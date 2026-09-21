import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { runSync, type SyncJob } from '../src/sync/scheduler.js';
import { FixtureSheetConnector } from '../src/connector/fixture-sheet-connector.js';
import {
  countEntries,
  findByStudentRef,
  searchRosterEntries,
} from '../src/repositories/roster-entries.js';
import { getScholarStatus } from '../src/services/scholar-status.js';
import { todayServiceDate } from '../src/util/service-date.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_MAPPINGS,
  TENANT_B_MAPPINGS,
  TENANT_A_DERIVATION_RULES,
  TENANT_B_DERIVATION_RULES,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-201 — roster grain: `service_date` + `student_id` linkage.
 *
 * T-50: Two service dates coexist. A sync writes a dated set — day 2's
 *       sync must not wipe day 1, a dated read must not return rows from
 *       both dates, and yesterday's rows are unreachable from a
 *       default-scoped (today) read.
 * T-51: Student linkage complete. A `student_ref` not yet in `students`
 *       is inserted at ingest — every roster row carries a non-null
 *       `student_id`, and a re-sync does not duplicate the student.
 * T-52 (GATE): A dated read is tenant-scoped across every date scope,
 *       including an explicit historical date and a colliding
 *       `student_ref`. Fail (critical): any cross-tenant row — the
 *       service_date grain adds rows previous reads never saw (leak
 *       vector 21).
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only — colliding refs and names across tenants are
 * deliberate.
 */

const DAY_1 = '2030-01-14'; // historical service date
const TODAY = todayServiceDate();

/** Valid fixture rows per tenant sheet: 8 rows, 2 dirty → 6 valid. */
const VALID_ROWS = 6;

let db: TestDb;
let day1SyncId: string;

beforeAll(async () => {
  db = await provisionTestDb();

  // Seed tenants, column mappings, and derivation rules for both tenants.
  const owner = await db.ownerPool.connect();
  try {
    await owner.query(
      `insert into tenants (id, name) values ($1, 'Campus Alpha'), ($2, 'Campus Bravo')`,
      [TENANT_A, TENANT_B],
    );

    for (const m of TENANT_A_MAPPINGS) {
      await owner.query(
        `insert into column_mappings (tenant_id, sheet_header, canonical_field) values ($1, $2, $3)`,
        [TENANT_A, m.sheetHeader, m.canonicalField],
      );
    }
    for (const m of TENANT_B_MAPPINGS) {
      await owner.query(
        `insert into column_mappings (tenant_id, sheet_header, canonical_field) values ($1, $2, $3)`,
        [TENANT_B, m.sheetHeader, m.canonicalField],
      );
    }
    for (const r of TENANT_A_DERIVATION_RULES) {
      await owner.query(
        `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type) values ($1, $2, $3, $4, $5)`,
        [TENANT_A, r.ruleName, r.conditionColumn, r.conditionValue, r.derivedHoldType],
      );
    }
    for (const r of TENANT_B_DERIVATION_RULES) {
      await owner.query(
        `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type) values ($1, $2, $3, $4, $5)`,
        [TENANT_B, r.ruleName, r.conditionColumn, r.conditionValue, r.derivedHoldType],
      );
    }
  } finally {
    owner.release();
  }
});

afterAll(async () => {
  await db.cleanup();
});

function jobFor(tenantId: string): SyncJob {
  return { tenantId, sheetId: tenantId, range: 'Sheet1!A1:Z1000' };
}

// ── T-50: Two service dates coexist ───────────────────────────────────

