import { type Pool } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import {
  getDecisionMetrics,
  type DecisionMetrics,
} from '../repositories/decision-metrics.js';
import { type Logger } from '../logging/logger.js';

/**
 * Decision-metrics emission (PL-211) — the runbook surface.
 *
 * Emits one structured line per tenant: median and p90 time-to-decision,
 * escalation rate, expiry rate, and the decision mix by approver. Run it
 * against a tenant to see how the approval path is actually performing.
 *
 * **The Alexa 500 ms budget does not govern this surface — say so
 * wherever these numbers are read.** Time-to-decision is measured in
 * minutes. A high escalation rate means routing is wrong; a high expiry
 * rate means the policy is wrong. Optimizing the wrong number is worse
 * than not measuring. (The operational runbook is on the deferred list —
 * operational readiness: runbook, on-call, failure playbook — unscoped
 * and overdue; this docstring is the interim home of the note.)
 *
 * The tenant comes from configuration in the runbook/ops tradition of
 * `SyncJob` — this is background/diagnostic infrastructure, not a
 * request-scoped argument (Rule 7).
 */

export interface MetricsJob {
  /** From configuration — which tenant to emit metrics for. */
  readonly tenantId: string;
}

export async function emitDecisionMetrics(
  pool: Pool,
  job: MetricsJob,
  logger: Logger,
): Promise<DecisionMetrics> {
  const metrics = await withTenant(pool, job.tenantId, (client) =>
    getDecisionMetrics(client),
  );

  // The line carries the numbers WITH their conditions — counts travel
  // with every rate and percentile — and nothing else: no scholar
  // identifiers, no request contents.
  logger.info({
    msg: 'decision_metrics',
    tenant_id: job.tenantId,
    total_requests: metrics.totalRequests,
    decided_count: metrics.decidedCount,
    escalated_count: metrics.escalatedCount,
    expired_count: metrics.expiredCount,
    escalation_rate: metrics.escalationRate,
    expiry_rate: metrics.expiryRate,
    median_seconds: metrics.medianSeconds,
    p90_seconds: metrics.p90Seconds,
    median_minutes: metrics.medianSeconds !== null ? metrics.medianSeconds / 60 : null,
    p90_minutes: metrics.p90Seconds !== null ? metrics.p90Seconds / 60 : null,
    decision_mix: metrics.decisionMix,
  });

  return metrics;
}
