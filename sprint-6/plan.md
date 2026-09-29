# plan.md — Sprint 6: the Sprint AUTH repair

**Sprint goal**

> Every proof of the decision-path controls stands in front of the door, and every leg can fail. The Sprint AUTH evaluation's findings F-1…F-4, the orchestrator's preflight phase observation, and the unscored dead-export observation are closed as checks, not as intentions.

**Companion artifacts:** `sprint-6/test.md` (T-87 rewritten, T-75/T-85/T-86/T-88 extended, T-52 self-sufficient, T-89/T-90 new) · `sprint-6/progress.md` (this Generator). No `sprint-6/research.md` — a repair-of-repair has no new research questions. `sprint-auth/*` stands unchanged except the Failed Approaches recurrence annotation (below).

---

## Why this sprint exists

The Sprint AUTH evaluator returned four findings plus one unscored observation. Three are the same lesson at different depths:

- **F-1** — T-87 opens its own transaction and calls the service beneath the door. The doors own the transaction (`decide-pickup-request.ts`, `interaction-endpoint.ts`); a test that supplies its own cannot detect a door losing theirs — and the UPDATE's assignee predicate masks the outcome either way. **Reproduced before this plan was coded: with `withTenantTransaction` swapped to `withTenant` in the tool handler, the old test passed 4/4.** That is B-4's rule recurring one layer down: a control asserted against the thing beneath the door rather than the door.
- **F-3** — unmapped actors get a typed refusal and audit rows but no `refused` ledger event on either door; and two T-75 legs cannot fail (the Slack replay and unmapped-actor replay legs assert no ledger or audit rows; the creator-as-assignee leg replays a routed, never-decided request — it stayed green with PL-274 undone). A test that passes against the broken build is the F-1 class one layer in.
- **F-4** — T-52, a gate test, is red when run alone (it depends on T-50/T-51 having run). A filtered gate run showing false red is how people learn to ignore the gate.
- **F-2** — `parentline_owner` with only `createdb` cannot run migration 0000's `create role` — fresh-clone-blocking; CI hides it by running as superuser. The T-85 refusal message points at `APP_DATABASE_URL`, a variable the suite never reads.
- **Preflight phase assertion** (orchestrator's observation, not the evaluator's) — `preflight.sh` prints phase state but asserts nothing; a receipt showed a foreign conversation's `implementation` phase with no attribution.
- **Unscored observation (now scored)** — the dead-export check exempts all of `src/repositories/` from needing `src/` callers. PL-206 was caught by "no caller in `src/`"; a repository function called only by tests now passes. Nine exports have no `src/` caller; two of them are documented as production-wired but are not.

## Scope

**In scope:** F-1 (T-87 through the doors) · F-3 (unmapped-actor ledger events + the cannot-fail legs + the T-75 mutation audit) · F-2 (README grants, T-85 message, T-89 fresh-clone leg) · F-4 (T-52 self-sufficient) · the preflight phase assertion (T-90) · the dead-export narrowing (T-88 extension) with `assertApproverRoutingTotal` wired into seed.

**Out of scope, second pass:** B-3 (timing parity), B-6…B-9, T-63's P2-gated leg, E1/E2/E6. Any other gate test found lone-red during verification is recorded as a finding for the next sprint, not fixed here — the last three sprints all grew past scope and that is the failure mode to avoid.

**Out of scope, permanently:** Sprint 4/5 features, PL-209, PL-213.

---

## Tasks

### PL-279 — T-87 goes through the doors (F-1)

Rewrite `tests/pickup-decision-transaction.test.ts` in place. No service imports — decisions happen only via `callTool('decide_pickup_request', …)` and signed POSTs to `/slack/interactions`. The injection rides the `appPoolWrapper` seam (the T-83 pattern): wrapped clients' `query` is intercepted; the interposition triggers only on the decision UPDATE for the target request; the arm state is set immediately before a door call and cleared after.

**AC:** legs through both doors — lock (second-connection reassignment under `lock_timeout` times out; the door's transaction holds the row lock), predicate (same-client reassignment inside the door's transaction → typed `not_assigned_approver`), mutation (a) strip-transaction door-level (the wrapper swallows begin/commit and rewrites the tenant `set_config` to session-local — verified: transaction-local `set_config` reverts immediately in autocommit — the injection lands, proving the lock leg flips red), mutation (b) drop-predicate door-level (the assignee guard no-ops; the stale decision lands — the B-2 corruption, asserted deliberately). **Red-run:** with `withTenantTransaction` → `withTenant` swapped in the tool handler, the rewritten lock leg goes red.

### PL-280 — unmapped actors leave a ledger event (F-3, code)

`src/services/pickup-decision.ts`: on an unmapped actor, both doors write a `refused` ledger event — app: actor = the raw subject, channel `app`, request looked up silently (existent only; the wire is unchanged, `from` stays `null` — no T-66 oracle); Slack: actor = the raw slack id, channel `slack`, alongside the existing audit row. Both commit inside the door's transaction.

**AC:** unmapped-actor refusals on both doors carry a `refused` ledger event naming who tried; no wire change anywhere.

