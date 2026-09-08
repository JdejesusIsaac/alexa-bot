# plan.md — Sprint 1: Parent Line Core

**Rev 2 — optimized after the Alexa+ MCP, reference-implementation, and source-schema reviews.**

**Sprint goal**

> Ingest one campus's attendance tracker on a schedule, validate every row, store it under enforced tenant isolation, and answer scholar-status queries correctly, fast, and auditably — with detention **derived** from existing columns and marked provisional, academic redo deferred, and no voice or LLM anywhere in the path.

**Duration:** 2 weeks (see *Capacity* below)
**Exit criteria:**
1. `getScholarStatus` correct for 10 consecutive business days against a synthetic mirror of the real sheet
2. Zero cross-tenant leakage across the full suite
3. p95 latency ≤150 ms
4. Zero student PII in logs; every read audited
5. The MCP spike (PL-013) has returned a written go/no-go on transport and auth

---

## What changed in this revision, and why

| Change | Driver |
|---|---|
| Goal now says **detention derived, redo deferred** | `research/research.md` §2e F-2 — redo has no source in the tracker; the original goal promised something the data can't support |
| Added **PL-012** (hold derivation as config) | Detention *is* derivable today from Tardy + Missing ID, so Sprint 1 no longer waits on leadership approval of new columns |
| Added **PL-013** (MCP walking-skeleton spike) | AD-8 + §2d — the 401 divergence and Alexa+ eligibility are the two unknowns that could invalidate the architecture. Failing to learn them now costs weeks later |
| Latency promoted to an **exit criterion** | §3a — the Alexa+ 500 ms ceiling covers the whole round trip, so the read must be a fraction of it |
| PL-004 canonical schema extended; notes column **excluded at the connector** | §2e F-3, F-4 |

---

## Why this scope

The riskiest thing Parent Line does is say something true about the right child to the right adult. Voice, language, and conversation are presentation on top of that. Sprint 1 builds the part where being wrong is unacceptable, with zero model variance, so failures are deterministic and debuggable.

The Alexa+ review reinforced this rather than changing it: a 500 ms round-trip budget means the read path can never contain a model call. **What we build here is the final architecture for that path, not a placeholder.**

---

## In scope

- Tenant model with Postgres RLS (forced), two seeded tenants
- Repository layer that makes an untenanted query impossible to write
- Canonical roster schema + per-tenant column mapping config
- Google Sheets connector (read-only), with the advisor-notes column excluded at ingestion
- Row validation + quarantine queue
- Scheduled sync + staleness guard
- Append-only audit log
- `getScholarStatus` — the core read
- Config-driven hold derivation, flagged provisional
- Structured logging with `tenant_id`, no PII
- A timeboxed, throwaway MCP transport/auth spike
- CI: typecheck, lint, test, migrations-run-clean

## Explicitly out of scope

Voice / Alexa runtime · Claude or any LLM call · **the production MCP server** (Sprint 2) · parent identity verification · email · calendar booking · onboarding UI · Spanish · multi-campus rollout

> Out of scope means **do not scaffold it "for later."** Speculative structure for unbuilt features is how the isolation rules get quietly bypassed. PL-013 is the one exception, and it is explicitly throwaway.

---

## Tasks

Dependencies in brackets. PL-002 and PL-003 gate everything.

### PL-001 — Repo scaffold + CI
TypeScript, Node 20, strict mode. Vitest, ESLint, Prettier. GitHub Actions: typecheck → lint → test → migrations. `.gitignore` covers `.env`, `*.csv`, `*.xlsx`, `/fixtures/real/`.
**AC:** `npm run verify` green on a clean clone. CI blocks merge on failure.

### PL-002 — Schema + RLS [PL-001]
Tables: `tenants`, `students`, `authorized_contacts`, `roster_entries`, `roster_syncs`, `quarantined_rows`, `audit_log`, `column_mappings`, `derivation_rules`.
Every student-data table carries `tenant_id uuid not null`. RLS **enabled and FORCED**, policy `tenant_id = current_setting('app.tenant_id')::uuid`. The application role is not superuser and does not own the tables — owners bypass RLS.
**AC:** with `app.tenant_id` set to tenant A, a bare `select * from roster_entries` returns only A's rows. Unset session variable → query errors rather than returning everything.

### PL-003 — Tenant context + repository layer [PL-002]
`withTenant(tenantId, fn)` acquires a connection, sets `app.tenant_id`, runs the callback, and **resets the variable before returning the connection to the pool**. All data access goes through repositories requiring a tenant context; no exported raw query helper.
**AC:** a lint rule or architecture test fails the build if `pool.query` is called outside the repository layer. T-04 passes.

