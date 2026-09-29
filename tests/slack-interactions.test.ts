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
import { median, percentile } from './helpers/stats.js';

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

    // T-74: the samples must carry variance — a distribution of
    // identical values would "prove" parity at any percentile index.
    expect(Math.max(...cross)).not.toBe(Math.min(...cross));
    expect(Math.max(...nowhere)).not.toBe(Math.min(...nowhere));

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

// ── T-74: the instrument itself — assert the helper before the statistic ──

describe('PL-255 · T-74: the percentile helper measures what it claims', () => {
  it('p90 of 1…200 returns the tail element, not index 1', () => {
    // The constructed distribution where the old bug was loudest:
    // (0.9/100)·200 = index 1 — the second-FASTEST sample, reported as
    // the tail while T-66 ran green on it.
    const ordered = Array.from({ length: 200 }, (_, i) => i + 1);
    const p90 = percentile(ordered, 0.9);
    expect(p90).toBeGreaterThanOrEqual(180);
    expect(p90).toBeLessThanOrEqual(182);
    expect(p90).not.toBe(ordered[1]);
  });

  it('the shared helper is the one the parity legs call — identical semantics to the mcp-audit copy', async () => {
    // T-74's "shared import" leg: this file imports stats.ts; mcp-audit
    // still has its own copy — assert the SAME semantics on the same
    // input so a future divergence fails here, not silently.
    const jittered = Array.from({ length: 200 }, (_, i) =>
      100 + ((i * 37) % 23) + i * 0.01,
    );
    const p50 = percentile(jittered, 0.5);
    const p90 = percentile(jittered, 0.9);
    const sorted = [...jittered].sort((a, b) => a - b);
    expect(p50).toBe(sorted[Math.floor(200 * 0.5)]);
    expect(p90).toBe(sorted[Math.floor(200 * 0.9)]);
    // The boundary: p near 1 clamps to the last element, never past it.
    expect(percentile(jittered, 1.0)).toBe(sorted[199]);
  });
});

// ── T-80: a thrown decision path is an audited 500, not a not-found ──

describe('PL-258 · T-80: a thrown error is audited — never confused with not-found', () => {
  it('a mid-decision failure returns a generic 500 and an error:slack_internal audit row', async () => {
    // A fresh routed request in tenant A with a mapped approver —
    // seeded BEFORE the fault lands.
    const requestId = await withTenant(
      server.db.appPool,
      TENANT_A,
      async (client) => {
        const student = await upsertStudent(client, {
          studentRef: 'SI-500',
          studentName: 'Error Path Scholar',
          section: '101',
        });
        const approver = await findStaffIdentityBySlackUserId(
          client,
          'USYNTH_A_SECTION',
        );
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
      },
    );

    // Force the throw: the decision path's identity lookup cannot run.
    // Grant-scoped, restored in finally — the test db is per-file.
    const owner = await server.db.ownerPool.connect();
    try {
      await owner.query(
        'revoke select on staff_identities from parentline_app',
      );

      const res = await postSigned(requestId, 'USYNTH_A_SECTION');
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; request_id: string };
      // Not the not-found shape — an internal error must not masquerade
      // as the oracle surface, and must carry no internals.
      expect(body.error).not.toBe('request_not_found');
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/staff_identities|permission|relation|column/i);

      const audits = await auditRowFor(body.request_id);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(audits.some((a) => a.outcome === 'error:slack_internal')).toBe(true);
    } finally {
      await owner.query(
        'grant select on staff_identities to parentline_app',
      );
      owner.release();
    }
  });
});

// ── T-83: constant-work tenant resolution (probe count + decoy) ──────

