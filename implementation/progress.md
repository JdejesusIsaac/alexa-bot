# progress.md — Sprint 1

> **Agent: update this file at the end of every working session.** Append to the log, refresh the state table, and set "Next action" to something specific enough that a fresh session can start cold. This file is how continuity survives a context reset.

**Sprint:** 1 — Parent Line Core
**Started:** _(fill in)_
**Status:** 🟡 In progress — all PL tasks done (PL-001 through PL-012), PL-013 partial. Soak phase next.

---

## Current state

**Next action:** **Soak phase.** All sprint code complete. Run `getScholarStatus` for 10 consecutive business days against synthetic mirror. Monitor p95 latency, audit completeness, zero cross-tenant leakage. PL-013 steps 2 & 5 still blocked on credentials.

PL-005 is code-complete but cannot be integration-tested without Google Sheets OAuth credentials. The `GoogleSheetsConnector` is constructed and tested for error handling; the `FixtureSheetConnector` covers test scenarios.

PL-006 is code-complete: validation + quarantine pipeline with `ingestSheet`, `validateRow`, quarantined-rows repo, roster-syncs repo. 10 unit tests passing (no DB needed). DB integration tests (T-06, T-07) written but need `DATABASE_URL` to run.

**Task order** (derived from the `planning/plan.md` DAG — follow this unless a dependency changes):
 
```
PL-001 ✅ → PL-002 ✅ → PL-003 ✅ → PL-004 ✅ → PL-011 ✅ → PL-012 ✅ → PL-008 ✅ → PL-010 ✅ → PL-005 ✅ → PL-006 ✅ → PL-007 ✅ → PL-009 ✅ → soak
                     └─ PL-002 + PL-003 gate everything; do not start others before both are done
                        PL-009 ✅ done — all sprint code complete
                        PL-005 is code-complete; integration test blocked on Google Sheets OAuth creds + a test sheet
                        PL-013 ✅ partial (throwaway spike, runs independently)
```

**Blocked on:** nothing for PL-001–PL-004. **Resolved:** the container-runtime blocker is gone — AD-11 replaces Testcontainers with a real local Postgres (16.14 already running) and a database-per-run, with T-05 promoted to a blocking precondition because a dev superuser silently bypasses RLS. PL-005 still needs Google Sheets OAuth credentials and a test sheet. Open question 9 (authorization server) is Sprint 2, not this sprint.

**Soak status:** not started · 0 / 10 business days

**Exit criteria:** ⬜ 10-day soak · ✅ zero cross-tenant leakage (T-01…T-05, T-22, T-23) · ✅ p95 ≤150 ms (1.0ms measured) · ✅ zero PII in logs (T-09) · 🟡 PL-013 go/no-go **partially** written (Q1 answered; Q2/Q3 blocked on credentials)

---

## Failed Approaches

> **Generator: read this before writing any code.** Repeating a documented failure is a rubric penalty. Max 10 lines — one line per failure, cause first, not narrative. Survives context resets and sprint restarts; append on failure, never clear.

- `raw_data->>$2` returned nothing — raw_data is parallel arrays `{headers:[...], values:[...]}`, not a key-value map (S18)
- `->>` won't take a bigint from `WITH ORDINALITY` — needs `::int` cast (S18)
- Backdating only the latest sync left an earlier successful sync still fresh (S17)
- `exactOptionalPropertyTypes` rejects JWT object form — needs positional overload (S15)
- Zod `.nullable()` without `.default(null)` still requires the key present (S10)
- RLS `WITH CHECK` rejects INSERT omitting `tenant_id` (S9)
- Evaluator mischaracterized T-18 as asserting ≤500 ms — the assertion is ≤150 ms; 100/100 score was not earned

---

## Task board

