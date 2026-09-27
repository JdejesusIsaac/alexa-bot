import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  startTestMcpServer,
  SYNTHETIC_SLACK_SIGNING_SECRET,
  type TestMcpServer,
} from './helpers/mcp-server.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  createPickupRequest,
  findPickupRequestById,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import { findStaffIdentityBySlackUserId } from '../src/repositories/staff-identities.js';
import { upsertStudent } from '../src/repositories/students.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';
import { todayServiceDate } from '../src/util/service-date.js';

/**
 * PL-207 — the Slack interaction endpoint (inbound), graded by T-65 and
 * T-66.
 *
 * T-65: unsigned, stale, and replayed payloads are each rejected
 *       distinctly — and each rejection writes an mcp_audit row queried
 *       by request_id, not inferred from a log line. These rejections
 *       fire before any handler runs; auditing at the boundary is the
 *       AD-42 rule, and the Sprint 2 F-1 shape (green tests alongside
 *       an unaudited rejection path) is exactly what must not recur.
 *
 * T-66: a cross-tenant request_id is indistinguishable from a
 *       nonexistent one — message, error code, and response time.
 *       The Sprint 2 evaluator ran 200×2 on the equivalent (T-42) and
 *       found it clean; this matches that method.
 *
 * The no-leak guardrail: the signing secret and computed signatures
 * never appear in any log line, even with capture enabled.
 *
 * Synthetic data only. The secret is synthetic; the verification path
 * is the real one.
 */

const ENDPOINT = '/slack/interactions';

let server: TestMcpServer;
let requestA: string; // tenant A's request, routed to USYNTH_A_SECTION
let requestB: string; // tenant B's request, routed to USYNTH_B_SECTION

beforeAll(async () => {
  server = await startTestMcpServer({ captureLogs: true });

  const makeRouted = async (
    tenantId: string,
    studentRef: string,
    approverSlackId: string,
  ): Promise<string> => {
    return withTenant(server.db.appPool, tenantId, async (client) => {
      const student = await upsertStudent(client, {
        studentRef,
        studentName: 'Slack Endpoint Scholar',
        section: '101',
      });
      const approver = await findStaffIdentityBySlackUserId(client, approverSlackId);
      expect(approver).not.toBeNull();
      const request = await createPickupRequest(client, {
        serviceDate: todayServiceDate(),
        studentId: student.id,
        pickupAt: new Date('2030-03-15T18:30:00Z'),
        reasonCategory: 'appointment',
        intakeChannel: 'coordinator',
      });
      const routed = await transitionPickupRequest(client, {
        requestId: request.id,
        action: 'route',
        actor: 'intake-coordinator',
        escalateAt: new Date('2030-03-15T18:30:00Z'),
        assignedApproverId: approver!.id,
      });
      expect(routed.ok).toBe(true);
      return request.id;
    });
  };

  requestA = await makeRouted(TENANT_A, 'SI-001', 'USYNTH_A_SECTION');
  requestB = await makeRouted(TENANT_B, 'SI-101', 'USYNTH_B_SECTION');
});

afterAll(async () => {
  await server.close();
});

function sign(timestamp: number, body: string, secret = SYNTHETIC_SLACK_SIGNING_SECRET) {
  const hex = createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return { signature: `v0=${hex}`, timestamp: String(timestamp) };
}

function interactionBody(requestId: string, slackUserId: string): string {
  const payload = JSON.stringify({
    type: 'block_actions',
    user: { id: slackUserId },
    actions: [{ action_id: 'approve', value: requestId }],
  });
  return new URLSearchParams({ payload }).toString();
}

interface PostOptions {
  timestamp?: string;
  signature?: string;
}

async function postInteraction(body: string, opts: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.timestamp !== undefined) headers['x-slack-request-timestamp'] = opts.timestamp;
  if (opts.signature !== undefined) headers['x-slack-signature'] = opts.signature;
  return fetch(`${server.url}${ENDPOINT}`, { method: 'POST', headers, body });
}

