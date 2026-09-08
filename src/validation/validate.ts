/**
 * Row validation (PL-006).
 *
 * The Zod canonical schema (PL-004) catches structural issues: missing
 * required fields, wrong types. This module adds semantic validation that
 * Zod can't express: time format, known attendance statuses, known reason
 * codes.
 *
 * Each validation failure produces a specific human-readable reason stored
 * in `quarantined_rows.reason`. The reason is staff-facing diagnostic text —
 * it must never contain student data (Rule 6).
 *
 * Known value sets are intentionally permissive defaults. They can become
 * per-tenant config in a future sprint if campuses diverge.
 */

import type { CanonicalRow } from '../schema/canonical-row.js';

/**
 * Known attendance statuses. Campuses may use different labels in their
 * sheets, but the mapped canonical value must be one of these.
 */
const VALID_ATTENDANCE_STATUSES = new Set([
  'Present',
  'Absent',
  'Tardy',
  'Late',
  'Early Dismissal',
  'Excused',
  'Unexcused',
]);

/**
 * Known reason codes. Free-text reason codes from the sheet are mapped to
 * these canonical values. An unknown code means the sheet has a value the
 * system doesn't recognize — it should be quarantined for staff review.
 */
const VALID_REASON_CODES = new Set([
  'Excused',
  'Unexcused',
  'Excused W/O Notes',
]);

/**
 * Release time format: H:MM or HH:MM (24-hour). Allows single-digit hour
 * (e.g. "8:30") and double-digit (e.g. "14:30"). Does not validate the
 * actual time range (e.g. "25:99" passes the regex but is semantically
 * invalid — we check the range too).
 */
const TIME_FORMAT = /^(\d{1,2}):(\d{2})$/;

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validate a canonical row beyond the Zod schema.
 *
 * Checks:
 * 1. `release_time` — if non-null, must be HH:MM format with valid range
 * 2. `attendance_status` — if non-null, must be a known status
 * 3. `reason_code` — if non-null, must be a known reason code
 *
 * Returns `{ valid: true }` or `{ valid: false, reason }` with a specific
 * reason string for quarantine tracking.
 */
export function validateRow(row: CanonicalRow): ValidationResult {
  // 1. Release time format
  if (row.release_time !== null) {
    const match = TIME_FORMAT.exec(row.release_time);
    if (!match) {
      return {
        valid: false,
        reason: `invalid release_time format: "${row.release_time}" (expected HH:MM)`,
      };
    }
    const hours = parseInt(match[1]!, 10);
    const minutes = parseInt(match[2]!, 10);
    if (hours > 23 || minutes > 59) {
      return {
        valid: false,
        reason: `invalid release_time value: "${row.release_time}" (hours > 23 or minutes > 59)`,
      };
    }
  }

  // 2. Attendance status
  if (row.attendance_status !== null && !VALID_ATTENDANCE_STATUSES.has(row.attendance_status)) {
    return {
      valid: false,
      reason: `unknown attendance_status: "${row.attendance_status}"`,
    };
  }

  // 3. Reason code
  if (row.reason_code !== null && !VALID_REASON_CODES.has(row.reason_code)) {
    return {
      valid: false,
      reason: `unknown reason_code: "${row.reason_code}"`,
    };
  }

  return { valid: true };
}
