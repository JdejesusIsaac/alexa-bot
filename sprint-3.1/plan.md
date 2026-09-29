# plan.md — Sprint 3.1: Repair the Approval Path

**Sprint goal**

> Close what the Sprint 3 evaluation found. The sprint built every piece of the approval path and wired almost none of it: any mapped actor could approve any request, the approver's DM carried no way to approve, the notifier had no caller, `release` and `complete` were unreachable, the first escalation fired when the parent was already due, stuck rows starved the queue forever, the timing instrument read the wrong index, and a worker exception could kill the process. This sprint repairs those — nothing else.

**Companion artifacts:** `sprint-3.1/test.md` (T-74…T-83) · `sprint-3.1/progress.md` (task board, Failed Approaches). Sprint 3's artifacts (`sprint-3/plan.md`, `test.md`, `research.md`) stand unchanged — this is a repair sprint under the failure protocol, not a re-plan. Decisions settled here land in `research/research.md` §4 the same session.

**Why this sprint exists.** Sprint 3 was evaluated at ≈69% weighted against a 90% bar. No hard-fail fired and the isolation gate is green; it failed on score and on unmet exit criteria. The evaluator listed nine findings in discovery order; this plan works them in a different order — a self-approval path on a child-release flow outranks everything else here. Also on file: one evaluation-log observation (every hook line was `payload-probe.py`; the harness ran the Step-0 probe config for the entire sprint, so no gate ever fired) and three items recorded by the author after the evaluation so as not to contaminate it.

**This is a repair sprint. If a task reads like a new feature, it is written wrong.** Everything here is enforcement, wiring, or instrumentation of what Sprint 3 already built.

---

## Scope

**In scope:** evaluation findings 1–6, 8, 9; the `SECURITY DEFINER` surface in migration 0009; a worker attempt ceiling with a terminal human-handoff state; the PL-206/PL-207 board revert; prerequisite H.

**Out of scope:** PL-209 (Aircall probe — human-gated) · PL-213 (pilot — human-gated) · finding 7 (PL-209 is not built because it is not startable; nothing to repair) · any Sprint 4 or 5 work · any new capability · re-opening Sprint 3's plan or research.

---

## Prerequisites — blocking, not tasks

| # | Item | Blocks | Runs in parallel? |
| - | ---- | ------ | ----------------- |
| H | **The harness is not running.** `.windsurf/hooks.json` still carries the Step-0 probe config (`payload-probe.py` on every event); the failure check, spike gate, evaluator isolation, and both guards have never fired. The evaluator's "I did not read progress.md" was discipline, not enforcement. Swap in the real wiring — `pre_user_prompt` → `phase-writer.py`; `pre_write_code` → `student-data-guard.py`, `tenant-isolation-guard.py`, `artifact-budget-guard.py`, `failure-check.py`, `spike-gate.py`; `pre_read_code` and `pre_run_command` → `evaluator-isolation.py`; `pre_mcp_tool_use` → `mcp-phase-router.py` — then run `bash .windsurf/verify-hooks.sh` and record the result in progress.md (expect 10/10). | **All implementation.** No code is written before this lands. | No |
| P2 | **Escalation ladder policy** — still open from Sprint 3. The worker still cannot run a real ladder; T-63's recorded-policy assertion still cannot exist. | T-63's real assertion (still gated — stated plainly, not ✅) | Yes |

**Verify hooks are live at the start of the sprint, not the end.** That line is now in Failed Approaches because this sprint exists partly because it wasn't.

---

## Exit criteria — graded separately (AD-14)

Sprint 3's six criteria carry forward. **The sprint's measurable goal is E5 and E6** — the two this sprint can actually move:

| # | Criterion | Status entering 3.1 | Sprint 3.1 |
| - | --------- | ------------------- | ---------- |
| E1 | One week live at one campus | Human-gated (PL-213) | **Stays open — no pilot this sprint** |
| E2 | Median time-to-decision + P1 baseline | Human-gated (P1 not started) | **Stays open — no baseline exists** |
| E3 | Zero scholars released without a recorded decision | **Holds vacuously — `release` was unreachable** | Structural half becomes real once PL-252 wires `release`; the observational half stays human-gated. Vacuous satisfaction is not satisfaction — record it that way. |
| E4 | `reason_detail` never leaves Postgres | Green (T-68, T-69) | Held — the new interactive payloads get the same sentinel treatment (T-76) |
| E5 | Every decision audited with an actor resolved through `staff_identities` | **Violated in reach if not yet in fact** — app-channel decisions never touched `staff_identities`, and HF5's wording let it pass | **The measurable goal.** T-75 (GATE) enforces it on both channels; HF5 is widened to match |
| E6 | Zero cross-tenant leakage through the new tables and the Slack surface | Timing assertion was measuring index 1 of 200 — unproven | **The measurable goal.** T-74 fixes the instrument; T-82/T-83 prove membership-only resolution and real parity |

---

## Task status convention

Unchanged. ⬜ not started · 🟡 in progress · 🔵 **code-complete, AC unverified** · ✅ AC met and verified · 🔴 blocked · ⏸️ paused. **🔵 is not ✅** — and after this sprint's findings: **grep for a caller before marking ✅.** Code that nothing calls is code-complete at best.

---

## Tasks

Priority order is the commission's, not the report's numbering.

### PL-251 — Decision authorization: only the assigned approver decides (findings 2, 3)

A self-approval path on a child-release flow is the worst defect in the report. Today any mapped Slack actor — and any authenticated app caller at all — can approve any request, including the coordinator who created it. `decidePickupRequestAsSlackActor` never compares the actor to `assigned_approver_id`; `decide_pickup_request` never touches `staff_identities`. AD-27 and E5 are both claimed in the plan and neither is enforced.

**Enforce in the chokepoint, not in two call sites.** The Sprint-2 F-1 lesson applies: a rule held by memory in two places is a rule that fails in the third. `transitionPickupRequest` is the one place every channel must pass through, so the check lives there:

- Decision actions (`approve`, `flag`, `deny`) require the caller's resolved `staff_identities` id. Inside the locked row: identity ≠ `assigned_approver_id` → typed refusal `not_assigned_approver`; decider subject = the `routed` event's actor (the request's creator) → typed refusal `self_approval`. Both write refusal events and audit rows; no state change.
- The **Slack** path passes the identity it already resolves (slack_user_id → `staff_identities`); `unmapped_slack_actor` stands, now joined by the two new refusals. `not_assigned_approver` may return a distinct wire response — the actor is authenticated tenant staff, and "not your request" is honest, not a leak; the not-found indistinguishability (T-66) applies to actors the tenant does not know at all.
- The **app** path (`decide_pickup_request`) resolves `identity.sub` → `findStaffIdentityBySubject` first. An unresolved subject is a typed refusal `unmapped_actor`, audited — this is the case widened HF5 exists to catch.
- Deliberate consequence, stated plainly: if a campus's routing assigns the request's own creator, that request cannot be decided by them — it escalates to the next rung. That is the point of the control.
- `escalate`, `expire`, `route`, `release`, `complete` are unaffected — they are not decisions (see PL-252 for release/complete's own gate).

**AC:** T-75 (new GATE) passes. Zero decision rows whose actor is unresolved in `staff_identities`, on any channel; zero decisions by a non-assignee; zero self-approvals by the creator. HF5 amended (contract below). Existing T-53/T-54/T-70 still pass with test callers updated to resolve through `staff_identities`.

### PL-252 — Wire the loop: the approval path changes what happens at 1:50 pm (finding 6)

The sprint's actual purpose. `sendPickupNotifications` has no caller in `src/`, the DM is text-only so no approve action can exist, and nothing calls `release` or `complete`.

- `SlackMessage` gains optional `blocks`. The approver DM carries a Block Kit `actions` block with a button: `action_id: 'approve'`, `value: <request_id>` — the exact shape the interaction endpoint already parses. The payload allowlist is unchanged: scholar name, pickup time, link, request id — nothing else enters the builder, so T-68's guarantee covers the blocks too.
- `sendPickupNotifications` gains its callers: after a successful `route` in `create_pickup_request` (DM + visibility thread), and in the worker after each `escalate` (DM to the **newly assigned** approver) and on `expired`/`stalled` (visibility thread — there is no DM target on a terminal state). Notification is a side effect, never a gate: a failed or thrown send is a typed result and a log line, never a failed transition.
- New config, following `SlackInteractionDeps`/worker-env precedent: `SLACK_BOT_TOKEN`, `SLACK_VISIBILITY_CHANNEL`, `PICKUP_REVIEW_URL` (the link base). Tool deps and the worker accept an optional notifier; **absent Slack config → notification skipped with a log, transitions unaffected** — the system works without a Slack tenant configured.
- `release` and `complete` become reachable through a new tool **`record_pickup_outcome`** — a fourth request-lifecycle tool rather than a widened `decide_pickup_request` enum, because releasing a scholar is not a decision and the descriptions must stay disjoint (AD-16). Actions: `release`, `complete`. Authorization: caller resolves through `staff_identities` (same posture as PL-251's app path — an unresolved subject refuses), but **need not be the assignee** — the front office releases, not the approver. The state machine already enforces `release` only from `approved`, `complete` only from `released`. Minimum set declared in `TOOL_MINIMUM_FIELDS`; schema registry → 2.2.0 with changelog.

**AC:** T-76, T-77 pass. A request created through the tool produces a DM with a working approve action and a thread post; escalation notifies the new rung's approver; approve → release → complete is drivable end to end; the sentinel appears in no block, text, or log line.

### PL-253 — The level-0 clock: escalation starts before the parent is due (finding 5)

`create_pickup_request` sets `escalateAt: pickupAt`, so the first rung fires at the pickup time — when the parent is already at security. The level-0 deadline is policy, and policy lives in the ladder file.

- The ladder schema gains a required `initial_minutes`: the deadline the first named approver gets before rung 1 fires. The fixture ladder gains an obviously-fake value (1 minute) with the note updated.
- Route sets `escalate_at = min(pickup_at, now() + initial_minutes)` when the web process has a ladder (`ESCALATION_LADDER_FILE`, the same env the worker reads — loaded once at construction, injected for tests).
- **When no ladder is configured the request still routes** with `escalate_at = pickup_at` and a `initial_clock_unconfigured` warning — an honest posture, not a silent one: without a written ladder no worker can run, so the clock is inert data either way. The failure the evaluator named only becomes live when P2 lands; this fix makes the ladder the source of the level-0 clock so that day it already works.
- Rows written before this change keep their stored `escalate_at` — stated, not silently migrated.

**AC:** T-76's clock leg passes: a routed request under a configured ladder has `escalate_at < pickup_at` equal to now + `initial_minutes`; without a ladder the row routes with `pickup_at` and the warning is emitted.

### PL-254 — The escalation queue: fairness, a ceiling, and per-tenant ladders (finding 4 + author's item)

Three defects in one queue: skipped and failing rows keep their `escalate_at`, the due query sorts oldest-first with `limit batchSize`, so healthy rows starve behind poisoned ones; skipped rows never reach `expired`, so no in-person handoff ever happens; and one shared ladder file carrying per-tenant approver subjects means a worker covering two tenants skips every row for the second.

- **Deferral.** A row that skips or fails does not keep its slot. `escalate_at` is deferred (now + a bounded deferral, defaulting to the poll interval) and `escalation_attempts` (new column, migration 0010) increments — in the repository, inside the still-open transaction after the savepoint release/rollback. `escalate_at` is not `state`; T-55's guard is unaffected, and the write still lives in the repository layer (Rule 11).
- **Ceiling → terminal human handoff.** At `ESCALATION_MAX_ATTEMPTS` (config, default 20) the worker transitions the row to a new terminal state **`stalled`** (new action `stall`, legal only off `routed`): audited, `reason_detail` purged as terminal, and the outcome routes the coordinator to in-person handling. Per AD-26 **`stalled` never behaves like `approved`** — it is terminal, unreachable by `release`/`complete`, and a wronged family gets a human, not a zombie row. A stalled row leaves the due queue by construction (`state != 'routed'`).
- **Per-tenant ladders.** `ESCALATION_LADDER_FILE` (single file) becomes `ESCALATION_LADDER_DIR` — `<dir>/<tenant_id>.json` per `WORKER_TENANTS` entry. A configured tenant with no file is a boot refusal naming the tenant and the missing path — same posture as today, now per campus, which is also where P2's answer actually lives. Fixture ladders live at `src/fixtures/escalation/` with the same obviously-fake shape per fixture tenant.

**AC:** T-78, T-79 pass. A poisoned row cannot starve a healthy one; a stuck row reaches `stalled` and a human; a two-tenant worker with two ladder files processes both queues; a missing per-tenant file refuses boot naming it.

### PL-255 — Fix the instrument before the measurement (finding 1, first half)

`percentile(values, 0.9)` in `tests/slack-interactions.test.ts` divides by 100 a second time and reads **index 1 of 200** — T-66's p90 assertion was comparing the second-fastest sample of each run and could not fail. Land this before any timing work, because right now there is no measurement to trust. This is Sprint-2 F-2 recurring: a test that cannot fail its own pass condition.

- Correct the helper to the same semantics as the (correct) copy in `tests/mcp-audit.test.ts`.
- Add T-74: the instrument asserts itself — `percentile` of a constructed distribution returns the tail element it claims to, and the timing comparison asserts the samples carry real variance (a distribution of identical values cannot "pass" a parity check).

**AC:** T-74 passes and fails when the index math is broken. Sequenced ahead of PL-257.

### PL-256 — Membership-only tenant resolution (author's item, migration 0010)

`find_pickup_request_tenant` is a `SECURITY DEFINER` function returning `tenant_id` — it runs as owner, bypasses the forced RLS that is the whole point of the schema, and hands any EXECUTE holder an oracle that maps `request_id` → owning tenant and confirms existence.

- Migration 0010 drops it and creates `pickup_request_belongs_to_tenant(p_request_id uuid, p_tenant_id uuid) returns boolean` — still SECURITY DEFINER (the endpoint has no tenant context to invoke under), still read-only, but it confirms membership rather than disclosing the mapping. `revoke all from public`; `grant execute` to `parentline_app` only — and the test asserts that grant posture, not just the behavior.
- The endpoint gains a configured tenant list (`SLACK_TENANT_IDS`, comma-separated — configuration, never a caller argument, Rule 7). Resolution = membership probes, not disclosure.
- New leak vector **30** recorded in research.md: *a SECURITY DEFINER read returning tenant-scoped values to a caller with no tenant context* — narrow such functions to boolean membership and pin their grants.

**AC:** T-82 passes — the function returns true only for the owning tenant, returns no `tenant_id`, and `information_schema`/`pg_proc` inspection shows execute granted to `parentline_app` and no one else.

### PL-257 — Close the timing parity gap (finding 1, second half)

Cross-tenant runs the full decision path; nonexistent returns after the lookup. With the instrument fixed (PL-255) that gap is measurable, so close it structurally:

- The endpoint probes **all** configured tenants via the boolean function — no early exit; the probe count is constant whether the id exists or not.
- On a match: the decision path runs under the resolved tenant as today.
- On no match: run the **decoy** decision sequence against the first configured tenant — `withTenant` + `findPickupRequestById` + identity lookup + audit — so a nonexistent id performs the same query profile as a real one. The decoy's audit row is honest (`refusal:not_found` in that tenant's context).
- The wire stays byte-identical in all not-found shapes (T-66 unchanged); only the timing distribution equalizes.

**AC:** T-83 passes — median and p90 (a percentile that actually reads the tail) for cross-tenant vs nonexistent are indistinguishable under T-42's tolerance, and the test now asserts the instrument discriminates (T-74) rather than trusting it.

### PL-258 — Unaudited error paths (finding 9)

Sprint 2's F-1 class recurring on the new surfaces:

- **Slack handler.** A thrown error in the decision section currently becomes a 500 with a log line and no audit row. Wrap the post-auth section: a throw produces an audited `error:slack_internal` boundary row and a generic 500 — **not** the not-found shape; an error is not part of the oracle surface and must not be trained into it.
- **Worker.** `setInterval(() => void this.tick())` means a whole-tick rejection is an unhandled rejection — which exits the process on Node 20. That is a reliability bug in its own right, not just an audit gap. `this.tick().catch(...)` in the interval callback; a per-tenant `try/catch` inside `tick()` so one tenant's failure cannot starve the others; each failure logged and audited under its tenant where resolvable; a consecutive-failure counter emits a loud `worker_unhealthy` error line. The worker keeps polling — a transient DB failure is retried next tick, not fatal.

**AC:** T-80, T-81 pass — the thrown-decision 500 writes an audit row; a rejecting tick leaves the process alive and the other tenant still processes; the failure is visible in stats, log, and audit.

### PL-259 — Artifact hygiene (finding 8 + author's item)

- **Sprint 3 board:** PL-206 and PL-207 revert from ✅ to 🔵 with a one-line note each — they were marked AC-met while code-complete (PL-206's notifier has no caller; PL-207's endpoint authorized nobody). 🔵 is not ✅; this is the third time the lesson has been paid for.
- **T-63 stays partial.** It asserts the fixture ladder against the fixture — a drift guard, not a policy check. Per the note beside the test, when P2 lands the recorded-ladder assertion flips to the written decision; until then the AC is unmet and this plan says so rather than marking it ✅.
- **research.md** records this sprint's settled decisions the same session (leak vector 30; the authorization rule; the level-0 clock; `stalled`; per-tenant ladders).
- **Sprint 4/5 numbering flag:** the drafts reserved T-74…T-83 (Sprint 4) and T-84…T-95 (Sprint 5); this sprint allocates T-74…T-83. **Those drafts must be renumbered when they open — flagged here, not renumbered now.**

**AC:** the board is honest; research.md carries the new entries; the flag is visible to whoever opens Sprint 4.

---

## Sequencing

```
H (hooks live, verify 10/10) ── blocks everything ──────────────────────┐
                                                                        ▼
PL-251 authorization ──┬──→ PL-252 wiring (needs the decision rule before the button is safe)
                       └──→ PL-252 → record_pickup_outcome (needs the app-path gate)
PL-253 clock ────────────────── independent (create tool + ladder schema)
PL-252 ──→ PL-254 queue ────── (both touch the worker; wiring first)
PL-253 ──→ PL-254 ─────────── (shared ladder schema)
PL-255 instrument ──→ PL-256 definer ──→ PL-257 parity (the probe is the fix's mechanism)
PL-251 ──→ PL-258 errors ───── (shares pickup-decision.ts / decide tool)
PL-254 ──→ PL-258 ─────────── (shares the worker file)
PL-259 hygiene ─────────────── any point; do not let it be the reason others slip
```

Suggested order: **H → PL-251 → PL-252 → PL-253 → PL-254 → PL-255 → PL-256 → PL-257 → PL-258 → PL-259.**

---

## Sprint Contract — Sprint 3.1

### Regrade rule

**Full rubric regrade on re-issue.** Findings 2, 3, 5, and 6 are substantive code changes to the decision path, the state machine, and both Sprint-3 surfaces — the re-issue rule's "regrade only if code changed" clearly triggers. The evaluator re-runs the standing gate and every touched surface, not only the new tests.

### Rubric — unchanged from Sprint 3

| Category | Weight |
| -------- | ------ |
| **Disclosure & Data Integrity** | **40%** |
| Auth & Security | 25% |
| Functionality | 25% |
| Design | 10% |

Kept deliberately: the repair's defects are already priced by this split — the authorization gap is hard-fail condition 5 widened plus a new gate test, and the wiring gaps are functionality. Moving weight toward auth would double-penalize a defect the gate already fails outright; the 40% disclosure weight stays because this sprint still stores and transmits sensitive content (the interactive DM payloads ride the same surface).

Pass threshold ≥90% weighted, **and** zero hard-fails, **and** the isolation gate green.

### Hard-fail conditions — any one fails the sprint

1. Any of T-01…T-05, T-33…T-35, T-52, T-60, T-68, **or T-75** failing or unwritten (the standing gate, widened to cover authorization)
2. `reason_detail` present in any Slack payload — text or block — notification, log, trace, or tool response
3. A scholar released, or a request approved, without a recorded human decision
4. A timeout, error, restart, retry, **or attempt-ceiling** path that auto-approves — `stalled` is terminal and never behaves like `approved`
5. **A decision recorded on any channel whose actor did not resolve through `staff_identities` to the currently-assigned approver, or whose actor created the request** *(amended — Sprint 3's wording, "attributable only to a Slack user id," is why an unmapped app-channel subject passed a hard fail written to catch exactly that)*
6. A tool schema accepting a tenant parameter, or a forged tenant argument honored
7. A state transition written outside the transition function
8. A rejection or error path on any surface — Slack endpoint, worker, MCP boundary — that writes no audit row (AD-42), **now including thrown-handler and per-tick failures**
9. Real student data anywhere in the repo
10. **The SECURITY DEFINER function returning `tenant_id` or otherwise disclosing tenant mapping to a context-free caller** — membership answers only

### Evaluator requirements

- Fresh conversation, led with `/evaluate` (per-conversation phase; the evaluator-isolation hook is wired now — verify it fires, don't assume it).
- **A different model family from the builder** — no hook manufactures independence.
- Grade against `sprint-3.1/plan.md` + `sprint-3.1/test.md` only. **Do not read `sprint-3.1/progress.md` or `sprint-3/progress.md`.**
- `DATABASE_URL` / `APP_DATABASE_URL` exported — vitest does not load `.env`; do not `source .env`.
- Generator-side observations are not findings; reach your own independently.
- Exit criteria graded separately from the rubric (AD-14): E1, E2, E3 remain human-gated and are not expected to move; **E5 and E6 are this sprint's measurable goal.**
- **Check rejection and error paths for audit rows, not log lines** — including a thrown Slack handler and a failed worker tick.
- A finding is required, or an explicit statement that one was sought and not found. Generator-flagged design points are context, not inherited findings.

---

## Definition of sprint complete

- [ ] Prerequisite H done and recorded: real `hooks.json` live, `verify-hooks.sh` 10/10
- [ ] PL-251…PL-259 all ✅ (not 🔵)
- [ ] T-01…T-83 written and passing, with T-75 in the gate
- [ ] Zero hard-fail conditions triggered
- [ ] E5 and E6 verifiably met; E1–E3 stated honestly as still human-gated
- [ ] T-63 reported as partial, not ✅ — P2 remains open
- [ ] PL-206 and PL-207 reverted to 🔵 on the Sprint 3 board
- [ ] Evaluator produced at least one finding, or stated one was sought and not found
- [ ] `research/research.md` reconciled — leak vector 30 and this sprint's decisions in §4

---

## Handoff — Generator (fresh `/implement` conversation)

1. **First action, before any code:** swap `.windsurf/hooks.json` to the real wiring (see Prerequisite H) and run `bash .windsurf/verify-hooks.sh` — record 10/10 in `sprint-3.1/progress.md`. If it is not 10/10, stop and say so.
2. **Read `sprint-3.1/progress.md` → Failed Approaches before writing code.** Two documented failures recurred in Sprint 3; repeating one a third time is the rubric penalty the list exists to prevent.
3. **Task order with dependencies:**
   - PL-251 (T-75 GATE) — authorization in `transitionPickupRequest`; Slack service + `decide_pickup_request` both resolve through `staff_identities`.
   - PL-252 (T-76, T-77) — `SlackMessage.blocks` approve button; `sendPickupNotifications` callers in create-tool and worker; `record_pickup_outcome` tool; registry 2.2.0.
   - PL-253 (T-76 clock leg) — `initial_minutes` in the ladder; `min(pickup_at, now + initial)` on route.
   - PL-254 (T-78, T-79) — deferral + `escalation_attempts` + `stalled` terminal + per-tenant `ESCALATION_LADDER_DIR`. Migration 0010.
   - PL-255 (T-74) — fix `percentile`; instrument self-test first.
   - PL-256 (T-82) — boolean `pickup_request_belongs_to_tenant`; grant pinned. Migration 0010 (same file as PL-254 is fine — sequence the edits).
   - PL-257 (T-83) — all-tenant probes + decoy decision path; parity proven with the fixed instrument.
   - PL-258 (T-80, T-81) — audited 500; `tick().catch`; per-tenant isolation; no unhandled rejection.
   - PL-259 — board revert (PL-206/PL-207 → 🔵), research.md entries, numbering flag.
4. **One migration** (`0010`) carries: `escalation_attempts`, the `stalled` state + event type, the `stall` action's legality, and the function swap. Keep it coherent.
5. **Constants of every task:** tenant isolation held · audit entry written · typed refusal on failure (never empty success) · no student PII in logs · `reason_detail`/`note`/advisor-notes absent downstream · `tenant_id` never a caller-supplied argument.
6. **The Generator does not grade its own work.** When done: report 🔵/✅ honestly in progress.md, then hand to a fresh `/evaluate` conversation on a different model family — see "Evaluator requirements."