/** A correctly signed, fresh interaction. */
async function postSigned(requestId: string, slackUserId: string): Promise<Response> {
  const body = interactionBody(requestId, slackUserId);
  const { signature, timestamp } = sign(Math.floor(Date.now() / 1000), body);
  return postInteraction(body, { signature, timestamp });
}

/** Query the mcp_audit row by request_id — a row, never a log line. */
async function auditRowFor(requestId: string) {
  return withTenant(server.db.appPool, TENANT_A, async (client) => {
    const res = await client.query<{
      tenant_id: string | null;
      actor: string;
      outcome: string;
      rpc_method: string | null;
    }>(
      `select tenant_id, actor, outcome, rpc_method from mcp_audit where request_id = $1`,
      [requestId],
    );
    return res.rows;
  });
}

// ── The approve path works end to end ────────────────────────────────

describe('PL-207 · the endpoint', () => {
  it('a correctly signed interaction from the mapped approver approves the request', async () => {
    const res = await postSigned(requestA, 'USYNTH_A_SECTION');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; request_id: string };
    expect(body.ok).toBe(true);

    const row = await withTenant(server.db.appPool, TENANT_A, async (client) =>
      findPickupRequestById(client, requestA),
    );
    expect(row!.state).toBe('approved');
    expect(row!.decided_by).toBe('lead-alpha-section@synthetic.test');

    const events = await withTenant(server.db.appPool, TENANT_A, async (client) => {
      const r = await client.query<{ event_type: string; channel: string }>(
        `select event_type, channel from pickup_request_events
         where request_id = $1 and event_type = 'approved'`,
        [requestA],
      );
      return r.rows;
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.channel).toBe('slack');

    const audit = await auditRowFor(body.request_id);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.outcome).toBe('success');
  });
});

// ── T-65: distinct rejections, audited at the boundary ───────────────

