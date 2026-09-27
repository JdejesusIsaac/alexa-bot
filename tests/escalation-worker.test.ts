import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { upsertStudent } from '../src/repositories/students.js';
import { insertStaffIdentity } from '../src/repositories/staff-identities.js';
import {
  createPickupRequest,
  findPickupRequestById,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import { EscalationWorker } from '../src/sync/escalation-worker.js';
import {
  loadEscalationLadder,
  loadEscalationLadderFromEnv,
  parseEscalationLadder,
  type EscalationLadder,
} from '../src/sync/escalation-ladder.js';
import { createLogger, type Logger } from '../src/logging/logger.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';
import { todayServiceDate } from '../src/util/service-date.js';

/**
 * PL-204 — the escalation worker, graded by T-60…T-63.
 *
 * T-60 (GATE): expiry never approves. Drive a request through the full
 *       ladder with no response; force an error mid-ladder; kill the
 *       worker between rungs. No path — timeout, error, restart, or
 *       default — produces approved or released. The terminal state is
 *       `expired`, routing the coordinator to in-person handling.
 * T-61: two workers racing the same due row — exactly one advances
 *       (FOR UPDATE SKIP LOCKED), and skipped or failed rows produce
 *       audit records (AD-42: the poll loop is the boundary).
 * T-62: restart mid-escalation resumes at the correct level — state
 *       lives in Postgres, never in process memory (AD-30).
 * T-63: the ladder matches the recorded policy. P2 is still open —
 *       the only ladder that can run is the obviously-fake fixture,
 *       and the worker refuses to start without a written ladder,
 *       naming the file. When P2 lands, the recorded-policy assertion
 *       flips to the written decision.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only — the fixture ladder's approvers are FIXTURE_VP,
 * unmaskable as real config by design.
 */

const FIXTURE_LADDER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'fixtures',
  'escalation-ladder.FIXTURE.json',
);

let db: TestDb;
let ladder: EscalationLadder;
let logger: Logger;

beforeAll(async () => {
  db = await provisionTestDb();

  const owner = await db.ownerPool.connect();
  try {
    await owner.query(
      `insert into tenants (id, name) values ($1, 'Campus Alpha'), ($2, 'Campus Bravo')`,
      [TENANT_A, TENANT_B],
    );
  } finally {
    owner.release();
  }

  // The fixture ladder's rung approvers, registered as staff in tenant A
  // only — tenant B deliberately lacks them (the T-61 skip case).
  await withTenant(db.appPool, TENANT_A, async (client) => {
    await insertStaffIdentity(client, {
      slackUserId: 'U_FIXTURE_VP_ONE',
      subject: 'FIXTURE_VP_ONE@fixture.test',
      role: 'staff',
    });
    await insertStaffIdentity(client, {
      slackUserId: 'U_FIXTURE_VP_TWO',
      subject: 'FIXTURE_VP_TWO@fixture.test',
      role: 'staff',
    });
  });

  ladder = await loadEscalationLadder(FIXTURE_LADDER_PATH);
  logger = createLogger({ logLevel: 'error' });
});

afterAll(async () => {
  await db.cleanup();
});

function makeWorker(tenantId: string = TENANT_A): EscalationWorker {
  return new EscalationWorker(db.appPool, ladder, logger, {
    jobs: [{ tenantId }],
  });
}

/** A routed request whose clock is already past — due for escalation. */
async function makeDueRequest(tenantId: string = TENANT_A): Promise<string> {
  return withTenant(db.appPool, tenantId, async (client) => {
    const student = await upsertStudent(client, {
      studentRef: tenantId === TENANT_A ? 'W-001' : 'W-101',
      studentName: 'Worker Test Scholar',
      section: '101',
    });
    const request = await createPickupRequest(client, {
      serviceDate: todayServiceDate(),
      studentId: student.id,
      pickupAt: new Date('2030-03-15T18:30:00Z'),
      reasonCategory: 'appointment',
      reasonDetail: 'SENTINEL-worker-detail',
      intakeChannel: 'coordinator',
    });
    const routed = await transitionPickupRequest(client, {
      requestId: request.id,
      action: 'route',
      actor: 'intake-coordinator',
      escalateAt: new Date(Date.now() - 60_000), // already due
    });
    expect(routed.ok).toBe(true);
    return request.id;
  });
}

