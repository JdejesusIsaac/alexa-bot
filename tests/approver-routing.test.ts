import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb, seedTenants } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  insertApproverRoutingRule,
  assertApproverRoutingTotal,
  resolveApproverForStudent,
  RoutingNotTotalError,
  type RoutingResolution,
} from '../src/repositories/approver-routing.js';
import { insertStaffIdentity } from '../src/repositories/staff-identities.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';

/**
 * PL-203 — approver routing resolver.
 *
 * T-58: Resolution is deterministic, most-specific-wins, and total.
 *       A tenant with `default`, a `grade` rule, and a `section` rule
 *       that all match one scholar resolves to the section rule; the
 *       same input always resolves to the same approver; every scholar
 *       resolves to exactly one.
 * T-59: A tenant without a default routing rule fails at seed — the
 *       loud failure is `assertApproverRoutingTotal` (wired into
 *       `npm run seed`), and the resolver refuses typed rather than
 *       resolving to nobody. Colliding scope values across tenants stay
 *       tenant-scoped.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

// Synthetic approver ids — they resolve against staff_identities (PL-205).
const APPROVER_SEC = '11111111-1111-1111-1111-111111111111';
const APPROVER_GRADE = '22222222-2222-2222-2222-222222222222';
const APPROVER_DEFAULT = '33333333-3333-3333-3333-333333333333';
const B_APPROVER_SEC = '44444444-4444-4444-4444-444444444444';
const B_APPROVER_DEFAULT = '55555555-5555-5555-5555-555555555555';

let db: TestDb;
let secAndGrade: string; // matches section, grade, and default rules
let gradeOnly: string; // matches the grade rule only
let nothingButDefault: string; // matches nothing but the default
let nullGradeInSection: string; // section matches; grade is null
let bInSection: string; // tenant B, section code colliding with A's

beforeAll(async () => {
  db = await provisionTestDb();

  // FORCE RLS binds the owner too — the tenants and students insert
  // under each tenant's own context (B-12).
  await seedTenants(db.ownerPool, [
    [TENANT_A, 'Campus Alpha'],
    [TENANT_B, 'Campus Bravo'],
  ]);

  const insertStudent = async (
    tenantId: string,
    ref: string,
    section: string | null,
    grade: string | null,
  ): Promise<string> =>
    withTenant(db.ownerPool, tenantId, async (owner) => {
      const res = await owner.query<{ id: string }>(
        `insert into students (tenant_id, student_ref, student_name, section, grade)
         values ($1, $2, $3, $4, $5) returning id`,
        [tenantId, ref, 'Routing Test Scholar', section, grade],
      );
      return res.rows[0]!.id;
    });

  secAndGrade = await insertStudent(TENANT_A, 'R-001', '101', '5');
  gradeOnly = await insertStudent(TENANT_A, 'R-002', '999', '5');
  nothingButDefault = await insertStudent(TENANT_A, 'R-003', '999', '9');
  nullGradeInSection = await insertStudent(TENANT_A, 'R-004', '101', null);
  bInSection = await insertStudent(TENANT_B, 'R-101', '101', null);

  // Approvers are registered staff (PL-205): the composite FK on
  // approver_id refuses to name an identity that does not exist, so the
  // identities are inserted before the rules that reference them.
  await withTenant(db.appPool, TENANT_A, async (client) => {
    await insertStaffIdentity(client, {
      id: APPROVER_SEC,
      slackUserId: 'USYNTH_SEC',
      subject: 'lead-sec@synthetic.test',
      role: 'staff',
    });
    await insertStaffIdentity(client, {
      id: APPROVER_GRADE,
      slackUserId: 'USYNTH_GRADE',
      subject: 'lead-grade@synthetic.test',
      role: 'staff',
    });
    await insertStaffIdentity(client, {
      id: APPROVER_DEFAULT,
      slackUserId: 'USYNTH_DEFAULT',
      subject: 'lead-default@synthetic.test',
      role: 'staff',
    });
  });
  await withTenant(db.appPool, TENANT_B, async (client) => {
    await insertStaffIdentity(client, {
      id: B_APPROVER_SEC,
      slackUserId: 'USYNTH_B_SEC',
      subject: 'lead-b-sec@synthetic.test',
      role: 'staff',
    });
    await insertStaffIdentity(client, {
      id: B_APPROVER_DEFAULT,
      slackUserId: 'USYNTH_B_DEFAULT',
      subject: 'lead-b-default@synthetic.test',
      role: 'staff',
    });
  });

  // Tenant A: the full tri-rule tenant — section, grade, and default all
  // in play (T-58's setup).
  await withTenant(db.appPool, TENANT_A, async (client) => {
    await insertApproverRoutingRule(client, {
      scopeType: 'section',
      scopeValue: '101',
      approverId: APPROVER_SEC,
    });
    await insertApproverRoutingRule(client, {
      scopeType: 'grade',
      scopeValue: '5',
      approverId: APPROVER_GRADE,
    });
    await insertApproverRoutingRule(client, {
      scopeType: 'default',
      approverId: APPROVER_DEFAULT,
    });
  });

  // Tenant B: a section rule only — deliberately NOT total yet (T-59's
  // setup). The section code collides with tenant A's on purpose.
  await withTenant(db.appPool, TENANT_B, async (client) => {
    await insertApproverRoutingRule(client, {
      scopeType: 'section',
      scopeValue: '101',
      approverId: B_APPROVER_SEC,
    });
  });
});

afterAll(async () => {
  await db.cleanup();
});

async function resolve(studentId: string, tenantId: string): Promise<RoutingResolution> {
  return withTenant(db.appPool, tenantId, async (client) =>
    resolveApproverForStudent(client, studentId),
  );
}

// ── T-58: deterministic, most-specific-wins, total ─────────────────────

describe('PL-203 · T-58: resolution is deterministic, most-specific-wins, and total', () => {
  it('the section rule wins when section, grade, and default all match one scholar', async () => {
    const result = await resolve(secAndGrade, TENANT_A);
    expect(result).toEqual({
      ok: true,
      resolution: {
        approverId: APPROVER_SEC,
        matchedScope: 'section',
        scopeValue: '101',
      },
    });
  });

  it('the grade rule wins over the default when no section rule matches', async () => {
    const result = await resolve(gradeOnly, TENANT_A);
    expect(result).toEqual({
      ok: true,
      resolution: {
        approverId: APPROVER_GRADE,
        matchedScope: 'grade',
        scopeValue: '5',
      },
    });
  });

  it('the default catches everything else — resolution is total', async () => {
    const result = await resolve(nothingButDefault, TENANT_A);
    expect(result).toEqual({
      ok: true,
      resolution: {
        approverId: APPROVER_DEFAULT,
        matchedScope: 'default',
        scopeValue: null,
      },
    });
  });

  it('a null grade never matches a grade rule — the scholar falls to their section', async () => {
    const result = await resolve(nullGradeInSection, TENANT_A);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.approverId).toBe(APPROVER_SEC);
      expect(result.resolution.matchedScope).toBe('section');
    }
  });

  it('the same input always resolves to the same approver', async () => {
    const results: RoutingResolution[] = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(await resolve(secAndGrade, TENANT_A));
    }
    const approvers = new Set(
      results.map((r) => (r.ok ? r.resolution.approverId : `failure:${r}`)),
    );
    expect(approvers.size).toBe(1);
    expect([...approvers][0]).toBe(APPROVER_SEC);
  });

  it('every scholar resolves to exactly one approver', async () => {
    for (const studentId of [
      secAndGrade,
      gradeOnly,
      nothingButDefault,
      nullGradeInSection,
    ]) {
      const result = await resolve(studentId, TENANT_A);
      expect(result.ok, `scholar ${studentId} must resolve`).toBe(true);
      if (result.ok) {
        expect(typeof result.resolution.approverId).toBe('string');
        expect(result.resolution.approverId.length).toBe(36);
      }
    }
  });

  it('a colliding section code stays tenant-scoped — B resolves B’s approver, never A’s', async () => {
    const result = await resolve(bInSection, TENANT_B);
    expect(result).toEqual({
      ok: true,
      resolution: {
        approverId: B_APPROVER_SEC,
        matchedScope: 'section',
        scopeValue: '101',
      },
    });
  });
});

// ── T-59: A tenant without a default routing rule fails at seed ───────

describe('PL-203 · T-59: a tenant without a default routing rule fails at seed', () => {
  it('the totality assertion fails loudly — a typed error, not a silent pass', async () => {
    await expect(
      withTenant(db.appPool, TENANT_B, async (client) =>
        assertApproverRoutingTotal(client),
      ),
    ).rejects.toThrow(RoutingNotTotalError);
  });

  it('the resolver refuses rather than resolving to nobody — the 1:50 pm backstop', async () => {
    // A tenant-B scholar whose section matches nothing, with no default
    // to catch them. The typed refusal is the caller’s signal to degrade
    // to a human (Rule 10) — never a confident nobody.
    const unmatched = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into students (tenant_id, student_ref, student_name, section, grade)
         values ($1, 'R-102', 'Routing Test Scholar', '999', null) returning id`,
        [TENANT_B],
      );
      return res.rows[0]!.id;
    });

    const result = await resolve(unmatched, TENANT_B);
    expect(result).toEqual({ ok: false, code: 'routing_not_total' });
  });

  it('an invisible scholar is student_not_found, never forbidden-but-real', async () => {
    const result = await resolve('99999999-9999-9999-9999-999999999999', TENANT_A);
    expect(result).toEqual({ ok: false, code: 'student_not_found' });
  });

  it('the schema permits exactly one default rule per tenant', async () => {
    let rejected = false;
    let errorCode: string | undefined;
    await withTenant(db.appPool, TENANT_A, async (client) => {
      try {
        await insertApproverRoutingRule(client, {
          scopeType: 'default',
          approverId: APPROVER_DEFAULT,
        });
      } catch (err) {
        rejected = true;
        errorCode = (err as { code?: string }).code;
      }
    });
    // NULLS NOT DISTINCT — a second default row is rejected even though
    // its scope_value is NULL.
    expect(rejected).toBe(true);
    expect(errorCode).toBe('23505');
  });

  it('adding the default makes resolution total', async () => {
    await withTenant(db.appPool, TENANT_B, async (client) => {
      await insertApproverRoutingRule(client, {
        scopeType: 'default',
        approverId: B_APPROVER_DEFAULT,
      });
      await assertApproverRoutingTotal(client); // no throw
    });

    // The previously-refused shape now resolves.
    const result = await resolve(bInSection, TENANT_B);
    expect(result.ok).toBe(true);
  });
});
