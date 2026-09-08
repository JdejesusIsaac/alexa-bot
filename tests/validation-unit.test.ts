import { describe, expect, it } from 'vitest';
import { validateRow } from '../src/validation/validate.js';
import { canonicalRowSchema, type CanonicalRow } from '../src/schema/canonical-row.js';

/**
 * PL-006 — validateRow unit tests (no DB needed).
 *
 * Tests the semantic validation layer that runs after Zod mapping:
 * time format, known attendance statuses, known reason codes.
 */

function makeCanonicalRow(overrides: Partial<CanonicalRow> = {}): CanonicalRow {
  return canonicalRowSchema.parse({
    student_ref: 'T001',
    student_name: 'Test Student',
    section: null,
    attendance_status: null,
    reason_code: null,
    hold_type: null,
    hold_source: 'authoritative',
    release_time: null,
    hold_location: null,
    do_not_call: false,
    missing_id: false,
    source_row_number: 1,
    ...overrides,
  });
}

describe('PL-006 · validateRow (unit)', () => {
  it('accepts a valid row with all fields populated', () => {
    const row = makeCanonicalRow({
      attendance_status: 'Present',
      reason_code: 'Excused',
      release_time: '14:30',
    });
    expect(validateRow(row)).toEqual({ valid: true });
  });

  it('accepts a row with all nullable fields null', () => {
    const row = makeCanonicalRow();
    expect(validateRow(row)).toEqual({ valid: true });
  });

  it('rejects a malformed release_time (not HH:MM)', () => {
    const row = makeCanonicalRow({ release_time: 'not-a-time' });
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toContain('release_time');
  });

  it('rejects a release_time with hours > 23', () => {
    const row = makeCanonicalRow({ release_time: '25:30' });
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toContain('release_time');
  });

  it('rejects a release_time with minutes > 59', () => {
    const row = makeCanonicalRow({ release_time: '14:99' });
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toContain('release_time');
  });

  it('accepts a valid single-digit hour release_time', () => {
    const row = makeCanonicalRow({ release_time: '8:30' });
    expect(validateRow(row)).toEqual({ valid: true });
  });

  it('rejects an unknown attendance_status', () => {
    const row = makeCanonicalRow({ attendance_status: 'Teleported' });
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toContain('attendance_status');
    expect(result.valid === false && result.reason).toContain('Teleported');
  });

  it('rejects an unknown reason_code', () => {
    const row = makeCanonicalRow({ reason_code: 'Alien Abduction' });
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toContain('reason_code');
    expect(result.valid === false && result.reason).toContain('Alien Abduction');
  });

  it('accepts all known attendance statuses', () => {
    for (const status of ['Present', 'Absent', 'Tardy', 'Late', 'Early Dismissal', 'Excused', 'Unexcused']) {
      const row = makeCanonicalRow({ attendance_status: status });
      expect(validateRow(row)).toEqual({ valid: true });
    }
  });

  it('accepts all known reason codes', () => {
    for (const code of ['Excused', 'Unexcused', 'Excused W/O Notes']) {
      const row = makeCanonicalRow({ reason_code: code });
      expect(validateRow(row)).toEqual({ valid: true });
    }
  });
});
