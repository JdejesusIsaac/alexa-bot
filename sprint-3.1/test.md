# test.md — Sprint 3.1 (repair)

**Carried forward: T-01 … T-73 run every sprint.** The isolation gate never retires. Sprint 3's tests are the baseline this repair must not break — and two of them (T-63, T-66) were passing while measuring less than they claimed. That is the sprint's lesson: a green test is evidence only if it can fail.

**The gate widens once more.** T-75 joins T-01…T-05, T-33…T-35, T-52, T-60, T-68 as stop-the-line. Sprint 3's risk was a scholar leaving without a decision or a medical reason in a Slack channel. **Sprint 3.1's is a decision recorded by someone who had no right to make it — including the person who created the request.**

---

## Strategy for this sprint

**Test the authorization, not the mapping.** Sprint 3 proved a Slack actor resolves through `staff_identities` (T-64, T-67) and never proved the resolved actor was allowed to decide. Any mapped actor — and on the app channel, any authenticated subject at all — could approve. T-75 exists because the gap was a self-approval path on a child-release flow: the decision must come from the currently-assigned approver, never the request's creator, on both channels.

**Assert the helper before trusting the statistic.** `percentile(values, 0.9)` read index 1 of 200 while T-66 reported green — Sprint 2's F-2, recurring verbatim. When a test asserts a statistical property, the instrument gets its own test first (T-74), and the parity test asserts the samples vary enough for the comparison to fail.

**Test that wiring exists, not just that components work.** `sendPickupNotifications` passed seven sentinel tests and had no caller. A task is not done when its function is correct; it is done when the function is reachable. Every test here exercises the path through its real entry point — the tool, the endpoint, the worker tick — not the function in isolation.

**Test what the failure used to hide.** Skipped rows held the oldest `escalate_at` forever, so the queue's sort order was itself the starvation mechanism. The fix is a behavior (deferral + a terminal human handoff), and the test must prove the healthy row is processed while the poisoned one is still pending — not merely that the poisoned row retries.

**Audit rows, still not log lines (AD-42).** The new error paths — a thrown Slack handler, a failed worker tick — get the same treatment T-65 introduced: the row is queried, never inferred.

**T-63 is reported honestly.** Its recorded-policy assertion cannot exist until P2 lands; the fixture-drift legs remain as a guard. This sprint's test file states the AC as unmet rather than greenwashing it — a repair sprint does not mark debts paid.

**Numbering flag.** T-74…T-83 collide with the Sprint 4 draft's reserved range (Sprint 4: T-74…T-83, Sprint 5: T-84…T-95). Sprint 3.1 allocates them first; **the Sprint 4/5 drafts must renumber when those sprints open** — flagged in both artifacts, not renumbered here.

---

## The instrument — T-74

### T-74 · The percentile helper measures what it claims

The Slack-interactions copy of `percentile` computed `ceil((p/100)·n)−1` on a fraction `p` — index 1 of 200, the second-fastest sample. The median of two near-identical minimums "proved" parity.

**Pass:** `percentile` of a constructed, ordered distribution (e.g., 1…200 at p=0.9) returns the tail element (~180th), not index 1; the helper used by T-83's timing legs is the corrected one (shared import or identical semantics to the mcp-audit copy); and the timing tests assert `max ≠ min` on their samples — a variance check that makes "all samples identical" a failure, not a pass.

**Fail:** the helper reads the wrong index, or the parity test could pass on constant data.

---

## Authorization — T-75 **(GATE)**

### T-75 · Only the assigned approver decides, on every channel

The request's `assigned_approver_id` is the only identity allowed to decide it, resolved through `staff_identities` on both surfaces. Cases:

- **Mapped non-assignee, Slack:** a correctly signed interaction from a `slack_user_id` mapped in the request's tenant but not the assignee → typed refusal, audited, no state change. The refusal may be distinct on the wire (`not_assigned_approver`) — the actor is authenticated tenant staff; it must not be a success.
- **Mapped non-assignee, app:** `decide_pickup_request` under a token whose `sub` maps to a *different* staff identity → identical refusal shape, audited.
- **Unmapped app actor:** a token `sub` with no `staff_identities` row in this tenant → `unmapped_actor`, audited, no state change. **This is the widened HF5 case** — Sprint 3's hard fail named only Slack ids, which is why this path shipped green.
- **Self-approval:** the subject that created/routed the request attempts `approve` (either channel, even when they *are* the assignee) → `self_approval` refusal, audited, no state change. If routing assigns the creator, the request cannot be self-decided — it escalates.
- **The assignee decides:** the mapped approver approves on Slack; the mapped approver approves via `decide_pickup_request`; both record `decided_by` as the subject and channel correctly.
- **Zero unresolved actors:** query decision events/audit rows — every one carries a `staff_identities`-resolved subject, never a bare Slack id or an unmapped token sub.