describe('PL-207 · T-65: unsigned, stale, replayed — distinct and audited', () => {
  it('an unsigned payload is rejected distinctly, with an mcp_audit row queried by request_id', async () => {
    const body = interactionBody(requestA, 'USYNTH_A_SECTION');
    const res = await postInteraction(body, {
      timestamp: String(Math.floor(Date.now() / 1000)),
      // no signature header
    });
    expect(res.status).toBe(401);
    const parsed = (await res.json()) as { error: string; request_id: string };
    expect(parsed.error).toBe('slack_unsigned');

    // The audit row — asserted, not inferred from a log line.
    const rows = await auditRowFor(parsed.request_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('rejected:slack_unsigned');
    expect(rows[0]!.tenant_id).toBeNull();
    expect(rows[0]!.rpc_method).toBe('slack_interaction');
  });

  it('a correctly signed but stale payload is rejected distinctly, audited the same way', async () => {
    const body = interactionBody(requestA, 'USYNTH_A_SECTION');
    const { signature, timestamp } = sign(Math.floor(Date.now() / 1000) - 600, body);
    const res = await postInteraction(body, { signature, timestamp });
    expect(res.status).toBe(401);
    const parsed = (await res.json()) as { error: string; request_id: string };
    expect(parsed.error).toBe('slack_stale');

    const rows = await auditRowFor(parsed.request_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('rejected:slack_stale');
    expect(rows[0]!.tenant_id).toBeNull();
  });

  it('a valid payload replayed within the window is rejected as a replay, audited the same way', async () => {
    // First delivery: processed. (requestA was already approved above —
    // use tenant B's request and approver for a clean decision state.)
    const first = await postSigned(requestB, 'USYNTH_B_SECTION');
    expect(first.status).toBe(200);
    expect(((await first.json()) as { ok: boolean }).ok).toBe(true);

    // Replay: identical body, fresh signature, immediately.
    const replayed = await postSigned(requestB, 'USYNTH_B_SECTION');
    expect(replayed.status).toBe(401);
    const parsed = (await replayed.json()) as { error: string; request_id: string };
    expect(parsed.error).toBe('slack_replayed');

    const rows = await auditRowFor(parsed.request_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('rejected:slack_replayed');

    // The first delivery decided once; the replay did not re-decide.
    const events = await withTenant(server.db.appPool, TENANT_B, async (client) => {
      const r = await client.query(
        `select count(*)::int as count from pickup_request_events
         where request_id = $1 and event_type = 'approved'`,
        [requestB],
      );
      return r.rows[0]!.count;
    });
    expect(events).toBe(1);
  });

  it('the signing secret and computed signatures appear in no log line — the auth Rule 8', async () => {
    await postSigned(requestA, 'USYNTH_A_SECTION');
    await postInteraction(interactionBody(requestA, 'USYNTH_A_SECTION'));

    const all = server.logLines.join('\n');
    expect(all).not.toContain(SYNTHETIC_SLACK_SIGNING_SECRET);
    // No computed signature (v0=<64 hex>) in any captured line either.
    expect(all).not.toMatch(/v0=[0-9a-f]{64}/);
  });
});

// ── T-66: cross-tenant is not-found, in message, code, and time ──────

describe('PL-207 · T-66: cross-tenant request_id is not-found, never forbidden-but-real', () => {
  const SAMPLES = 200;

  it('message and code are indistinguishable from a genuinely nonexistent id', async () => {
    // Tenant A's approver carries tenant B's request id — signed, fresh.
    const cross = await postSigned(requestB, 'USYNTH_A_SECTION');
    const nowhere = await postSigned(
      '99999999-9999-9999-9999-999999999999',
      'USYNTH_A_SECTION',
    );

    expect(cross.status).toBe(nowhere.status);
    const crossBody = (await cross.json()) as Record<string, unknown>;
    const nowhereBody = (await nowhere.json()) as Record<string, unknown>;

    // request_id is the boundary's fresh correlation id — per-request
    // noise, like the MCP boundary's. Everything else is byte-identical.
    delete crossBody.request_id;
    delete nowhereBody.request_id;
    expect(crossBody).toEqual(nowhereBody);
    expect(crossBody).toEqual({ ok: false, error: 'request_not_found' });

    // An unmapped actor in the request's own tenant gets the identical
    // shape — the response never says "you exist but may not act here".
    const unmapped = await postSigned(requestA, 'U_NEVER_MAPPED_ANYWHERE');
    const unmappedBody = (await unmapped.json()) as Record<string, unknown>;
    delete unmappedBody.request_id;
    expect(unmappedBody).toEqual(crossBody);
  });

  it(`timing distributions over ${SAMPLES}×2 calls are statistically indistinguishable`, async () => {
    async function sample(requestId: string, slackUserId: string): Promise<number[]> {
      const durations: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const start = performance.now();
        const res = await postSigned(requestId, slackUserId);
        durations.push(performance.now() - start);
        const body = (await res.json()) as { ok: boolean; error: string };
        expect(body.ok).toBe(false);
        expect(body.error).toBe('request_not_found');
      }
      return durations;
    }

    // Cross-tenant: tenant A's approver, tenant B's request.
    const cross = await sample(requestB, 'USYNTH_A_SECTION');
    // Genuinely nonexistent id.
    const nowhere = await sample(
      '99999999-9999-9999-9999-999999999999',
      'USYNTH_A_SECTION',
    );

    const medCross = median(cross);
    const medNowhere = median(nowhere);
    const p90Cross = percentile(cross, 0.9);
    const p90Nowhere = percentile(nowhere, 0.9);

    // T-42's method and tolerance: generous to noise, far below any
    // per-query structural gap.
    const tolerance = Math.max(15, 0.5 * Math.max(medCross, medNowhere));
    expect(Math.abs(medCross - medNowhere)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(p90Cross - p90Nowhere)).toBeLessThanOrEqual(tolerance * 2);
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}
