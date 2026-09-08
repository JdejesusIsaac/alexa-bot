import { type ColumnMapping } from '../repositories/column-mappings.js';
import {
  canonicalRowSchema,
  type CanonicalRow,
  MappingError,
  MAPPABLE_FIELDS,
} from '../schema/canonical-row.js';

/**
 * Pure mapper — transforms a raw sheet row into a validated canonical row
 * using per-tenant column mappings.
 *
 * No inference. Only columns with explicit mappings are processed (AD-6).
 * The advisor-notes column is excluded by omission: if no mapping row
 * exists for it, its value never enters a canonical row (§2e F-3).
 *
 * `hold_source` defaults to 'authoritative'. PL-012's derivation logic
 * may override it to 'derived' after mapping.
 * `source_row_number` is sync metadata, never mapped from a sheet column.
 */

const MAPPABLE_SET: ReadonlySet<string> = new Set(MAPPABLE_FIELDS);

function coerceBoolean(value: string | null): boolean {
  if (value === null) return false;
  return value.trim().toUpperCase() === 'TRUE';
}

function coerceNullableString(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Map a raw sheet row to a canonical row.
 *
 * @param headers - Sheet column headers (e.g. ["ID", "Scholar", "Attendance", ...])
 * @param values  - Raw cell values for one row, positionally aligned with headers
 * @param mappings - Per-tenant column mappings (sheet_header → canonical_field)
 * @param rowNumber - Source row number for audit and quarantine tracking
 * @returns Validated canonical row
 * @throws {MappingError} if the mapped row fails Zod validation
 */
export function mapRow(
  headers: readonly string[],
  values: readonly string[],
  mappings: readonly ColumnMapping[],
  rowNumber: number,
): CanonicalRow {
  const headerToField = new Map<string, string>();
  for (const m of mappings) {
    if (MAPPABLE_SET.has(m.canonical_field)) {
      headerToField.set(m.sheet_header, m.canonical_field);
    }
  }

  const raw: Record<string, unknown> = {
    hold_source: 'authoritative',
    source_row_number: rowNumber,
  };

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    const canonicalField = headerToField.get(header);
    if (canonicalField === undefined) continue;

    const value = i < values.length ? (values[i] ?? null) : null;

    if (canonicalField === 'do_not_call' || canonicalField === 'missing_id') {
      raw[canonicalField] = coerceBoolean(value);
    } else {
      raw[canonicalField] = coerceNullableString(value);
    }
  }

  const result = canonicalRowSchema.safeParse(raw);
  if (!result.success) {
    throw new MappingError(rowNumber, result.error.issues);
  }
  return result.data;
}
