# progress.md — Sprint 3.1 (repair)

> **Agent: update this file at the end of every working session.** Append to the log, refresh the state table, set "Next action" specific enough for a cold start. This file is how continuity survives a context reset.

**Sprint:** 3.1 — repair sprint under the failure protocol. Sprint 3 evaluated at ≈69% weighted vs a 90% bar; no hard-fail, green isolation gate; failed on score and unmet exit criteria.
**Opened:** 2026-09-27
**Status:** ✅ Implementation complete — **342/342 green.** H ✅ · PL-251…PL-259 ✅ (T-74…T-83 written and passing). Ready for the Evaluator (fresh conversation, `/evaluate`, different model family).

---

## Current state

**Next action:** full Vitest suite + final test-status table, then stop — the Generator does not grade its own work.

**Blocked on:** nothing human. P2 remains open upstream — it gates T-63's real assertion only, not any PL-251…PL-259 task. PL-209/PL-213 stay with their human owners in Sprint 3.

**Measurable goal:** **E5 and E6 move from unmet to met.** E1, E2, E3 stay human-gated — no pilot, no P1 baseline. E3 held only because `release` was unreachable; once PL-252 wires it, E3's structural half is real and its observational half is still owed.

**Carry-over note:** PL-206 and PL-207 revert to 🔵 on the Sprint 3 board (PL-259) — marked ✅ while code-complete. Also: the Sprint 4/5 drafts reserved T-74… onward; this sprint allocates T-74…T-83, so those drafts renumber when they open. Flagged, not renumbered here.

