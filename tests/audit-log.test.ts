import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { insertAuditEntry, findByStudentRef } from '../src/repositories/audit-log.js';

/**
 * PL-008 tests — append-only audit log.
 *
 * T-10: Audit log is append-only at the database. Attempt `update` and
 * `delete` on `audit_log` as the application role (parentline_app).
 * Pass: both rejected by Postgres. Fail: rejected only by application code.
 *
 * The DB grants (PL-002) give parentline_app SELECT + INSERT only on
 * audit_log. UPDATE and DELETE are explicitly revoked. This test proves
 * the enforcement is at the database level, not a convention.
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

// ── T-10: Audit log is append-only at the database ─────────────────

describe('T-10 · Audit log is append-only at the database', () => {
  it('rejects UPDATE on audit_log as the application role', async () => {
    // First insert an entry so we have something to try to update
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return insertAuditEntry(client, {
        actor: 'staff@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'A001',
        fieldsDisclosed: ['attendance_status'],
        outcome: 'success',
      });
    });

    // Attempt UPDATE as the app role — must fail at the DB level
    await expect(
      withTenant(db.appPool, TENANT_A, async (client) => {
        await client.query(
          `update audit_log set outcome = 'tampered' where id = $1`,
          [entry.id],
        );
      }),
    ).rejects.toThrow();
  });

  it('rejects DELETE on audit_log as the application role', async () => {
    // Insert an entry to try to delete
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return insertAuditEntry(client, {
        actor: 'staff@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'A002',
        fieldsDisclosed: ['hold_type'],
        outcome: 'success',
      });
    });

    // Attempt DELETE as the app role — must fail at the DB level
    await expect(
      withTenant(db.appPool, TENANT_A, async (client) => {
        await client.query(`delete from audit_log where id = $1`, [entry.id]);
      }),
    ).rejects.toThrow();
  });

  it('INSERT and SELECT still work on audit_log', async () => {
    // Insert should work
    const entry = await withTenant(db.appPool, TENANT_B, async (client) => {
      return insertAuditEntry(client, {
        actor: 'staff-b@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'B001',
        fieldsDisclosed: ['attendance_status', 'hold_source'],
        outcome: 'refusal:stale',
      });
    });

    expect(entry.actor).toBe('staff-b@example.com');
    expect(entry.outcome).toBe('refusal:stale');

    // SELECT should work
    const found = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByStudentRef(client, 'B001');
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.outcome).toBe('refusal:stale');
  });
});

// ── Audit entry integrity ──────────────────────────────────────────

describe('Audit entry integrity', () => {
  it('records all required fields on insert', async () => {
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return insertAuditEntry(client, {
        actor: 'admin@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'A003',
        fieldsDisclosed: ['attendance_status', 'hold_type', 'hold_source', 'release_time'],
        outcome: 'success',
      });
    });

    expect(entry.id).toBeDefined();
    expect(entry.tenant_id).toBe(TENANT_A);
    expect(entry.actor).toBe('admin@example.com');
    expect(entry.action).toBe('getScholarStatus');
    expect(entry.subject_student_ref).toBe('A003');
    expect(entry.fields_disclosed).toEqual([
      'attendance_status',
      'hold_type',
      'hold_source',
      'release_time',
    ]);
    expect(entry.outcome).toBe('success');
    expect(entry.created_at).toBeInstanceOf(Date);
  });

  it('audit entries are tenant-isolated', async () => {
    // Insert under tenant A
    await withTenant(db.appPool, TENANT_A, async (client) => {
      return insertAuditEntry(client, {
        actor: 'a@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'SHARED_REF',
        fieldsDisclosed: ['attendance_status'],
        outcome: 'success',
      });
    });

    // Insert under tenant B with same student ref
    await withTenant(db.appPool, TENANT_B, async (client) => {
      return insertAuditEntry(client, {
        actor: 'b@example.com',
        action: 'getScholarStatus',
        subjectStudentRef: 'SHARED_REF',
        fieldsDisclosed: ['attendance_status'],
        outcome: 'success',
      });
    });

    // Tenant A sees only A's entries
    const aEntries = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByStudentRef(client, 'SHARED_REF');
    });
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0]!.actor).toBe('a@example.com');

    // Tenant B sees only B's entries
    const bEntries = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByStudentRef(client, 'SHARED_REF');
    });
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0]!.actor).toBe('b@example.com');
  });

  it('supports null subject_student_ref for non-student-specific actions', async () => {
    const entry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return insertAuditEntry(client, {
        actor: 'system',
        action: 'sync',
        subjectStudentRef: null,
        fieldsDisclosed: [],
        outcome: 'success',
      });
    });

    expect(entry.subject_student_ref).toBeNull();
    expect(entry.fields_disclosed).toEqual([]);
  });
});
