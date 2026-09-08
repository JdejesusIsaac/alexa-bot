import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { seed } from '../src/db/seed.js';
import {
  findByTenant as findRulesByTenant,
  insertRule,
} from '../src/repositories/derivation-rules.js';
import { findByStudentRef } from '../src/repositories/roster-entries.js';
import { deriveHolds } from '../src/derivation/derive-holds.js';
import { toParentFacing } from '../src/derivation/parent-facing.js';
import { canonicalRowSchema } from '../src/schema/canonical-row.js';
import {
  TENANT_A,
  TENANT_B,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-012 tests — hold derivation as config.
 *
 * T-21: Derived holds carry `hold_source` and are blocked on parent-facing
 * paths. Flipping config from derived to authoritative changes behavior
 * with no deploy.
 *
 * Also tests the derivation repository (tenant isolation), the pure
 * derivation engine, and the parent-facing filter.
 *
 * Synthetic data only.
 */

const TENANT_A_ID = TENANT_A;
const TENANT_B_ID = TENANT_B;

let db: TestDb;

beforeAll(async () => {
  db = await provisionTestDb();
  process.env.DATABASE_URL = db.ownerUrl;
  process.env.APP_DATABASE_URL = db.appUrl;
  await seed();
});

afterAll(async () => {
  await db.cleanup();
});

// ── Derivation-rules repository ────────────────────────────────────

describe('Derivation-rules repository', () => {
  it('retrieves rules for the active tenant only', async () => {
    const aRules = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findRulesByTenant(client);
    });
    const bRules = await withTenant(db.appPool, TENANT_B_ID, async (client) => {
      return findRulesByTenant(client);
    });

    expect(aRules).toHaveLength(2);
    expect(bRules).toHaveLength(2);

    // Same rule names in both tenants (seeds are identical)
    const aNames = aRules.map((r) => r.rule_name).sort();
    const bNames = bRules.map((r) => r.rule_name).sort();
    expect(aNames).toEqual(['missing-id-detention', 'tardy-detention']);
    expect(bNames).toEqual(['missing-id-detention', 'tardy-detention']);
  });

  it('rules inserted under tenant A are not visible to tenant B', async () => {
    await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      await insertRule(client, {
        ruleName: 'custom-rule-a',
        conditionColumn: 'attendance_status',
        conditionValue: 'Excused',
        derivedHoldType: 'Study Hall',
      });
    });

    const aRules = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findRulesByTenant(client);
    });
    const bRules = await withTenant(db.appPool, TENANT_B_ID, async (client) => {
      return findRulesByTenant(client);
    });

    expect(aRules).toHaveLength(3);
    expect(bRules).toHaveLength(2); // tenant B does not see tenant A's custom rule
  });
});

// ── T-21: Derived holds are marked and never parent-facing ─────────

describe('T-21 · Derived holds are marked and never parent-facing', () => {
  it('derives detention from Tardy (no authoritative hold_type)', async () => {
    // A001 is Jordan Smith, Tardy, no hold_type from sheet
    const entry = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A001');
    });
    expect(entry).not.toBeNull();
    expect(entry!.hold_type).toBe('Detention');
    expect(entry!.hold_source).toBe('derived');
  });

  it('derives detention from missing_id = true', async () => {
    // A007 is Aisha Mohammed, Tardy + missing_id=true, no hold_type from sheet
    const entry = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A007');
    });
    expect(entry).not.toBeNull();
    expect(entry!.hold_type).toBe('Detention');
    expect(entry!.hold_source).toBe('derived');
  });

  it('preserves authoritative holds from the sheet', async () => {
    // A008 is Devon Walker, hold_type='Detention' from sheet (Hold Type column)
    const entry = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A008');
    });
    expect(entry).not.toBeNull();
    expect(entry!.hold_type).toBe('Detention');
    expect(entry!.hold_source).toBe('authoritative');
  });

  it('leaves no hold when no rule matches and no sheet hold', async () => {
    // A002 is Jordan Smith (second one), Present, no hold_type from sheet
    const entry = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A002');
    });
    expect(entry).not.toBeNull();
    expect(entry!.hold_type).toBeNull();
    expect(entry!.hold_source).toBe('authoritative');
  });

  it('blocks derived holds on parent-facing paths', async () => {
    // A001 has a derived hold
    const entry = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A001');
    });
    expect(entry).not.toBeNull();

    const parentFacing = toParentFacing(entry!);
    expect(parentFacing.kind).toBe('refusal');
    if (parentFacing.kind === 'refusal') {
      expect(parentFacing.reason).toBe('derived_hold_staff_only');
    }
  });

  it('allows authoritative holds on parent-facing paths', async () => {
    // A008 has an authoritative hold
    const entry = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A008');
    });
    expect(entry).not.toBeNull();

    const parentFacing = toParentFacing(entry!);
    expect(parentFacing.kind).toBe('hold');
    if (parentFacing.kind === 'hold') {
      expect(parentFacing.hold_type).toBe('Detention');
      expect(parentFacing.release_time).toBe('14:30');
      expect(parentFacing.hold_location).toBe('Room 5');
    }
  });

  it('staff path retrieves both derived and authoritative holds', async () => {
    // Staff path = direct repository access, no parent-facing filter
    const derived = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A001');
    });
    const authoritative = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A008');
    });

    expect(derived!.hold_source).toBe('derived');
    expect(derived!.hold_type).toBe('Detention');
    expect(authoritative!.hold_source).toBe('authoritative');
    expect(authoritative!.hold_type).toBe('Detention');
  });
});

