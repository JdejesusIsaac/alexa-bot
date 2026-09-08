/**
 * Synthetic fixtures for PL-011.
 *
 * Two campuses with different sheet headers, deliberately colliding student
 * names, dirty rows for PL-006 quarantine, and rows exercising every hold
 * and refusal case. The column shape mirrors the real HEMS attendance
 * tracker (§2e), including a populated advisor-notes column — so T-19 has
 * something to prove is excluded.
 *
 * Synthetic only. No real student names, refs, or data.
 */

export const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

export const TENANT_A_NAME = 'Campus Alpha';
export const TENANT_B_NAME = 'Campus Bravo';

// ── Column mappings per tenant ───────────────────────────────────────
// Each tenant uses different sheet headers for the same canonical fields,
// proving that explicit per-tenant mapping works (T-08).

export interface MappingSeed {
  sheetHeader: string;
  canonicalField: string;
}

export const TENANT_A_MAPPINGS: readonly MappingSeed[] = [
  { sheetHeader: 'ID', canonicalField: 'student_ref' },
  { sheetHeader: 'Scholar Name', canonicalField: 'student_name' },
  { sheetHeader: 'Homeroom', canonicalField: 'section' },
  { sheetHeader: 'Attendance', canonicalField: 'attendance_status' },
  { sheetHeader: 'Reason', canonicalField: 'reason_code' },
  { sheetHeader: 'Hold Type', canonicalField: 'hold_type' },
  { sheetHeader: 'Time In', canonicalField: 'release_time' },
  { sheetHeader: 'Hold Location', canonicalField: 'hold_location' },
  { sheetHeader: 'DO NOT CALL', canonicalField: 'do_not_call' },
  { sheetHeader: 'Missing ID', canonicalField: 'missing_id' },
];

export const TENANT_B_MAPPINGS: readonly MappingSeed[] = [
  { sheetHeader: 'Student #', canonicalField: 'student_ref' },
  { sheetHeader: 'Full Name', canonicalField: 'student_name' },
  { sheetHeader: 'Room', canonicalField: 'section' },
  { sheetHeader: 'Status', canonicalField: 'attendance_status' },
  { sheetHeader: 'Reason Code', canonicalField: 'reason_code' },
  { sheetHeader: 'Detention Type', canonicalField: 'hold_type' },
  { sheetHeader: 'Release', canonicalField: 'release_time' },
  { sheetHeader: 'Where', canonicalField: 'hold_location' },
  { sheetHeader: 'No Call', canonicalField: 'do_not_call' },
  { sheetHeader: 'ID Missing', canonicalField: 'missing_id' },
];

// ── Raw sheet data ────────────────────────────────────────────────────
// Mirrors the real tracker's column shape (§2e). Includes a populated
// advisor-notes column ("Notes") that must never enter a canonical row.
//
// Headers intentionally differ between tenants to exercise column mapping.
// Values are positionally aligned with headers.

