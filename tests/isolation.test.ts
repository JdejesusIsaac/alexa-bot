import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';

/**
 * Isolation gate — T-01 through T-05.
 *
 * These tests run against a real Postgres with RLS enabled and forced.
 * A mocked query layer would pass every test while the real system leaks.
 *
 * T-05 runs first and aborts the suite on failure — every other isolation
 * result is meaningless if the app role can bypass RLS.
 *
 * Synthetic data only. No real student names, refs, or exports.
 */

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const RLS_TABLES = [
  'tenants',
  'students',
  'authorized_contacts',
  'roster_syncs',
  'roster_entries',
  'quarantined_rows',
  'audit_log',
  'column_mappings',
  'derivation_rules',
];

let db: TestDb;

beforeAll(async () => {
  db = await provisionTestDb();

  // Seed two tenants with colliding student names.
  // Owner pool is a superuser — bypasses RLS for seeding.
  const owner = await db.ownerPool.connect();
  try {
    // Tenants
    await owner.query(
      `insert into tenants (id, name) values ($1, 'Campus A'), ($2, 'Campus B')`,
      [TENANT_A, TENANT_B],
    );

    // Sync records (required FK for roster_entries)
    const syncA = await owner.query(
      `insert into roster_syncs (tenant_id, started_at, finished_at, rows_in, rows_valid, outcome)
       values ($1, now(), now(), 3, 3, 'success') returning id`,
      [TENANT_A],
    );
    const syncB = await owner.query(
      `insert into roster_syncs (tenant_id, started_at, finished_at, rows_in, rows_valid, outcome)
       values ($1, now(), now(), 3, 3, 'success') returning id`,
      [TENANT_B],
    );

    const syncAId = syncA.rows[0]!.id;
    const syncBId = syncB.rows[0]!.id;

    // Roster entries — deliberately colliding "Daniel Reyes" across tenants
    // with different statuses, so a cross-tenant leak is visible.
    await owner.query(
      `insert into roster_entries
         (tenant_id, student_ref, student_name, section, attendance_status, hold_source, source_row_number, sync_id)
       values
         ($1, 'A001', 'Daniel Reyes', '101', 'Tardy',   'derived',      1, $2),
         ($1, 'A002', 'Sarah Chen',   '101', 'Present', 'authoritative', 2, $2),
         ($1, 'A003', 'James Park',   '102', 'Absent',  'authoritative', 3, $2)`,
      [TENANT_A, syncAId],
    );

    await owner.query(
      `insert into roster_entries
         (tenant_id, student_ref, student_name, section, attendance_status, hold_source, source_row_number, sync_id)
       values
         ($1, 'B001', 'Daniel Reyes', '201', 'Absent',  'authoritative', 1, $2),
         ($1, 'B002', 'Maria Lopez',   '201', 'Excused', 'authoritative', 2, $2),
         ($1, 'B003', 'Kevin Wright',  '202', 'Present', 'authoritative', 3, $2)`,
      [TENANT_B, syncBId],
    );
  } finally {
    owner.release();
  }
});

afterAll(async () => {
  await db.cleanup();
});

// ── T-05: Application role cannot bypass RLS ─────────────────────────
// Runs first. Aborts the suite on failure — every other isolation test
// is meaningless if the app role can bypass RLS.