| ID | Task | Status | Notes |
|---|---|---|---|
| PL-001 | Repo scaffold + CI | ✅ Done | `npm run verify` green; rule 7 + rule 11 lint guards verified firing; 0 npm vulns |
| PL-002 | Schema + RLS | ✅ Done | 9 tables, RLS enabled+forced, `parentline_app` non-owner role, T-01..T-05 all passing |
| PL-003 | Tenant context + repository layer | ✅ Done | `withTenant` in `src/db/tenant-context.ts`, `roster-entries` + `audit-log` repositories, 7 repo tests all passing |
| PL-004 | Canonical schema + column mapping | ✅ Done | Zod schema, column-mappings repo, pure mapper, 13 tests (T-08, T-19, T-20 mapping layer) |
| PL-005 | Google Sheets connector | ✅ Done | Interface + Google impl (googleapis, service account) + fixture provider; 12 tests; integration test needs real creds |
| PL-006 | Validation + quarantine | ✅ Done | `validateRow` (time format, known codes), `ingestSheet` pipeline, quarantined-rows + roster-syncs repos, 10 unit tests + DB integration tests (T-06, T-07) |
| PL-007 | Sync scheduler + staleness guard | ✅ Done | `runSync` + `SyncScheduler` + `isRosterFresh`; migration 0002 (DELETE grants); 9 tests (T-11, T-12, T-13, T-23) |
| PL-008 | Append-only audit log | ✅ Done | T-10 passing (UPDATE/DELETE rejected at DB level); 6 audit-log tests; repo from PL-003 already complete |
| PL-009 | `getScholarStatus` service | ✅ Done | Typed refusals (stale/sync_failed/not_found/quarantined), audit on every call, parent-facing derived-hold block, 18 tests (T-14, T-15, T-16, T-18) |
| PL-010 | Structured logging | ✅ Done | JSON logger with redaction (T-09 passing); 9 logging tests; `src/logging/logger.ts` |
| PL-011 | Synthetic fixtures, two tenants | ✅ Done | `npm run seed` produces reproducible two-tenant dataset; 12 fixture tests passing |
| PL-012 | Hold derivation as config | ✅ Done | `deriveHolds` pure engine, `derivation-rules` repo, `toParentFacing` filter, 15 tests (T-21 passing) |
| PL-013 | MCP transport + auth spike | 🟡 Partial | 3/5 steps closed. Q1 answered: **no** single 401 shape works → AD-10. Steps 2 & 5 blocked on credentials |

**Legend:** ⬜ Not started · 🟡 In progress · ✅ Done · 🔴 Blocked · ⏸️ Paused

---

## Test status

See `evaluation/test.md` for definitions. Isolation tests are the gate — the sprint does not ship with any of T-01 through T-05 failing or unwritten.

All 23 T-numbered tests (T-01…T-23) written and passing. 146 individual test cases across 15 files.

| File | T-numbers | Tests |
|---|---|---|
| tests/isolation.test.ts | T-01…T-05 | 11 |
| tests/validation.test.ts | T-06, T-07 | 8 |
| tests/canonical-schema.test.ts | T-08, T-19, T-20 | 13 |
| tests/derivation.test.ts | T-21 | 15 |
| tests/logging.test.ts | T-09 | 9 |
| tests/audit-log.test.ts | T-10 | 6 |
| tests/sync.test.ts | T-11, T-12, T-13, T-23 | 9 |
| tests/service.test.ts | T-14, T-15, T-16, T-18, T-03 | 18 |
| tests/migrations.test.ts | T-17 | 4 |
| tests/cache-isolation.test.ts | T-22 | 3 |
| tests/repositories.test.ts | T-04 | 7 |
| tests/fixtures.test.ts | PL-011 | 12 |
| tests/validation-unit.test.ts | PL-006 | 10 |
| tests/connector.test.ts | PL-005 | 12 |
| tests/config.test.ts | PL-001 | 9 |
| **Total** | **23 / 23** | **146** |

---

## Session log

*Newest entry at the top. Template below — copy it, don't reformat it.*

```
### YYYY-MM-DD — session N
**Worked on:** PL-00X
**Done:** what actually landed (commits, files, migrations)
**Decisions made:** anything that changes `research/research.md` — copy it there too
**Surprises:** what didn't behave as expected
**Next action:** specific enough to start cold
```

---

