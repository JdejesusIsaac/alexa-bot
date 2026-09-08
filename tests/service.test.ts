import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { runSync, type SyncJob } from '../src/sync/scheduler.js';
import { FixtureSheetConnector } from '../src/connector/fixture-sheet-connector.js';
import { getScholarStatus, type ScholarStatusResult } from '../src/services/scholar-status.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_MAPPINGS,
  TENANT_B_MAPPINGS,
  TENANT_A_DERIVATION_RULES,
  TENANT_B_DERIVATION_RULES,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-009 — getScholarStatus service (DB integration tests).
 *
 * T-14: Happy path — fresh roster, valid student, derived detention.
 * T-15: Four refusals are distinguishable (stale, sync_failed, not_found, quarantined).
 * T-16: Every read is audited — one entry per call, success or refusal.
 * T-18: getScholarStatus p95 ≤150 ms.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

let db: TestDb;

beforeAll(async () => {
  db = await provisionTestDb();

  // Seed tenants, column mappings, and derivation rules for both tenants.
  const owner = await db.ownerPool.connect();
  try {
    await owner.query(
      `insert into tenants (id, name) values ($1, 'Campus Alpha'), ($2, 'Campus Bravo')`,
      [TENANT_A, TENANT_B],
    );

    for (const m of TENANT_A_MAPPINGS) {
      await owner.query(
        `insert into column_mappings (tenant_id, sheet_header, canonical_field) values ($1, $2, $3)`,
        [TENANT_A, m.sheetHeader, m.canonicalField],
      );
    }
    for (const m of TENANT_B_MAPPINGS) {
      await owner.query(
        `insert into column_mappings (tenant_id, sheet_header, canonical_field) values ($1, $2, $3)`,
        [TENANT_B, m.sheetHeader, m.canonicalField],
      );
    }
    for (const r of TENANT_A_DERIVATION_RULES) {
      await owner.query(
        `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type) values ($1, $2, $3, $4, $5)`,
        [TENANT_A, r.ruleName, r.conditionColumn, r.conditionValue, r.derivedHoldType],
      );
    }
    for (const r of TENANT_B_DERIVATION_RULES) {
      await owner.query(
        `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type) values ($1, $2, $3, $4, $5)`,
        [TENANT_B, r.ruleName, r.conditionColumn, r.conditionValue, r.derivedHoldType],
      );
    }
  } finally {
    owner.release();
  }

  // Run a sync for tenant A so the roster is populated and fresh.
  const connector = new FixtureSheetConnector();
  const job: SyncJob = {
    tenantId: TENANT_A,
    sheetId: TENANT_A,
    range: 'Sheet1!A1:Z1000',
  };
  const result = await runSync(db.appPool, connector, job);
  expect(result.kind).toBe('success');
});

afterAll(async () => {
  await db.cleanup();
});

// ── T-14: Happy path ──────────────────────────────────────────────────

describe('PL-009 · T-14: happy path', () => {
  it('staff caller gets correct status with derived hold_source', async () => {
    // A001 = Jordan Smith, Tardy → derived detention
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.student_ref).toBe('A001');
      expect(result.student_name).toBe('Jordan Smith');
      expect(result.attendance_status).toBe('Tardy');
      expect(result.hold_source).toBe('derived');
      expect(result.hold_type).toBe('Detention');
      expect(result.do_not_call).toBe(false);
    }
  });

  it('staff caller gets authoritative hold with release time and location', async () => {
    // A008 = Devon Walker, Absent with authoritative Detention hold
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A008',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.student_ref).toBe('A008');
      expect(result.hold_type).toBe('Detention');
      expect(result.hold_source).toBe('authoritative');
      expect(result.release_time).toBe('14:30');
      expect(result.hold_location).toBe('Room 5');
    }
  });

  it('parent caller gets authoritative hold info', async () => {
    // A008 = Devon Walker, authoritative hold — parent should see it
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A008',
        caller: 'parent',
        actor: 'test-parent',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.hold_type).toBe('Detention');
      expect(result.hold_source).toBe('authoritative');
      expect(result.release_time).toBe('14:30');
      // Parent should not see reason_code or do_not_call
      expect(result.reason_code).toBeNull();
      expect(result.do_not_call).toBe(false);
    }
  });
});

// ── T-21 (via service): Derived holds blocked on parent path ─────────

describe('PL-009 · T-21 via service: derived holds blocked for parents', () => {
  it('parent caller does not receive derived hold details', async () => {
    // A001 = Jordan Smith, Tardy → derived detention
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'parent',
        actor: 'test-parent',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      // Student info is returned, but hold details are blocked
      expect(result.student_ref).toBe('A001');
      expect(result.student_name).toBe('Jordan Smith');
      expect(result.hold_type).toBeNull();
      expect(result.release_time).toBeNull();
      expect(result.hold_location).toBeNull();
      // hold_source is omitted entirely — a false value would imply
      // there IS a hold, which is the information we're withholding
      expect(result.hold_source).toBeUndefined();
    }
  });

  it('staff caller sees derived hold details', async () => {
    // Same student — staff should see the derived hold
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.hold_type).toBe('Detention');
      expect(result.hold_source).toBe('derived');
    }
  });
});

