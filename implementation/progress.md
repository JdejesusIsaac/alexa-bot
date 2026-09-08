# progress.md — Sprint 1

> **Agent: update this file at the end of every working session.** Append to the log, refresh the state table, and set "Next action" to something specific enough that a fresh session can start cold. This file is how continuity survives a context reset.

**Sprint:** 1 — Parent Line Core
**Started:** _(fill in)_
**Status:** 🟡 In progress — PL-001 done, PL-002 next

---

## Current state

**Next action:** **PL-002 — schema + RLS.** Write `src/db/migrations/0001_*.sql` creating the nine tables with `tenant_id uuid not null`, RLS **enabled AND forced**, and a non-owner `parentline_app` role. Then T-05 first (as a blocking precondition), then T-01…T-04.

**Task order** (derived from the `planning/plan.md` DAG — follow this unless a dependency changes):

```
PL-001 ✅ → PL-002 → PL-003 → PL-004 → PL-011 → PL-012 → PL-008 → PL-010 → PL-005 → PL-006 → PL-007 → PL-009
                     └─ PL-002 + PL-003 gate everything; do not start others before both are done
                        PL-009 is last: it needs PL-007 + PL-008 + PL-012
                        PL-005 is BLOCKED on Google Sheets OAuth creds + a test sheet
                        PL-013 ✅ partial (throwaway spike, runs independently)
```

**Blocked on:** nothing for PL-001–PL-004. **Resolved:** the container-runtime blocker is gone — AD-11 replaces Testcontainers with a real local Postgres (16.14 already running) and a database-per-run, with T-05 promoted to a blocking precondition because a dev superuser silently bypasses RLS. PL-005 still needs Google Sheets OAuth credentials and a test sheet. Open question 9 (authorization server) is Sprint 2, not this sprint.

**Soak status:** not started · 0 / 10 business days

**Exit criteria:** ⬜ 10-day soak · ⬜ zero cross-tenant leakage · ⬜ p95 ≤150 ms · ⬜ zero PII in logs · 🟡 PL-013 go/no-go **partially** written (Q1 answered; Q2/Q3 blocked on credentials)

---

## Failed Approaches

> **Generator: read this before writing any code.** Repeating a documented failure is a rubric penalty. Max 10 lines — one line per failure, cause first, not narrative. Survives context resets and sprint restarts; append on failure, never clear.

*(none yet — Sprint 1 has not begun implementation)*

---

## Task board

| ID | Task | Status | Notes |
|---|---|---|---|
| PL-001 | Repo scaffold + CI | ✅ Done | `npm run verify` green; rule 7 + rule 11 lint guards verified firing; 0 npm vulns |
| PL-002 | Schema + RLS | ⬜ Not started | Gates everything |
| PL-003 | Tenant context + repository layer | ⬜ Not started | Gates everything |
| PL-004 | Canonical schema + column mapping | ⬜ Not started | |
| PL-005 | Google Sheets connector | ⬜ Not started | Needs a test sheet + OAuth creds |
| PL-006 | Validation + quarantine | ⬜ Not started | |
| PL-007 | Sync scheduler + staleness guard | ⬜ Not started | |
| PL-008 | Append-only audit log | ⬜ Not started | |
| PL-009 | `getScholarStatus` service | ⬜ Not started | Headline deliverable. Needs PL-012 |
| PL-010 | Structured logging | ⬜ Not started | |
| PL-011 | Synthetic fixtures, two tenants | ⬜ Not started | Colliding names across tenants |
| PL-012 | Hold derivation as config | ⬜ Not started | Detention derived; `hold_source` flag |
| PL-013 | MCP transport + auth spike | 🟡 Partial | 3/5 steps closed. Q1 answered: **no** single 401 shape works → AD-10. Steps 2 & 5 blocked on credentials |

**Legend:** ⬜ Not started · 🟡 In progress · ✅ Done · 🔴 Blocked · ⏸️ Paused

---

## Test status

See `evaluation/test.md` for definitions. Isolation tests are the gate — the sprint does not ship with any of T-01 through T-05 failing or unwritten.

| Group | Written | Passing |
|---|---|---|
| Isolation (T-01…T-05) | 0 / 5 | 0 / 5 |
| Validation (T-06…T-08) | 0 / 3 | 0 / 3 |
| Source schema (T-19…T-20) | 0 / 2 | 0 / 2 |
| Derivation (T-21) | 0 / 1 | 0 / 1 |
| Privacy (T-09…T-10) | 0 / 2 | 0 / 2 |
| Sync (T-11…T-13) | 0 / 3 | 0 / 3 |
| Service (T-14…T-18) | 0 / 5 | 0 / 5 |
| Leak vectors (T-22…T-23) | 0 / 2 | 0 / 2 |
| **Total** | **0 / 23** | **0 / 23** |

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