### Session 19 — Corrective pass (independent review fixes)
**Worked on:** Sprint 1 corrective actions from independent review
**Done:**
- LOW 1: `src/services/scholar-status.ts` — made `hold_source` optional in `ScholarStatusResult`; omitted it from parent derived-hold-blocked path instead of returning false `'authoritative'`. `tests/service.test.ts` — updated T-21 assertion to `expect(result.hold_source).toBeUndefined()`.
- LOW 2: `tests/isolation.test.ts` — tightened T-02 and T-04 assertions from disjunctive `errored || rowCount === 0` to specific `expect(errored).toBe(true)`. Design intent (no `missing_ok` on `current_setting`) is to error, not silently filter.
- Nice-to-have: `tests/service.test.ts` — added `console.log` in T-18 to record actual p95 value. Measured p95 = 1.0ms.
- MEDIUM 3: `tests/logging.test.ts` — renamed T-09 describe block to "Redacts PII keys; string-scan covers fixture data only".
- progress.md — backfilled Failed Approaches (7 entries), fixed test-count table (146 tests across 15 files), filled decisions table (AD-10, AD-11), updated exit criteria (3 items now ✅), added deferred items.
- `npm run verify` green: typecheck + lint + 146 tests all passing.
**Decisions made:**
- `hold_source` is now optional on `ScholarStatusResult` — omitted from parent path when derived hold is blocked, present on staff and parent-authoritative paths.
- T-02/T-04 assert `errored=true` specifically — the RLS policy errors on unset `app.tenant_id` (no `missing_ok`), which is the designed behavior.
**Surprises:**
- Evaluator mischaracterized T-18 as asserting ≤500 ms when the code asserts ≤150 ms — the 100/100 score was not earned. Logged as a Failed Approach.
- Two findings drawn from the Evaluator's report were wrong (HIGH 1, HIGH 2); all findings drawn from progress.md were correct. Lesson: verify against source, not against characterization.
**Next action:** CI gate test — break T-01 deliberately, push, confirm CI reds, revert. Then start soak phase.

### Session 18 — PL-009 getScholarStatus service
**Worked on:** PL-009
**Done:**
- `src/repositories/quarantined-rows.ts` — Added `existsByStudentRef` to check if a student's row was quarantined. Queries `raw_data` jsonb ({ headers: [...], values: [...] } parallel arrays) using `jsonb_array_elements_text WITH ORDINALITY` to match header index to value position.
- `src/services/scholar-status.ts` — `getScholarStatus(client, request)`: the core read. Accepts `PoolClient` already scoped by `withTenant` (never receives `tenantId`). Checks `isRosterFresh` first → refusal if stale. Distinguishes `sync_failed` (latest sync failed, no fresh success) from `roster_stale` (sync aged out). Looks up student in `roster_entries` → if not found, checks `quarantined_rows` via `existsByStudentRef` to distinguish `row_quarantined` from `student_not_found`. All four refusals are distinct typed results (Rule 10). Every call writes exactly one audit entry (T-16). Parent callers get derived holds blocked via `toParentFacing` (Rule 9); staff see everything.
- `tests/service.test.ts` — 18 tests: T-14 (happy path), T-21 via service (parent blocked from derived hold), T-15 (four refusals: stale/sync_failed/not_found/quarantined — all distinct), T-16 (audit entries: one per call, correct fields), T-18 (p95 <150ms over 200 calls), T-03 via service (tenant isolation).
- `npm run verify` green: typecheck + lint + 139 tests all passing.
**Decisions made:**
- `sync_failed` vs `roster_stale`: if latest sync is failure AND no fresh success exists, report `sync_failed` (more actionable). Otherwise `roster_stale`.
- Parent-facing response for derived hold: returns `hold_source: 'authoritative'` with null hold fields — avoids implying a hold exists.
- `existsByStudentRef` uses `WITH ORDINALITY` + `::int` cast for jsonb array index access.
- `reason_code` and `do_not_call` are staff-only fields — never disclosed to parent callers.
**Surprises:**
- `raw_data` is stored as `{ headers: [...], values: [...] }` parallel arrays, not key-value map. Initial `raw_data->>$2` query found nothing. Fixed with `WITH ORDINALITY`.
- `->>` operator doesn't accept bigint from `WITH ORDINALITY` — needed `::int` cast.
**Next action:** Soak phase — 10 business days of monitoring.