/** Make the current level's clock past — due again without waiting minutes. */
async function makeDueAgain(requestId: string): Promise<void> {
  const owner = await db.ownerPool.connect();
  try {
    await owner.query(
      `update pickup_requests set escalate_at = now() - interval '1 minute' where id = $1`,
      [requestId],
    );
  } finally {
    owner.release();
  }
}

async function stateOf(requestId: string, tenantId: string = TENANT_A) {
  return withTenant(db.appPool, tenantId, async (client) =>
    findPickupRequestById(client, requestId),
  );
}

async function escalatedEventCount(requestId: string, level: number): Promise<number> {
  return withTenant(db.appPool, TENANT_A, async (client) => {
    const res = await client.query<{ count: number }>(
      `select count(*)::int as count from pickup_request_events
       where request_id = $1 and event_type = 'escalated' and escalation_level = $2`,
      [requestId, level],
    );
    return res.rows[0]!.count;
  });
}

async function workerAuditRows(requestId: string, tenantId: string = TENANT_A) {
  return withTenant(db.appPool, tenantId, async (client) => {
    const res = await client.query<{
      actor: string;
      outcome: string;
      rpc_method: string | null;
    }>(
      `select actor, outcome, rpc_method from mcp_audit where request_id = $1 and actor = 'escalation-worker'`,
      [requestId],
    );
    return res.rows;
  });
}

// ── T-60 (GATE): expiry never approves ────────────────────────────────

describe('PL-204 · T-60 (GATE): expiry never approves', () => {
  it('the full ladder with no response terminates in expired — never approved, never released', async () => {
    const requestId = await makeDueRequest();

    // Level 0 → 1 (rung 1's approver, its clock).
    await makeWorker().tick();
    let row = await stateOf(requestId);
    expect(row!.state).toBe('routed');
    expect(row!.escalation_level).toBe(1);
    expect(row!.assigned_approver_id).not.toBeNull();

    // Level 1 → 2.
    await makeDueAgain(requestId);
    await makeWorker().tick();
    row = await stateOf(requestId);
    expect(row!.state).toBe('routed');
    expect(row!.escalation_level).toBe(2);

    // Level 2 is the top: due again → EXPIRED. Terminal, in-person.
    await makeDueAgain(requestId);
    await makeWorker().tick();
    row = await stateOf(requestId);
    expect(row!.state).toBe('expired');
    expect(row!.expired_at).not.toBeNull();
    expect(row!.decided_by).toBeNull(); // no human decided; no path did either
    // The P3 purge: terminal state purged the reason detail.
    expect(row!.reason_detail).toBeNull();

    // Exactly one escalation event per level, one expiry.
    expect(await escalatedEventCount(requestId, 1)).toBe(1);
    expect(await escalatedEventCount(requestId, 2)).toBe(1);
    const expiredEvents = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(
        `select count(*)::int as count from pickup_request_events
         where request_id = $1 and event_type = 'expired'`,
        [requestId],
      );
      return res.rows[0]!.count;
    });
    expect(expiredEvents).toBe(1);
  });

  it('a forced error mid-ladder leaves the row intact, audited — never approved', async () => {
    const requestId = await makeDueRequest();

    // Force a real error: pre-insert the level-1 escalation event, so
    // the worker's own event insert hits the unique constraint and
    // throws mid-transition. The savepoint rolls the row back.
    await withTenant(db.appPool, TENANT_A, async (client) => {
      await client.query(
        `insert into pickup_request_events
           (tenant_id, request_id, escalation_level, event_type, actor, channel)
         values (current_setting('app.tenant_id')::uuid, $1, 1, 'escalated', 'blocker', 'worker')`,
        [requestId],
      );
    });

    const stats = await makeWorker().tick();

    // The row is untouched: routed at level 0, still waiting.
    const row = await stateOf(requestId);
    expect(row!.state).toBe('routed');
    expect(row!.escalation_level).toBe(0);
    expect(row!.decided_by).toBeNull();

    // The failure is audited at the boundary (AD-42) — by request id.
    const audits = await workerAuditRows(requestId);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.some((a) => a.outcome === 'error:worker_row_failed')).toBe(true);
    expect(stats[0]!.failed).toBeGreaterThanOrEqual(1);

    // And the next tick fails the same way — safely, still no approval.
    await makeWorker().tick();
    const still = await stateOf(requestId);
    expect(still!.state).toBe('routed');
    expect(still!.escalation_level).toBe(0);

    // The config error cleared: the row resumes on the next tick —
    // nothing was lost while it was stuck. (The blocker event is
    // removed as the owner: the events table is append-only to the app
    // role, and this synthetic blocker existed only for this test.)
    const owner = await db.ownerPool.connect();
    try {
      await owner.query(
        `delete from pickup_request_events where request_id = $1 and actor = 'blocker'`,
        [requestId],
      );
    } finally {
      owner.release();
    }
    await makeWorker().tick();
    const resumed = await stateOf(requestId);
    expect(resumed!.state).toBe('routed');
    expect(resumed!.escalation_level).toBe(1);
    expect(await escalatedEventCount(requestId, 1)).toBe(1);
  });

  it('killing the worker between rungs resumes at the correct level — once per rung', async () => {
    const requestId = await makeDueRequest();

    const first = new EscalationWorker(db.appPool, ladder, logger, {
      jobs: [{ tenantId: TENANT_A }],
    });
    await first.tick();
    expect((await stateOf(requestId))!.escalation_level).toBe(1);

    // "Kill" — the instance is abandoned. State was never in memory.
    await makeDueAgain(requestId);

    // "Restart" — a brand-new instance, a fresh tick.
    const restarted = new EscalationWorker(db.appPool, ladder, logger, {
      jobs: [{ tenantId: TENANT_A }],
    });
    await restarted.tick();

    const row = await stateOf(requestId);
    expect(row!.escalation_level).toBe(2); // exactly +1, not +2
    expect(await escalatedEventCount(requestId, 1)).toBe(1);
    expect(await escalatedEventCount(requestId, 2)).toBe(1);
  });
});