### Session 7 — PL-001 scaffold + CI
**Worked on:** PL-001, stack amendment (AD-11)
**Done:**
- Amended §5 stack table and `evaluation/test.md` strategy: **Testcontainers → real local Postgres, database-per-run**. Docker is no longer required. T-05 promoted to a **blocking precondition** that aborts the run.
- Scaffolded: `package.json`, `tsconfig.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json`, `.env.example`, `README.md`, `.github/workflows/ci.yml` with a Postgres 16 `services:` container.
- `src/config.ts` — Zod-validated env with **two** database URLs (owner vs non-owner app role); `APP_DATABASE_URL` is mandatory in production. 9 tests, all passing.
- `src/db/migrate.ts` — transactional migration runner, idempotent, verified against local `parentline_dev`.
- `npm run verify` green. `npm audit` **0 vulnerabilities**.
**Decisions made:**
- **Rules 7 and 11 are now lint-enforced, not conventions.** `no-restricted-syntax` blocks `.query(` outside `src/repositories/` and blocks `tenantId`/`tenant_id` in exported signatures outside `src/auth/`. **Verified firing** with throwaway probe files: `src/services/` → both errors; `src/repositories/` → query allowed, tenant param still blocked.
- Rule 11 exception is scoped to the single file `src/db/migrate.ts`, not `src/db/**` — a directory-wide exception would be a loophole big enough to park application queries in.
- `vitest.config.ts` sets `fileParallelism: false` and `bail: 1` — parallel files would race on per-run database/role creation, and bail stops a vacuous green after the T-05 precondition fails.
**Surprises:**
- Initial install carried a **critical** advisory (`@vitest/mocker` arbitrary file read/execute) plus a high in `vite`. Both dev-only and gated on the Vitest UI server, which we don't run — but bumping vitest 2.1.9 → 3.2.x cleared all 5 to zero. Worth doing on a project handling student records rather than carrying a known critical.
- CI needed `npm run migrate` to exist, which pulled a minimal migration runner into PL-001 slightly ahead of PL-002.
**Next action:** PL-002 — schema + RLS, then the isolation gate.

### Session 6 — PL-013 spike
**Worked on:** PL-013, `research/research.md` → rev 5
**Done:** Built the throwaway walking skeleton in `spike/pl-013-mcp-auth/` — plain `node:http`, no SDK needed, no database, no student data. Streamable HTTP MCP with a no-argument `whoami` tool, PRM document (RFC 9728), AS metadata, and a configurable 401 shape. 13/13 characterization assertions pass under the client-varying strategy.
**Decisions made:**
- **AD-10 — the 401 response varies by client, deliberately.** Q1 is answered **no**: the MCP spec makes `WWW-Authenticate` a MUST on 401, Alexa+ requires it absent, and I proved both fixed strategies fail the other client (`spec` → 1 failure on the Alexa+ profile; `alexa` → 2 failures on the spec profile). Only per-client variance passes. Sprint 2 either sniffs the client or serves two endpoints; the two-endpoint option is probably sounder.
**Surprises:**
- The conflict is **spec-level MUST vs. platform requirement**, not a preference mismatch as rev 3 implied. There is no clever single-shape answer to find — worth knowing before Sprint 2 built an auth layer around one.
- No SDK dependency was needed at all to answer the questions; the spike installs nothing.
- **No private distribution path exists for Alexa+ *add-ons*.** What turned up is the older Alexa for Business private-skill model and Alexa Smart Properties — both adjacent, neither confirmed to intersect the add-on track. Gate 3 stays closed.
**Blocked:** Q2 (which AS) needs a Cognito/Auth0/Okta account. Q3 needs an Amazon developer account. Both are credential blockers, not technical ones.
**Next action:** install a container runtime, then PL-001.

