/**
 * PL-106 — the disclosure policy chokepoint (T-36…T-38, T-45).
 *
 * T-36: default-deny — an unknown field never projects, even if it
 *       somehow appears on a row; ingestion metadata is never cleared.
 * T-37: the advisor-notes column and other sheet-only columns never
 *       appear in any tool response, success or refusal.
 * T-38: `hold_source` is present for staff and truthful — derived
 *       holds say derived, authoritative holds say authoritative.
 * T-45: responses carry exactly the tool's minimum field set — no
 *       roster, tenant, or internal context rides along, and refusals
 *       never carry student fields.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import {
  FIELD_CLEARANCE,
  TOOL_MINIMUM_FIELDS,
  project,
} from '../src/disclosure/policy.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  server = await startTestMcpServer();
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

describe('PL-106 · T-36: default-deny projection', () => {
  it('drops a field absent from the clearance map entirely', () => {
    const row = {
      student_ref: 'A001',
      student_name: 'Someone',
      gpa: '4.0', // unknown to the policy — must not survive
      advisor_notes: 'medical detail', // excluded at the connector; doubly denied
    };
    const projected = project(row, 'lookup_scholar_status', 'staff');
    expect(projected).not.toHaveProperty('gpa');
    expect(projected).not.toHaveProperty('advisor_notes');
  });

  it('denies ingestion and sync metadata even for admins', () => {
    const row = {
      student_ref: 'A001',
      missing_id: true,
      source_row_number: 3,
      sync_id: 'abc',
      tenant_id: TENANT_A,
      id: 'uuid',
    };
    // Only the cleared field survives; every metadata field is dropped.
    expect(project(row, 'lookup_scholar_status', 'admin')).toEqual({
      student_ref: 'A001',
    });
    expect(FIELD_CLEARANCE.missing_id).toBe('never');
    expect(FIELD_CLEARANCE.source_row_number).toBe('never');
    expect(FIELD_CLEARANCE.sync_id).toBe('never');
    expect(FIELD_CLEARANCE.tenant_id).toBe('never');
  });

  it('the minimum sets contain only cleared fields — no contradiction ships', () => {
    // Row-projecting tools only: roster_sync_status builds its response
    // from sync state, not from roster rows.
    for (const tool of ['lookup_scholar_status', 'search_roster'] as const) {
      for (const field of TOOL_MINIMUM_FIELDS[tool] ?? []) {
        expect(FIELD_CLEARANCE[field] ?? 'never').not.toBe('never');
      }
    }
  });
});

describe('PL-106 · T-37: excluded columns stay excluded (E2E)', () => {
  it('advisor-notes content never appears in a tool response', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // A001's row carries advisor notes ("Mom called re custody");
    // A003's carries ("Asthma flare, sent home").
    for (const ref of ['A001', 'A003']) {
      const res = await client.callTool(
        session,
        'lookup_scholar_status',
        {
          student_ref: ref,
        },
        { token },
      );
      expect(res.rawText).not.toContain('custody');
      expect(res.rawText).not.toContain('Asthma');
      expect(res.rawText).not.toContain('advisor');
      expect(res.rawText).not.toContain('Notes');
    }

    const search = await client.callTool(session, 'search_roster', {}, { token });
    expect(search.rawText).not.toContain('custody');
    expect(search.rawText).not.toContain('Asthma');
  });

  it('sheet-only columns (Advisor, Uniform, Absence Count) never appear', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });
    const res = await client.callTool(
      session,
      'search_roster',
      { section: '101' },
      { token },
    );

    const result = res.body?.result as
      { structuredContent?: { scholars?: Array<Record<string, unknown>> } } | undefined;
    const rows = result?.structuredContent?.scholars ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('advisor');
      expect(row).not.toHaveProperty('uniform');
      expect(row).not.toHaveProperty('absence_count');
      expect(row).not.toHaveProperty('reason_code');
    }
  });
});

describe('PL-106 · T-38: hold_source is present and truthful', () => {
  it('derived hold is labeled derived; authoritative hold is labeled authoritative', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // A001: Tardy → derived Detention. A008: authoritative Detention.
    const derived = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );
    const authoritative = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A008',
      },
      { token },
    );

    const d = derived.body?.result as
      { structuredContent?: { scholar?: { hold_source?: string } } } | undefined;
    const a = authoritative.body?.result as
      { structuredContent?: { scholar?: { hold_source?: string } } } | undefined;

    expect(d?.structuredContent?.scholar?.hold_source).toBe('derived');
    expect(a?.structuredContent?.scholar?.hold_source).toBe('authoritative');
  });
});

describe('PL-106 · T-45: minimum field sets, success and refusal', () => {
  it('a success response carries exactly the declared fields', async () => {
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
        student_ref: 'A008',
      },
      { token },
    );

    const scholar = (
      res.body?.result as
        { structuredContent?: { scholar?: Record<string, unknown> } } | undefined
    )?.structuredContent?.scholar;

    expect(scholar).toBeDefined();
    expect(Object.keys(scholar!).sort()).toEqual(
      [...(TOOL_MINIMUM_FIELDS.lookup_scholar_status ?? [])].sort(),
    );
    // No tenant, no roster context, no sync ids, no internal fields.
    expect(scholar).not.toHaveProperty('tenant_id');
    expect(scholar).not.toHaveProperty('sync_id');
    expect(scholar).not.toHaveProperty('id');
  });

  it('a search response carries exactly the declared fields per row', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });
    const res = await client.callTool(session, 'search_roster', { limit: 5 }, { token });

    const rows =
      (
        res.body?.result as
          | { structuredContent?: { scholars?: Array<Record<string, unknown>> } }
          | undefined
      )?.structuredContent?.scholars ?? [];

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [...(TOOL_MINIMUM_FIELDS.search_roster ?? [])].sort(),
      );
    }
  });

  it('a refusal response carries no student fields at all', async () => {
    const token = await server.mintToken({
      sub: 'staff-a',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });

    // Not-found refusal: no roster, no existence hint, no student data.
    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'Z999',
      },
      { token },
    );

    const result = res.body?.result as
      { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual({
      kind: 'refusal',
      reason: 'student_not_found',
    });
    expect(res.rawText).not.toContain('roster_entries');
    expect(res.rawText).not.toContain(TENANT_A);
  });
});
