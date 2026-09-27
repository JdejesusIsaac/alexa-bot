import { Pool, type PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import {
  transitionPickupRequest,
  processDueEscalations,
  type DueEscalationRow,
  type DueEscalationStats,
} from '../repositories/pickup-requests.js';
import { findStaffIdentityBySubject } from '../repositories/staff-identities.js';
import { insertTenantMcpAuditEntry } from '../repositories/mcp-audit.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { loadConfig } from '../config.js';
import {
  loadEscalationLadderFromEnv,
  type EscalationLadder,
} from './escalation-ladder.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Escalation worker (PL-204) — the ladder's engine.
 *
 * A second long-running process, same codebase, same repository layer.
 * The poll loop IS this component's boundary (AD-42): a row it skips
 * or fails to transition is audited HERE, because there is no HTTP
 * layer in front of it — a silently skipped row is the same gap as an
 * unaudited rejection.
 *
 * **AD-26: expiry never approves.** A row past the top of the ladder
 * transitions to `expired` — a terminal state routing the coordinator
 * to in-person handling. No timeout, error, restart, or default path
 * produces `approved` or `released`; T-60 holds that structurally.
 *
 * **The ladder is required configuration with no default.** The
 * constructor accepts only a loaded `EscalationLadder` — obtainable
 * from `loadEscalationLadder`, which fails loudly at boot naming the
 * file. A worker that cannot find its ladder does not start; it never
 * gets far enough to decline rows one at a time, which is the failure
 * shape that eventually gets "fixed" with an invented default.
 *
 * Concurrency (T-61): the due queue is claimed with
 * `FOR UPDATE SKIP LOCKED` inside one transaction per tick, with a
 * SAVEPOINT per row — two workers racing the same due row means one
 * escalates and the other never sees it, and a row that throws
 * mid-batch rolls back to its savepoint without sinking the others.
 * State lives in Postgres (AD-30): restart mid-ladder resumes at the
 * correct level (T-62).
 */

/** One worker job per tenant — tenant ids come from configuration. */
export interface EscalationJob {
  readonly tenantId: string;
}

export interface EscalationWorkerOptions {
  readonly jobs: readonly EscalationJob[];
  /** Poll interval in milliseconds (default 15s). */
  readonly intervalMs?: number;
  /** Due rows claimed per tick, per tenant (default 50). */
  readonly batchSize?: number;
}

export interface TickStats extends DueEscalationStats {
  readonly tenantId: string;
}

const WORKER_ACTOR = 'escalation-worker';

export class EscalationWorker {
  private readonly pool: Pool;
  private readonly ladder: EscalationLadder;
  private readonly logger: Logger;
  private readonly opts: Required<
    Pick<EscalationWorkerOptions, 'intervalMs' | 'batchSize'>
  > &
    EscalationWorkerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    pool: Pool,
    ladder: EscalationLadder,
    logger: Logger,
    options: EscalationWorkerOptions,
  ) {
    this.pool = pool;
    this.ladder = ladder;
    this.logger = logger;
    this.opts = {
      intervalMs: options.intervalMs ?? 15_000,
      batchSize: options.batchSize ?? 50,
      jobs: options.jobs,
    };
  }

  /** Start polling. The ladder is already validated — start cannot fail silently. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref();
    this.logger.info({
      msg: 'escalation_worker_started',
      ladder_source: this.ladder.source,
      rungs: this.ladder.rungs.length,
      jobs: this.opts.jobs.length,
      interval_ms: this.opts.intervalMs,
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass over every configured tenant's due queue. */
  async tick(): Promise<TickStats[]> {
    const stats: TickStats[] = [];
    for (const job of this.opts.jobs) {
      stats.push(await this.tickTenant(job));
    }
    return stats;
  }

  /**
   * One tenant's due queue. The transaction mechanics and the SKIP
   * LOCKED claim live in the repository (`processDueEscalations`); this
   * side owns ladder policy — which rung, which approver, and the
   * AD-42 audit for rows it skips or fails to transition.
   */
  private async tickTenant(job: EscalationJob): Promise<TickStats> {
    let stats: DueEscalationStats;
    await withTenant(this.pool, job.tenantId, async (client) => {
      stats = await processDueEscalations(
        client,
        this.opts.batchSize,
        (c, row) => this.processRow(c, row.id, row.escalation_level),
        (c, row, err) => this.auditRowFailure(c, row, err),
      );
    });

    if (stats!.claimed > 0) {
      this.logger.info({
        msg: 'escalation_tick',
        tenant_id: job.tenantId,
        ...stats!,
      });
    }
    return { tenantId: job.tenantId, ...stats! };
  }

  /**
   * One due row. Level L, ladder of N rungs:
   *  - L < N → escalate to rung L+1's approver with rung L+1's clock
   *  - L >= N → expire (AD-26: never approve)
   * A rung whose approver subject has no staff identity in this tenant
   * is a config gap — the row is skipped, audited, and left routed for
   * the next tick (fixing the mapping resumes it; nothing is lost).
   */
  private async processRow(
    client: PoolClient,
    requestId: string,
    level: number,
  ): Promise<'escalated' | 'expired' | 'skipped'> {
    const nextLevel = level + 1;
    const rung = this.ladder.rungs[nextLevel - 1];

    if (rung === undefined) {
      // The top of the ladder. Expiry terminates to in-person handling.
      const result = await transitionPickupRequest(client, {
        requestId,
        action: 'expire',
        actor: WORKER_ACTOR,
        channel: 'worker',
      });
      if (!result.ok) {
        throw new Error(`expire transition refused: ${result.code}`);
      }
      return 'expired';
    }

    const approver = await findStaffIdentityBySubject(client, rung.approverSubject);
    if (approver === null) {
      // AD-42: the poll loop is the boundary — a skipped row is audited
      // here, by request id, before anything else can claim it worked.
      await this.auditRow(
        client,
        requestId,
        'skipped:approver_not_mapped',
        `rung ${nextLevel} approver ${rung.approverSubject} has no staff identity in this tenant`,
      );
      return 'skipped';
    }

    const escalateAt = new Date(Date.now() + rung.afterMinutes * 60_000);
    const result = await transitionPickupRequest(client, {
      requestId,
      action: 'escalate',
      actor: WORKER_ACTOR,
      channel: 'worker',
      escalateAt,
      assignedApproverId: approver.id,
    });
    if (!result.ok) {
      throw new Error(`escalate transition refused: ${result.code}`);
    }
    return 'escalated';
  }

  /** AD-42: audit a row the worker failed to transition, by request id. */
  private async auditRowFailure(
    client: PoolClient,
    row: DueEscalationRow,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.auditRow(client, row.id, 'error:worker_row_failed', message);
    this.logger.error({
      msg: 'escalation_row_failed',
      request_id: row.id,
      error: message,
    });
  }

  /** AD-42 worker-boundary audit row — queryable by the pickup request id. */
  private async auditRow(
    client: PoolClient,
    requestId: string,
    outcome: string,
    detail: string,
  ): Promise<void> {
    try {
      await insertTenantMcpAuditEntry(client, {
        requestId,
        actor: WORKER_ACTOR,
        role: null,
        httpMethod: 'WORKER',
        rpcMethod: 'escalation_tick',
        tool: null,
        // The detail is the config gap, never student data.
        argumentsRedacted: { detail },
        outcome,
        authMs: null,
        toolMs: null,
        totalMs: null,
      });
    } catch (err) {
      this.logger.error({
        msg: 'audit_write_failed',
        request_id: requestId,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Process entry — `npm run worker`. Loads the written ladder from
 * ESCALATION_LADDER_FILE (refusing to start without it), then polls.
 * Tenant ids come from WORKER_TENANTS (comma-separated) — configuration,
 * never a caller argument (Rule 7).
 */
async function runFromEnv(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // The boot refusal: a worker without a written ladder does not start.
  const ladder = await loadEscalationLadderFromEnv();

  const tenants = (process.env.WORKER_TENANTS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tenants.length === 0) {
    throw new Error(
      'WORKER_TENANTS is not set — the escalation worker refuses to start.',
    );
  }

  const pool = new Pool({
    connectionString: config.appDatabaseUrl,
    max: 4,
  });

  const worker = new EscalationWorker(pool, ladder, logger, {
    jobs: tenants.map((tenantId) => ({ tenantId })),
  });
  worker.start();
  logger.info({ msg: 'escalation_worker_process_ready' });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  runFromEnv().catch((err: unknown) => {
    // Loud, named, non-zero — this is the refusal the guardrails asked
    // for, printed to stderr where operators will actually see it.
    console.error(`escalation worker failed to start: ${(err as Error).message}`);
    process.exit(1);
  });
}