### Session 17 — PL-007 sync scheduler + staleness guard
**Worked on:** PL-007
**Done:**
- `src/db/migrations/0002_sync_grants.sql` — DELETE grants on `roster_entries` + `quarantined_rows` to `parentline_app`. Needed for sync idempotency (clear old data before re-ingesting). RLS still enforces tenant scoping on DELETE.
- `src/repositories/roster-syncs.ts` — Added `findLatestSuccessfulSync` (filters out `outcome='failure'` so staleness counts from last good sync) and `isRosterFresh(client, freshnessMinutes)` (returns false if no successful sync or sync is past threshold).
- `src/repositories/roster-entries.ts` — Added `deleteAllEntries` (RLS-scoped delete for idempotency).
- `src/repositories/quarantined-rows.ts` — Added `deleteAllQuarantinedRows` (RLS-scoped delete for idempotency).
- `src/sync/scheduler.ts` — `runSync(pool, connector, job)`: enters `withTenant`, fetches mappings+rules, tries connector fetch. On failure: records failed sync, preserves existing data (T-13). On success: clears old entries+quarantined rows, calls `ingestSheet` (T-11 idempotency). Returns typed `SyncResult` (success | failure), never empty success (Rule 10). `SyncScheduler` class with configurable interval + school-hours guard.
- `eslint.config.js` — Override for `src/sync/scheduler.ts` allowing `tenantId` as parameter (background-job infrastructure, same role as `tenant-context.ts`). Rule 11 still enforced.
- `tests/sync.test.ts` — 9 tests: T-11 (idempotent — twice on unchanged sheet, no duplicates, distinct sync records), T-12 (fresh after sync, stale after backdate, false when no sync), T-13 (connector failure preserves entries, staleness counts from last successful sync), T-23 (tenant A/B data correctly scoped, sync records tenant-isolated).
- `npm run verify` green: typecheck + lint + 121 tests all passing.
**Decisions made:**
- Connector fetch happens BEFORE deleting old entries — if the fetch fails, existing data is preserved (T-13). Only on successful fetch do we clear + re-ingest.
- Staleness guard counts from the last *successful* sync, not the last sync. A failed sync does not reset the freshness clock (T-13). `findLatestSuccessfulSync` filters `outcome IN ('success', 'partial-success')`.
- `SyncJob` carries `tenantId` from configuration — this is background-job infrastructure, not a request-scoped argument. ESLint override scoped to `src/sync/scheduler.ts` only.
- `ingestSheet` is unchanged — the scheduler orchestrates around it (fetch config, fetch sheet, clear old data, call `ingestSheet`).
**Surprises:**
- T-12 backdate test initially failed because T-11 created two successful syncs — backdating only the latest left the second-latest still fresh. Fixed by backdating all successful syncs for the tenant.
**Next action:** PL-009 — `getScholarStatus` service.

### Session 16 — PL-006 validation + quarantine
**Worked on:** PL-006
**Done:**
- `src/validation/validate.ts` — `validateRow` function: semantic validation beyond Zod. Checks release_time format (HH:MM with valid range), known attendance statuses (Present, Absent, Tardy, Late, Early Dismissal, Excused, Unexcused), known reason codes (Excused, Unexcused, Excused W/O Notes). Returns `{ valid: true }` or `{ valid: false, reason }` with specific reason for quarantine.
- `src/repositories/quarantined-rows.ts` — `insertQuarantinedRow`, `findBySync`, `countQuarantined`. tenant_id set by RLS, never passed as value (Rule 7).
- `src/repositories/roster-syncs.ts` — `createSync`, `finalizeSync`, `findLatestSync`. Tracks started/finished timestamps, row counts, outcome (success/partial-success/failure).
- `src/repositories/roster-entries.ts` — Added `insertEntry` method so `ingestSheet` doesn't need raw query (Rule 11).
- `src/sync/ingest.ts` — `ingestSheet` function: the ingestion pipeline. Map → validate → derive → insert valid / quarantine invalid. Creates a sync record, processes each row, finalizes with counts and outcome. Partial success is normal — 3 bad rows do not fail a 200-row sync. Uses `insertEntry` and `insertQuarantinedRow` repos, no raw query.
- `tests/validation-unit.test.ts` — 10 unit tests for `validateRow` (no DB needed): valid row, all-null fields, malformed time, hours > 23, minutes > 59, single-digit hour, unknown attendance_status, unknown reason_code, all known statuses, all known reason codes.
- `tests/validation.test.ts` — DB integration tests for T-06 (dirty rows quarantine, clean rows survive, partial-success outcome, specific reasons) and T-07 (quarantined rows unreachable from `findByStudentRef`). Needs `DATABASE_URL` to run.
- `npm run verify` green: typecheck + lint + 40 non-DB tests passing.
**Decisions made:**
- Validation is a separate layer from Zod mapping. Zod catches structural issues (missing required fields, wrong types). `validateRow` catches semantic issues (time format, known codes). Both failures route to quarantine.
- Known value sets are permissive defaults — can become per-tenant config in a future sprint if campuses diverge.
- `ingestSheet` uses `insertEntry` repository method, not raw `client.query`, to comply with Rule 11.
- Sync outcome is `partial-success` when any rows are quarantined, `success` when all valid. `failure` is reserved for connector errors (PL-007).
- Quarantine reasons are staff-facing diagnostic text, never contain student data (Rule 6).
**Next action:** PL-007 — sync scheduler + staleness guard.

