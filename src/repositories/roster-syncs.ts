import { type PoolClient } from 'pg';

/**
 * Roster syncs repository (PL-006/PL-007).
 *
 * Each sync run creates a `roster_syncs` record with started/finished
 * timestamps, row counts, and an outcome. The outcome is one of:
 *  - `success` — all rows valid
 *  - `partial-success` — some rows quarantined, rest valid
 *  - `failure` — sync could not complete (e.g. connector error)
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in the INSERT (Rule 7).
 */

export interface RosterSync {
  id: string;
  tenant_id: string;
  started_at: Date;
  finished_at: Date | null;
  rows_in: number;
  rows_valid: number;
  rows_quarantined: number;
  outcome: 'success' | 'partial-success' | 'failure';
}

/**
 * Create a new sync record at the start of a sync run.
 * The tenant_id is set by RLS from `app.tenant_id`.
 */
export async function createSync(
  client: PoolClient,
): Promise<RosterSync> {
  const res = await client.query<RosterSync>(
    `insert into roster_syncs (tenant_id, started_at, rows_in, rows_valid, rows_quarantined, outcome)
     values (current_setting('app.tenant_id')::uuid, now(), 0, 0, 0, 'success')
     returning *`,
  );
  return res.rows[0]!;
}

/**
 * Finalize a sync record with counts and outcome.
 */
export async function finalizeSync(
  client: PoolClient,
  params: {
    syncId: string;
    rowsIn: number;
    rowsValid: number;
    rowsQuarantined: number;
    outcome: 'success' | 'partial-success' | 'failure';
  },
): Promise<RosterSync> {
  const res = await client.query<RosterSync>(
    `update roster_syncs
     set finished_at = now(),
         rows_in = $2,
         rows_valid = $3,
         rows_quarantined = $4,
         outcome = $5
     where id = $1
     returning *`,
    [
      params.syncId,
      params.rowsIn,
      params.rowsValid,
      params.rowsQuarantined,
      params.outcome,
    ],
  );
  return res.rows[0]!;
}

/**
 * Find the latest sync record for the current tenant.
 */
export async function findLatestSync(
  client: PoolClient,
): Promise<RosterSync | null> {
  const res = await client.query<RosterSync>(
    `select * from roster_syncs order by started_at desc limit 1`,
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Find the latest *successful* sync record for the current tenant.
 * A successful sync is one with outcome 'success' or 'partial-success'.
 * Failed syncs are excluded so the staleness guard counts from the last
 * good sync, not a failed one (T-13).
 */
export async function findLatestSuccessfulSync(
  client: PoolClient,
): Promise<RosterSync | null> {
  const res = await client.query<RosterSync>(
    `select * from roster_syncs
     where outcome in ('success', 'partial-success')
     order by finished_at desc nulls last
     limit 1`,
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Check whether the roster is fresh for the current tenant.
 * Returns true if the latest successful sync finished within the
 * freshness threshold (default 45 minutes). Returns false if no
 * successful sync exists or the sync is stale (T-12).
 */
export async function isRosterFresh(
  client: PoolClient,
  freshnessMinutes: number,
): Promise<boolean> {
  const sync = await findLatestSuccessfulSync(client);
  if (!sync || !sync.finished_at) {
    return false;
  }
  const ageMs = Date.now() - new Date(sync.finished_at).getTime();
  return ageMs < freshnessMinutes * 60 * 1000;
}