describe('PL-201 · T-50: two service dates coexist', () => {
  it("day 2's sync does not wipe day 1", async () => {
    const connector = new FixtureSheetConnector();

    // Day 1 — a historical service date
    const day1 = await runSync(db.appPool, connector, jobFor(TENANT_A), {
      serviceDate: DAY_1,
    });
    expect(day1.kind).toBe('success');

    // Day 2 — today
    const day2 = await runSync(db.appPool, connector, jobFor(TENANT_A));
    expect(day2.kind).toBe('success');

    // Both dates present in roster_entries — day 2 wiped nothing.
    const counts = await withTenant(db.appPool, TENANT_A, async (client) => {
      const day1Count = await countEntries(client, DAY_1);
      const todayCount = await countEntries(client, TODAY);
      return { day1Count, todayCount };
    });
    expect(counts.day1Count).toBe(VALID_ROWS);
    expect(counts.todayCount).toBe(VALID_ROWS);

    // Distinct dated sets: the same ref resolves to different syncs per date.
    const syncIds = await withTenant(db.appPool, TENANT_A, async (client) => {
      const day1Entry = await findByStudentRef(client, 'A001', DAY_1);
      const todayEntry = await findByStudentRef(client, 'A001', TODAY);
      return { day1: day1Entry?.sync_id, today: todayEntry?.sync_id };
    });
    expect(syncIds.day1).toBeDefined();
    expect(syncIds.today).toBeDefined();
    expect(syncIds.day1).not.toBe(syncIds.today);
    day1SyncId = syncIds.day1!;
  });

  it("a dated read returns only that date's rows, never both", async () => {
    const page = await withTenant(db.appPool, TENANT_A, async (client) => {
      return searchRosterEntries(client, {}, { limit: 50, offset: 0 }, TODAY);
    });
    // Today's read sees today's set only — 6, not 12. Returning rows
    // from both dates is the fail condition.
    expect(page.total).toBe(VALID_ROWS);
    for (const entry of page.entries) {
      expect(entry.service_date).toBe(TODAY);
    }
  });

  it("yesterday's rows are unchanged and unreachable from a default-scoped read", async () => {
    // A ref that exists on day 1 only — planted before day 2's sync ran,
    // attached to day 1's sync.
    const owner = await db.ownerPool.connect();
    try {
      await owner.query(
        `insert into roster_entries
           (tenant_id, service_date, student_ref, student_name, section, attendance_status, hold_source, source_row_number, sync_id)
         values ($1, $2, 'A-OLD-1', 'Prior Day Scholar', '999', 'Present', 'authoritative', 99, $3)`,
        [TENANT_A, DAY_1, day1SyncId],
      );
    } finally {
      owner.release();
    }

    // Unchanged: still readable under its explicit date, content intact.
    const day1Row = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByStudentRef(client, 'A-OLD-1', DAY_1);
    });
    expect(day1Row).not.toBeNull();
    expect(day1Row!.student_name).toBe('Prior Day Scholar');

    // Unreachable from a default-scoped read: the status lookup defaults
    // to today and must not find a day-1-only scholar. The roster is
    // fresh (synced moments ago), so this is a date failure, not freshness.
    const status = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A-OLD-1',
        caller: 'staff',
        actor: 'grain-test',
        freshnessMinutes: 45,
      });
    });
    expect(status).toEqual({ kind: 'refusal', reason: 'student_not_found' });
  });
});

// ── T-51: Student linkage complete ────────────────────────────────────

describe('PL-201 · T-51: student linkage complete', () => {
  it('inserts an absent student and gives every ingested row a student_id', async () => {
    // Tenant B has never been ingested in this database — its `students`
    // table is empty, so every sheet ref is absent (the T-51 setup).
    const connector = new FixtureSheetConnector();
    const result = await runSync(db.appPool, connector, jobFor(TENANT_B));
    expect(result.kind).toBe('success');

    const linkage = await withTenant(db.appPool, TENANT_B, async (client) => {
      const nullIds = await client.query<{ count: string }>(
        `select count(*)::text as count from roster_entries where student_id is null`,
      );
      const students = await client.query<{
        student_ref: string;
        student_name: string;
        section: string | null;
      }>(`select student_ref, student_name, section from students order by student_ref`);
      const b001 = await findByStudentRef(client, 'B001', TODAY);
      const b001Student = await client.query<{ id: string; student_name: string }>(
        `select id, student_name from students where student_ref = 'B001'`,
      );
      return {
        nullIdCount: parseInt(nullIds.rows[0]!.count, 10),
        students: students.rows,
        b001Entry: b001,
        b001Student: b001Student.rows[0] ?? null,
      };
    });

    // Every ingested row has a non-null student_id — none skipped.
    expect(linkage.nullIdCount).toBe(0);

    // The absent students were inserted — all six valid refs.
    expect(linkage.students).toHaveLength(VALID_ROWS);
    expect(linkage.students.map((s) => s.student_ref)).toEqual([
      'B001',
      'B002',
      'B003',
      'B004',
      'B007',
      'B008',
    ]);

    // The roster row points at the student row for the same ref.
    expect(linkage.b001Entry).not.toBeNull();
    expect(linkage.b001Student).not.toBeNull();
    expect(linkage.b001Entry!.student_id).toBe(linkage.b001Student!.id);
    expect(linkage.b001Student!.student_name).toBe('Jordan Smith');
  });

  it('a re-sync does not duplicate the student or the roster row', async () => {
    const connector = new FixtureSheetConnector();
    const result = await runSync(db.appPool, connector, jobFor(TENANT_B));
    expect(result.kind).toBe('success');

    const after = await withTenant(db.appPool, TENANT_B, async (client) => {
      const students = await client.query<{ count: string }>(
        `select count(*)::text as count from students`,
      );
      const entries = await countEntries(client, TODAY);
      return {
        studentCount: parseInt(students.rows[0]!.count, 10),
        entryCount: entries,
      };
    });

    expect(after.studentCount).toBe(VALID_ROWS);
    expect(after.entryCount).toBe(VALID_ROWS);
  });
});

// ── T-52 (GATE): Dated read is tenant-scoped ──────────────────────────

