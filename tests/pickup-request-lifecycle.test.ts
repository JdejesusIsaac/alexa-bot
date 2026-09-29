import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb, seedTenants } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  createPickupRequest,
  findPickupRequestById,
  transitionPickupRequest,
  purgeStaleReasonDetail,
  type PickupRequest,
  type PickupRequestAction,
  type TransitionResult,
} from '../src/repositories/pickup-requests.js';
import { upsertStudent } from '../src/repositories/students.js';
import { insertStaffIdentity } from '../src/repositories/staff-identities.js';
import { todayServiceDate } from '../src/util/service-date.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';

/**
 * PL-202 — pickup_requests schema + state machine.
 *
 * T-53: Illegal transitions are typed refusals naming the attempt; no
 *       state change; an event row records each attempt.
 * T-54: Transition is idempotent on an already-decided request — the
 *       Slack at-least-once case returns the current state as a no-op.
 * T-55 (structural): `state` is written only through the transition
 *       function — grep-verified, zero occurrences elsewhere.
 * T-56: The event log is append-only at the grant level, not in
 *       application code. Mirrors T-10.
 * T-57: Two events for the same (request_id, escalation_level) are
 *       rejected by the unique constraint — in the database, so a
 *       retry, a race, or a redeployed worker cannot double-notify.
 *
 * Plus the P3 decision's enforcement points: reason_detail purged at
 * terminal states under the default retention, retained under a widen-
 * ed per-tenant setting, and swept past its service date. And tenant
 * isolation through the new tables (leak vector 21's write side).
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

const SERVICE_DATE = '2030-03-15';
// Genuinely in the past relative to the real clock — the sweep compares
// against current_date, so a fictional "past" like 2030 would not purge.
const PAST_DATE = '2020-01-02';

let db: TestDb;
let studentA: string;
let studentB: string;
// The assigned approver per tenant (PL-251): decisions are legal only
// from the request's assigned staff identity, and the creator is never
// the decider — the route actor is deliberately a different subject.
let approverA: { id: string; subject: string };
let approverB: { id: string; subject: string };
const CREATOR_SUBJECT = 'lc-coordinator@synthetic.test';

beforeAll(async () => {
  db = await provisionTestDb();

  // FORCE RLS binds the owner too — each tenant row enters under its
  // own context (B-12).
  await seedTenants(db.ownerPool, [
    [TENANT_A, 'Campus Alpha'],
    [TENANT_B, 'Campus Bravo'],
  ]);

  studentA = await withTenant(db.appPool, TENANT_A, async (client) => {
    const s = await upsertStudent(client, {
      studentRef: 'A101',
      studentName: 'Request Test Scholar',
      section: '101',
    });
    return s.id;
  });
  studentB = await withTenant(db.appPool, TENANT_B, async (client) => {
    const s = await upsertStudent(client, {
      studentRef: 'B101',
      studentName: 'Request Test Scholar',
      section: '201',
    });
    return s.id;
  });

  approverA = await withTenant(db.appPool, TENANT_A, async (client) =>
    insertStaffIdentity(client, {
      slackUserId: 'U_LC_APPROVER_A',
      subject: 'lc-approver-a@synthetic.test',
      role: 'staff',
    }),
  );
  approverB = await withTenant(db.appPool, TENANT_B, async (client) =>
    insertStaffIdentity(client, {
      slackUserId: 'U_LC_APPROVER_B',
      subject: 'lc-approver-b@synthetic.test',
      role: 'staff',
    }),
  );
});

afterAll(async () => {
  await db.cleanup();
});

// ── Helpers ───────────────────────────────────────────────────────────

interface RequestOverrides {
  serviceDate?: string;
  reasonDetail?: string | null;
  reasonCategory?: 'appointment' | 'family' | 'illness' | 'administrative' | 'other';
}

async function makeRequest(
  tenantId: string,
  studentId: string,
  overrides: RequestOverrides = {},
): Promise<PickupRequest> {
  return withTenant(db.appPool, tenantId, async (client) =>
    createPickupRequest(client, {
      serviceDate: overrides.serviceDate ?? SERVICE_DATE,
      studentId,
      pickupAt: new Date('2030-03-15T18:30:00Z'),
      reasonCategory: overrides.reasonCategory ?? 'appointment',
      reasonDetail: overrides.reasonDetail ?? 'SENTINEL-DETAIL-for-leak-assertions',
      intakeChannel: 'coordinator',
    }),
  );
}

async function drive(
  requestId: string,
  action: PickupRequestAction,
  options: { tenantId?: string; escalateAt?: Date } = {},
): Promise<TransitionResult> {
  const tenantId = options.tenantId ?? TENANT_A;
  const approver = tenantId === TENANT_A ? approverA : approverB;
  const isDecision =
    action === 'approve' || action === 'flag' || action === 'deny';
  return withTenant(db.appPool, tenantId, async (client) =>
    transitionPickupRequest(client, {
      requestId,
      action,
      // Decisions arrive as the assigned approver's subject carrying its
      // resolved identity (PL-251); routing/system actions stay under the
      // creator or the system — never the same subject as the decider.
      actor: isDecision ? approver.subject : CREATOR_SUBJECT,
      escalateAt: options.escalateAt ?? new Date('2030-03-15T20:00:00Z'),
      ...(action === 'route' ? { assignedApproverId: approver.id } : {}),
      ...(isDecision ? { actorIdentityId: approver.id } : {}),
    }),
  );
}

/** Drive a request from draft to a given state through legal transitions only. */
async function driveTo(
  requestId: string,
  target:
    'routed' | 'approved' | 'flagged' | 'denied' | 'released' | 'completed' | 'expired',
  options: { tenantId?: string } = {},
): Promise<void> {
  if (
    target === 'routed' ||
    target === 'approved' ||
    target === 'flagged' ||
    target === 'denied' ||
    target === 'released' ||
    target === 'completed' ||
    target === 'expired'
  ) {
    const routed = await drive(requestId, 'route', options);
    expect(routed.ok).toBe(true);
  }
  if (['approved', 'released', 'completed'].includes(target)) {
    const approved = await drive(requestId, 'approve', options);
    expect(approved.ok).toBe(true);
  }
  if (target === 'flagged') {
    const flagged = await drive(requestId, 'flag', options);
    expect(flagged.ok).toBe(true);
  }
  if (target === 'denied') {
    const denied = await drive(requestId, 'deny', options);
    expect(denied.ok).toBe(true);
  }
  if (['released', 'completed'].includes(target)) {
    const released = await drive(requestId, 'release', options);
    expect(released.ok).toBe(true);
  }
  if (target === 'completed') {
    const completed = await drive(requestId, 'complete', options);
    expect(completed.ok).toBe(true);
  }
  if (target === 'expired') {
    const expired = await drive(requestId, 'expire', options);
    expect(expired.ok).toBe(true);
  }
}

