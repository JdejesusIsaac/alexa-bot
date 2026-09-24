/**
 * Disclosure policy — the single chokepoint (PL-106, AD-12/13/17).
 *
 * Two layers, both enforced here:
 *
 * 1. **Clearance (AD-12, default-deny).** Every canonical field maps to a
 *    clearance (`staff` / `admin` / `never`) in `FIELD_CLEARANCE`. A field
 *    with NO entry is `never` — a new column on the sheet cannot disclose
 *    itself through a tool. Responses are built by projection, never by
 *    handlers remembering to omit.
 *
 * 2. **Minimum field set (AD-17).** Clearance alone is insufficient — a
 *    cleared field still has to earn its place. Each tool declares the
 *    fewest fields that answer its question. Anything returned persists
 *    in the caller's conversation context and can be restated later to
 *    whoever is standing there, so a field that is merely cleared but not
 *    needed is a disclosure we chose to make permanent for no benefit.
 *
 * A field must pass BOTH gates to appear in a response: it must be in the
 * tool's minimum set AND cleared for the caller's role. Omission is
 * honest; a false value is a wrong answer about a student record (AD-13).
 */

import { type Role } from '../auth/identity.js';

export type Clearance = 'staff' | 'admin' | 'never';

/** Clearance for every field that can appear on a roster entry. Default-deny. */
export const FIELD_CLEARANCE: Readonly<Record<string, Clearance>> = {
  student_ref: 'staff',
  student_name: 'staff',
  section: 'staff',
  attendance_status: 'staff',
  // Sprint 2 review finding, closed by PL-210: the roster's reason code
  // is reason-adjacent free text — "the reason goes to a private channel"
  // (README). It was kept out of responses only by the minimum-set gate,
  // with clearance alone permitting it. Demoted to never; a future tool
  // that needs it requires a written decision, like every other widening.
  reason_code: 'never',
  hold_type: 'staff',
  hold_source: 'staff',
  release_time: 'staff',
  hold_location: 'staff',
  do_not_call: 'staff',
  // Ingestion/sync metadata — never a response field.
  missing_id: 'never',
  source_row_number: 'never',
  sync_id: 'never',
  tenant_id: 'never',
  id: 'never',
  student_id: 'never',
  service_date: 'never',

  // ── Sprint 3: pickup_requests (PL-210) ───────────────────────────────
  // The P3 decision: `reason_detail` is clearance `never` — written at
  // intake, read only in-app under a tenant context with an audit entry,
  // purged at terminal states. The category is the disclosable form.
  request_id: 'staff',
  state: 'staff',
  pickup_at: 'staff',
  reason_category: 'staff',
  reason_detail: 'never',
  escalation_level: 'staff',
  decided_at: 'staff',
  decided_by: 'staff',
  // Clock and lifecycle timestamps: internal until a tool earns them.
  escalate_at: 'never',
  released_at: 'never',
  completed_at: 'never',
  expired_at: 'never',
  created_at: 'never',
  // Internal references — uuids that resolve server-side only.
  assigned_approver_id: 'never',
  requested_by_contact_id: 'never',
  intake_channel: 'never',
};

/**
 * Minimum field sets per tool (AD-17). A response may contain exactly
 * these fields — nothing more, on success or refusal paths (T-45).
 */
export const TOOL_MINIMUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  lookup_scholar_status: [
    'student_ref',
    'student_name',
    'section',
    'hold_type',
    'hold_source',
    'release_time',
    'hold_location',
    'do_not_call',
  ],
  search_roster: [
    'student_ref',
    'student_name',
    'section',
    'attendance_status',
    'hold_type',
    'hold_source',
    'release_time',
    'hold_location',
    'do_not_call',
  ],
  roster_sync_status: [
    'last_sync_at',
    'last_outcome',
    'roster_age_minutes',
    'is_fresh',
    'quarantined',
  ],
  // ── Sprint 3: the request-lifecycle tools (PL-210 declares; PL-208
  // implements). Minimum sets exist before the tools so T-69/T-70 can
  // grade default-deny against the tables that carry the sensitive
  // content, not just the ones the policy was written for.
  create_pickup_request: ['request_id', 'state'],
  // The approver's queue: who, when, why (category — the disclosable
  // form), and how far up the ladder it has climbed.
  list_pending_approvals: [
    'request_id',
    'student_name',
    'pickup_at',
    'reason_category',
    'escalation_level',
  ],
  decide_pickup_request: ['request_id', 'state', 'decided_at'],
};

function isClearedForRole(clearance: Clearance, role: Role): boolean {
  if (clearance === 'never') return false;
  if (clearance === 'admin') return role === 'admin';
  return true; // 'staff' — both roles may read staff-cleared fields
}

/**
 * Project a row through the disclosure policy: copy only the tool's
 * minimum-set fields that are also cleared for the caller's role.
 *
 * A field absent from `FIELD_CLEARANCE` is `never` — it is dropped even
 * if someone added it to a minimum set by mistake (T-36).
 */
export function project<T extends Record<string, unknown>>(
  row: T,
  toolName: string,
  role: Role,
): Record<string, unknown> {
  const minimum = TOOL_MINIMUM_FIELDS[toolName];
  if (minimum === undefined) {
    // No tool is registered without a minimum set; failing closed anyway.
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const field of minimum) {
    const clearance = FIELD_CLEARANCE[field] ?? 'never';
    if (!isClearedForRole(clearance, role)) continue;
    if (field in row) {
      result[field] = row[field];
    }
  }
  return result;
}
