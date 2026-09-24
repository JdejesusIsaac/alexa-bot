# progress.md — Sprint 3

> **Agent: update this file at the end of every working session.** Append to the log, refresh the state table, set "Next action" specific enough for a cold start. This file is how continuity survives a context reset.

**Sprint:** 3 — The Approval Path
**Started:** 2026-09-20
**Status:** 🟡 In progress — **all unblocked implementation tasks are done.** PL-201, PL-212, PL-202, PL-203, PL-205, PL-206, PL-210, PL-208, PL-211 ✅ (T-50…T-52, T-72, T-53…T-57, T-58/T-59, T-64/T-67, T-68, T-69, T-70, T-73 passing; full suite 294/294). **Remaining: PL-204 waits on P2** (or the ladder-as-required-config option), **PL-209 on the Aircall probe, PL-213 (pilot) on all.** The critical path is now entirely human: P2, the probe, P1's baseline, Q6.

---

## Current state

**Next action:** **The Generator has no unblocked tasks left — the critical path is entirely human.** (1) **P2 (escalation ladder)** — the principal and VPs; bring the research.md §Spike Results proposal, not the question. Or take the standing option: build PL-204 now with the ladder as required config (the worker refuses to start without a written ladder; T-63 asserts config against the recorded policy) — buildable against a fixture ladder, un-runnable for real until P2 lands. (2) **The Aircall probe** — credentials + observation of what the API actually exposes (the PL-101 lesson; never documentation) — unblocks PL-209. (3) **P1 measurement week** — three numbers, manual tally; E2's number is not a result without the baseline recorded alongside it. (4) **Q6** — open now, not at Sprint 5 planning. Then PL-213 (the pilot) once its inputs land.