### Session 15 — PL-005 Google Sheets connector
**Worked on:** PL-005
**Done:**
- `src/connector/sheet-connector.ts` — `SheetConnector` interface, `SheetData` type, typed error hierarchy: `ConnectorError` (base), `ConnectorAuthError` (401/403), `ConnectorNotFoundError` (404), `ConnectorNetworkError` (network/timeout). No `tenant_id` in any signature (Rule 7).
- `src/connector/google-sheets-connector.ts` — `GoogleSheetsConnector` using `googleapis` SDK + `google-auth-library` JWT. Service account auth from `GOOGLE_SERVICE_ACCOUNT_JSON` env var. Read-only scope. Maps API errors to typed errors. Validates `client_email` + `private_key` at construction.
- `src/connector/fixture-sheet-connector.ts` — `FixtureSheetConnector` using synthetic fixtures. Supports `simulateAuthFailure` for testing auth error paths.
- `src/config.ts` — Added `GOOGLE_SERVICE_ACCOUNT_JSON` and `ROSTER_SHEET_ID` (both optional).
- `.env.example` — Uncommented and documented Google Sheets env vars.
- `package.json` — Added `googleapis` dependency.
- `tests/connector.test.ts` — 12 tests: fixture provider returns correct data for both tenants, `ConnectorNotFoundError` for unknown IDs, `ConnectorAuthError` on simulated auth failure, raw rows include advisor-notes column (exclusion is downstream in mapper), `SheetData` shape validation, `GoogleSheetsConnector` construction validation (invalid JSON, empty string, missing fields, valid construction), typed error hierarchy.
- `npm run verify` green: typecheck + lint + 30 non-DB tests passing (DB tests need `DATABASE_URL`).
**Decisions made:**
- Connector returns raw rows — column mapping and advisor-notes exclusion happen downstream in the mapper (PL-004), not at the connector. The connector's job is fetch + typed errors.
- Used `googleapis` SDK with `google-auth-library` JWT for service account auth. Positional `JWT(email, undefined, key, scopes)` overload to satisfy `exactOptionalPropertyTypes`.
- `GoogleSheetsConnector` construction validates `client_email` and `private_key` presence, throwing `ConnectorAuthError` if missing.
**Surprises:**
- `exactOptionalPropertyTypes` required using the positional JWT overload instead of the object form — the object form's `email?: string` doesn't accept `string | undefined`.
**Next action:** PL-006 — validation + quarantine.

### Session 14 — PL-010 structured logging
**Worked on:** PL-010
**Done:**
- `src/logging/logger.ts` — structured JSON logger: `createLogger(config, stream)` returns a `Logger` with `debug/info/warn/error` methods. Each log line is JSON with `level`, `time`, `tenant_id`, `request_id`, `msg`, `duration_ms`, `outcome`, and arbitrary extra fields.
- Redaction layer: recursively walks log payloads and replaces values for PII keys (`student_name`, `student_ref`, `advisor_notes`, etc.) with `[REDACTED]`. Also scans string values (including error messages and stack traces) for known student refs and names and replaces them.
- `tests/logging.test.ts` — 9 tests: T-09 (redacts student_name/ref in payloads, nested objects/arrays, interpolated in message strings, in error stack traces; tenant_id on every line; 50-lookup simulation with error paths, zero PII matches), log level filtering, duration_ms/outcome fields, advisor_notes redaction.
- `npm run verify` green: typecheck + lint + 82 tests.
**Decisions made:**
- Redaction is defense-in-depth: both key-based redaction (PII keys → `[REDACTED]`) and value-based redaction (scan strings for known student refs/names).
- Error objects are redacted by converting to `{ name, message, stack }` with each field run through the redactor.
- Logger writes to a `NodeJS.WritableStream` (defaults to `process.stdout`), enabling test capture without mocking.
**Surprises:**
- TypeScript required `as unknown as NodeJS.WritableStream` for the test mock stream — `WritableStream` has many required methods we don't need for testing.
**Next action:** PL-006 — validation + quarantine.

