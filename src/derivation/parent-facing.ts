import { type RosterEntry } from '../repositories/roster-entries.js';

/**
 * Parent-facing hold filter (PL-012, Rule 9).
 *
 * A derived hold is an inference — staff may have waived the detention.
 * Derived holds are staff-facing only and must never reach a parent-facing
 * surface. This is enforced in code, not by convention.
 *
 * PL-009's `getScholarStatus` will call `toParentFacing` before returning
 * a hold to a parent-facing caller. Staff-facing callers receive the raw
 * roster entry directly.
 */

export type ParentFacingHold =
  | {
      kind: 'hold';
      hold_type: string | null;
      release_time: string | null;
      hold_location: string | null;
    }
  | {
      kind: 'refusal';
      reason: 'derived_hold_staff_only';
    };

/**
 * Convert a roster entry to a parent-facing hold result.
 *
 * If the hold is derived (`hold_source === 'derived'`), returns a typed
 * refusal — never the hold details. If the hold is authoritative, returns
 * the hold information.
 *
 * If the entry has no hold_type at all, returns a hold with null fields
 * (no active hold) — this is a valid success, not a refusal.
 */
export function toParentFacing(entry: RosterEntry): ParentFacingHold {
  if (entry.hold_source === 'derived') {
    return { kind: 'refusal', reason: 'derived_hold_staff_only' };
  }

  return {
    kind: 'hold',
    hold_type: entry.hold_type,
    release_time: entry.release_time,
    hold_location: entry.hold_location,
  };
}
