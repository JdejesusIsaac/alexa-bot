import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { runSync, type SyncJob } from '../src/sync/scheduler.js';
import { FixtureSheetConnector } from '../src/connector/fixture-sheet-connector.js';
import { getScholarStatus } from '../src/services/scholar-status.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_MAPPINGS,
  TENANT_B_MAPPINGS,
  TENANT_A_DERIVATION_RULES,
  TENANT_B_DERIVATION_RULES,
} from '../src/fixtures/synthetic-data.js';

/**
 * T-22 · Cache keys are tenant-scoped (leak vector 2).
 *
 * With any caching or memoization in the read path, warm the cache under
 * tenant A for a student ref that exists in both tenants, then perform the
 * same lookup under tenant B.
 *
 * Pass: B receives B's record.
 * Fail (critical): B receives A's cached value.
 *
 * If no cache exists yet, this test asserts that — so that adding one later
 * cannot silently bypass RLS, which lives in the database and cannot see a
 * cache hit.
 *
 * Synthetic data only.
 */

let db: TestDb;

beforeAll(async () => {
  db = await provisionTestDb();

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

  // Sync both tenants so both have fresh rosters.
  const connector = new FixtureSheetConnector();
  for (const tenantId of [TENANT_A, TENANT_B]) {
    const job: SyncJob = {
      tenantId,
      sheetId: tenantId,
      range: 'Sheet1!A1:Z1000',
    };
    const result = await runSync(db.appPool, connector, job);
    expect(result.kind).toBe('success');
  }
});

afterAll(async () => {
  await db.cleanup();
});

describe('T-22: cache keys are tenant-scoped (leak vector 2)', () => {
  it('no cache exists in the read path — getScholarStatus always hits the database', async () => {
    // The service accepts a PoolClient already scoped by withTenant.
    // There is no cache layer between getScholarStatus and the repository.
    // Each call goes through withTenant → repository → database.
    // RLS lives in the database and cannot be bypassed by a cache hit.
    //
    // This test asserts that behavior: two calls for the same student_ref
    // under different tenants return different data, proving no cache
    // is returning stale cross-tenant results.

    // Jordan Smith exists in both tenants (name collision fixture).
    // Tenant A's Jordan Smith has student_ref A001.
    // Tenant B's Jordan Smith has student_ref B001.
    // Both tenants have a student named "Jordan Smith" but with different refs.
    // Use A001 which only exists in tenant A.

    // Warm: lookup A001 under tenant A.
    const resultA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });
    expect(resultA.kind).toBe('success');

    // Now lookup A001 under tenant B — should be student_not_found,
    // NOT A's cached data.
    const resultB = await withTenant(db.appPool, TENANT_B, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    // B should not see A's data — A001 doesn't exist in B's roster.
    expect(resultB.kind).toBe('refusal');
    if (resultB.kind === 'refusal') {
      expect(resultB.reason).toBe('student_not_found');
    }
  });

  it('repeated lookups under the same tenant return consistent results', async () => {
    // Call getScholarStatus twice for the same student under the same tenant.
    // Both calls should return identical results — no stale cache issue.
    const result1 = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    const result2 = await withTenant(db.appPool, TENANT_A, async (client) => {
      return getScholarStatus(client, {
        studentRef: 'A001',
        caller: 'staff',
        actor: 'test-staff',
        freshnessMinutes: 45,
      });
    });

    expect(result1).toEqual(result2);
  });

  it('source code contains no cache or memoization in the service layer', async () => {
    // Assert that getScholarStatus does not use any caching mechanism.
    // This is a static assertion: the service module exports only the
    // function and types, with no module-level cache state.
    //
    // If a cache is added later, this test must be updated to verify
    // tenant-scoped keys — otherwise it should fail loudly.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const servicePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'services',
      'scholar-status.ts',
    );

    const source = await readFile(servicePath, 'utf8');

    // Check for common cache patterns. If any are found, the test fails
    // and the developer must add tenant-scoped cache key tests.
    const cachePatterns = [
      /\bMap\s*\(/,
      /\bnew\s+Map\b/,
      /\bWeakMap\b/,
      /\.cache\b/,
      /\bmemo\b/i,
      /\blru\b/i,
    ];

    for (const pattern of cachePatterns) {
      expect(pattern.test(source)).toBe(false);
    }
  });
});
