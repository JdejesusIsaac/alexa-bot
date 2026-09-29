import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  findPickupRequestById,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import { CaptureSlackClient } from '../src/slack/capture-client.js';
import { createPickupNotifier } from '../src/services/pickup-notification.js';
import { type SlackClient, type SlackMessage } from '../src/slack/slack-client.js';
import { createLogger } from '../src/logging/logger.js';
import {
  TENANT_A,
  TENANT_A_APPROVER_SECTION,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-252/PL-253 — the approval loop is wired end to end, graded by
 * T-76 (wiring + payload discipline on the new block shape + the
 * level-0 clock) and T-77 (the release/complete lifecycle reachable
 * through the real tool surface).
 *
 * T-76's exercise is through `create_pickup_request` — the tool call
 * itself — not the service in isolation, because Sprint 3's finding was
 * precisely that a correct function with no caller is not a feature.
 * The Slack side is the capture client (what WOULD have gone on the
 * wire), swappable per test for the failing and throwing clients.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

const SENTINEL = 'SENTINEL-notify-detail-4d7b';
const PICKUP_AT = '2030-03-15T18:30:00.000Z';
const VISIBILITY_CHANNEL = 'C-VISIBILITY-TEST';
const REVIEW_URL = 'https://parentline.example/review';
// A001 is section 101 → routed to the section approver, whose Slack id
// is the DM target.
const APPROVER_SLACK_ID = 'USYNTH_A_SECTION';
const ASSIGNEE_A = 'lead-alpha-section@synthetic.test';
// A second tenant-A staff identity — the front-office caller for
// record_pickup_outcome (release is not the assignee's act, PL-252).
const FRONT_OFFICE = 'lead-alpha-default@synthetic.test';

let server: TestMcpServer;
let plainServer: TestMcpServer;
let client: McpTestClient;
let plainClient: McpTestClient;
let capture: CaptureSlackClient;

beforeAll(async () => {
  // The delegating client lets each test swap the capture client's
  // mode without booting another server.
  const proxySlack: SlackClient = {
    postMessage: (message: SlackMessage) => capture.postMessage(message),
  };
  const logger = createLogger({ logLevel: 'error' });
  server = await startTestMcpServer({
    captureLogs: true,
    pickupNotifier: createPickupNotifier({
      slack: proxySlack,
      visibilityChannel: VISIBILITY_CHANNEL,
      link: REVIEW_URL,
      logger,
    }),
    escalationLadders: { [TENANT_A]: { initialMinutes: 45 } },
  });
  plainServer = await startTestMcpServer({ captureLogs: true, logLevel: 'warn' });
  client = new McpTestClient(server.mcpUrl);
  plainClient = new McpTestClient(plainServer.mcpUrl);
});

afterAll(async () => {
  await server.close();
  await plainServer.close();
});

async function callAs(
  target: TestMcpServer,
  sub: string,
  tool: string,
  args: Record<string, unknown> | undefined,
) {
  const token = await target.mintToken({ sub, tenantId: TENANT_A, role: 'staff' });
  const c = target === plainServer ? plainClient : client;
  const session = await c.connect({ token });
  return c.callTool(session, tool, args ?? {}, { token });
}

/** Create + route a request for A001 through the real tool. */
async function createRouted(
  target: TestMcpServer,
  sub = 'coordinator-a',
): Promise<string> {
  const res = await callAs(target, sub, 'create_pickup_request', {
    student_ref: 'A001',
    pickup_at: PICKUP_AT,
    reason_category: 'appointment',
    reason_detail: SENTINEL,
  });
  const result = res.body?.result as
    | { structuredContent?: { request?: { request_id?: string } } }
    | undefined;
  expect(result?.structuredContent?.request?.request_id).toBeDefined();
  return result!.structuredContent!.request!.request_id!;
}

// ── T-76: the approval loop is closed ────────────────────────────────

describe('PL-252 · T-76: a created request notifies, with an approve action', () => {
  it('produces the assignee DM (with the approve block), the thread post, and the routed row', async () => {
    capture = new CaptureSlackClient();
    const requestId = await createRouted(server);

    expect(capture.messages()).toHaveLength(2);

    // The DM — to the assignee's slack id, with the approve action the
    // interaction endpoint already parses (action_id/value shape).
    const dm = capture.messages()[0]!;
    expect(dm.channel).toBe(APPROVER_SLACK_ID);
    const actions = dm.blocks?.find((b) => b.type === 'actions') as
      | { elements?: Array<{ action_id?: string; value?: string }> }
      | undefined;
    expect(actions).toBeDefined();
    expect(actions!.elements).toHaveLength(1);
    expect(actions!.elements![0]!.action_id).toBe('approve');
    expect(actions!.elements![0]!.value).toBe(requestId);

    // The visibility thread — low detail, the room is informed without
    // becoming the request.
    const thread = capture.messages()[1]!;
    expect(thread.channel).toBe(VISIBILITY_CHANNEL);

    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.state).toBe('routed');
    expect(row!.assigned_approver_id).toBe(TENANT_A_APPROVER_SECTION);
  });

  it('the sentinel appears in no text, no serialized block, no log line', async () => {
    capture = new CaptureSlackClient();
    await createRouted(server);

    for (const m of capture.messages()) {
      expect(m.text).not.toContain(SENTINEL);
      expect(m.text).not.toContain('appointment');
      expect(JSON.stringify(m.blocks ?? [])).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(server.logLines)).not.toContain(SENTINEL);
  });

  it('a failing send never fails the tool call or alters the request', async () => {
    capture = new CaptureSlackClient({ fail: 'fail' });
    const requestId = await createRouted(server);

    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.state).toBe('routed');
    // Attempted wire content stays clean even on the failure path.
    for (const m of capture.messages()) {
      expect(JSON.stringify(m)).not.toContain(SENTINEL);
    }
  });

  it('a throwing client is contained — the call succeeds and nothing propagates', async () => {
    capture = new CaptureSlackClient({ fail: 'throw' });
    const requestId = await createRouted(server);

    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.state).toBe('routed');
    for (const m of capture.messages()) {
      expect(JSON.stringify(m)).not.toContain(SENTINEL);
    }
  });

  it('with a ladder configured the level-0 clock is min(pickup_at, now + initial_minutes)', async () => {
    capture = new CaptureSlackClient();
    const before = Date.now();
    const requestId = await createRouted(server);
    const after = Date.now();

    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    // PL-253: escalation starts before the parent is due.
    expect(row!.escalate_at!.getTime()).toBeLessThan(new Date(PICKUP_AT).getTime());
    expect(row!.escalate_at!.getTime()).toBeGreaterThanOrEqual(before + 45 * 60_000 - 5_000);
    expect(row!.escalate_at!.getTime()).toBeLessThanOrEqual(after + 45 * 60_000 + 5_000);
  });

  it('without Slack config the request still routes and nothing is sent', async () => {
    const requestId = await createRouted(plainServer);
    const row = await withTenant(plainServer.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.state).toBe('routed');

    // And without a ladder the clock is the pickup time, honestly
    // warned — PL-253's configured-or-logged posture.
    expect(row!.escalate_at!.toISOString()).toBe(PICKUP_AT);
    expect(
      plainServer.logLines.some((l) => l.includes('initial_clock_unconfigured')),
    ).toBe(true);
  });
});