async function currentState(
  requestId: string,
  tenantId = TENANT_A,
): Promise<string | null> {
  const row = await withTenant(db.appPool, tenantId, async (client) =>
    findPickupRequestById(client, requestId),
  );
  return row?.state ?? null;
}

async function eventsFor(
  requestId: string,
  tenantId = TENANT_A,
): Promise<Array<{ event_type: string; escalation_level: number | null }>> {
  return withTenant(db.appPool, tenantId, async (client) => {
    const res = await client.query<{
      event_type: string;
      escalation_level: number | null;
    }>(
      `select event_type, escalation_level from pickup_request_events
       where request_id = $1 order by created_at asc, id asc`,
      [requestId],
    );
    return res.rows;
  });
}

// ── T-53: Illegal transition refused ──────────────────────────────────

describe('PL-202 · T-53: illegal transition refused', () => {
  it('draft → approve is a typed refusal naming the attempt, state unchanged, event recorded', async () => {
    const request = await makeRequest(TENANT_A, studentA);

    const result = await drive(request.id, 'approve');
    // Since PL-274 (B-1's reorder), a decision authorizes BEFORE its
    // state is classified — that ordering is what stops an idempotent
    // replay from returning a success shape to a non-assignee. On a
    // draft there is no assigned approver, so any decider is refused
    // as not the assignee; the refusal names the actor's standing, not
    // the machine's state. Still typed, still no state change, still
    // ledgered.
    expect(result).toEqual({
      ok: false,
      code: 'not_assigned_approver',
      from: 'draft',
      action: 'approve',
    });

    // No state change.
    expect(await currentState(request.id)).toBe('draft');

    // An event row records the attempt.
    const events = await eventsFor(request.id);
    expect(events.filter((e) => e.event_type === 'refused')).toHaveLength(1);
  });

  it('expired → approve is refused the same way', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'expired');

    const result = await drive(request.id, 'approve');
    expect(result).toEqual({
      ok: false,
      code: 'illegal_transition',
      from: 'expired',
      action: 'approve',
    });
    expect(await currentState(request.id)).toBe('expired');
    expect(
      (await eventsFor(request.id)).filter((e) => e.event_type === 'refused'),
    ).toHaveLength(1);
  });

  it('completed → route is refused the same way', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'completed');

    const result = await drive(request.id, 'route');
    expect(result).toEqual({
      ok: false,
      code: 'illegal_transition',
      from: 'completed',
      action: 'route',
    });
    expect(await currentState(request.id)).toBe('completed');
    expect(
      (await eventsFor(request.id)).filter((e) => e.event_type === 'refused'),
    ).toHaveLength(1);
  });

  it('a request id invisible in this tenant is not_found, never forbidden-but-real', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    const result = await drive(request.id, 'approve', { tenantId: TENANT_B });
    expect(result).toEqual({
      ok: false,
      code: 'not_found',
      from: null,
      action: 'approve',
    });
  });
});

