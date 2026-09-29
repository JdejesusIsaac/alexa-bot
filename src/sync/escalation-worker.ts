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
  loadEscalationLaddersFromEnv,
  type EscalationLadder,
} from './escalation-ladder.js';
import {
  createPickupNotifier,
  type PickupNotifier,
} from '../services/pickup-notification.js';
import { WebApiSlackClient } from '../slack/web-api-client.js';
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

/**
 * One worker job per tenant (PL-254) — tenant ids and ladders come
 * from configuration (`<ESCALATION_LADDER_DIR>/<tenant_id>.json` per
 * WORKER_TENANTS entry). The ladder rides on the job because approver
 * subjects are per-tenant: one shared ladder is the reason a two-tenant
 * worker skipped every row of the second campus.
 */
export interface EscalationJob {
  readonly tenantId: string;
  readonly ladder: EscalationLadder;
}

export interface EscalationWorkerOptions {
  readonly jobs: readonly EscalationJob[];
  /** Poll interval in milliseconds (default 15s). */
  readonly intervalMs?: number;
  /** Due rows claimed per tick, per tenant (default 50). */
  readonly batchSize?: number;
  /**
   * Skip/failure ceiling (ESCALATION_MAX_ATTEMPTS, default 20): at the
   * ceiling the worker transitions the row to `stalled` — terminal,
   * audited, a human handoff that never behaves like `approved`.
   */
  readonly maxAttempts?: number;
  /**
   * Requeue delay after a skip/fail in seconds. A row that skips or
   * fails keeps its escalate_at no longer — it defers out of the
   * oldest-first head so a poisoned row cannot starve a healthy one.
   * Default: the poll interval.
   */
  readonly deferralSeconds?: number;
  /**
   * Outbound Slack notifier (PL-252): an escalated row DMs its newly
   * assigned approver; a terminal row posts the in-person handoff to
   * the visibility thread. Absent → nothing is sent; a failed send is
   * a log line, never a failed transition.
   */
  readonly notifier?: PickupNotifier;
}

export interface TickStats extends DueEscalationStats {
  readonly tenantId: string;
}

const WORKER_ACTOR = 'escalation-worker';

export class EscalationWorker {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly notifier: PickupNotifier | undefined;
  private readonly opts: Required<
    Pick<
      EscalationWorkerOptions,
      'intervalMs' | 'batchSize' | 'maxAttempts' | 'deferralSeconds'
    >
  > &
    EscalationWorkerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive per-tenant tick failures — the unhealthy signal. */
  private readonly tenantFailures = new Map<string, number>();

  constructor(
    pool: Pool,
    logger: Logger,
    options: EscalationWorkerOptions,
  ) {
    this.pool = pool;
    this.logger = logger;
    this.notifier = options.notifier;
    const intervalMs = options.intervalMs ?? 15_000;
    this.opts = {
      intervalMs,
      batchSize: options.batchSize ?? 50,
      maxAttempts: options.maxAttempts ?? 20,
      // A skipped/failed row defers by at most the poll interval —
      // it rejoins the queue behind healthy rows, never ahead of them.
      deferralSeconds: options.deferralSeconds ?? intervalMs / 1000,
      jobs: options.jobs,
    };
  }

