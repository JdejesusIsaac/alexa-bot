# progress.md — Sprint 3

> **Agent: update this file at the end of every working session.** Append to the log, refresh the state table, set "Next action" specific enough for a cold start. This file is how continuity survives a context reset.

**Sprint:** 3 — The Approval Path
**Started:** 2026-09-20
**Status:** ⬜ Harness written, no implementation. **Blocked at the gate:** P1 (measurement week) has not started, and P2/P3 are unanswered policy decisions that block PL-202 and PL-204.

---

## Current state

**Next action:** (1) **Start P1 today.** One week, three numbers, manual tally: early pickups per day, how many were called in that morning, and minutes from Slack post to leader response. No code depends on it; the sprint's justification does. (2) Get P2 and P3 on a calendar with the principal and VPs — both are short conversations with people who are hard to catch, which is the same problem this sprint is trying to solve. Bring the proposals in research.md §Spike Results, not open questions. (3) Start PL-201 in parallel — it depends on nothing and is on the critical path for both routing and the leader's pattern context. (4) **Open Q6 now, not at Sprint 5 planning.** Under AD-48 it is reopened from a no-caller-ID baseline: what second factor works on a shared device where nothing secret can be spoken aloud. It is the hardest open question in the project, it needs real parents in two languages, and it takes weeks of elapsed time against an hour of work.

**Blocked on:** P2 blocks PL-204 (escalation ladder). P3 blocks PL-202 and PL-210 (`reason_detail` clearance and retention). PL-209 blocked pending the Aircall capability probe.

**Do not start PL-204 before P2 lands.** We can propose a ladder; we must not pick one. A system that releases a scholar on our invented default is a wrong answer about a child with our name on it.

**Sprint 2 carry-over, still open:** PL-112 (Claude Desktop end to end — Auth0 claims Action, client registration, then E1/E3) · soak at 0/10 counted business days · Sprint 1 evaluation re-issue (owner: user, via `/evaluate`). **These are Sprint 2 closure, not Sprint 3 blockers**, with one exception: E6 should now close as "Q2 answered, Q3 descoped under AD-33" rather than remaining open indefinitely.