**Fail (critical):** any of the refusal cases succeeds; any decision row lacks a resolved subject; a creator approves their own request. Hard-fail condition 5 (amended) and hard-fail 1.

---

## Wiring — T-76 · T-77

### T-76 · The approval loop is closed and the payload is still clean

**Pass:**

- `create_pickup_request` on a configured server produces: a DM to the assignee's slack id containing an `actions` block whose button carries `action_id: 'approve'` and `value: <request_id>`; a visibility-thread post; and the request in `routed`.
- The sentinel discipline extends to blocks: a `reason_detail` sentinel appears in no message text, no serialized block, no log line — including a failing and a throwing Slack client (T-68's method on the new shape).
- The clock leg (PL-253): with a ladder configured, `escalate_at = min(pickup_at, created + initial_minutes)` — assert `escalate_at < pickup_at`; without one, `escalate_at = pickup_at` and the `initial_clock_unconfigured` warning was logged.
- A send failure does not fail the tool call or alter the request state — typed result, logged metadata only.
- With no Slack config at all, the tool succeeds and nothing was sent (the system works without the channel).

### T-77 · The lifecycle is reachable end to end

**Pass:** `approve → release → complete` is drivable through the real surfaces: approve via the assignee (either channel), then `record_pickup_outcome` performs `release` then `complete` — each with an audit row and an event row under a `staff_identities`-resolved actor. `routed → release` and `approved → complete` are typed `illegal_transition` refusals (the state machine is the chokepoint — this leg extends T-53's discipline, not replaces it). An unmapped app caller is refused. `expired`/`stalled`/`denied` requests reject release — terminal never behaves like approved.

---

## The queue — T-78 · T-79

### T-78 · A poisoned row cannot starve the queue, and the ceiling hands off to a human

Construct a due row that always fails (the blocking-event trick from the T-60 file) **ahead of** a healthy due row's `escalate_at`, with `batchSize` small enough that ordering matters.

**Pass:**

- The healthy row is escalated on the same or next tick — the failed row's deferral moved it out of the oldest-first head of the queue. Assert the healthy row advanced *while the poisoned row is still unresolved*.
- Each skip/failure increments `escalation_attempts` and rewrites `escalate_at` — queried, not inferred.
- At the configured ceiling the row transitions to `stalled`: terminal, audited (`stalled` event + worker audit row by request id), `reason_detail` purged, `decided_by` still null, and every subsequent transition attempt (`approve`, `release`, `escalate`) is a typed refusal. The `stalled` outcome routes to in-person handling in its audit/log copy.
- A skipped row (unmapped rung approver) defers and counts the same way — config gaps do not get infinite silent retries, and a mapping fixed *before* the ceiling still resumes the row.

**Fail:** the healthy row waits behind the poisoned one; attempts grow without bound; `stalled` is reachable as `approved`/`released`/`completed`.

### T-79 · Ladders are per-tenant

One worker, two tenant jobs, two ladder files (`ESCALATION_LADDER_DIR`).

**Pass:** both tenants' due rows escalate under their own ladder's subjects — tenant B's rows are not skipped for lacking tenant A's approvers. A configured tenant missing its ladder file is a boot refusal naming the tenant and the path — startup refusal, not per-request decline. Fixture ladders remain obviously fake per tenant.

---

## Error paths — T-80 · T-81

### T-80 · A thrown Slack decision path is audited, not just logged

Force a throw after signature verification (e.g., a dependency that rejects mid-decision).

**Pass:** the response is a generic 500 — **not** the `request_not_found` shape (errors are not the oracle surface); an `mcp_audit` row with an `error:*` outcome exists, queried by `request_id`; no internals, payload content, or stack text in the response or the audit arguments.

### T-81 · A failing tick neither kills the worker nor starves the other tenant

Two tenant jobs; force tenant A's `tickTenant` to throw (e.g., a severed client).

**Pass:** `tick()` resolves (or surfaces stats) with tenant B still processed; the failure is logged and audited under tenant A; the interval callback catches (`this.tick().catch`), so **the process sees no unhandled rejection** — assert via `process.on('unhandledRejection')` armed in the test, or fake timers driving `start()`; a consecutive-failure counter produces the `worker_unhealthy` line. The worker does not exit.

---

## Tenant resolution — T-82 · T-83

### T-82 · The cross-tenant lookup confirms membership, nothing more

Migration 0010 replaces `find_pickup_request_tenant` with `pickup_request_belongs_to_tenant(request_id, tenant_id) → boolean`.

**Pass:** returns true only for the owning tenant — false for every other configured tenant and for a nonexistent id; the return type is boolean (no `tenant_id` is produced at all); `information_schema`/`pg_proc` asserts `prosecdef`, public EXECUTE revoked, and EXECUTE held by `parentline_app` alone. Leak vector 30's regression test.

### T-83 · Timing parity, with an instrument that can fail

T-66's timing leg re-run post-repair — cross-tenant id vs genuinely nonexistent id, 200×2, T-42's tolerance — now meaningful because T-74 proved the percentile reads the tail.

**Pass:** the endpoint probes every configured tenant with no early exit (constant probe count for existent and nonexistent ids — a query-count assertion, not just timing); a nonexistent id still performs the decoy decision-path sequence; median **and** corrected-p90 are indistinguishable; the wire remains byte-identical; the samples carry the variance T-74 requires.

---

## Adversarial pass — Sprint 3.1 additions

Attempt each, report what worked, fix nothing.

- Approve a request as the wrong approver — Slack and app
- Approve a request you created — including where routing names you the approver
- Decide with a token subject that has no `staff_identities` row
- Make a stuck row reach `approved`, `released`, or `completed` — by retry, by timeout, by direct tool call
- Starve the queue: fill the head of the due list with failing rows and check whether a healthy row advances
- Extract `tenant_id` (not just existence) from the request-resolution path — by error shape, by timing, by the definer function's return
- Get `reason_detail` into a Slack *block*, not just a message text
- Kill the worker process via a whole-tick failure — or prove it cannot be killed that way
- Get a decision recorded under anything other than a resolved `staff_identities` subject
- **Find a rejection or error path that writes no audit row** — the Slack 500, the failed tick, the stalled handoff (the F-1 class, now three surfaces deep)

**A finding is required, or an explicit statement that one was sought and not found.**

---

## Still open, stated plainly

- **T-63** — the recorded-policy assertion remains gated on P2. The fixture-drift legs stay green as a guard; the AC is unmet until a real ladder is written down. Not ✅.
- **T-71** — Aircall webhook test; PL-209 is human-gated and out of scope.
- **E1, E2, E3** — human-gated: no pilot, no P1 baseline this sprint. E3's structural half becomes real when `release` is wired; its observational half still needs the campus.

---

## Test run log

| Date | T-numbers | Result | Conditions |
| ---- | --------- | ------ | ---------- |
| 2026-09-27 | T-01…T-83 (full suite, 342 tests) | 342/342 green; `tsc` clean; **`eslint` 1 error** | Local Postgres (Homebrew, :5432), per-file throwaway DBs, warm, vitest default parallel. Owner role = local superuser (`.env.example`'s `owner` role does not exist locally); app role `parentline_app`. |
| 2026-09-27 | Evaluator adversarial probes (temp file, deleted) | **T-75 gate breached** (EVAL-1, EVAL-2); T-83 parity breached (EVAL-3) | Same env; Slack timing 400×2 interleaved |

Record conditions with every entry: local vs remote, dataset size, warm vs cold, serial vs parallel.

---

## Adding tests

Append with the next ID — which, after this sprint's allocation, is **T-96**, not T-84 (Sprint 4's draft must renumber when it opens). If a test exists because something broke in real use, say so in the description.

---

## Evaluation report — Sprint 3.1 (2026-09-27)

**Verdict: FAIL.** The standing gate is breached at T-75, and hard-fails 1 and 5 fire. The weighted score is ≈70%, against a 90% bar. Every test in the suite passes (342/342). The breaches were found by evaluator probes that the suite does not cover.

Inputs: the `sprint-3.1/plan.md` Sprint Contract, this file, and the build. Neither `progress.md` was read. The builder was a non-Claude family (the user confirmed this) and the evaluator runs on Claude.

### Hard-fail conditions

| # | Result | Evidence |
| - | ------ | -------- |
| 1 | **FIRED** | T-75 refusal cases return success (B-1), and T-75 legs are unwritten (B-4) |
| 2 | clear | Sentinel absent from text, blocks and logs (T-76). The builder only receives allowlisted fields |
| 3 | clear | `release` is legal only from `approved` |
| 4 | clear | `stalled` is terminal. approve/release/escalate/complete are refused (T-78) |
| 5 | **FIRED** | B-1 writes decision audit rows under a non-assignee and under the creator. B-2 records a decision by a no-longer-assigned approver |
| 6 | clear | No `tenant` in `schema-registry.json` (2.2.0). The Slack endpoint takes its tenant list from config |
| 7 | clear | `state` is written only in `applyTransition` inside `transitionPickupRequest` |
| 8 | clear (sought) | Checked the Slack 500, tenant tick failure, row failure, stall, and an unmapped app actor. Each writes an `mcp_audit` row |
| 9 | clear | No `.csv`/`.xlsx`/`fixtures/real`. Fixtures are synthetic |
| 10 | clear | The boolean function exists and `find_pickup_request_tenant` is dropped. ACL is `{owner=X, parentline_app=X}` with no PUBLIC |

### Bug reports

**B-1 · Idempotent replay bypasses decision authorization — Auth & Security, GATE (T-75, HF5).**
- *What:* `transitionPickupRequest` returns an idempotent success at step 2 (`current.state === def.to`). That happens before the step-4b assignee and self-approval checks.
- *Repro:* The assignee approves a request. Then a mapped non-assignee sends `approve`, through the app or Slack. Separately, the request's creator re-sends `approve` on an approved request, or a non-assignee sends `deny` on a denied one.
- *Expected:* `not_assigned_approver` / `self_approval` refusals.
- *Actual:* The app returns `kind: success`, "Decision recorded: request is now approved". Slack returns `{"ok":true}`. `mcp_audit` gets `success:idempotent` under the non-assignee subject. `audit_log` gets `decidePickupRequest success:idempotent` under the non-assignee.
- State is unchanged. But the audit trail now says a non-assignee (or the creator) decided successfully. T-75 says a refusal case "must not be a success".
- *Fix direction:* authorize before the idempotency short-circuit for decision actions.

**B-2 · TOCTOU: a de-assigned approver's decision lands — Auth & Security, GATE (HF5 "currently-assigned").**
- *What:* `withTenant` opens no transaction. So the `select … for update` in the app and Slack paths runs in autocommit and releases its lock immediately. `applyTransition` guards only on `state`, not on `assigned_approver_id`.
- *Repro:* The old assignee's approve reads the row. The worker then escalates and reassigns (state stays `routed`). The approve's UPDATE still matches.
- *Actual:* The row ended in `approved`, `decided_by = lead-alpha-section`, `assigned_approver_id = 6f6f…` (the default approver). The window is small but real.
- *Fix direction:* add `assigned_approver_id = $n` to the UPDATE guard, or run the transition in a transaction.

**B-3 · T-83 decoy does not match the real path — Disclosure & Data Integrity (E6).**
- *What:* A cross-tenant id runs `findStudentById`, then `audit_log` `insertAuditEntry`, then the refusal. The decoy skips both.
- *Measured:* 9 vs 7 non-probe queries. Medians 3.47 vs 2.72 ms, p90 4.61 vs 3.66 ms, over 400×2 interleaved runs. Mann-Whitney z = 12.
- *Consequence:* A signed caller can tell "exists in some configured tenant" from "nonexistent". That reveals existence, not `tenant_id`.
- T-66/T-83's tolerance (≥15 ms median, ≥30 ms p90) is ~20× the structural gap, so the parity leg cannot fail on it. That is the "green but vacuous" pattern this sprint exists to repair.
- *Expected:* the decoy performs the same sequence as the real path, including the `refusal:not_found` `audit_log` write the plan names. Also a test that fails on this gap.

**B-4 · T-75 is incomplete as written — Auth & Security (GATE, "unwritten").**
- The "zero unresolved actors" sweep is not in the suite (the evaluator ran it: 0 unresolved subjects, but B-2 produced one non-current-assignee decision).
- "The assignee approves on Slack and via `decide_pickup_request`" is not in T-75. The T-75 approve leg is a `flag` through the service.
- T-75 legs call the services, not the tool or endpoint (the strategy asks for real entry points).
- The unmapped-actor leg asserts no audit row. The evaluator verified that an `mcp_audit` `refusal:unmapped_actor` row is written through the tool.

**B-5 · `npm run lint` fails — Design.**
- `src/repositories/pickup-requests.ts:275` breaks the Rule-7 lint on `pickupRequestBelongsToTenant(pool, requestId, tenantId)`, so `npm run verify` is red.
- The value comes from config, not from a caller. But the rule was neither satisfied nor given a scoped, justified override like `tenant-context.ts` has.

**B-6 · Worker notifications are untested — Functionality (PL-252 AC).**
- No test drives the worker with a notifier. "Escalation notifies the new rung's approver" and the `expired`/`stalled` thread post are unverified. The code exists in `escalation-worker.ts:255-275`.

**B-7 · T-81's interval-catch leg cannot fail — Design (test quality).**
- `tick()` already catches every per-tenant error, so the promise in `start()` never rejects. Deleting `.catch(...)` would leave the test green.

**B-8 · The attempt ceiling can be silently disabled — Design.**
- `Number(process.env.ESCALATION_MAX_ATTEMPTS)` is not validated. A non-numeric value gives `NaN`, and `attempts >= NaN` is always false, so attempts become unbounded. No approve path opens, but it is the unbounded retry that T-78 forbids.
- Route this value through `config.ts` with a Zod int ≥1.

**B-9 · Artifact DoD — Design.**
- `research/research.md` has no leak vector 30 and no entries for this sprint's decisions. Only `sprint-3.1/research.md` mentions vector 30.
- The PL-206/PL-207 board revert lives in `sprint-3/progress.md`, which the evaluator may not read, so it was not verified.

**Harness observation (not scored).** `verify-hooks.sh` passes 10/10 and `hooks.json` has the real wiring. This conversation was never switched to evaluation (global phase file = `implementation`, no `/evaluate`), so evaluator-isolation would not have blocked a `progress.md` read. Isolation held by discipline again. Start the next evaluation with `/evaluate`.

### Rubric

| Category | Weight | Score | Notes |
| -------- | ------ | ----- | ----- |
| Disclosure & Data Integrity | 40% | 70% | Sentinel, boolean definer and grants are solid. B-3 breaks E6 timing parity, and B-1 puts false success rows in the audit trail |
| Auth & Security | 25% | 55% | The chokepoint design is right. B-1 and B-2 defeat it |
| Functionality | 25% | 85% | The loop is wired: DM with approve button, `record_pickup_outcome`, level-0 clock, deferral, `stalled`, per-tenant ladders, audited 500 and tick failures. B-6 leaves part of it untested |
| Design | 10% | 65% | B-5, B-7, B-8, B-9 |
| **Weighted** | | **≈70%** | Threshold 90%. The gate is red regardless |

### Exit criteria (AD-14)

- **E5: NOT MET.** Unresolved subjects: none found. But non-assignee and creator "success" decision audit rows exist (B-1), and the stale-assignee decision exists (B-2).
- **E6: NOT MET.** Membership-only resolution holds (T-82). Timing parity does not hold (B-3).
- **E4: held.**
- **E3:** the structural half is now real, since `release` is reachable only from `approved`. The observational half is human-gated.
- **E1, E2:** human-gated and open, as expected. T-63 is partial, as expected.

### Adversarial pass

| Attempt | Result |
| ------- | ------ |
| Approve as the wrong approver | **Found:** B-1 (after decision) and B-2 (race). Refused on a fresh `routed` request |
| Approve a request you created | **Found:** B-1 (after the assignee decides). Refused on `routed` |
| Decide with an unmapped subject | Sought, not found. Refused and audited |
| Make a stuck row reach approved/released/completed | Sought, not found |
| Starve the queue | Sought, not found. Deferral works (T-78) |
| Extract `tenant_id` | Not found for `tenant_id` itself. Existence leaks via timing (B-3) |
| `reason_detail` into a Slack block | Sought, not found |
| Kill the worker via a tick failure | Sought, not found. Caveat: B-7 |
| Decision under a non-`staff_identities` subject | Sought, not found |
| Error path with no audit row | Sought, not found |

**Next sprint input (failure protocol):** B-1 and B-2 are stop-the-line. Then B-3, B-4 and B-5.