### PL-281 — the cannot-fail legs (F-3, tests) + the T-75 mutation audit

`tests/pickup-decision-authorization.test.ts`: the Slack non-assignee replay leg asserts the refused ledger event and audit row; the unmapped legs (fresh + replay, both doors) assert the ledger event with the raw actor id plus audit rows; the creator-as-assignee leg replays a **decided** request (reassign via the chokepoint's `escalate` — setup mechanics, the worker's action — then the new assignee approves through the door) and must be refused on both doors, never success.

**AC:** every T-75 leg is paired with its mutation, named: PL-274 ordering undone → every replay leg red including creator-as-assignee; the service-level unmapped check removed → the unmapped legs red. Recorded in the run log, controls restored after.

### PL-282 — the fresh clone is real (F-2)

README: `create role parentline_owner login createdb createrole;` (single statement — the doc and the parser agree). `tests/helpers/db.ts`: the T-85 refusal message names the actual mechanism (the suite reads `DATABASE_URL` only and constructs the `parentline_app` connection itself; fix the role per the README, never point `APP_DATABASE_URL`). `tests/suite-refuses-superuser.test.ts`: doc-honesty leg requires `createrole`; **T-89** — parse the README's grants, provision a probe role with exactly them, create a database it owns, connect as it, run migration 0000's `create role` (renamed to a unique probe role) → must succeed.

**AC:** T-89 red against the createdb-only shape, green after; the README's owner can actually run migration 0000; the guard message tells the truth about variables.

### PL-283 — T-52 runs green alone (F-4)

`tests/roster-grain.test.ts`: T-52's describe-level `beforeAll` seeds its own world idempotently — `runSync` for A on DAY_1 and TODAY, B on TODAY (re-syncs are no-ops per T-51), a guarded A-OLD-1 insert, plus the existing colliding-row plants.

**AC:** `npx vitest run tests/roster-grain.test.ts -t "T-52"` green alone; the full file green (no double-seeding).

### PL-284 — preflight asserts phase (T-90)

`scripts/preflight.sh` section 1 becomes a checked item: fails when no phase state exists at all or any phase file holds an invalid value; `PREFLIGHT_STATE_DIR` (hermetic override, `PREFLIGHT_SKIP_VERIFY` precedent); optional `PREFLIGHT_TRAJECTORY_ID` asserts *that conversation's own* phase file and prints it labeled. T-90 legs against a temp state dir.

**AC:** no phase state → failed item + exit 1; planted files listed with contents; trajectory id set + present → labeled pass; set + missing → failed item.

### PL-285 — the dead-export exemption narrows (T-88 extension)

`scripts/check-dead-exports.mjs`: `src/repositories/` leaves TEST_SURFACE; `--tests-root <dir>` added; JUSTIFIED entries with written reasons for `insertApproverRoutingRule`, `insertMapping`, `insertRule`, `insertStaffIdentity` (test-world seeding), `findMcpAuditEntries` (diagnostic reader, no door yet), `findBySync`, `countEntries` (suite pinning), `purgeStaleReasonDetail` (**explicit P3 deferral** — no production schedule; deferred like `SyncScheduler`, recorded not hidden). `src/db/seed.ts` calls `assertApproverRoutingTotal` in step 3b, replacing the inlined duplicate (tenant context set/reset around the call — approver_routing is FORCE RLS). T-88 gains the leg: a repository export whose only caller is a test file fails the check.

**AC:** the real tree passes with the written exceptions; the planted test-only repository export fails; a tenant with no default rule still fails seed loudly (red-run).

---

## Gate

T-01…T-05, T-33…T-35, T-52, T-60, T-68, T-75, T-84, T-88 — **plus T-87 and T-89.** Run before every commit.

## Hard-fail conditions — any one fails the sprint