**Cold-start gotchas (carried):** vitest does not load `.env` — `export $(grep -E '^(DATABASE_URL|APP_DATABASE_URL)=' .env | xargs)` before `npm test`. Do **not** `source .env` — the multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` breaks it. Auth0 custom-claim namespaces must be valid URLs with a TLD.

---

## Exit criteria — the only scoreboard

Graded separately from the rubric (AD-14).

| #   | Criterion                                                                                                            | Status                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| E1  | One week live at one campus; every early-pickup request captured at intake, none created after the parent arrives     | ⬜ PL-213                                  |
| E2  | Median time-to-decision recorded, with the P1 baseline alongside it                                                  | ⬜ **baseline not started — P1**           |
| E3  | Zero scholars released without a recorded decision; timeout produces `expired` and in-person handoff                 | ⬜ T-60, T-62, observation                 |
| E4  | `reason_detail` never leaves Postgres — absent from every Slack payload, notification, log, trace, and tool response  | ⬜ T-68, T-69, adversarial                 |
| E5  | Every decision audited with an actor resolved through `staff_identities`                                             | ⬜ T-64, T-67                              |
| E6  | Zero cross-tenant leakage through the new tables and the Slack surface, including a forged `request_id`              | ⬜ T-52, T-66                              |

**E2 is a measurement, not a target.** We do not know the baseline. Setting a goal before P1 reports would be inventing one.

---

## Failed Approaches

> **Generator: read this before writing any code.** Repeating a documented failure is a rubric penalty. Max 10 lines. Survives context resets **and sprint restarts** — carried forward from Sprints 1 and 2; append on failure, never clear.

- Evaluator mischaracterized T-18's assertion (≤500 ms) when the code asserts ≤150 ms — verify against source, never against a report's characterization
- Marking a task ✅ when code is written rather than when the AC is met (PL-005) — use 🔵 for code-complete-but-unverified
- Zod `.nullable()` without `.default(null)` still requires the key present
- RLS `WITH CHECK` rejects INSERT omitting `tenant_id`
- `exactOptionalPropertyTypes` rejects the JWT object form — positional overload required
- Auth0 silently drops custom claims whose namespace is not a valid URL (`https://parent-line/` — bare host, no TLD): no error anywhere; cost ~2h across 6 probe runs chasing deployment instead of naming
- `source .env` crashes on multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` — vitest needs `DATABASE_URL`/`APP_DATABASE_URL` exported explicitly
- **Verifying an external integration by documentation rather than observation** (PL-101: two "REJECTED" results were dashboard misconfiguration, not vendor behavior). Applies directly to PL-209 — probe Aircall, don't read about it
- **Auditing inside the handler when the rejection happens before the handler** (Sprint 2 F-1): `tools/call` rejections raised by the SDK pre-dispatch wrote no `mcp_audit` row, violating E5 while 49 tests stayed green. Two sibling tools also disagreed on the identical invalid-args path — the pattern was enforced by memory, not structure. → AD-42
- **A test that cannot fail its own pass condition** (Sprint 2 F-2): T-41 asserted `auth_ms`/`tool_ms` were non-null instead of running 200 calls and recording p95. It occupied a slot on a green scoreboard while measuring nothing. This is PL-005's failure moved from the task board to the test suite, and 🔵 does not catch it — **when writing a test, state which AC clause it can fail on**

_At the 10-line cap, prune the oldest code-specific entries first; they remain in earlier sprints' progress.md. The two process lessons at the top stay._

---

## Task board

| ID     | Task                                    | Status | Notes                                                                                   |
| ------ | --------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| PL-201 | Roster grain: `service_date` + `student_id` | ⬜     | Depends on nothing. Start in parallel with P1. Carried from the Sprint 2 review as "housekeeping" — it is not |
| PL-202 | `pickup_requests` schema + state machine | ⬜     | **Blocked on P3** (clearance decision before the first row is written)                  |
| PL-203 | Approver routing resolver               | ⬜     | The tribal-knowledge artifact (F-15). Cheapest high-value item in the sprint            |
| PL-204 | Escalation worker                       | ⬜     | **Blocked on P2.** `skip locked`, no broker                                             |
| PL-205 | `staff_identities` + Slack actor mapping | ⬜     | Without it, E5 degrades silently at the one point a human decided                       |
| PL-206 | Slack notification surface (outbound)   | ⬜     | Category + link only. Never `reason_detail`                                             |
| PL-207 | Slack interaction endpoint (inbound)    | ⬜     | Approve only. Second auth scheme on a write path — Sprint 2's OAuth scrutiny applies    |
| PL-208 | MCP tools: request lifecycle            | ⬜     | Three tools, disjoint descriptions, minimum field sets                                  |
| PL-209 | Aircall intake webhook                  | ⬜     | **Probe first** (research.md §Spike Results). A "webhooks unreliable" result shrinks this to a form |
| PL-210 | Disclosure extension                    | ⬜     | **Blocked on P3.** Also demotes `reason_code` per the Sprint 2 review finding           |
| PL-211 | Time-to-decision instrumentation        | ⬜     | New SLO. The 500 ms budget does not govern this surface — say so in the runbook          |
| PL-212 | JWKS warm path + session-store decision | ⬜     | Independent, any week. Decide the session store; build only on trigger                  |
| PL-213 | Campus pilot                            | ⬜     | One week, one campus, coordinator + two approvers                                       |

**Legend:** ⬜ Not started · 🟡 In progress · 🔵 **Code-complete, AC unverified** · ✅ AC met and verified · 🔴 Blocked · ⏸️ Paused

**🔵 is not ✅.** A task blocked on a policy decision or an external dependency stays 🔵.

---

## Test status

Sprint 1's T-01…T-23 and Sprint 2's T-24…T-49 continue to run every sprint. Sprint 3 adds T-50…T-73.

| Group                        | Written | Passing |
| ---------------------------- | ------- | ------- |
| T-01…T-49 (carried)          | 49      | 49      |
| T-50…T-52 roster grain       | 0       | 0       |
| T-53…T-57 request lifecycle  | 0       | 0       |
| T-58…T-59 routing            | 0       | 0       |
| T-60…T-63 escalation         | 0       | 0       |
| T-64…T-67 actor + inbound auth | 0     | 0       |
| T-68…T-70 disclosure         | 0       | 0       |
| T-71…T-73 intake + ops       | 0       | 0       |

**Gate this sprint:** T-01…T-05, T-33…T-35, **plus T-52, T-60, T-68.** Run before every commit.

---

## Session log

### Session 0 — Sprint 3 opened

**Worked on:** harness — `research.md` rev 1, `plan.md`, `test.md`, this file.
**Done:** Reviewed `serversmx/alexa-mcp` (second reading, outbound primitive) and `awslabs/mcp` (`mcp-lambda-handler`, `DESIGN_GUIDELINES.md`). Recorded field observation of the early-pickup process as research §2j — the primary source for this sprint. Added AD-26…AD-33, leak vectors 16–21, Q11…Q16, T-50…T-73, three spikes.

**Decisions made:**

- **AD-26** approval is a decision, never a timeout default — expiry escalates then terminates to in-person
- **AD-27** one named approver, never a channel broadcast
- **AD-28** `reason_detail` clearance `never` by default; notifications carry category + link
- **AD-29** a Slack actor decides only through `staff_identities`
- **AD-30** escalation state in Postgres, `skip locked`, no broker
- **AD-31** `service_date` is the grain of the roster
- **AD-32** a caller-ID match is an identity signal, not verification
- **AD-33** the lobby device is descoped; the phone is the parent channel
- **AD-34** Sprint 4 ships the product surface, Sprint 5 puts parents on it — a commitment in plan.md, not an intention _(amended same day under AD-48: the channel is Alexa+, not the phone)_

**Surprises:**

- **The sprint we had queued was the wrong one.** Sprint 3 was scoped through two sprints as "parent verification and tiering." Watching the actual process says the lookup is seconds of a fifteen-minute problem, and the cost is an approval chain run at 1:50 pm. The voice agent was solving the cheap part.
- **`#eastleaders` has ~15 members** — principal, VPs, assessment specialist, all ops. The delay is diffusion of responsibility, not notification latency. This is the finding that reframed the whole sprint (F-13).
- **This is the first sprint that stores sensitive content on purpose.** Rule 8 exists to keep medical and family detail out; early-pickup reasons walk it back in through the front door. Hence AD-28 and the rubric reweighting.
- **AD-17's "cannot un-disclose" turns out to be mostly a lobby-speaker problem.** Push to a known contact has no identity problem at all, because the recipient is already determined (F-6). That inverted the difficulty and produced AD-33.
- **Neither reviewed repo is multi-tenant with row-level isolation.** Across 60+ AWS reference servers, none. There is no pattern to copy here; the isolation gate carries the weight alone.
- **Checked the scope against the six README capabilities rather than assuming it covered them** (F-18). The pickup spine carries four of six — status lookup is already built and needs only a channel; escalation becomes real for the first time; callbacks transfer fully; appointments transfer partially; document delivery not at all. The tempting claim ("this unlocks everything") is false and would set up a Sprint 5 that discovers document delivery from scratch.
- **Nothing in Sprint 3 reaches a parent, and this is the second staff-only sprint in a row.** Each has a locally good reason, which is exactly how the drift stays invisible. AD-34 makes Sprint 4 a commitment in the artifact rather than an intention.

