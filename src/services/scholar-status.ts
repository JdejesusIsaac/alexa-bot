/**
 * `getScholarStatus` — the core read (PL-009).
 *
 * Given a tenant-scoped connection and a student reference, returns hold
 * status, type, release time, location, `hold_source`, and `do_not_call`
 * — or a typed refusal.
 *
 * Refusal cases (T-15): roster stale · sync failed · student not found ·
 * row quarantined. Each is a distinct typed result; no case returns an
 * empty success (Rule 10).
 *
 * Every call — success or refusal — writes exactly one audit entry (T-16).
 *
 * Derived holds are staff-facing only (Rule 9). A parent-facing caller
 * never receives derived hold details; `toParentFacing` enforces this.
 *
 * The service accepts a `PoolClient` already scoped by `withTenant` —
 * it never acquires its own connection and never receives `tenant_id`
 * as an argument (Rule 7).
 */

import { type PoolClient } from 'pg';
import { isRosterFresh, findLatestSync } from '../repositories/roster-syncs.js';
import { findByStudentRef, type RosterEntry } from '../repositories/roster-entries.js';
import { findByTenant as findMappings } from '../repositories/column-mappings.js';
import { existsByStudentRef } from '../repositories/quarantined-rows.js';
import { insertAuditEntry } from '../repositories/audit-log.js';
import { toParentFacing } from '../derivation/parent-facing.js';

export type CallerType = 'staff' | 'parent';

export type ScholarStatusResult =
  | {
      kind: 'success';
      student_ref: string;
      student_name: string;
      section: string | null;
      attendance_status: string | null;
      reason_code: string | null;
      hold_type: string | null;
      hold_source?: 'derived' | 'authoritative';
      release_time: string | null;
      hold_location: string | null;
      do_not_call: boolean;
    }
  | {
      kind: 'refusal';
      reason: 'roster_stale' | 'sync_failed' | 'student_not_found' | 'row_quarantined';
    };

export interface ScholarStatusRequest {
  /** The student reference to look up. */
  readonly studentRef: string;
  /** Who is calling — staff sees all fields, parent sees filtered output. */
  readonly caller: CallerType;
  /** Authenticated actor identity, for the audit entry. */
  readonly actor: string;
  /** Freshness threshold in minutes (from config). */
  readonly freshnessMinutes: number;
}

const STAFF_FIELDS = [
  'student_ref',
  'student_name',
  'section',
  'attendance_status',
  'reason_code',
  'hold_type',
  'hold_source',
  'release_time',
  'hold_location',
  'do_not_call',
] as const;

const PARENT_FIELDS = [
  'student_ref',
  'student_name',
  'section',
  'attendance_status',
  'hold_type',
  'hold_source',
  'release_time',
  'hold_location',
] as const;

/**
 * Look up a scholar's status. The `client` must already be scoped to a
 * tenant via `withTenant` — the service never derives the tenant itself.
 */
export async function getScholarStatus(
  client: PoolClient,
  request: ScholarStatusRequest,
): Promise<ScholarStatusResult> {
  const { studentRef, caller, actor, freshnessMinutes } = request;

  // 1. Freshness check — is the roster current enough to answer?
  const fresh = await isRosterFresh(client, freshnessMinutes);
  if (!fresh) {
    // Distinguish "sync failed" from "roster stale." If the latest sync
    // attempt failed (and there's no fresh successful sync to fall back
    // on), report sync_failed — more actionable than just "stale."
    const latestSync = await findLatestSync(client);
    const reason =
      latestSync && latestSync.outcome === 'failure'
        ? 'sync_failed'
        : 'roster_stale';

    await insertAuditEntry(client, {
      actor,
      action: 'getScholarStatus',
      subjectStudentRef: studentRef,
      fieldsDisclosed: [],
      outcome: reason,
    });

    return { kind: 'refusal', reason };
  }

  // 2. Look up the student in roster_entries.
  const entry = await findByStudentRef(client, studentRef);
  if (!entry) {
    // 3. Not in roster_entries — check if the row was quarantined.
    //    We need the tenant's sheet header for student_ref to search
    //    the raw_data jsonb in quarantined_rows.
    const mappings = await findMappings(client);
    const studentRefHeader = mappings.find(
      (m) => m.canonical_field === 'student_ref',
    )?.sheet_header;

    let quarantined = false;
    if (studentRefHeader) {
      quarantined = await existsByStudentRef(client, studentRef, studentRefHeader);
    }

    const reason = quarantined ? 'row_quarantined' : 'student_not_found';

    await insertAuditEntry(client, {
      actor,
      action: 'getScholarStatus',
      subjectStudentRef: studentRef,
      fieldsDisclosed: [],
      outcome: reason,
    });

    return { kind: 'refusal', reason };
  }

  // 4. Student found — build the response, filtering for parent if needed.
  const result = buildResult(entry, caller);

  // Determine which fields were actually disclosed for the audit entry.
  let fieldsDisclosed: readonly string[];
  if (caller === 'staff') {
    fieldsDisclosed = STAFF_FIELDS;
  } else if (
    result.kind === 'success' &&
    (result.hold_type !== null || result.hold_source === 'authoritative')
  ) {
    fieldsDisclosed = PARENT_FIELDS;
  } else {
    // Parent path with derived hold blocked — hold fields not disclosed.
    fieldsDisclosed = PARENT_FIELDS.filter(
      (f) =>
        f !== 'hold_type' &&
        f !== 'hold_source' &&
        f !== 'release_time' &&
        f !== 'hold_location',
    );
  }

  await insertAuditEntry(client, {
    actor,
    action: 'getScholarStatus',
    subjectStudentRef: studentRef,
    fieldsDisclosed: [...fieldsDisclosed],
    outcome: 'success',
  });

  return result;
}

/**
 * Build the success result from a roster entry, applying parent-facing
 * filtering for derived holds (Rule 9).
 */
function buildResult(
  entry: RosterEntry,
  caller: CallerType,
): ScholarStatusResult {
  if (caller === 'staff') {
    return {
      kind: 'success',
      student_ref: entry.student_ref,
      student_name: entry.student_name,
      section: entry.section,
      attendance_status: entry.attendance_status,
      reason_code: entry.reason_code,
      hold_type: entry.hold_type,
      hold_source: entry.hold_source,
      release_time: entry.release_time,
      hold_location: entry.hold_location,
      do_not_call: entry.do_not_call,
    };
  }

  // Parent caller — filter derived holds via toParentFacing.
  const hold = toParentFacing(entry);

  if (hold.kind === 'refusal') {
    // Derived hold — block all hold info from the parent.
    // Don't disclose hold_source either: revealing 'derived' implies
    // there IS a hold, which is the information we're withholding.
    // Omit the field entirely rather than returning a false value.
    return {
      kind: 'success',
      student_ref: entry.student_ref,
      student_name: entry.student_name,
      section: entry.section,
      attendance_status: entry.attendance_status,
      reason_code: null,
      hold_type: null,
      release_time: null,
      hold_location: null,
      do_not_call: false,
    };
  }

  // Authoritative hold or no hold — return hold info to the parent.
  return {
    kind: 'success',
    student_ref: entry.student_ref,
    student_name: entry.student_name,
    section: entry.section,
    attendance_status: entry.attendance_status,
    reason_code: null,
    hold_type: hold.hold_type,
    hold_source: entry.hold_source,
    release_time: hold.release_time,
    hold_location: hold.hold_location,
    do_not_call: false,
  };
}
