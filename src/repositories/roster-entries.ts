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
export async function countEntries(
  client: PoolClient,
): Promise<number> {
  const res = await client.query<{ count: string }>(
    `select count(*)::text as count from roster_entries`,
  );
  return parseInt(res.rows[0]!.count, 10);
}

/**
 * Delete all roster entries for the current tenant. Used by the sync
 * scheduler before re-ingesting to ensure idempotency (T-11). RLS
 * ensures only the active tenant's rows are affected.
 */
export async function deleteAllEntries(
  client: PoolClient,
): Promise<number> {
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
