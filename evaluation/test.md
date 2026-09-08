# test.md — Sprint 1

> **The gate:** T-01 through T-05 are cross-tenant isolation tests. The sprint does not ship with any of them failing or unwritten. Everything else can slip; these cannot.

---

## Strategy

**Real Postgres, not a mock.** Row-level security is a database behavior. A mocked query layer will pass every isolation test while the real system leaks.

**A real database, not necessarily a container** *(revised — see `research/research.md` AD-11)*. The suite provisions a uniquely-named database per run against any reachable Postgres 15+, applies migrations as an owner role, and connects as a separate **non-owner, non-superuser** app role. Testcontainers is a valid drop-in but is not required; it buys hermeticity and parallelism, not correctness.

**The application role must not own the tables.** Table owners and superusers bypass RLS silently. If tests run as the owner, T-01 passes and production leaks.

**T-05 is a blocking precondition, not just a test.** It runs first. If the app role is superuser, owns the RLS tables, or any table lacks `FORCE ROW LEVEL SECURITY`, the run **aborts** and no other isolation result is reported as trustworthy. This matters more on a local Postgres than in a container, because a developer's default role is typically a superuser — the suite must refuse to run as one rather than pass vacuously.

**Two tenants in every fixture, with colliding student names.** Campus A and Campus B both have a "Daniel Reyes." If a query forgets its tenant filter, a single-tenant fixture returns plausible-looking correct data and the bug ships. Name collision is what makes the leak visible.

**Test the refusals harder than the successes.** The dangerous failure here is not an error — it's a confident answer built from stale, quarantined, or wrong-tenant data. Every refusal path gets an explicit test proving it is distinguishable from success.

**Synthetic data only.** No real student names, refs, or exports in fixtures. Ever.

---

## Isolation — T-01 to T-05 (the gate)

### T-01 · RLS scopes reads to the active tenant
Seed roster entries for A and B. Set `app.tenant_id` to A. `select * from roster_entries` with no where clause.
**Pass:** only A's rows. **Fail (critical):** any B row.

### T-02 · Unset tenant context does not return everything
Acquire a connection without setting `app.tenant_id`. Query `roster_entries`.
**Pass:** query errors — the RLS policy uses `current_setting('app.tenant_id')::uuid` with no `missing_ok`, so an unset session variable raises an error rather than silently returning zero rows. **Fail (critical):** returns all tenants' rows, or silently returns zero rows (silent filtering could mask a context bug).

### T-03 · Name collision does not cross tenants
A and B each have a "Daniel Reyes" with different statuses. Look up "Daniel Reyes" under tenant A.
**Pass:** A's Daniel, A's status. **Fail (critical):** B's record, or two results.

### T-04 · Pool does not leak tenant context
Run `withTenant(A, …)`, release the connection, then acquire a connection and query **without** setting a tenant.
**Pass:** behaves as T-02 — query errors (no tenant context set). **Fail (critical):** A's rows, because `app.tenant_id` survived in the pooled connection.

### T-05 · Application role cannot bypass RLS — **runs first, aborts the run on failure**
Assert the connected role is not superuser, does not own the RLS tables, and that `FORCE ROW LEVEL SECURITY` is set on each.
**Pass:** all assertions hold. **Fail (critical):** abort immediately — every other isolation test is meaningless, and reporting them as green is worse than reporting nothing.

---

## Validation and quarantine — T-06 to T-08

### T-06 · Dirty rows quarantine, clean rows survive
Sheet with 200 rows: one malformed release time, one blank student name, one unknown reason code.
**Pass:** 197 valid roster entries, exactly 3 quarantine records, each with its source row number and specific reason. Sync outcome is partial-success, not failure.

### T-07 · Quarantined rows are unreachable from lookup
Quarantine a row for a student, then call `getScholarStatus` for that student.
**Pass:** a typed refusal ("can't confirm — see staff"), never the quarantined values.

### T-08 · Different headers, identical canonical rows
Campus A uses `Scholar` / `Out Time`; Campus B uses `Student Name` / `Release`. Both mapped via `column_mappings`.
**Pass:** byte-identical canonical output for equivalent input.

---

## Privacy — T-09 to T-10

### T-09 · No student PII in logs
Capture all log output across a full sync and 50 lookups, including forced error paths. Scan for fixture student names and refs.
**Pass:** zero matches; `tenant_id` present on every line.
*Include error paths deliberately — stack traces echoing row data are the usual culprit.*

### T-10 · Audit log is append-only at the database
Attempt `update` and `delete` on `audit_log` as the application role.
**Pass:** both rejected by Postgres. **Fail:** rejected only by application code — that's a convention, not a guarantee.

---

## Sync — T-11 to T-13

### T-11 · Sync is idempotent
Run sync twice against an unchanged sheet.
**Pass:** no duplicate roster entries; second run recorded as a distinct sync with unchanged results.

### T-12 · Staleness guard refuses stale rosters
Sync, advance the clock past the freshness threshold, call `getScholarStatus`.
**Pass:** typed stale refusal, distinguishable from not-found. **Fail (critical):** returns the stale answer as if current.

### T-13 · Upstream failure does not corrupt good data
Force the Sheets connector to fail mid-sync (auth error, then a timeout).
**Pass:** previous roster intact, sync recorded as failed, staleness guard begins counting from the last *successful* sync — not this one.

---

## Service — T-14 to T-18

