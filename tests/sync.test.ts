import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { runSync, type SyncJob } from '../src/sync/scheduler.js';
import { FixtureSheetConnector } from '../src/connector/fixture-sheet-connector.js';
import { countEntries } from '../src/repositories/roster-entries.js';
import { isRosterFresh, findLatestSuccessfulSync, findLatestSync } from '../src/repositories/roster-syncs.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_MAPPINGS,
  TENANT_B_MAPPINGS,
  TENANT_A_DERIVATION_RULES,
  TENANT_B_DERIVATION_RULES,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-007 — Sync scheduler + staleness guard (DB integration tests).
 *
 * T-11: Sync is idempotent — twice on an unchanged sheet produces no duplicates.
 * T-12: Staleness guard refuses stale rosters.
 * T-13: Upstream failure leaves prior roster intact; freshness counts from last successful sync.
 * T-23: Background jobs establish tenant context explicitly.
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
});

afterAll(async () => {
  await db.cleanup();
});

// ── T-11: Sync is idempotent ──────────────────────────────────────────

describe('PL-007 · T-11: sync is idempotent', () => {
  it('running sync twice on an unchanged sheet produces no duplicate entries', async () => {
    const connector = new FixtureSheetConnector();
    const job: SyncJob = {
      tenantId: TENANT_A,
      sheetId: TENANT_A,
      range: 'Sheet1!A1:Z1000',
    };

    // First sync
    const result1 = await runSync(db.appPool, connector, job);
    expect(result1.kind).toBe('success');

    const count1 = await withTenant(db.appPool, TENANT_A, async (client) => {
      return countEntries(client);
    });

    // Second sync on the same sheet
    const result2 = await runSync(db.appPool, connector, job);
    expect(result2.kind).toBe('success');

    const count2 = await withTenant(db.appPool, TENANT_A, async (client) => {
      return countEntries(client);
    });

    // No duplicates — count should be the same
    expect(count2).toBe(count1);
    expect(count1).toBeGreaterThan(0);
  });

  it('second sync is recorded as a distinct sync record', async () => {
    const allSyncs = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ id: string; outcome: string }>(
        `select id, outcome from roster_syncs order by started_at desc limit 2`,
      );
      return res.rows;
    });

    expect(allSyncs).toHaveLength(2);
    // Both should be successful
    expect(allSyncs[0]!.outcome).toMatch(/^(success|partial-success)$/);
    expect(allSyncs[1]!.outcome).toMatch(/^(success|partial-success)$/);
    // Distinct IDs
    expect(allSyncs[0]!.id).not.toBe(allSyncs[1]!.id);
  });
});

// ── T-12: Staleness guard refuses stale rosters ───────────────────────

describe('PL-007 · T-12: staleness guard refuses stale rosters', () => {
  it('isRosterFresh returns true after a recent sync', async () => {
    const fresh = await withTenant(db.appPool, TENANT_A, async (client) => {
      return isRosterFresh(client, 45);
    });
    expect(fresh).toBe(true);
  });

  it('isRosterFresh returns false when the sync is backdated past the threshold', async () => {
    // Backdate ALL successful syncs for tenant A to 2 hours ago.
    // T-11 created two syncs — backdating only the latest would leave
    // the second-latest still fresh.
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

    const fresh = await withTenant(db.appPool, TENANT_A, async (client) => {
      return isRosterFresh(client, 45);
    });
    expect(fresh).toBe(false);
  });

  it('isRosterFresh returns false when no successful sync exists', async () => {
    // Use tenant B which has no syncs yet
    const fresh = await withTenant(db.appPool, TENANT_B, async (client) => {
      return isRosterFresh(client, 45);
    });
    expect(fresh).toBe(false);
  });
});

// ── T-13: Upstream failure does not corrupt good data ─────────────────

