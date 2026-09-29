import { type PoolClient } from 'pg';

/**
 * Quarantined rows repository (PL-006).
 *
 * Rows that fail validation (Zod schema or semantic validation) are stored
 * here with their source row number, raw data, and a specific reason.
 * Quarantined rows are never readable by the status lookup (PL-009) —
 * they exist only for staff diagnosis.
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in the INSERT (Rule 7).
 */

export interface QuarantinedRow {
  id: string;
  tenant_id: string;
  sync_id: string;
  source_row_number: number;
  raw_data: Record<string, unknown>;
  reason: string;
}

/**
 * Insert a quarantined row. The tenant_id is set by RLS from the
 * `app.tenant_id` session variable — it is never passed as a value
 * in the INSERT, ensuring it cannot be forged.
 */
export async function insertQuarantinedRow(
  client: PoolClient,
  params: {
    syncId: string;
    sourceRowNumber: number;
    rawData: Record<string, unknown>;
    reason: string;
  },
): Promise<QuarantinedRow> {
  const res = await client.query<QuarantinedRow>(
    `insert into quarantined_rows (tenant_id, sync_id, source_row_number, raw_data, reason)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)
     returning *`,
    [
      params.syncId,
      params.sourceRowNumber,
      JSON.stringify(params.rawData),
      params.reason,
    ],
  );
  return res.rows[0]!;
}

/**
 * Find all quarantined rows for a sync, ordered by source row number.
 * RLS ensures only the active tenant's quarantined rows are visible.
 */
export async function findBySync(
  client: PoolClient,
  syncId: string,
): Promise<QuarantinedRow[]> {
  const res = await client.query<QuarantinedRow>(
    `select * from quarantined_rows where sync_id = $1 order by source_row_number`,
    [syncId],
  );
  return res.rows;
}

/**
 * Quarantine summary with reasons for the current tenant's most recent
 * sync (PL-109). Admins see counts and reasons — never row contents,
 * which may include unvalidated free text.
 */
export interface QuarantineSummary {
  readonly total: number;
  readonly byReason: ReadonlyArray<{ reason: string; count: number }>;
}

export async function summarizeQuarantine(
  client: PoolClient,
): Promise<QuarantineSummary> {
  const res = await client.query<{ reason: string; count: string }>(
    `select reason, count(*)::text as count from quarantined_rows
     where sync_id = (select id from roster_syncs order by started_at desc limit 1)
     group by reason order by count desc, reason asc`,
  );
  const byReason = res.rows.map((r) => ({
    reason: r.reason,
    count: parseInt(r.count, 10),
  }));
  const total = byReason.reduce((sum, r) => sum + r.count, 0);
  return { total, byReason };
}

/**
 * Delete the quarantined rows for one service date within the current
 * tenant. Used by the sync scheduler before re-ingesting to keep the
 * day's set idempotent (T-11). Scoped by the sync's service date, like
 * the roster entries it accompanies — a new day's sync must not wipe a
 * prior day's quarantine history (PL-201).
 */
export async function deleteQuarantinedRowsForDate(
  client: PoolClient,
  serviceDate: string,
): Promise<number> {
  const res = await client.query(
    `delete from quarantined_rows q
     using roster_syncs s
     where q.sync_id = s.id and s.service_date = $1`,
    [serviceDate],
  );
  return res.rowCount ?? 0;
}

/**
 * Check whether any quarantined row has a student_ref matching the given
 * value. The student_ref is stored inside `raw_data` jsonb under the
 * tenant's sheet header for that field, so the caller must provide the
 * sheet header (from column_mappings).
 *
 * Scoped to a service date (PL-201): a quarantine from a prior day says
 * nothing about today's roster, and the refusal reason must not reach
 * further back than the read it explains.
 *
 * Used by `getScholarStatus` to distinguish "student not found" from
 * "student row was quarantined" (T-07, T-15).
 */
export async function existsByStudentRef(
  client: PoolClient,
  studentRef: string,
  studentRefHeader: string,
  serviceDate: string,
): Promise<boolean> {
  // raw_data is stored as { headers: [...], values: [...] } — parallel arrays.
  // Find the index of the student_ref header in the headers array, then check
  // the value at the same index in the values array.
  const res = await client.query(
    `select 1 from quarantined_rows q
     join roster_syncs s on s.id = q.sync_id
     where s.service_date = $3
       and exists (
       select 1
       from jsonb_array_elements_text(q.raw_data->'headers') with ordinality as h(header, idx)
       where h.header = $2
         and q.raw_data->'values'->>((h.idx - 1)::int) = $1
     )
     limit 1`,
    [studentRef, studentRefHeader, serviceDate],
  );
  return res.rows.length > 0;
}