### T-14 · Happy path
Fresh roster, valid student, an active **derived detention** (Tardy or Missing ID).
**Pass:** correct status, release time, reason, and `hold_source: derived`. Audit entry written.
*Originally written as "active redo entry." Redo is deferred this sprint — it has no source in the tracker (`research/research.md` §2e F-2) — so the original wording described a state the system cannot reach and the test could never go green. Detention is what Sprint 1 actually ships.*

### T-15 · The four refusals are distinguishable
Stale roster · student not found · sync failed · row quarantined.
**Pass:** four distinct typed results. **Fail (critical):** any two collapse into the same shape, or any returns an empty success. *Empty-as-success is the silent failure this whole sprint exists to prevent.*

### T-16 · Every read is audited
Run all of T-14 and T-15, then count audit rows.
**Pass:** one entry per call — successes *and* refusals — with actor, subject, fields disclosed, and outcome.

### T-17 · Migrations run clean from empty
Fresh database, run all migrations, then the full suite.
**Pass:** no manual steps, no errors, suite green.

### T-18 · `getScholarStatus` holds the latency budget
*(Added after the Alexa+ MCP review — see `research/research.md` §3a.)* Warm pool, seeded roster at realistic size, 200 sequential calls.
**Pass:** p95 ≤150 ms, leaving headroom for transport, auth, and network in Sprint 2.
**Fail:** at or near 500 ms. Alexa+ enforces the ceiling on the *entire* round trip, so the database read must be a fraction of it.

---

## Source schema and derivation — T-19 to T-21

### T-19 · Advisor-notes column never leaves the connector
*(Added after the source-schema review — `research/research.md` §2e F-3.)* Seed a fixture whose notes column contains sensitive free text. Run sync, then call `getScholarStatus`.
**Pass:** the notes value appears in no canonical row, no service response, and no log line. **Fail (critical):** it appears anywhere downstream. This column carries health and family detail; exclusion happens at ingestion, not by filtering later.

### T-20 · `DO NOT CALL` survives ingestion intact
*(§2e F-4.)* Fixture rows with the flag set and unset.
**Pass:** the flag lands on the canonical row and is queryable. It is a hard guardrail on proactive contact in later sprints, so losing it in ingestion is a silent policy failure.

### T-21 · Derived holds are marked and never parent-facing
*(Added in plan rev 2 — see PL-012 and `research/research.md` §2e F-2.)* Seed a scholar whose detention is *derived* (Tardy or Missing ID) with no authoritative hold column, and a second whose hold is authoritative.
**Pass:** both carry a correct `hold_source` (`derived` / `authoritative`); the derived one is retrievable on the staff path and **blocked on any parent-facing path** — `hold_source` is omitted entirely from the parent-facing response when a derived hold is blocked, not set to a false value.
**Fail (critical):** a derived hold is indistinguishable from an authoritative one. Staff may have waived the detention — telling a parent their child is being held, on an inference, is the exact failure this project exists to avoid.

---

## Remaining leak vectors — T-22 to T-23

*`research/research.md` §7 lists seven cross-tenant leak vectors and claims each has a test here. Vectors 2 and 3 did not. These close that gap; vectors 6–7 remain Sprint 2, since they need the MCP server to exist.*

### T-22 · Cache keys are tenant-scoped *(leak vector 2)*
With any caching or memoization in the read path, warm the cache under tenant A for a student ref that exists in **both** tenants, then perform the same lookup under tenant B.
**Pass:** B receives B's record. **Fail (critical):** B receives A's cached value. *If no cache exists yet, this test asserts that — so that adding one later cannot silently bypass RLS, which lives in the database and cannot see a cache hit.*

### T-23 · Background jobs run inside tenant context *(leak vector 3)*
The scheduled sync (PL-007) is a background job that writes student data with no HTTP request to derive tenant from. Invoke it directly, outside any request scope.
**Pass:** it establishes tenant context explicitly via `withTenant` and writes only that tenant's rows; a run with no tenant resolved fails loudly rather than writing unscoped. **Fail (critical):** rows land with a wrong or null `tenant_id`, or the job writes across tenants in one pass.

---

## Running

```bash
npm run test              # full suite (real Postgres, database-per-run)
npm run test:isolation    # T-01..T-05 only — run before every commit
npm run verify            # typecheck + lint + test — CI gate
```

Requires a reachable Postgres 15+ and a role that may create databases and roles.
Set `DATABASE_URL` (admin connection); the suite derives the per-run database and
the non-owner app role from it. CI pins the version via GitHub Actions `services:`.

CI blocks merge on any failure. **Any isolation failure is a stop-the-line event**, not a ticket.

---

## Deliberately not tested this sprint

Voice, Alexa, LLM output quality, MCP tools, parent verification, email, calendar. Out of scope per `planning/plan.md`.

**Queued for Sprint 2** — two leak vectors added by the Alexa+ review (`research/research.md` §7, vectors 6–7). Both are untestable until the MCP server exists, and both are critical when it does:

- **Over-disclosure in a tool response.** Alexa+ runs Amazon's model, not ours. Any field we return may be spoken aloud immediately. Test that an unverified caller's response payload *omits* the reason field entirely rather than returning it with a caveat.
- **`tenant_id` as a tool argument.** An external model fills tool arguments. Test that no tool schema accepts a tenant parameter, and that a forged one in the payload is ignored in favor of the token-derived value.

---

## Adding tests

Append with the next ID. If a test is added because something broke in real use, note that in the description — it's the difference between a test someone imagined and a test that caught a live bug, and it changes how seriously the next person takes a failure.