import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import { withTenant } from '../src/db/tenant-context.js';
import { findPickupRequestById } from '../src/repositories/pickup-requests.js';
import { TOOL_MINIMUM_FIELDS, project } from '../src/disclosure/policy.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';

/**
 * PL-208 — the request-lifecycle tools, graded by T-70.
 *
 * Each response carries exactly its declared minimum set, on success
 * AND refusal — nothing merely cleared rides along. The reason detail
 * a coordinator enters at intake (a sentinel, here) is stored under the
 * P3 clearance rules and never returns: not in the structured content,
 * not in the text summary, on any path.
 *
 * Also covers: the approver's queue is THE CALLER's (AD-27 — one named
 * approver), decisions record the caller's token subject as
 * `decided_by` with the note on the event, cross-tenant request ids
 * are not-found, and the three descriptions are deliberately disjoint.
 */

const SENTINEL = 'SENTINEL-create-intake-detail-9c2f';
const PICKUP_AT = '2030-03-15T18:30:00.000Z';
// A001 is section 101 → assigned approver is this staff-identity subject
// (PL-251: only the assignee may decide; callers resolve through
// staff_identities, so decision callers carry a mapped subject).
const ASSIGNEE_A = 'lead-alpha-section@synthetic.test';
const ASSIGNEE_B = 'lead-bravo-section@synthetic.test';

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  server = await startTestMcpServer();
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

async function callAs(
  sub: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  tenantId: string = TENANT_A,
) {
  const token = await server.mintToken({ sub, tenantId, role: 'staff' });
  const session = await client.connect({ token });
  return client.callTool(session, tool, args ?? {}, { token });
}

/** Create a routed request for A001 (section 101 → the section approver). */
async function createRoutedRequest(sub = 'coordinator-a'): Promise<string> {
  const res = await callAs(sub, 'create_pickup_request', {
    student_ref: 'A001',
    pickup_at: PICKUP_AT,
    reason_category: 'appointment',
    reason_detail: SENTINEL,
  });
  const result = res.body?.result as
    { structuredContent?: { request?: { request_id?: string } } } | undefined;
  expect(result?.structuredContent?.request?.request_id).toBeDefined();
  return result!.structuredContent!.request!.request_id!;
}

// ── create_pickup_request ─────────────────────────────────────────────

describe('PL-208 · T-70: create_pickup_request', () => {
  it('creates and routes with exactly the minimum set — and the detail never returns', async () => {
    const res = await callAs('coordinator-a', 'create_pickup_request', {
      student_ref: 'A001',
      pickup_at: PICKUP_AT,
      reason_category: 'appointment',
      reason_detail: SENTINEL,
    });

    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: { request?: Record<string, unknown> } }
      | undefined;
    expect(result?.isError).not.toBe(true);

    // Exactly the declared minimum set (T-70).
    const request = result?.structuredContent?.request;
    expect(Object.keys(request!).sort()).toEqual(
      [...(TOOL_MINIMUM_FIELDS.create_pickup_request ?? [])].sort(),
    );
    expect(request!.state).toBe('routed');

    // The sentinel never returns — not in the structured content, not
    // in the text summary. The P3 clearance, behaviorally.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(res.rawText).not.toContain(SENTINEL);
    expect(request).not.toHaveProperty('reason_detail');
    expect(request).not.toHaveProperty('reason_category');

    // The request is routed to the section approver with the clock set
    // to the pickup time — decide before the parent arrives.
    const requestId = request!.request_id as string;
    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.state).toBe('routed');
    expect(row!.assigned_approver_id).not.toBeNull();
    expect(row!.escalate_at?.toISOString()).toBe(PICKUP_AT);
    // Stored, not returned — the detail lives in Postgres (AD-28).
    expect(row!.reason_detail).toBe(SENTINEL);
  });

  it('an unknown scholar is a typed refusal carrying nothing but kind and reason', async () => {
    const before = await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const r = await c.query<{ count: string }>(
        `select count(*)::text as count from pickup_requests`,
      );
      return parseInt(r.rows[0]!.count, 10);
    });

    const res = await callAs('coordinator-a', 'create_pickup_request', {
      student_ref: 'ZZZ999',
      pickup_at: PICKUP_AT,
      reason_category: 'appointment',
    });

    const result = res.body?.result as
      { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual({
      kind: 'refusal',
      reason: 'student_not_found',
    });

    // Nothing was created.
    const after = await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const r = await c.query<{ count: string }>(
        `select count(*)::text as count from pickup_requests`,
      );
      return parseInt(r.rows[0]!.count, 10);
    });
    expect(after).toBe(before);
  });
});

// ── list_pending_approvals ────────────────────────────────────────────

describe('PL-208 · T-70: list_pending_approvals', () => {
  it("returns the caller's queue, each row exactly the minimum set", async () => {
    await createRoutedRequest();

    // A001 is in section 101 — the fixture routes that section to
    // lead-alpha-section@synthetic.test.
    const res = await callAs(
      'lead-alpha-section@synthetic.test',
      'list_pending_approvals',
      undefined,
    );

    const result = res.body?.result as
      | {
          structuredContent?: {
            approvals?: Array<Record<string, unknown>>;
            total?: number;
          };
        }
      | undefined;
    const approvals = result?.structuredContent?.approvals ?? [];
    expect(result?.structuredContent?.total).toBeGreaterThanOrEqual(1);

    for (const row of approvals) {
      expect(Object.keys(row).sort()).toEqual(
        [...(TOOL_MINIMUM_FIELDS.list_pending_approvals ?? [])].sort(),
      );
      // The intake sentinel never rides along on the queue either.
      expect(JSON.stringify(row)).not.toContain(SENTINEL);
      expect(row).not.toHaveProperty('reason_detail');
    }
    expect(approvals.some((r) => r.state === undefined)).toBe(true); // state not in the minimum set
  });

  it('a caller who is not an approver has an empty queue — not an error', async () => {
    const res = await callAs('some-random-staff', 'list_pending_approvals', undefined);
    const result = res.body?.result as
      | {
          isError?: boolean;
          structuredContent?: { approvals?: unknown[]; total?: number };
        }
      | undefined;
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent?.approvals).toEqual([]);
    expect(result?.structuredContent?.total).toBe(0);
  });
});

