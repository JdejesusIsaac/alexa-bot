/**
 * Ingestion pipeline (PL-006).
 *
 * Ties together: map → validate → derive → resolve student → insert valid / quarantine invalid.
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
import { upsertStudent } from '../repositories/students.js';
import { todayServiceDate } from '../util/service-date.js';

export interface IngestResult {
  sync: RosterSync;
  rowsIn: number;
  rowsValid: number;
  rowsQuarantined: number;
  outcome: 'success' | 'partial-success';
}

/**
 * Options for an ingest run. `serviceDate` is the school day the sheet
 * belongs to — a sync without a date is today's set (PL-201). Tests pass
 * fixed dates for determinism.
 */
export interface IngestOptions {
  readonly serviceDate?: string;
}

/**
 * Ingest a sheet: map each row, validate, derive holds, resolve the
 * student registry, insert valid rows into `roster_entries` for the
 * service date, quarantine invalid rows in `quarantined_rows`.
 *
 * Every valid row links to `students` — an absent `student_ref` is
 * inserted, never skipped (T-51).
 *
 * @param client - PoolClient already scoped to a tenant via `withTenant`
 * @param sheetData - Raw sheet data from the connector
 * @param mappings - Per-tenant column mappings
 * @param derivationRules - Per-tenant hold derivation rules
 * @param options - Optional service date; defaults to today
 * @returns Sync result with counts and outcome
 */
export async function ingestSheet(
  client: PoolClient,
  sheetData: SheetData,
  mappings: readonly ColumnMapping[],
  derivationRules: readonly DerivationRule[],
  options?: IngestOptions,
): Promise<IngestResult> {
  const serviceDate = options?.serviceDate ?? todayServiceDate();
  const sync = await createSync(client, serviceDate);

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

      // 4. Resolve the student registry — insert when absent, link the
      //    roster row to the student (T-51)
      const student = await upsertStudent(client, {
        studentRef: canonical.student_ref,
        studentName: canonical.student_name,
        section: canonical.section,
      });

      // 5. Insert into roster_entries for the service date
      await insertEntry(client, {
        serviceDate,
        studentId: student.id,
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
