import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  findByTenant,
  insertMapping,
} from '../src/repositories/column-mappings.js';
import { mapRow } from '../src/mapping/mapper.js';
import { MappingError } from '../src/schema/canonical-row.js';

/**
 * PL-004 tests — canonical schema + column mapping.
 *
 * T-08: Different headers, identical canonical rows.
 * T-19 (mapping layer): Advisor-notes excluded from canonical row.
 * T-20 (mapping layer): do_not_call preserved through mapping.
 * Column-mapping repo CRUD + tenant isolation.
 *
 * Synthetic data only.
 */

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let db: TestDb;

beforeAll(async () => {
  db = await provisionTestDb();

  const owner = await db.ownerPool.connect();
  try {
    await owner.query(
      `insert into tenants (id, name) values ($1, 'Campus A'), ($2, 'Campus B')`,
      [TENANT_A, TENANT_B],
    );
  } finally {
    owner.release();
  }
});

afterAll(async () => {
  await db.cleanup();
});

// ── Column-mapping repository ─────────────────────────────────────

describe('Column-mapping repository', () => {
  it('inserts and retrieves mappings within tenant A', async () => {
    await withTenant(db.appPool, TENANT_A, async (client) => {
      await insertMapping(client, { sheetHeader: 'Scholar', canonicalField: 'student_name' });
      await insertMapping(client, { sheetHeader: 'Out Time', canonicalField: 'release_time' });
      await insertMapping(client, { sheetHeader: 'ID', canonicalField: 'student_ref' });
    });

    const mappings = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByTenant(client);
    });

    expect(mappings.length).toBe(3);
    const headers = mappings.map((m) => m.sheet_header).sort();
    expect(headers).toEqual(['ID', 'Out Time', 'Scholar']);
  });

  it('mappings inserted under tenant A are not visible to tenant B', async () => {
    const mappingsB = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByTenant(client);
    });
    expect(mappingsB.length).toBe(0);
  });

  it('tenant B can have its own independent mappings', async () => {
    await withTenant(db.appPool, TENANT_B, async (client) => {
      await insertMapping(client, { sheetHeader: 'Student Name', canonicalField: 'student_name' });
      await insertMapping(client, { sheetHeader: 'Release', canonicalField: 'release_time' });
      await insertMapping(client, { sheetHeader: 'Student ID', canonicalField: 'student_ref' });
    });

    const mappingsB = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByTenant(client);
    });

    expect(mappingsB.length).toBe(3);
    expect(mappingsB.map((m) => m.sheet_header).sort()).toEqual(
      ['Release', 'Student ID', 'Student Name'],
    );
  });
});

// ── T-08: Different headers, identical canonical rows ─────────────

describe('T-08 · Different headers, identical canonical rows', () => {
  it('produces byte-identical canonical rows from different sheet layouts', async () => {
    const mappingsA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByTenant(client);
    });
    const mappingsB = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByTenant(client);
    });

    // Campus A sheet headers
    const headersA = ['ID', 'Scholar', 'Out Time'];
    const valuesA = ['A001', 'Daniel Reyes', '15:30'];

    // Campus B sheet headers — different names, same logical fields
    const headersB = ['Student ID', 'Student Name', 'Release'];
    const valuesB = ['A001', 'Daniel Reyes', '15:30'];

    const rowA = mapRow(headersA, valuesA, mappingsA, 1);
    const rowB = mapRow(headersB, valuesB, mappingsB, 1);

    expect(rowA).toEqual(rowB);
    expect(rowA.student_ref).toBe('A001');
    expect(rowA.student_name).toBe('Daniel Reyes');
    expect(rowA.release_time).toBe('15:30');
  });
});

// ── T-19: Advisor-notes excluded from canonical row ──────────────

describe('T-19 · Advisor-notes column never enters a canonical row', () => {
  it('excludes unmapped columns — notes value absent from every field', async () => {
    // Campus A with an "Advisor Notes" column that has NO mapping
    const mappingsA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByTenant(client);
    });

    const headers = ['ID', 'Scholar', 'Out Time', 'Advisor Notes'];
    const values = ['A001', 'Daniel Reyes', '15:30', 'SENSITIVE_MEDICAL_DETAIL'];

    const row = mapRow(headers, values, mappingsA, 1);

    // The notes value must not appear in any canonical field
    const allValues = Object.values(row);
    for (const v of allValues) {
      expect(v).not.toBe('SENSITIVE_MEDICAL_DETAIL');
    }
  });
});