export interface SheetRow {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export const TENANT_A_SHEET: SheetRow = {
  headers: [
    'ID',
    'Scholar Name',
    'Homeroom',
    'Advisor',
    'Attendance',
    'Uniform',
    'DO NOT CALL',
    'Notes',
    'Time In',
    'Reason',
    'Missing ID',
    'Absence Count',
    'Hold Type',
    'Hold Location',
  ],
  rows: [
    // Row 1 — colliding name "Jordan Smith", Tardy → derived detention
    ['A001', 'Jordan Smith', '101', 'Ms. Carter', 'Tardy', 'Pass', 'FALSE', 'Mom called re custody', '', 'Unexcused', 'FALSE', 'ExAbs: 1 | UnExAbs: 2', '', ''],
    // Row 2 — colliding name "Jordan Smith" (different student), Present, no hold
    ['A002', 'Jordan Smith', '102', 'Mr. Davis', 'Present', 'Pass', 'FALSE', '', '', '', 'FALSE', '', '', ''],
    // Row 3 — Absent with reason code, authoritative hold
    ['A003', 'Maria Gonzalez', '101', 'Ms. Carter', 'Absent', 'N/A', 'FALSE', 'Asthma flare, sent home', '', 'Excused W/O Notes', 'FALSE', 'ExAbs: 3 | UnExAbs: 0', 'Room 12', 'Front Office'],
    // Row 4 — do_not_call = TRUE, tests T-20 preservation
    ['A004', 'Tyler Nguyen', '103', 'Ms. Lopez', 'Tardy', 'Fail', 'TRUE', 'Custody restriction on file', '', 'Unexcused', 'TRUE', 'ExAbs: 0 | UnExAbs: 4', '', ''],
    // Row 5 — Dirty row: empty student_ref (should fail validation → quarantine)
    ['', 'Samuel Park', '102', 'Mr. Davis', 'Absent', 'Pass', 'FALSE', '', '', 'Unexcused', 'FALSE', '', '', ''],
    // Row 6 — Dirty row: empty student_name (should fail validation → quarantine)
    ['A006', '', '103', 'Ms. Lopez', 'Present', 'Pass', 'FALSE', '', '', '', 'FALSE', '', '', ''],
    // Row 7 — missing_id = TRUE, tests derived detention path
    ['A007', 'Aisha Mohammed', '101', 'Ms. Carter', 'Tardy', 'Pass', 'FALSE', '', '', 'Unexcused', 'TRUE', 'ExAbs: 2 | UnExAbs: 1', '', ''],
    // Row 8 — hold with release time
    ['A008', 'Devon Walker', '102', 'Mr. Davis', 'Absent', 'N/A', 'FALSE', '', '14:30', 'Excused W/O Notes', 'FALSE', 'ExAbs: 1 | UnExAbs: 0', 'Detention', 'Room 5'],
  ],
};

export const TENANT_B_SHEET: SheetRow = {
  headers: [
    'Student #',
    'Full Name',
    'Room',
    'Advisor',
    'Status',
    'Uniform',
    'No Call',
    'Notes',
    'Release',
    'Reason Code',
    'ID Missing',
    'Absence Count',
    'Detention Type',
    'Where',
  ],
  rows: [
    // Row 1 — colliding name "Jordan Smith" (tenant B), Absent
    ['B001', 'Jordan Smith', '201', 'Mr. Evans', 'Absent', 'N/A', 'FALSE', 'Family trip', '', 'Excused', 'FALSE', 'ExAbs: 2 | UnExAbs: 0', '', ''],
    // Row 2 — colliding name "Maria Gonzalez" (different from tenant A's), Tardy → derived
    ['B002', 'Maria Gonzalez', '202', 'Ms. Patel', 'Tardy', 'Pass', 'FALSE', '', '', 'Unexcused', 'FALSE', 'ExAbs: 0 | UnExAbs: 3', '', ''],
    // Row 3 — do_not_call = TRUE
    ['B003', 'Kevin Wright', '201', 'Mr. Evans', 'Present', 'Pass', 'TRUE', 'No contact per court order', '', '', 'FALSE', '', '', ''],
    // Row 4 — authoritative hold with release time and location
    ['B004', 'Priya Sharma', '202', 'Ms. Patel', 'Absent', 'N/A', 'FALSE', '', '15:00', 'Excused W/O Notes', 'FALSE', 'ExAbs: 4 | UnExAbs: 0', 'Detention', 'Library'],
    // Row 5 — Dirty row: empty student_ref
    ['', 'Liam Foster', '201', 'Mr. Evans', 'Tardy', 'Pass', 'FALSE', '', '', 'Unexcused', 'FALSE', '', '', ''],
    // Row 6 — Dirty row: empty student_name
    ['B006', '', '202', 'Ms. Patel', 'Present', 'Pass', 'FALSE', '', '', '', 'FALSE', '', '', ''],
    // Row 7 — missing_id = TRUE, derived detention
    ['B007', 'Olivia Brown', '201', 'Mr. Evans', 'Tardy', 'Fail', 'FALSE', '', '', 'Unexcused', 'TRUE', 'ExAbs: 1 | UnExAbs: 2', '', ''],
    // Row 8 — reason_code populated, no hold
    ['B008', 'Noah Garcia', '202', 'Ms. Patel', 'Absent', 'N/A', 'FALSE', 'Dental appointment', '', 'Excused', 'FALSE', 'ExAbs: 0 | UnExAbs: 1', '', ''],
  ],
};

// ── Derivation rules per tenant (PL-012 seeds) ─────────────────────────

export interface DerivationRuleSeed {
  ruleName: string;
  conditionColumn: string;
  conditionValue: string;
  derivedHoldType: string;
}

export const TENANT_A_DERIVATION_RULES: readonly DerivationRuleSeed[] = [
  { ruleName: 'tardy-detention', conditionColumn: 'attendance_status', conditionValue: 'Tardy', derivedHoldType: 'Detention' },
  { ruleName: 'missing-id-detention', conditionColumn: 'missing_id', conditionValue: 'true', derivedHoldType: 'Detention' },
];

export const TENANT_B_DERIVATION_RULES: readonly DerivationRuleSeed[] = [
  { ruleName: 'tardy-detention', conditionColumn: 'attendance_status', conditionValue: 'Tardy', derivedHoldType: 'Detention' },
  { ruleName: 'missing-id-detention', conditionColumn: 'missing_id', conditionValue: 'true', derivedHoldType: 'Detention' },
];

// ── Convenience: all fixture data in one structure ─────────────────────

export interface TenantFixture {
  tenantId: string;
  tenantName: string;
  mappings: readonly MappingSeed[];
  sheet: SheetRow;
  derivationRules: readonly DerivationRuleSeed[];
}

export const FIXTURES: readonly TenantFixture[] = [
  {
    tenantId: TENANT_A,
    tenantName: TENANT_A_NAME,
    mappings: TENANT_A_MAPPINGS,
    sheet: TENANT_A_SHEET,
    derivationRules: TENANT_A_DERIVATION_RULES,
  },
  {
    tenantId: TENANT_B,
    tenantName: TENANT_B_NAME,
    mappings: TENANT_B_MAPPINGS,
    sheet: TENANT_B_SHEET,
    derivationRules: TENANT_B_DERIVATION_RULES,
  },
];
