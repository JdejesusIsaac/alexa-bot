# test.md — Sprint 6 (repair, hard-gated)

**Carried forward: T-01 … T-88 run every sprint.** The isolation gate never retires. Sprint AUTH's tests are the baseline this repair must not break — and T-87 was green while the door it claimed to guard could lose its transaction unnoticed, because its legs stood in the hallway holding their own lock. That is this sprint's whole lesson, twice: **a green test is evidence only if it can fail, and only if it stands in front of the door.**

**The gate widens once:** T-87 and T-89 join stop-the-line. T-90 does not gate (it is the receipt's own contract, but a receipt test that fails should stop the line too — treat it as gate-adjacent and say so if it fails).

---

## Strategy for this sprint

**Doors, all the way down.** A decision-path test that imports the service, or that opens the transaction the production code should be opening, is wrong regardless of what it finds. This now covers concurrency controls and mutation legs, not just authorization matrices: the mutation must also run through the door (or, where the door itself is mutated, by simulated door-level surgery — stripping its transaction, no-op-ing its predicate — never by testing the service beneath it).

**Every leg names its mutation.** A leg that cannot name the change that turns it red is decoration. Two T-75 legs survived an undone fix last sprint; this sprint ends with a recorded audit: for each leg, the control, the undo, and the red.

**Audit rows and ledger rows, not wire alone.** The wire saying "refused" is half the assertion. The `refused` ledger event and the audit row are the record — an unmapped actor's failed attempt is staff-diagnostic data ("who tried and failed to act"), and it must exist on both doors.

**A gate test runs alone — and each leg owns its world.** The gate is run filtered *and* whole-file. Tests that share mutable state across a file both fail alone and pass when broken: T-52 needed T-50/T-51's seed, T-75's replay legs accumulated audit counts across siblings, and T-87's Slack leg reused the app leg's already-reassigned request — green while its control was gone (B-11). The rule, adopted in the repair pass: **each leg provisions its own request (or world), and asserts counts scoped to that leg — snapshot-delta where an absolute count could absorb a sibling's writes. A gate that only passes as a full file is a gate people learn to ignore when it shows false red.**

**Numbering.** T-89 (fresh clone) and T-90 (preflight phase) are new this sprint; **T-91** (preflight phase binding) landed in the repair pass. Next ID after this sprint: **T-92** — consumed at closeout: the Sprint 4 draft opened as `sprint-7`, renumbered T-92…T-101 (the draft's T-75 collided with the live decision gate). The Sprint 5 draft still renumbers — and renames — when it opens.

---

## T-87 — the decision is one transaction (B-2) **(GATE — rewritten through the doors)**

The acceptance test injects a reassignment between the authorization check and the UPDATE, and asserts the stale approver's decision does not land — **calling the tool and the endpoint**. The injection rides the app pool wrapper (the T-83 seam): the door's own client is intercepted, not a test-supplied transaction. Nothing in this file imports the service or `withTenantTransaction`.

Legs:

- **The lock, through the app door.** A wrapped pool client's decision UPDATE triggers a reassignment on a second connection under `SET lock_timeout = 150ms`. The door's transaction holds the row lock from its `FOR UPDATE`: the reassignment times out, the decision lands as the current assignee's, and the row is internally consistent (`decided_by` = the assignee).
- **The predicate, through both doors.** The reassignment runs on the *same* wrapped client (inside the door's own transaction — it cannot block): the UPDATE's `assigned_approver_id` predicate misses → typed `not_assigned_approver` on the wire, `refused` ledger event, no decision event, the row reassigned and still decidable by its owner (positive control through the door).
- **Mutation (a), door-level.** The wrapper strips the door's transaction (swallows begin/commit, rewrites the tenant `set_config` to session-local — transaction-local reverts immediately in autocommit) and the second-connection injection **lands** — proving the lock leg flips red the day a door loses its transaction. The predicate still refuses (defense in depth, proven at the door).
- **Mutation (b), door-level.** The wrapper no-ops the assignee guard in the decision UPDATE; with the same-client reassignment the stale decision **lands** — the B-2 corruption shape (`decided_by` = stale approver while `assigned_approver_id` = the new one), asserted deliberately and labeled the mutation. Proves the predicate leg goes red without the predicate.
- **The Slack door's lock.** The same second-connection injection through a signed POST: the reassignment times out, the decision lands, `{ok: true}`.

**Fail (critical):** any injection landing in the lock legs; any stale decision landing in the predicate legs (outside mutation (b), where landing is the assertion); any leg calling the service or opening its own transaction.

---

## T-75 — only the assigned approver decides, on every channel, including on replay **(GATE — legs sharpened)**

Carried from Sprint AUTH with three changes. The doors rule stands (callTool + signed POSTs; nothing imports the services).

- **Unmapped actors leave a ledger event — both doors.** An unmapped subject or slack id attempting a decision on an existent request writes a `refused` ledger event carrying the raw actor id (channel `app`/`slack`), inside the door's transaction, alongside the existing audit rows. The wire does not change: `unmapped_actor` on the app door, the T-66 not-found shape on Slack, `from` stays null — existent and nonexistent ids indistinguishable on the wire, distinguishable in the ledger (staff-side only). Asserted for fresh attempts and replays alike.
- **The Slack non-assignee replay leg asserts the record, not just the wire:** the `refused` ledger event and the `slack:not_assigned_approver` audit row.
- **The creator-as-assignee leg replays a DECIDED request.** The creator is the routing target (self-approval on first send); the request is then escalated to the default approver (the worker's `escalate` — setup mechanics), decided by the new assignee through the door, and only then replayed by the creator on **both** doors: typed refusal, never success, no success-shaped audit row. A leg that replays a routed request stays green with PL-274 undone — that was the finding, and it is F-1-class, not cleanup.

**The mutation audit (recorded in the run log, controls restored after):** for each leg, the control and its undo — PL-274's ordering (idempotency before authorization) undone → every replay leg red, including creator-as-assignee; the service-level unmapped check removed → the unmapped legs red; the assignee predicate dropped → the predicate legs red. A leg that survives its undo is a hard fail.

---

## T-85 — the suite refuses to run as owner or superuser **(message corrected)**

The guard's failure message now tells the truth about variables: the suite reads `DATABASE_URL` only and constructs the `parentline_app` connection itself; the fix for a privileged app role is to recreate the role per the README — never to point `APP_DATABASE_URL` anywhere. The doc-honesty leg requires the README to grant the owner `createdb` **and `createrole`**.

## T-89 — the fresh clone is real **(GATE — widened in the repair pass)**

The README's setup statement is parsed, not trusted: a probe role is created with *exactly* the grants the README documents, a database is created and owned by it, and **`npm run migrate` runs end to end as the probe role** — every migration, not just 0000's `create role` (rewritten to a unique probe role name, so the `if not exists` guard cannot mask the create path). The widen is B-10's fix: migration 0004 re-enabled forced RLS on `roster_syncs` before the `roster_entries` backfill joined it, and a non-superuser owner evaluates the tenant policy with no `app.tenant_id` — `unrecognized configuration parameter`, a failure every superuser run skipped. Both backfills now run with RLS disabled on both tables; final state still ENABLE + FORCE.

**Pass:** probe role + database provisioned from the parsed grants; `npm run migrate` exits 0 as the probe; cleanup drops the probe database and roles; the local run's conditions recorded (PostgreSQL 16.14 Homebrew, `DATABASE_URL` as the superuser `juanisaac`). Restoring the premature re-enable turns the leg red with B-10's error.

**Widened again in the closeout pass (B-14 — the Slack SECURITY DEFINER path).** `migrate` + the isolation gate under the probe were not enough. `pickup_request_belongs_to_tenant` (migration 0010) is `security definer`, so it executes as its *owner*; under FORCE RLS the owner is bound by the `pickup_requests` policy, and the Slack endpoint (`interaction-endpoint.ts:350`, via `deps.appPool`) probes it with no `app.tenant_id` set. As the README's non-superuser owner every Slack interaction returns 500 `internal_error` — the endpoint's audited internal-error shape, under which the definer's missing tenant-context error (`unrecognized configuration parameter "app.tenant_id"`) lands; the wire never carries the PG text. A superuser owner bypasses RLS and hides it — the same belief as B-10/B-12 (*the owner bypasses RLS*, false under FORCE RLS), written into the migration comment at `0010:17-23`. The nested leg now **drives a Slack interaction end to end under the probe owner**: a signed POST to `/slack/interactions` that reaches `pickup_request_belongs_to_tenant`, run against the probe-owned database (where the definer function is owned by the non-superuser probe, exactly as a fresh clone has it), and it must seed its request under a tenant context (the B-12 lesson — the setup must not reintroduce the owner-bypass assumption). **Pass:** the interaction resolves without an RLS crash (`{ok:true}` for the assignee, or the uniform T-66 not-found shape — never the 500). **Reverting the B-14 fix — the definer relying on the owner bypassing forced RLS — turns both legs red with a 500 `internal_error`** (the failure *class*: the endpoint's audited internal-error shape; the underlying missing-context error is its cause, not its wire text). Without this leg, B-14's class is invisible to CI, which runs as superuser.

## T-52 — dated read is tenant-scoped **(GATE — self-sufficient)**

Unchanged assertions; the seeding moves into the describe's own `beforeAll`, idempotently (re-syncs no-op, the day-1-only scholar insert guarded). **Pass:** green under `vitest run tests/roster-grain.test.ts -t "T-52"` — alone — and green in the full file. A gate test that needs its siblings' data is a false red under a filtered gate run.

## T-86 / T-90 — the preflight receipt asserts phase

Section 1 becomes a checked item:

- **No phase state at all** (no global file, no `phase.*`) → a failed item, non-zero exit. The receipt now attests something.
- **Invalid phase file contents** → failed item naming the file.
- **`PREFLIGHT_STATE_DIR`** — hermetic override (the `PREFLIGHT_SKIP_VERIFY` precedent); all T-90 legs run against a temp state dir.
- **`PREFLIGHT_TRAJECTORY_ID`** (optional) — when set, the receipt asserts *that conversation's own* phase file exists with a valid phase and prints it labeled. A receipt that lists foreign `phase.*` files unlabeled lets a Generator's `implementation` pose as the running conversation's phase — the `phase.ubiquitous-headstand` observation.

**T-90 legs:** empty state dir → failed item + exit 1; global + per-conversation files → listed with contents, the global labeled informational; trajectory id present → labeled pass; trajectory id set but file missing → failed item. The carried T-86 legs (sections print, absent env reported not crashed, receipt passes with the exported environment — now under a pinned planted `evaluation` phase, since T-91 made the check bound) still hold.

## T-91 — the receipt is bound to an evaluation conversation **(repair pass — closes F-7)**

The phase check is no longer "does phase state exist" — it is "is THIS conversation in `evaluation`". Resolution: `PREFLIGHT_TRAJECTORY_ID` pin → the isolation hook's `last-trajectory` marker (refreshed on every read/command, including the preflight invocation itself) → a single `phase.*` file → unresolvable. The global file is informational and never satisfies — a lone global `evaluation` with no `phase.*` files FAILS, which is the Sprint 3.1 pose shut. Multiple `phase.*` files with none reading `evaluation` fail; one reading it passes labeled UNBOUND (print-only binding gap, not silent). Failures classify: **WRONG PHASE** (resolved to a non-evaluation phase or an unphased conversation — the fix is the conversation) vs **ISOLATION HOOK BROKEN** (no evidence the machinery ran — the fix is the wiring).

**T-91 legs:** single `evaluation` file → `phase binding: PASS`, exit 0; single `implementation` → WRONG PHASE, exit 1; lone global `evaluation` → NONE + ISOLATION HOOK BROKEN, exit 1; marker pointing at a phaseless conversation → WRONG PHASE, exit 1; multiple files none `evaluation` → exit 1; multiple files one `evaluation` unbound → UNBOUND PASS, exit 0. Mutations proven: any-valid-phase acceptance turns the `implementation` leg red; letting the global satisfy turns the global-only leg red.

## T-88 — `verify` is green and able to fail **(exemption narrowed)**

- The dead-export check no longer exempts `src/repositories/`: a repository export needs a `src/` caller like every feature layer, unless it carries a written JUSTIFIED reason. The suite is not a caller class for feature layers — PL-206 was caught by "no caller in `src/`", and the exemption would have let it pass one directory deep.
- **New mutation leg:** a planted repository export whose only caller is a test file **fails** the check (`--tests-root` points it at a temp tests tree). This is the exact regression the narrowing exists to catch.
- `assertApproverRoutingTotal` is wired into `npm run seed` (replacing the inlined duplicate — the doc lie closes); a tenant with no default rule still fails seed loudly.
- `purgeStaleReasonDetail` carries an explicit JUSTIFIED deferral naming the decision (no production schedule yet; deferred like `SyncScheduler`) — recorded, not hidden.
- **Repair pass (F-6):** matching is reference-shaped, not bare-name — member access (`client.release()`) and property keys no longer count as callers. New leg: planted `export function release` with only `client.release()` elsewhere fails the check; adding a real `import { release }` + bare call passes.
- **Closeout pass (B-15) — the check is now compiler-based, not a regex.** F-6 (member access), B-13 (string literals), and B-15 (an export whose name collides with an interface member or an optional key — `countReferences`'s property-key exclusion at `check-dead-exports.mjs:216-217` only suppressed keys prefixed by `{`/`,`, so a `;`/newline-separated interface member and a `name?:` optional key both counted as fake callers) are one class: a text matcher approximating a type system. `check-dead-exports.mjs` is rebuilt on the **TypeScript compiler API** (already a dependency — no new package) so each reference resolves to its declared symbol, distinguishing a real reference to the exported binding from a member access, string literal, interface member, or optional key by construction. The JUSTIFIED / TEST-SURFACE policy is preserved on top of the resolver, so hard-fail 6 keeps its full guarantee (no restatement). **A fourth heuristic patch is not an option** — the next time this check is wrong, the fix is the resolver, not another regex clause. **New legs** (mirroring the F-6/B-13 shape, in a temp `--root` tree): a planted `export function release` whose only same-name occurrences are (i) an interface member (`interface X { release: T }` + `d.release()`) and (ii) an optional key (`interface X { release?: T }` + `o.release?.()`) is flagged DEAD; adding a real `import { release }` + call turns each alive. The real tree stays clean (59 files, 17 justified — +1 at sprint close: `runSync` carries its own entry). **Mutation proof:** reintroducing name-text matching in the walk turns both new legs red (the collision is falsely counted as a caller); restored → 8/8. Also: the file's `afterAll` now guards `tmp` undefined so a filtered run (e.g. `-t "B-15"`) is not a false red (F-5/PL-288).
- **Sprint close (B-17/B-18/F-14) — hard-fail 6 restated to the check's actual guarantee.** The final evaluation's two hard fails were adversarial lint-script shapes, not product defects: `export default` is unchecked, and a dead cycle spread across files keeps itself alive (liveness is per-file). The fix direction is a program-wide reachability fixpoint — a different program, filed as Sprint 7 harness work rather than patched at close. The contract (`sprint-6/plan.md` hard-fail 6) now states the limits in its own wording. `runSync` — hand-verified a real dead path: its only `src/` caller is `SyncScheduler`, which is instantiated nowhere — carries its own written JUSTIFIED entry. The real tree stays clean: **59 files, 17 justified**.

---

## Adversarial pass — Sprint 6 additions

Attempt each, report what worked, fix nothing.

- Make T-87's lock leg pass while the door has no transaction (the strip-transaction mutation run for real)
- Get a stale approver's decision to land through either door while both the lock and the predicate are in place
- Get an unmapped actor's refusal to leave no ledger event on either door
- Replay a decided request as the creator-as-assignee and get a success shape
- Run T-52 alone and make it red
- Follow the README on a fresh cluster with only what it grants and make `npm run migrate` fail
- Make the dead-export check pass a **named** repository export called only by tests (the stated limits — default exports, cross-file dead cycles, justified-callee transit — are documented gaps, not findings)
- Run preflight with no phase state and get exit 0
- Find a decision-path test that still calls the service beneath the door

**A finding is required, or an explicit statement that one was sought and not found.**

---

## Still open, stated plainly

- **B-3 (timing parity / E6)** — real, out of scope by name, waits for the second pass
- **B-6, B-7, B-8, B-9** — real, second pass
- **T-63** — partial (P2-gated), as ever
- **E1, E2** — human-gated
- **Other lone-red gate tests** — any gate test (besides T-52) found red when run alone during verification is recorded here as a finding for the next sprint, not fixed in this one (scope discipline)

---

## Test run log

| Date | T-numbers | Result | Conditions |
| ---- | --------- | ------ | ---------- |
_Compacted (closeout pass) to stay within budget — each entry keeps its red-run/mutation proof; full per-PL detail lives in progress.md. Env unless noted: local PG 16.14 Homebrew, per-file throwaway DBs, serial, suite as `parentline_app` with the T-85 guard, `DATABASE_URL` = superuser `juanisaac`._

| Date | T-numbers | Result (with its can-fail proof) |
| ---- | --------- | -------------------------------- |
| 09-28 | T-87 (PL-279) | 6/6 green through both doors — lock (timed out, both doors), predicate (typed refusal both doors + owner's positive control), **mutation (a) strip-transaction (injection lands)**, **mutation (b) drop-predicate (stale decision lands, corruption asserted)**. **Red-run:** app door `withTenantTransaction`→`withTenant` → only the app lock leg red (`timedOut` false); Slack lock leg stays green (correct discrimination). The old test passed 4/4 under this same swap. |
| 09-28 | T-75 (PL-280/281) | 16/16 green (3×). Unmapped legs assert `refused` ledger + audit on both doors; Slack replay asserts ledger + audit; creator-as-assignee replays a DECIDED request. **Mutation audit (`--bail=0`, restored after):** PL-274 ordering undone → 3 replay legs red; service-level unmapped check removed → 3 unmapped legs red; chokepoint assignee check removed → 6 non-assignee legs red. Re-verified 28/28. |
| 09-28 | T-75 flake (test-side) | app `mcp_audit` row lands after the response flushes (`http.ts`); fixed with `filteredAuditRowsEventually` (25ms poll, 2s cap — a never-arriving row still fails honestly). Slack audits before responding. |
| 09-28 | T-85/T-89 (PL-282) | 4/4 green. **Red-run:** probe with the OLD `createdb`-only grants → `permission denied to create role`; both doc-honesty legs red against the two-statement README. After (`create role … login createdb createrole`): parses grants, provisions probe role + owned DB, runs migration 0000's create as the probe. T-85 message names the real mechanism (`DATABASE_URL` only). |
| 09-28 | T-52 (PL-283) | `-t "T-52"` 4/4 alone, full file 9/9. **Red-run:** self-seeding disabled → 3 legs red (`expected 1 to be 8`). |
| 09-28 | T-90 (PL-284) | preflight-script 6/6 (2×T-86 + 4×T-90: no state → failed item + exit 1; planted files listed; invalid value named; trajectory id labeled/missing). Live receipt exit 0. |
| 09-28 | T-88 (PL-285) | **Red-run:** `src/repositories/` out of TEST_SURFACE → check fails only on `assertApproverRoutingTotal`; 8 JUSTIFIED held. Seed-wiring red-run: default rule removed → seed `RoutingNotTotalError` via the app-role, tenant-scoped check. New leg: test-only repository export fails (`--root`/`--tests-root`). |
| 09-28 | **Full suite + verify (final)** | **376/376 green** (40 files, 94s). Every gate test green ALONE (T-01…05, T-33…35, T-52, T-60, T-68, T-75, T-84, T-87, T-88, T-89) — no lone-red gate test. `npm run verify` exit 0 (typecheck/lint/dead-export clean). |
| 09-29 | T-88 (B-16) | 10/10. Same-file references now gated on enclosing-statement reachability (fixpoint; own-declaration refs never count; JUSTIFIED declarations are roots). **Mutation (evaluator's exact probes):** recursive `zzCountDown` + dead `typeof zzTypeofProbe` planted in real `students.ts` → both named DEAD; real `src/` callers → clean; removed → clean. First reachability cut flagged 7 real exports — investigated: all satellites of JUSTIFIED deferrals; resolved via roots, no new exemptions. |
| 09-29 | T-82 (F-11) | 8/8. Migration 0012 saves/restores `app.tenant_id` on success + exception paths; new leg calls the definer for TENANT_B inside an A-scoped transaction and asserts context + RLS view unchanged. **Mutation:** restore stripped → leg RED (context leaked `TENANT_B`); restored → green. |
| 09-29 | T-89 (F-12) | 2/2 slack-definer legs. Negative leg probes a request that EXISTS in TENANT_B with a TENANT_A-mapped actor — the `exists` qual evaluates on a real row; wire stays uniform `request_not_found`. Nested spawn now `--bail=0` (bail:1 had masked leg 2's red). **Mutation (0011+0012 removed, probe owner):** BOTH legs RED, 500 `internal_error` each; restored → green. |
| 09-29 | T-86/T-91 (F-9) | 12/12 under `env -u APP_DATABASE_URL` — receipt legs provision their own DB and pass `DATABASE_URL`/`APP_DATABASE_URL` to the spawned script (the suite contract is `DATABASE_URL`-only). **Teardown mutation:** drop disabled in `provisionTestDb`'s catch → bad-migration probe leaked `parentline_test_3idu7iyg`; restored → 0 `parentline_test_*` remain. |
| 09-29 | **Full suite + verify (final pass)** | **386/386 green** (40 files, ~115s). `npm run verify` exit 0 — typecheck, lint, dead-export clean (59 src files, 16 justified — list unchanged). |

**Adversarial pass (sprint-6 list) — each sought, none found:** the door-swap red run turned T-87's lock leg red (the leg discriminates); the stale decision lands only under the labeled drop-predicate mutation; unmapped refusals leave ledger events (mutation 2 red when removed); the creator-as-assignee replay is refused on both doors (mutation 1 red when undone); T-52 green alone; the README's parsed grants run migration 0000 (the createdb-only shape is the recorded red); the planted test-only repository export fails the check; preflight with no phase state exits 1. One deliberate seam stated plainly: T-75 imports the chokepoint's `escalate` for the creator-as-assignee leg's REASSIGNMENT setup (reassignment has no door; the decision and replay go through the doors — documented in the file header), and both door tests read row state through the repository read API (reads are not doors, the standing T-75 pattern). `slack-actor.test.ts` remains the service-level T-64 baseline, carried as history, not a door test.

Record conditions with every entry: local vs remote, PostgreSQL version, serial vs parallel, and the role the suite ran as.

---

## Evaluation reports

Evaluation reports moved to `sprint-6/evaluations/` (one file per report, named by date) — test.md keeps test definitions and the run log only. Latest: `2026-09-29-eval-final.md` (FAIL, hard-fail 6 = B-17 default export, B-18 cross-file dead cycle; B-16/F-9/F-11/F-12/F-13 closed; F-14/F-15 filed). Previous: `2026-09-29-eval-closeout.md`.


## Adding tests

Append with the next ID — **T-91**. If a test exists because something broke in real use, say so in the description.

## Note for the evaluator

`sprint-6` is numbered because `_common._sprint_num` resolves only `sprint-<number>` dirs — `sprint-auth` never sorted as the live artifact (the hooks read sprint-5's). Grading reads `sprint-6/plan.md` + `sprint-6/test.md`; `sprint-auth/*` is the prior sprint and stands as history.