describe('T-05 · Application role cannot bypass RLS', () => {
  it('app pool connects as parentline_app, not a superuser', async () => {
    // Check the ACTUAL connected role, not just pg_roles by name.
    // If the app pool silently connects as the owner/superuser, every
    // other test is vacuous.
    const res = await db.appPool.query(`select current_user, session_user`);
    expect(res.rows[0]!.current_user).toBe('parentline_app');
    expect(res.rows[0]!.session_user).toBe('parentline_app');
  });

  it('connected role is not a superuser', async () => {
    const res = await db.appPool.query(
      `select rolsuper from pg_roles where rolname = current_user`,
    );
    expect(res.rows[0]!.rolsuper).toBe(false);
  });

  it('connected role does not have BYPASSRLS', async () => {
    const res = await db.appPool.query(
      `select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(res.rows[0]!.rolbypassrls).toBe(false);
  });

  it('connected role does not own the RLS tables', async () => {
    const roleRes = await db.appPool.query(
      `select oid from pg_roles where rolname = current_user`,
    );
    const appRoleOid = roleRes.rows[0]!.oid;

    for (const table of RLS_TABLES) {
      const res = await db.ownerPool.query(
        `select relowner from pg_class where relname = $1 and relkind = 'r'`,
        [table],
      );
      expect(res.rows.length, `table ${table} should exist`).toBe(1);
      expect(
        res.rows[0]!.relowner,
        `parentline_app must not own table ${table} — owners bypass RLS`,
      ).not.toBe(appRoleOid);
    }
  });

  it('has FORCE ROW LEVEL SECURITY on every student-data table', async () => {
    for (const table of RLS_TABLES) {
      const res = await db.ownerPool.query(
        `select relrowsecurity, relforcerowsecurity
         from pg_class where relname = $1 and relkind = 'r'`,
        [table],
      );
      expect(res.rows.length, `table ${table} should exist`).toBe(1);
      expect(
        res.rows[0]!.relrowsecurity,
        `${table} must have RLS enabled`,
      ).toBe(true);
      expect(
        res.rows[0]!.relforcerowsecurity,
        `${table} must have FORCE RLS — without it the owner bypasses policies silently`,
      ).toBe(true);
    }
  });
});

// ── T-01: RLS scopes reads to the active tenant ──────────────────────

describe('T-01 · RLS scopes reads to the active tenant', () => {
  it('returns only tenant A rows when app.tenant_id is set to A', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query(`select set_config('app.tenant_id', $1, false)`, [
        TENANT_A,
      ]);
      const res = await client.query(`select * from roster_entries`);
      expect(res.rows.length).toBe(3);
      for (const row of res.rows) {
        expect(row.tenant_id).toBe(TENANT_A);
      }
      await client.query(`select set_config('app.tenant_id', '', false)`);
    } finally {
      client.release();
    }
  });

  it('returns only tenant B rows when app.tenant_id is set to B', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query(`select set_config('app.tenant_id', $1, false)`, [
        TENANT_B,
      ]);
      const res = await client.query(`select * from roster_entries`);
      expect(res.rows.length).toBe(3);
      for (const row of res.rows) {
        expect(row.tenant_id).toBe(TENANT_B);
      }
      await client.query(`select set_config('app.tenant_id', '', false)`);
    } finally {
      client.release();
    }
  });
});

// ── T-02: Unset tenant context does not return everything ────────────

describe('T-02 · Unset tenant context does not return everything', () => {
  it('errors when app.tenant_id is not set (fails loudly, not silently)', async () => {
    const client = await db.appPool.connect();
    try {
      let errored = false;
      try {
        await client.query(`select * from roster_entries`);
      } catch {
        errored = true;
      }
      // The RLS policy uses current_setting('app.tenant_id')::uuid with no
      // missing_ok — an unset session variable must error, not silently
      // return zero rows. Silent filtering could mask a context bug.
      expect(errored).toBe(true);
    } finally {
      client.release();
    }
  });
});

// ── T-03: Name collision does not cross tenants ──────────────────────

describe('T-03 · Name collision does not cross tenants', () => {
  it('returns A\'s Daniel Reyes, not B\'s', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query(`select set_config('app.tenant_id', $1, false)`, [
        TENANT_A,
      ]);
      const res = await client.query(
        `select * from roster_entries where student_name = 'Daniel Reyes'`,
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0]!.student_ref).toBe('A001');
      expect(res.rows[0]!.attendance_status).toBe('Tardy');
      expect(res.rows[0]!.tenant_id).toBe(TENANT_A);
      await client.query(`select set_config('app.tenant_id', '', false)`);
    } finally {
      client.release();
    }
  });

  it('returns B\'s Daniel Reyes, not A\'s', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query(`select set_config('app.tenant_id', $1, false)`, [
        TENANT_B,
      ]);
      const res = await client.query(
        `select * from roster_entries where student_name = 'Daniel Reyes'`,
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0]!.student_ref).toBe('B001');
      expect(res.rows[0]!.attendance_status).toBe('Absent');
      expect(res.rows[0]!.tenant_id).toBe(TENANT_B);
      await client.query(`select set_config('app.tenant_id', '', false)`);
    } finally {
      client.release();
    }
  });
});

// ── T-04: Pool does not leak tenant context ──────────────────────────

describe('T-04 · Pool does not leak tenant context', () => {
  it('does not retain app.tenant_id after withTenant releases', async () => {
    // Run a query under tenant A via withTenant, which resets the setting
    // before releasing the connection back to the pool.
    await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query(`select * from roster_entries`);
      expect(res.rows.length).toBe(3);
    });

    // Acquire a fresh connection from the same pool and query without
    // setting a tenant. If app.tenant_id leaked, this would return A's rows.
    // With no tenant context set, the RLS policy must error (same as T-02).
    const client = await db.appPool.connect();
    try {
      let errored = false;
      try {
        await client.query(`select * from roster_entries`);
      } catch {
        errored = true;
      }
      expect(errored).toBe(true);
    } finally {
      client.release();
    }
  });
});