// ── T-77: the lifecycle is reachable end to end ──────────────────────

describe('PL-252 · T-77: approve → release → complete through the real surfaces', () => {
  async function eventsFor(requestId: string) {
    return withTenant(server.db.appPool, TENANT_A, async (c) => {
      const r = await c.query<{ event_type: string; actor: string }>(
        `select event_type, actor from pickup_request_events
         where request_id = $1 order by created_at asc, id asc`,
        [requestId],
      );
      return r.rows;
    });
  }

  async function auditFor(requestId: string) {
    void requestId; // audit rows key on the HTTP request id, not the request row
    return withTenant(server.db.appPool, TENANT_A, async (c) => {
      const r = await c.query<{ tool: string | null; outcome: string; actor: string }>(
        `select tool, outcome, actor from mcp_audit where tool = 'record_pickup_outcome'`,
      );
      return r.rows;
    });
  }

  it('drives the full loop; release needs staff, not the assignee', async () => {
    capture = new CaptureSlackClient();
    const requestId = await createRouted(server);

    // The assignee approves.
    const decided = await callAs(server, ASSIGNEE_A, 'decide_pickup_request', {
      request_id: requestId,
      decision: 'approve',
    });
    expect((decided.body?.result as { isError?: boolean })?.isError).not.toBe(true);

    // The front office — a mapped staff identity who is NOT the
    // assignee — records the release, then the completion.
    const released = await callAs(server, FRONT_OFFICE, 'record_pickup_outcome', {
      request_id: requestId,
      outcome: 'release',
    });
    const relResult = released.body?.result as
      | { isError?: boolean; structuredContent?: { outcome?: { state?: string } } }
      | undefined;
    expect(relResult?.isError).not.toBe(true);
    expect(relResult?.structuredContent?.outcome?.state).toBe('released');

    const completed = await callAs(server, FRONT_OFFICE, 'record_pickup_outcome', {
      request_id: requestId,
      outcome: 'complete',
    });
    const compResult = completed.body?.result as
      | { isError?: boolean; structuredContent?: { outcome?: { state?: string } } }
      | undefined;
    expect(compResult?.structuredContent?.outcome?.state).toBe('completed');

    // Event rows under the resolved subject, in order.
    const events = await eventsFor(requestId);
    expect(events.map((e) => e.event_type)).toEqual([
      'routed',
      'approved',
      'released',
      'completed',
    ]);
    expect(events[2]!.actor).toBe(FRONT_OFFICE);
    expect(events[3]!.actor).toBe(FRONT_OFFICE);

    // The tool's audit rows exist — boundary, not log (AD-42).
    const audit = await auditFor(requestId);
    const outcomeRows = audit.filter(
      (a) => a.tool === 'record_pickup_outcome' && a.actor === FRONT_OFFICE,
    );
    expect(outcomeRows.filter((a) => a.outcome === 'success').length).toBe(2);
  });

  it('routed → release and approved → complete are illegal_transition refusals', async () => {
    const routedId = await createRouted(server);
    const early = await callAs(server, FRONT_OFFICE, 'record_pickup_outcome', {
      request_id: routedId,
      outcome: 'release',
    });
    const earlyResult = early.body?.result as
      | { isError?: boolean; structuredContent?: Record<string, unknown> }
      | undefined;
    expect(earlyResult?.isError).toBe(true);
    expect(earlyResult?.structuredContent).toEqual({
      kind: 'refusal',
      reason: 'illegal_transition',
    });

    const approvedId = await createRouted(server);
    await callAs(server, ASSIGNEE_A, 'decide_pickup_request', {
      request_id: approvedId,
      decision: 'approve',
    });
    const skip = await callAs(server, FRONT_OFFICE, 'record_pickup_outcome', {
      request_id: approvedId,
      outcome: 'complete',
    });
    const skipResult = skip.body?.result as
      | { isError?: boolean; structuredContent?: Record<string, unknown> }
      | undefined;
    expect(skipResult?.structuredContent).toEqual({
      kind: 'refusal',
      reason: 'illegal_transition',
    });
  });

  it('terminal states refuse the outcome tool — expired and denied never release', async () => {
    // Denied via the decision path.
    const deniedId = await createRouted(server);
    await callAs(server, ASSIGNEE_A, 'decide_pickup_request', {
      request_id: deniedId,
      decision: 'deny',
    });
    const deniedRelease = await callAs(server, FRONT_OFFICE, 'record_pickup_outcome', {
      request_id: deniedId,
      outcome: 'release',
    });
    expect(
      (deniedRelease.body?.result as { structuredContent?: Record<string, unknown> })
        ?.structuredContent,
    ).toEqual({ kind: 'refusal', reason: 'illegal_transition' });

    // Expired — driven through the repository (the worker's transition,
    // non-decision) because no tool surface expires a request.
    const expiredId = await createRouted(server);
    await withTenant(server.db.appPool, TENANT_A, async (c) => {
      const res = await transitionPickupRequest(c, {
        requestId: expiredId,
        action: 'expire',
        actor: 'escalation-worker',
        channel: 'worker',
      });
      expect(res.ok).toBe(true);
    });
    const expiredRelease = await callAs(server, FRONT_OFFICE, 'record_pickup_outcome', {
      request_id: expiredId,
      outcome: 'release',
    });
    expect(
      (expiredRelease.body?.result as { structuredContent?: Record<string, unknown> })
        ?.structuredContent,
    ).toEqual({ kind: 'refusal', reason: 'illegal_transition' });
  });

  it('an unmapped caller cannot record an outcome — the staff gate holds here too', async () => {
    const requestId = await createRouted(server);
    await callAs(server, ASSIGNEE_A, 'decide_pickup_request', {
      request_id: requestId,
      decision: 'approve',
    });

    const res = await callAs(server, 'ghost@synthetic.test', 'record_pickup_outcome', {
      request_id: requestId,
      outcome: 'release',
    });
    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: Record<string, unknown> }
      | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual({
      kind: 'refusal',
      reason: 'unmapped_actor',
    });

    const row = await withTenant(server.db.appPool, TENANT_A, async (c) =>
      findPickupRequestById(c, requestId),
    );
    expect(row!.state).toBe('approved');
  });
});