// ── T-20: do_not_call survives ingestion intact ───────────────────

describe('T-20 · do_not_call survives mapping intact', () => {
  it('coerces "TRUE" to true', async () => {
    await withTenant(db.appPool, TENANT_A, async (client) => {
      await insertMapping(client, { sheetHeader: 'DO NOT CALL', canonicalField: 'do_not_call' });
      await insertMapping(client, { sheetHeader: 'Missing ID', canonicalField: 'missing_id' });
    });
    const mappingsA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByTenant(client);
    });

    const headers = ['ID', 'Scholar', 'DO NOT CALL', 'Missing ID'];
    const values = ['A001', 'Daniel Reyes', 'TRUE', 'FALSE'];
    const row = mapRow(headers, values, mappingsA, 1);

    expect(row.do_not_call).toBe(true);
    expect(row.missing_id).toBe(false);
  });

  it('coerces "FALSE" and empty string to false', async () => {
    const mappingsA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByTenant(client);
    });

    const headers = ['ID', 'Scholar', 'DO NOT CALL', 'Missing ID'];
    const valuesFalse = ['A002', 'Sarah Chen', 'FALSE', ''];
    const rowFalse = mapRow(headers, valuesFalse, mappingsA, 2);

    expect(rowFalse.do_not_call).toBe(false);
    expect(rowFalse.missing_id).toBe(false);
  });

  it('coerces empty string to false for do_not_call', async () => {
    const mappingsA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByTenant(client);
    });

    const headers = ['ID', 'Scholar', 'DO NOT CALL', 'Missing ID'];
    const values = ['A003', 'James Park', '', 'TRUE'];
    const row = mapRow(headers, values, mappingsA, 3);

    expect(row.do_not_call).toBe(false);
    expect(row.missing_id).toBe(true);
  });
});

// ── Mapper edge cases ─────────────────────────────────────────────

describe('Mapper edge cases', () => {
  it('throws MappingError on validation failure (blank student_ref)', () => {
    const mappings = [
      { id: 'x', tenant_id: 'x', sheet_header: 'ID', canonical_field: 'student_ref' },
      { id: 'y', tenant_id: 'x', sheet_header: 'Name', canonical_field: 'student_name' },
    ];

    expect(() => {
      mapRow(['ID', 'Name'], ['', 'Daniel'], mappings, 5);
    }).toThrow(MappingError);
  });

  it('throws MappingError on validation failure (blank student_name)', () => {
    const mappings = [
      { id: 'x', tenant_id: 'x', sheet_header: 'ID', canonical_field: 'student_ref' },
      { id: 'y', tenant_id: 'x', sheet_header: 'Name', canonical_field: 'student_name' },
    ];

    expect(() => {
      mapRow(['ID', 'Name'], ['A001', '   '], mappings, 7);
    }).toThrow(MappingError);
  });

  it('MappingError carries the source row number', () => {
    const mappings = [
      { id: 'x', tenant_id: 'x', sheet_header: 'ID', canonical_field: 'student_ref' },
      { id: 'y', tenant_id: 'x', sheet_header: 'Name', canonical_field: 'student_name' },
    ];

    try {
      mapRow(['ID', 'Name'], ['', ''], mappings, 42);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MappingError);
      expect((err as MappingError).sourceRowNumber).toBe(42);
    }
  });

  it('defaults hold_source to authoritative', () => {
    const mappings = [
      { id: 'x', tenant_id: 'x', sheet_header: 'ID', canonical_field: 'student_ref' },
      { id: 'y', tenant_id: 'x', sheet_header: 'Name', canonical_field: 'student_name' },
    ];

    const row = mapRow(['ID', 'Name'], ['A001', 'Test Student'], mappings, 1);
    expect(row.hold_source).toBe('authoritative');
  });

  it('ignores unmapped columns silently', () => {
    const mappings = [
      { id: 'x', tenant_id: 'x', sheet_header: 'ID', canonical_field: 'student_ref' },
      { id: 'y', tenant_id: 'x', sheet_header: 'Name', canonical_field: 'student_name' },
    ];

    const headers = ['ID', 'Name', 'Unknown Col', 'Also Unknown'];
    const values = ['A001', 'Test', 'ignored1', 'ignored2'];
    const row = mapRow(headers, values, mappings, 1);

    expect(row.student_ref).toBe('A001');
    expect(row.student_name).toBe('Test');
  });
});
