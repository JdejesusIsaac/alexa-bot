import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { upsertStudent } from '../src/repositories/students.js';
import {
  createPickupRequest,
  findPickupRequestById,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import { insertStaffIdentity } from '../src/repositories/staff-identities.js';
import { findByStudentRef as findAuditByStudentRef } from '../src/repositories/audit-log.js';
import { decidePickupRequestAsSlackActor } from '../src/services/pickup-decision.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';

/**
 * PL-205 — staff_identities: the Slack actor maps to the audit subject.
 *
 * T-64: An unmapped slack_user_id cannot decide — typed refusal, audited,
 *       no state change. A slack id mapped only in another tenant is
 *       equally unmapped (RLS); the refusal is identical in outcome
 *       whether the id is foreign or nonexistent.
 * T-67: Every decision is audited with the resolved subject — the event,
 *       the request row, and the audit row all carry the subject, the
 *       tenant, the request, the decision, and the channel it arrived
 *       through. Zero decision rows whose actor is only a Slack user id.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

const MAPPED_SLACK_ID = 'USYNTH_MAPPED';
const MAPPED_SUBJECT = 'leader@synthetic.test';

const SERVICE_DATE = '2030-03-15';

let db: TestDb;
let studentA: string;
let studentB: string;

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

  studentA = await withTenant(db.appPool, TENANT_A, async (client) => {
    const s = await upsertStudent(client, {
      studentRef: 'S-001',
      studentName: 'Slack Actor Test Scholar',
      section: '101',
    });
    return s.id;
  });
  studentB = await withTenant(db.appPool, TENANT_B, async (client) => {
    const s = await upsertStudent(client, {
      studentRef: 'S-101',
      studentName: 'Slack Actor Test Scholar',
      section: '201',
    });
    return s.id;
  });

  // The mapping exists in tenant A ONLY — tenant B's context must not
  // see it (RLS), which is the cross-tenant shape T-64 also covers.
  await withTenant(db.appPool, TENANT_A, async (client) => {
    await insertStaffIdentity(client, {
      slackUserId: MAPPED_SLACK_ID,
      subject: MAPPED_SUBJECT,
      role: 'staff',
    });
  });
});

afterAll(async () => {
  await db.cleanup();
});

async function makeRoutedRequest(tenantId: string, studentId: string): Promise<string> {
  return withTenant(db.appPool, tenantId, async (client) => {
    const request = await createPickupRequest(client, {
      serviceDate: SERVICE_DATE,
      studentId,
      pickupAt: new Date('2030-03-15T18:30:00Z'),
      reasonCategory: 'appointment',
      intakeChannel: 'coordinator',
    });
    const routed = await transitionPickupRequest(client, {
      requestId: request.id,
      action: 'route',
      actor: 'intake-coordinator',
      escalateAt: new Date('2030-03-15T20:00:00Z'),
    });
    expect(routed.ok).toBe(true);
    return request.id;
  });
}

async function decide(
  tenantId: string,
  requestId: string,
  slackUserId: string,
  action: 'approve' | 'flag' | 'deny' = 'approve',
) {
  return withTenant(db.appPool, tenantId, async (client) =>
    decidePickupRequestAsSlackActor(client, { requestId, action, slackUserId }),
  );
}

interface EventRow {
  event_type: string;
  actor: string;
  channel: string;
}

async function eventsFor(tenantId: string, requestId: string): Promise<EventRow[]> {
  return withTenant(db.appPool, tenantId, async (client) => {
    const res = await client.query<EventRow>(
      `select event_type, actor, channel from pickup_request_events
       where request_id = $1 order by created_at asc, id asc`,
      [requestId],
    );
    return res.rows;
  });
}

// ── T-64: An unmapped Slack actor cannot decide ───────────────────────

describe('PL-205 · T-64: an unmapped Slack actor cannot decide', () => {
  it('is a typed refusal with no state change and an audit row', async () => {
    const requestId = await makeRoutedRequest(TENANT_A, studentA);

    const result = await decide(TENANT_A, requestId, 'USYNTH_UNMAPPED');
    expect(result).toEqual({
      ok: false,
      code: 'unmapped_slack_actor',
      from: 'routed',
      action: 'approve',
    });

    // No state change — and no decision event exists.
    const after = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, requestId),
    );
    expect(after!.state).toBe('routed');
    expect(
      (await eventsFor(TENANT_A, requestId)).filter((e) => e.event_type === 'approved'),
    ).toHaveLength(0);

    // Audited: the refusal row names the actor that needs mapping and
    // whose request was blocked (T-64's "audited" — a row, not a log line).
    const audit = await withTenant(db.appPool, TENANT_A, async (client) =>
      findAuditByStudentRef(client, 'S-001'),
    );
    const refusal = audit.filter(
      (a) =>
        a.outcome === 'refusal:unmapped_slack_actor' && a.actor === 'USYNTH_UNMAPPED',
    );
    expect(refusal.length).toBeGreaterThanOrEqual(1);
    expect(refusal[0]!.action).toBe('decidePickupRequest');
  });

  it('a slack id mapped only in another tenant is equally unmapped — RLS scopes the lookup', async () => {
    const requestId = await makeRoutedRequest(TENANT_B, studentB);

    // MAPPED_SLACK_ID exists in tenant A only. Under B it resolves to
    // nothing, and the refusal is identical to any other unmapped id.
    const result = await decide(TENANT_B, requestId, MAPPED_SLACK_ID);
    expect(result).toEqual({
      ok: false,
      code: 'unmapped_slack_actor',
      from: 'routed',
      action: 'approve',
    });

    const after = await withTenant(db.appPool, TENANT_B, async (client) =>
      findPickupRequestById(client, requestId),
    );
    expect(after!.state).toBe('routed');
  });

  it('an invisible request id is not_found, never forbidden-but-real', async () => {
    const result = await decide(
      TENANT_A,
      '99999999-9999-9999-9999-999999999999',
      MAPPED_SLACK_ID,
    );
    expect(result).toEqual({
      ok: false,
      code: 'not_found',
      from: null,
      action: 'approve',
    });

    const audit = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ actor: string; outcome: string }>(
        `select actor, outcome from audit_log where outcome = 'refusal:not_found'`,
      );
      return res.rows;
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.actor).toBe(MAPPED_SLACK_ID);
  });
});

// ── T-67: Every decision is audited with a resolved subject ───────────

describe('PL-205 · T-67: every decision carries the resolved subject and channel', () => {
  it('a mapped actor decides under the subject — never the slack id — on every row that records it', async () => {
    const requestId = await makeRoutedRequest(TENANT_A, studentA);

    const result = await decide(TENANT_A, requestId, MAPPED_SLACK_ID);
    expect(result.ok).toBe(true);

    // The request row: decided_by is the subject.
    const request = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, requestId),
    );
    expect(request!.state).toBe('approved');
    expect(request!.decided_by).toBe(MAPPED_SUBJECT);

    // The event row: the decision carries subject + channel (T-67's five
    // parts — subject, tenant, request, decision, channel — all present).
    const events = await eventsFor(TENANT_A, requestId);
    const approved = events.filter((e) => e.event_type === 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0]!.actor).toBe(MAPPED_SUBJECT);
    expect(approved[0]!.channel).toBe('slack');

    // Zero decision rows whose actor is only a Slack user id.
    const slackActorEvents = events.filter((e) => e.actor === MAPPED_SLACK_ID);
    expect(slackActorEvents).toHaveLength(0);

    // The audit row: success, under the subject.
    const audit = await withTenant(db.appPool, TENANT_A, async (client) =>
      findAuditByStudentRef(client, 'S-001'),
    );
    const success = audit.filter(
      (a) => a.action === 'decidePickupRequest' && a.outcome === 'success',
    );
    expect(success.length).toBeGreaterThanOrEqual(1);
    expect(success[0]!.actor).toBe(MAPPED_SUBJECT);
  });

  it('the channel distinguishes how the decision arrived — slack vs app', async () => {
    const slackRequest = await makeRoutedRequest(TENANT_A, studentA);
    await decide(TENANT_A, slackRequest, MAPPED_SLACK_ID);
    const slackEvent = (await eventsFor(TENANT_A, slackRequest)).find(
      (e) => e.event_type === 'approved',
    );
    expect(slackEvent!.channel).toBe('slack');

    // The same decision through the app path (the in-app tool, PL-208)
    // records the app channel — same machine, distinguishable arrival.
    const appRequest = await makeRoutedRequest(TENANT_A, studentA);
    await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await transitionPickupRequest(client, {
        requestId: appRequest,
        action: 'approve',
        actor: 'app-user@synthetic.test',
      });
      expect(res.ok).toBe(true);
    });
    const appEvent = (await eventsFor(TENANT_A, appRequest)).find(
      (e) => e.event_type === 'approved',
    );
    expect(appEvent!.channel).toBe('app');
    expect(appEvent!.actor).toBe('app-user@synthetic.test');
  });

  it('a replayed Slack approval is an idempotent no-op under the subject — one decision event', async () => {
    const requestId = await makeRoutedRequest(TENANT_A, studentA);

    const first = await decide(TENANT_A, requestId, MAPPED_SLACK_ID);
    expect(first.ok).toBe(true);
    const decidedAt = (await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, requestId),
    ))!.decided_at;

    // The Slack at-least-once case, arriving through the actor path.
    const second = await decide(TENANT_A, requestId, MAPPED_SLACK_ID);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.idempotent).toBe(true);
    }

    const after = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, requestId),
    );
    expect(after!.decided_at).toEqual(decidedAt);

    // One decision event; the audit trail distinguishes the replay.
    const events = await eventsFor(TENANT_A, requestId);
    expect(events.filter((e) => e.event_type === 'approved')).toHaveLength(1);
    const audit = await withTenant(db.appPool, TENANT_A, async (client) =>
      findAuditByStudentRef(client, 'S-001'),
    );
    expect(
      audit.filter((a) => a.outcome === 'success:idempotent').length,
    ).toBeGreaterThanOrEqual(1);
  });
});