// ── T-61: concurrent workers; skipped rows audited ────────────────────

describe('PL-204 · T-61: concurrent workers do not double-escalate', () => {
  it('two workers racing the same due row: one advances, the other never sees it', async () => {
    const requestId = await makeDueRequest();

    const workerOne = makeWorker();
    const workerTwo = makeWorker();
    const [statsOne, statsTwo] = await Promise.all([workerOne.tick(), workerTwo.tick()]);

    // Exactly one escalation happened; the row advanced exactly once.
    const totalEscalated =
      statsOne.reduce((sum, s) => sum + s.escalated, 0) +
      statsTwo.reduce((sum, s) => sum + s.escalated, 0);
    expect(totalEscalated).toBe(1);

    const row = await stateOf(requestId);
    expect(row!.escalation_level).toBe(1);
    expect(row!.state).toBe('routed');

    // One notification per rung — the unique constraint is the backstop,
    // SKIP LOCKED is the front line.
    expect(await escalatedEventCount(requestId, 1)).toBe(1);
  });

  it('a row the worker cannot transition is skipped AND audited — never silently dropped', async () => {
    // Tenant B has no staff identity for the fixture rungs: rung 1's
    // approver cannot resolve, so the row is a config-gap skip.
    const requestId = await makeDueRequest(TENANT_B);

    const stats = await makeWorker(TENANT_B).tick();
    expect(stats[0]!.skipped).toBeGreaterThanOrEqual(1);

    // The row is untouched — routed, level 0, waiting for the mapping.
    const row = await stateOf(requestId, TENANT_B);
    expect(row!.state).toBe('routed');
    expect(row!.escalation_level).toBe(0);

    // AD-42: the audit row exists, queried by request id — the poll
    // loop is the boundary, and a silently skipped row is the same gap
    // as an unaudited rejection.
    const audits = await workerAuditRows(requestId, TENANT_B);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]!.outcome).toBe('skipped:approver_not_mapped');
    expect(audits[0]!.rpc_method).toBe('escalation_tick');
  });
});

