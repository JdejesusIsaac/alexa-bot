import { type PoolClient } from 'pg';
import '../db/pg-types.js';

/**
 * Roster entry repository.
 *
 * All data access goes through repositories. Each method accepts a
 * `PoolClient` that is already scoped to a tenant via `withTenant` —
 * the repository never acquires its own connection, which would bypass
 * the tenant context.
 *
 * RLS enforces isolation at the database level; the repository provides
 * intention-named methods so that raw `.query()` is never needed outside
 * this directory (Rule 11).
 */

export interface RosterEntry {
  id: string;
  tenant_id: string;
  service_date: string;
  student_id: string | null;
  student_ref: string;
  student_name: string;
  section: string | null;
  attendance_status: string | null;
  reason_code: string | null;
  hold_type: string | null;
  hold_source: 'derived' | 'authoritative';
  release_time: string | null;
  hold_location: string | null;
  do_not_call: boolean;
  missing_id: boolean;
  source_row_number: number;
  sync_id: string;
}

/**
 * Find a roster entry by student reference within the current tenant
 * context, scoped to a service date (PL-201). RLS ensures only the
 * active tenant's rows are visible; the date scope ensures only that
 * day's set is reachable — the grain adds rows previous reads never
 * saw, so an undated read here would be a leak vector (21).
 */
export async function findByStudentRef(
  client: PoolClient,
  studentRef: string,
  serviceDate: string,
): Promise<RosterEntry | null> {
  const res = await client.query<RosterEntry>(
    `select * from roster_entries
     where student_ref = $1 and service_date = $2
     limit 1`,
    [studentRef, serviceDate],
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Find a roster entry by student name within the current tenant context,
 * scoped to a service date (PL-201). Used when a parent provides a name
 * rather than a ref.
 */
export async function findByStudentName(
  client: PoolClient,
  studentName: string,
  serviceDate: string,
): Promise<RosterEntry | null> {
  const res = await client.query<RosterEntry>(
    `select * from roster_entries
     where student_name = $1 and service_date = $2
     limit 1`,
    [studentName, serviceDate],
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Count roster entries for the current tenant on a service date.
 * Used by sync to record how many rows landed on the day's set.
 */
export async function countEntries(
  client: PoolClient,
  serviceDate: string,
): Promise<number> {
  const res = await client.query<{ count: string }>(
    `select count(*)::text as count from roster_entries where service_date = $1`,
    [serviceDate],
  );
  return parseInt(res.rows[0]!.count, 10);
}

/**
 * Search the current tenant's roster (PL-108). Filters are optional and
 * composable; every declared filter is applied — a declared-but-ignored
 * filter makes the model confidently assert a narrowing that never
 * happened (AD-15, T-43).
 *
 * Returns the page of entries and the total match count, so an empty
 * page is distinguishable from a failed query (never an empty success
 * standing in for a failure).
 */
export interface RosterSearchFilters {
  readonly section?: string;
  readonly holdType?: string;
  readonly attendanceStatus?: string;
}

export interface RosterSearchPage {
  readonly entries: readonly RosterEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export async function searchRosterEntries(
  client: PoolClient,
  filters: RosterSearchFilters,
  pagination: { limit: number; offset: number },
  serviceDate: string,
): Promise<RosterSearchPage> {
  const where: string[] = [];
  const params: unknown[] = [];

  params.push(serviceDate);
  where.push(`service_date = $${params.length}`);

  if (filters.section !== undefined) {
    params.push(filters.section);
    where.push(`section = $${params.length}`);
  }
  if (filters.holdType !== undefined) {
    params.push(filters.holdType);
    where.push(`hold_type = $${params.length}`);
  }
  if (filters.attendanceStatus !== undefined) {
    params.push(filters.attendanceStatus);
    where.push(`attendance_status = $${params.length}`);
  }

  const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : '';

  const countRes = await client.query<{ count: string }>(
    `select count(*)::text as count from roster_entries ${whereSql}`,
    params,
  );
  const total = parseInt(countRes.rows[0]!.count, 10);

  params.push(pagination.limit);
  const limitIdx = params.length;
  params.push(pagination.offset);
  const offsetIdx = params.length;

  const res = await client.query<RosterEntry>(
    `select * from roster_entries ${whereSql}
     order by student_ref asc
     limit $${limitIdx} offset $${offsetIdx}`,
    params,
  );

  return {
    entries: res.rows,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

/**
 * Delete the roster entries for one service date within the current
 * tenant. Used by the sync scheduler before re-ingesting to keep the
 * day's set idempotent (T-11) — and only the day's set: deleting every
 * date is exactly the wipe that the service_date grain exists to prevent
 * (T-50).
 */
export async function deleteEntriesForDate(
  client: PoolClient,
  serviceDate: string,
): Promise<number> {
  const res = await client.query(`delete from roster_entries where service_date = $1`, [
    serviceDate,
  ]);
  return res.rowCount ?? 0;
}

/**
 * Insert a roster entry. The tenant_id is set by RLS from the
 * `app.tenant_id` session variable — it is never passed as a value
 * in the INSERT, ensuring it cannot be forged.
 */
export async function insertEntry(
  client: PoolClient,
  params: {
    serviceDate: string;
    studentId: string;
    studentRef: string;
    studentName: string;
    section: string | null;
    attendanceStatus: string | null;
    reasonCode: string | null;
    holdType: string | null;
    holdSource: 'derived' | 'authoritative';
    releaseTime: string | null;
    holdLocation: string | null;
    doNotCall: boolean;
    missingId: boolean;
    sourceRowNumber: number;
    syncId: string;
  },
): Promise<RosterEntry> {
  const res = await client.query<RosterEntry>(
    `insert into roster_entries
       (tenant_id, service_date, student_id, student_ref, student_name, section, attendance_status,
        reason_code, hold_type, hold_source, release_time, hold_location,
        do_not_call, missing_id, source_row_number, sync_id)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning *`,
    [
      params.serviceDate,
      params.studentId,
      params.studentRef,
      params.studentName,
      params.section,
      params.attendanceStatus,
      params.reasonCode,
      params.holdType,
      params.holdSource,
      params.releaseTime,
      params.holdLocation,
      params.doNotCall,
      params.missingId,
      params.sourceRowNumber,
      params.syncId,
    ],
  );
  return res.rows[0]!;
}
