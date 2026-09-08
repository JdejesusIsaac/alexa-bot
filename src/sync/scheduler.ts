/**
 * Sync scheduler + staleness guard (PL-007).
 *
 * Scheduled sync (default every 15 min, school hours). Each run writes
 * a `roster_syncs` record: started, finished, rows in/valid/quarantined,
 * outcome. `isRosterFresh` returns false past the threshold (default 45 min).
 *
 * The scheduler is background-job infrastructure. It establishes tenant
 * context explicitly via `withTenant` (T-23) — there is no HTTP request
 * to derive the tenant from. The `tenantId` in `SyncJob` comes from
 * configuration, not from a caller-supplied argument.
 *
 * Design:
 *  - The sheet is fetched BEFORE old entries are deleted. If the fetch
 *    fails, existing data is preserved (T-13).
 *  - Staleness counts from the last *successful* sync, not a failed one
 *    (T-13). `findLatestSuccessfulSync` filters out failures.
 *  - Sync is idempotent: old entries are deleted before re-ingesting,
 *    so twice on an unchanged sheet produces no duplicates (T-11).
 */

import { type Pool } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import { type SheetConnector, type SheetData, ConnectorError } from '../connector/sheet-connector.js';
import { findByTenant as findMappings } from '../repositories/column-mappings.js';
import { findByTenant as findRules } from '../repositories/derivation-rules.js';
import { ingestSheet, type IngestResult } from './ingest.js';
import {
  createSync,
  finalizeSync,
  type RosterSync,
} from '../repositories/roster-syncs.js';
import { deleteAllEntries } from '../repositories/roster-entries.js';
import { deleteAllQuarantinedRows } from '../repositories/quarantined-rows.js';

/**
 * One sync job per tenant. The `tenantId` comes from configuration —
 * this is background-job infrastructure, not a request-scoped argument.
 */
export interface SyncJob {
  readonly tenantId: string;
  readonly sheetId: string;
  readonly range: string;
}

/**
 * Typed result of a sync run. Never an empty success (Rule 10).
 */
export type SyncResult =
  | { kind: 'success'; sync: RosterSync; ingest: IngestResult }
  | { kind: 'failure'; sync: RosterSync; error: string };

/**
 * Run a single sync for one tenant.
 *
 * 1. Enter `withTenant` — establish tenant context explicitly (T-23).
 * 2. Fetch column mappings + derivation rules from the DB.
 * 3. Try to fetch the sheet via the connector.
 * 4. On connector failure: create + finalize a failed sync record.
 *    Do NOT delete existing entries — previous roster stays intact (T-13).
 * 5. On connector success: clear old entries + quarantined rows, then
 *    run `ingestSheet` to re-ingest (T-11 idempotency).
 */
export async function runSync(
  pool: Pool,
  connector: SheetConnector,
  job: SyncJob,
): Promise<SyncResult> {
  return withTenant(pool, job.tenantId, async (client) => {
    // Fetch config (mappings + rules) within tenant context
    const mappings = await findMappings(client);
    const rules = await findRules(client);

    // Try to fetch the sheet BEFORE deleting old data.
    let sheetData: SheetData;
    try {
      sheetData = await connector.fetchSheet(job.sheetId, job.range);
    } catch (err) {
      // Connector failure — record a failed sync, preserve existing data.
      const sync = await createSync(client);
      const failedSync = await finalizeSync(client, {
        syncId: sync.id,
        rowsIn: 0,
        rowsValid: 0,
        rowsQuarantined: 0,
        outcome: 'failure',
      });
      const errorMsg =
        err instanceof ConnectorError
          ? err.name
          : 'unknown error';
      return {
        kind: 'failure',
        sync: failedSync,
        error: errorMsg,
      };
    }

    // Connector succeeded — clear old data and re-ingest (idempotent).
    await deleteAllEntries(client);
    await deleteAllQuarantinedRows(client);

    const ingest = await ingestSheet(
      client,
      sheetData,
      mappings,
      rules,
    );

    return {
      kind: 'success',
      sync: ingest.sync,
      ingest,
    };
  });
}

/**
 * Scheduler options.
 */
export interface SchedulerOptions {
  /** Sync interval in minutes (default 15). */
  readonly intervalMinutes?: number;
  /** School hours window. Defaults to Mon–Fri 7:00–16:00. */
  readonly schoolHours?: {
    readonly startHour: number;
    readonly endHour: number;
    readonly days: readonly number[]; // 0=Sun, 6=Sat
  };
}

const DEFAULT_OPTS: Required<SchedulerOptions> = {
  intervalMinutes: 15,
  schoolHours: {
    startHour: 7,
    endHour: 16,
    days: [1, 2, 3, 4, 5], // Mon–Fri
  },
};

function isWithinSchoolHours(
  now: Date,
  schoolHours: Required<SchedulerOptions>['schoolHours'],
): boolean {
  const day = now.getDay();
  const hour = now.getHours();
  return (
    schoolHours.days.includes(day) &&
    hour >= schoolHours.startHour &&
    hour < schoolHours.endHour
  );
}

/**
 * Scheduled sync runner. Calls `runSync` for each job on a configurable
 * interval, gated by school hours.
 */
export class SyncScheduler {
  private readonly pool: Pool;
  private readonly connector: SheetConnector;
  private readonly jobs: readonly SyncJob[];
  private readonly opts: Required<SchedulerOptions>;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    pool: Pool,
    connector: SheetConnector,
    jobs: readonly SyncJob[],
    opts?: SchedulerOptions,
  ) {
    this.pool = pool;
    this.connector = connector;
    this.jobs = jobs;
    this.opts = {
      intervalMinutes: opts?.intervalMinutes ?? DEFAULT_OPTS.intervalMinutes,
      schoolHours: opts?.schoolHours ?? DEFAULT_OPTS.schoolHours,
    };
  }

  /**
   * Start the scheduler. Runs `tick` on every interval.
   */
  start(): void {
    if (this.intervalId !== null) {
      return;
    }
    this.intervalId = setInterval(
      () => void this.tick(),
      this.opts.intervalMinutes * 60 * 1000,
    );
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Run one sync cycle for all jobs. Skips runs outside school hours.
   */
  async tick(): Promise<SyncResult[]> {
    if (!isWithinSchoolHours(new Date(), this.opts.schoolHours)) {
      return [];
    }
    const results: SyncResult[] = [];
    for (const job of this.jobs) {
      const result = await runSync(this.pool, this.connector, job);
      results.push(result);
    }
    return results;
  }
}
