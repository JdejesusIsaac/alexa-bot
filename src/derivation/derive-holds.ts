import { type CanonicalRow } from '../schema/canonical-row.js';
import { type DerivationRule } from '../repositories/derivation-rules.js';

/**
 * Pure hold-derivation engine (PL-012).
 *
 * Given a canonical row and a set of per-tenant derivation rules, derives
 * a hold when the row has no authoritative hold_type from the sheet.
 *
 * Rules:
 * 1. If `hold_type` is already non-null (authoritative from sheet mapping),
 *    the row is returned unchanged — authoritative holds take precedence.
 * 2. If `hold_type` is null, evaluate rules in order. The first matching
 *    rule sets `hold_type` to `derived_hold_type` and `hold_source` to
 *    `'derived'`.
 * 3. If no rule matches, the row is returned unchanged (no hold).
 *
 * Boolean fields (`missing_id`, `do_not_call`) are compared as string
 * `'true'`/`'false'` against `condition_value`, case-insensitively.
 * String fields are compared case-sensitively (exact match).
 *
 * This function is pure — no DB, no I/O. It runs at ingestion time
 * (after mapping, before DB insert), so `hold_source` is persisted on
 * the roster_entries row.
 */

function fieldValueToString(row: CanonicalRow, column: string): string | null {
  const value = (row as Record<string, unknown>)[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function deriveHolds(
  row: CanonicalRow,
  rules: readonly DerivationRule[],
): CanonicalRow {
  // Authoritative holds from the sheet take precedence over derivation.
  if (row.hold_type !== null) {
    return row;
  }

  for (const rule of rules) {
    const fieldValue = fieldValueToString(row, rule.condition_column);
    if (fieldValue === null) continue;

    const isBooleanField =
      rule.condition_column === 'missing_id' ||
      rule.condition_column === 'do_not_call';

    const matches = isBooleanField
      ? fieldValue.toLowerCase() === rule.condition_value.toLowerCase()
      : fieldValue === rule.condition_value;

    if (matches) {
      return {
        ...row,
        hold_type: rule.derived_hold_type,
        hold_source: 'derived',
      };
    }
  }

  return row;
}
