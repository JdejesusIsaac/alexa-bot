import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  startTestMcpServer,
  SYNTHETIC_SLACK_SIGNING_SECRET,
  type TestMcpServer,
} from './helpers/mcp-server.js';
import { McpTestClient, refusalReason } from './helpers/mcp-client.js';
import { withTenant } from '../src/db/tenant-context.js';
import { findPickupRequestById } from '../src/repositories/pickup-requests.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

/**
 * T-87 (GATE, rewritten — PL-279) — the decision is one transaction,
 * proven at the DOORS.
 *
 * The Sprint AUTH evaluation's F-1: this file used to open its own
 * `withTenantTransaction` and hand the client to the service — a control
 * asserted against the thing beneath the door rather than the door
 * (B-4's lesson, one layer down). With the app door's transaction
 * actually removed (`withTenantTransaction` → `withTenant` swapped in
 * the tool handler — the recorded red run in sprint-6/test.md), the old
 * file passed 4/4: the test could not see the door lose the lock, and
 * the UPDATE's assignee predicate masked the outcome either way.
 *
 * Rewritten: every decision goes through a door — the MCP tool via the
 * test server, or a signed POST to /slack/interactions. The injection
 * rides the app pool wrapper (the T-83 seam): the door's OWN client is
 * intercepted, so the transaction under test is the door's. This file
 * imports no service and opens no transaction of its own.
 *
 * The legs:
 *
 *   1. THE LOCK (both doors): a reassignment on a second connection,
 *      under lock_timeout, fires the moment the door's transaction
 *      issues its decision UPDATE. The chokepoint took the row lock
 *      with `for update` inside that transaction — so the reassignment
 *      times out and the decision that lands is the current assignee's.
 *
 *   2. THE PREDICATE (both doors): the reassignment runs on the SAME
 *      wrapped client — inside the door's own transaction, where it
 *      cannot block — landing exactly "between check and update."
 *      The UPDATE's `assigned_approver_id` predicate misses; the stale
 *      approver's decision is refused, ledgered, and never recorded.
 *
 *   3. MUTATION (a) — the door loses its transaction, simulated at the
 *      door: the wrapper swallows begin/commit and rewrites the
 *      transaction-local tenant set_config to session-local (a
 *      transaction-local setting reverts immediately under autocommit,
 *      which would blank the tenant). The second-connection injection
 *      now LANDS — proving leg 1's `timedOut` assertion flips red the
 *      day a door loses its transaction. The predicate still refuses:
 *      defense in depth, proven at the door, not assumed.
 *
 *   4. MUTATION (b) — the predicate drops, simulated at the door: the
 *      wrapper rewrites the decision UPDATE's assignee guard into a
 *      tautology on the parameter. With the same-client reassignment in
 *      place, the stale decision LANDS — `decided_by` is the stale
 *      approver while `assigned_approver_id` is the new one, B-2's
 *      corruption — asserted deliberately, labeled the mutation.
 *      Proves leg 2 goes red without the predicate.
 */

const PICKUP_AT = '2030-03-15T18:30:00.000Z';
const ENDPOINT = '/slack/interactions';

// Fixture identities, tenant A. OLD is the section-101 assignee (the
// routed approver for A001); NEW is the default approver (the
// reassignment target).
const OLD_SUBJECT = 'lead-alpha-section@synthetic.test';
const OLD_SLACK = 'USYNTH_A_SECTION';
const NEW_SUBJECT = 'lead-alpha-default@synthetic.test';
// An unmapped creator — fine for create (the routed event only records
// the subject); keeps the creator out of every later assertion.
const CREATOR = 'coordinator-a';

/** The chokepoint's decision UPDATE — the seam every leg intercepts. */
const DECISION_UPDATE = "update pickup_requests set state = 'approved'";

/**
 * What the wrapper is armed to do when the door issues that UPDATE.
 * `result` is filled by the second-connection modes; the armed object is
 * captured per leg so the assertions read it after the door call.
 */