  /**
   * Start polling. tick() is a CAUGHT promise (PL-258): a tick that
   * rejects inside `setInterval` is an unhandled rejection, which exits
   * the process on Node 20 — Sprint 2's F-1 shape. Per-tenant failures
   * are already isolated inside tick(); a rejection here means the loop
   * itself failed — count it, report worker_unhealthy, keep polling.
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.logger.error({
          msg: 'worker_unhealthy',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.opts.intervalMs);
    this.timer.unref();
    this.logger.info({
      msg: 'escalation_worker_started',
      jobs: this.opts.jobs.length,
      interval_ms: this.opts.intervalMs,
      max_attempts: this.opts.maxAttempts,
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass over every configured tenant's due queue (PL-258): a
   * tenant whose tick throws does not take the others down — its
   * failure is logged and audited, and the loop continues. Consecutive
   * failures for the same tenant emit `worker_unhealthy`; the worker
   * keeps polling either way — a dead worker is how a queue starves.
   */
  async tick(): Promise<TickStats[]> {
    const stats: TickStats[] = [];
    for (const job of this.opts.jobs) {
      try {
        stats.push(await this.tickTenant(job));
        this.tenantFailures.set(job.tenantId, 0);
      } catch (err) {
        const consecutive = (this.tenantFailures.get(job.tenantId) ?? 0) + 1;
        this.tenantFailures.set(job.tenantId, consecutive);
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({
          msg: 'escalation_tenant_failed',
          tenant_id: job.tenantId,
          consecutive_failures: consecutive,
          error: message,
        });
        if (consecutive >= 2) {
          this.logger.error({
            msg: 'worker_unhealthy',
            tenant_id: job.tenantId,
            consecutive_failures: consecutive,
          });
        }
        await this.auditTenantFailure(job.tenantId, message);
        stats.push({
          tenantId: job.tenantId,
          claimed: 0,
          escalated: 0,
          expired: 0,
          skipped: 0,
          stalled: 0,
          failed: 0,
        });
      }
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
    // A job with no ladder is a constructor-level type error — and a
    // runtime refusal, because `any` exists. A tenant whose policy is
    // absent does not tick; the others still do.
    if (job.ladder === undefined || job.ladder === null) {
      throw new Error(
        `escalation job for tenant ${job.tenantId} has no ladder — refusing to tick`,
      );
    }

    let stats: DueEscalationStats;
    // What the tick did, per row — notification sends happen AFTER the
    // claim transaction commits (a DM for a rolled-back escalate would
    // name an approver who was never assigned).
    const outcomes: Array<{
      requestId: string;
      outcome: 'escalated' | 'expired' | 'skipped' | 'stalled';
    }> = [];
    await withTenant(this.pool, job.tenantId, async (client) => {
      stats = await processDueEscalations(
        client,
        this.opts.batchSize,
        this.opts.deferralSeconds,
        async (c, row) => {
          const outcome = await this.processRow(c, row, job.ladder);
          outcomes.push({ requestId: row.id, outcome });
          return outcome;
        },
        (c, row, err) => this.auditRowFailure(c, row, err),
      );

      // PL-252: escalate → DM the newly assigned approver (the row's
      // assignee was updated by the transition); expire/stall → the
      // terminal handoff post, thread only. Skip → nothing sent — the
      // row was audited, not announced. Never a gate.
      if (this.notifier !== undefined) {
        for (const o of outcomes) {
          if (o.outcome === 'skipped') continue;
          try {
            if (o.outcome === 'escalated') {
              await this.notifier.notifyAssigned(client, o.requestId, {
                escalated: true,
              });
            } else {
              await this.notifier.notifyTerminal(client, o.requestId, o.outcome);
            }
          } catch {
            this.logger.warn({
              msg: 'pickup_notification_failed',
              tenant_id: job.tenantId,
              request_id: o.requestId,
              code: 'notifier_exception',
            });
          }
        }
      }
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
   * One due row. Attempt count first, then level L against ladder of
   * N rungs:
   *  - attempts >= ceiling → stall (terminal human handoff, AD-26's
   *    twin: the clock gave up, a person takes over — never approve)
   *  - L < N → escalate to rung L+1's approver with rung L+1's clock
   *  - L >= N → expire (AD-26: never approve)
   * A rung whose approver subject has no staff identity in this tenant
   * is a config gap — the row is skipped, audited, and deferred for
   * the next tick (fixing the mapping resumes it; the attempts count
   * bounds how long it can sit).
   */
  private async processRow(
    client: PoolClient,
    row: DueEscalationRow,
    ladder: EscalationLadder,
  ): Promise<'escalated' | 'expired' | 'skipped' | 'stalled'> {
    if (row.escalation_attempts >= this.opts.maxAttempts) {
      const result = await transitionPickupRequest(client, {
        requestId: row.id,
        action: 'stall',
        actor: WORKER_ACTOR,
        channel: 'worker',
      });
      if (!result.ok) {
        throw new Error(`stall transition refused: ${result.code}`);
      }
      await this.auditRow(
        client,
        row.id,
        'stalled:max_attempts',
        `escalation attempt ceiling (${this.opts.maxAttempts}) reached — in-person handoff required`,
      );
      return 'stalled';
    }

    const nextLevel = row.escalation_level + 1;
    const rung = ladder.rungs[nextLevel - 1];

    if (rung === undefined) {
      // The top of the ladder. Expiry terminates to in-person handling.
      const result = await transitionPickupRequest(client, {
        requestId: row.id,
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
        row.id,
        'skipped:approver_not_mapped',
        `rung ${nextLevel} approver ${rung.approverSubject} has no staff identity in this tenant`,
      );
      return 'skipped';
    }

    const escalateAt = new Date(Date.now() + rung.afterMinutes * 60_000);
    const result = await transitionPickupRequest(client, {
      requestId: row.id,
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

  /**
   * PL-258: a whole-tenant tick failure, audited where resolvable —
   * the tenant's own audit partition if a connection opens; the log
   * line stands alone if it cannot. Never throws: the audit must not
   * become the next tenant's failure.
   */
  private async auditTenantFailure(
    tenantId: string,
    message: string,
  ): Promise<void> {
    try {
      await withTenant(this.pool, tenantId, async (client) => {
        await insertTenantMcpAuditEntry(client, {
          requestId: 'worker-tenant-failure',
          actor: WORKER_ACTOR,
          role: null,
          httpMethod: 'WORKER',
          rpcMethod: 'escalation_tick',
          tool: null,
          argumentsRedacted: { detail: message },
          outcome: 'error:worker_tenant_failed',
          authMs: null,
          toolMs: null,
          totalMs: null,
        });
      });
    } catch (err) {
      this.logger.error({
        msg: 'audit_write_failed',
        tenant_id: tenantId,
        outcome: 'error:worker_tenant_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
 * Process entry — `npm run worker`. Loads each tenant's written ladder
 * from `<ESCALATION_LADDER_DIR>/<tenant_id>.json` for every
 * WORKER_TENANTS entry (a missing file is a boot refusal naming the
 * tenant and the path), then polls. Tenant ids come from WORKER_TENANTS
 * (comma-separated) — configuration, never a caller argument (Rule 7).
 */
async function runFromEnv(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const tenants = (process.env.WORKER_TENANTS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tenants.length === 0) {
    throw new Error(
      'WORKER_TENANTS is not set — the escalation worker refuses to start.',
    );
  }

  // The boot refusal: a worker missing any tenant's written ladder
  // does not start — the error names the tenant and its expected path.
  const ladders = await loadEscalationLaddersFromEnv(tenants);

  const pool = new Pool({
    connectionString: config.appDatabaseUrl,
    max: 4,
  });

  // The outbound surface is optional here too (PL-252): a worker with
  // no Slack config still climbs the ladder — the DMs are absent, and
  // that is logged once at boot rather than per row.
  const notifier =
    config.slackBotToken.length > 0 &&
    config.slackVisibilityChannel.length > 0 &&
    config.pickupReviewUrl.length > 0
      ? createPickupNotifier({
          slack: new WebApiSlackClient({ botToken: config.slackBotToken }),
          visibilityChannel: config.slackVisibilityChannel,
          link: config.pickupReviewUrl,
          logger,
        })
      : undefined;
  if (notifier === undefined) {
    logger.info({ msg: 'slack_notifications_disabled', reason: 'not_configured' });
  }

  const worker = new EscalationWorker(pool, logger, {
    jobs: tenants.map((tenantId) => {
      const ladder = ladders.get(tenantId);
      if (ladder === undefined) {
        throw new Error(`no escalation ladder for tenant ${tenantId}`);
      }
      return { tenantId, ladder };
    }),
    ...(process.env.ESCALATION_MAX_ATTEMPTS !== undefined &&
    process.env.ESCALATION_MAX_ATTEMPTS.length > 0
      ? { maxAttempts: Number(process.env.ESCALATION_MAX_ATTEMPTS) }
      : {}),
    ...(notifier !== undefined ? { notifier } : {}),
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
