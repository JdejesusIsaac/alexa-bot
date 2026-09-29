# plan.md — Sprint AUTH: the decision is made by its owner

**Sprint goal**

> One control, closed at the doors and provable in the audit trail: only the currently assigned approver — never the creator, never an unresolved actor, never by replay — can produce a response that says a decision was recorded, on any channel. Everything else in this sprint exists to make that control impossible to grade falsely.

**Companion artifacts:** `sprint-auth/test.md` (T-75 rewritten; T-84…T-88) · `sprint-auth/progress.md` (opened by the Generator at `/implement`). No `sprint-auth/research.md` — a repair-of-repair has no new research questions; the one genuinely new decision (transactional tenant context, PL-275) lands as a single line in `research/research.md` §4 the same session, per the standing convention. Sprint 3.1's artifacts stand unchanged.

---

## Why this sprint is not "Sprint 3.2"

Sprint 3.1 was itself the repair for Sprint 3 findings 2 and 3 — decisions by non-assignees and actors unresolved in `staff_identities`. B-1 and B-2 are those same defects, surviving the repair. Two consecutive repair sprints on one defect means the defect is not what is being repaired.

PL-251 was designed correctly: put the check in `transitionPickupRequest` so no call site can bypass it. It was bypassed inside the chokepoint — an idempotent-replay branch returns success before the assignee and self-approval checks run. The principle held; the implementation put a door in front of the lock. B-2 is the same shape one layer out: the row lock releases immediately because callers do not wrap it in a transaction, so a control that reads correctly in one file is defeated by how two other files call it.

So this sprint is narrow on purpose. If B-1 recurs a third time, the problem is the process, not the code, and that gets escalated rather than re-planned.

**Verified against source before this plan was written:** the replay branch (`pickup-requests.ts` step 2) returns before the 4b authorization checks; `withTenant` opens no transaction; `applyTransition`'s UPDATE guards on `state` alone; T-75's current legs call the service functions, not the tool or the endpoint; `pickupRequestBelongsToTenant`'s `tenantId` parameter trips the Rule-7 lint; `evaluator-isolation.py` allows every read unless the phase is `evaluation`; `verify-hooks.sh` runs 10 checks; `.env.example` documents an `owner` role no fresh clone has and the README setup section creates no roles at all.

---

## Scope

**In scope:** B-1 (authorization before idempotency) · B-2 (the decision is one transaction) · B-4 (T-75 tests the doors) · B-5 (`npm run verify` green) · pre-flight A, B, C · the Failed-Approaches conversion into mechanical checks.