### Session 13 — PL-008 append-only audit log
**Worked on:** PL-008
**Done:**
- `tests/audit-log.test.ts` — 6 tests: T-10 (UPDATE rejected at DB level, DELETE rejected at DB level, INSERT+SELECT still work), audit entry integrity (all required fields recorded, tenant isolation, null subject_student_ref supported).
- The audit log infrastructure was already built in PL-002 (schema + grants: SELECT/INSERT only, UPDATE/DELETE revoked) and PL-003 (`insertAuditEntry`, `findByStudentRef` repo). PL-008's deliverable was proving the append-only enforcement is at the database level, not in application code.
- `npm run verify` green: typecheck + lint + 73 tests.
**Decisions made:**
- No new code needed — the repo and grants from PL-002/PL-003 are complete. PL-008 was a verification task.
- T-10 tests use `rejects.toThrow()` to prove the DB rejects UPDATE/DELETE, not application code.
**Surprises:**
- None — the grants from PL-002 worked exactly as designed.
**Next action:** PL-010 — structured logging.

### Session 12 — PL-012 hold derivation as config
**Worked on:** PL-012
**Done:**
- `src/repositories/derivation-rules.ts` — RLS-scoped repo for `derivation_rules` table: `findByTenant`, `insertRule`. Same pattern as `column-mappings.ts`.
- `src/derivation/derive-holds.ts` — pure `deriveHolds(row, rules)`: if `hold_type` is null and a rule matches (e.g. `attendance_status = 'Tardy'`), sets `hold_type` to derived type and `hold_source` to `'derived'`. Authoritative holds from sheet take precedence. First matching rule wins. Boolean fields compared case-insensitively as strings.
- `src/derivation/parent-facing.ts` — `toParentFacing(entry)`: returns `{ kind: 'refusal', reason: 'derived_hold_staff_only' }` for derived holds (Rule 9 enforcement), `{ kind: 'hold', ... }` for authoritative. Building block for PL-009.
- `src/db/seed.ts` — applies `deriveHolds` after `mapRow`, before insertion. Derivation rules come from fixture data.
- `tests/derivation.test.ts` — 15 tests: derivation-rules repo CRUD + tenant isolation, T-21 (derived from Tardy, derived from missing_id, authoritative preserved, no hold when no match, parent-facing block on derived, staff path retrieves both, config flip with no code change), pure engine edge cases (first match wins, authoritative precedence, no rules = no derivation).
- `npm run verify` green: typecheck + lint + 67 tests.
**Decisions made:**
- Derivation happens at **ingestion time** (after mapping, before DB insert), not at query time. `hold_source` is persisted on the row.
- Authoritative holds from the sheet's Hold Type column always take precedence over derived rules — a sheet-provided `hold_type` is never overridden.
- `ParentFacingHold` type allows `hold_type: null` in the 'hold' variant — no active hold is a valid success, not a refusal.
**Surprises:**
- Initial `ParentFacingHold` type had `hold_type: string` but `RosterEntry.hold_type` is `string | null` — typecheck caught it. Fixed by allowing null in the parent-facing type.
**Next action:** PL-008 — append-only audit log.