// ── T-62: restart resumes ─────────────────────────────────────────────

describe('PL-204 · T-62: restart mid-escalation resumes', () => {
  it('a worker restarted after the clock passes escalates once, at the correct level', async () => {
    const requestId = await makeDueRequest();
    await makeWorker().tick();
    expect((await stateOf(requestId))!.escalation_level).toBe(1);

    // The clock passes; the worker is down. State is in Postgres.
    await makeDueAgain(requestId);

    // A restart processes exactly the due row, exactly once.
    await makeWorker().tick();
    const row = await stateOf(requestId);
    expect(row!.escalation_level).toBe(2);
    expect(await escalatedEventCount(requestId, 2)).toBe(1);
  });
});

// ── T-63: the ladder matches the recorded policy ─────────────────────

describe('PL-204 · T-63: the configured ladder matches the recorded policy', () => {
  it('the fixture ladder is exactly the recorded fixture — 1- and 2-minute FIXTURE_VP rungs', async () => {
    // Drift in the fixture file fails here: the rungs are asserted
    // exactly. When P2 lands, this test is rewritten to assert the
    // WRITTEN decision from research.md instead — the comment in the
    // fixture file says the same thing.
    expect(ladder.source).toBe(FIXTURE_LADDER_PATH);
    expect(ladder.rungs).toEqual([
      {
        level: 1,
        afterMinutes: 1,
        approverSubject: 'FIXTURE_VP_ONE@fixture.test',
      },
      {
        level: 2,
        afterMinutes: 2,
        approverSubject: 'FIXTURE_VP_TWO@fixture.test',
      },
    ]);
  });

  it('P2 is still open in research.md — the only runnable ladder is the obviously-fake fixture', async () => {
    // The recorded policy, as of this sprint: NO ladder has been
    // chosen. The fixture is the only config that can run, and its
    // shape exists to be unmistakable. When P2 lands, replace this
    // assertion with the recorded decision (rungs and intervals as
    // written in research.md §Spike Results).
    const research = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'sprint-3',
        'research.md',
      ),
      'utf8',
    );
    const p2 = research.slice(
      research.indexOf('### P2 —'),
      research.indexOf('### PL-209'),
    );
    // Still open, still a proposal rather than a decision: the ladder
    // on record is the "bring the proposal, not the question" text.
    expect(p2).toContain('`SPIKE` (open)');
    expect(p2).toContain('assigned VP → 10 min → principal → 10 min → expire');
    expect(p2).toContain('Record what they choose and what they reject');
  });

  it('the worker refuses to start without a written ladder — loudly, naming the file', async () => {
    await expect(loadEscalationLadder('does/not/exist/ladder.json')).rejects.toThrow(
      /does\/not\/exist\/ladder\.json.*refuses to start/,
    );
  });

  it('the boot refusal names the missing environment variable', async () => {
    const saved = process.env.ESCALATION_LADDER_FILE;
    delete process.env.ESCALATION_LADDER_FILE;
    try {
      await expect(loadEscalationLadderFromEnv()).rejects.toThrow(
        /ESCALATION_LADDER_FILE is not set.*refuses to start/,
      );
    } finally {
      if (saved !== undefined) process.env.ESCALATION_LADDER_FILE = saved;
    }
  });

  it('an invalid ladder is a boot refusal, not a sanitized default', () => {
    expect(() =>
      parseEscalationLadder('{"rungs": [{"level": 2}]}', 'bad-ladder.json'),
    ).toThrow(/bad-ladder\.json.*refuses to start/);

    expect(() =>
      parseEscalationLadder(
        JSON.stringify({
          rungs: [
            { level: 1, after_minutes: 5, approver_subject: 'a@b.test' },
            { level: 3, after_minutes: 5, approver_subject: 'c@d.test' },
          ],
        }),
        'gap-ladder.json',
      ),
    ).toThrow(/gap-ladder\.json.*contiguous from 1/);
  });
});
