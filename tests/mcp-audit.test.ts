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

describe('PL-110 · T-41: per-stage latency recorded', () => {
  it('tool calls record auth_ms, tool_ms, and total_ms, all non-negative', async () => {
    const token = await server.mintToken({
      sub: 'timing-staff',
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

    const entries = await withTenant(server.db.appPool, TENANT_A, (c) =>
      findMcpAuditEntries(c, 20),
    );
    const entry = entries.find(
      (e) =>
        e.actor === 'timing-staff' &&
        e.tool === 'lookup_scholar_status' &&
        e.outcome === 'success',
    );
    expect(entry).toBeDefined();
    expect(entry!.auth_ms).not.toBeNull();
    expect(entry!.auth_ms!).toBeGreaterThanOrEqual(0);
    expect(entry!.tool_ms).not.toBeNull();
    expect(entry!.tool_ms!).toBeGreaterThanOrEqual(0);
    expect(entry!.total_ms).not.toBeNull();
    expect(entry!.total_ms!).toBeGreaterThanOrEqual(0);
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