### PL-004 — Canonical schema + column mapping [PL-003]
Zod schema for a canonical roster row: `student_ref`, `student_name`, `section`, `attendance_status`, `reason_code`, `hold_type`, `hold_source`, `release_time`, `hold_location`, `do_not_call`, `missing_id`, `source_row_number`.
`column_mappings` stores per-tenant header → canonical field as explicit config. No inference.
**Excluded by design:** the advisor-notes free-text column is dropped at the connector and never enters a canonical row (§2e F-3). `do_not_call` is carried through as required (F-4).
**AC:** two tenants with different sheet headers map to identical canonical rows. T-19 and T-20 pass.

### PL-005 — Google Sheets connector [PL-004]
Read-only OAuth scope. Fetch by sheet ID + range, return raw rows. Credentials from env, never committed. Behind an interface so a fixture provider replaces it in tests.
**AC:** pulls a test sheet; auth failure surfaces as a typed error, not a crash.

### PL-006 — Validation + quarantine [PL-005]
Every row validated against the canonical schema. Failures go to `quarantined_rows` with source row number and specific reason. **Quarantined rows are never readable by the status lookup.** Partial success is normal — 3 bad rows do not fail a 200-row sync.
**AC:** a sheet with malformed times, blank names, and an unknown reason code produces exactly 3 quarantine entries and N−3 valid rows.

### PL-007 — Sync scheduler + staleness guard [PL-006]
Scheduled sync (default every 15 min, school hours). Each run writes a `roster_syncs` record: started, finished, rows in/valid/quarantined, outcome. `isRosterFresh(tenantId)` returns false past the threshold (default 45 min).
**AC:** sync is idempotent — twice on an unchanged sheet produces no duplicates. Clock advanced past threshold → freshness false.

### PL-008 — Append-only audit log [PL-003]
Every read of student data writes: timestamp, tenant, actor, action, subject student, fields disclosed, outcome. `update` and `delete` revoked at the DB grant level.
**AC:** an attempted `update` on `audit_log` fails at the database, not in application code.

### PL-009 — `getScholarStatus` service [PL-007, PL-008, PL-012]
The core read. Given a tenant context and a student reference, returns hold status, type, release time, location, `hold_source`, and `do_not_call` — or a typed refusal.
Refusal cases: roster stale · student not found · sync failed · row quarantined. Each distinguishable; **no case returns an empty success.**
**AC:** all four refusals return distinct typed results. Every call — success or refusal — writes an audit entry. T-18 (latency) passes.

### PL-010 — Structured logging [PL-003]
JSON logs with `tenant_id`, request id, duration, outcome. Redaction layer strips student names and refs. Error paths included — stack traces must not echo row data.
**AC:** T-09 finds no student identifiers anywhere in captured log output.

### PL-011 — Synthetic fixtures, two tenants [PL-004]
Two campuses with different headers, **deliberately colliding student names**, a dirty-data sheet for PL-006, and rows exercising every hold and refusal case. Mirror the real tracker's column shape — including a populated notes column, so T-19 has something to prove is excluded. **Synthetic only.**
**AC:** `npm run seed` produces a reproducible two-tenant dataset.

### PL-012 — Hold derivation as config [PL-004] 🆕
The school's existing rule — Attendance = `Tardy` **or** `Missing ID` checked → detention — is deterministic and derivable from columns that exist **today**. Implement it as a per-tenant `derivation_rules` config, not hardcoded logic.
Every canonical row carries `hold_source`: `derived` or `authoritative`. When leadership approves the proposed `Hold Type` column, the mapping switches to authoritative with no code change.
**Critical:** a *derived* hold is an inference — staff may have waived it. Derived holds are **staff-facing only** and must never reach a parent-facing surface. This is enforced in the service, not by convention.
**AC:** T-21 passes. Flipping a tenant's config from derived to authoritative changes behavior with no deploy.

### PL-013 — MCP transport + auth spike [PL-001] 🆕 ⏱️ **timeboxed: 1 day, throwaway**
A walking skeleton proving the Sprint 2 foundation before we commit to it. **Not production code. No student data. Deleted or archived at sprint end.**

