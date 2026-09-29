import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  startTestMcpServer,
  SYNTHETIC_SLACK_SIGNING_SECRET,
  type TestMcpServer,
} from './helpers/mcp-server.js';
import { McpTestClient, refusalReason } from './helpers/mcp-client.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  findPickupRequestById,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

/**
 * T-75 (GATE, rewritten — PL-274/PL-276) — only the assigned approver
 * decides, on every channel, INCLUDING ON REPLAY.
 *
 * Every DECISION goes through a DOOR: the app legs go through
 * `decide_pickup_request` over the real MCP HTTP server; the Slack legs
 * go through signed POSTs against `/slack/interactions`. Nothing here
 * imports the service to make a decision — a control asserted against
 * the function beneath it has not been asserted against the path an
 * attacker uses (B-4's lesson; this is a rule, not a preference). The
 * one deliberate exception is SETUP mechanics: the creator-as-assignee
 * leg's reassignment runs the worker's own `escalate` action (the
 * chokepoint's transition), because reassignment has no door — the
 * decision and its replay still go through the doors.
 *
 * B-1's leg is the replay matrix: after a request is decided, a
 * non-assignee, the creator, or an unresolved actor re-sends the decision
 * through both doors. Before PL-274 the idempotent-replay branch returned
 * success before the authorization checks ran — the wire said "Decision
 * recorded" and the audit row said `success:idempotent` under an actor
 * with no right to make it. The state never changed; the audit trail was
 * the thing corrupted. So the replay legs assert refusal on the wire AND
 * no success-shaped audit row underneath.
 *
 * The Sprint AUTH evaluation's F-3 repairs, folded in as first-class legs
 * (a test that cannot fail is the F-1 class, not cleanup):
 *  - unmapped actors leave a `refused` LEDGER EVENT on both doors (the
 *    raw actor id — who tried and failed — alongside the audit rows);
 *  - the Slack replay and unmapped legs assert the record (ledger +
 *    audit rows), not just the wire;
 *  - the creator-as-assignee leg replays a DECIDED request. The old leg
 *    replayed a routed one and stayed green with PL-274 undone.
 *
 * T-54 is preserved on purpose: the assignee's own re-send stays an
 * idempotent success. The fix must not break idempotency for the actor
 * entitled to it.
 *
 * Synthetic data only. The Slack signing secret is synthetic; the
 * verification path is the real one.
 */

const PICKUP_AT = '2030-03-15T18:30:00.000Z';
const ENDPOINT = '/slack/interactions';

// Tenant A's section-101 approver is the assignee for A001's requests.
const ASSIGNEE_SUBJECT = 'lead-alpha-section@synthetic.test';
const ASSIGNEE_SLACK = 'USYNTH_A_SECTION';
// Mapped tenant-A staff, but NOT the assignee for section 101 — the
// non-assignee legs and the creator-who-is-not-the-assignee case.
const OTHER_SUBJECT = 'lead-alpha-default@synthetic.test';
const OTHER_SLACK = 'USYNTH_A_DEFAULT';
// Resolves nowhere.
const GHOST_SUBJECT = 'ghost@synthetic.test';
const GHOST_SLACK = 'USYNTH_NOBODY';

interface EventRow {
  event_type: string;
  actor: string;
  channel: string;
}

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  server = await startTestMcpServer({ captureLogs: true });
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

// ── The doors ─────────────────────────────────────────────────────────

async function callAs(
  sub: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const token = await server.mintToken({ sub, tenantId: TENANT_A, role: 'staff' });
  const session = await client.connect({ token });
  return client.callTool(session, tool, args, { token });
}

/** Create a routed request for A001 (section 101 → ASSIGNEE). */
async function createRoutedRequest(creatorSub: string): Promise<string> {
  const res = await callAs(creatorSub, 'create_pickup_request', {
    student_ref: 'A001',
    pickup_at: PICKUP_AT,
    reason_category: 'appointment',
  });
  const result = res.body?.result as
    | { structuredContent?: { request?: { request_id?: string } } }
    | undefined;
  expect(result?.structuredContent?.request?.request_id).toBeDefined();
  return result!.structuredContent!.request!.request_id!;
}

async function decideApp(sub: string, requestId: string) {
  return callAs(sub, 'decide_pickup_request', {
    request_id: requestId,
    decision: 'approve',
  });
}

