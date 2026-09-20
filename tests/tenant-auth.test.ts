/**
 * PL-105 — token-derived tenant and role through the tool layer
 * (T-33…T-35, T-47).
 *
 * T-33: tenant A's token sees exactly tenant A's data through the
 *       MCP tool (E2E — token → identity → RLS → response).
 * T-34: tool arguments attempting to set `tenant_id` are ignored; the
 *       token's tenant governs. The response carries A's data, not an
 *       error naming tenant B.
 * T-35: cross-tenant probes — a ref and a name existing only in
 *       tenant B, queried under A's token, return not-found with the
 *       same shape as any not-found; existence is not confirmed.
 * T-47: session replay — A's session under A's token works; under a
 *       bad token is rejected; under B's token resolves to B's data.
 *       An unknown session id is a typed rejection, never a silent
 *       fresh session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient, refusalReason } from './helpers/mcp-client.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  server = await startTestMcpServer();
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

describe('PL-105 · token-derived tenant', () => {
  it('T-33: tenant A token resolves tenant A data through the full stack', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });
    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );

    expect(res.status).toBe(200);
    const result = res.body?.result as
      | {
          isError?: boolean;
          structuredContent?: {
            kind?: string;
            scholar?: { student_ref?: string; student_name?: string; hold_type?: string };
          };
        }
      | undefined;
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.kind).toBe('success');
    expect(result?.structuredContent?.scholar?.student_ref).toBe('A001');
    // A001 is tenant A's Jordan Smith — the Tardy row with a derived hold.
    expect(result?.structuredContent?.scholar?.hold_type).toBe('Detention');
  });

  it('T-34: a forged tenant_id argument is ignored — the token governs', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // Ask for a tenant-B-only student while smuggling a tenant argument.
    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'B004',
        tenant_id: TENANT_B,
      },
      { token },
    );

    expect(res.status).toBe(200);
    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: { kind?: string; reason?: string } }
      | undefined;
    // The forged argument is ignored — the ref is not found in tenant A,
    // and the response never mentions tenant B.
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.reason).toBe('student_not_found');
    expect(res.rawText).not.toContain(TENANT_B);
  });

  it('T-35: cross-tenant probe by ref returns not-found, confirming nothing', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // B004 exists only in tenant B.
    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'B004',
      },
      { token },
    );

    expect(res.status).toBe(200);
    expect(refusalReason(res.body)).toBe('student_not_found');
    // "no" is the same answer for "exists elsewhere" and "does not exist".
    expect(res.rawText).not.toContain('Priya');
  });

  it('T-35: cross-tenant probe by name returns not-found, confirming nothing', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // "Kevin Wright" exists only in tenant B; "Maria Gonzalez" exists in
    // both — A's own row must come back, never B's.
    const bOnly = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_name: 'Kevin Wright',
      },
      { token },
    );
    expect(refusalReason(bOnly.body)).toBe('student_not_found');
    expect(bOnly.rawText).not.toContain('Kevin');

    const both = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_name: 'Maria Gonzalez',
      },
      { token },
    );
    const result = both.body?.result as
      | { isError?: boolean; structuredContent?: { scholar?: { student_ref?: string } } }
      | undefined;
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.scholar?.student_ref).toBe('A003');
  });
});

describe('PL-105 · T-47: session replay', () => {
  it("A's session with A's token keeps answering A's data", async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });
    for (let i = 0; i < 3; i += 1) {
      const res = await client.callTool(
        session,
        'lookup_scholar_status',
        {
          student_ref: 'A001',
        },
        { token },
      );
      const result = res.body?.result as { isError?: boolean } | undefined;
      expect(result?.isError).toBeFalsy();
    }
  });

  it("A's session with an invalid token is rejected (401) — auth runs per request", async () => {
    const good = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const bad = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      foreignKey: true,
    });
    const session = await client.connect({ token: good });

    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token: bad },
    );
    expect(res.status).toBe(401);
  });

  it("A's session with B's token resolves to B's data — identity is per-request, never session-cached", async () => {
    const tokenA = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const tokenB = await server.mintToken({
      sub: 'staff-b',
      tenantId: TENANT_B,
      role: 'staff',
    });
    const session = await client.connect({ token: tokenA });

    // Same session, tenant B's token: must see B's data.
    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'B004',
      },
      { token: tokenB },
    );

    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: { scholar?: { student_ref?: string } } }
      | undefined;
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.scholar?.student_ref).toBe('B004');
  });

  it('an unknown session id is a typed rejection — never a silent fresh session', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const res = await client.callTool(
      { sessionId: '00000000-0000-0000-0000-000000000000' },
      'lookup_scholar_status',
      { student_ref: 'A001' },
      { token },
    );
    expect(res.status).toBe(404);
    expect(res.body?.error).toBeDefined();
    expect(res.body?.error?.code).toBe(-32001);
  });
});