**Blocked on:** P2 blocks PL-204 (escalation ladder). PL-209 is blocked pending the Aircall capability probe. **P3 is resolved** (product default, Session 3) — PL-202 and PL-210 are unblocked.

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
- RLS `WITH CHECK` rejects INSERT omitting `tenant_id`
- `exactOptionalPropertyTypes` rejects the JWT object form — positional overload required
- Auth0 silently drops custom claims whose namespace is not a valid URL (`https://parent-line/` — bare host, no TLD): no error anywhere; cost ~2h across 6 probe runs chasing deployment instead of naming
- `source .env` crashes on multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` — vitest needs `DATABASE_URL`/`APP_DATABASE_URL` exported explicitly
- **Verifying an external integration by documentation rather than observation** (PL-101: two "REJECTED" results were dashboard misconfiguration, not vendor behavior). Applies directly to PL-209 — probe Aircall, don't read about it
- **Auditing inside the handler when the rejection happens before the handler** (Sprint 2 F-1): `tools/call` rejections raised by the SDK pre-dispatch wrote no `mcp_audit` row, violating E5 while 49 tests stayed green. Two sibling tools also disagreed on the identical invalid-args path — the pattern was enforced by memory, not structure. → AD-42
- **A test that cannot fail its own pass condition** (Sprint 2 F-2): T-41 asserted `auth_ms`/`tool_ms` were non-null instead of running 200 calls and recording p95. It occupied a slot on a green scoreboard while measuring nothing. This is PL-005's failure moved from the task board to the test suite, and 🔵 does not catch it — **when writing a test, state which AC clause it can fail on**
- **Piping a gate through `tail` reports the pipe's exit code, not the command's.** `npm run typecheck | tail -3 && npm run lint` ran lint over a failing typecheck — the `exactOptionalPropertyTypes` error sat inside a "green" verify step until an unpiped run caught it. Run gates unfiltered, or check the command's own status

_At the 10-line cap, prune the oldest code-specific entries first; they remain in earlier sprints' progress.md. The two process lessons at the top stay._

---

## Task board

| ID     | Task                                    | Status | Notes                                                                                   |
| ------ | --------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| PL-201 | Roster grain: `service_date` + `student_id` | ✅     | T-50…T-52 passing (tests/roster-grain.test.ts); full suite 228/228 incl. carried T-01…T-49 |
| PL-202 | `pickup_requests` schema + state machine | ✅     | T-53…T-57 passing. P3 enforced at the chokepoint: `reason_detail` purged at terminal states, per-tenant retention (`tenant_settings`), nightly sweep |
| PL-203 | Approver routing resolver               | ✅     | T-58, T-59 passing. Most-specific-wins (section > grade > default), total, deterministic; totality fails loudly at seed (assert wired into `npm run seed`) |
| PL-204 | Escalation worker                       | ⬜     | **Blocked on P2.** `skip locked`, no broker                                             |
| PL-205 | `staff_identities` + Slack actor mapping | ✅     | T-64, T-67 passing. Unmapped actor → typed refusal, audited, no state change; decisions recorded under the subject, never the slack id. T-65/T-66 wait on PL-207's endpoint |
| PL-206 | Slack notification surface (outbound)   | ✅     | T-68 passing (sentinel adversarial, 7 tests). Per P3: no reason at all — name, time, link; the payload builder never sees the request row |
| PL-207 | Slack interaction endpoint (inbound)    | ⬜     | Approve only. Second auth scheme on a write path — Sprint 2's OAuth scrutiny applies    |
| PL-208 | MCP tools: request lifecycle            | ✅     | T-70 passing (9 tests). Three tools, disjoint descriptions, exactly the minimum sets on success and refusal; registry regenerated at 2.1.0 |
| PL-209 | Aircall intake webhook                  | ⬜     | **Probe first** (research.md §Spike Results). A "webhooks unreliable" result shrinks this to a form |
| PL-210 | Disclosure extension                    | ✅     | T-69 passing. Sprint 3 fields in FIELD_CLEARANCE (`reason_detail` never per P3); `reason_code` demoted to never (Sprint 2 review); TOOL_MINIMUM_FIELDS declared for the three PL-208 tools |
| PL-211 | Time-to-decision instrumentation        | ✅     | T-73 passing (5 tests). Median/p90 (percentile_cont), rates, mix by approver; counts travel with every number. SLO note recorded in the emitter's docstring |
| PL-212 | JWKS warm path + session-store decision | ✅     | T-72 passing. Warm path was already built in Sprint 2 — T-72 is the missing proof. AD-52 records the externalization trigger |
| PL-213 | Campus pilot                            | ⬜     | One week, one campus, coordinator + two approvers                                       |

**Legend:** ⬜ Not started · 🟡 In progress · 🔵 **Code-complete, AC unverified** · ✅ AC met and verified · 🔴 Blocked · ⏸️ Paused

**🔵 is not ✅.** A task blocked on a policy decision or an external dependency stays 🔵.

---

## Test status

Sprint 1's T-01…T-23 and Sprint 2's T-24…T-49 continue to run every sprint. Sprint 3 adds T-50…T-73.

| Group                        | Written | Passing |
| ---------------------------- | ------- | ------- |
| T-01…T-49 (carried)          | 49      | 49      |
| T-50…T-52 roster grain       | 3       | 3       |
| T-53…T-57 request lifecycle  | 5       | 5       |
| T-58…T-59 routing            | 2       | 2       |
| T-60…T-63 escalation         | 0       | 0       |
| T-64…T-67 actor + inbound auth | 2 (T-64, T-67) | 2     |
| T-68…T-70 disclosure         | 3     | 3       |
| T-71…T-73 intake + ops       | 2 (T-72, T-73) | 2     |

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

### Session 1 — PL-201 roster grain (2026-09-21)

**Worked on:** PL-201 — `service_date` + `student_id` linkage. First implementation task of the sprint; read Failed Approaches first (no repeats).

**Done:**

- **Migration `0004_service_date.sql`** — `service_date date not null` on `roster_syncs` and `roster_entries`, backfilled from each row's sync start; composite `(tenant_id, service_date)` indexes on both. Backfill runs with RLS temporarily disabled (migrations execute as the table owner, FORCE RLS would evaluate the tenant policy with no `app.tenant_id`); re-enabled and re-forced immediately after. Fresh databases are no-ops.
- **`students` repository** (`src/repositories/students.ts`) — `upsertStudent`: insert-when-absent keyed on `(tenant_id, student_ref)`; name/section refresh from the sheet, `do_not_call` deliberately untouched (staff-managed flag, F-4). Ingest calls it per valid row; every roster row now carries `student_id`.
- **Dated sync set** — `runSync`/`ingestSheet` take an optional `serviceDate` (derived at run time, defaulting to local today via `src/util/service-date.ts`). `deleteAllEntries` is **gone**, replaced by `deleteEntriesForDate`; the quarantined wipe is scoped by the sync's service date the same way. The scheduler ticks today on every run rather than pinning a date on job config.
- **Dated reads everywhere** — `findByStudentRef`, `findByStudentName`, `searchRosterEntries`, `countEntries`, and `existsByStudentRef` require an explicit service date (the data layer does not decide what "today" means); `getScholarStatus` derives today and accepts a request-pinned date so one request cannot straddle local midnight; `lookup_scholar_status` and `search_roster` derive the date once per request.
- **Seed** writes a dated set (today by default, explicit for tests) and populates `students` the same way ingest does. **Disclosure:** `service_date` added to `FIELD_CLEARANCE` as `never` — projection default-deny already covered it; now it is documented like the other ingestion metadata.
- **`src/db/pg-types.ts`** — the `date` OID parses as the raw `YYYY-MM-DD` string (see Surprises).

**Tests:** T-50, T-51, T-52 written in `tests/roster-grain.test.ts` and passing; carried suite updated for the new signatures and green. **Full run 2026-09-21: 24 files, 228/228 passing, local Postgres, synthetic fixtures, fixed service dates in tests** (conditions recorded per test.md's run-log convention). Standing gate green: T-01…T-05, T-33…T-35, T-52. T-60/T-68 do not exist yet — they gate the sprint, not PL-201.

**Surprises:**

- **node-postgres parses `date` as a local-midnight JS Date.** In UTC+8 that round-trips to the *previous* day in UTC — the default parser is wrong for a calendar grain in half the world. The service date is not an instant (AD-31), so the `date` OID now parses as the stored string. `service_date` is the only `date`-typed column; `timestamptz` parsing is untouched.
- **The wipe-before-ingest was the exact T-50 failure mechanism.** `deleteAllEntries` existed for T-11 idempotency and would have erased day 1 on day 2's first tick. Removing it (rather than adding a dated variant alongside) was the honest fix — leaving the unscoped delete in the codebase invites the wipe back.
- **`summarizeQuarantine` claimed "most recent sync" but counted every row ever.** Harmless while the table was wiped each sync; after the grain change it would misreport across days. Now scoped to the latest sync, matching its own docstring.
- **The name→ref resolution and the status read can straddle local midnight** if each computes "today" independently — the lookup tool now pins one service date per request. The bug is a one-in-a-day race, but it was free to close.
- **A passing test caught the Date-parse lie on the first run** — `RosterEntry.service_date: string` was typed honestly but the runtime returned a Date. The failing assertion (T-50, date equality) was the system working as designed: the test could fail its own pass condition.

**Next action:** PL-212 (JWKS warm path + session-store decision record) — the remaining unblocked implementation task. P2/P3 still gate PL-202/PL-204/PL-210; P1 measurement week still not started.

### Session 2 — PL-212 JWKS warm path + session-store decision (2026-09-21)

**Worked on:** PL-212 — the last unblocked implementation task in the sprint.

**Done:**

- **T-72 written and passing** (`tests/session-lifecycle.test.ts`): a fresh app serves its **first authenticated request** from the startup-warmed JWKS cache — the AS's fetch count does not move across the request. The test waits for the `jwks_warmed` log line, which fires *after* the warm resolves, rather than polling the fetch count; the count increments when the AS serves the document but before jose resolves it into the cache, so count-polling alone leaves a window where the request would coalesce with the in-flight fetch and pay the network wait.
- **The warm path itself was already built in Sprint 2** (`c04fba5`): construction prefetch, refresh timer, `resetJwksCache` for T-48, and T-48's own warm/cold measurements. What was missing was exactly T-72's claim — that the *first* request on a fresh process never pays the fetch. **No production code changed for the warm path.**
- **AD-52 recorded** (research.md §4 rev 5): the session store stays in process memory until a second web instance exists. Sessions hold transports only — identity is re-derived from the token on every request (AD-18), so a lost map costs a client a re-initialize, never an auth bypass or a cross-tenant disclosure. **Triggers, either forces the move:** a second web instance behind a load balancer (a session initialized on A 404s on B — a hard client failure under the T-47 typed-404 rule, not a retry), or autoscaling the web tier. Target when it fires: **Postgres**, the system of record already in the stack — the same no-new-infrastructure reasoning as AD-30.

**Surprises:**

- **The shared test server's fire-and-forget startup warm raced T-72's fetch-count measurement** — visible only when the test ran filtered (`-t T-72`), because no earlier requests had quiesced the shared server's warm. Fixed by quiescing in `beforeAll` (poll the AS fetch count to 1) rather than loosening the assertion; the count reaching 1 means the AS served the document, and jose resolves the warm on that same response before the next poll tick.
- **The sprint's remaining critical path contains no engineering.** PL-202 waits on P3; every remaining task depends on PL-202; PL-204 additionally on P2; PL-209 on the Aircall probe. With PL-201 and PL-212 done, the Generator has nothing unblocked left to build — the honest next actions are the two policy conversations, the measurement week, and Q6.

**Next action:** None unblocked for the Generator. P3 → PL-202 → the rest, in plan order. See Current state above.

### Session 3 — P3 resolved; PL-202 `pickup_requests` + state machine (2026-09-21)

**Worked on:** PL-202, unblocked by the P3 decision — recorded as a product default per AD-28's fallback and AD-43. The Generator had been blocking on a question its own artifacts had already answered: "default if unanswered: `never` for detail, no Slack category. Ship narrower, widen on a written decision."

**Done:**

- **Migration `0005_pickup_requests.sql`** — `pickup_requests`, `pickup_request_events` (append-only, `unique (request_id, escalation_level)`), `tenant_settings` (per-tenant `reason_detail` retention, default 0 = the P3 default). RLS enabled AND forced, same grants posture: events INSERT+SELECT only, UPDATE/DELETE revoked at the grant level (T-56, the `audit_log` posture); requests are never deletable. **Composite tenant FKs:** a request's scholar and contact must belong to the request's own tenant — a plain FK on `student_id` would reference across tenants; the composite keys make the write side of leak vector 21 structurally impossible, asserted by test.
- **The transition function** (`src/repositories/pickup-requests.ts`) — the single writer of `state` (T-55, guarded structurally). `draft → routed → approved | flagged | denied → released → completed`, plus `expired` off `routed` (AD-26: expiry never approves; E3: `release` is reachable only from `approved`). `FOR UPDATE` serializes concurrent transitions on one request; re-applying the settled outcome is an idempotent no-op returning the current state (T-54, the Slack at-least-once case); illegal attempts are typed refusals naming the attempted transition, with a `refused` event row (T-53). Ladder events carry their level — the unique constraint is the double-fire backstop in the database (T-57); decision and refusal events carry NULL (distinct under Postgres uniqueness, so they never collide with the ladder).
- **P3 enforcement at the chokepoint** — terminal transitions (`completed`, `denied`, `expired`) purge `reason_detail` when the tenant retention is 0; `tenant_settings.reason_detail_retention_days` widens retention as a config row, not a migration; `purgeStaleReasonDetail` is the nightly sweep (service date past, plus the retention window). `reason_category` is a five-value product-default enum (`appointment`, `family`, `illness`, `administrative`, `other`) — widened by written decision, never silently.
- **Tests** (`tests/pickup-request-lifecycle.test.ts`, 21): T-53 (three illegal transitions, each named, state unchanged, event recorded; cross-tenant id is `not_found`), T-54 (idempotent re-approval, no second decision row; conflicting re-decision after denial refused), T-55 (grep: `update pickup_requests` exists only in the transition module's two writers — `applyTransition`, which writes state and is not exported, and the retention sweep, which sets `reason_detail` only), T-56 (grant-level append-only), T-57 (double-fire rejected as 23505; distinct rungs coexist; escalate advances level + clock), P3 (terminal purge on all three terminal states, widened retention retains, sweep purges past-date only), isolation (cross-tenant invisibility; composite FK rejects a cross-tenant scholar).

**Full run 2026-09-21: 25 files, 250/250 passing** (229 + 21), local Postgres, synthetic fixtures. Standing gate green: T-01…T-05, T-33…T-35, T-52.

**Surprises:**

- **The sweep compares against the real clock, and the first fixture was fictional-future.** A "past" service date of 2030 purges nothing when today is 2026 — the test failed its own pass condition on the first run. Test dates that mean "past" must be past the real clock; dates that mean "deterministic" may be fictional.
- **The plan's `unique (request_id, escalation_level)` cannot be a plain constraint if decisions are events** — `routed@0` and `approved@0` would collide. Resolution: the constraint IS plain, exactly as written; ladder events carry levels, everything else NULL (Postgres treats NULLs as distinct). The plan's intent — one notification per rung — holds literally, and refusal events never collide.
- **`assigned_approver_id` ships without a foreign key, on purpose** — `staff_identities` is PL-205's table with its own schema decisions. A uuid now so the reference never changes shape when the FK lands.
- **T-53 and T-57 could have conflicted** — both write event rows, and a refusal event at the request's current level would collide with that level's ladder event. NULL-level refusal events resolve it without weakening either guarantee.

**Next action:** PL-203 (approver routing resolver) — unblocked; AC is T-58 and T-59. Then PL-205 → PL-206 → PL-208 → PL-210 → PL-211 in plan order. PL-204 waits on P2 unless the ladder-as-required-config option is taken; PL-209 on the Aircall probe.

### Session 4 — PL-203 approver routing resolver (2026-09-21)

**Worked on:** PL-203 — the tribal-knowledge artifact (F-15): `approver_routing` + the resolver. Built across the branch interruption: the harness/v2 rework stashed this WIP mid-flight (recovered via stash pop after the user committed their harness work as `a5873c5`).

**Done:**

- **Migration `0006_approver_routing.sql`** — the `approver_routing` table: `scope_type` (section | grade | default), `scope_value`, `approver_id` (uuid, resolves against `staff_identities` in PL-205 — same forward-compatible pattern as `assigned_approver_id`), `priority`. RLS enabled and forced, full CRUD grants (config, tenant-scoped). **`students.grade`** added (nullable): the attribute grade rules match, populated per campus when their sheet carries it; a null grade simply never matches and falls through.
- **Totality is structural:** a partial unique index (`one default per tenant`) plus the seed-time assertion `assertApproverRoutingTotal` — wired into `npm run seed`, which now seeds a section rule and a default per fixture tenant and **throws** if a tenant lacks a default (T-59's loud failure, not a 1:50 pm nobody).
- **The resolver** (`src/repositories/approver-routing.ts`) — most-specific-wins (section > grade > default), deterministic by construction (one section and one grade per scholar; unique rules; a total-order fallback on priority then scope value), total via the default rule. No-match-with-no-default is a typed refusal `routing_not_total` — the caller degrades to a human (Rule 10). An invisible scholar is `student_not_found`, indistinguishable from nonexistent.
- **Tests** (`tests/approver-routing.test.ts`, 12): T-58 (section beats grade beats default; grade over default; default catches the rest; null grade never matches; same input → same approver ×10; every scholar resolves to exactly one; colliding section codes stay tenant-scoped) and T-59 (totality assertion throws `RoutingNotTotalError`; resolver refuses rather than resolving to nobody; `student_not_found`; a second default row rejected as 23505 — the partial unique index; adding the default makes resolution total).

**Full run 2026-09-21: 26 files, 262/262 passing** (250 + 12), local Postgres, synthetic fixtures. Standing gate green.

**Surprises:**

- **`NULLS NOT DISTINCT` has a syntax order** — the modifier goes before the column list, not after (`unique nulls not distinct (cols)`). First draft put it after and got a syntax error. Resolved with the clearer form anyway: a plain unique for rule dedup plus a partial unique index that says "one default per tenant" directly.
- **The plan's grade scope had no source.** `students` carried no grade — T-58's grade rule had nothing to match. The registry gains a nullable `grade`, populated per campus when their sheet maps it (a canonical widening, by written decision) or at provisioning. Documented in the migration rather than silently derived from section codes — a section→grade convention would have been an invention.
- **A mid-flight branch switch by the user stashed this WIP** — the recovery path (commit their harness work, switch, pop, restore untracked files) is recorded here because the stash's message is the only durable trace of the interruption.

**Next action:** PL-205 (`staff_identities` + Slack actor mapping) — AC T-64, T-67. Then PL-206 → PL-208 → PL-210 → PL-211. PL-204 waits on P2 unless the ladder-as-required-config option is taken; PL-209 on the Aircall probe.

### Session 5 — PL-205 staff_identities + Slack actor mapping (2026-09-21)

**Worked on:** PL-205 — the Slack actor resolves to the audit subject (AD-29), the gate that keeps E5 honest at the one point a human decided.

**Done:**

- **Migration `0007_staff_identities.sql`** — the mapping table: `(tenant_id, slack_user_id, subject, role)`, unique per (tenant, slack id), RLS enabled and forced, full CRUD grants. **The deferred FKs landed as promised in PL-202/203**: `approver_routing.approver_id` and `pickup_requests.assigned_approver_id` now composite-FK to `staff_identities (tenant_id, id)` — a configured approver must be registered staff, because the fast decision path (PL-207) arrives over Slack and an unmapped approver could never be notified. `NOT VALID` on purpose: pre-registry seeded rows exist in dev databases; new writes are enforced, the seed inserts identities before routing, so fresh seeds are fully consistent — VALIDATE after any old dev DB is re-seeded.
- **`pickup_request_events.channel`** (`slack` | `app` | `worker`, default `app`) — T-67's "the channel it arrived through" lives on the decision row; the transition function records it.
- **Repository** (`src/repositories/staff-identities.ts`) — `insertStaffIdentity` (optional id so approver config can reference a known identity) and `findStaffIdentityBySlackUserId` (RLS-scoped: a slack id mapped only in another tenant is simply not found). Plus `findStudentById` on the students repo, so refusal rows can name whose request was blocked.
- **The decision service** (`src/services/pickup-decision.ts`) — `decidePickupRequestAsSlackActor`: unmapped actor → typed refusal `unmapped_slack_actor`, **audited**, no state change (T-64); mapped → the transition runs under the **subject**, never the slack id, with channel `slack`. Every call writes exactly one `audit_log` row (the T-16 discipline): refusal rows carry the raw slack id — "who tried and failed to act" is exactly what staff need to close a mapping gap — decision rows carry the subject.
- **Seed + fixtures**: staff identities for the four fixture approvers, inserted before the routing rules; the routing test file registers its five approvers the same way.
- **Tests** (`tests/slack-actor.test.ts`, 6): T-64 (unmapped → refusal with state unchanged and an audit row; a foreign-tenant mapping is equally unmapped — identical refusal; invisible request → `not_found`) and T-67 (request row, event row, and audit row all carry the subject + channel; zero events attributable to a slack id; slack vs app channels distinguishable; the at-least-once replay is idempotent — one decision event, `success:idempotent` audit).

**Full run 2026-09-21: 27 files, 268/268 passing** (262 + 6), local Postgres, synthetic fixtures. Standing gate green.

**Surprises:**

- **A pipe hid a type error inside a green verify step.** `npm run typecheck | tail -3 && npm run lint` tested `tail`'s exit code, not `tsc`'s — the `exactOptionalPropertyTypes` failure (passing `channel: request.channel` into an optional param) sailed through and only surfaced when a later run wasn't piped. Fixed by normalizing `request.channel ?? 'app'` once, and logged as a Failed Approach — the third `exactOptionalPropertyTypes` bite in this project's history.
- **The refusal audit row deliberately carries the raw slack id** while decision rows never do — the asymmetry is the point: T-67 forbids slack-id *decisions*, not slack-id *evidence*. A refusal that cannot say who was refused closes no mapping gaps.
- **One human, two Slack accounts is legal** (several slack ids → one subject); the reverse is not (unique per tenant + id). Everything audits as the human.

**Next action:** PL-206 (Slack notification surface, outbound) — AC T-68, the sentinel adversarial pass; the P3 decision means the payload carries no reason at all. Then PL-208 → PL-210 → PL-211. PL-204 waits on P2 unless the ladder-as-required-config option is taken; PL-209 on the Aircall probe.

### Session 6 — PL-206 Slack notification surface, outbound (2026-09-21)

**Worked on:** PL-206 — the outbound half of the Slack surface, graded by T-68 (GATE): `reason_detail` never leaves Postgres.

**Done:**

- **Slack client surface** (`src/slack/`): `SlackClient` (post a message, get a typed result — no throws in the contract), `WebApiSlackClient` (`chat.postMessage` over plain HTTPS — no SDK, per the no-new-infrastructure posture; token at construction, never logged), and `CaptureSlackClient` (records every message it **would** have put on the wire, including on failure — what a failing send would have sent is part of the leak surface; can fail or throw on demand).
- **The notification service** (`src/services/pickup-notification.ts`): DM to the named approver (their `staff_identities` slack id — AD-27) + low-detail thread in the visibility channel. **Payload discipline is structural:** `buildPickupNotificationPayloads(studentName, pickupAt, link)` takes only the three fields it may carry and never receives the request row, so `reason_detail` cannot reach a message even by mistake. Per the P3 decision the payload carries **no reason at all** — not the category, not the detail. Notifications are a side effect, never a gate: typed refusals (`not_found`, `no_assigned_approver`, `send_failed`), logs carry metadata only.
- **A throwing client is contained** (`postSafely`): the exception's message is deliberately neither propagated nor logged — it is the one string in this path we do not control, and an exception message that embeds payload content must not become the leak (T-68's forced-exception leg).
- **T-68** (`tests/slack-notification.test.ts`, 7): the DM and thread carry name/time/link and no sentinel **and no reason category** (the P3 fail condition, not just AD-28's); log lines carry metadata only — no sentinel, no message text, not even the link; a failing client's attempted messages and logs stay clean; a throwing client is contained with `client_exception` and no exception text; unassigned → typed refusal with nothing sent; invisible and cross-tenant requests → `not_found` with nothing sent.

**Full run 2026-09-21: 28 files, 275/275 passing** (268 + 7), local Postgres, synthetic fixtures. Standing gate green.

**Surprises:**

- **The composite FK caught my own test setup.** The cross-tenant test routed tenant B's request to tenant A's approver identity — the `pickup_requests_approver_fk` from PL-205 rejected the route before the test could assert anything. The protection working as designed is the best kind of test failure: fix the fixture, not the guard.
- **Wiring is deliberately absent.** Nothing calls the notifier yet — the worker (PL-204) and the route flow (PL-208) are its callers. Adding config keys now would be dead config; they land with the first wiring.
- **T-68's tool-response legs (success and refusal) are not yet testable** — the tools are PL-208. The projection chokepoint already default-denies `reason_detail` (no FIELD_CLEARANCE entry), and PL-210 formalizes the clearance map for the Sprint 3 fields.

**Next action:** PL-210 (disclosure extension — FIELD_CLEARANCE + TOOL_MINIMUM_FIELDS for the Sprint 3 fields, `reason_code` demoted per the Sprint 2 review), then PL-208 (the three request-lifecycle tools, T-70), then PL-211. PL-204 waits on P2 unless the ladder-as-required-config option is taken; PL-209 on the Aircall probe.

### Session 7 — PL-210 disclosure extension (2026-09-21)

**Worked on:** PL-210 — the clearance map grows to the tables that carry the sensitive content. Done ahead of PL-208 (the plan sequences 208 after 210) so the tools implement against a declared policy rather than inventing one.

**Done:**

- **FIELD_CLEARANCE gains the Sprint 3 fields** (pickup_requests): `reason_detail` is `never` (the P3 decision — written at intake, read only in-app under a tenant context with an audit entry, purged at terminal states); `reason_category` is `staff` (the disclosable form); the decision surface (`request_id`, `state`, `pickup_at`, `escalation_level`, `decided_at`, `decided_by`) is `staff`; the clock/lifecycle timestamps and internal references (`escalate_at`, `released_at`, `completed_at`, `expired_at`, `created_at`, `assigned_approver_id`, `requested_by_contact_id`, `intake_channel`) are `never` — internal until a tool earns them, widened by written decision.
- **The Sprint 2 review finding is closed**: `reason_code` demoted from `staff` to `never` — it was kept out of responses only by the minimum-set gate, with clearance alone permitting it ("the reason goes to a private channel," README). No existing minimum set contains it, so the demotion breaks nothing and forecloses the future leak.
- **TOOL_MINIMUM_FIELDS declares the three PL-208 tools before they exist**: `create_pickup_request` [`request_id`, `state`], `list_pending_approvals` [`request_id`, `student_name`, `pickup_at`, `reason_category`, `escalation_level`], `decide_pickup_request` [`request_id`, `state`, `decided_at`]. Declaring first means T-69/T-70 grade default-deny against a real policy.
- **T-69** (`tests/disclosure-extension.test.ts`, 5): the canary leg — a brand-new column (`t69_canary`) ALTERed onto `pickup_requests` with no clearance entry anywhere rides on every `select *` row and survives **no** projection, for every tool, at every role; the new tools' projections carry exactly their declared minimum sets; `reason_detail`/`reason_code` pinned `never` in the map and absent in behavior; internal references pinned `never`.

**Full run 2026-09-21: 29 files, 280/280 passing** (275 + 5), local Postgres, synthetic fixtures. Standing gate green.

**Surprises:**

- **The minimum-set field is `request_id`, but the row's PK is `id` — and `id` is `never`-cleared.** A generic PK is not a response field; the tools (PL-208) present it as `request_id` on the shaped row they project. The first T-69 run failed on exactly this — the test now shapes the row the way the tool layer will, and the contract is recorded for PL-208: never project the raw `id`.
- **The demotion broke nothing** — `reason_code` appears in no minimum set, so the E2E suites never saw it. The finding was clearance *latently permitting* a field no tool currently returns; the demotion forecloses the future tool that would have leaned on it.

**Next action:** PL-208 (the three request-lifecycle tools — T-70), then PL-211. PL-204 waits on P2 unless the ladder-as-required-config option is taken; PL-209 on the Aircall probe.

### Session 8 — PL-208 MCP tools: request lifecycle (2026-09-21)

**Worked on:** PL-208 — the three staff tools, graded by T-70. Built against the disclosure ground PL-210 laid (minimum sets and clearances existed before the tools).

**Done:**

- **`create_pickup_request`** — coordinator-entered intake: scholar, pickup time, reason category, optional detail. Resolves the student by ref (unknown ref → typed refusal, nothing invented), resolves the ONE named approver (PL-203) BEFORE creating anything — no orphan drafts — then creates and routes with the clock set to the pickup time (decide before the parent arrives; until PL-204 the clock is data, the worker owns ladder semantics). `routing_not_total` refuses and degrades to a human (Rule 10). Notifications deliberately NOT wired here — no Slack credentials exist; the callers are the worker and the Slack flow.
- **`list_pending_approvals`** — the caller's own queue (AD-27: one named approver, so the queue is theirs), resolved through `staff_identities` by audit subject: a caller with no identity in this tenant has an empty queue, which is honest, not an error. Today's service date, `routed` state, ordered by pickup time. No arguments — approver and date derived server-side.
- **`decide_pickup_request`** — approve/flag/deny with a note. The caller's verified-token subject is `decided_by` (the app actor arrives AS the subject — AD-29's distinction from Slack actors). The note is a declared parameter that lands somewhere real (AD-15): a new `pickup_request_events.note` column (migration 0008), clearance `never` — decision-adjacent free text, same discipline as reason_detail. Idempotent replays are successes (T-54's discipline); cross-tenant and unknown ids are `not_found`, conflicting re-decisions are `illegal_transition`.
- **Registration + versioning**: the three tools registered (six total), `TOOL_NAMES` extended, `SCHEMA_VERSION`/`SERVER_VERSION` bumped to 2.1.0 with a changelog entry, the registry fingerprint regenerated. The test helper now seeds staff identities + approver routing per tenant (identities before rules — the composite FK checks every new row).
- **T-70** (`tests/pickup-tools.test.ts`, 9): each response carries exactly its declared minimum set on success and refusal; the intake sentinel (reason_detail) never returns in structured content or text; the DB row is routed + assigned + clocked to pickup time with the detail stored, not returned; unknown scholar creates nothing; the queue is the caller's with exactly the minimum set per row; non-approvers get an empty queue, not an error; decisions record the caller's subject with the note on the event; foreign-tenant ids are `not_found`; conflicting re-decisions refuse without overwriting; the three descriptions are disjoint (each names its own action and tells the model when to use another); the unit leg — a full row projected through every minimum set discloses no reason detail.

**Full run 2026-09-21: 30 files, 289/289 passing** (280 + 9), local Postgres, synthetic fixtures. Standing gate green; registry check green at 2.1.0.

**Surprises:**

- **T-55's structural guard caught the queue read and had to be taught the difference between a WHERE and a SET.** `listPendingApprovalsForApprover` filters `where pr.state = 'routed'`; the guard's `\bstate\s*=` pattern flagged it. The guard now matches the write shape (`set … state =`) — reads may filter on state, writes may not — and the export allowlist gained the queue function. The guard being wrong twice in two sessions is it working: each change to that module has to argue with the test.
- **The fourth `exactOptionalPropertyTypes` bite**, same class as the last three: `note: args.note` into an optional param. The spread pattern (`...(x !== undefined ? { x } : {})`) is now the house style for optional threading — worth remembering before the fifth.
- **The create tool resolves the approver before creating the request.** The first design would have left orphan drafts on a routing failure; resolution is student-based (PL-203), so it can run pre-create. No draft exists that the system cannot route.

**Next action:** PL-211 (time-to-decision instrumentation — T-73), the last unblocked implementation task. Then PL-213 (pilot) once PL-204/PL-209 land. PL-204 waits on P2 unless the ladder-as-required-config option is taken; PL-209 on the Aircall probe.

### Session 9 — PL-211 time-to-decision instrumentation (2026-09-21)

**Worked on:** PL-211 — the sprint's governing SLO, measured. The last unblocked implementation task: **every task the plan gates on decisions alone is now done.**

**Done:**

- **The metrics repository** (`src/repositories/decision-metrics.ts`): median and p90 time-to-decision (routed → decided, the glossary's definition) via PostgreSQL's `percentile_cont` ordered-set aggregates — computed in the database, not shipped for sorting. Escalation rate and expiry rate (the plan's two named signals: high escalation means routing is wrong; high expiry means the policy is wrong). Decision mix by approver — grouped by the audit subject (`decided_by`), never a raw id. **Counts travel with every number** — a measurement with no conditions is not a number (E2's discipline). Reads only; `state` is never written there (T-55 holds).
- **The emitter** (`src/services/decision-metrics.ts`): one structured line per tenant — numbers, conditions, and nothing else (no scholar identifiers). The tenant comes from configuration in the `SyncJob` tradition — runbook/ops infra, not a request-scoped argument (Rule 7). **The SLO note lives in the emitter's docstring:** the Alexa 500 ms budget does not govern this surface; time-to-decision is in minutes. The operational runbook itself is on the deferred list (unscoped and overdue) — the docstring is its interim home, and the note says so.
- **T-73** (`tests/decision-metrics.test.ts`, 5): constructed timings — three decided requests at 10/20/30 minutes, one escalated-then-denied, one expired — with the routed-event and decided-at timestamps backdated as exact values, so median (1200s) and p90 (1680s; `percentile_cont` interpolates — rank 1.8 of [600, 1200, 1800] is 1200 + 0.8·600) are **asserted, not approximated**. Escalation rate 0.25, expiry rate 0.25; the mix by approver exactly; an empty tenant is well-formed (null percentiles, zero rates, no mix — no divide-by-zero, no fake zeros standing in for no-data); the emitter's line carries numbers + conditions + tenant_id and no scholar data. E2's number itself lands with the pilot (PL-213) alongside the P1 baseline — the machinery that records it with its conditions is what this task owed.

**Full run 2026-09-21: 31 files, 294/294 passing** (289 + 5), local Postgres, synthetic fixtures. Standing gate green.

**Surprises:**

- **`percentile_cont` interpolates.** With three samples, p90 is not the third value — it is 80% of the way from the second to the third. The test asserts 1680s with the arithmetic in a comment, because the next reader will assume 1800 and "fix" it.
- **The fifth `exactOptionalPropertyTypes` bite** — same class again (`escalateAt: cond ? x : undefined`), caught by typecheck before it could hide. The spread pattern is now reflexive; the Failed Approach line already covers the class.
- **The metrics were buildable without PL-204 despite the plan's dependency edge** — the worker is only the thing that would IMPROVE the numbers; the measurement is read-side over what exists. Pre-worker, escalation rate will read near zero and expiry rate exactly zero — which is itself a condition worth recording, not a reason to defer the instrumentation.

**Next action:** None unblocked for the Generator. The critical path is entirely human: P2 (or the ladder-as-required-config option for PL-204), the Aircall probe (PL-209), P1's baseline (E2), Q6. Then PL-213.

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
| S2      | **AD-52 session store in-memory until a second web instance** | PL-212: sessions hold transports only (AD-18), so the single-instance assumption holds; second instance or autoscale forces the move — to Postgres, not a broker | ✅ §4 rev 5 |
| S3      | **P3 resolved — product default** (AD-28 fallback + AD-43) | Clearance `never`, no Slack category; purge at terminal state + nightly end-of-service-date sweep; per-tenant retention setting. Widening either value requires a written decision | ✅ §Spike Results |

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