interface ArmState {
  readonly mode:
    | 'second-connection'
    | 'same-client'
    | 'strip-transaction'
    | 'drop-predicate';
  readonly requestId: string;
  result: { interposed: boolean; timedOut: boolean } | null;
}

let arm: ArmState | null = null;

let server: TestMcpServer;
let client: McpTestClient;
let newAssigneeId: string;

beforeAll(async () => {
  server = await startTestMcpServer({ appPoolWrapper: wrapPool });
  client = new McpTestClient(server.mcpUrl);
  newAssigneeId = await withTenant(server.db.appPool, TENANT_A, async (c) => {
    const res = await c.query<{ id: string }>(
      `select id from staff_identities where subject = $1`,
      [NEW_SUBJECT],
    );
    return res.rows[0]!.id;
  });
});

afterAll(async () => {
  await server.close();
});

// ── the pool wrapper: the injection rides the door's own client ──────

/** Normalize (text, values) out of pg's argument shapes. */
function queryArgs(args: readonly unknown[]): { text: string; values: unknown[] } {
  const first = args[0];
  if (typeof first === 'string') {
    return { text: first, values: (args[1] as unknown[] | undefined) ?? [] };
  }
  if (typeof first === 'object' && first !== null && 'text' in first) {
    const cfg = first as { text: string; values?: unknown[] };
    return { text: String(cfg.text), values: cfg.values ?? [] };
  }
  return { text: '', values: [] };
}

/** A fabricated result for swallowed transaction statements. */
const NOOP_RESULT = {
  rows: [],
  rowCount: 0,
  command: '',
  oid: 0,
  fields: [],
} as unknown as QueryResult;

/**
 * One wrapped client: every query the DOOR issues passes through here.
 * The arm is only ever set around a single door call, and the
 * interposition keys on the decision UPDATE for the target request —
 * probes, reads, and audit writes pass through untouched.
 */
function wrapClient(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(_t, prop) {
      if (prop === 'query') {
        const orig = client.query.bind(client) as (
          ...a: unknown[]
        ) => Promise<QueryResult>;
        return (...args: unknown[]): Promise<QueryResult> =>
          interceptedQuery(orig, args);
      }
      const value = Reflect.get(client, prop, client) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(client)
        : value;
    },
  }) as PoolClient;
}

async function interceptedQuery(
  orig: (...a: unknown[]) => Promise<QueryResult>,
  args: readonly unknown[],
): Promise<QueryResult> {
  let { text, values } = queryArgs(args);

  // Mutation (a): the door's transaction, stripped. begin/commit are
  // swallowed so every statement autocommits, and the transaction-local
  // tenant setting is rewritten session-local — under autocommit a
  // transaction-local setting reverts the instant its statement ends,
  // which would blank the tenant and turn this into a not-found test.
  if (arm?.mode === 'strip-transaction') {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve(NOOP_RESULT);
    }
    if (text.includes("set_config('app.tenant_id'") && text.includes(', true)')) {
      text = text.replace(', true)', ', false)');
    }
  }

  const armed = arm;
  if (
    armed !== null &&
    text.includes(DECISION_UPDATE) &&
    values[0] === armed.requestId
  ) {
    if (armed.mode === 'second-connection' || armed.mode === 'strip-transaction') {
      // Fire the reassignment on a SECOND, unwrapped connection. Under
      // the door's transaction the row lock holds and it times out
      // (leg 1); with the transaction stripped (mutation a) it lands.
      armed.result = await reassignOnSecondConnection(armed.requestId);
    } else {
      // The reassignment rides the SAME wrapped client — inside the
      // door's own transaction, where it cannot block. This is B-2's
      // race, injected deterministically. `interposed` is recorded so a
      // leg can prove the interposition FIRED — a leg whose call is
      // refused before the UPDATE never reaches this point, and must
      // not be allowed to report green without it (B-11: the Sprint 6
      // Slack predicate leg reused a row the app leg had already
      // reassigned, so the chokepoint refused ahead of the UPDATE and
      // the leg survived the predicate's removal).
      await orig(
        `update pickup_requests set assigned_approver_id = $2 where id = $1`,
        [armed.requestId, newAssigneeId],
      );
      armed.result = { interposed: true, timedOut: false };
      if (armed.mode === 'drop-predicate') {
        // Mutation (b): the assignee guard becomes a tautology on the
        // parameter — the UPDATE no longer binds to the assignee the
        // check authorized. The parameter stays referenced and cast,
        // so pg's type inference is untouched.
        text = text.replace(
          ' and assigned_approver_id = $3',
          ' and $3::uuid is not null',
        );
      }
    }
  }

  return orig(text, values);
}