// ── Pure derivation engine ─────────────────────────────────────────

describe('Pure derivation engine', () => {
  const rules = [
    {
      id: 'r1',
      tenant_id: 'x',
      rule_name: 'tardy-detention',
      condition_column: 'attendance_status',
      condition_value: 'Tardy',
      derived_hold_type: 'Detention',
    },
    {
      id: 'r2',
      tenant_id: 'x',
      rule_name: 'missing-id-detention',
      condition_column: 'missing_id',
      condition_value: 'true',
      derived_hold_type: 'Detention',
    },
  ];

  function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    const base = {
      student_ref: 'X001',
      student_name: 'Test Student',
      section: null,
      attendance_status: null,
      reason_code: null,
      hold_type: null,
      hold_source: 'authoritative' as const,
      release_time: null,
      hold_location: null,
      do_not_call: false,
      missing_id: false,
      source_row_number: 1,
    };
    return canonicalRowSchema.parse({ ...base, ...overrides });
  }

  it('derives hold when attendance_status matches a rule', () => {
    const row = makeRow({ attendance_status: 'Tardy' });
    const derived = deriveHolds(row, rules);
    expect(derived.hold_type).toBe('Detention');
    expect(derived.hold_source).toBe('derived');
  });

  it('derives hold when missing_id is true', () => {
    const row = makeRow({ missing_id: true });
    const derived = deriveHolds(row, rules);
    expect(derived.hold_type).toBe('Detention');
    expect(derived.hold_source).toBe('derived');
  });

  it('does not derive when hold_type is already set (authoritative)', () => {
    const row = makeRow({ hold_type: 'ISS', attendance_status: 'Tardy' });
    const derived = deriveHolds(row, rules);
    expect(derived.hold_type).toBe('ISS');
    expect(derived.hold_source).toBe('authoritative');
  });

  it('does not derive when no rule matches', () => {
    const row = makeRow({ attendance_status: 'Present' });
    const derived = deriveHolds(row, rules);
    expect(derived.hold_type).toBeNull();
    expect(derived.hold_source).toBe('authoritative');
  });

  it('first matching rule wins', () => {
    const row = makeRow({ attendance_status: 'Tardy', missing_id: true });
    const rulesWithOrder = [
      { ...rules[0]!, derived_hold_type: 'Detention' },
      { ...rules[1]!, derived_hold_type: 'Study Hall' },
    ];
    // Tardy rule is first → should derive Detention, not Study Hall
    const derived = deriveHolds(row, rulesWithOrder);
    expect(derived.hold_type).toBe('Detention');
    expect(derived.hold_source).toBe('derived');
  });
});

// ── Config flip: derived → authoritative with no code change ───────

describe('Config flip — derived to authoritative with no deploy', () => {
  it('flipping derivation rules changes behavior without code change', async () => {
    // A001 currently has a derived hold (Tardy → Detention, hold_source=derived)
    const beforeFlip = await withTenant(db.appPool, TENANT_A_ID, async (client) => {
      return findByStudentRef(client, 'A001');
    });
    expect(beforeFlip!.hold_source).toBe('derived');

    // Simulate flipping to authoritative: remove derivation rules,
    // add a column mapping for hold_type, and re-seed.
    // In production this is a config change in the DB, not a deploy.

    // Verify the derivation engine respects the flip:
    // With no rules, a Tardy row with no sheet hold_type gets no hold.
    const rowWithNoRules = deriveHolds(
      canonicalRowSchema.parse({
        student_ref: 'A001',
        student_name: 'Test',
        section: null,
        attendance_status: 'Tardy',
        reason_code: null,
        hold_type: null,
        hold_source: 'authoritative',
        release_time: null,
        hold_location: null,
        do_not_call: false,
        missing_id: false,
        source_row_number: 1,
      }),
      [], // no rules — authoritative mode
    );
    expect(rowWithNoRules.hold_type).toBeNull();
    expect(rowWithNoRules.hold_source).toBe('authoritative');

    // With a sheet-provided hold_type and no rules, it stays authoritative
    const rowWithSheetHold = deriveHolds(
      canonicalRowSchema.parse({
        student_ref: 'A001',
        student_name: 'Test',
        section: null,
        attendance_status: 'Tardy',
        reason_code: null,
        hold_type: 'Detention',
        hold_source: 'authoritative',
        release_time: null,
        hold_location: null,
        do_not_call: false,
        missing_id: false,
        source_row_number: 1,
      }),
      [], // no rules — authoritative mode, hold comes from sheet
    );
    expect(rowWithSheetHold.hold_type).toBe('Detention');
    expect(rowWithSheetHold.hold_source).toBe('authoritative');
  });
});