// ── T-54: Idempotent on an already-decided request ────────────────────

describe('PL-202 · T-54: transition idempotent on an already-decided request', () => {
  it('submitting the same approval twice returns the current state and is a no-op', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'approved');

    const before = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, request.id),
    );
    const eventsBefore = await eventsFor(request.id);

    // The Slack at-least-once case: the same approval, delivered twice.
    const second = await drive(request.id, 'approve');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.idempotent).toBe(true);
      expect(second.request.state).toBe('approved');
    }

    // No second decision row: decided_at and decided_by are unchanged.
    const after = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, request.id),
    );
    expect(after!.decided_at).toEqual(before!.decided_at);
    expect(after!.decided_by).toBe(approverA.subject);

    // No second decision event.
    const eventsAfter = await eventsFor(request.id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    expect(eventsAfter.filter((e) => e.event_type === 'approved')).toHaveLength(1);
  });

  it('a conflicting re-decision after denial is a typed refusal, not a silent overwrite', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'denied');

    const result = await drive(request.id, 'approve');
    expect(result).toEqual({
      ok: false,
      code: 'illegal_transition',
      from: 'denied',
      action: 'approve',
    });
    expect(await currentState(request.id)).toBe('denied');
  });
});

// ── T-55: State written only through the transition function ─────────

describe('PL-202 · T-55 (structural): state written only through the transition function', () => {
  const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => path.join(e.parentPath, e.name));
  }

  it('no `update pickup_requests` outside the transition module', async () => {
    const files = await sourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const matches = content.match(/update\s+pickup_requests/gi) ?? [];
      if (
        path.resolve(file) ===
        path.resolve(SRC_ROOT, 'repositories', 'pickup-requests.ts')
      ) {
        // Exactly three writers live in the transition module:
        //  1. applyTransition — the private arm of transitionPickupRequest,
        //     the only place `state` is written.
        //  2. purgeStaleReasonDetail — the P3 retention sweep, which sets
        //     reason_detail only and never touches state.
        //  3. deferRow (inside processDueEscalations, PL-254) — the queue
        //     deferral: SETs escalation_attempts and escalate_at only;
        //     its `state = 'routed'` is a WHERE guard, never a write.
        expect(matches.length).toBe(3);
        const applyStart = content.indexOf('async function applyTransition');
        const purgeStart = content.indexOf(
          'export async function purgeStaleReasonDetail',
        );
        const deferStart = content.indexOf('const deferRow');
        expect(applyStart).toBeGreaterThan(-1);
        expect(purgeStart).toBeGreaterThan(applyStart);
        expect(deferStart).toBeGreaterThan(purgeStart);

        const positions = [...content.matchAll(/update\s+pickup_requests/gi)].map(
          (m) => m.index!,
        );
        // The state writer sits inside applyTransition.
        expect(positions[0]!).toBeGreaterThan(applyStart);
        expect(positions[0]!).toBeLessThan(purgeStart);
        // The sweep sits after it and sets reason_detail only.
        expect(positions[1]!).toBeGreaterThan(purgeStart);
        expect(positions[1]!).toBeLessThan(deferStart);
        const purgeBody = content.slice(purgeStart, deferStart);
        expect(
          purgeBody.match(/update\s+pickup_requests\s+set\s+reason_detail\s*=\s*null/i),
        ).not.toBeNull();
        // Nothing after the state writer SETS state — reads may filter on
        // it (`where pr.state = 'routed'` in the queue), writes may not.
        // The write shape is a SET clause reaching `state =`.
        expect(purgeBody.match(/\bset\b[\s\S]{0,200}?\bstate\s*=/i)).toBeNull();
        // The deferral writes queue fields and only queue fields — the
        // `state = 'routed'` in its WHERE clause is the guard that keeps
        // a stalled/decided row from being re-armed.
        const deferBody = content.slice(deferStart);
        expect(
          deferBody.match(
            /update\s+pickup_requests\s+set\s+escalation_attempts\s*=\s*escalation_attempts/i,
          ),
        ).not.toBeNull();
        const deferSetClause = deferBody.slice(
          deferBody.search(/update\s+pickup_requests\s+set/i),
          deferBody.search(/\bwhere\b/i),
        );
        expect(deferSetClause.match(/\bstate\s*=/i)).toBeNull();
        // applyTransition is module-private — only the chokepoint can
        // reach the state writer.
        expect(
          content.match(/export\s+(async\s+)?function\s+applyTransition/),
        ).toBeNull();
      } else {
        expect(matches, `${file} must not write pickup_requests directly`).toHaveLength(
          0,
        );
      }
    }
  });

  it('the repository exports no direct state setter', async () => {
    const content = await readFile(
      path.join(SRC_ROOT, 'repositories', 'pickup-requests.ts'),
      'utf8',
    );
    const exports = [...content.matchAll(/export\s+async\s+function\s+(\w+)/g)].map(
      (m) => m[1],
    );
    // Every exported writer is intake, lookup, or the chokepoint itself;
    // the queue listing and the due-queue claim are reads (state is
    // written only through the chokepoint callback).
    for (const name of exports) {
      expect(name).toMatch(
        /^(createPickupRequest|findPickupRequestById|insertPickupRequestEvent|getReasonDetailRetentionDays|transitionPickupRequest|purgeStaleReasonDetail|listPendingApprovalsForApprover|pickupRequestBelongsToTenant|processDueEscalations)$/,
      );
    }
  });
});