/**
 * A request decided by the assignee through the app door. Each replay
 * and sweep leg provisions its own (the shared-fixture repair — F-5):
 * the old shape kept one `decidedId` in a beforeAll and counted audit
 * rows cumulatively across the file, so legs were red run alone and
 * could pass for the wrong reason together.
 */
async function decidedByAssignee(): Promise<string> {
  const id = await createRoutedRequest(OTHER_SUBJECT);
  const res = await decideApp(ASSIGNEE_SUBJECT, id);
  expect(refusalReason(res.body)).toBeNull(); // the assignee decides
  expect((await requestState(id)).state).toBe('approved');
  return id;
}

/**
 * A request escalated off its routed assignee to the default approver,
 * who then decides through the app door — the OTHER-decided shape the
 * sweep asserts. The reassignment uses the worker's own `escalate`
 * transition (setup mechanics — reassignment has no door; the decision
 * goes through the door).
 */
async function escalatedAndDecidedByOther(): Promise<string> {
  // An unmapped creator is fine for create — the routed event only
  // records the subject — and keeps the creator out of the decision.
  const id = await createRoutedRequest('coordinator-a');
  const otherApproverId = await withTenant(server.db.appPool, TENANT_A, async (c) => {
    const res = await c.query<{ id: string }>(
      `select id from staff_identities where subject = $1`,
      [OTHER_SUBJECT],
    );
    return res.rows[0]!.id;
  });
  const escalated = await withTenant(server.db.appPool, TENANT_A, async (c) =>
    transitionPickupRequest(c, {
      requestId: id,
      action: 'escalate',
      actor: 'escalation-worker',
      channel: 'worker',
      escalateAt: new Date(Date.now() + 30 * 60_000),
      assignedApproverId: otherApproverId,
    }),
  );
  expect(escalated.ok).toBe(true);
  const decided = await decideApp(OTHER_SUBJECT, id);
  expect(refusalReason(decided.body)).toBeNull();
  return id;
}