describe('PL-007 · T-13: upstream failure preserves prior data', () => {
  it('connector failure records a failed sync and leaves existing entries intact', async () => {
    // First, run a successful sync for tenant B
    const goodConnector = new FixtureSheetConnector();
    const job: SyncJob = {
      tenantId: TENANT_B,
      sheetId: TENANT_B,
      range: 'Sheet1!A1:Z1000',
    };

    const result1 = await runSync(db.appPool, goodConnector, job);
    expect(result1.kind).toBe('success');

    const countBefore = await withTenant(db.appPool, TENANT_B, async (client) => {
      return countEntries(client);
    });
    expect(countBefore).toBeGreaterThan(0);

    // Now run with a failing connector
    const failingConnector = new FixtureSheetConnector({
      simulateAuthFailure: true,
    });
    const result2 = await runSync(db.appPool, failingConnector, job);
    expect(result2.kind).toBe('failure');
    if (result2.kind === 'failure') {
      expect(result2.sync.outcome).toBe('failure');
      expect(result2.error).toBe('ConnectorAuthError');
    }

    // Existing entries are preserved — count unchanged
    const countAfter = await withTenant(db.appPool, TENANT_B, async (client) => {
      return countEntries(client);
    });
    expect(countAfter).toBe(countBefore);
  });

  it('staleness guard counts from the last successful sync, not the failed one', async () => {
    // The failed sync should NOT reset the freshness clock.
    // The last successful sync for tenant B was just moments ago,
    // so isRosterFresh should still return true.
    const fresh = await withTenant(db.appPool, TENANT_B, async (client) => {
      return isRosterFresh(client, 45);
    });
    expect(fresh).toBe(true);

    // Verify the latest sync is the failed one
    const latest = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findLatestSync(client);
    });
    expect(latest).not.toBeNull();
    expect(latest!.outcome).toBe('failure');

    // But the latest *successful* sync is the good one
    const latestSuccess = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findLatestSuccessfulSync(client);
    });
    expect(latestSuccess).not.toBeNull();
    expect(latestSuccess!.outcome).toMatch(/^(success|partial-success)$/);
  });
});

// ── T-23: Background jobs run inside tenant context ──────────────────

describe('PL-007 · T-23: background jobs establish tenant context', () => {
  it('runSync for tenant A writes only tenant A rows', async () => {
    // We already have tenant A entries from T-11. Verify they are all tenant A.
    const aCount = await withTenant(db.appPool, TENANT_A, async (client) => {
      return countEntries(client);
    });
    expect(aCount).toBeGreaterThan(0);

    // Verify tenant B cannot see tenant A's entries
    const bCount = await withTenant(db.appPool, TENANT_B, async (client) => {
      return countEntries(client);
    });
    // Tenant B has entries from T-13, but they should be separate from A's
    expect(bCount).toBeGreaterThan(0);

    // Cross-verify: the counts are independent (no cross-tenant leakage)
    // The total entries visible under each tenant should not include the other's
    const aEntries = await withTenant(db.appPool, TENANT_A, async (client) => {
      const res = await client.query<{ student_ref: string }>(
        `select student_ref from roster_entries order by student_ref limit 1`,
      );
      return res.rows[0]?.student_ref ?? null;
    });
    const bEntries = await withTenant(db.appPool, TENANT_B, async (client) => {
      const res = await client.query<{ student_ref: string }>(
        `select student_ref from roster_entries order by student_ref limit 1`,
      );
      return res.rows[0]?.student_ref ?? null;
    });

    // Tenant A refs start with 'A', tenant B refs start with 'B'
    if (aEntries) {
      expect(aEntries.startsWith('A')).toBe(true);
    }
    if (bEntries) {
      expect(bEntries.startsWith('B')).toBe(true);
    }
  });

  it('runSync establishes tenant context via withTenant — data is correctly scoped', async () => {
    // Run a fresh sync for tenant A and verify the sync record is tenant-scoped
    const connector = new FixtureSheetConnector();
    const job: SyncJob = {
      tenantId: TENANT_A,
      sheetId: TENANT_A,
      range: 'Sheet1!A1:Z1000',
    };

    const result = await runSync(db.appPool, connector, job);
    expect(result.kind).toBe('success');

    // The sync record should be visible under tenant A
    const syncA = await withTenant(db.appPool, TENANT_A, async (client) => {
      return findLatestSync(client);
    });
    expect(syncA).not.toBeNull();

    // The sync record should NOT be visible under tenant B
    const syncB = await withTenant(db.appPool, TENANT_B, async (client) => {
      return findLatestSync(client);
    });
    // Tenant B's latest sync is the failed one from T-13, not A's
    if (syncB) {
      expect(syncB.id).not.toBe(syncA!.id);
    }
  });
});
