/**
 * PL-107 / PL-108 / PL-109 — the three tools (T-39, T-43, T-44).
 *
 * T-39: a `staff` token calling the admin-only `roster_sync_status`
 *       gets a typed authorization refusal — distinguishable from an
 *       empty result. An `admin` token gets the status.
 * T-43: every declared argument changes behavior: each filter alone
 *       narrows, filters compose, and pagination pages. Nothing is
 *       declared-and-ignored.
 * T-44: tool descriptions are pairwise disjoint (wrong-tool
 *       selection), and none of them leak campus names, student
 *       examples, or jargon.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
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

async function staffSession() {
  const token = await server.mintToken({
    sub: 'staff-a',
    tenantId: TENANT_A,
    role: 'staff',
  });
  return { token, session: await client.connect({ token }) };
}

async function adminSession() {
  const token = await server.mintToken({
    sub: 'admin-a',
    tenantId: TENANT_A,
    role: 'admin',
  });
  return { token, session: await client.connect({ token }) };
}

describe('PL-108 · T-43: every declared argument changes behavior', () => {
  it('section filter narrows the result set', async () => {
    const { token, session } = await staffSession();
    const all = await client.callTool(session, 'search_roster', { limit: 50 }, { token });
    const section101 = await client.callTool(
      session,
      'search_roster',
      { section: '101' },
      { token },
    );

    const allTotal = (
      all.body?.result as { structuredContent?: { total?: number } } | undefined
    )?.structuredContent?.total;
    const s101Total = (
      section101.body?.result as { structuredContent?: { total?: number } } | undefined
    )?.structuredContent?.total;

    expect(allTotal).toBe(6); // tenant A has 6 clean rows
    expect(s101Total).toBe(3); // rows in section 101: A001, A003, A007
    expect(s101Total!).toBeLessThan(allTotal!);
  });

  it('hold_type filter narrows the result set', async () => {
    const { token, session } = await staffSession();
    const res = await client.callTool(
      session,
      'search_roster',
      { hold_type: 'Detention' },
      { token },
    );
    const rows = (
      res.body?.result as
        | {
            structuredContent?: {
              scholars?: Array<{ hold_type?: string }>;
              total?: number;
            };
          }
        | undefined
    )?.structuredContent;
    expect(rows?.total).toBeGreaterThan(0);
    for (const row of rows?.scholars ?? []) {
      expect(row.hold_type).toBe('Detention');
    }
  });

  it('attendance_status filter narrows the result set', async () => {
    const { token, session } = await staffSession();
    const res = await client.callTool(
      session,
      'search_roster',
      { attendance_status: 'Tardy' },
      { token },
    );
    const rows = (
      res.body?.result as
        | {
            structuredContent?: {
              scholars?: Array<{ attendance_status?: string }>;
              total?: number;
            };
          }
        | undefined
    )?.structuredContent;
    expect(rows?.total).toBe(3); // A001, A004, A007
    for (const row of rows?.scholars ?? []) {
      expect(row.attendance_status).toBe('Tardy');
    }
  });

  it('filters compose', async () => {
    const { token, session } = await staffSession();
    const res = await client.callTool(
      session,
      'search_roster',
      { attendance_status: 'Tardy', section: '103' },
      { token },
    );
    const rows = (
      res.body?.result as { structuredContent?: { total?: number } } | undefined
    )?.structuredContent;
    expect(rows?.total).toBe(1); // only A004 is Tardy in 103
  });

  it('an empty result is a success, distinguishable from a failure', async () => {
    const { token, session } = await staffSession();
    const res = await client.callTool(
      session,
      'search_roster',
      { section: '999' },
      { token },
    );
    const result = res.body?.result as
      | {
          isError?: boolean;
          structuredContent?: { total?: number; scholars?: unknown[] };
        }
      | undefined;
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.total).toBe(0);
    expect(result?.structuredContent?.scholars).toEqual([]);
  });

  it('pagination pages without duplicating or dropping rows', async () => {
    const { token, session } = await staffSession();
    const page1 = await client.callTool(
      session,
      'search_roster',
      { limit: 4, offset: 0 },
      { token },
    );
    const page2 = await client.callTool(
      session,
      'search_roster',
      { limit: 4, offset: 4 },
      { token },
    );

    const p1 =
      (
        page1.body?.result as
          | { structuredContent?: { scholars?: Array<{ student_ref?: string }> } }
          | undefined
      )?.structuredContent?.scholars ?? [];
    const p2 =
      (
        page2.body?.result as
          | { structuredContent?: { scholars?: Array<{ student_ref?: string }> } }
          | undefined
      )?.structuredContent?.scholars ?? [];

    expect(p1).toHaveLength(4);
    expect(p2).toHaveLength(2); // 6 total
    const refs = [...p1, ...p2].map((r) => r.student_ref);
    expect(new Set(refs).size).toBe(6);
  });
});

describe('PL-109 · T-39: admin-only tool authorization', () => {
  it('staff token gets a typed authorization refusal, not an empty result', async () => {
    const { token, session } = await staffSession();
    const res = await client.callTool(session, 'roster_sync_status', {}, { token });

    expect(res.status).toBe(200);
    const result = res.body?.result as
      | { isError?: boolean; structuredContent?: { kind?: string; reason?: string } }
      | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.kind).toBe('refusal');
    expect(result?.structuredContent?.reason).toBe('insufficient_role');
    // The refusal text names the requirement — it does not look like a
    // successful empty answer.
    const text = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
    expect(text?.[0]?.text).toContain('administrative');
  });

  it('admin token gets the sync status with quarantine reasons', async () => {
    const { token, session } = await adminSession();
    const res = await client.callTool(session, 'roster_sync_status', {}, { token });

    const result = res.body?.result as
      | {
          isError?: boolean;
          structuredContent?: {
            kind?: string;
            last_outcome?: string;
            quarantined?: {
              total?: number;
              byReason?: Array<{ reason: string; count: number }>;
            };
          };
        }
      | undefined;
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.kind).toBe('success');
    // 2 dirty rows quarantined → the sync outcome is partial-success, not success.
    expect(result?.structuredContent?.last_outcome).toBe('partial-success');
    // Tenant A's sheet has 2 dirty rows quarantined.
    expect(result?.structuredContent?.quarantined?.total).toBe(2);
    expect(result?.structuredContent?.quarantined?.byReason?.length).toBeGreaterThan(0);
  });
});

describe('PL-107/108 · T-44: descriptions are disjoint and leak-free', () => {
  it('descriptions steer wrong-tool selection with explicit use/do-not-use clauses', async () => {
    const { token, session } = await staffSession();
    const listed = await client.listTools(session, { token });
    const tools =
      (
        listed.body?.result as
          { tools?: Array<{ name: string; description: string }> } | undefined
      )?.tools ?? [];

    const byName = new Map(tools.map((t) => [t.name, t.description]));
    const lookup = byName.get('lookup_scholar_status') ?? '';
    const search = byName.get('search_roster') ?? '';
    const sync = byName.get('roster_sync_status') ?? '';

    // Lookup vs search: the wrong-tool pair.
    expect(lookup).toMatch(/one specific scholar|one scholar/i);
    expect(lookup).toMatch(/do not use it to list/i);
    expect(search).toMatch(/group|whole roster|filtered/i);
    expect(search).toMatch(/do not use it to look up one specific scholar/i);

    // Sync is a diagnostic, clearly distinct from both.
    expect(sync).toMatch(/health|refreshed|current/i);
    expect(sync).toMatch(/administrative/i);
  });

  it('descriptions leak no campus names, student examples, or jargon', async () => {
    const { token, session } = await staffSession();
    const listed = await client.listTools(session, { token });
    const tools =
      (
        listed.body?.result as
          { tools?: Array<{ name: string; description: string }> } | undefined
      )?.tools ?? [];

    for (const tool of tools) {
      expect(tool.description).not.toContain('Campus');
      expect(tool.description).not.toContain('Alpha');
      expect(tool.description).not.toContain('Bravo');
      expect(tool.description).not.toContain('Jordan');
      expect(tool.description).not.toContain('A001');
      expect(tool.description).not.toContain(TENANT_A);
      expect(tool.description).not.toContain(TENANT_B);
      expect(tool.description).not.toMatch(/roster_entries|RLS|tenant_id|sync_id/i);
    }
  });
});
