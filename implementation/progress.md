# progress.md — Sprint 1

> **Agent: update this file at the end of every working session.** Append to the log, refresh the state table, and set "Next action" to something specific enough that a fresh session can start cold. This file is how continuity survives a context reset.

**Sprint:** 1 — Parent Line Core
**Started:** _(fill in)_
**Status:** 🟡 Not started

---

## Current state

**Next action:** Confirm stack + authorization server (`research/research.md` §5, open question 9), then begin **PL-001**. Start **PL-013** early in week 1 — its findings are worth most while there's still time to act on them.

**Blocked on:** nothing (Sprint 1 is deliberately unblocked — the legal question gates voice work, not this sprint)

**Soak status:** not started · 0 / 10 business days

**Exit criteria:** ⬜ 10-day soak · ⬜ zero cross-tenant leakage · ⬜ p95 ≤150 ms · ⬜ zero PII in logs · ⬜ PL-013 go/no-go written

---

## Task board

| ID | Task | Status | Notes |
|---|---|---|---|
| PL-001 | Repo scaffold + CI | ⬜ Not started | |
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
| PL-013 | MCP transport + auth spike | ⬜ Not started | ⏱️ 1 day, throwaway. Run early week 1 |

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
- [ ] All 21 tests written and passing
- [ ] Migrations run clean from empty on a fresh database
- [ ] `getScholarStatus` correct for 10 consecutive business days
- [ ] Zero cross-tenant leakage across the full test suite
- [ ] Zero student PII found in logs
- [ ] `research/research.md` updated with everything learned
- [ ] Sprint 2 scope drafted (MCP server for staff)