// ── decide_pickup_request ─────────────────────────────────────────────

describe('PL-208 · T-70: decide_pickup_request', () => {
  it('records the decision under the caller’s subject, with the note on the event', async () => {
    const requestId = await createRoutedRequest();

    const res = await callAs(ASSIGNEE_A, 'decide_pickup_request', {
      request_id: requestId,
      decision: 'approve',
      note: 'Confirmed with the front office.',
    });

    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: { decision?: Record<string, unknown> } }
      | undefined;
    expect(result?.isError).not.toBe(true);

    // Exactly the declared minimum set (T-70).
    const decision = result?.structuredContent?.decision;
    expect(Object.keys(decision!).sort()).toEqual(
      [...(TOOL_MINIMUM_FIELDS.decide_pickup_request ?? [])].sort(),
    );
    expect(decision!.state).toBe('approved');

    // The decision is attributable to the caller's subject, not to a
    // session or a raw id; the note is on the event, never the response.
    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.decided_by).toBe(ASSIGNEE_A);
    expect(JSON.stringify(result)).not.toContain('Confirmed with the front office.');

    const events = await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const r = await c.query<{ event_type: string; actor: string; note: string | null }>(
        `select event_type, actor, note from pickup_request_events where request_id = $1 and event_type = 'approved'`,
        [requestId],
      );
      return r.rows;
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe(ASSIGNEE_A);
    expect(events[0]!.note).toBe('Confirmed with the front office.');
  });

  it('an unknown or foreign-tenant request id is not_found, carrying nothing but kind and reason', async () => {
    const res = await callAs(ASSIGNEE_A, 'decide_pickup_request', {
      request_id: '99999999-9999-9999-9999-999999999999',
      decision: 'approve',
    });
    const result = res.body?.result as
      { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual({ kind: 'refusal', reason: 'not_found' });

    // A request that exists in another tenant is equally not_found —
    // under a subject mapped in B, so the identity resolves and only
    // the request is invisible.
    const foreignId = await createRoutedRequest();
    const foreign = await callAs(
      ASSIGNEE_B,
      'decide_pickup_request',
      {
        request_id: foreignId,
        decision: 'approve',
      },
      TENANT_B,
    );
    const foreignResult = foreign.body?.result as
      { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
    expect(foreignResult?.structuredContent).toEqual({
      kind: 'refusal',
      reason: 'not_found',
    });
  });

  it('a conflicting re-decision is an illegal_transition refusal, never a silent overwrite', async () => {
    const requestId = await createRoutedRequest();
    await callAs(ASSIGNEE_A, 'decide_pickup_request', {
      request_id: requestId,
      decision: 'approve',
    });

    const res = await callAs(ASSIGNEE_A, 'decide_pickup_request', {
      request_id: requestId,
      decision: 'deny',
    });
    const result = res.body?.result as
      { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual({
      kind: 'refusal',
      reason: 'illegal_transition',
    });

    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.state).toBe('approved');
  });
});

// ── Descriptions are deliberately disjoint (AD-16, wrong-tool selection) ──

describe('PL-208 · T-70: the three descriptions are disjoint', () => {
  it('each names its own action and no other tool’s', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const session = await client.connect({ token });
    const listed = await client.listTools(session, { token });
    const tools =
      (
        listed.body?.result as
          { tools?: Array<{ name: string; description?: string }> } | undefined
      )?.tools ?? [];

    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));

    const create = byName.get('create_pickup_request')!;
    const list = byName.get('list_pending_approvals')!;
    const decide = byName.get('decide_pickup_request')!;

    // Each names its own action…
    expect(create).toContain('Record a new early-pickup request');
    expect(list).toContain('waiting for YOUR decision');
    expect(decide).toContain('approve it, flag it for a closer look, or deny');

    // …and each tells the model when NOT to use the other two.
    expect(create).toContain('Do not use it to look up an existing request');
    expect(list).toContain('Do not use it to create a request');
    expect(decide).toContain('Do not use it to create requests');

    // The three texts share no long phrase with the Sprint 2 tools'
    // surface either — spot-check the load-bearing terms.
    for (const description of [create, list, decide]) {
      expect(description).not.toContain('dismissal status of one specific scholar');
      expect(description).not.toContain('List the scholars on today');
    }
  });

  it('the projection of a full pickup row through every tool carries no reason detail', async () => {
    // The unit leg of T-70: the row the DB returns, projected through
    // every declared minimum set, discloses no reason detail.
    const row = {
      id: 'x',
      request_id: 'x',
      state: 'routed',
      pickup_at: new Date(PICKUP_AT),
      reason_category: 'appointment',
      reason_detail: SENTINEL,
      escalation_level: 0,
      decided_at: null,
      decided_by: null,
      student_name: 'Someone',
    };
    for (const tool of Object.keys(TOOL_MINIMUM_FIELDS)) {
      const projected = project(row, tool, 'staff');
      expect(projected).not.toHaveProperty('reason_detail');
    }
  });
});