// ── T-15: Four refusals are distinguishable ──────────────────────────

describe('PL-009 · T-15: four refusals are distinguishable', () => {
  it('roster_stale — fresh sync backdated past threshold', async () => {
    // Backdate all successful syncs for tenant A to 2 hours ago
    const owner = await db.ownerPool.connect();
    try {
      await owner.query(
        `update roster_syncs
         set finished_at = now() - interval '2 hours'
         where tenant_id = $1 and outcome in ('success', 'partial-success')`,
        [TENANT_A],
      );
    } finally {
      owner.release();
    }

    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('roster_stale');
    }

    // Restore freshness for subsequent tests
    const owner2 = await db.ownerPool.connect();
    try {
      await owner2.query(
        `update roster_syncs
         set finished_at = now()
         where tenant_id = $1 and outcome in ('success', 'partial-success')`,
        [TENANT_A],
      );
    } finally {
      owner2.release();
    }
  });

  it('sync_failed — latest sync failed, no prior successful sync', async () => {
    // Tenant B has no syncs yet. Run a failing sync (no prior success).
    const failingConnector = new FixtureSheetConnector({
      simulateAuthFailure: true,
    });
    const job: SyncJob = {
      tenantId: TENANT_B,
      sheetId: TENANT_B,
      range: 'Sheet1!A1:Z1000',
    };
    const syncResult = await runSync(db.appPool, failingConnector, job);
    expect(syncResult.kind).toBe('failure');

    // Now call getScholarStatus — should get sync_failed, not roster_stale
    const result = await withTenant(db.appPool, TENANT_B, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'B001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('sync_failed');
    }
  });

  it('student_not_found — fresh roster, student does not exist', async () => {
    // Tenant A roster is fresh (restored). Look up a non-existent student.
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'ZZZ999',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('student_not_found');
    }
  });

  it('row_quarantined — student row was quarantined during sync', async () => {
    // A006 has an empty student_name — it gets quarantined during sync.
    // The student_ref 'A006' is in the raw_data but not in roster_entries.
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A006',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('row_quarantined');
    }
  });

  it('all four refusal reasons are distinct strings', () => {
    const reasons = [
      'roster_stale',
      'sync_failed',
      'student_not_found',
      'row_quarantined',
    ];
    expect(new Set(reasons).size).toBe(4);
  });

  it('no refusal returns an empty success', async () => {
    // Verify that a refusal never has kind === 'success'
    const results: ScholarStatusResult[] = [];

    // roster_stale (backdate again briefly)
    const owner = await db.ownerPool.connect();
    try {
      await owner.query(
        `update roster_syncs
         set finished_at = now() - interval '2 hours'
         where tenant_id = $1 and outcome in ('success', 'partial-success')`,
        [TENANT_A],
      );
    } finally {
      owner.release();
    }

    results.push(
      await withTenant(db.appPool, TENANT_A, async (client) => {
        return getScholarStatus(client, {
          studentRef: 'A001',
          caller: 'staff',
          actor: 'test-staff',
          freshnessMinutes: 45,
        });
      }),
    );

    // Restore
    const owner2 = await db.ownerPool.connect();
    try {
      await owner2.query(
        `update roster_syncs
         set finished_at = now()
         where tenant_id = $1 and outcome in ('success', 'partial-success')`,
        [TENANT_A],
      );
    } finally {
      owner2.release();
    }

    // sync_failed (tenant B already has a failed sync)
    results.push(
      await withTenant(db.appPool, TENANT_B, async (client) => {
        return getScholarStatus(client, {
          studentRef: 'B001',
          caller: 'staff',
          actor: 'test-staff',
          freshnessMinutes: 45,
        });
      }),
    );

    // student_not_found
    results.push(
      await withTenant(db.appPool, TENANT_A, async (client) => {
        return getScholarStatus(client, {
          studentRef: 'ZZZ999',
          caller: 'staff',
          actor: 'test-staff',
          freshnessMinutes: 45,
        });
      }),
    );

    // row_quarantined
    results.push(
      await withTenant(db.appPool, TENANT_A, async (client) => {
        return getScholarStatus(client, {
          studentRef: 'A006',
          caller: 'staff',
          actor: 'test-staff',
          freshnessMinutes: 45,
        });
      }),
    );

    for (const r of results) {
      expect(r.kind).toBe('refusal');
    }
  });
});

// ── T-16: Every read is audited ──────────────────────────────────────

