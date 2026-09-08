import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  findByStudentName,
  findByStudentRef,
} from '../src/repositories/roster-entries.js';
import {
  findByStudentRef as findAuditByStudentRef,
  insertAuditEntry,
} from '../src/repositories/audit-log.js';

/**
 * Repository layer tests.
 *
 * Verifies that the repository methods work correctly within a tenant
 * context established by the real `withTenant` from src/db/tenant-context.ts,
 * and that RLS enforces isolation at the database level.
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

    const syncA = await owner.query(
      `insert into roster_syncs (tenant_id, started_at, finished_at, rows_in, rows_valid, outcome)
       values ($1, now(), now(), 2, 2, 'success') returning id`,
      [TENANT_A],
    );
    const syncB = await owner.query(
      `insert into roster_syncs (tenant_id, started_at, finished_at, rows_in, rows_valid, outcome)
       values ($1, now(), now(), 2, 2, 'success') returning id`,
      [TENANT_B],
    );

    const syncAId = syncA.rows[0]!.id;
    const syncBId = syncB.rows[0]!.id;

    await owner.query(
      `insert into roster_entries
         (tenant_id, student_ref, student_name, section, attendance_status, hold_source, source_row_number, sync_id)
       values
         ($1, 'A001', 'Daniel Reyes', '101', 'Tardy',   'derived',      1, $2),
         ($1, 'A002', 'Sarah Chen',   '101', 'Present', 'authoritative', 2, $2)`,
      [TENANT_A, syncAId],
    );

    await owner.query(
      `insert into roster_entries
         (tenant_id, student_ref, student_name, section, attendance_status, hold_source, source_row_number, sync_id)
       values
         ($1, 'B001', 'Daniel Reyes', '201', 'Absent',  'authoritative', 1, $2),
         ($1, 'B002', 'Maria Lopez',   '201', 'Excused', 'authoritative', 2, $2)`,
      [TENANT_B, syncBId],
    );
  } finally {
    owner.release();
  }
});

afterAll(async () => {
  await db.cleanup();
});

describe('Repository layer · roster-entries', () => {
  it('findByStudentRef returns the correct entry within tenant A', async () => {
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByStudentRef(client, 'A001');
    });
    expect(entry).not.toBeNull();
    expect(entry!.student_name).toBe('Daniel Reyes');
    expect(entry!.attendance_status).toBe('Tardy');
    expect(entry!.hold_source).toBe('derived');
  });

  it('findByStudentRef returns null for a student in the other tenant', async () => {
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByStudentRef(client, 'B001');
    });
    expect(entry).toBeNull();
  });

  it('findByStudentName returns the correct entry within tenant B', async () => {
    const entry = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByStudentName(client, 'Daniel Reyes');
    });
    expect(entry).not.toBeNull();
    expect(entry!.student_ref).toBe('B001');
    expect(entry!.attendance_status).toBe('Absent');
  });

  it('findByStudentName does not cross tenants for colliding names', async () => {
    const entryA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByStudentName(client, 'Daniel Reyes');
    });
    expect(entryA!.student_ref).toBe('A001');

    const entryB = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByStudentName(client, 'Daniel Reyes');
    });
    expect(entryB!.student_ref).toBe('B001');
  });
});

describe('Repository layer · audit-log', () => {
  it('insertAuditEntry writes an entry within the tenant context', async () => {
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return insertAuditEntry(client, {
        actor: 'staff@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'A001',
        fieldsDisclosed: ['attendance_status', 'hold_source'],
        outcome: 'success',
      });
    });

    expect(entry.actor).toBe('staff@example.com');
    expect(entry.action).toBe('getScholarStatus');
    expect(entry.subject_student_ref).toBe('A001');
    expect(entry.outcome).toBe('success');
    expect(entry.fields_disclosed).toEqual([
      'attendance_status',
      'hold_source',
    ]);
  });

  it('findByStudentRef returns audit entries only for the active tenant', async () => {
    // Insert an entry under tenant A
    await withTenant(db.appPool, TENANT_A, async (client) => {
      return insertAuditEntry(client, {
        actor: 'staff-a@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'A002',
        fieldsDisclosed: ['attendance_status'],
        outcome: 'success',
      });
    });

    // Insert an entry under tenant B
    await withTenant(db.appPool, TENANT_B, async (client) => {
      return insertAuditEntry(client, {
        actor: 'staff-b@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'A002',
        fieldsDisclosed: ['attendance_status'],
        outcome: 'success',
      });
    });

    // Under tenant A, should only see tenant A's entries
    const entriesA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findAuditByStudentRef(client, 'A002');
    });
    expect(entriesA.length).toBe(1);
    expect(entriesA[0]!.actor).toBe('staff-a@example.com');

    // Under tenant B, should only see tenant B's entries
    const entriesB = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findAuditByStudentRef(client, 'A002');
    });
    expect(entriesB.length).toBe(1);
    expect(entriesB[0]!.actor).toBe('staff-b@example.com');
  });
});

describe('Repository layer · withTenant context management', () => {
  it('withTenant resets tenant context before returning connection to pool', async () => {
    // Run a query under tenant A
    await withTenant(db.appPool, TENANT_A, async (client) => {
      const entry = await findByStudentRef(client, 'A001');
      expect(entry).not.toBeNull();
    });

    // Acquire a fresh connection — should not see tenant A's data
    const client = await db.appPool.connect();
    try {
      let errored = false;
      let rowCount = 0;
      try {
        const res = await client.query(`select * from roster_entries`);
        rowCount = res.rows.length;
      } catch {
        errored = true;
      }
      expect(errored || rowCount === 0).toBe(true);
    } finally {
      client.release();
    }
  });
});