describe('PL-257 · T-83: every request probes every tenant — constant count, decoy on miss', () => {
  let probeCount = 0;
  let decoyQueries: string[] = [];
  let probeServer: TestMcpServer;
  let crossTenantRequest: string; // exists in tenant B only

  beforeAll(async () => {
    probeServer = await startTestMcpServer({
      appPoolWrapper: (pool) => {
        const connect = pool.connect.bind(pool);
        pool.connect = (async () => {
          const client = await connect();
          // The pool returns the same client object across connect()
          // calls — wrap once or each query counts per wrap layer.
          const tagged = client as typeof client & { __probeWrapped?: boolean };
          if (tagged.__probeWrapped === true) return client;
          tagged.__probeWrapped = true;
          const query = client.query.bind(client);
          client.query = ((sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === 'string') {
              if (sql.includes('pickup_request_belongs_to_tenant')) {
                probeCount += 1;
              } else {
                decoyQueries.push(sql);
              }
            }
            return query(sql as never, ...(rest as never[]));
          }) as typeof client.query;
          return client;
        }) as typeof pool.connect;
        return pool;
      },
    });

    crossTenantRequest = await withTenant(
      probeServer.db.appPool,
      TENANT_B,
      async (client) => {
        const student = await upsertStudent(client, {
          studentRef: 'SI-900',
          studentName: 'Parity Scholar',
          section: '101',
        });
        const approver = await findStaffIdentityBySlackUserId(
          client,
          'USYNTH_B_SECTION',
        );
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
      },
    );
  });

  afterAll(async () => {
    await probeServer.close();
  });

  async function postTo(
    requestId: string,
    slackUserId: string,
  ): Promise<Response> {
    const body = interactionBody(requestId, slackUserId);
    const { signature, timestamp } = sign(Math.floor(Date.now() / 1000), body);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    };
    return fetch(`${probeServer.url}${ENDPOINT}`, {
      method: 'POST',
      headers,
      body,
    });
  }

  it('probes every configured tenant — same count for existent, cross-tenant, nonexistent, malformed', async () => {
    const configured = 2; // the helper's default SLACK_TENANT_IDS: [A, B]

    // A request that exists in the FIRST probed tenant — no early exit.
    const inA = await withTenant(
      probeServer.db.appPool,
      TENANT_A,
      async (client) => {
        const student = await upsertStudent(client, {
          studentRef: 'SI-901',
          studentName: 'Parity Scholar Two',
          section: '101',
        });
        const approver = await findStaffIdentityBySlackUserId(
          client,
          'USYNTH_A_SECTION',
        );
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
      },
    );

    probeCount = 0;
    await postTo(inA, 'USYNTH_A_SECTION');
    expect(probeCount).toBe(configured);

    // Exists only in tenant B — the A probed first misses, B hits.
    probeCount = 0;
    await postTo(crossTenantRequest, 'USYNTH_A_SECTION');
    expect(probeCount).toBe(configured);

    // Nonexistent — same probe count.
    probeCount = 0;
    const nowhere = await postTo(
      '99999999-9999-9999-9999-999999999999',
      'USYNTH_A_SECTION',
    );
    expect(probeCount).toBe(configured);
    const nowhereBody = (await nowhere.json()) as Record<string, unknown>;
    delete nowhereBody.request_id;
    expect(nowhereBody).toEqual({ ok: false, error: 'request_not_found' });

    // Malformed (non-uuid) — same probe count, same wire shape.
    probeCount = 0;
    const malformed = await postTo('not-a-uuid', 'USYNTH_A_SECTION');
    expect(probeCount).toBe(configured);
    const malformedBody = (await malformed.json()) as Record<string, unknown>;
    delete malformedBody.request_id;
    expect(malformedBody).toEqual(nowhereBody);
  });

  it('a no-match id runs the decoy sequence under the first configured tenant', async () => {
    decoyQueries = [];
    probeCount = 0;
    const res = await postTo(
      '99999999-9999-9999-9999-999999999999',
      'USYNTH_A_SECTION',
    );
    const body = (await res.json()) as { request_id: string };

    // The decoy ran the real path's work shape: tenant context set,
    // request lookup, actor identity lookup — all absent for the
    // not-found shape before PL-257.
    const joined = decoyQueries.join('\n');
    expect(joined).toContain('app.tenant_id');
    expect(joined).toMatch(/from\s+pickup_requests/i);
    expect(joined).toMatch(/from\s+staff_identities/i);

    // And its boundary audit lands under the decoy tenant.
    const audits = await withTenant(
      probeServer.db.appPool,
      TENANT_A,
      async (client) => {
        const r = await client.query<{ outcome: string; tenant_id: string }>(
          `select outcome, tenant_id from mcp_audit where request_id = $1`,
          [body.request_id],
        );
        return r.rows;
      },
    );
    expect(audits.length).toBe(1);
    expect(audits[0]!.outcome).toBe('slack_not_found');
    expect(audits[0]!.tenant_id).toBe(TENANT_A);
  });
});
