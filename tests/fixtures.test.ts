import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { seed } from '../src/db/seed.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_NAME,
  TENANT_B_NAME,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-011 — Synthetic fixtures test.
 *
 * Verifies that `seed()` produces a reproducible two-tenant dataset with:
 * - Two tenants with different sheet headers
 * - Deliberately colliding student names across tenants
 * - Dirty rows quarantined (for PL-006)
 * - Advisor-notes column never present in roster_entries (T-19)
 * - do_not_call preserved (T-20)
 * - Rows exercising hold and refusal cases
 *
 * Synthetic data only. No real student names, refs, or exports.
 */

let db: TestDb;

beforeAll(async () => {
  db = await provisionTestDb();
});

afterAll(async () => {
  await db.cleanup();
});

describe('PL-011 · seed() produces a reproducible two-tenant dataset', () => {
  it('seeds without error', async () => {
    // Point seed() at the test database by overriding DATABASE_URL
  process.env.DATABASE_URL = db.ownerUrl;
  process.env.APP_DATABASE_URL = db.appUrl;
    const results = await seed();
    expect(results).toHaveLength(2);
    expect(results[0]!.tenantName).toBe(TENANT_A_NAME);
    expect(results[1]!.tenantName).toBe(TENANT_B_NAME);
  });

  it('creates exactly two tenants', async () => {
    const owner = await db.ownerPool.connect();
    try {
      const res = await owner.query('select id, name from tenants order by name');
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0]!.name).toBe(TENANT_A_NAME);
      expect(res.rows[1]!.name).toBe(TENANT_B_NAME);
    } finally {
      owner.release();
    }
  });

  it('seeds column mappings per tenant with different headers', async () => {
    const aMappings = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query('select sheet_header, canonical_field from column_mappings order by sheet_header');
      return res.rows;
    });

    const bMappings = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query('select sheet_header, canonical_field from column_mappings order by sheet_header');
      return res.rows;
    });

    // Both tenants have 10 mappings
    expect(aMappings).toHaveLength(10);
    expect(bMappings).toHaveLength(10);

    // Headers differ between tenants (T-08)
    const aHeaders = new Set(aMappings.map((r: { sheet_header: string }) => r.sheet_header));
    const bHeaders = new Set(bMappings.map((r: { sheet_header: string }) => r.sheet_header));
    const shared = [...aHeaders].filter((h) => bHeaders.has(h));
    expect(shared).toHaveLength(0);

    // Same canonical fields mapped
    const aFields = new Set(aMappings.map((r: { canonical_field: string }) => r.canonical_field));
    const bFields = new Set(bMappings.map((r: { canonical_field: string }) => r.canonical_field));
    expect(aFields).toEqual(bFields);
  });

  it('has deliberately colliding student names across tenants', async () => {
    // Jordan Smith exists in both tenants
    const aJordan = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(
        `select student_ref, student_name, attendance_status from roster_entries where student_name = 'Jordan Smith' order by student_ref`,
      );
      return res.rows;
    });

    const bJordan = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query(
        `select student_ref, student_name, attendance_status from roster_entries where student_name = 'Jordan Smith' order by student_ref`,
      );
      return res.rows;
    });

    // Two Jordan Smiths in tenant A (rows 1 and 2)
    expect(aJordan).toHaveLength(2);
    expect(aJordan[0]!.student_ref).toBe('A001');
    expect(aJordan[0]!.attendance_status).toBe('Tardy');
    expect(aJordan[1]!.student_ref).toBe('A002');

    // One Jordan Smith in tenant B
    expect(bJordan).toHaveLength(1);
    expect(bJordan[0]!.student_ref).toBe('B001');
    expect(bJordan[0]!.attendance_status).toBe('Absent');

    // Maria Gonzalez also collides across tenants
    const aMaria = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(
        `select student_ref from roster_entries where student_name = 'Maria Gonzalez'`,
      );
      return res.rows;
    });
    const bMaria = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query(
        `select student_ref from roster_entries where student_name = 'Maria Gonzalez'`,
      );
      return res.rows;
    });
    expect(aMaria).toHaveLength(1);
    expect(aMaria[0]!.student_ref).toBe('A003');
    expect(bMaria).toHaveLength(1);
    expect(bMaria[0]!.student_ref).toBe('B002');
  });

  it('quarantines dirty rows with missing required fields', async () => {
    const aQuarantined = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query('select source_row_number, reason from quarantined_rows order by source_row_number');
      return res.rows;
    });

    const bQuarantined = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query('select source_row_number, reason from quarantined_rows order by source_row_number');
      return res.rows;
    });

    // Each tenant has 2 dirty rows (empty student_ref and empty student_name)
    expect(aQuarantined).toHaveLength(2);
    expect(bQuarantined).toHaveLength(2);
    expect(aQuarantined[0]!.source_row_number).toBe(5);
    expect(aQuarantined[1]!.source_row_number).toBe(6);
    expect(bQuarantined[0]!.source_row_number).toBe(5);
    expect(bQuarantined[1]!.source_row_number).toBe(6);
  });

  it('inserts 6 valid roster entries per tenant (8 rows - 2 quarantined)', async () => {
    const aCount = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query('select count(*)::int as count from roster_entries');
      return res.rows[0]!.count;
    });

    const bCount = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query('select count(*)::int as count from roster_entries');
      return res.rows[0]!.count;
    });

    expect(aCount).toBe(6);
    expect(bCount).toBe(6);
  });

  it('T-19: advisor-notes column never appears in roster_entries', async () => {
    // The roster_entries table has no notes/advisor_notes column.
    // Verify by checking column names, and verify no raw notes content
    // leaked into any field.
    const owner = await db.ownerPool.connect();
    try {
      const cols = await owner.query(`
        select column_name from information_schema.columns
        where table_name = 'roster_entries'
        order by column_name
      `);
      const colNames = cols.rows.map((r: { column_name: string }) => r.column_name);
      expect(colNames).not.toContain('notes');
      expect(colNames).not.toContain('advisor_notes');
    } finally {
      owner.release();
    }

    // Check that notes content from the fixture does not appear in any
    // text field of roster_entries.
    const notesSnippets = [
      'Mom called re custody',
      'Asthma flare',
      'Custody restriction',
      'Family trip',
      'court order',
      'Dental appointment',
    ];

    for (const snippet of notesSnippets) {
      const aHit = await withTenant(db.appPool, TENANT_A, async (client) => {
        const res = await client.query(
          `select count(*)::int as count from roster_entries
           where student_name ilike '%' || $1 || '%'
              or section ilike '%' || $1 || '%'
              or attendance_status ilike '%' || $1 || '%'
              or reason_code ilike '%' || $1 || '%'
              or hold_type ilike '%' || $1 || '%'
              or hold_location ilike '%' || $1 || '%'`,
          [snippet],
        );
        return res.rows[0]!.count;
      });
      expect(aHit).toBe(0);

      const bHit = await withTenant(db.appPool, TENANT_B, async (client) => {
        const res = await client.query(
          `select count(*)::int as count from roster_entries
           where student_name ilike '%' || $1 || '%'
              or section ilike '%' || $1 || '%'
              or attendance_status ilike '%' || $1 || '%'
              or reason_code ilike '%' || $1 || '%'
              or hold_type ilike '%' || $1 || '%'
              or hold_location ilike '%' || $1 || '%'`,
          [snippet],
        );
        return res.rows[0]!.count;
      });
      expect(bHit).toBe(0);
    }
  });

  it('T-20: do_not_call survives ingestion intact', async () => {
    // Tenant A: A004 has do_not_call = TRUE
    const aDnc = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(
        `select student_ref, do_not_call from roster_entries where student_ref = 'A004'`,
      );
      return res.rows[0];
    });
    expect(aDnc.do_not_call).toBe(true);

    // Tenant B: B003 has do_not_call = TRUE
    const bDnc = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query(
        `select student_ref, do_not_call from roster_entries where student_ref = 'B003'`,
      );
      return res.rows[0];
    });
    expect(bDnc.do_not_call).toBe(true);

    // Other rows should have do_not_call = false
    const aFalse = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(
        `select count(*)::int as count from roster_entries where do_not_call = false`,
      );
      return res.rows[0]!.count;
    });
    expect(aFalse).toBe(5); // 6 total - 1 true = 5 false
  });

  it('exercises hold cases (authoritative holds with release time and location)', async () => {
    // Tenant A: A003 has hold_type = null but hold_location = 'Front Office'
    // (from the sheet — Hold Location column maps, but Hold Type is empty)
    // Tenant A: A008 has hold_type = 'Detention', release_time = '14:30', hold_location = 'Room 5'
    const a008 = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(
        `select hold_type, release_time, hold_location from roster_entries where student_ref = 'A008'`,
      );
      return res.rows[0];
    });
    expect(a008.hold_type).toBe('Detention');
    expect(a008.release_time).toBe('14:30');
    expect(a008.hold_location).toBe('Room 5');

    // Tenant B: B004 has hold_type = 'Detention', release_time = '15:00', hold_location = 'Library'
    const b004 = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query(
        `select hold_type, release_time, hold_location from roster_entries where student_ref = 'B004'`,
      );
      return res.rows[0];
    });
    expect(b004.hold_type).toBe('Detention');
    expect(b004.release_time).toBe('15:00');
    expect(b004.hold_location).toBe('Library');
  });

  it('exercises missing_id = true rows', async () => {
    // Tenant A: A004 and A007 have missing_id = true
    const aMissing = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(
        `select student_ref from roster_entries where missing_id = true order by student_ref`,
      );
      return res.rows;
    });
    expect(aMissing).toHaveLength(2);
    expect(aMissing[0]!.student_ref).toBe('A004');
    expect(aMissing[1]!.student_ref).toBe('A007');

    // Tenant B: B007 has missing_id = true
    const bMissing = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query(
        `select student_ref from roster_entries where missing_id = true`,
      );
      return res.rows;
    });
    expect(bMissing).toHaveLength(1);
    expect(bMissing[0]!.student_ref).toBe('B007');
  });

  it('seeds derivation rules per tenant', async () => {
    const aRules = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query('select rule_name, condition_column, condition_value, derived_hold_type from derivation_rules order by rule_name');
      return res.rows;
    });

    const bRules = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query('select rule_name, condition_column, condition_value, derived_hold_type from derivation_rules order by rule_name');
      return res.rows;
    });

    expect(aRules).toHaveLength(2);
    expect(bRules).toHaveLength(2);

    expect(aRules[0]!.rule_name).toBe('missing-id-detention');
    expect(aRules[0]!.condition_column).toBe('missing_id');
    expect(aRules[0]!.condition_value).toBe('true');
    expect(aRules[0]!.derived_hold_type).toBe('Detention');

    expect(aRules[1]!.rule_name).toBe('tardy-detention');
    expect(aRules[1]!.condition_column).toBe('attendance_status');
    expect(aRules[1]!.condition_value).toBe('Tardy');
    expect(aRules[1]!.derived_hold_type).toBe('Detention');
  });

  it('is reproducible — seeding twice produces the same counts', async () => {
    // First seed already happened. Seed again and verify counts match.
    const results = await seed();

    expect(results).toHaveLength(2);
    expect(results[0]!.rowsValid).toBe(6);
    expect(results[0]!.rowsQuarantined).toBe(2);
    expect(results[0]!.rowsIn).toBe(8);
    expect(results[1]!.rowsValid).toBe(6);
    expect(results[1]!.rowsQuarantined).toBe(2);
    expect(results[1]!.rowsIn).toBe(8);

    // Verify counts in DB are still correct (not doubled)
    const aCount = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query('select count(*)::int as count from roster_entries');
      return res.rows[0]!.count;
    });
    expect(aCount).toBe(6);
  });
});
