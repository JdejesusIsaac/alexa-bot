/**
 * Ingestion pipeline (PL-006).
 *
 * Ties together: map → validate → derive → insert valid / quarantine invalid.
 *
 * The function accepts a `PoolClient` already scoped to a tenant via
 * `withTenant` — it never acquires its own connection (Rule 11) and never
 * accepts `tenant_id` as a parameter (Rule 7).
 *
 * Partial success is normal: 3 bad rows do not fail a 200-row sync. The
 * sync outcome is `partial-success` when any rows are quarantined, and
 * `success` when all rows are valid.
 *
 * Quarantined rows are stored with their source row number, raw data, and
 * a specific reason. They are never readable by the status lookup (PL-009)
 * because they live in `quarantined_rows`, not `roster_entries`.
 */

import { type PoolClient } from 'pg';
import { type ColumnMapping } from '../repositories/column-mappings.js';
import { type DerivationRule } from '../repositories/derivation-rules.js';
import { type SheetData } from '../connector/sheet-connector.js';
import { mapRow } from '../mapping/mapper.js';
import { MappingError } from '../schema/canonical-row.js';
import { validateRow } from '../validation/validate.js';
import { deriveHolds } from '../derivation/derive-holds.js';
import {
  createSync,
  finalizeSync,
  type RosterSync,
} from '../repositories/roster-syncs.js';
import { insertQuarantinedRow } from '../repositories/quarantined-rows.js';
import { insertEntry } from '../repositories/roster-entries.js';

export interface IngestResult {
  sync: RosterSync;
  rowsIn: number;
  rowsValid: number;
  rowsQuarantined: number;
  outcome: 'success' | 'partial-success';
}

/**
 * Ingest a sheet: map each row, validate, derive holds, insert valid rows
 * into `roster_entries`, quarantine invalid rows in `quarantined_rows`.
 *
 * @param client - PoolClient already scoped to a tenant via `withTenant`
 * @param sheetData - Raw sheet data from the connector
 * @param mappings - Per-tenant column mappings
 * @param derivationRules - Per-tenant hold derivation rules
 * @returns Sync result with counts and outcome
 */
export async function ingestSheet(
  client: PoolClient,
  sheetData: SheetData,
  mappings: readonly ColumnMapping[],
  derivationRules: readonly DerivationRule[],
): Promise<IngestResult> {
  const sync = await createSync(client);

  const { headers, rows } = sheetData;
  let rowsValid = 0;
  let rowsQuarantined = 0;

  for (let i = 0; i < rows.length; i++) {
    const values = rows[i]!;
    const rowNumber = i + 1;

    try {
      // 1. Map raw row → canonical row (Zod validation)
      const mapped = mapRow(headers, values, mappings, rowNumber);

      // 2. Semantic validation (time format, known codes)
      const validation = validateRow(mapped);
      if (!validation.valid) {
        await insertQuarantinedRow(client, {
          syncId: sync.id,
          sourceRowNumber: rowNumber,
          rawData: { headers: [...headers], values: [...values] },
          reason: validation.reason,
        });
        rowsQuarantined++;
        continue;
      }

      // 3. Derive holds (PL-012)
      const canonical = deriveHolds(mapped, derivationRules);

      // 4. Insert into roster_entries
      await insertEntry(client, {
        studentRef: canonical.student_ref,
        studentName: canonical.student_name,
        section: canonical.section,
        attendanceStatus: canonical.attendance_status,
        reasonCode: canonical.reason_code,
        holdType: canonical.hold_type,
        holdSource: canonical.hold_source,
        releaseTime: canonical.release_time,
        holdLocation: canonical.hold_location,
        doNotCall: canonical.do_not_call,
        missingId: canonical.missing_id,
        sourceRowNumber: canonical.source_row_number,
        syncId: sync.id,
      });
      rowsValid++;
    } catch (err) {
      // MappingError from Zod validation — quarantine with specific issues
      if (err instanceof MappingError) {
        const reason = err.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        await insertQuarantinedRow(client, {
          syncId: sync.id,
          sourceRowNumber: rowNumber,
          rawData: { headers: [...headers], values: [...values] },
          reason,
        });
        rowsQuarantined++;
      } else {
        // Unexpected error — re-throw. We don't quarantine unknown errors;
        // they indicate a bug, not a dirty row.
        throw err;
      }
    }
  }

  const rowsIn = rows.length;
  const outcome: 'success' | 'partial-success' =
    rowsQuarantined > 0 ? 'partial-success' : 'success';

  const finalizedSync = await finalizeSync(client, {
    syncId: sync.id,
    rowsIn,
    rowsValid,
    rowsQuarantined,
    outcome,
  });

  return {
    sync: finalizedSync,
    rowsIn,
    rowsValid,
    rowsQuarantined,
    outcome,
  };
}