async function decideSlack(requestId: string, slackUserId: string): Promise<Response> {
  const payload = JSON.stringify({
    type: 'block_actions',
    user: { id: slackUserId },
    actions: [{ action_id: 'approve', value: requestId }],
  });
  const body = new URLSearchParams({ payload }).toString();
  const hex = createHmac('sha256', SYNTHETIC_SLACK_SIGNING_SECRET)
    .update(`v0:${Math.floor(Date.now() / 1000)}:${body}`)
    .digest('hex');
  return fetch(`${server.url}${ENDPOINT}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': `v0=${hex}`,
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
    },
    body,
  });
}

// ── DB assertions ─────────────────────────────────────────────────────

async function requestState(requestId: string) {
  return withTenant(server.db.appPool, TENANT_A, async (c) => {
    const row = await findPickupRequestById(c, requestId);
    return {
      state: row!.state,
      decidedBy: row!.decided_by,
      assignedApproverId: row!.assigned_approver_id,
    };
  });
}

async function eventsFor(requestId: string): Promise<EventRow[]> {
  return withTenant(server.db.appPool, TENANT_A, async (c) => {
    const res = await c.query<EventRow>(
      `select event_type, actor, channel from pickup_request_events
       where request_id = $1 order by created_at asc, id asc`,
      [requestId],
    );
    return res.rows;
  });
}

function decisionEvents(events: readonly EventRow[]): readonly EventRow[] {
  return events.filter((e) =>
    ['approved', 'flagged', 'denied'].includes(e.event_type),
  );
}

interface AuditRow {
  actor: string;
  outcome: string;
}

/**
 * The app door's boundary audit row lands AFTER the JSON-RPC response is
 * flushed (AD-42: `transport.handleRequest` resolves when the response is
 * written; the `mcp_audit` insert follows it). A test that queries the
 * ledger the instant the door answers races that write — a real flake
 * observed on 2026-09-28 (a 3-file run; the row arrived milliseconds
 * behind the response). The Slack door audits before responding, so only
 * the mcp_audit assertions need this.
 *
 * Poll until at least `expectAtLeast` rows match, capped — if the row
 * never appears, the final value is returned and the assertion fails
 * honestly. A wait that masked a genuine absence would be worse than
 * the flake.
 */
async function filteredAuditRowsEventually(
  query: () => Promise<AuditRow[]>,
  predicate: (a: AuditRow) => boolean,
  expectAtLeast: number,
  ms = 2000,
): Promise<AuditRow[]> {
  const start = Date.now();
  let rows = (await query()).filter(predicate);
  while (rows.length < expectAtLeast && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 25));
    rows = (await query()).filter(predicate);
  }
  return rows;
}

/** App-door decision audit rows (tool = decide_pickup_request). */
async function decideAuditRows(): Promise<AuditRow[]> {
  return withTenant(server.db.appPool, TENANT_A, async (c) => {
    const res = await c.query<AuditRow>(
      `select actor, outcome from mcp_audit
       where tool = 'decide_pickup_request' order by id asc`,
    );
    return res.rows;
  });
}

/** Slack-boundary audit rows for this surface, any tool, any tenant. */
async function slackAuditRows(tenant: string = TENANT_A): Promise<AuditRow[]> {
  return withTenant(server.db.appPool, tenant, async (c) => {
    const res = await c.query<AuditRow>(
      `select actor, outcome from mcp_audit
       where rpc_method = 'slack_interaction' order by id asc`,
    );
    return res.rows;
  });
}

/**
 * Audit-row assertions are DELTAS, never file-wide counts (the
 * shared-fixture class — F-5 found legs that pass only inside the full
 * file because their expected counts accumulate siblings' rows, and
 * B-11's leg survived its control's undo on the same mechanism).
 * mcp_audit redacts arguments, so a row cannot be scoped to a pickup
 * request; the scope is the leg's own action: snapshot BEFORE the door
 * call (the row lands just after the response — a later snapshot would
 * race it), act, then poll for the delta and assert the exact count.
 * Returns the action's result so wire assertions follow normally.
 */
async function expectAuditDelta<T>(
  query: () => Promise<AuditRow[]>,
  predicate: (a: AuditRow) => boolean,
  delta: number,
  act: () => Promise<T>,
): Promise<T> {
  const before = (await query()).filter(predicate).length;
  const result = await act();
  const rows = await filteredAuditRowsEventually(query, predicate, before + delta);
  expect(rows).toHaveLength(before + delta);
  return result;
}

// ── The assignee approves (the positive control) ──────────────────────

describe('T-75 · the assignee approves — both doors', () => {
  it('the app door records the decision under the resolved subject', async () => {
    const requestId = await createRoutedRequest(OTHER_SUBJECT);

    const res = await decideApp(ASSIGNEE_SUBJECT, requestId);
    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: { decision?: { state?: string } } }
      | undefined;
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent?.decision?.state).toBe('approved');

    const state = await requestState(requestId);
    expect(state.state).toBe('approved');
    expect(state.decidedBy).toBe(ASSIGNEE_SUBJECT);
    const events = decisionEvents(await eventsFor(requestId));
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe(ASSIGNEE_SUBJECT);
    expect(events[0]!.channel).toBe('app');
  });

  it('the Slack door records the same decision under the same subject', async () => {
    const requestId = await createRoutedRequest(OTHER_SUBJECT);

    const res = await decideSlack(requestId, ASSIGNEE_SLACK);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );

    const state = await requestState(requestId);
    expect(state.state).toBe('approved');
    expect(state.decidedBy).toBe(ASSIGNEE_SUBJECT);
    const events = decisionEvents(await eventsFor(requestId));
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe(ASSIGNEE_SUBJECT);
    expect(events[0]!.channel).toBe('slack');
  });
});

// ── A mapped non-assignee is refused ──────────────────────────────────

describe('T-75 · a mapped non-assignee is refused — both doors', () => {
  it('the app door: typed refusal, no state change, refused event, refusal audit row', async () => {
    const requestId = await createRoutedRequest(OTHER_SUBJECT);

    // The boundary audit row carries the refusal — never a success.
    // Asserted as a DELTA (+1 from this leg's own call): the snapshot
    // precedes the door call because the row lands just after it.
    const res = await expectAuditDelta(
      decideAuditRows,
      (a) =>
        a.actor === OTHER_SUBJECT && a.outcome === 'refusal:not_assigned_approver',
      1,
      () => decideApp(OTHER_SUBJECT, requestId),
    );
    expect(refusalReason(res.body)).toBe('not_assigned_approver');

    const state = await requestState(requestId);
    expect(state.state).toBe('routed');
    expect(state.decidedBy).toBeNull();
    const events = await eventsFor(requestId);
    expect(decisionEvents(events)).toHaveLength(0);
    expect(events.some((e) => e.event_type === 'refused')).toBe(true);
  });

  it('the Slack door: the same rule, the other channel', async () => {
    const requestId = await createRoutedRequest(OTHER_SUBJECT);

    const res = await expectAuditDelta(
      () => slackAuditRows(),
      (a) => a.outcome === 'slack:not_assigned_approver',
      1,
      () => decideSlack(requestId, OTHER_SLACK),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: 'not_assigned_approver',
      request_id: expect.any(String),
    });

    const state = await requestState(requestId);
    expect(state.state).toBe('routed');
    expect(state.decidedBy).toBeNull();
  });

  it('a non-assignee deciding a request they created themselves — the assignee check fires first, honestly classified', async () => {
    // The creator who is not the assignee is a non-assignee; the
    // assignee check refuses before the creator check is ever reached.
    // This leg documents the order rather than leaving it to be
    // discovered.
    const requestId = await createRoutedRequest(OTHER_SUBJECT);

    const res = await decideApp(OTHER_SUBJECT, requestId);
    expect(refusalReason(res.body)).toBe('not_assigned_approver');
    expect((await requestState(requestId)).state).toBe('routed');
  });
});

// ── The creator cannot self-approve ───────────────────────────────────

describe('T-75 · the creator cannot self-approve, even when routing assigned them — both doors', () => {
  it('the app door refuses self_approval', async () => {
    // The assignee creates the request themselves: routing assigns the
    // section approver — the creator. Their own decision is self-approval.
    const requestId = await createRoutedRequest(ASSIGNEE_SUBJECT);

    const res = await decideApp(ASSIGNEE_SUBJECT, requestId);
    expect(refusalReason(res.body)).toBe('self_approval');

    const state = await requestState(requestId);
    expect(state.state).toBe('routed');
    expect(state.decidedBy).toBeNull();
    expect(decisionEvents(await eventsFor(requestId))).toHaveLength(0);
  });

  it('the Slack door refuses self_approval', async () => {
    const requestId = await createRoutedRequest(ASSIGNEE_SUBJECT);

    const res = await decideSlack(requestId, ASSIGNEE_SLACK);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: 'self_approval',
      request_id: expect.any(String),
    });

    const state = await requestState(requestId);
    expect(state.state).toBe('routed');
    expect(state.decidedBy).toBeNull();
  });
});

// ── An unresolved actor is refused ────────────────────────────────────

describe('T-75 · an unresolved actor is refused — both doors', () => {
  it('the app door refuses an unmapped subject — the widened HF5', async () => {
    const requestId = await createRoutedRequest(OTHER_SUBJECT);

    const res = await expectAuditDelta(
      decideAuditRows,
      (a) => a.actor === GHOST_SUBJECT && a.outcome === 'refusal:unmapped_actor',
      1,
      () => decideApp(GHOST_SUBJECT, requestId),
    );
    expect(refusalReason(res.body)).toBe('unmapped_actor');

    const state = await requestState(requestId);
    expect(state.state).toBe('routed');
    expect(state.decidedBy).toBeNull();

    // F-3: the refusal reaches the LEDGER — the raw subject, who tried
    // and failed to act, recorded on the request they could not decide.
    // The wire above is unchanged; this is the staff-side record.
    const events = await eventsFor(requestId);
    expect(
      events.some(
        (e) =>
          e.event_type === 'refused' &&
          e.actor === GHOST_SUBJECT &&
          e.channel === 'app',
      ),
    ).toBe(true);
  });

  it('the Slack door answers an unmapped slack id with the not-found wire shape — and audits the refusal distinctly', async () => {
    const requestId = await createRoutedRequest(OTHER_SUBJECT);

    const res = await expectAuditDelta(
      () => slackAuditRows(),
      (a) => a.outcome === 'slack_unmapped_actor',
      1,
      () => decideSlack(requestId, GHOST_SLACK),
    );
    expect(res.status).toBe(200);
    // T-66's discipline: the wire never says "you exist but may not act
    // here" — indistinguishable from a nonexistent request.
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: 'request_not_found',
      request_id: expect.any(String),
    });

    const state = await requestState(requestId);
    expect(state.state).toBe('routed');
    expect(state.decidedBy).toBeNull();

    // F-3: the ledger records the raw slack id — staff-side only; the
    // wire above stays the uniform not-found shape.
    const events = await eventsFor(requestId);
    expect(
      events.some(
        (e) =>
          e.event_type === 'refused' &&
          e.actor === GHOST_SLACK &&
          e.channel === 'slack',
      ),
    ).toBe(true);
  });
});

// ── B-1's leg: the replay matrix ──────────────────────────────────────

describe('T-75 · replay of each refusal is refused — the idempotent branch may not bypass authorization (B-1)', () => {
  // Each leg provisions its OWN decided request (the shared-fixture
  // repair — F-5/B-11). Created by OTHER (a mapped non-assignee): the
  // creator replaying is the non-assignee replaying — the same actor,
  // both roles.

  it('a non-assignee (the creator) replaying the decided request is refused — app door', async () => {
    const decidedId = await decidedByAssignee();

    const res = await expectAuditDelta(
      decideAuditRows,
      (a) => a.actor === OTHER_SUBJECT && a.outcome === 'refusal:not_assigned_approver',
      1,
      () => decideApp(OTHER_SUBJECT, decidedId),
    );
    expect(refusalReason(res.body)).toBe('not_assigned_approver');

    // The state did not change — and neither did the record of who
    // decided it. One decision event, one decider.
    const state = await requestState(decidedId);
    expect(state.state).toBe('approved');
    expect(state.decidedBy).toBe(ASSIGNEE_SUBJECT);
    expect(decisionEvents(await eventsFor(decidedId))).toHaveLength(1);

    // The audit trail is the thing B-1 corrupted: no success-shaped row
    // may appear under the non-assignee from THIS replay (OTHER decides
    // legitimately elsewhere in the file, so the assertion is a delta,
    // not a global zero).
    const otherSuccesses = (a: AuditRow) =>
      a.actor === OTHER_SUBJECT && a.outcome.startsWith('success');
    const before = (await decideAuditRows()).filter(otherSuccesses).length;
    const replay = await decideApp(OTHER_SUBJECT, decidedId);
    expect(refusalReason(replay.body)).toBe('not_assigned_approver');
    expect(
      (await decideAuditRows()).filter(otherSuccesses),
    ).toHaveLength(before);
  });

  it('the same replay is refused — Slack door', async () => {
    const decidedId = await decidedByAssignee();

    const res = await expectAuditDelta(
      () => slackAuditRows(),
      (a) => a.outcome === 'slack:not_assigned_approver',
      1,
      () => decideSlack(decidedId, OTHER_SLACK),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: 'not_assigned_approver',
      request_id: expect.any(String),
    });

    // F-3's repair: the RECORD, not just the wire — the attempt is in
    // the ledger under the actor, and the boundary audit row carries
    // the refusal (the delta above). Before, this leg asserted the wire
    // and the decision count only: nothing pinned the record of who
    // tried.
    const events = await eventsFor(decidedId);
    expect(decisionEvents(events)).toHaveLength(1);
    expect(
      events.some(
        (e) =>
          e.event_type === 'refused' &&
          e.actor === OTHER_SUBJECT &&
          e.channel === 'slack',
      ),
    ).toBe(true);
  });

  it('an unresolved actor replaying is refused — both doors', async () => {
    const decidedId = await decidedByAssignee();

    const ghost = await expectAuditDelta(
      decideAuditRows,
      (a) => a.actor === GHOST_SUBJECT && a.outcome === 'refusal:unmapped_actor',
      1,
      () => decideApp(GHOST_SUBJECT, decidedId),
    );
    expect(refusalReason(ghost.body)).toBe('unmapped_actor');

    const ghostSlack = await decideSlack(decidedId, GHOST_SLACK);
    await expect(ghostSlack.json()).resolves.toEqual(
      expect.objectContaining({ ok: false, error: 'request_not_found' }),
    );

    // Still one decision, one decider, after every replay.
    const state = await requestState(decidedId);
    expect(state.state).toBe('approved');
    expect(state.decidedBy).toBe(ASSIGNEE_SUBJECT);
    expect(decisionEvents(await eventsFor(decidedId))).toHaveLength(1);

    // F-3: both doors' unmapped refusals reach the ledger — the app
    // door under the raw subject (the delta above), the Slack door
    // under the raw slack id — and neither produced a success-shaped
    // audit row. Before the fix this leg could not see the ledger at
    // all.
    const events = await eventsFor(decidedId);
    expect(
      events.some(
        (e) =>
          e.event_type === 'refused' &&
          e.actor === GHOST_SUBJECT &&
          e.channel === 'app',
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event_type === 'refused' &&
          e.actor === GHOST_SLACK &&
          e.channel === 'slack',
      ),
    ).toBe(true);
    expect(
      (await decideAuditRows()).filter(
        (a) => a.actor === GHOST_SUBJECT && a.outcome.startsWith('success'),
      ),
    ).toHaveLength(0); // GHOST has no legitimate success anywhere
  });

  it('the creator-as-assignee re-sending a DECIDED request is refused — self-approval does not age into permission (B-1)', async () => {
    // The F-3 repair: this leg used to replay a request that was still
    // `routed` — nobody had decided it — so it stayed green even with
    // PL-274 undone (the evaluation's finding: a test that cannot
    // fail). The replay must land on a DECIDED request: that is the
    // idempotent branch the old code returned success from.
    const selfId = await createRoutedRequest(ASSIGNEE_SUBJECT);
    const first = await decideApp(ASSIGNEE_SUBJECT, selfId);
    expect(refusalReason(first.body)).toBe('self_approval');

    // The reassignment: the worker's own action (the chokepoint's
    // `escalate`, exactly as the escalation worker invokes it) — setup
    // mechanics, because reassignment has no door. The ladder moves the
    // request off the creator to the default approver.
    const otherApproverId = await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const res = await c.query<{ id: string }>(
        `select id from staff_identities where subject = $1`,
        [OTHER_SUBJECT],
      );
      return res.rows[0]!.id;
    });
    const escalated = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      transitionPickupRequest(c, {
        requestId: selfId,
        action: 'escalate',
        actor: 'escalation-worker',
        channel: 'worker',
        escalateAt: new Date(Date.now() + 30 * 60_000),
        assignedApproverId: otherApproverId,
      }),
    );
    expect(escalated.ok).toBe(true);

    // The NEW assignee decides — through the door. The request is now
    // decided, and the creator (former assignee) re-sends: the
    // idempotent branch MUST NOT hand them a success (PL-274). With
    // PL-274 undone, this replay returns "Decision recorded" — red.
    const decided = await decideApp(OTHER_SUBJECT, selfId);
    expect(refusalReason(decided.body)).toBeNull();
    expect((await requestState(selfId)).state).toBe('approved');

    // Snapshot before the replays: the file's earlier positive controls
    // legitimately wrote ASSIGNEE_SUBJECT successes. The assertion is
    // that the replays add NONE — a snapshot-delta, not a file-wide
    // zero, because mcp_audit rows are not per-request.
    const assigneeSuccessesBefore = (await decideAuditRows()).filter(
      (a) => a.actor === ASSIGNEE_SUBJECT && a.outcome.startsWith('success'),
    ).length;

    const replay = await decideApp(ASSIGNEE_SUBJECT, selfId);
    expect(refusalReason(replay.body)).toBe('not_assigned_approver');
    const after = await requestState(selfId);
    expect(after.state).toBe('approved');
    expect(after.decidedBy).toBe(OTHER_SUBJECT);

    // The same replay through the Slack door: refused there too.
    const slackReplay = await decideSlack(selfId, ASSIGNEE_SLACK);
    expect(slackReplay.status).toBe(200);
    await expect(slackReplay.json()).resolves.toEqual({
      ok: false,
      error: 'not_assigned_approver',
      request_id: expect.any(String),
    });

    // One decision, one decider — and no success-shaped audit row
    // added under the creator by either replay.
    const events = decisionEvents(await eventsFor(selfId));
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe(OTHER_SUBJECT);
    expect(
      (await decideAuditRows()).filter(
        (a) => a.actor === ASSIGNEE_SUBJECT && a.outcome.startsWith('success'),
      ),
    ).toHaveLength(assigneeSuccessesBefore);
  });

  it("the assignee's own re-send remains an idempotent success (T-54 preserved)", async () => {
    const decidedId = await decidedByAssignee();

    const res = await decideApp(ASSIGNEE_SUBJECT, decidedId);
    const result = res.body?.result as { isError?: boolean };
    expect(result.isError).not.toBe(true);

    const state = await requestState(decidedId);
    expect(state.state).toBe('approved');
    expect(state.decidedBy).toBe(ASSIGNEE_SUBJECT);
    // One decision event — the replay added none.
    expect(decisionEvents(await eventsFor(decidedId))).toHaveLength(1);

    const slackReplay = await decideSlack(decidedId, ASSIGNEE_SLACK);
    await expect(slackReplay.json()).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(decisionEvents(await eventsFor(decidedId))).toHaveLength(1);
  });
});

// ── The sweep ─────────────────────────────────────────────────────────

describe('T-75 · the sweep — zero decision rows whose actor is unresolved or non-assigned', () => {
  it('every decision event resolves through staff_identities to the assigned approver', async () => {
    // Self-provisioned (the shared-fixture repair): the sweep is a
    // global invariant over the file's activity, but run ALONE there is
    // no activity — this leg first makes its own decision through the
    // door so the invariant has something to hold over.
    await decidedByAssignee();

    const rows = await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const res = await c.query<{
        request_id: string;
        actor: string;
        decided_by: string | null;
        assignee_subject: string | null;
      }>(
        `select e.request_id, e.actor, pr.decided_by,
                (select si.subject from staff_identities si
                  where si.id = pr.assigned_approver_id) as assignee_subject
         from pickup_request_events e
         join pickup_requests pr on pr.id = e.request_id
         where e.event_type in ('approved', 'flagged', 'denied')`,
      );
      return res.rows;
    });

    expect(rows.length).toBeGreaterThan(0); // this file decided things
    for (const row of rows) {
      // Resolved through staff_identities — and equal to the assignee's
      // subject at decision time. Both, on every row.
      expect(row.assignee_subject, `request ${row.request_id}`).not.toBeNull();
      expect(row.actor).toBe(row.assignee_subject);
      expect(row.decided_by).toBe(row.assignee_subject);
    }
  });

  it('no success-shaped audit row exists under a non-assignee or unresolved actor — either ledger', async () => {
    // Self-provisioned: an assignee-decided request AND an
    // escalated-then-decided-by-OTHER request, so both entitled actors
    // exist when this leg runs alone (in the full file, earlier legs
    // contribute more — the invariant is global either way).
    await decidedByAssignee();
    await escalatedAndDecidedByOther();

    // The actors entitled to a success: exactly those whose approved
    // decision event exists and matches the request's `decided_by` (the
    // leg above joins actor to assignee at decision time). OTHER_SUBJECT
    // joins the entitled set this sprint: the creator-as-assignee leg
    // escalates its request and the new assignee decides it through the
    // door — a legitimate success the old hardcoded sweep would have
    // miscounted as a violation.
    const approvedActors = await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const res = await c.query<{ actor: string }>(
        `select distinct e.actor from pickup_request_events e
         join pickup_requests pr on pr.id = e.request_id
         where e.event_type in ('approved', 'flagged', 'denied')
           and pr.decided_by = e.actor`,
      );
      return new Set(res.rows.map((r) => r.actor));
    });
    expect(approvedActors.size).toBeGreaterThan(0);
    expect(approvedActors.has(ASSIGNEE_SUBJECT)).toBe(true);
    expect(approvedActors.has(OTHER_SUBJECT)).toBe(true); // the escalated request's new assignee
    expect(approvedActors.has(GHOST_SUBJECT)).toBe(false);

    // The app door's boundary ledger (mcp_audit, by tool).
    const decideAudit = await decideAuditRows();
    const successes = decideAudit.filter((a) => a.outcome.startsWith('success'));
    expect(successes.length).toBeGreaterThan(0); // the assignee's — and only the entitled
    for (const row of successes) {
      expect(
        approvedActors.has(row.actor),
        `mcp_audit success under ${row.actor}`,
      ).toBe(true);
    }

    // The Slack service's ledger (audit_log, by action).
    const serviceAudit = await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const res = await c.query<AuditRow>(
        `select actor, outcome from audit_log
         where action = 'decidePickupRequest' order by id asc`,
      );
      return res.rows;
    });
    for (const row of serviceAudit.filter((a) => a.outcome.startsWith('success'))) {
      expect(
        approvedActors.has(row.actor),
        `audit_log success under ${row.actor}`,
      ).toBe(true);
    }
  });
});