**Out of scope, second pass:** B-3 (timing parity — E6 depends on it) · B-6 (worker notifications untested) · B-7 (T-81's interval-catch leg cannot fail) · B-8 (`ESCALATION_MAX_ATTEMPTS` NaN) · B-9 (artifact DoD). They are real and they wait. Do not let them in — the last two sprints both grew past their scope and both failed.

**Out of scope, permanently:** anything from Sprint 4 or 5, PL-209, PL-213.

---

## Pre-flight — mechanical, not remembered

Sprint 3.1's evaluator disclosed two conditions that undercut its own grade: it never started with `/evaluate`, so isolation was discipline again; and the `owner` role in `.env.example` does not exist locally, so it graded T-01…T-05 with a superuser standing in for the non-owner app role — the exact configuration those tests exist to prove impossible.

Both have been instructions in the plan for three sprints. Instructions are not working. Make each one fail closed.

### A. Isolation defaults to on

Today `evaluator-isolation.py` blocks `progress.md` only when the phase is `evaluation`. A conversation with no phase reads freely — which is precisely what happened. Invert it: block `progress.md` and `smoke.log` unless the phase is explicitly `implementation`. The Generator already types `/implement`. An evaluator that forgets `/evaluate` is then isolated by default rather than by memory. This mirrors the Cursor harness, where an unphased conversation defaults to the most restrictive phase.

"Explicitly" is the load-bearing word: only this conversation's **own** phase file (`.windsurf/state/phase.<trajectory_id>`) reading exactly `implementation` allows the read. The legacy global file may make isolation stricter (it can say `evaluation`), never looser — a global file saying `implementation` cannot vouch for a conversation that never declared a phase, because that is the exact shape of the Sprint 3.1 breach. Absent per-conversation phase, `research`, `planning`, `evaluation`, and no-trajectory all block. This is specified as a task (PL-271) with a test (T-84): `verify-hooks.sh` gains the unphased case — **expect 11 cases, not 10** — hermetic (it sets the global file to `implementation`, runs an unphased trajectory, expects the block, then restores).

### B. The suite refuses to run as owner or superuser

Add a global test-setup assertion: if the app connection's `current_user` is a superuser, or is the database owner, the suite fails at setup with a message naming the role and the fix. Not a warning, not a skip.

The isolation gate asserts that RLS holds against `parentline_app`. Run as superuser, RLS is bypassed and those tests prove nothing while reporting green. Also correct `.env.example` so the documented role matches one a fresh clone can actually create, and add the `CREATE ROLE` statement to the setup docs (README "Setup"). Task PL-272, test T-85.

### C. A pre-flight the evaluator must paste

One script, `scripts/preflight.sh`, printing: current phase file contents, `verify-hooks.sh` result, `current_user` and its superuser/owner status, and `npm run verify` exit code. The contract requires its output verbatim in the evaluation report. A report without it is incomplete regardless of score. Task PL-273, test T-86.

A and B are the enforcement. C is the receipt.

---

## Task status convention

Unchanged. ⬜ not started · 🟡 in progress · 🔵 **code-complete, AC unverified** · ✅ AC met and verified · 🔴 blocked · ⏸️ paused. **🔵 is not ✅**, and from this sprint: **`npm run verify` green is a precondition for any ✅** — the board records the verify run (date, result) per task. Code that nothing calls is code-complete at best; now the build says so itself (PL-278).

---

## Tasks

### PL-271 — Isolation defaults to on (pre-flight A)

Invert `evaluator-isolation.py` per the spec above. The hook already sits on both the read path and the terminal path in `hooks.json` — no wiring change, only the logic. The block message states the default (isolation on unless this conversation is in the implementation phase) and the way out (`/implement`), so a blocked Generator knows why and a blocked evaluator learns nothing it shouldn't. Extend `verify-hooks.sh`: the unphased case is new; `smoke.log` is covered inside the existing blocked cases without adding a twelfth check.

**AC:** T-84 passes — `verify-hooks.sh` 11/11, including: unphased trajectory + global file `implementation` → `progress.md` read blocked (the Sprint 3.1 breach, now a test); a conversation whose own phase file says `implementation` reads freely; `smoke.log` blocked in every phase that blocks `progress.md`.

### PL-272 — The suite refuses to run as owner or superuser (pre-flight B)

In `provisionTestDb` (`tests/helpers/db.ts`), immediately after the app pool connects: assert `current_user` is not a superuser (`rolsuper`), does not hold `BYPASSRLS`, and is not the owner of the connected database (`datdba`). On violation the setup **throws** — the suite fails before a single test runs — with a message naming the role and the fix (create the non-owner roles per the README; never run the suite as the owner or a superuser; `APP_DATABASE_URL` is the app connection, `DATABASE_URL` runs migrations). Correct `.env.example`'s owner role to one the README's `CREATE ROLE` statement actually creates (e.g. `parentline_owner`); add the role-creation step to the README Setup section so a fresh clone can follow it end to end.

**AC:** T-85 passes — the guard fires against a deliberately privileged connection with the role named in the failure; `.env.example` and the README agree on roles a fresh clone can create.

### PL-273 — `scripts/preflight.sh` (pre-flight C)

One script, four sections, printed regardless of individual failures, exiting non-zero if any item failed:

1. **Phase state** — the legacy global phase file (contents or "absent") and every `.windsurf/state/phase.*` per-conversation file with contents.
2. **Hooks** — `bash .windsurf/verify-hooks.sh` output and result (11/11 expected).
3. **Database posture** — for each of `DATABASE_URL` and `APP_DATABASE_URL`: `current_user`, `rolsuper`, `rolbypassrls`, and whether the user owns the connected database. Via `node` and the `pg` driver (no `psql` dependency). Unset variables are reported as failed items, never crashes.
4. **Verify** — `npm run verify` exit code.

The script never sources `.env` (the multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` breaks it — standing gotcha); it reads exported environment only and reports absence as a failed pre-flight item.

**AC:** T-86 passes — four sections present, exit codes correct (zero only when every item passes), absent env reported not crashed.

### PL-274 — Authorization before idempotency (B-1)

The replay branch in `transitionPickupRequest` must run the assignee and self-approval checks before returning any success shape. Concretely: for decision actions (`approve`, `flag`, `deny`), step 4b's checks precede the idempotent short-circuit and the illegal-transition classification. A non-assignee or the creator re-deciding an already-decided request gets the typed refusal, not "Decision recorded", and the audit row records a refusal — `refused` ledger event in the chokepoint, `refusal:not_assigned_approver` / `refusal:self_approval` (or `unmapped_*` where resolution fails first) in the audit ledgers the services already write.

Note in the plan, carried to the code comment: the state did not change, but the audit recorded a successful decision by someone with no right to make it — **the audit trail was the thing corrupted.** The wire and the row were both lying; the row is the one staff rely on.

The legitimate assignee re-sending their own decision keeps the idempotent success (T-54 preserved — the fix must not break idempotency for the actor entitled to it). Refusal copy for both codes already exists on the tool path; confirm, don't re-add.

**AC:** T-75's replay legs and sweep pass (with PL-276). Zero success-shaped responses and zero `success:idempotent` audit rows under a non-assignee, the creator, or an unresolved actor, on any channel.

### PL-275 — The decision is one transaction (B-2)

Both the Slack and app paths must wrap the read-check-update in a single transaction so the row lock is held across it, and the conditional update must include `assigned_approver_id` in its predicate, not just `state`.

- New `withTenantTransaction` in `src/db/tenant-context.ts` (the file already carries the standing Rule-7/Rule-11 override — same roles, no new override): acquire client → `begin` → `set_config('app.tenant_id', $1, true)` — transaction-local, so the setting cannot outlive the transaction even on rollback (T-04's guarantee by construction) → callback → `commit`; on error `rollback` and rethrow; release in `finally`.
- The app tool path (`handleDecidePickupRequest`) and the Slack endpoint's decision section route through it. The Slack service's `audit_log` rows now commit atomically with the decision they describe. The tool boundary's `mcp_audit` row stays at the HTTP boundary — one row per request, telemetry, deliberately not part of the decision's atomicity.
- `applyTransition`: decision actions' UPDATE predicate gains `and assigned_approver_id = <the identity the check authorized>` — the value read under the lock. A missed UPDATE re-reads and classifies: state unchanged but assignee changed → `not_assigned_approver` (ledgered and audited like any 4b refusal); state changed → `illegal_transition` as today.
- Stated so it is deliberate, not missed: `record_pickup_outcome` (release/complete) and the worker keep their current guards — their authorization does not depend on the assignee, and the state predicate is their control.

**AC:** T-87 passes — the acceptance test injects a reassignment between check and update and asserts the stale approver's decision does not land, on both channels. One line lands in `research/research.md` §4 (transaction-local tenant context — leak vector 4 hardening).

### PL-276 — T-75 tests the doors, not the hallway (B-4)

T-75's legs must call the MCP tool and the Slack endpoint, not the service functions underneath. Required legs (spec in `sprint-auth/test.md`): assignee approves (both channels), non-assignee refused (both), creator self-approval refused (both), unresolved actor refused (both), replay of each of the above refused, and a sweep asserting zero decision rows whose actor is unresolved or non-assigned. T-75 stays in the gate. The current service-level T-75 block in `tests/slack-actor.test.ts` is **replaced**, not kept alongside — keeping both re-teaches the hallway. Both door harnesses already exist (`McpTestClient` + minted tokens; signed POST against `/slack/interactions`) — reuse them.

**AC:** T-75 rewritten and green through both doors, with its mutation legs.

### PL-277 — `npm run verify` is green (B-5)

Fix the Rule-7 lint failure at `pickup-requests.ts:275` (`pickupRequestBelongsToTenant`'s `tenantId` parameter). The value comes from `SLACK_TENANT_IDS` config, never from a caller — the evaluator named both acceptable directions: satisfy the rule, or give it a scoped, justified override like `tenant-context.ts` has. Primary direction here: a **line-scoped** disable on that one signature with the justification written where the disable sits (config origin named; SQL surface stays boolean membership per leak vector 30) — narrower than a file override, visible in review. Alternative: restructure the signature so the tenant list arrives config-shaped. Either way the rule is not weakened anywhere else, and T-82/T-83's assertions (probe count constant, grants posture) hold unchanged.

**AC:** `npm run verify` exits 0. Part of T-88.

### PL-278 — Failed Approaches becomes executable

Three classes have now recurred in all three evaluations:

| Class | Sprint 2 | Sprint 3 | Sprint 3.1 | The check that replaces the line |
| --- | --- | --- | --- | --- |
| A test that cannot fail its own assertion | F-2 | `percentile` index bug | B-3 tolerance 20× the gap; B-7 | Paired mutation tests — test-writing rule in `sprint-auth/test.md`, applied to this sprint's legs |
| Code-complete marked ✅ | PL-005 | PL-206, PL-207 | B-5 (`verify` red) | `verify` green as precondition for ✅ (plan convention) + dead-export check in `verify` (this task) |
| An unenforced path inside a control | F-1 | finding 9 | B-1 | Authorization tests call public entry points only (test.md rule; T-75's doors rewrite) + isolation default-on (PL-271) + suite refuses superuser (PL-272) |

The entries are accurate and are being read as history rather than as a checklist. Adding a fourth line will not help. So:

- **Dead-export check:** a small script (no new dependencies) wired into `npm run verify` — a `src/` export with no caller in `src/` fails the build. Allowlist only where a justification is written (entry points, fixture modules consumed by tests). PL-206 (`sendPickupNotifications`, no caller, marked ✅) would have been caught at commit. **This lands first, before any task is marked ✅** — the sprint runs under the check it is installing.
- **✅ precondition:** recorded per task in progress.md (the verify run's date and result beside the status).
- **The two test-writing rules** land in `sprint-auth/test.md` from the start (they are there now); this task's close-out cross-references them from progress.md.
- **The list itself:** keep the existing Failed Approaches list at its 10-line cap; annotate the three recurring classes as **superseded by checks** and note where each check lives (this table). Do not extend the list with a fourth recollection.

**AC:** the dead-export check fails on a planted dead export (T-88's mutation leg); the annotation with check-homes is in progress.md; nothing in the list grew.

---

## Sequencing

```
PL-271 isolation default-on ─┐
PL-272 suite refuses superuser ─┤
PL-277 verify green (B-5) ──────┼── session 1: the sprint runs guarded; every later ✅ is honest
PL-278 dead-export check (first half) ─┘
PL-273 preflight.sh ────────── after A+B (it prints their results)
PL-274 auth before idempotency ─┐
PL-275 one transaction + predicate ─┴── same function; ordering keeps the diff reviewable
PL-276 T-75 rewritten to the doors ── after 274+275 (the legs must pass against the fixed code)
PL-278 close-out (annotation, cross-refs, research.md line) ── any point after the above
```

Suggested order: **PL-271 → PL-272 → PL-277 → PL-278 (dead-export check) → PL-273 → PL-274 → PL-275 → PL-276 → PL-278 (close-out).**

---

## Sprint Contract — Sprint AUTH

### Rubric

| Category | Weight |
| -------- | ------ |
| **Auth & Security** | **50%** |
| Disclosure & Data Integrity | 25% |
| Functionality | 15% |
| Design | 10% |

This sprint is one control; it is weighted accordingly — everything else in scope exists to make that control provable, and the disclosure weight stays substantial because the breach being repaired was, in the end, a false record in an audit trail.

**Pass:** ≥90% weighted, **and** zero hard-fails, **and** the gate green, **and** the pre-flight output present verbatim in the report.

### Gate

T-01…T-05, T-33…T-35, T-52, T-60, T-68, **T-75**. Run before every commit.

### Hard-fail conditions — any one fails the sprint

1. Any of T-01…T-05, T-33…T-35, T-52, T-60, T-68, or T-75 failing or unwritten (the standing gate)
2. `reason_detail` present in any Slack payload — text or block — notification, log, trace, or tool response
3. A scholar released, or a request approved, without a recorded human decision
4. A timeout, error, restart, retry, or attempt-ceiling path that auto-approves — `stalled` is terminal and never behaves like `approved`
5. **Any response indicating a decision was recorded — including an idempotent replay — returned to an actor who is not the currently assigned approver, or who created the request, or who is unresolved in `staff_identities`, on any channel.** *(second amendment: Sprint 3's wording named only Slack ids and missed app-channel actors; Sprint 3.1's named the actor but not the replay. "Response" is the load-bearing word — the wire shape, the audit row, and the log line are all responses; a `success:idempotent` row under a non-entitled actor is this hard fail, not a technicality.)*
6. A tool schema accepting a tenant parameter, or a forged tenant argument honored
7. A state transition written outside the transition function
8. A rejection or error path on any surface that writes no audit row (AD-42)
9. Real student data anywhere in the repo
10. The SECURITY DEFINER function returning `tenant_id` or otherwise disclosing tenant mapping to a context-free caller

### Exit criteria — graded separately (AD-14)

| # | Criterion | Status entering AUTH | Sprint AUTH |
| - | --------- | -------------------- | ----------- |
| E1 | One week live at one campus | Human-gated (PL-213) | Stays open — no pilot |
| E2 | Median time-to-decision + P1 baseline | Human-gated (P1 not started) | Stays open |
| E3 | Zero scholars released without a recorded decision | Structural half real (`release` only from `approved`); observational half human-gated | Holds — stated, not re-proven |
| E4 | `reason_detail` never leaves Postgres | Green (T-68, T-76) | Holds |
| E5 | Every decision audited with an actor resolved through `staff_identities` to the **currently assigned approver** — never the creator, never by replay, on any channel | **NOT MET** (B-1, B-2) | **The only measurable goal.** T-75 (rewritten, GATE) + T-87 |
| E6 | Zero cross-tenant leakage through the new tables and the Slack surface | Membership-only holds (T-82); timing parity NOT MET (B-3) | **Not carried** — depends on B-3, which is out of scope by name. Stated here rather than left dangling |

### Evaluator requirements

- Fresh conversation, led with `/evaluate`. The hook now defaults closed — an unphased conversation is isolated, so this is verification, not hope. Verify it fires; don't assume.
- **A different model family from the builder** — no hook manufactures independence.
- Grade against `sprint-auth/plan.md` + `sprint-auth/test.md` only. **Do not read `sprint-auth/progress.md`** (or any sprint's).
- `DATABASE_URL` / `APP_DATABASE_URL` exported — vitest does not load `.env`; do not `source .env`.
- **Run `scripts/preflight.sh` first and paste its output verbatim in the report.** A report without it is incomplete regardless of score.
- **If a pre-flight item cannot be satisfied, report that as the first line of the report, not as a caveat at the end.** Both prior evaluators disclosed honestly; both buried it.
- Audit rows, not log lines — query the row.
- A finding is required, or an explicit statement that one was sought and not found. Generator-flagged design points are context, not inherited findings.

---

## Definition of sprint complete

- [ ] Pre-flight landed and green: `verify-hooks.sh` 11/11 including the unphased case; the setup refusal proven against a privileged connection; `scripts/preflight.sh` runs with its contract holding
- [ ] PL-271…PL-278 all ✅ (not 🔵), each with its verify run recorded
- [ ] T-75 rewritten and green through both doors, in the gate; T-84…T-88 written and passing; T-01…T-83 carried and green
- [ ] `npm run verify` green end to end
- [ ] Zero hard-fail conditions; HF5 carries its second amendment as worded above
- [ ] E5 met and proven at the doors; E1–E4 stated honestly; E6 explicitly not carried (B-3 waits for the second pass)
- [ ] The dead-export check would have caught PL-206 — mutation proven (T-88)
- [ ] The three recurring Failed-Approaches classes each carry a mechanical check and a named home; the list did not grow
- [ ] Numbering flag carried: the Sprint 4 **and** Sprint 5 drafts renumber when they open
- [ ] Evaluator produced at least one finding, or stated one was sought and not found

---

## Handoff — Generator (fresh `/implement` conversation)

1. **First action, before any code:** run `bash .windsurf/verify-hooks.sh`. With PL-271 landed it must read 11/11; if not, stop and say so. Then land session 1 in order — PL-271, PL-272, PL-277, PL-278's dead-export check — so the sprint runs guarded and every later ✅ is honest. From the second session on, start every session with `bash scripts/preflight.sh`.
2. **Read Failed Approaches before writing code** — and read it as a checklist now: three classes, three checks. Repeating a documented failure is the rubric penalty the list exists to prevent; repeating one of the three recurring classes now also trips a mechanical check.
3. **Task order with dependencies, and the tests each must make pass:**
   - PL-271 (T-84) — isolation default-on; `verify-hooks.sh` 11/11 with the unphased case
   - PL-272 (T-85) — setup refusal naming role and fix; `.env.example` + README role honesty
   - PL-277 (part of T-88) — `npm run verify` green; Rule-7 fixed without weakening
   - PL-278 first half (part of T-88) — dead-export check wired into `verify`, before any ✅
   - PL-273 (T-86) — `scripts/preflight.sh`
   - PL-274 (T-75 replay legs + sweep) — authorization before idempotency in the chokepoint
   - PL-275 (T-87) — `withTenantTransaction` on both paths + `assigned_approver_id` predicate
   - PL-276 (T-75 full matrix) — T-75 rewritten to the doors; the old service-level block replaced
   - PL-278 close-out — annotation with check-homes, cross-references, one `research/research.md` §4 line
4. **`npm run verify` green before any ✅** — checked and recorded per task in progress.md. 🔵 is not ✅; a ✅ without a recorded verify run is not a ✅.
5. **Constants of every task:** tenant isolation held · audit entry written · typed refusal on failure (never empty success) · no student PII in logs · `reason_detail`/`note`/advisor-notes absent downstream · `tenant_id` never a caller-supplied argument.
6. **The Generator does not grade its own work.** When done: report 🔵/✅ honestly in progress.md, then hand to a fresh `/evaluate` conversation on a different model family — see "Evaluator requirements."
