import { type PoolClient } from 'pg';

/**
 * Decision metrics repository (PL-211) — the sprint's governing SLO.
 *
 * Time-to-decision is the interval from `routed` to a recorded decision
 * (glossary, §9): the leader's judgment speed, which is what the
 * approval path exists to improve. Median and p90 come from
 * PostgreSQL's ordered-set aggregates (`percentile_cont`) — computed in
 * the database, not shipped to the app for sorting.
 *
 * **The Alexa 500 ms budget does not govern this surface.** This SLO is
 * measured in minutes; a high escalation rate means routing is wrong,
 * a high expiry rate means the policy is wrong (plan, PL-211). Nobody
 * should optimize the wrong number.
 *
 * All queries are reads — `state` is never written here (T-55). RLS
 * scopes everything to the active tenant; the counts travel with the
 * numbers so a measurement always carries its conditions (E2: a number
 * without its sample size is not a result).
 */

export type DecisionType = 'approved' | 'flagged' | 'denied';

export interface ApproverDecisionMix {
  readonly approver: string;
  readonly decision: DecisionType;
  readonly count: number;
}

export interface DecisionMetrics {
  /** Every request the tenant has recorded, any state. */
  readonly totalRequests: number;
  /** Requests with a recorded human decision (decided_at set). */
  readonly decidedCount: number;
  readonly escalatedCount: number;
  readonly expiredCount: number;
  /** escalated / total — high means routing is wrong. */
  readonly escalationRate: number;
  /** expired / total — high means the policy is wrong. */
  readonly expiryRate: number;
  /** Median routed → decided, in seconds; null when nothing is decided yet. */
  readonly medianSeconds: number | null;
  /** p90 routed → decided, in seconds (interpolated, as percentile_cont is). */
  readonly p90Seconds: number | null;
  /** Decisions grouped by the audit subject that made them. */
  readonly decisionMix: readonly ApproverDecisionMix[];
}

export async function getDecisionMetrics(client: PoolClient): Promise<DecisionMetrics> {
  const countsRes = await client.query<{
    total: number;
    escalated: number;
    expired: number;
    decided: number;
  }>(
    `select count(*)::int as total,
            count(*) filter (where escalation_level > 0)::int as escalated,
            count(*) filter (where state = 'expired')::int as expired,
            count(*) filter (where decided_at is not null)::int as decided
     from pickup_requests`,
  );
  const counts = countsRes.rows[0]!;

  const timesRes = await client.query<{
    median_seconds: number | null;
    p90_seconds: number | null;
    decided_count: number;
  }>(
    `select (percentile_cont(0.5) within group (
              order by extract(epoch from (pr.decided_at - e.created_at))))::float8 as median_seconds,
            (percentile_cont(0.9) within group (
              order by extract(epoch from (pr.decided_at - e.created_at))))::float8 as p90_seconds,
            count(*)::int as decided_count
     from pickup_requests pr
     join pickup_request_events e
       on e.request_id = pr.id and e.event_type = 'routed'
     where pr.decided_at is not null`,
  );
  const times = timesRes.rows[0]!;

  const mixRes = await client.query<{
    approver: string;
    decision: DecisionType;
    count: number;
  }>(
    `select decided_by as approver,
            case when state in ('approved', 'released', 'completed') then 'approved'
                 when state = 'denied' then 'denied'
                 when state = 'flagged' then 'flagged' end as decision,
            count(*)::int as count
     from pickup_requests
     where decided_at is not null and decided_by is not null
     group by decided_by, decision
     order by decided_by asc, decision asc`,
  );

  const total = counts.total;
  return {
    totalRequests: total,
    decidedCount: counts.decided,
    escalatedCount: counts.escalated,
    expiredCount: counts.expired,
    escalationRate: total > 0 ? counts.escalated / total : 0,
    expiryRate: total > 0 ? counts.expired / total : 0,
    medianSeconds: times.median_seconds,
    p90Seconds: times.p90_seconds,
    decisionMix: mixRes.rows,
  };
}
