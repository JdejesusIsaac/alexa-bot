import { type PoolClient } from 'pg';

/**
 * Derivation-rules repository.
 *
 * Per-tenant hold derivation config (PL-012). Detention is derived from
 * existing columns (Tardy, Missing ID) — not hardcoded logic. Each rule
 * specifies a condition column, condition value, and the hold type to
 * derive when the condition matches.
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in the INSERT (Rule 7).
 */

export interface DerivationRule {
  id: string;
  tenant_id: string;
  rule_name: string;
  condition_column: string;
  condition_value: string;
  derived_hold_type: string;
}

/**
 * Retrieve all derivation rules for the current tenant context.
 * RLS ensures only the active tenant's rules are visible.
 */
export async function findByTenant(
  client: PoolClient,
): Promise<DerivationRule[]> {
  const res = await client.query<DerivationRule>(
    `select * from derivation_rules order by rule_name`,
  );
  return res.rows;
}

/**
 * Insert a derivation rule. The tenant_id is set by RLS from the
 * `app.tenant_id` session variable — it is never passed as a value
 * in the INSERT, ensuring it cannot be forged.
 */
export async function insertRule(
  client: PoolClient,
  params: {
    ruleName: string;
    conditionColumn: string;
    conditionValue: string;
    derivedHoldType: string;
  },
): Promise<DerivationRule> {
  const res = await client.query<DerivationRule>(
    `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)
     returning *`,
    [
      params.ruleName,
      params.conditionColumn,
      params.conditionValue,
      params.derivedHoldType,
    ],
  );
  return res.rows[0]!;
}