/** The pool the HTTP layer sees: every client it acquires is wrapped. */
function wrapPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(_t, prop) {
      if (prop === 'connect') {
        return async (...args: unknown[]): Promise<PoolClient> =>
          wrapClient(
            await (pool.connect as (...a: unknown[]) => Promise<PoolClient>)(
              ...args,
            ),
          );
      }
      const value = Reflect.get(pool, prop, pool) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(pool)
        : value;
    },
  }) as Pool;
}

/** Reassign on a second, unwrapped connection under a short lock timeout. */
async function reassignOnSecondConnection(
  requestId: string,
): Promise<{ interposed: boolean; timedOut: boolean }> {
  let interposed = false;
  let timedOut = false;
  await withTenant(server.db.appPool, TENANT_A, async (c2) => {
    await c2.query(`set lock_timeout = '150ms'`);
    try {
      const res = await c2.query(
        `update pickup_requests set assigned_approver_id = $2 where id = $1`,
        [requestId, newAssigneeId],
      );
      interposed = (res.rowCount ?? 0) > 0;
    } catch {
      timedOut = true; // the row lock held — the reassignment could not land
    }
  });
  return { interposed, timedOut };
}

// ── the doors ─────────────────────────────────────────────────────────

async function callAs(sub: string, tool: string, args: Record<string, unknown>) {
  const token = await server.mintToken({ sub, tenantId: TENANT_A, role: 'staff' });
  const session = await client.connect({ token });
  return client.callTool(session, tool, args, { token });
}

/** Create a routed request for A001 — assigned to OLD (section 101). */
async function createRoutedRequest(): Promise<string> {
  const res = await callAs(CREATOR, 'create_pickup_request', {
    student_ref: 'A001',
    pickup_at: PICKUP_AT,
    reason_category: 'appointment',
  });
  const result = res.body?.result as
    | { structuredContent?: { request?: { request_id?: string } } }
    | undefined;
  return result!.structuredContent!.request!.request_id!;
}

async function decideApp(sub: string, requestId: string) {
  return callAs(sub, 'decide_pickup_request', {
    request_id: requestId,
    decision: 'approve',
  });
}

/**
 * One app-door call under an armed wrapper. The armed object is returned
 * so the leg can assert on what the interposition recorded — the arm is
 * cleared in the finally no matter how the door call ends.
 */
async function decideAppArmed(
  mode: ArmState['mode'],
  requestId: string,
  sub: string,
): Promise<{ res: Awaited<ReturnType<typeof decideApp>>; state: ArmState }> {
  const state: ArmState = { mode, requestId, result: null };
  arm = state;
  try {
    return { res: await decideApp(sub, requestId), state };
  } finally {
    arm = null;
  }
}

/** One Slack-door call under an armed wrapper (same discipline). */
async function decideSlackArmed(
  mode: ArmState['mode'],
  requestId: string,
  slackUserId: string,
): Promise<{ res: Response; state: ArmState }> {
  const state: ArmState = { mode, requestId, result: null };
  arm = state;
  try {
    return { res: await decideSlack(requestId, slackUserId), state };
  } finally {
    arm = null;
  }
}

