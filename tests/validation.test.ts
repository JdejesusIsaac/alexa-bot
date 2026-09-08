import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { ingestSheet } from '../src/sync/ingest.js';
import { findByStudentRef } from '../src/repositories/roster-entries.js';
import { findBySync as findQuarantined } from '../src/repositories/quarantined-rows.js';
import { findLatestSync } from '../src/repositories/roster-syncs.js';
import type { ColumnMapping } from '../src/repositories/column-mappings.js';
import type { DerivationRule } from '../src/repositories/derivation-rules.js';
import {
  TENANT_A,
  TENANT_A_MAPPINGS,
  TENANT_A_DERIVATION_RULES,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-006 — Validation + quarantine (DB integration tests).
 *
 * T-06: Dirty rows quarantine, clean rows survive. Partial success is normal.
 * T-07: Quarantined rows are unreachable from lookup.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only — no real student names, refs, or exports.
 *
 * Unit tests for validateRow are in tests/validation-unit.test.ts (no DB needed).
 */

let db: TestDb;

beforeAll(async () => {
  db = await provisionTestDb();
});

afterAll(async () => {
  await db.cleanup();
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeMappings(): ColumnMapping[] {
  return TENANT_A_MAPPINGS.map((m, i) => ({
    id: `test-mapping-${i}`,
    tenant_id: TENANT_A,
    sheet_header: m.sheetHeader,
    canonical_field: m.canonicalField,
  }));
}

function makeDerivationRules(): DerivationRule[] {
  return TENANT_A_DERIVATION_RULES.map((r, i) => ({
    id: `test-rule-${i}`,
    tenant_id: TENANT_A,
    rule_name: r.ruleName,
    condition_column: r.conditionColumn,
    condition_value: r.conditionValue,
    derived_hold_type: r.derivedHoldType,
  }));
}

// ── T-06: Ingestion with dirty rows ───────────────────────────────────

describe('PL-006 · T-06: dirty rows quarantine, clean rows survive', () => {
  it('quarantines exactly the dirty rows and keeps the rest', async () => {
    // Build a sheet with 8 rows: 5 clean, 3 dirty
    // Row 5: malformed release_time
    // Row 6: blank student_name (Zod catches)
    // Row 7: unknown reason_code
    const headers = [
      'ID', 'Scholar Name', 'Homeroom', 'Attendance', 'Reason',
      'Hold Type', 'Time In', 'Hold Location', 'DO NOT CALL', 'Missing ID',
    ];

    const rows = [
      // Row 1 — clean
      ['T001', 'Alice Test', '101', 'Present', '', '', '', '', 'FALSE', 'FALSE'],
      // Row 2 — clean with hold
      ['T002', 'Bob Test', '102', 'Absent', 'Excused W/O Notes', 'Detention', '14:30', 'Room 5', 'FALSE', 'FALSE'],
      // Row 3 — clean, Tardy (will derive detention)
      ['T003', 'Carol Test', '101', 'Tardy', 'Unexcused', '', '', '', 'FALSE', 'FALSE'],
      // Row 4 — clean, do_not_call
      ['T004', 'Dave Test', '103', 'Present', '', '', '', '', 'TRUE', 'FALSE'],
      // Row 5 — dirty: malformed release_time
      ['T005', 'Eve Test', '101', 'Present', '', '', 'not-a-time', '', 'FALSE', 'FALSE'],
      // Row 6 — dirty: blank student_name (Zod min(1) catches)
      ['T006', '', '102', 'Present', '', '', '', '', 'FALSE', 'FALSE'],
      // Row 7 — dirty: unknown reason_code
      ['T007', 'Frank Test', '103', 'Absent', 'Alien Abduction', '', '', '', 'FALSE', 'FALSE'],
      // Row 8 — clean
      ['T008', 'Grace Test', '101', 'Present', '', '', '', '', 'FALSE', 'TRUE'],
    ];

    // Set up tenant and mappings in the DB
    const owner = await db.ownerPool.connect();
    try {
      await owner.query(`insert into tenants (id, name) values ($1, $2) on conflict do nothing`, [TENANT_A, 'Test Campus']);
    } finally {
      owner.release();
    }

    const mappings = makeMappings();
    const derivationRules = makeDerivationRules();

    // Insert column mappings and derivation rules
    await withTenant(db.appPool, TENANT_A, async (client) => {
      for (const m of mappings) {
        await client.query(
          `insert into column_mappings (tenant_id, sheet_header, canonical_field) values ($1, $2, $3) on conflict do nothing`,
          [TENANT_A, m.sheet_header, m.canonical_field],
        );
      }
      for (const r of derivationRules) {
        await client.query(
          `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type) values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [TENANT_A, r.rule_name, r.condition_column, r.condition_value, r.derived_hold_type],
        );
      }
    });

    // Run ingestion
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return ingestSheet(client, { headers, rows }, mappings, derivationRules);
    });

    // 5 valid, 3 quarantined, 8 total
    expect(result.rowsIn).toBe(8);
    expect(result.rowsValid).toBe(5);
    expect(result.rowsQuarantined).toBe(3);
    expect(result.outcome).toBe('partial-success');

    // Verify sync record
    expect(result.sync.rows_in).toBe(8);
    expect(result.sync.rows_valid).toBe(5);
    expect(result.sync.rows_quarantined).toBe(3);
    expect(result.sync.outcome).toBe('partial-success');
    expect(result.sync.finished_at).not.toBeNull();
  });

  it('quarantined rows have source row numbers and specific reasons', async () => {
    const latestSync = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findLatestSync(client);
    });
    expect(latestSync).not.toBeNull();

    const quarantined = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findQuarantined(client, latestSync!.id);
    });

    expect(quarantined).toHaveLength(3);

    // Row 5: malformed release_time
    const row5 = quarantined.find((q) => q.source_row_number === 5);
    expect(row5).toBeDefined();
    expect(row5!.reason).toContain('release_time');

    // Row 6: blank student_name (Zod catches)
    const row6 = quarantined.find((q) => q.source_row_number === 6);
    expect(row6).toBeDefined();
    expect(row6!.reason).toContain('student_name');

    // Row 7: unknown reason_code
    const row7 = quarantined.find((q) => q.source_row_number === 7);
    expect(row7).toBeDefined();
    expect(row7!.reason).toContain('reason_code');
  });

  it('clean rows are in roster_entries', async () => {
    const count = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ count: string }>(
        `select count(*)::text as count from roster_entries where student_ref like 'T%'`,
      );
      return parseInt(res.rows[0]!.count, 10);
    });
    expect(count).toBe(5);
  });

  it('all valid rows are reachable by student_ref', async () => {
    for (const ref of ['T001', 'T002', 'T003', 'T004', 'T008']) {
      const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
        return findByStudentRef(client, ref);
      });
      expect(entry).not.toBeNull();
    }
  });
});

// ── T-07: Quarantined rows unreachable from lookup ───────────────────

describe('PL-006 · T-07: quarantined rows unreachable from lookup', () => {
  it('a quarantined student_ref is not found in roster_entries', async () => {
    // T005 was quarantined (malformed release_time)
    // T006 was quarantined (blank student_name)
    // T007 was quarantined (unknown reason_code)
    for (const ref of ['T005', 'T006', 'T007']) {
      const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
        return findByStudentRef(client, ref);
      });
      expect(entry).toBeNull();
    }
  });

  it('quarantined rows exist in quarantined_rows, not roster_entries', async () => {
    // Verify T007 is in quarantined_rows
    const latestSync = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findLatestSync(client);
    });

    const quarantined = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findQuarantined(client, latestSync!.id);
    });

    const t007Quarantined = quarantined.find((q) => q.source_row_number === 7);
    expect(t007Quarantined).toBeDefined();

    // But T007 is NOT in roster_entries
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByStudentRef(client, 'T007');
    });
    expect(entry).toBeNull();
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('PL-006 · edge cases', () => {
  it('a sheet with all valid rows produces outcome = success', async () => {
    const headers = [
      'ID', 'Scholar Name', 'Homeroom', 'Attendance', 'Reason',
      'Hold Type', 'Time In', 'Hold Location', 'DO NOT CALL', 'Missing ID',
    ];

    const rows = [
      ['E001', 'Edge One', '101', 'Present', '', '', '', '', 'FALSE', 'FALSE'],
      ['E002', 'Edge Two', '102', 'Tardy', 'Unexcused', '', '', '', 'FALSE', 'FALSE'],
    ];

    const mappings = makeMappings();
    const derivationRules = makeDerivationRules();

    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return ingestSheet(client, { headers, rows }, mappings, derivationRules);
    });

    expect(result.rowsValid).toBe(2);
    expect(result.rowsQuarantined).toBe(0);
    expect(result.outcome).toBe('success');
  });

  it('an empty sheet produces zero counts and outcome = success', async () => {
    const headers = [
      'ID', 'Scholar Name', 'Homeroom', 'Attendance', 'Reason',
      'Hold Type', 'Time In', 'Hold Location', 'DO NOT CALL', 'Missing ID',
    ];

    const mappings = makeMappings();
    const derivationRules = makeDerivationRules();

    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return ingestSheet(client, { headers, rows: [] }, mappings, derivationRules);
    });

    expect(result.rowsIn).toBe(0);
    expect(result.rowsValid).toBe(0);
    expect(result.rowsQuarantined).toBe(0);
    expect(result.outcome).toBe('success');
  });
});