### Session 5 — harness restructure + Sprint Contract
**Worked on:** repo structure, `planning/plan.md` (Sprint Contract), `implementation/progress.md`
**Done:**
- Moved the four artifacts out of `sprint-1/` to the paths AGENTS.md routes on: `research/research.md`, `planning/plan.md`, `implementation/progress.md`, `evaluation/test.md`. Removed `sprint-1/`. Updated all cross-references.
- Git repo initialized (it did not previously exist), initial commit, pushed to `origin/main`.
- Wrote the **Sprint Contract** into `planning/plan.md` — rubric Auth&Security 50 / Functionality 30 / Design 10 / Originality 10, every test mapped to a requirement, 8 hard-fail gates, ≥90% pass threshold.
- Added the **Failed Approaches** section, previously missing.
- **Applied four audit fixes:** T-14 rewritten from "active redo entry" to derived detention (it described an unreachable state and could never pass); added **T-22** (tenant-scoped cache, leak vector 2) and **T-23** (background jobs in tenant context, leak vector 3); corrected `research.md` rev 3 → rev 4; moved T-19/20/21 above `## Running` into named sections. Test count 21 → 23. §7 leak vectors now carry test IDs.
**Decisions made:**
- Single canonical artifact location; `sprint-1/` dropped rather than kept as a snapshot, to avoid two drifting copies.
- Sprint Contract is marked **provisional until PL-013 closes**, per the spike-gate rule.
**Surprises:**
- **`artifact-budget-guard.py` keys on the four routed paths.** While the artifacts lived in `sprint-1/` the budget hook matched nothing and silently passed on every write — the guard was installed but inert. The restructure is what switched it on.
- **12 of 21 tests were never cited by any task AC** (T-03, T-06…T-08, T-10…T-17). The Sprint Contract now provides that traceability.
- Repo had no `.git` at all despite being believed initialized.
- **`spike-gate.py` is also inert:** it blocks `planning/` writes only when `research.md` contains `SPIKE:` markers. There are zero, so PL-013 was never registered as a spike and the gate never fires. Marking PL-013's open questions `SPIKE:` would arm it — and would correctly block further planning writes until a `## Spike Results` section exists.
**Open:** open question 9 (which authorization server) still unresolved — routed into PL-013 as a deliverable. Whether to arm the spike gate is pending a call.
**Next action:** run **PL-013** (timeboxed 1 day, throwaway) — needs a cloud AS account (Cognito/Auth0/Okta) before it can start. Then **PL-001**.

### Session 4 — final sprint optimization
**Worked on:** `planning/plan.md` → rev 2, `evaluation/test.md` T-21, `implementation/progress.md`
**Done:** Folded all three review sessions into the plan. Two tasks added (13 total), one test added (21 total), exit criteria tightened.
**Decisions made:**
- **PL-012 — detention is derived from existing columns.** Tardy or Missing ID → detention is already deterministic, so Sprint 1 no longer waits on leadership approving new columns. Implemented as per-tenant config with a `hold_source` flag; switching to authoritative later needs no code change.
- **Derived holds are staff-facing only.** A derived detention is an inference — staff may have waived it. Enforced in the service and covered by T-21.
- **PL-013 — one-day throwaway MCP spike, run early.** Proves Streamable HTTP + OAuth 2.1/PKCE + the 401 divergence + Alexa+ eligibility before Sprint 2 commits to any of it. A "no" on any of them is a successful outcome.
- **Latency promoted to an exit criterion** (p95 ≤150 ms), since the Alexa+ 500 ms ceiling covers the whole round trip.
- **Sprint goal restated honestly:** detention derived, redo deferred. The original goal promised a status the data can't currently support.
**Surprises:** the redo gap turned out not to block the sprint — detention was derivable from columns that already exist, which decoupled Sprint 1 from both leadership decisions.
**Open:** capacity. Two weeks assumes real working time; if CCAR-P study runs concurrently at 120 min/day, either merge Parent Line into it as the capstone or plan three weeks.
**Next action:** confirm stack + AS (Q9), then PL-001. Start PL-013 in parallel early in week 1.

### Session 3 — source schema review
**Worked on:** research (`research/research.md` → rev 4, §2e), `planning/plan.md` PL-004, `evaluation/test.md` T-19/T-20
**Done:** Reviewed the HEMS attendance tracker structure. Column map recorded; **no student data stored anywhere.** Canonical schema in PL-004 extended with `hold_type`, `hold_location`, `do_not_call`. Drafted a leadership proposal for the new tracker columns.
**Decisions made:**
- Advisor-notes free-text column is **excluded at the connector** — never enters a canonical row, response, or log (F-3). T-19 covers it.
- `DO NOT CALL` carried through as a required canonical field (F-4). T-20 covers it.
- Every field Parent Line reads must be a constrained enum, never free text (F-5).
**Surprises:**
- **eSD is the system of record**, not the spreadsheet — answers open question 4, opens question 11 (does eSD have an API?).
- **Academic redo has no source in the tracker.** Detention is derivable from Tardy + Missing ID; redo originates with teachers and never reaches the sheet. The headline use case has no data behind it until leadership decides an ingestion route (open question 10).
- Advisor-notes column carries medical and family detail in practice — the strongest argument for controlled vocabulary in the proposed columns.
- Absence-count column is a concatenated string, not numeric. Parse or request a split.
**Next action:** unchanged — confirm stack (`research/research.md` §5) + AS choice (Q9), then PL-001. Separately: send the column proposal to leadership; Q10 gates the redo use case.