// ── T-56: Event log append-only at the grant level ───────────────────

describe('PL-202 · T-56: event log append-only at the database', () => {
  it('rejects UPDATE on pickup_request_events as the application role', async () => {
    await expect(
      withTenant(db.appPool, TENANT_A, async (client) => {
        await client.query(`update pickup_request_events set actor = 'tampered'`);
      }),
    ).rejects.toThrow();
  });

  it('rejects DELETE on pickup_request_events as the application role', async () => {
    await expect(
      withTenant(db.appPool, TENANT_A, async (client) => {
        await client.query(`delete from pickup_request_events`);
      }),
    ).rejects.toThrow();
  });

  it('INSERT and SELECT still work on pickup_request_events', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    const routed = await drive(request.id, 'route');
    expect(routed.ok).toBe(true);

    const events = await eventsFor(request.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event_type).toBe('routed');
    expect(events[0]!.escalation_level).toBe(0);
  });
});

// ── T-57: Double-fire blocked at the schema ──────────────────────────

describe('PL-202 · T-57: double-fire blocked at the schema', () => {
  it('a second event for the same (request_id, escalation_level) is rejected by the unique constraint', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'routed'); // writes the level-0 'routed' event

    let rejected = false;
    let errorCode: string | undefined;
    await withTenant(db.appPool, TENANT_A, async (client) => {
      try {
        await client.query(
          `insert into pickup_request_events
             (tenant_id, request_id, escalation_level, event_type, actor)
           values (current_setting('app.tenant_id')::uuid, $1, 0, 'escalated', 'double-fire')`,
          [request.id],
        );
      } catch (err) {
        rejected = true;
        errorCode = (err as { code?: string }).code;
      }
    });

    // Rejected by the database — a retry, a race, or a redeployed
    // worker cannot double-notify through this table.
    expect(rejected).toBe(true);
    expect(errorCode).toBe('23505'); // unique_violation
  });

  it('distinct ladder rungs coexist: routed@0 and escalated@1', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'routed');
    const escalated = await drive(request.id, 'escalate');
    expect(escalated.ok).toBe(true);

    const events = await eventsFor(request.id);
    const ladder = events.filter((e) => e.escalation_level !== null);
    expect(ladder.map((e) => e.escalation_level).sort()).toEqual([0, 1]);
    expect(ladder.map((e) => e.event_type)).toEqual(['routed', 'escalated']);
  });

  it('escalate advances the level and re-arms the clock without changing state', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'routed');

    const next = new Date('2030-03-15T20:10:00Z');
    const result = await drive(request.id, 'escalate', { escalateAt: next });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.state).toBe('routed');
      expect(result.request.escalation_level).toBe(1);
      expect(result.request.escalate_at).toEqual(next);
    }
  });
});