**Next action:** as above — P1 today, P2/P3 on a calendar, PL-201 in parallel.

### Session 0b — Sprint 2 evaluation returned

**Worked on:** folding the Sprint 2 evaluation's findings into Sprint 3 before implementation starts.
**Verdict received:** rubric sound — isolation holds over the network surface, auth rejects with distinct codes, disclosure is projection-enforced, AD-15/16/17/18 honored in code and test. **Sprint fails completeness, not quality:** E1, E3, and E6 need runs or measurements that haven't happened, and E5 has a demonstrable code gap.

**Folded into Sprint 3:**

- **AD-42** added to research.md §4 rev 2 and to the plan's AD table
- **T-65 rewritten** — rejection *and* audit row, asserted by querying `mcp_audit` on `request_id`, not inferred from a log line
- **T-61 extended** — the worker's poll loop is its boundary; skipped and failed rows are audited
- **PL-207, PL-204, PL-209 ACs** amended to put auditing at the boundary
- **Hard-fail 8** added: a rejection path on any new surface writing no audit row
- **Two Failed Approaches lines** added; the two oldest code-specific entries pruned to stay at the 10-line cap (they remain in Sprint 1's progress.md)

**Surprises:**

- **F-1 is architectural, not a missed line.** `tools/call` was carved out of the HTTP layer's audit on reasoning that was correct for calls that dispatch and silently wrong for ones the SDK rejects first. The tell was two sibling tools disagreeing on the identical invalid-args path — a pattern held by memory rather than structure. The fix is to move `tools/call` auditing back to the boundary entirely rather than patch the two branches the evaluator happened to find.
- **F-2 is rated MEDIUM and is arguably worse than F-1.** A test that cannot fail its own pass condition is worse than no test, because it occupies a slot on a green scoreboard — the suite reported health it had not measured. Implementing T-41 properly *is* E3's measurement, so that repair is on the critical path to Sprint 2 closure, not a side task.
- **AD-14 paid for itself.** Green tests coexisting with a violated exit criterion is exactly the scenario it was written for, and it caught that in both F-1 and F-2. Worth recording as evidence, since it is the kind of process rule that gets softened when inconvenient.
- **The adversarial pass produced a novel result** — reachable behavior no green test covered — which satisfies the contract properly rather than a theoretical gap argued away.

**Next action:** unchanged for Sprint 3 (P1 today, P2/P3 on a calendar, PL-201 in parallel, Q6 opened). **Sprint 2 repairs are Sprint 2's closure work, not Sprint 3 tasks:** move `tools/call` auditing to the HTTP layer, implement T-41 as specified, one-line T-32 header fix, drop `sessions` from `/health`.

---

## Decisions made mid-sprint

_Anything settled here must also land in `research/research.md` §4 **the same session**. This table is the changelog; research.md is the source of truth._

| Session | Decision                                        | Why                                                                                    | In research.md |
| ------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------- |
| S0      | AD-26 approval is never a timeout default       | A timeout that releases a scholar is Rule 10's exact failure mode                      | ⬜ pending     |
| S0      | AD-27 one named approver, never a broadcast     | Fifteen recipients is zero recipients (F-13)                                           | ⬜ pending     |
| S0      | AD-28 `reason_detail` clearance `never`         | First sprint storing medical-adjacent content on purpose                               | ⬜ pending     |
| S0      | AD-29 Slack actor via `staff_identities`        | Otherwise "actor from the token" degrades where a human decided                        | ⬜ pending     |
| S0      | AD-30 escalation state in Postgres              | An SLA timer must survive restart and multiple instances                               | ⬜ pending     |
| S0      | AD-31 `service_date` is the roster grain        | The leader's judgment rests on pattern; a wiped table can't supply it                  | ⬜ pending     |
| S0      | AD-32 caller ID is a signal, not verification   | It narrows who is calling; it does not establish it                                    | ⬜ pending     |
| S0      | AD-33 lobby device descoped, phone is the channel | Verification is easiest where caller ID is free and there is one listener             | ⬜ pending     |
| S0      | AD-34 Sprint 4 = product surface, Sprint 5 = parents | Parents get a surface within two sprints; a further deferral needs a product argument | ⬜ pending |
| S0      | **AD-48 Alexa+ is the product surface**         | Aircall demoted to a later capability on the same server; Q6 reopened no-caller-ID     | ✅ §4 rev 4    |
| S0      | Rubric reweighted: Disclosure 40%, Auth 25%     | First sprint storing sensitive content on purpose and moving a child                   | ⬜ pending     |
| S0      | **AD-42 audit at the rejecting boundary**       | Sprint 2 evaluation F-1: pre-dispatch rejections reached no handler, so no row was written | ✅ §4 rev 2 |

**⬜ pending is a debt, not a status.** Sprint 2 kept this table reconciled every session; do the same.

---

## Deferred to a later sprint

_Real but out of scope. Capture, don't build._

| Item                                                                  | Surfaced        | Target                          |
| ----------------------------------------------------------------------- | --------------- | --------------------------------- |
| **Alexa+ channel, staff-facing — the product surface**                | S0              | **Sprint 4 — committed (AD-34/48)** |
| **Parent tier on Alexa+ + verification (Q6, reopened no-caller-ID)**   | S0              | **Sprint 5**                    |
| Aircall/phone as an MCP capability                                    | S0              | Sprint 6+, per AD-48            |
| Callback requests as a `pickup_requests` request type                 | S0              | Sprint 5                        |
| After-school incident callback scheduling (F-16 — scheduling only, no content) | S0      | Sprint 5                        |
| Leadership appointments — calendar availability beyond the spine      | S0              | Sprint 5                        |
| Document delivery — verification + template library, no spine transfer | S0             | Sprint 5                        |
| Speech-to-text reason capture on the intake call                      | S0              | Sprint 5+                       |
| Broadcast notifications to parents (consent, opt-out, TCPA)           | S0              | **Not scoped — a second product** |
| Alexa+ certification docs; PL-013 Q3; MCP Apps; lobby device          | S1, S2          | **Descoped under AD-33**        |
| Per-tenant validation sets (`VALID_ATTENDANCE_STATUSES`, `VALID_REASON_CODES`) | Sprint 2 review | Before campus two         |
| Session store externalization                                         | Sprint 2 review | On trigger (PL-212)             |
| Tighten the spike gate to match markers to resolutions                | S2 S0           | Harness maintenance             |
| Does eSD expose an API that supersedes the Sheets connector?           | Sprint 1        | Sprint 4 research               |

---

## Definition of sprint complete

- [ ] All six exit criteria met (E1–E6)
- [ ] All 13 tasks ✅ (not 🔵)
- [ ] T-01…T-73 written and passing
- [ ] Zero hard-fail conditions triggered
- [ ] Evaluator produced at least one finding, or stated one was sought and not found
- [ ] Evaluator confirmed the phase file was set to `evaluation`
- [ ] `research/research.md` reconciled — AD-26…AD-33 landed in §4, decisions table all ✅
- [ ] P1 baseline and E2 measurement recorded side by side
- [ ] **Sprint 4 scope drafted as the Alexa+ channel (AD-34 amended, AD-48), and Sprint 5 as the parent tier on it.** Parents get a surface within two sprints; a Sprint 5 draft that defers them again requires a product-level argument, not a scope adjustment. **Q6 opened** — reopened from a no-caller-ID baseline, it needs real parents and weeks of elapsed time