Starting from the official TypeScript SDK's `examples/server` (`simpleStreamableHttp.ts --oauth --oauth-strict`, §2d):
1. Stand up Streamable HTTP with one trivial tool (`whoami`)
2. Wire a managed authorization server (Cognito/Auth0/Okta) with PKCE S256
3. Serve the PRM document (RFC 9728) and `/.well-known/oauth-authorization-server`
4. **Test the 401 divergence** — Alexa+ requires 401 *without* `WWW-Authenticate`; other MCP clients prefer it *present*. Confirm one 401 shape works for both clients (§2d)
5. Confirm Alexa+ eligibility and whether a **private/org-scoped distribution path** exists (open question 1)

**AC:** a one-page written finding in `research/research.md` answering: does one 401 shape serve both clients? Which AS? Can we deploy privately? **A "no" on any of these is a success** — it reshapes Sprint 2 before we've built it.

---

## Sequencing

```
PL-001 ─┬→ PL-002 → PL-003 ─┬→ PL-004 ─┬→ PL-005 → PL-006 → PL-007 ─┬→ PL-009
        │                   ├→ PL-008 ──────────────────────────────┘
        │                   ├→ PL-010
        │                   ├→ PL-011
        │                   └→ PL-012 ─────────────────────────────→ PL-009
        └→ PL-013 (parallel, timeboxed, independent)
```

**Week 1:** PL-001 → PL-004, plus PL-011 and PL-012. Run PL-013 early in the week — its findings are worth most when there's still time to act on them.
**Week 2:** PL-005 → PL-010, harden, 10-day soak begins.

---

## Definition of Done (every task)

- [ ] Tests written and passing, including isolation cases where relevant
- [ ] No `tenant_id` accepted as an argument from outside the auth layer
- [ ] Reads of student data emit an audit entry
- [ ] Failure path returns a typed refusal, never an empty success
- [ ] No student PII in logs
- [ ] Advisor-notes content appears nowhere downstream
- [ ] `npm run verify` green
- [ ] `implementation/progress.md` updated

---

## Risks

| Risk | Mitigation |
|---|---|
| RLS misconfigured — app role owns tables and silently bypasses policy | T-01/T-02/T-05 against real Postgres in CI |
| Pool leaks tenant context between requests | Explicit reset in `withTenant`; T-04 |
| **Derived detention spoken to a parent as fact** | `hold_source` on every row; service-level block; T-21 |
| **Alexa+ auth or distribution turns out unworkable** | PL-013 surfaces it in week 1, not Sprint 2 |
| Latency can't hold under the Alexa+ ceiling | T-18 from PL-009 onward; promoted to exit criterion |
| Sheet structure changes mid-sprint | Mapping is config; failures quarantine rather than crash |
| Redo ingestion decision slips | Sprint 1 ships detention-only; redo is additive when Q10 resolves |
| Real student data reaches the repo | `.gitignore` + synthetic fixtures + review checklist item |

---

## Dependencies outside the team

| Item | Blocks | Owner |
|---|---|---|
| Stack + AS confirmation (`research/research.md` §5, Q9) | PL-001, PL-013 | Juan |
| Tracker column proposal approval | Switching `hold_source` to authoritative — **not Sprint 1** | Leadership |
| Academic redo ingestion route (Q10) | Redo status entirely | Leadership |
| Alexa+ security & data policies (§3f) | Any voice work — **not Sprint 1** | Amazon |

**Nothing outside the team blocks Sprint 1 from starting today.** That's deliberate.

---

## Capacity — an honest note

Two weeks assumes real working time on this. If the CCAR-P study plan is running concurrently at 120 min/day, these compete directly.

Two options: run Parent Line **as** the CCAR-P capstone ("Atlas") — the certification requires tool integration, retrieval, structured output, auth/authz, an eval harness, guardrails, escalation, and a threat model, and this project produces every one of them — or accept three weeks instead of two. Trying to do both separately at full pace will quietly degrade both.

---

## Not building yet, and why

**Production MCP server (Sprint 2).** PL-013 proves the foundation; the real server is built on a stable core. Per AD-8 it must meet Alexa+ requirements from its first commit — Streamable HTTP, OAuth 2.1 + PKCE (S256), sub-500 ms. Retrofitting transport or auth later is a rewrite.
**Parent verification (Sprint 3).** Method undecided (Q6). Alexa+ doesn't support OAuth Step-Up, so tiering lives in our own session state (§3c). Design in Sprint 2.
**Academic redo.** No data source exists (§2e F-2). Blocked on Q10.
**Anything voice (Sprint 3+).** Three gates in §6, including Amazon's unpublished security policies.