async function decideSlack(requestId: string, slackUserId: string): Promise<Response> {
  const payload = JSON.stringify({
    type: 'block_actions',
    user: { id: slackUserId },
    actions: [{ action_id: 'approve', value: requestId }],
  });
  const body = new URLSearchParams({ payload }).toString();
  const ts = Math.floor(Date.now() / 1000);
  const hex = createHmac('sha256', SYNTHETIC_SLACK_SIGNING_SECRET)
    .update(`v0:${ts}:${body}`)
    .digest('hex');
  return fetch(`${server.url}${ENDPOINT}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': `v0=${hex}`,
      'x-slack-request-timestamp': String(ts),
    },
    body,
  });
}

// ── DB reads for assertions (reads are not doors) ────────────────────

async function requestRow(requestId: string) {
  return withTenant(server.db.appPool, TENANT_A, async (c) => {
    const row = await findPickupRequestById(c, requestId);
    return {
      state: row!.state,
      decidedBy: row!.decided_by,
      assignedApproverId: row!.assigned_approver_id,
    };
  });
}

async function eventsFor(requestId: string): Promise<
  readonly { event_type: string; actor: string; channel: string }[]
> {
  return withTenant(server.db.appPool, TENANT_A, async (c) => {
    const res = await c.query<{
      event_type: string;
      actor: string;
      channel: string;
    }>(
      `select event_type, actor, channel from pickup_request_events
       where request_id = $1 order by created_at asc, id asc`,
      [requestId],
    );
    return res.rows;
  });
}

// ── leg 1: the lock, through both doors ──────────────────────────────

describe('T-87 · the lock: a concurrent reassignment cannot interleave with the door transaction', () => {
  it('the app door — the row lock holds across check→update; the current assignee decides', async () => {
    const requestId = await createRoutedRequest();

    const { res, state } = await decideAppArmed(
      'second-connection',
      requestId,
      OLD_SUBJECT,
    );

    // THE proof of the door's transaction: the second connection's
    // reassignment blocked on the row lock and timed out.
    expect(state.result).not.toBeNull();
    expect(state.result!.timedOut).toBe(true);
    expect(state.result!.interposed).toBe(false);

    // The decision that landed is the CURRENT assignee's — the row is
    // internally consistent: decided_by is the assigned approver.
    expect(refusalReason(res.body)).toBeNull();
    const after = await requestRow(requestId);
    expect(after.state).toBe('approved');
    expect(after.decidedBy).toBe(OLD_SUBJECT);
    expect(after.assignedApproverId).not.toBe(newAssigneeId);
  });

  it('the Slack door — the same lock, the other channel', async () => {
    const requestId = await createRoutedRequest();

    const { res, state } = await decideSlackArmed(
      'second-connection',
      requestId,
      OLD_SLACK,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(state.result!.timedOut).toBe(true);
    expect(state.result!.interposed).toBe(false);

    const after = await requestRow(requestId);
    expect(after.state).toBe('approved');
    expect(after.decidedBy).toBe(OLD_SUBJECT);
    expect(after.assignedApproverId).not.toBe(newAssigneeId);
  });
});

// ── leg 2: the predicate, through both doors ─────────────────────────

describe('T-87 · the predicate: a reassignment that lands between the door check and update refuses the stale approver', () => {
  it('the app door — the decision UPDATE guards on assigned_approver_id', async () => {
    const racedId = await createRoutedRequest();

    const { res, state } = await decideAppArmed('same-client', racedId, OLD_SUBJECT);

    // The interposition must have fired — a leg refused before the
    // UPDATE never exercised the predicate and proves nothing (B-11).
    expect(state.result?.interposed).toBe(true);
    expect(refusalReason(res.body)).toBe('not_assigned_approver');

    // Post-commit: reassigned, undecided, and the attempt is ledgered.
    const after = await requestRow(racedId);
    expect(after.state).toBe('routed');
    expect(after.decidedBy).toBeNull();
    expect(after.assignedApproverId).toBe(newAssigneeId);
    const events = await eventsFor(racedId);
    expect(events.some((e) => e.event_type === 'refused')).toBe(true);
    expect(events.some((e) => e.event_type === 'approved')).toBe(false);
  });

  it('the Slack door — the same refusal, the other channel; then the owner decides', async () => {
    // B-11: this leg used to reuse the app leg's request — which that
    // leg had already reassigned to NEW. The chokepoint's pre-check
    // refused OLD before applyTransition ever ran, so the interposition
    // never fired and the leg stayed green with the Slack predicate
    // dropped. Each leg provisions its own request now, and asserts the
    // interposition fired — the leg cannot be green without having
    // reached the UPDATE.
    const slackRacedId = await createRoutedRequest();

    const { res, state } = await decideSlackArmed('same-client', slackRacedId, OLD_SLACK);

    expect(state.result?.interposed).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: 'not_assigned_approver',
      request_id: expect.any(String),
    });

    // Post-commit: reassigned, undecided — same invariants as the app leg.
    const raced = await requestRow(slackRacedId);
    expect(raced.state).toBe('routed');
    expect(raced.decidedBy).toBeNull();
    expect(raced.assignedApproverId).toBe(newAssigneeId);

    // And the request is still decidable — by its owner, through the door.
    const ownerRes = await decideApp(NEW_SUBJECT, slackRacedId);
    const ownerResult = ownerRes.body?.result as { isError?: boolean };
    expect(ownerResult.isError).not.toBe(true);
    const after = await requestRow(slackRacedId);
    expect(after.state).toBe('approved');
    expect(after.decidedBy).toBe(NEW_SUBJECT);
  });
});

// ── mutation (a): the door loses its transaction — simulated at the door ──

describe('T-87 · mutation (a): with the door transaction stripped, the injection lands — the lock leg would be red', () => {
  it('the app door under the OLD mechanism (autocommit) — no lock, and the predicate is the backstop', async () => {
    const requestId = await createRoutedRequest();

    const { res, state } = await decideAppArmed(
      'strip-transaction',
      requestId,
      OLD_SUBJECT,
    );

    // No lock: the reassignment interleaved — exactly what leg 1's
    // timedOut assertion turns red on. This is B-2's original race,
    // through the door.
    expect(state.result!.interposed).toBe(true);
    expect(state.result!.timedOut).toBe(false);

    // Defense in depth: the predicate refuses the stale decision
    // anyway. Against fully unfixed code (state-only guard) this
    // decision LANDED — which is what mutation (b) below demonstrates.
    expect(refusalReason(res.body)).toBe('not_assigned_approver');
    const after = await requestRow(requestId);
    expect(after.decidedBy).toBeNull();
    expect(after.state).toBe('routed');
    expect(after.assignedApproverId).toBe(newAssigneeId);
  });
});

// ── mutation (b): the predicate drops — simulated at the door ────────

describe('T-87 · mutation (b): with the assignee predicate dropped, the stale decision lands — the predicate leg would be red', () => {
  it('the app door with the guard no-oped — B-2’s corruption, deliberately asserted', async () => {
    const requestId = await createRoutedRequest();

    const { res } = await decideAppArmed('drop-predicate', requestId, OLD_SUBJECT);

    // The corruption: the door reported success, the row says the
    // STALE approver decided a request assigned to someone else. This
    // is the outcome T-87 exists to make impossible — shown here only
    // with the predicate surgically removed, labeled the mutation, so
    // the predicate leg is proven able to fail.
    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: { decision?: { state?: string } } }
      | undefined;
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent?.decision?.state).toBe('approved');

    const after = await requestRow(requestId);
    expect(after.state).toBe('approved');
    expect(after.decidedBy).toBe(OLD_SUBJECT);
    expect(after.assignedApproverId).toBe(newAssigneeId);

    const events = await eventsFor(requestId);
    const approved = events.find((e) => e.event_type === 'approved');
    expect(approved?.actor).toBe(OLD_SUBJECT);
  });
});