describe('PL-201 · T-52 (GATE): dated read is tenant-scoped', () => {
  // Both tenants have rosters for TODAY (A from T-50, B from T-51).
  // Plant a colliding student_ref on the same explicit historical date
  // in both tenants — identical ref, different content, so a
  // cross-tenant row is visible, not just countable.
  const COLLIDING_REF = 'X-999';
  const HISTORICAL = DAY_1;

  beforeAll(async () => {
    const owner = await db.ownerPool.connect();
    try {
      const syncA = await owner.query<{ id: string }>(
        `insert into roster_syncs (tenant_id, service_date, started_at, finished_at, rows_in, rows_valid, outcome)
         values ($1, $2, now(), now(), 1, 1, 'success') returning id`,
        [TENANT_A, HISTORICAL],
      );
      const syncB = await owner.query<{ id: string }>(
        `insert into roster_syncs (tenant_id, service_date, started_at, finished_at, rows_in, rows_valid, outcome)
         values ($1, $2, now(), now(), 1, 1, 'success') returning id`,
        [TENANT_B, HISTORICAL],
      );

      await owner.query(
        `insert into roster_entries
           (tenant_id, service_date, student_ref, student_name, section, attendance_status, hold_source, source_row_number, sync_id)
         values ($1, $2, $3, 'Kim Alpha', '301', 'Present', 'authoritative', 1, $4)`,
        [TENANT_A, HISTORICAL, COLLIDING_REF, syncA.rows[0]!.id],
      );
      await owner.query(
        `insert into roster_entries
           (tenant_id, service_date, student_ref, student_name, section, attendance_status, hold_source, source_row_number, sync_id)
         values ($1, $2, $3, 'Kim Bravo', '401', 'Present', 'authoritative', 1, $4)`,
        [TENANT_B, HISTORICAL, COLLIDING_REF, syncB.rows[0]!.id],
      );
    } finally {
      owner.release();
    }
  });

  it('a colliding ref on an explicit historical date resolves within the tenant', async () => {
    const aEntry = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findByStudentRef(client, COLLIDING_REF, HISTORICAL);
    });
    expect(aEntry).not.toBeNull();
    expect(aEntry!.student_name).toBe('Kim Alpha');

    const bEntry = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findByStudentRef(client, COLLIDING_REF, HISTORICAL);
    });
    expect(bEntry).not.toBeNull();
    expect(bEntry!.student_name).toBe('Kim Bravo');
  });

  it('a dated search returns only the active tenant’s rows for that date', async () => {
    // Tenant A on the historical date: the six day-1 fixture rows, the
    // day-1-only scholar, and A's colliding row — never B's.
    const aPage = await withTenant(db.appPool, TENANT_A, async (client) => {
      return searchRosterEntries(client, {}, { limit: 50, offset: 0 }, HISTORICAL);
    });
    expect(aPage.total).toBe(VALID_ROWS + 2);
    const aColliding = aPage.entries.find((e) => e.student_ref === COLLIDING_REF);
    expect(aColliding?.student_name).toBe('Kim Alpha');
    for (const entry of aPage.entries) {
      expect(entry.service_date).toBe(HISTORICAL);
      expect(entry.student_name).not.toBe('Kim Bravo');
    }

    // Tenant B on the same date: only B's colliding row — A's history
    // is invisible even though both tenants have rows for the date.
    const bPage = await withTenant(db.appPool, TENANT_B, async (client) => {
      return searchRosterEntries(client, {}, { limit: 50, offset: 0 }, HISTORICAL);
    });
    expect(bPage.total).toBe(1);
    expect(bPage.entries[0]!.student_ref).toBe(COLLIDING_REF);
    expect(bPage.entries[0]!.student_name).toBe('Kim Bravo');
  });

  it('a raw dated count never includes the other tenant’s rows', async () => {
    const counts = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ count: string }>(
        `select count(*)::text as count from roster_entries where service_date = $1`,
        [HISTORICAL],
      );
      return parseInt(res.rows[0]!.count, 10);
    });
    // A's historical set: 6 fixture + 1 day-1-only + 1 colliding = 8.
    // Any cross-tenant row is the critical fail condition.
    expect(counts).toBe(VALID_ROWS + 2);
  });

  it('a default-scoped (today) read stays tenant-scoped', async () => {
    // Both tenants have today's rosters; each sees its own scholars.
    const aStatus = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'grain-test',
        freshnessMinutes: 45,
      });
    });
    expect(aStatus.kind).toBe('success');

    // A ref belonging only to tenant B is not found under tenant A —
    // same message as a genuinely unknown ref, never forbidden-but-real.
    const crossStatus = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'B001',
        caller: 'staff',
        actor: 'grain-test',
        freshnessMinutes: 45,
      });
    });
    expect(crossStatus).toEqual({ kind: 'refusal', reason: 'student_not_found' });

    // The colliding ref exists historically in both tenants; a
    // default-scoped read under A finds neither tenant's historical row.
    const historicalStatus = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: COLLIDING_REF,
        caller: 'staff',
        actor: 'grain-test',
        freshnessMinutes: 45,
      });
    });
    expect(historicalStatus).toEqual({ kind: 'refusal', reason: 'student_not_found' });
  });
});