### Session 2 — reference implementation survey
**Worked on:** research (`research/research.md` → rev 3, §2d added)
**Done:** Surveyed available MCP-over-OAuth reference implementations.
**Key finding:** **There is no Amazon sample repo, and none is needed.** Amazon's overview says to bring an existing MCP server built for other hosts — so an "Alexa+ MCP server" is just a spec-2025-11-25 server over Streamable HTTP with OAuth 2.1. Primary reference is the official **TypeScript SDK `examples/server`** (`simpleStreamableHttp.ts --oauth --oauth-strict`); secondary is `tkodev/mcp-oauth-example` for the resource-server-only shape; `github/github-mcp-server` for production operational patterns.
**Surprises:**
- **401 divergence.** The MCP spec and every reference implementation return 401 *with* `WWW-Authenticate`. Alexa+ requires it *absent*. Since one server must serve both Alexa+ and Claude Desktop, this needs an explicit two-client test in Sprint 2.
- `github-mcp-server` ignores `X-Forwarded-*` when building metadata URLs so an untrusted client can't influence what we advertise — a vulnerability we'd otherwise have shipped.
- Decision leaning: **use a managed authorization server** (Cognito/Auth0/Okta), not a hand-rolled one. DCR is unsupported so clients are static anyway.
**Next action:** unchanged — confirm stack in `research/research.md` §5, then PL-001. Add AS choice (open question 9) to that confirmation.

### Session 1 — Alexa+ MCP Toolkit review
**Worked on:** research
**Done:** Reviewed Amazon's Alexa+ MCP QuickStart. `research/research.md` revised to rev 2 (§2c and §3 added). `planning/plan.md` and `evaluation/test.md` updated; T-18 added.
**Decisions made:**
- **AD-1 revised** — Alexa+ is an MCP *client*. One MCP server serves both Alexa+ (parents) and Claude Desktop (staff). The earlier "two front doors" design collapses into one interface.
- **AD-8 revised** — the Sprint 2 server must meet Alexa+ requirements from its first commit: Streamable HTTP, OAuth 2.1 + PKCE (S256), sub-500 ms.
- **AD-9 added** — Alexa+ caches tool definitions until redeploy; tool schemas are a versioned, deploy-gated interface.
**Surprises:**
- **500 ms round-trip budget**, not the ~8 s of a classic skill. Rules out any LLM call in a tool path — and reinforces this sprint's deterministic scope.
- **We don't own the model.** Amazon's model picks tools and fills arguments. Tool return values are now our *only* disclosure control; prompt-based constraints are unavailable.
- **Step-Up Authorization unsupported** — verification tiering must live in our own session state (§3c).
- **Security and data policies unpublished** — FERPA assessment can't be completed yet. Hardest gate on the voice path.
**Next action:** unchanged — confirm stack in `research/research.md` §5, then PL-001.

### Session 0 — setup
**Done:** Sprint harness created (`research/research.md`, `planning/plan.md`, `implementation/progress.md`, `evaluation/test.md`). Source review complete: `alexa-mcp` rejected as spine, ASK confirmed as the voice path for a later sprint.
**Decisions made:** Sprint 1 scoped to the deterministic core — no voice, no LLM, no MCP. Rationale in `planning/plan.md`.
**Open:** stack assumptions in `research/research.md` §4 need confirmation before PL-001.
**Next action:** confirm stack, then PL-001.

---

## Decisions made mid-sprint

*Anything settled here must also land in `research/research.md` §3. This section is the changelog; `research/research.md` is the source of truth.*

| Date | Decision | Why | Copied to research/research.md |
|---|---|---|---|
| — | — | — | — |

---

## Deferred to a later sprint

*Things surfaced during the sprint that are real but out of scope. Capture, don't build.*

| Item | Surfaced | Target sprint |
|---|---|---|
| — | — | — |

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