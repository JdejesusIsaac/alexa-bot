import { type PoolClient } from 'pg';

/**
 * Approver routing repository (PL-203) — the tribal-knowledge artifact.
 *
 * "Which leader for which grade, and who to try next" lives in operators'
 * heads at a campus with high turnover (F-15). The `approver_routing`
 * table is that knowledge, encoded. Resolution is:
 *
 *  - **most-specific-wins:** section > grade > default;
 *  - **total:** a `default` row is required per tenant, so every scholar
 *    resolves to exactly one approver — the loud failure happens at seed
 *    time (`assertApproverRoutingTotal`, T-59), not at 1:50 pm;
 *  - **deterministic:** no randomness and a total order — the same input
 *    always resolves to the same approver (T-58).
 *
 * One named approver, never a channel broadcast (AD-27).
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in the INSERT (Rule 7).
 */

export type RoutingScope = 'section' | 'grade' | 'default';

export interface RoutingRule {
  id: string;
  tenant_id: string;
  scope_type: RoutingScope;
  scope_value: string | null;
  approver_id: string;
  priority: number;
  created_at: Date;
}

/** Typed, loud failure for a tenant whose routing is not total (T-59). */
export class RoutingNotTotalError extends Error {
  constructor() {
    super(
      'approver routing is not total: this tenant has no default rule — ' +
        'a request could resolve to nobody',
    );
    this.name = 'RoutingNotTotalError';
  }
}

/**
 * Insert a routing rule. `scope_value` is required for section and grade
 * rules and must be absent for the default rule — the database check
 * constraint enforces the shape; this function mirrors it for clarity.
 */
export async function insertApproverRoutingRule(
  client: PoolClient,
  params: {
    scopeType: RoutingScope;
    /** The section or grade this rule matches. Omit for the default rule. */
    scopeValue?: string;
    approverId: string;
    priority?: number;
  },
): Promise<RoutingRule> {
  const res = await client.query<RoutingRule>(
    `insert into approver_routing
       (tenant_id, scope_type, scope_value, approver_id, priority)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)
     returning *`,
    [
      params.scopeType,
      params.scopeValue ?? null,
      params.approverId,
      params.priority ?? 0,
    ],
  );
  return res.rows[0]!;
}

/**
 * Assert the active tenant's routing is total — exactly one `default`
 * rule. Called at seed time so a tenant with no default fails loudly
 * here (T-59), not when the first unmatched request resolves to nobody.
 * Throws `RoutingNotTotalError`.
 */
export async function assertApproverRoutingTotal(client: PoolClient): Promise<void> {
  const res = await client.query<{ count: string }>(
    `select count(*)::text as count from approver_routing
     where scope_type = 'default'`,
  );
  const defaults = parseInt(res.rows[0]!.count, 10);
  if (defaults !== 1) {
    throw new RoutingNotTotalError();
  }
}

export interface ResolvedApprover {
  readonly approverId: string;
  readonly matchedScope: RoutingScope;
  /** The section or grade that matched; null for the default rule. */
  readonly scopeValue: string | null;
}

export type RoutingResolution =
  | { ok: true; resolution: ResolvedApprover }
  /**
   * `student_not_found` — the id is invisible in this tenant or
   * nonexistent, indistinguishable by design.
   * `routing_not_total` — no rule matched and no default exists. A
   * typed refusal, never a silent nobody: the caller degrades to a
   * human (Rule 10), which at 1:50 pm is the in-person handoff.
   */
  | { ok: false; code: 'student_not_found' | 'routing_not_total' };

/** Specificity ranking: section beats grade beats default. */
const SCOPE_RANK: Readonly<Record<RoutingScope, number>> = {
  section: 2,
  grade: 1,
  default: 0,
};

/**
 * Resolve the single approver for a scholar's pickup request (PL-203).
 *
 * Most specific match wins; the `default` rule makes resolution total.
 * Deterministic by construction: a scholar has one section and one
 * grade, the unique constraint allows one rule per (tenant, scope,
 * value), and the fallback ordering — priority descending, then scope
 * value ascending — is a total order even for scope types that could
 * someday match more than once.
 */
export async function resolveApproverForStudent(
  client: PoolClient,
  studentId: string,
): Promise<RoutingResolution> {
  const studentRes = await client.query<{ section: string | null; grade: string | null }>(
    `select section, grade from students where id = $1`,
    [studentId],
  );
  const student = studentRes.rows[0];
  if (student === undefined) {
    return { ok: false, code: 'student_not_found' };
  }

  const rulesRes = await client.query<{
    scope_type: RoutingScope;
    scope_value: string | null;
    approver_id: string;
    priority: number;
  }>(
    `select scope_type, scope_value, approver_id, priority from approver_routing
     where scope_type = 'default'
        or (scope_type = 'section' and scope_value = $1)
        or (scope_type = 'grade' and scope_value = $2)`,
    [student.section, student.grade],
  );

  if (rulesRes.rows.length === 0) {
    // The default rule matches unconditionally — reaching here means
    // there is none. Refuse loudly rather than resolve to nobody.
    return { ok: false, code: 'routing_not_total' };
  }

  const winner = rulesRes.rows
    .map((rule) => ({
      rule,
      rank: SCOPE_RANK[rule.scope_type],
    }))
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.rule.priority - a.rule.priority ||
        (a.rule.scope_value ?? '').localeCompare(b.rule.scope_value ?? ''),
    )[0]!;

  return {
    ok: true,
    resolution: {
      approverId: winner.rule.approver_id,
      matchedScope: winner.rule.scope_type,
      scopeValue: winner.rule.scope_value,
    },
  };
}
