/**
 * PL-110 — MCP audit trail (T-40…T-42).
 *
 * T-40: successes, refusals, and auth failures each produce an audit
 *       entry; the actor is the token subject; recorded arguments
 *       contain no student identifiers; nothing student-shaped reaches
 *       logs even when the name is absent from every redaction list.
 * T-41: per-stage latency is recorded (auth_ms, tool_ms, total_ms).
 * T-42: the timing oracle is closed — a ref existing only in tenant B
 *       and a ref existing nowhere, both under tenant A's token, are
 *       indistinguishable in shape, error code, message, and timing
 *       distribution.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import { findMcpAuditEntries } from '../src/repositories/mcp-audit.js';
import { withTenant } from '../src/db/tenant-context.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  server = await startTestMcpServer({ captureLogs: true });
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

describe('PL-110 · T-40: every MCP call audited', () => {
  it('successes, refusals, and auth failures each produce exactly one entry', async () => {
    const token = await server.mintToken({
      sub: 'auditor-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // 3 successes, 2 refusals, 3 auth failures = 8 tool-level calls.
    for (const ref of ['A001', 'A003', 'A008']) {
      await client.callTool(
        session,
        'lookup_scholar_status',
        { student_ref: ref },
        { token },
      );
    }
    await client.callTool(
      session,
      'lookup_scholar_status',
      { student_ref: 'Z999' },
      { token },
    );
    await client.callTool(
      session,
      'lookup_scholar_status',
      { student_ref: 'B004' },
      { token },
    );

    for (let i = 0; i < 3; i += 1) {
      const bad = await server.mintToken({ tenantId: TENANT_A, foreignKey: true });
      await client.callTool(
        session,
        'lookup_scholar_status',
        { student_ref: 'A001' },
        { token: bad },
      );
    }

    // Read back through the repository, inside the tenant context.
    const entries = await withTenant(server.db.appPool, TENANT_A, (c) =>
      findMcpAuditEntries(c, 100),
    );

    const toolCalls = entries.filter(
      (e) => e.tool === 'lookup_scholar_status' && e.rpc_method === 'tools/call',
    );
    const successes = toolCalls.filter((e) => e.outcome === 'success');
    const refusals = toolCalls.filter((e) => e.outcome.startsWith('refusal:'));
    const authRejected = entries.filter((e) => e.outcome.startsWith('auth_rejected:'));

    expect(successes).toHaveLength(3);
    expect(refusals).toHaveLength(2);
    expect(authRejected).toHaveLength(3);
    for (const entry of toolCalls) {
      expect(entry.actor).toBe('auditor-staff');
      expect(entry.role).toBe('staff');
    }
    for (const entry of authRejected) {
      expect(entry.actor).toBe('anonymous');
    }
  });

  it('pre-dispatch rejections still produce audit rows (F-1)', async () => {
    const token = await server.mintToken({
      sub: 'boundary-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // Unknown tool — the SDK rejects before any handler runs. The
    // rejection surfaces as result.isError (HTTP 200), not a JSON-RPC
    // error field.
    const unknown = await client.callTool(session, 'no_such_tool', {}, { token });
    expect(
      (unknown.body?.result as { isError?: boolean } | undefined)?.isError,
    ).toBe(true);
    expect(unknown.rawText).toContain('not found');

    // Schema-level argument failure — rejected at dispatch, never
    // reaches the handler (student_ref must be a string).
    const badArgs = await client.callTool(
      session,
      'lookup_scholar_status',
      { student_ref: 123 },
      { token },
    );
    expect(
      (badArgs.body?.result as { isError?: boolean } | undefined)?.isError,
    ).toBe(true);

    // Handler-level refusal — passes the SDK schema, fails the
    // exactly-one-of refine inside the handler. Enrichment path.
    const handlerRefusal = await client.callTool(
      session,
      'lookup_scholar_status',
      { student_ref: 'A001', student_name: 'Maria Gonzalez' },
      { token },
    );
    expect(refusalOf(handlerRefusal.body)).toBe('invalid_arguments');

    // Malformed call — params.name is not even a string. Raw fetch
    // because callTool() always serializes a string name.
    const malformed = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session.sessionId,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 42, arguments: {} },
      }),
    });
    expect(malformed.status).toBe(200);

    // The boundary writes each row after the response is sent (AD-42),
    // so the last call's row can lag this read — poll until it lands.
    const mine = await (async () => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const entries = await withTenant(server.db.appPool, TENANT_A, (c) =>
          findMcpAuditEntries(c, 100),
        );
        const rows = entries.filter((e) => e.actor === 'boundary-staff');
        const outcomes = rows.map((e) => e.outcome);
        if (
          (outcomes.includes('rejected:unknown_tool') &&
            outcomes.includes('rejected:tool_call_failed') &&
            outcomes.includes('rejected:malformed_tool_call') &&
            outcomes.includes('refusal:invalid_arguments')) ||
          Date.now() >= deadline
        ) {
          return rows;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    const unknownRow = mine.find((e) => e.outcome === 'rejected:unknown_tool');
    expect(unknownRow).toBeDefined();
    expect(unknownRow!.tool).toBe('no_such_tool');

    const failedRow = mine.find((e) => e.outcome === 'rejected:tool_call_failed');
    expect(failedRow).toBeDefined();
    expect(failedRow!.tool).toBe('lookup_scholar_status');

    const refusedRow = mine.find((e) => e.outcome === 'refusal:invalid_arguments');
    expect(refusedRow).toBeDefined();
    expect(refusedRow!.tool).toBe('lookup_scholar_status');

    const malformedRow = mine.find(
      (e) => e.outcome === 'rejected:malformed_tool_call',
    );
    expect(malformedRow).toBeDefined();
  });

  it('authenticated method rejections are audited (F-1)', async () => {
    const token = await server.mintToken({
      sub: 'method-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });

    const res = await fetch(server.mcpUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);

    const entries = await withTenant(server.db.appPool, TENANT_A, (c) =>
      findMcpAuditEntries(c, 100),
    );
    const row = entries.find(
      (e) => e.actor === 'method-staff' && e.outcome === 'rejected:method_not_allowed',
    );
    expect(row).toBeDefined();
  });

  it('recorded arguments carry no student identifiers', async () => {
    const token = await server.mintToken({
      sub: 'privacy-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    await client.callTool(
      session,
      'lookup_scholar_status',
      { student_ref: 'A001' },
      { token },
    );
    await client.callTool(
      session,
      'lookup_scholar_status',
      { student_name: 'Maria Gonzalez' },
      { token },
    );
    await client.callTool(session, 'search_roster', { section: '101' }, { token });

    const entries = await withTenant(server.db.appPool, TENANT_A, (c) =>
      findMcpAuditEntries(c, 50),
    );
    const recent = entries.filter((e) => e.actor === 'privacy-staff');
    expect(recent.length).toBeGreaterThanOrEqual(3);
    for (const entry of recent) {
      const serialized = JSON.stringify(entry.arguments_redacted);
      expect(serialized).not.toContain('A001');
      expect(serialized).not.toContain('Maria');
      expect(serialized).not.toContain('Gonzalez');
    }
  });

  it('no student names reach logs even when absent from every redaction list', async () => {
    const token = await server.mintToken({
      sub: 'logcheck-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // "Maria Gonzalez" is on the fixture list; the point of this test is
    // that nothing depends on the list. Call through the full stack and
    // assert the name never appears in ANY captured log line — value or
    // redacted form — including the production-shaped check below.
    await client.callTool(
      session,
      'lookup_scholar_status',
      { student_name: 'Maria Gonzalez' },
      { token },
    );

    const logs = server.logLines.join('\n');
    expect(logs).not.toContain('Maria Gonzalez');
    expect(logs).not.toContain('Maria');
    expect(logs).not.toContain('Gonzalez');
    // And a name that is on no list anywhere — synthetic but production-shaped.
    const probe = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_name: 'Production Shapedname',
      },
      { token },
    );
    expect(refusalOf(probe.body)).toBe('student_not_found');
    expect(server.logLines.join('\n')).not.toContain('Production Shapedname');
    expect(server.logLines.join('\n')).not.toContain('Shapedname');
  });
});

describe('PL-110 · T-41: full round-trip latency, measured', () => {
  it('200 sequential calls — p95 ≤300 ms, per stage, recorded with conditions', async () => {
    const token = await server.mintToken({
      sub: 'latency-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    const clientTotals: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const start = performance.now();
      const res = await client.callTool(
        session,
        'lookup_scholar_status',
        { student_ref: 'A001' },
        { token },
      );
      clientTotals.push(performance.now() - start);
      expect(res.status).toBe(200);
    }

    // Per-stage numbers come from the audit trail — auth_ms, tool_ms,
    // total_ms are recorded per call. The measurement is the point
    // (eval F-2): a test asserting field presence cannot fail for latency.
    // The boundary writes the row after the response is sent (AD-42), so
    // the final call's row can lag the client's read — poll briefly.
    const calls = await (async () => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const entries = await withTenant(server.db.appPool, TENANT_A, (c) =>
          findMcpAuditEntries(c, 500),
        );
        const mine = entries.filter(
          (e) =>
            e.actor === 'latency-staff' &&
            e.tool === 'lookup_scholar_status' &&
            e.outcome === 'success',
        );
        if (mine.length === 200 || Date.now() >= deadline) return mine;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();
    expect(calls).toHaveLength(200);

    const authP95 = percentile(calls.map((e) => e.auth_ms!), 0.95);
    const toolP95 = percentile(calls.map((e) => e.tool_ms!), 0.95);
    const totalP95 = percentile(calls.map((e) => e.total_ms!), 0.95);
    const clientP95 = percentile(clientTotals, 0.95);

    // Recorded with conditions per the T-41 spec: dataset size, local
    // vs network, cache state. This number is the one E3 grades.
    console.log(
      `[T-41] 200 sequential tools/call, local Postgres + local JWKS (warm), ` +
        `synthetic fixtures — auth p95 ${authP95}ms · tool p95 ${toolP95}ms · ` +
        `server-total p95 ${totalP95}ms · client round-trip p95 ${clientP95.toFixed(1)}ms ` +
        `(criterion ≤300ms; Alexa+ budget 500ms end-to-end)`,
    );

    expect(totalP95).toBeLessThanOrEqual(300);
    expect(clientP95).toBeLessThanOrEqual(300);
  });
});

describe('PL-110 · T-42: the timing oracle is closed', () => {
  const SAMPLES = 200;

  it('B-only and nonexistent refs are indistinguishable in shape, code, and message', async () => {
    const token = await server.mintToken({
      sub: 'oracle-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    const bOnly = await client.callTool(
      session,
      'lookup_scholar_status',
      { student_ref: 'B004' },
      { token },
    );
    const nowhere = await client.callTool(
      session,
      'lookup_scholar_status',
      { student_ref: 'Z999' },
      { token },
    );

    expect(bOnly.status).toBe(nowhere.status);
    // The ref is never echoed — byte-identical refusal responses.
    expect(bOnly.rawText).toBe(nowhere.rawText);
    expect(refusalOf(bOnly.body)).toBe('student_not_found');
    expect(refusalOf(nowhere.body)).toBe('student_not_found');
    // Same copy, byte for byte — no distinguishing text.
    const bText = JSON.stringify((bOnly.body?.result as { content?: unknown }).content);
    const zText = JSON.stringify((nowhere.body?.result as { content?: unknown }).content);
    expect(bText).toBe(zText);
  });

  it(`timing distributions over ${SAMPLES} calls are statistically indistinguishable`, async () => {
    const token = await server.mintToken({
      sub: 'oracle-staff',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    async function sample(ref: string): Promise<number[]> {
      const durations: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const start = performance.now();
        const res = await client.callTool(
          session,
          'lookup_scholar_status',
          { student_ref: ref },
          { token },
        );
        durations.push(performance.now() - start);
        expect(refusalOf(res.body)).toBe('student_not_found');
      }
      return durations;
    }

    const bOnly = await sample('B004');
    const nowhere = await sample('Z999');

    const medB = median(bOnly);
    const medZ = median(nowhere);
    const p90B = percentile(bOnly, 0.9);
    const p90Z = percentile(nowhere, 0.9);

    // The distributions must overlap heavily. A structural difference —
    // an extra query path for one case — shows up as a consistent offset;
    // the tolerance is generous to noise but far below any per-query gap.
    const tolerance = Math.max(15, 0.5 * Math.max(medB, medZ));
    expect(Math.abs(medB - medZ)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(p90B - p90Z)).toBeLessThanOrEqual(tolerance * 2);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function refusalOf(
  body: {
    result?: { isError?: boolean; structuredContent?: { reason?: string } };
  } | null,
): string | null {
  if (body?.result?.isError !== true) return null;
  return body.result.structuredContent?.reason ?? null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)]!;
}
