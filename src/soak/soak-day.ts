/**
 * Soak day runner — `npm run soak:day` (Sprint 1 exit criterion 1, P3).
 *
 * Runs `getScholarStatus` across both synthetic tenants once per business
 * day and records three things per run: p95 latency, audit completeness,
 * and a cross-tenant leakage probe. Ten recorded business days closes
 * Sprint 1's soak.
 *
 * Deliberate properties:
 *
 * 1. **No raw SQL.** Every database touch goes through a repository or
 *    the service layer (rule 11). This file owns no queries.
 * 2. **No student identifiers in output.** The log carries `tenant_id`,
 *    counts, and timings only — never a ref, never a name (rule: logs
 *    carry tenant_id, never student identifiers). Refs live in memory
 *    for the duration of the run and are never written or printed.
 * 3. **Idempotent per date.** Re-running on a date already recorded
 *    amends that entry rather than advancing the counter, so a repeated
 *    run cannot inflate the day count.
 * 4. **Weekends do not count.** A weekend run is recorded as
 *    non-counting unless `--force` is passed.
 *
 * The data is synthetic fixture data. This is monitoring, not a test —
 * it reports rather than asserts, except for the leakage probe, which
 * exits non-zero because a leak is not a metric.
 */

import { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { withTenant } from '../db/tenant-context.js';
import { getScholarStatus } from '../services/scholar-status.js';
import { findByStudentRef as findAuditByStudentRef } from '../repositories/audit-log.js';
import { searchRosterEntries } from '../repositories/roster-entries.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_NAME,
  TENANT_B_NAME,
} from '../fixtures/synthetic-data.js';
import { appendSoakDay, readSoakLog, type SoakDayRecord } from './soak-log.js';

const TENANTS = [
  { id: TENANT_A, name: TENANT_A_NAME, foreignRef: 'B001' },
  { id: TENANT_B, name: TENANT_B_NAME, foreignRef: 'A001' },
] as const;

const ACTOR = 'soak-runner';

interface TenantRunResult {
  readonly tenantId: string;
  readonly calls: number;
  readonly successes: number;
  readonly refusals: number;
  readonly latenciesMs: readonly number[];
  readonly auditedCalls: number;
  readonly leakageProbe: 'clean' | 'LEAKED';
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

/**
 * Probe one tenant: look up every roster entry it can see, confirm each
 * call was audited, then attempt a ref belonging to the other tenant.
 */
async function runTenant(
  pool: Pool,
  tenant: (typeof TENANTS)[number],
  freshnessMinutes: number,
): Promise<TenantRunResult> {
  return withTenant(pool, tenant.id, async (client) => {
    const page = await searchRosterEntries(client, {}, { limit: 100, offset: 0 });

    const latenciesMs: number[] = [];
    let successes = 0;
    let refusals = 0;
    let auditedCalls = 0;

    for (const entry of page.entries) {
      const ref = entry.student_ref;

      const auditBefore = (await findAuditByStudentRef(client, ref)).length;

      const startedAt = process.hrtime.bigint();
      const result = await getScholarStatus(client, {
        studentRef: ref,
        caller: 'staff',
        actor: ACTOR,
        freshnessMinutes,
      });
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      latenciesMs.push(elapsedMs);
      if (result.kind === 'success') successes += 1;
      else refusals += 1;

      const auditAfter = (await findAuditByStudentRef(client, ref)).length;
      if (auditAfter === auditBefore + 1) auditedCalls += 1;
    }

    // Leakage probe: a ref that exists only in the other tenant must be
    // invisible here. Anything other than a refusal is a leak.
    const foreign = await getScholarStatus(client, {
      studentRef: tenant.foreignRef,
      caller: 'staff',
      actor: ACTOR,
      freshnessMinutes,
    });
    const leakageProbe = foreign.kind === 'refusal' ? 'clean' : 'LEAKED';

    return {
      tenantId: tenant.id,
      calls: page.entries.length,
      successes,
      refusals,
      latenciesMs,
      auditedCalls,
      leakageProbe,
    };
  });
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.appDatabaseUrl, max: 4 });

  try {
    const results: TenantRunResult[] = [];
    for (const tenant of TENANTS) {
      results.push(await runTenant(pool, tenant, config.rosterFreshnessMinutes));
    }

    const allLatencies = results.flatMap((r) => [...r.latenciesMs]).sort((a, b) => a - b);
    const totalCalls = results.reduce((n, r) => n + r.calls, 0);
    const totalAudited = results.reduce((n, r) => n + r.auditedCalls, 0);
    const leaked = results.some((r) => r.leakageProbe === 'LEAKED');

    const today = new Date();
    const isWeekend = today.getDay() === 0 || today.getDay() === 6;
    const counts = !isWeekend || force;

    const existing = await readSoakLog();
    const dateKey = today.toISOString().slice(0, 10);
    const alreadyRecorded = existing.some((d) => d.date === dateKey);
    const priorCounted = existing.filter((d) => d.counts && d.date !== dateKey).length;

    const record: SoakDayRecord = {
      date: dateKey,
      dayNumber: counts ? priorCounted + 1 : priorCounted,
      counts,
      calls: totalCalls,
      p50Ms: percentile(allLatencies, 50),
      p95Ms: percentile(allLatencies, 95),
      auditCompleteness: totalCalls === 0 ? 0 : totalAudited / totalCalls,
      leakage: leaked ? 'LEAKED' : 'clean',
      tenants: results.map((r) => ({
        tenantId: r.tenantId,
        calls: r.calls,
        successes: r.successes,
        refusals: r.refusals,
      })),
    };

    await appendSoakDay(record);

    const verb = alreadyRecorded ? 'amended' : 'recorded';
    console.log(
      JSON.stringify({
        msg: `soak_day_${verb}`,
        date: record.date,
        day: `${record.dayNumber} / 10`,
        counts_toward_soak: record.counts,
        calls: record.calls,
        p50_ms: Number(record.p50Ms.toFixed(2)),
        p95_ms: Number(record.p95Ms.toFixed(2)),
        audit_completeness: record.auditCompleteness,
        leakage: record.leakage,
      }),
    );

    if (!counts) {
      console.log(
        JSON.stringify({
          msg: 'soak_day_not_counted',
          reason: 'weekend — pass --force to count it anyway',
        }),
      );
    }

    if (leaked) {
      console.error(
        JSON.stringify({ msg: 'soak_leakage_detected', detail: 'see soak/soak-log.md' }),
      );
      process.exitCode = 1;
    }

    if (record.auditCompleteness < 1) {
      console.error(
        JSON.stringify({
          msg: 'soak_audit_incomplete',
          audited: totalAudited,
          calls: totalCalls,
        }),
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'soak_day_failed',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