### Session 11 — PL-011 synthetic fixtures
**Worked on:** PL-011
**Done:**
- `src/fixtures/synthetic-data.ts` — two tenants (Campus Alpha / Campus Bravo) with different sheet headers (10 mappings each, zero shared headers), deliberately colliding student names (Jordan Smith ×2 in A + ×1 in B; Maria Gonzalez in both), 8 rows per tenant including 2 dirty rows (empty student_ref, empty student_name) for PL-006 quarantine, populated advisor-notes column ("Notes") mirroring real tracker §2e, rows exercising do_not_call=TRUE, missing_id=TRUE, authoritative holds with release_time + hold_location, derivation rule seeds (tardy→detention, missing_id→detention).
- `src/db/seed.ts` — `npm run seed` script. Idempotent (truncate + re-insert). Runs as owner to bypass RLS for seeding. Uses `mapRow` to produce canonical rows, quarantines validation failures. Updates `roster_syncs` with counts.
- `tests/fixtures.test.ts` — 12 tests: seed produces 2 tenants, different headers per tenant, colliding names across tenants, dirty rows quarantined (2 per tenant), 6 valid entries per tenant, T-19 (notes column not in roster_entries schema + notes content not leaked into any text field), T-20 (do_not_call=TRUE preserved), hold cases (authoritative holds with release_time + hold_location), missing_id rows, derivation rules seeded, reproducibility (seed twice → same counts, no duplication).
- ESLint override added for `src/db/seed.ts` (same role as `migrate.ts` — schema/seed tooling).
- `npm run verify` green: typecheck + lint + 52 tests.
**Decisions made:**
- Seed runs as owner (DATABASE_URL) not app role — the app role can't insert across tenants (RLS). This is the same pattern as test DB provisioning.
- Dirty rows are quarantined with raw JSON in `quarantined_rows.raw_data` — PL-006 will formalize the quarantine process.
- Fixtures include a `MappingSeed` type (simpler than `ColumnMapping` which has `id`/`tenant_id` from DB) for seeding column mappings.
**Surprises:**
- None — the mapper and schema from PL-004 worked cleanly with the fixture data.
**Next action:** PL-012 — hold derivation as config.

### Session 10 — PL-004 canonical schema + column mapping
**Worked on:** PL-004
**Done:**
- `src/schema/canonical-row.ts` — Zod canonical row schema (12 fields), `CanonicalRow` type, `MAPPABLE_FIELDS` set (10 mappable, 2 system-set), `MappingError` class with source row number + Zod issues.
- `src/repositories/column-mappings.ts` — `findByTenant`, `insertMapping`. RLS-scoped, `tenant_id` via `current_setting('app.tenant_id')::uuid` (Rule 7).
- `src/mapping/mapper.ts` — pure `mapRow(headers, values, mappings, rowNumber) → CanonicalRow`. Boolean coercion for checkboxes, empty-string-to-null for nullable fields, unmapped columns silently ignored (advisor-notes excluded by omission).
- `tests/canonical-schema.test.ts` — 13 tests: column-mapping repo CRUD + isolation, T-08 (different headers → identical canonical rows), T-19 (notes excluded from canonical row), T-20 (do_not_call/missing_id boolean coercion), mapper edge cases (validation failure, MappingError carries row number, hold_source default, unmapped columns ignored).
- `npm run verify` green: typecheck + lint + 40 tests.
**Decisions made:**
- Nullable fields use `.nullable().default(null)` and booleans use `.default(false)` in Zod — unmapped fields get sensible defaults instead of failing validation. Only `student_ref` and `student_name` are required (min 1).
- 1:1 header→field mapping only. Combining first/last name is the connector's job (PL-005). No composite fields, no inference (AD-6).
- `hold_source` defaults to `'authoritative'`; PL-012 derivation will override to `'derived'`. `source_row_number` is sync metadata, never mappable.
- `CanonicalRow` is a separate type from `RosterEntry` — logical schema pre-DB vs DB row with id/tenant_id/sync_id.
**Surprises:**
- Initial Zod schema without defaults on nullable fields caused validation failures for unmapped fields — `z.string().nullable()` still requires the key to be present. Fixed with `.default(null)`.
**Next action:** PL-011 — synthetic fixtures, two tenants.