describe('PL-009 · T-16: every read is audited', () => {
  it('each successful call writes exactly one audit entry', async () => {
    // Count audit entries before
    const before = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ count: string }>(
        `select count(*)::text as count from audit_log where subject_student_ref = $1`,
        ['A003'],
      );
      return parseInt(res.rows[0]!.count, 10);
    });

    // Make one successful call
    await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A003',
        caller: 'staff',
        actor: 'test-audit',
        freshnessMinutes: 45,
      });
    });

    // Count after
    const after = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ count: string }>(
        `select count(*)::text as count from audit_log where subject_student_ref = $1`,
        ['A003'],
      );
      return parseInt(res.rows[0]!.count, 10);
    });

    expect(after - before).toBe(1);
  });

  it('each refusal call writes exactly one audit entry', async () => {
    const ref = 'ZZZ-T16-AUDIT';

    const before = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ count: string }>(
        `select count(*)::text as count from audit_log where subject_student_ref = $1`,
        [ref],
      );
      return parseInt(res.rows[0]!.count, 10);
    });

    expect(before).toBe(0);

    // Make a refusal call (student not found)
    await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: ref,
        caller: 'staff',
        actor: 'test-audit',
        freshnessMinutes: 45,
      });
    });

    const after = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ count: string }>(
        `select count(*)::text as count from audit_log where subject_student_ref = $1`,
        [ref],
      );
      return parseInt(res.rows[0]!.count, 10);
    });

    expect(after).toBe(1);
  });

  it('audit entry for success has correct fields', async () => {
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A004',
        caller: 'staff',
        actor: 'test-audit-fields',
        freshnessMinutes: 45,
      });
    });
    expect(result.kind).toBe('success');

    // Check the latest audit entry
    const audit = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{
        actor: string;
        action: string;
        subject_student_ref: string;
        fields_disclosed: string[];
        outcome: string;
      }>(
        `select actor, action, subject_student_ref, fields_disclosed, outcome
         from audit_log
         where subject_student_ref = $1
         order by created_at desc limit 1`,
        ['A004'],
      );
      return res.rows[0];
    });

    expect(audit).toBeDefined();
    expect(audit!.actor).toBe('test-audit-fields');
    expect(audit!.action).toBe('getScholarStatus');
    expect(audit!.subject_student_ref).toBe('A004');
    expect(audit!.outcome).toBe('success');
    expect(audit!.fields_disclosed).toContain('student_ref');
    expect(audit!.fields_disclosed).toContain('hold_type');
    expect(audit!.fields_disclosed).toContain('do_not_call');
  });

  it('audit entry for refusal has empty fields_disclosed', async () => {
    const ref = 'ZZZ-T16-REFUSAL';

    await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: ref,
        caller: 'staff',
        actor: 'test-audit-refusal',
        freshnessMinutes: 45,
      });
    });

    const audit = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{
        outcome: string;
        fields_disclosed: string[];
      }>(
        `select outcome, fields_disclosed
         from audit_log
         where subject_student_ref = $1
         order by created_at desc limit 1`,
        [ref],
      );
      return res.rows[0];
    });

    expect(audit).toBeDefined();
    expect(audit!.outcome).toBe('student_not_found');
    expect(audit!.fields_disclosed).toEqual([]);
  });
});

// ── T-18: Latency ────────────────────────────────────────────────────

describe('PL-009 · T-18: getScholarStatus holds the latency budget', () => {
  it('p95 latency is comfortably under 150 ms', async () => {
    const N = 200;
    const latencies: number[] = [];

    for (let i = 0; i < N; i++) {
      const start = performance.now();
      await withTenant(db.appPool, TENANT_A, async (client) => {
        return getScholarStatus(client, {
          studentRef: 'A001',
          caller: 'staff',
          actor: 'test-latency',
          freshnessMinutes: 45,
        });
      });
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
    }

    latencies.sort((a, b) => a - b);
    const p95Index = Math.floor(N * 0.95);
    const p95 = latencies[p95Index]!;

    // Target ≤150 ms. We log the actual value for visibility.
    // The hard ceiling is 500 ms (Alexa+ round-trip budget).
    console.log(`[T-18] p95 = ${p95.toFixed(1)}ms (target ≤150ms)`);
    expect(p95).toBeLessThan(150);
  });
});

// ── T-03 (via service): Name collision does not cross tenants ────────

describe('PL-009 · T-03 via service: name collision does not cross tenants', () => {
  it('tenant A lookup for Jordan Smith returns tenant A data', async () => {
    // A001 = Jordan Smith (tenant A), Tardy → derived detention
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-isolation',
        freshnessMinutes: 45,
      });
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.student_ref).toBe('A001');
      expect(result.student_name).toBe('Jordan Smith');
      expect(result.attendance_status).toBe('Tardy');
    }
  });

  it('tenant A cannot look up tenant B student by ref', async () => {
    const result = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'B001',
        caller: 'staff',
        actor: 'test-isolation',
        freshnessMinutes: 45,
      });
    });

    // B001 is Jordan Smith in tenant B — not visible from tenant A
    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') {
      expect(result.reason).toBe('student_not_found');
    }
  });
});
