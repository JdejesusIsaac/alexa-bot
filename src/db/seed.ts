import { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { mapRow } from '../mapping/mapper.js';
import { type ColumnMapping } from '../repositories/column-mappings.js';
import { type DerivationRule } from '../repositories/derivation-rules.js';
import { assertApproverRoutingTotal } from '../repositories/approver-routing.js';
import { withTenant } from '../db/tenant-context.js';
import { deriveHolds } from '../derivation/derive-holds.js';
import { type MappingSeed, FIXTURES } from '../fixtures/synthetic-data.js';
import { todayServiceDate } from '../util/service-date.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Seed script — `npm run seed`.
 *
 * Produces a reproducible two-tenant dataset from the synthetic fixtures.
 * Runs as the OWNER role (DATABASE_URL) — the application role cannot
 * insert across tenants — but RLS is FORCED, so the owner is bound by
 * the policies too: each tenant's rows are inserted under that tenant's
 * `app.tenant_id` context, not around RLS (B-12).
 *
 * Idempotent: truncates all seeded tables before inserting.
 *
 * Seeds the roster as a dated set — today's service date by default, or
 * an explicit date for deterministic test setups — and populates the
 * `students` registry the same way ingest does (PL-201, T-51).
 *
 * No student PII is logged. Only counts and tenant names appear in output.
 */

export interface SeedOptions {
  /** Service date for the seeded roster set. Defaults to today. */
  readonly serviceDate?: string;
}

interface SyncResult {
  tenantName: string;
  rowsIn: number;
  rowsValid: number;
  rowsQuarantined: number;
}

export async function seed(options?: SeedOptions): Promise<SyncResult[]> {
  const serviceDate = options?.serviceDate ?? todayServiceDate();
  const config = loadConfig();
  // A one-client pool: withTenant needs a Pool to check out a client
  // and set the session context on. max: 1 keeps every statement on the
  // same connection, as the old bare Client did.
  const ownerPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  // The totality check's connection (3b below): the APP ROLE, so RLS
  // scopes the count to the tenant under check.
  const appPool = new Pool({ connectionString: config.appDatabaseUrl, max: 1 });

  try {
    // Idempotent: wipe all seeded data. Order respects FK constraints.
    // TRUNCATE is a bulk DDL operation — RLS does not apply to it, so
    // this runs outside any tenant context.
    await ownerPool.query(`
      truncate table derivation_rules, column_mappings, audit_log,
        quarantined_rows, roster_entries, roster_syncs,
        authorized_contacts, students, tenants
      cascade
    `);

    const results: SyncResult[] = [];

    for (const fixture of FIXTURES) {
      // Every row in a fixture carries that fixture's tenant_id, so the
      // fixture seeds under its own tenant context — FORCE RLS binds
      // the owner too, leaving no other door (B-12).
      await withTenant(ownerPool, fixture.tenantId, async (client) => {
        // 1. Insert tenant
        await client.query(`insert into tenants (id, name) values ($1, $2)`, [
          fixture.tenantId,
          fixture.tenantName,
        ]);

        // 2. Insert column mappings
        for (const m of fixture.mappings) {
          await client.query(
            `insert into column_mappings (tenant_id, sheet_header, canonical_field)
             values ($1, $2, $3)`,
            [fixture.tenantId, m.sheetHeader, m.canonicalField],
          );
        }

        // 3. Insert derivation rules
        for (const rule of fixture.derivationRules) {
          await client.query(
            `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type)
             values ($1, $2, $3, $4, $5)`,
            [
              fixture.tenantId,
              rule.ruleName,
              rule.conditionColumn,
              rule.conditionValue,
              rule.derivedHoldType,
            ],
          );
        }

        // 3a. Insert staff identities (PL-205) — BEFORE the routing rules
        // that reference them: the composite FK checks every new row, and
        // a configured approver must be registered staff (AD-29).
        for (const identity of fixture.staffIdentities) {
          await client.query(
            `insert into staff_identities (id, tenant_id, slack_user_id, subject, role)
             values ($1, $2, $3, $4, $5)`,
            [
              identity.id,
              fixture.tenantId,
              identity.slackUserId,
              identity.subject,
              identity.role,
            ],
          );
        }

        // 3b. Insert approver routing rules (PL-203 — the tribal-knowledge
        // artifact, F-15), then validate totality LOUDLY through the REAL
        // check (PL-285): `assertApproverRoutingTotal`, the same function
        // the suite pins (T-59). The inline duplicate it replaced was the
        // doc lie this wiring closes. A tenant with no default rule fails
        // here, at seed time — not when the first unmatched request
        // resolves to nobody at 1:50 pm.
        for (const rule of fixture.routing) {
          await client.query(
            `insert into approver_routing (tenant_id, scope_type, scope_value, approver_id)
             values ($1, $2, $3, $4)`,
            [fixture.tenantId, rule.scopeType, rule.scopeValue ?? null, rule.approverId],
          );
        }
        await withTenant(appPool, fixture.tenantId, assertApproverRoutingTotal);

        // 4. Create a roster sync record for the service date
        const syncRes = await client.query<{ id: string }>(
          `insert into roster_syncs (tenant_id, service_date, started_at, finished_at, rows_in, rows_valid, rows_quarantined, outcome)
           values ($1, $2, now(), now(), 0, 0, 0, 'success') returning id`,
          [fixture.tenantId, serviceDate],
        );
        const syncId = syncRes.rows[0]!.id;

        // 5. Map raw rows → canonical rows, apply derivation, insert valid ones, quarantine failures
        const mappings: ColumnMapping[] = fixture.mappings.map(
          (m: MappingSeed, i: number) => ({
            id: `seed-${fixture.tenantId}-${i}`,
            tenant_id: fixture.tenantId,
            sheet_header: m.sheetHeader,
            canonical_field: m.canonicalField,
          }),
        );

        const derivationRules: DerivationRule[] = fixture.derivationRules.map(
          (r, i: number) => ({
            id: `seed-${fixture.tenantId}-rule-${i}`,
            tenant_id: fixture.tenantId,
            rule_name: r.ruleName,
            condition_column: r.conditionColumn,
            condition_value: r.conditionValue,
            derived_hold_type: r.derivedHoldType,
          }),
        );

        let rowsValid = 0;
        let rowsQuarantined = 0;
        const headers = fixture.sheet.headers;

        for (let i = 0; i < fixture.sheet.rows.length; i++) {
          const values = fixture.sheet.rows[i]!;
          const rowNumber = i + 1;

          try {
            const mapped = mapRow(headers, values, mappings, rowNumber);
            const canonical = deriveHolds(mapped, derivationRules);

            // Resolve the student registry — insert when absent, link
            // the roster row (PL-201, T-51). Same shape as the ingest
            // pipeline; raw SQL here because seeding is tooling, not
            // the repository layer.
            const studentRes = await client.query<{ id: string }>(
              `insert into students (tenant_id, student_ref, student_name, section)
               values ($1, $2, $3, $4)
               on conflict (tenant_id, student_ref) do update
                 set student_name = excluded.student_name,
                     section = excluded.section
               returning id`,
              [
                fixture.tenantId,
                canonical.student_ref,
                canonical.student_name,
                canonical.section,
              ],
            );

            await client.query(
              `insert into roster_entries
                 (tenant_id, service_date, student_id, student_ref, student_name, section, attendance_status,
                  reason_code, hold_type, hold_source, release_time, hold_location,
                  do_not_call, missing_id, source_row_number, sync_id)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
              [
                fixture.tenantId,
                serviceDate,
                studentRes.rows[0]!.id,
                canonical.student_ref,
                canonical.student_name,
                canonical.section,
                canonical.attendance_status,
                canonical.reason_code,
                canonical.hold_type,
                canonical.hold_source,
                canonical.release_time,
                canonical.hold_location,
                canonical.do_not_call,
                canonical.missing_id,
                canonical.source_row_number,
                syncId,
              ],
            );
            rowsValid++;
          } catch {
            // Quarantine dirty rows (PL-006 will handle this properly;
            // for seeding we just count them and store the raw data)
            await client.query(
              `insert into quarantined_rows (tenant_id, sync_id, source_row_number, raw_data, reason)
               values ($1, $2, $3, $4, 'validation failure')`,
              [
                fixture.tenantId,
                syncId,
                rowNumber,
                JSON.stringify({ headers: [...headers], values: [...values] }),
              ],
            );
            rowsQuarantined++;
          }
        }

        // 6. Update sync record with counts
        await client.query(
          `update roster_syncs set rows_in = $1, rows_valid = $2, rows_quarantined = $3 where id = $4`,
          [fixture.sheet.rows.length, rowsValid, rowsQuarantined, syncId],
        );

        results.push({
          tenantName: fixture.tenantName,
          rowsIn: fixture.sheet.rows.length,
          rowsValid,
          rowsQuarantined,
        });
      });
    }

    return results;
  } finally {
    await appPool.end();
    await ownerPool.end();
  }
}

// Entry point when invoked via `npm run seed`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  seed()
    .then((results) => {
      for (const r of results) {
        console.log(
          `${r.tenantName}: ${r.rowsValid} valid, ${r.rowsQuarantined} quarantined, ${r.rowsIn} total`,
        );
      }
      console.log('seed complete');
    })
    .catch((err: unknown) => {
      console.error(`seed failed: ${(err as Error).message}`);
      process.exit(1);
    });
}