**Cold-start gotchas (carried):** vitest does not load `.env` — `export $(grep -E '^(DATABASE_URL|APP_DATABASE_URL)=' .env | xargs)` before `npm test`. Do **not** `source .env` — the multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` breaks it.

---

## Exit criteria — the only scoreboard

Graded separately from the rubric (AD-14).

| # | Criterion | Status |
| - | --------- | ------ |
| E1 | One week live at one campus | ⬜ human-gated — PL-213, out of scope |
| E2 | Median time-to-decision + P1 baseline | ⬜ human-gated — P1 not started |
| E3 | Zero scholars released without a recorded decision | ⬜ held vacuously in S3; structural half becomes real via PL-252, observation still owed |
| E4 | `reason_detail` never leaves Postgres | ⬜ held — T-76 re-proves it on the interactive payload shape |
| E5 | Every decision audited, actor resolved through `staff_identities` — any channel | ⬜ **the goal** — T-75 (GATE) |
| E6 | Zero cross-tenant leakage, forged `request_id` included | ⬜ **the goal** — T-74, T-82, T-83 |

---

## Failed Approaches

> **Generator: read this before writing any code.** Repeating a documented failure is a rubric penalty. Max 10 lines. Survives context resets **and sprint restarts** — carried forward from Sprints 1–3; append on failure, never clear.

- Evaluator mischaracterized T-18's assertion (≤500 ms) when the code asserts ≤150 ms — verify against source, never against a report's characterization
- Marking a task ✅ when code is written rather than when the AC is met (PL-005) — **recurred as PL-206/PL-207: `sendPickupNotifications` had no caller in `src/` while both sat ✅.** Grep for a caller before marking ✅; 🔵 is not ✅
- `exactOptionalPropertyTypes` rejects the JWT object form — positional overload required; spread pattern `...(x !== undefined ? { x } : {})` is house style for optional threading
- Auth0 silently drops custom claims whose namespace is not a valid URL (`https://parent-line/` — bare host, no TLD): no error anywhere; cost ~2h across 6 probe runs chasing deployment instead of naming
- `source .env` crashes on multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` — vitest needs `DATABASE_URL`/`APP_DATABASE_URL` exported explicitly
- **Verifying an external integration by documentation rather than observation** (PL-101: two "REJECTED" results were dashboard misconfiguration, not vendor behavior). Applies to any vendor surface
- **Auditing inside the handler when the rejection happens before the handler** (Sprint 2 F-1) — and **an error path that throws past the audit entirely** (Sprint 3 eval F-9): the Slack 500 and `void this.tick()` wrote no row. Boundary audits the throw, not just the rejection → AD-42
- **A test that cannot fail its own pass condition** (Sprint 2 F-2) — **recurred as `percentile(values, 0.9)` reading index 1 of 200 while T-66 reported green.** When a test asserts a statistical property, assert the helper first; assert the samples carry variance
- **Piping a gate through `tail` reports the pipe's exit code, not the command's.** Run gates unfiltered, or check the command's own status
- **Enforcement that was never wired looks identical to enforcement that passed.** The harness ran the Step-0 probe config for an entire sprint — no gate fired, and two documented failures recurred unchallenged. Verify hooks are live at the start of every sprint, not the end

_At the 10-line cap, prune the oldest code-specific entries first; they remain in earlier sprints' progress.md. The process lessons stay._

---

## Task board

| ID | Task | Status | Notes |
| -- | ---- | ------ | ----- |
| H | Real hooks.json wired + `verify-hooks.sh` 10/10 | ✅ | 10/10. Also fixed `_common.py`: `sprint-\d+` missed `sprint-3.1` and "highest-numbered" resolved to the sprint-5 DRAFT — `artifact()` now skips `STATUS: DRAFT` folders. `mcp-phases.json` written so the router enforces |
| PL-251 | Decision authorization — assignee-only, no self-approval, both channels | ✅ | Chokepoint enforces `actorIdentityId === assigned_approver_id` + creator check via `routed`-event actor; refusals ledgered (`refused` event) + audited (`refusal:not_assigned_approver`/`self_approval`/`unmapped_actor`). Slack resolves by slack_user_id; app by `sub`→`findStaffIdentityBySubject`. T-75 (4 tests) green; full suite 316/316 |
| PL-252 | Wire the loop — approve-button DM, notifier callers, `record_pickup_outcome` | ✅ | `SlackMessage.blocks` + `chat.postMessage` blocks passthrough; `sendPickupNotifications` modes (routed DM+thread / escalated DM / terminal thread); `PickupNotifier` injected into ToolDeps + worker; `record_pickup_outcome` tool (staff-resolved, non-assignee OK); registry → 2.2.0 |
| PL-253 | Level-0 clock — `initial_minutes`, `min(pickup_at, now+initial)` | ✅ | `initial_minutes` required in ladder schema (fixture: 1min); create tool computes `min(pickup_at, now+initial)`; absent ladder → `pickup_at` + `initial_clock_unconfigured` warning |
| PL-254 | Queue fairness + ceiling + per-tenant ladders | ✅ | Migration 0010 (`stalled` state/event, `escalation_attempts`); deferral writes in-repo inside the claim tx after savepoint release/rollback; ceiling → `stall` action (routed→stalled only, terminal, purged); per-job ladders via `ESCALATION_LADDER_DIR`/<tenant>.json; T-78/T-79 green |
| PL-255 | Fix `percentile` — instrument before measurement | ✅ | helpers/stats.ts shared copy (mcp-audit semantics); T-74 self-test: p90 of 1…200 → tail element (~181), clamp leg, variance asserted on T-66 samples |
| PL-256 | `pickup_request_belongs_to_tenant` boolean — drop the oracle | ✅ | Migration 0010; `prosecdef`/`proacl`/`has_function_privilege` asserted (T-82); returns boolean only; old function dropped |
| PL-257 | Timing parity — all-tenant probes + decoy decision path | ✅ | Constant probe count asserted via pool wrapper (T-83: 2/2/2/2 for existent/cross/nonexistent/malformed); decoy sequence asserted (tenant context + request + identity queries + audit under tenant[0]); T-66 timing legs rerun with the corrected helper |
| PL-258 | Unaudited error paths — audited 500, `tick().catch`, per-tenant isolation | ✅ | T-80: revoked grant → generic 500 + `error:slack_internal` row, no internals on the wire. T-81: tenant A job failure → B still processes, audited `error:worker_tenant_failed`, `worker_unhealthy` on consecutive, zero unhandled rejections under start() |
| PL-259 | Artifact hygiene — PL-206/207 → 🔵, research.md entries, T-74 flag | ✅ | Sprint 3 board corrected (status line + rows); T-63 partial noted; sprint-3.1/research.md records settled decisions (leak vector 30, authorization rule, level-0 clock, stalled, per-tenant ladders, error-path closure); numbering flag preserved in test.md |

**Legend:** ⬜ Not started · 🟡 In progress · 🔵 **Code-complete, AC unverified** · ✅ AC met and verified · 🔴 Blocked · ⏸️ Paused

---

## Test status

T-01…T-73 carried and run every sprint. Sprint 3.1 adds T-74…T-83.

| Group | Written | Passing |
| ----- | ------- | ------- |
| T-01…T-73 (carried) | 73 | 73 — T-63 partial by design (P2-gated leg stays open) |
| T-74…T-83 (3.1) | 10 | 10 |
| Full suite | 34 files | **342 / 342 green** (final run) |

**Gate this sprint:** T-01…T-05, T-33…T-35, T-52, T-60, T-68, **plus T-75.** Run before every commit.

---

## Session log

### Session 0 — Sprint 3.1 opened

**Worked on:** harness — `sprint-3.1/plan.md`, `test.md`, this file, under the failure protocol.

**Done:** Read the Sprint 3 artifacts and verified every evaluation finding against source before planning — `decidePickupRequestAsSlackActor` never compares actor to `assigned_approver_id`; `decide_pickup_request` bypasses `staff_identities`; `sendPickupNotifications` has no caller; `escalateAt: pickupAt`; oldest-first `limit` over rows that never leave the queue; `percentile` reading index 1 of 200; a Slack 500 with no audit row; `void this.tick()` as an unhandled rejection; migration 0009's SECURITY DEFINER returning `tenant_id`; and `hooks.json` still on the Step-0 probe config.

**Decisions recorded (landed in plan.md; due in `research/research.md` §4 same-session when implemented):**

- Authorization in the transition chokepoint, not two call sites (the F-1 lesson)
- `record_pickup_outcome` as a fourth tool rather than widening `decide_pickup_request`'s enum — releasing a scholar is not a decision (AD-16 disjoint descriptions)
- `stalled` as the terminal human-handoff state at the attempt ceiling — never behaves like `approved` (AD-26)
- Boolean membership function + configured tenant list replaces the `tenant_id`-returning definer (leak vector 30)
- Rubric weights unchanged; HF5 widened to any-channel unresolved actors and creator self-approval

**Next action:** H, then PL-251. Generator reads Failed Approaches first.

### Session 1 — H landed; PL-251 landed

**Worked on:** prerequisite H was already complete (hooks live, 10/10). PL-251 end-to-end: chokepoint authorization, both channels, tests.

**Done:**

- `transitionPickupRequest` (pickup-requests.ts): decision actions (approve/flag/deny) now require `actorIdentityId`; it must equal `assigned_approver_id` (`not_assigned_approver`) and the actor must not equal the `routed` event's actor — the creator (`self_approval`). Both refusals write a `refused` ledger event before returning; no state change.
- `decidePickupRequestAsSlackActor` passes the resolved `identity.id`; new `decidePickupRequestAsSubject` resolves the app token `sub` through `findStaffIdentityBySubject` — unmapped is a typed `unmapped_actor` refusal identical for existent/nonexistent ids (widened HF5).
- `decide_pickup_request` tool now routes through the service (was: raw `identity.sub` into the chokepoint); refusal copy added for `unmapped_actor`/`not_assigned_approver`/`self_approval`; Slack endpoint maps the two new codes distinctly for mapped tenant staff.
- T-75: four tests in slack-actor.test.ts — non-assignee refused on both channels (same refusal shape), creator self-approval refused on both channels, unmapped app subject refused, assignee flag allowed. Existing T-64/T-67/T-53/T-54/T-66 adapted to seed assignee identities; every decision call site updated.
- `tsc --noEmit` clean; full suite 33 files / 316 tests green.

**Note for the evaluator:** flag is a non-final decision — `decided_by` stays null on it; the flagged event carries the assignee subject. Self-approval compares subject strings (`routed` event actor), not identity ids — a creator deciding under a *different* mapped identity is an open edge if subjects ever diverge 1:n from identities.

**Next action:** PL-252 — blocks + approve button, notifier callers, `record_pickup_outcome`.

### Session 2 — PL-252 + PL-253 landed

**Worked on:** the approval loop wiring and the level-0 clock.

**Done:**

- `SlackMessage.blocks`; `WebApiSlackClient` serializes them.
- `sendPickupNotifications` gained `mode`: `routed` (DM + thread), `escalated` (DM to new assignee), `expired`/`stalled` (terminal thread only, no DM target). `buildPickupNotificationPayloads` gained `requestId` (allowlist +1: the button's `value`) and emits `dmBlocks` — section + `actions` block, `action_id:'approve'`, `value:<request_id>`, the shape the interaction endpoint parses.
- `PickupNotifier` interface + `createPickupNotifier` factory; `ToolDeps.pickupNotifier` + `escalationLadder` (narrowed `{initialMinutes}`); `McpAppOptions` pass-throughs; `main.ts` and worker `runFromEnv` build both from `SLACK_BOT_TOKEN`/`SLACK_VISIBILITY_CHANNEL`/`PICKUP_REVIEW_URL` + `ESCALATION_LADDER_FILE`; absent → `slack_notifications_disabled` boot log, transitions unaffected.
- `create_pickup_request` notifies post-route (own `withTenant`, try/catch — `notifier_exception` logged without the exception's message) and computes `escalate_at = min(pickup_at, now+initial_minutes)` when a ladder is configured, else `pickup_at` + `initial_clock_unconfigured` warning.
- Worker: per-row outcomes collected during the claim tx; notifications sent after commit (escalate → DM new assignee; expire → terminal thread).
- Ladder schema: required `initial_minutes`; fixture updated (1 min).
- New tool `record_pickup_outcome` (`release`/`complete`): resolves `sub`→staff identity (`unmapped_actor` refusal — identical whether or not the request exists), chokepoint enforces legal transitions. `TOOL_MINIMUM_FIELDS` + registry 2.2.0 + changelog; tools count 7.
- Tests: `pickup-notification-wiring.test.ts` (T-76 ×6, T-77 ×4). Touched suites all green.

**Note:** T-77's terminal-state leg covers `denied` + `expired`; `stalled` lands with PL-254/T-78. The audit-for check queries `mcp_audit` by tool name — rows key on the HTTP request id, not the pickup request id.

**Next action:** PL-254 — migration 0010 (`stalled`, `escalation_attempts`), deferral in `processDueEscalations`, per-tenant ladders.

### Session 3 — PL-254 landed; PL-256/257/258 code partially landed with it

**Worked on:** queue fairness, the `stalled` ceiling, per-tenant ladders — and the code that could not compile without its neighbors (membership function, endpoint probes, tick catch).

**Done:**

- Migration `0010_escalation_fairness.sql`: `stalled` added to the state + event-type checks; `escalation_attempts integer not null default 0`; `find_pickup_request_tenant` dropped and replaced by `pickup_request_belongs_to_tenant(uuid, uuid) → boolean` — SECURITY DEFINER, `search_path` pinned, public EXECUTE revoked, `parentline_app` only (leak vector 30).
- Repository: `stall` action (routed→stalled only, terminal → purge); `DueEscalationRow` carries `escalation_attempts`; `processDueEscalations` gains `deferralSeconds` — skipped rows defer after savepoint release, failed rows after rollback-to-savepoint, both inside the still-open claim transaction; `stalled` added to the outcome union + stats; `findPickupRequestTenant` → `pickupRequestBelongsToTenant`.
- Worker: `EscalationJob` carries its own `ladder` (per-tenant subjects — the two-tenant starvation cause); `maxAttempts` (default 20, `ESCALATION_MAX_ATTEMPTS` env) → `stall` transition + `stalled:max_attempts` audit; `tick()` isolates per-tenant failures (log + `error:worker_tenant_failed` audit + `worker_unhealthy` on consecutive); `start()` runs `tick().catch` — no unhandled rejection on Node 20. `runFromEnv` loads `ESCALATION_LADDER_DIR` per `WORKER_TENANTS` entry — a missing `<dir>/<tenant>.json` refuses boot naming tenant + path.
- Slack endpoint (PL-257 code): probes EVERY `SLACK_TENANT_IDS` entry via the boolean function (constant count, no early exit); no-match runs the decoy under tenant[0] (withTenant + `findPickupRequestById` + identity lookup + boundary audit); wire byte-identical. Wrapped sections 4–5 in try/catch → audited `error:slack_internal` + generic 500 (PL-258 code).
- Config: `SLACK_TENANT_IDS`, `ESCALATION_LADDER_DIR`/`ESCALATION_MAX_ATTEMPTS`/`WORKER_TENANTS` documented; web process loads per-tenant `initial_minutes` from the dir (`escalationLadders` keyed by tenant — the level-0 clock is now per-tenant, matching the worker).
- Fixtures: `src/fixtures/escalation/<tenant>.json` ×2 (obviously fake per tenant).
- Tests: T-78 (poisoned-head starvation, ceiling → stalled terminal/audited/unreachable, skip-defer-resume) and T-79 (two-tenant worker, boot refusals) appended to escalation-worker.test.ts; T-60's forced-error leg updated for the deferral contract (clock reset before re-tick); T-55's writer whitelist extended to name `deferRow` (queue fields only, `state` only in its WHERE guard); repo export whitelist updated for `pickupRequestBelongsToTenant`.
- 73 tests green across the six touched files; `tsc` clean.

**Note for the evaluator:** T-55 now whitelists THREE in-module writers — `deferRow` is named, argued queue-fields-only, and structurally checked (its SET clause is asserted to contain no `state`). The T-66 timing legs still run on the OLD decoy-free shape? No — they now exercise probes + decoy; T-83 is the parity re-proof.

**Next action:** PL-255 (`percentile` fix + T-74) → PL-256 T-82 → PL-257 T-83 → PL-258 T-80/T-81 → PL-259.

### Session 4 — PL-255/256/257/258 tests landed; PL-259 closed; sprint complete

**Worked on:** the remaining instrument + parity + error-path tests, artifact hygiene, full-suite run.

**Done:**

- PL-255: `percentile` hoisted to `tests/helpers/stats.ts` (mcp-audit semantics — `Math.floor((p/100)*len)` was a double-division reading index 1 of 200); T-74 asserts the helper on a known distribution, the clamp leg, and non-degenerate variance in T-66's timing samples.
- PL-256/T-82: `pg_proc` assertions (`prosecdef`, pinned `proconfig`, `proacl` grants to `parentline_app` only, `prorettype = bool`), `has_function_privilege`, behavioral legs (own-tenant true / cross-tenant false / nonexistent false / `find_pickup_request_tenant` gone).
- PL-257/T-83: probe count wrapped via `appPoolWrapper` in the test MCP server — `pickup_request_belongs_to_tenant` called exactly `SLACK_TENANT_IDS.length` times for existent, cross-tenant, nonexistent, and malformed ids (2/2/2/2); wrap-once client marking (the first version counted 7 — pooled clients were re-wrapped per `connect()`); decoy leg asserts the full sequence runs under tenant[0]; wire shapes byte-identical.
- PL-258/T-80: revoked EXECUTE → generic 500 (not the not-found shape, no internals) + `error:slack_internal` audit row. T-81: tenant A's job fails → tenant B still processes, `escalation_tenant_failed` logged, `error:worker_tenant_failed` audited, `worker_unhealthy` on consecutive failures, zero unhandled rejections under `start()` over ~12 intervals.
- Hygiene: removed dead `loadEscalationLadderFromEnv` (ESCALATION_LADDER_FILE path — nothing in `src/` called it; its boot-refusal test replaced with the per-tenant missing-file leg); fixture + progress references updated to `ESCALATION_LADDER_DIR`; sprint-3/progress.md board corrected (status line, PL-206/207 rows, T-63 partial noted honestly).
- `sprint-3.1/research.md` written — settled decisions recorded (leak vector 30, chokepoint authorization, level-0 clock, `stalled`, per-tenant ladders, error-path closure); P2/P1 still open.
- **Full suite: 34 files, 342/342 green.** `tsc --noEmit` clean.

**Next action:** none — implementation complete. Evaluator: fresh conversation, `/evaluate`, a different model family, graded against `sprint-3.1/plan.md` + `sprint-3.1/test.md` only — do not read this file.