### Session 9 — PL-003 tenant context + repository layer
**Worked on:** PL-003
**Done:**
- `src/db/tenant-context.ts` — real `withTenant(pool, tenantId, fn)`: acquires connection, sets `app.tenant_id` via `set_config`, runs callback, resets before releasing. ESLint override for both Rule 7 and Rule 11 (infrastructure, like auth layer + migration runner).
- `src/repositories/roster-entries.ts` — `findByStudentRef`, `findByStudentName`, `countEntries`. All accept a `PoolClient` already scoped by `withTenant` — never acquire their own connection.
- `src/repositories/audit-log.ts` — `insertAuditEntry` (uses `current_setting('app.tenant_id')::uuid` for the `tenant_id` column, never a caller-supplied value), `findByStudentRef`. Append-only enforced at DB grant level.
- `tests/repositories.test.ts` — 7 tests: repo methods within tenant context, cross-tenant isolation, audit insert + retrieval, `withTenant` pool reset verification.
- Removed test-only `withTenant` from `tests/helpers/db.ts`; T-04 now imports the real one from `src/`.
- `npm run verify` green: typecheck + lint + 27 tests.
**Decisions made:**
- `withTenant` lives in `src/db/` not `src/auth/` — it's infrastructure that the auth layer calls after deriving the tenant from the session. The ESLint override is scoped to this single file.
- Repository methods accept `PoolClient` rather than `Pool` — they never acquire their own connection, which would bypass the tenant context.
- `insertAuditEntry` uses `current_setting('app.tenant_id')::uuid` as the INSERT value for `tenant_id` — RLS `WITH CHECK` requires it, and it can't be a caller-supplied parameter (Rule 7).
**Surprises:**
- RLS `WITH CHECK` (which defaults to `USING`) rejects INSERTs that don't include `tenant_id` matching the session variable. The `audit_log` INSERT initially omitted `tenant_id`, causing "new row violates row-level security policy."
**Next action:** PL-004 — canonical schema + column mapping.

### Sessions 0–8 (compacted)
- **S0:** Sprint harness created, scoped to deterministic core (no voice/LLM/MCP).
- **S1:** Alexa+ MCP review — AD-1 (one server, two clients), AD-8 (Streamable HTTP + OAuth 2.1), AD-9 (versioned tool schemas). 500 ms budget discovered.
- **S2:** Reference impl survey — no Amazon sample needed. 401 divergence found (spec MUST vs Alexa+ absent). Leaning managed AS.
- **S3:** Source schema review — advisor-notes excluded at connector (F-3), do_not_call canonical (F-4). eSD is system of record. Redo has no data source.
- **S4:** Sprint optimization — PL-012 (detention derived from Tardy/Missing ID), PL-013 (throwaway MCP spike), latency promoted to exit criterion.
- **S5:** Harness restructure — artifacts moved to routed paths, Sprint Contract written, T-14/T-22/T-23 added, Failed Approaches section created.
- **S6:** PL-013 spike — AD-10 (401 varies by client). No SDK needed. Q2/Q3 blocked on credentials.
- **S7:** PL-001 scaffold — package.json, tsconfig, eslint (Rules 7+11 lint-enforced), vitest, CI. 0 npm vulns.
- **S8:** PL-002 schema + RLS — 9 tables, RLS enabled+forced, parentline_app non-owner. T-01..T-05 passing. `set_config` for tenant_id.

## Decisions made mid-sprint

*Anything settled here must also land in `research/research.md` §3. This section is the changelog; `research/research.md` is the source of truth.*

| Date | Decision | Why | Copied to research/research.md |
|---|---|---|---|
| S6 | AD-10: 401 response varies by client | MCP spec MUST vs Alexa+ absent — no single shape works | ✅ §4 line 209 |
| S6 | AD-11: Real Postgres, not necessarily Testcontainers | Need real DB with controlled role/ownership; CI pins version via `services:` | ✅ §4 line 211 |

---

## Deferred to a later sprint

*Things surfaced during the sprint that are real but out of scope. Capture, don't build.*

| Item | Surfaced | Target sprint |
|---|---|---|
| Production redaction must not rely on hardcoded name/ref lists — key-based redaction is the primary defense (T-09 string-scan covers fixture data only) | S18 corrective pass | Sprint 2 |
| CI gate has not been observed failing — break T-01 deliberately, confirm CI reds, revert | S18 corrective pass | Sprint 1 (before soak) |

---

## Definition of sprint complete

- [ ] All 13 tasks ✅
- [ ] All 23 tests written and passing
- [ ] Migrations run clean from empty on a fresh database
- [ ] `getScholarStatus` correct for 10 consecutive business days
- [ ] Zero cross-tenant leakage across the full test suite
- [ ] Zero student PII found in logs
- [ ] `research/research.md` updated with everything learned
- [ ] Sprint 2 scope drafted (MCP server for staff)