1. The standing gate (now including T-87, T-89) failing or unwritten
2. Any decision-path test calling the service beneath the door, or T-87 opening its own transaction
3. Any T-75/T-87 leg that survives its control's undo
4. An unmapped-actor refusal without a `refused` ledger event on either door
5. A fresh clone following the README unable to run the suite
6. A **named** `src/` export whose only callers are in `tests/` — or that has no caller at all — passing the dead-export check. **Stated limits, accepted at closeout (whole-codebase liveness is Sprint 7 harness work, not another local patch):** `export default` declarations are unchecked (B-17 — no `src/` file has one today); a dead cycle spread across files keeps itself alive — liveness is a per-file fixpoint, cross-file references count unconditionally (B-18); a JUSTIFIED declaration is a liveness root, so its callees are exempt transitively (F-14 — `runSync` carries its own written entry; the remaining satellites are the deferrals' own type declarations).
7. The preflight receipt's phase item absent or never failing

## Rubric

Functionality 30% (F-2, F-4, preflight, dead-exports) · **Auth & Security 55%** (F-1, F-3 — controls proven at the doors, legs that can fail) · Design 10% · Originality 5%. Hard fails override all weights.

## Risks (stated so they are deliberate, not missed)

- **Sprint naming:** `_common._sprint_num` matches only `sprint-<number>`; `sprint-auth` never resolved as the live artifact (hooks read sprint-5's). `sprint-6` restores resolution. No hook change — out of scope.
- **Strip-transaction wrapper:** begin-swallowing makes the door's transaction-local `set_config` revert immediately (verified against local PG 16.14) — the wrapper rewrites it to session-local on the armed connection; arm windows are tight (arm → one door call → disarm).
- **Seed wiring under FORCE RLS:** the owner is subject to forced RLS on `approver_routing`; the tenant context set/reset keeps the count tenant-scoped.
- **T-89 privilege dependence:** the fresh-clone leg needs the setup connection to create roles (holds locally and in CI, both superuser); PG16 CREATEROLE attribute-granting semantics verified empirically in the red-run.

---

## Repair pass (post-evaluation: B-10, B-11)

### PL-286 — migration 0004 backfill under the documented owner (T-89 widened)

`0004_service_date.sql` re-enabled and forced RLS on `roster_syncs` before the
`roster_entries` backfill joined it; a non-superuser owner evaluates the tenant
policy with no `app.tenant_id` — `unrecognized configuration parameter`. Both
tables now keep RLS disabled until both backfills complete; final state still
ENABLE + FORCE on each. T-89 proves `npm run migrate` end to end on a fresh
database created by a role holding the README's exact grants
(`createdb createrole`, no superuser), not just migration 0000's `create role`.

**AC:** T-89 green on a fresh DB as the README role; restoring the premature
RLS re-enable turns it red with B-10's error.

### PL-287 — T-87's Slack predicate leg gets its own request

The Slack leg reused the app leg's `racedId`, which the app leg had already
reassigned — the refusal fired at the chokepoint pre-check and the Slack leg
never reached the UPDATE, so dropping the Slack predicate stayed green. The leg
now provisions its own routed request, reassigns it inside the same wrapped
client, and asserts the interposition fired before asserting the refusal.

**AC:** with the assignee predicate dropped on the Slack channel only, exactly
that leg goes red; all six T-87 legs green restored, each alone and whole.

### PL-288 — the shared-fixture class

Per-leg provisioning + assertions scoped to the leg's own rows (snapshot-delta
audit counts; no cross-test mutable ids). Applies to T-52's seeded dependency,
T-75's accumulating audit counts, and T-87's reused request. The rule lands in
test.md: each leg provisions its own request, asserts counts scoped to it, and
the gate runs filtered leg-by-leg as well as whole-file.

**AC:** every leg of T-75/T-87/T-52 passes filtered alone; whole files green.

### PL-289 — the preflight receipt binds this conversation's phase (T-91)

Section 1 resolves THIS conversation's phase — `PREFLIGHT_TRAJECTORY_ID` pin,
then the isolation hook's `last-trajectory` marker (written on every
read/command by `evaluator-isolation.py`), then a single `phase.*` file — and
fails unless it is `evaluation`. The global file is informational only and can
never satisfy. Multiple phase files with none reading `evaluation` fail; one
reading it is a pass labeled UNBOUND. Failures classify WRONG PHASE vs
ISOLATION HOOK BROKEN in the exit summary. T-91: plant `evaluation` → exit 0;
plant `implementation` → exit 1, plus marker/multi-file/global-only legs.

**AC:** T-91's six legs green; weakening the check to any-valid-phase turns the
implementation leg red; letting the global file satisfy turns the
global-only leg red.

### PL-290 — dead-export check matches references, not name occurrences

`check-dead-exports.mjs` counted `client.release()` — a member access on an
unrelated object — as a caller of an export named `release` (F-6). Matching is
now reference-shaped: member access and property keys are excluded; imports,
bare reads/calls, and quoted specifiers count. T-88 gains the evaluator's
probe leg: planted `release` + only `client.release()` → dead; adding a real
import+call → alive.

**AC:** the planted-`release` leg discriminates both ways; the real tree
stays clean.

### PL-291 — the last service-level decision test is gone

`tests/slack-actor.test.ts` (T-64/T-67) called `decidePickupRequestAsSlackActor`
directly — beneath the door (F-8). Deleted: the door-level equivalents already
exist (unmapped → uniform `request_not_found` in T-66; subject/channel/audit in
the endpoint approve leg; idempotent replay in T-75's door legs). The service's
only remaining caller is the endpoint itself.

**AC:** no test imports the decision service; the endpoint legs covering the
same assertions stay green.

### PL-292 — secrets are files, not variables

`GOOGLE_SERVICE_ACCOUNT_JSON` (the key in an env var — broke `source .env`,
then leaked a private key through a variable listing) is replaced by
`GOOGLE_SERVICE_ACCOUNT_FILE` pointing at `./secrets/sa.json`; `secrets/` is
gitignored. The connector reads the file at construction; errors name the
variable and path, never contents. `.env.example`, README updated; connector
tests plant synthetic key files.

**AC:** connector constructs from a file path; unreadable/invalid/missing-field
files throw `ConnectorAuthError` naming `GOOGLE_SERVICE_ACCOUNT_FILE`; removing
the file read turns the construction leg red.
