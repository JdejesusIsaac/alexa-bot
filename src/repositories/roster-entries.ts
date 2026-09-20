import { type PoolClient } from 'pg';

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
 * context. RLS ensures only the active tenant's rows are visible.
 */
export async function findByStudentRef(
  client: PoolClient,
  studentRef: string,
): Promise<RosterEntry | null> {
  const res = await client.query<RosterEntry>(
    `select * from roster_entries where student_ref = $1 limit 1`,
    [studentRef],
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Find a roster entry by student name within the current tenant context.
 * Used when a parent provides a name rather than a ref.
 */
export async function findByStudentName(
  client: PoolClient,
  studentName: string,
): Promise<RosterEntry | null> {
  const res = await client.query<RosterEntry>(
    `select * from roster_entries where student_name = $1 limit 1`,
    [studentName],
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Count roster entries for the current tenant. Used by sync to record
 * how many rows landed.
 */
export async function countEntries(client: PoolClient): Promise<number> {
  const res = await client.query<{ count: string }>(
    `select count(*)::text as count from roster_entries`,
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
): Promise<RosterSearchPage> {
  const where: string[] = [];
  const params: unknown[] = [];

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
 * Delete all roster entries for the current tenant. Used by the sync
 * scheduler before re-ingesting to ensure idempotency (T-11). RLS
 * ensures only the active tenant's rows are affected.
 */
export async function deleteAllEntries(client: PoolClient): Promise<number> {
  const res = await client.query(`delete from roster_entries`);
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
       (tenant_id, student_ref, student_name, section, attendance_status,
        reason_code, hold_type, hold_source, release_time, hold_location,
        do_not_call, missing_id, source_row_number, sync_id)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
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
