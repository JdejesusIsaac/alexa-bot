import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb, seedTenants } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { upsertStudent } from '../src/repositories/students.js';
import { insertStaffIdentity } from '../src/repositories/staff-identities.js';
import {
  createPickupRequest,
  findPickupRequestById,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import {
  EscalationWorker,
  type EscalationWorkerOptions,
} from '../src/sync/escalation-worker.js';
import {
  loadEscalationLadder,

  loadEscalationLaddersFromDir,
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

  // FORCE RLS binds the owner too — each tenant row enters under its
  // own context (B-12).
  await seedTenants(db.ownerPool, [
    [TENANT_A, 'Campus Alpha'],
    [TENANT_B, 'Campus Bravo'],
  ]);

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

function makeWorker(
  tenantId: string = TENANT_A,
  jobLadder: EscalationLadder = ladder,
  options: Partial<EscalationWorkerOptions> = {},
): EscalationWorker {
  return new EscalationWorker(db.appPool, logger, {
    jobs: [{ tenantId, ladder: jobLadder }],
    ...options,
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
async function makeDueAgain(
  requestId: string,
  tenantId: string = TENANT_A,
): Promise<void> {
  // Owner-role clock rewrite under the request's own tenant context —
  // FORCE RLS binds the owner too (B-12).
  await withTenant(db.ownerPool, tenantId, async (owner) => {
    await owner.query(
      `update pickup_requests set escalate_at = now() - interval '1 minute' where id = $1`,
      [requestId],
    );
  });
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
    // PL-254: the failed row deferred out of the queue head; reset its
    // clock to make it due again (deferral is asserted in T-78).
    await makeDueAgain(requestId);
    await makeWorker().tick();
    const still = await stateOf(requestId);
    expect(still!.state).toBe('routed');
    expect(still!.escalation_level).toBe(0);

    // The config error cleared: the row resumes on the next tick —
    // nothing was lost while it was stuck. (The blocker event is
    // removed as the owner: the events table is append-only to the app
    // role, and this synthetic blocker existed only for this test.
    // Tenant A's context — FORCE RLS binds the owner too, B-12.)
    await withTenant(db.ownerPool, TENANT_A, async (owner) => {
      await owner.query(
        `delete from pickup_request_events where request_id = $1 and actor = 'blocker'`,
        [requestId],
      );
      await owner.query(
        `update pickup_requests set escalate_at = now() - interval '1 minute' where id = $1`,
        [requestId],
      );
    });
    await makeWorker().tick();
    const resumed = await stateOf(requestId);
    expect(resumed!.state).toBe('routed');
    expect(resumed!.escalation_level).toBe(1);
    expect(await escalatedEventCount(requestId, 1)).toBe(1);
  });

  it('killing the worker between rungs resumes at the correct level — once per rung', async () => {
    const requestId = await makeDueRequest();

    const first = new EscalationWorker(db.appPool, logger, {
      jobs: [{ tenantId: TENANT_A, ladder }],
    });
    await first.tick();
    expect((await stateOf(requestId))!.escalation_level).toBe(1);

    // "Kill" — the instance is abandoned. State was never in memory.
    await makeDueAgain(requestId);

    // "Restart" — a brand-new instance, a fresh tick.
    const restarted = new EscalationWorker(db.appPool, logger, {
      jobs: [{ tenantId: TENANT_A, ladder }],
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
    // The level-0 clock is fixture-fake too (PL-253).
    expect(ladder.initialMinutes).toBe(1);
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

  it('a missing per-tenant ladder is a boot refusal naming the tenant and the path', async () => {
    const { loadEscalationLaddersFromDir } = await import(
      '../src/sync/escalation-ladder.js'
    );
    await expect(
      loadEscalationLaddersFromDir('does/not/exist', [TENANT_A]),
    ).rejects.toThrow(/no escalation ladder for tenant.*does\/not\/exist/);
  });

  it('an invalid ladder is a boot refusal, not a sanitized default', () => {
    expect(() =>
      parseEscalationLadder(
        '{"initial_minutes": 1, "rungs": [{"level": 2}]}',
        'bad-ladder.json',
      ),
    ).toThrow(/bad-ladder\.json.*refuses to start/);

    // A ladder without initial_minutes is a boot refusal too — the
    // level-0 clock is policy, not a default (PL-253).
    expect(() =>
      parseEscalationLadder(
        '{"rungs": [{"level": 1, "after_minutes": 5, "approver_subject": "a@b.test"}]}',
        'no-initial-ladder.json',
      ),
    ).toThrow(/no-initial-ladder\.json.*refuses to start/);

    expect(() =>
      parseEscalationLadder(
        JSON.stringify({
          initial_minutes: 5,
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

// ── T-78: queue fairness — poisoned rows cannot starve the queue ─────

describe('PL-254 · T-78: a poisoned row cannot starve the queue', () => {
  /** Force a row's clock older/newer, as owner — ordering is the test. */
  async function setEscalateAt(requestId: string, secondsAgo: number): Promise<void> {
    // Tenant A's context — these requests are all A's, and FORCE RLS
    // binds the owner too (B-12).
    await withTenant(db.ownerPool, TENANT_A, async (owner) => {
      await owner.query(
        `update pickup_requests set escalate_at = now() - ($2 || ' seconds')::interval where id = $1`,
        [requestId, secondsAgo],
      );
    });
  }

  /** The blocking-event trick from T-60: a row that always fails. */
  async function poisonRow(requestId: string): Promise<void> {
    await withTenant(db.appPool, TENANT_A, async (client) => {
      await client.query(
        `insert into pickup_request_events
           (tenant_id, request_id, escalation_level, event_type, actor, channel)
         values (current_setting('app.tenant_id')::uuid, $1, 1, 'escalated', 'blocker', 'worker')`,
        [requestId],
      );
    });
  }

  it('a failing row ahead of a healthy one defers — the healthy row escalates', async () => {
    const poisoned = await makeDueRequest();
    const healthy = await makeDueRequest();
    // Poisoned is the OLDEST due row — it heads the oldest-first queue.
    await setEscalateAt(poisoned, 300);
    await setEscalateAt(healthy, 60);
    await poisonRow(poisoned);

    // batchSize 1: ordering decides everything. A long deferral moves
    // the poisoned row well behind the healthy one.
    const worker = makeWorker(TENANT_A, ladder, {
      batchSize: 1,
      deferralSeconds: 3600,
    });

    const first = await worker.tick();
    expect(first[0]!.claimed).toBe(1);
    expect(first[0]!.failed).toBe(1);

    // The poisoned row: deferred out of the head — attempts counted,
    // escalate_at rewritten into the future, still routed (untouched
    // by the rolled-back savepoint).
    const poisonedRow = await stateOf(poisoned);
    expect(poisonedRow!.state).toBe('routed');
    expect(poisonedRow!.escalation_attempts).toBe(1);
    expect(poisonedRow!.escalate_at!.getTime()).toBeGreaterThan(Date.now());

    // Tick 2: the healthy row is the due head now — it advances while
    // the poisoned row is still pending. This is the starvation fix.
    const second = await worker.tick();
    expect(second[0]!.escalated).toBe(1);
    const healthyRow = await stateOf(healthy);
    expect(healthyRow!.escalation_level).toBe(1);
    expect((await stateOf(poisoned))!.state).toBe('routed');

    // Unpoison for a clean suite tail — owner delete under tenant A's
    // context (B-12); the events table is append-only to the app role.
    await withTenant(db.ownerPool, TENANT_A, async (owner) => {
      await owner.query(
        `delete from pickup_request_events where request_id = $1 and actor = 'blocker'`,
        [poisoned],
      );
    });
  });

  it('the attempt ceiling lands the row in stalled — terminal, audited, human', async () => {
    const requestId = await makeDueRequest();
    await withTenant(db.ownerPool, TENANT_A, async (owner) => {
      await owner.query(
        `update pickup_requests set escalation_attempts = 2 where id = $1`,
        [requestId],
      );
    });

    const worker = makeWorker(TENANT_A, ladder, { maxAttempts: 2 });
    const stats = await worker.tick();
    expect(stats[0]!.stalled).toBe(1);

    const row = await stateOf(requestId);
    expect(row!.state).toBe('stalled');
    // Terminal, like every other terminal state: detail purged, and
    // no decider — a stall is a clock giving up, not a decision.
    expect(row!.reason_detail).toBeNull();
    expect(row!.decided_by).toBeNull();
    expect(row!.decided_at).toBeNull();

    // Audited: the stalled event row + the worker's boundary audit.
    const stalledEvents = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ count: number }>(
        `select count(*)::int as count from pickup_request_events
         where request_id = $1 and event_type = 'stalled'`,
        [requestId],
      );
      return res.rows[0]!.count;
    });
    expect(stalledEvents).toBe(1);
    const audits = await workerAuditRows(requestId);
    expect(audits.some((a) => a.outcome === 'stalled:max_attempts')).toBe(true);

    // Stalled never behaves like approved — every subsequent action
    // is a typed refusal (AD-26's twin). Since PL-274, decision actions
    // authorize BEFORE the state is classified (the B-1 reorder), so an
    // approve attempt without a resolved identity reports the caller
    // error — `missing_field` — instead of `illegal_transition`. Still
    // a typed refusal, still no state change; the ordering is what
    // closed the replay bypass.
    await withTenant(db.appPool, TENANT_A, async (client) => {
      const expectedCode: Record<'approve' | 'release' | 'escalate' | 'complete', string> = {
        approve: 'missing_field', // authorization precedes state classification (PL-274)
        release: 'illegal_transition',
        escalate: 'illegal_transition',
        complete: 'illegal_transition',
      };
      for (const action of ['approve', 'release', 'escalate', 'complete'] as const) {
        const result = await transitionPickupRequest(client, {
          requestId,
          action,
          actor: 'escalation-worker',
          channel: 'worker',
          ...(action === 'escalate'
            ? { escalateAt: new Date(Date.now() + 60_000) }
            : {}),
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe(expectedCode[action]);
      }
    });

    // And it has left the due queue — a second tick claims nothing.
    const again = await worker.tick();
    expect(again[0]!.claimed).toBe(0);
  });

  it('a skipped row defers and counts too — and resumes once the mapping lands', async () => {
    // Tenant B has no staff identity for the fixture rungs → skip.
    const requestId = await makeDueRequest(TENANT_B);
    const worker = makeWorker(TENANT_B, ladder, { deferralSeconds: 3600 });

    const first = await worker.tick();
    expect(first[0]!.skipped).toBe(1);
    const skipped = await stateOf(requestId, TENANT_B);
    expect(skipped!.state).toBe('routed');
    expect(skipped!.escalation_attempts).toBe(1);
    expect(skipped!.escalate_at!.getTime()).toBeGreaterThan(Date.now());

    // Fix the mapping — the row resumes on its next due tick, its
    // attempt count preserved (the bound still applies going forward).
    await withTenant(db.appPool, TENANT_B, async (client) => {
      await insertStaffIdentity(client, {
        slackUserId: 'U_FIXTURE_VP_ONE_B',
        subject: 'FIXTURE_VP_ONE@fixture.test',
        role: 'staff',
      });
    });
    await makeDueAgain(requestId, TENANT_B);

    const second = await worker.tick();
    expect(second[0]!.escalated).toBe(1);
    const resumed = await stateOf(requestId, TENANT_B);
    expect(resumed!.state).toBe('routed');
    expect(resumed!.escalation_level).toBe(1);
    expect(resumed!.escalation_attempts).toBe(1);
  });
});

// ── T-79: ladders are per-tenant ─────────────────────────────────────

describe('PL-254 · T-79: ladders are per-tenant', () => {
  const FIXTURE_LADDER_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'fixtures',
    'escalation',
  );

  it('a two-tenant worker with two ladder files processes both queues', async () => {
    const ladders = await loadEscalationLaddersFromDir(FIXTURE_LADDER_DIR, [
      TENANT_A,
      TENANT_B,
    ]);
    expect(ladders.size).toBe(2);
    expect(ladders.get(TENANT_A)!.source).toContain(`${TENANT_A}.json`);
    expect(ladders.get(TENANT_B)!.source).toContain(`${TENANT_B}.json`);

    // Tenant B's rung-1 approver is mapped in B — under the old
    // single-ladder regime, B's rows skipped for lacking A's subjects.
    await withTenant(db.appPool, TENANT_B, async (client) => {
      await insertStaffIdentity(client, {
        slackUserId: 'U_FIXTURE_VP_B_ONE',
        subject: 'FIXTURE_VP_B_ONE@fixture.test',
        role: 'staff',
      });
    });

    const requestA = await makeDueRequest(TENANT_A);
    const requestB = await makeDueRequest(TENANT_B);

    const worker = new EscalationWorker(db.appPool, logger, {
      jobs: [
        { tenantId: TENANT_A, ladder: ladders.get(TENANT_A)! },
        { tenantId: TENANT_B, ladder: ladders.get(TENANT_B)! },
      ],
    });
    const stats = await worker.tick();
    const byTenant = new Map(stats.map((s) => [s.tenantId, s]));
    expect(byTenant.get(TENANT_A)!.escalated).toBe(1);
    expect(byTenant.get(TENANT_B)!.escalated).toBe(1);
    expect(byTenant.get(TENANT_B)!.skipped).toBe(0);

    expect((await stateOf(requestA))!.escalation_level).toBe(1);
    const rowB = await stateOf(requestB, TENANT_B);
    expect(rowB!.escalation_level).toBe(1);
    // And B's assignee resolved through B's own identities.
    expect(rowB!.assigned_approver_id).not.toBeNull();
  });

  it('a configured tenant missing its ladder file is a boot refusal naming tenant and path', async () => {
    const missing = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await expect(
      loadEscalationLaddersFromDir(FIXTURE_LADDER_DIR, [TENANT_A, missing]),
    ).rejects.toThrow(
      new RegExp(`tenant ${missing}.*expected .*${missing}\\.json.*refuses to start`),
    );
  });

  it('an unset ESCALATION_LADDER_DIR is a boot refusal naming the variable', async () => {
    const saved = process.env.ESCALATION_LADDER_DIR;
    delete process.env.ESCALATION_LADDER_DIR;
    try {
      const { loadEscalationLaddersFromEnv } = await import(
        '../src/sync/escalation-ladder.js'
      );
      await expect(loadEscalationLaddersFromEnv([TENANT_A])).rejects.toThrow(
        /ESCALATION_LADDER_DIR is not set.*refuses to start/,
      );
    } finally {
      if (saved !== undefined) process.env.ESCALATION_LADDER_DIR = saved;
    }
  });
});

// ── T-81: a failing tick neither kills the worker nor starves a tenant ──

describe('PL-258 · T-81: a failing tick is isolated, audited, and survived', () => {
  it('tenant A throws; tenant B still processes; the failure is logged and audited', async () => {
    const lines: string[] = [];
    const captureLogger = createLogger({ logLevel: 'error' }, {
      write: (line: string) => {
        lines.push(line);
      },
    } as NodeJS.WritableStream);

    // A due row in tenant B — the tenant that must not starve.
    const requestB = await makeDueRequest(TENANT_B);
    await withTenant(db.appPool, TENANT_B, async (client) => {
      await insertStaffIdentity(client, {
        slackUserId: 'U_FIXTURE_VP_ONE_B81',
        subject: 'FIXTURE_VP_ONE@fixture.test',
        role: 'staff',
      });
    });

    // Tenant A's job is structurally broken: no ladder. The tick for A
    // throws before a row is touched — the test of isolation.
    const worker = new EscalationWorker(db.appPool, captureLogger, {
      jobs: [
        { tenantId: TENANT_A, ladder: undefined as unknown as EscalationLadder },
        { tenantId: TENANT_B, ladder },
      ],
    });

    const stats = await worker.tick();
    expect(stats).toHaveLength(2);
    const byTenant = new Map(stats.map((s) => [s.tenantId, s]));
    // B processed its queue — A's failure did not stop the loop.
    expect(byTenant.get(TENANT_B)!.escalated).toBe(1);
    expect((await stateOf(requestB, TENANT_B))!.escalation_level).toBe(1);
    // A contributed zero stats and a recorded failure.
    expect(byTenant.get(TENANT_A)!.claimed).toBe(0);

    // Logged.
    const joined = lines.join('\n');
    expect(joined).toContain('escalation_tenant_failed');
    expect(joined).toContain(TENANT_A);

    // Audited under tenant A — a row, not just a line (AD-42).
    const audits = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ outcome: string }>(
        `select outcome from mcp_audit
         where request_id = 'worker-tenant-failure' and actor = 'escalation-worker'`,
      );
      return res.rows;
    });
    expect(audits.some((a) => a.outcome === 'error:worker_tenant_failed')).toBe(true);
  });

  it('the interval loop catches — no unhandled rejection, worker_unhealthy on consecutive failures, still polling', async () => {
    const lines: string[] = [];
    const captureLogger = createLogger({ logLevel: 'error' }, {
      write: (line: string) => {
        lines.push(line);
      },
    } as NodeJS.WritableStream);

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    const worker = new EscalationWorker(db.appPool, captureLogger, {
      jobs: [
        { tenantId: TENANT_A, ladder: undefined as unknown as EscalationLadder },
      ],
      intervalMs: 10,
    });

    try {
      worker.start();
      // Several intervals — the Sprint 3 shape (`void this.tick()`)
      // rejected unhandled and exited the process on Node 20.
      await new Promise((resolve) => setTimeout(resolve, 120));
      worker.stop();
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(rejections).toHaveLength(0);
    const joined = lines.join('\n');
    // Consecutive failures escalated to the unhealthy signal…
    expect(joined).toContain('worker_unhealthy');
    // …and the worker kept polling — each interval logged a failure
    // rather than dying on the first.
    const failureCount = (joined.match(/escalation_tenant_failed/g) ?? []).length;
    expect(failureCount).toBeGreaterThanOrEqual(2);
  });
});