// ── P3 decision enforcement: reason_detail retention ─────────────────

describe('PL-202 · P3: reason_detail purged per the retention decision', () => {
  it('complete (terminal, default retention) purges reason_detail; category, row, and events persist', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'completed');

    const after = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, request.id),
    );
    expect(after!.reason_detail).toBeNull();
    expect(after!.reason_category).toBe('appointment');
    expect(after!.state).toBe('completed');

    // The dated request row and the event log persist (AD-31).
    const events = await eventsFor(request.id);
    expect(events.map((e) => e.event_type)).toContain('routed');
    expect(events.map((e) => e.event_type)).toContain('approved');
    expect(events.map((e) => e.event_type)).toContain('completed');
  });

  it('deny and expire (terminal) purge reason_detail too', async () => {
    const deniedReq = await makeRequest(TENANT_A, studentA);
    await driveTo(deniedReq.id, 'denied');
    const denied = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, deniedReq.id),
    );
    expect(denied!.reason_detail).toBeNull();

    const expiredReq = await makeRequest(TENANT_A, studentA);
    await driveTo(expiredReq.id, 'expired');
    const expired = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, expiredReq.id),
    );
    expect(expired!.reason_detail).toBeNull();
  });

  it('a non-terminal decision keeps reason_detail — the approver path never needs it, but the row is not yet terminal', async () => {
    const request = await makeRequest(TENANT_A, studentA);
    await driveTo(request.id, 'approved');
    const approved = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, request.id),
    );
    expect(approved!.reason_detail).not.toBeNull();
  });

  it('a widened per-tenant retention keeps reason_detail at terminal state', async () => {
    // Tenant B widens retention to 30 days — a config row, not a
    // migration. Written as the owner under B's context (B-12).
    await withTenant(db.ownerPool, TENANT_B, async (owner) => {
      await owner.query(
        `insert into tenant_settings (tenant_id, reason_detail_retention_days) values ($1, 30)`,
        [TENANT_B],
      );
    });

    const request = await makeRequest(TENANT_B, studentB);
    await driveTo(request.id, 'denied', { tenantId: TENANT_B });

    const after = await withTenant(db.appPool, TENANT_B, async (client) =>
      findPickupRequestById(client, request.id),
    );
    expect(after!.reason_detail).not.toBeNull();
  });

  it('the nightly sweep purges detail past its service date, and only past it', async () => {
    const stale = await makeRequest(TENANT_A, studentA, {
      serviceDate: PAST_DATE,
      reasonDetail: 'SENTINEL-stale',
    });
    const fresh = await makeRequest(TENANT_A, studentA, {
      serviceDate: todayServiceDate(),
      reasonDetail: 'SENTINEL-fresh',
    });

    const purged = await withTenant(db.appPool, TENANT_A, async (client) =>
      purgeStaleReasonDetail(client),
    );
    expect(purged).toBeGreaterThanOrEqual(1);

    const staleAfter = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, stale.id),
    );
    const freshAfter = await withTenant(db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, fresh.id),
    );
    expect(staleAfter!.reason_detail).toBeNull();
    expect(freshAfter!.reason_detail).not.toBeNull();
  });
});

// ── Tenant isolation through the new tables ──────────────────────────

describe('PL-202 · tenant isolation through pickup_requests', () => {
  it('a request is invisible outside its tenant — by row, by transition, and by raw scan', async () => {
    const request = await makeRequest(TENANT_A, studentA);

    const underB = await withTenant(db.appPool, TENANT_B, async (client) =>
      findPickupRequestById(client, request.id),
    );
    expect(underB).toBeNull();

    // B has its own requests (the widened-retention fixture); none of
    // them may be A's. A raw scan is the direct assertion — any
    // cross-tenant row is the critical fail condition.
    const bRows = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query<{ id: string }>(`select id from pickup_requests`);
      return res.rows.map((r) => r.id);
    });
    expect(bRows.includes(request.id)).toBe(false);
  });

  it('a request cannot reference another tenant’s scholar — the composite FK rejects it', async () => {
    let rejected = false;
    await withTenant(db.appPool, TENANT_A, async (client) => {
      try {
        await createPickupRequest(client, {
          serviceDate: SERVICE_DATE,
          studentId: studentB, // tenant B's scholar under tenant A's context
          pickupAt: new Date('2030-03-15T18:30:00Z'),
          reasonCategory: 'appointment',
          intakeChannel: 'coordinator',
        });
      } catch {
        rejected = true;
      }
    });
    expect(rejected).toBe(true);
  });
});
