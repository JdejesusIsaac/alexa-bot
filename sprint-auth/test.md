# test.md — Sprint AUTH (repair, hard-gated)

**Carried forward: T-01 … T-83 run every sprint.** The isolation gate never retires. Sprint 3.1's tests are the baseline this repair must not break — and T-75 was green while the door it was written to guard stood open, because its legs stood in the hallway. That is this sprint's lesson twice over: a green test is evidence only if it can fail, and only if it stands in front of the door.

**The gate does not widen; it sharpens.** T-75 stays stop-the-line and is rewritten in place. T-84…T-88 join the suite.

---

## Strategy for this sprint

**Test the doors, not the hallway.** Authorization tests call public entry points only — the MCP tool and the Slack endpoint. A control asserted against the function beneath it has not been asserted against the path an attacker uses. This is a rule now, not a preference: a test file that imports the service or repository to prove an authorization outcome is wrong regardless of what it finds.

**Every assertion ships with its mutation.** A control — or a tolerance — that has never been shown to fail is not an assertion. Every statistical or timing assertion, and every authorization leg written this sprint, carries a paired mutation leg proving it fails when the control is reverted: reorder the checks, drop the transaction, drop the predicate, restore the old hook logic. If you cannot name the mutation that turns the leg red, the leg is decoration.

**Audit rows, not log lines (AD-42).** Carried, with this sprint's sharpening: B-1's corruption was not the state — the state never changed — it was a `success:idempotent` audit row under an actor with no right to decide. The audit trail is the thing under test. Query the row; assert the outcome code and the actor; never infer either from a log.

**Numbering.** T-84…T-88 are allocated here, per the sprint commission — deliberately not skipped around the drafts: the Sprint 4 draft reserved T-74…T-83 (already taken by Sprint 3.1) and the Sprint 5 draft reserved T-84…T-95. **Both drafts renumber when they open** — this supersedes Sprint 3.1's "next ID is T-96" note, which assumed skipping past the drafts rather than renumbering them. Next ID after this sprint: **T-89**.

---

## T-75 — only the assigned approver decides, on every channel, including on replay **(GATE — rewritten)**

The request's `assigned_approver_id` is the only identity allowed to decide it, resolved through `staff_identities` on both surfaces, **before any idempotent short-circuit**. Every leg calls a door: the app legs go through `decide_pickup_request` via the test MCP server (`mintToken` + `callTool`); the Slack legs go through signed POSTs against `/slack/interactions` (`postSigned`). Nothing in this file imports the services.

Legs:

- **The assignee approves — both doors.** The positive control: a refusal-only test proves nothing about the path still working. `decided_by` is the resolved subject, the event row carries the right channel, the audit row is written.
- **A mapped non-assignee is refused — both doors.** Typed `not_assigned_approver`, audited, `refused` ledger event, no state change, no decision event.
- **The creator is refused — both doors**, including the case where routing assigned the creator: `self_approval`.
- **An unresolved actor is refused — both doors.** App: a token `sub` with no `staff_identities` row → `unmapped_actor`, identical for existent and nonexistent ids. Slack: an unmapped `slack_user_id` → the T-66 not-found wire shape, with the refusal distinguished in the audit row.
- **Replay of each of the above is refused.** After the assignee has decided the request, the non-assignee, the creator, and the unresolved actor each re-send the decision through both doors: typed refusal again, `refused` ledger event, refusal audit row. **No success-shaped response and no `success:idempotent` audit row under any of them.** This is B-1's leg — the state did not change, but the audit recorded a successful decision by someone with no right to make it; the audit trail was the thing corrupted.
- **The assignee's own re-send remains an idempotent success** (T-54 preserved — the fix must not break idempotency for the actor entitled to it). One decision row; the replay response says idempotent.
- **The sweep.** Query decision events and audit rows across every request this matrix created: zero rows whose actor is unresolved in `staff_identities`; zero success outcomes whose actor was not the assigned approver at decision time.

Mutation legs (the rule, applied):

- Reverting PL-274's ordering — idempotency before authorization — turns the replay legs red.
- The doors rule is structural, not runtime: the legs use `callTool` and signed POSTs, visible in the file; a reviewer (and the hook suite) sees the hallway import the moment it appears.

**Fail (critical):** any refusal case succeeds on either door; any success-shaped response or `success:idempotent` audit row under a non-entitled actor; any decision row lacking a resolved subject. Hard-fail 5 (second amendment) and hard-fail 1.

---

## T-84 — isolation defaults to on

`evaluator-isolation.py` inverted: `progress.md` and `smoke.log` are blocked unless **this conversation's own** phase file reads exactly `implementation`.

**Pass:**

- `verify-hooks.sh` reports **11/11**.
- The new unphased case: a trajectory with no per-conversation phase file, while the legacy global file says `implementation` — the Sprint 3.1 breach configuration — is **blocked** (exit 2, reason on stderr). The case is hermetic: it sets the global file, runs, and restores it.
- A conversation whose own phase file says `implementation` reads `progress.md` freely.
- `smoke.log` is blocked in every phase that blocks `progress.md` — asserted inside the blocked cases, not as a twelfth check.
- The block message states the default and the way out (`/implement`).

**Mutation:** the check runs the actual hook script, so it is its own mutation test — restore the old allow-unless-`evaluation` logic and the unphased case fails (exit 0 where 2 was expected), turning `verify-hooks.sh` red.

---

## T-85 — the suite refuses to run as owner or superuser

**Pass:**

- The setup guard in `provisionTestDb` throws when the app connection's `current_user` is a superuser, holds `BYPASSRLS`, or owns the connected database — before any test runs. Not a warning, not a skip.
- The failure message names the role and the fix: create the non-owner roles per the README, set `APP_DATABASE_URL` to the app role, never run the suite as the owner or a superuser.
- Mutation leg: drive the guard with a deliberately privileged connection (the `DATABASE_URL` owner works) and assert the typed failure fires. Against a guardless setup this leg has nothing to assert — it exists to prove the guard discriminates.
- Role honesty: `.env.example`'s documented owner role is one the README's `CREATE ROLE` statement creates; the README Setup section creates both roles, so a fresh clone can follow it end to end. (Doc leg — verified by inspection, stated as such.)

---

## T-86 — `scripts/preflight.sh` is the receipt

**Pass:**

- Four sections, in order: phase state (the legacy global file's contents or "absent", plus every per-conversation `phase.*` file with contents); `verify-hooks.sh` result (11/11 expected); database posture (per connection string: `current_user`, `rolsuper`, `rolbypassrls`, database-owner status); `npm run verify` exit code.
- Every section prints even when earlier items failed — a receipt, not a gate that stops early.
- Unset `DATABASE_URL` / `APP_DATABASE_URL` print as failed items, never crashes.
- The script never sources `.env`.
- Exit code is non-zero iff any item failed.

**Contract:** the evaluation report carries this output verbatim. A report without it is incomplete regardless of score.

---

## T-87 — the decision is one transaction (B-2)

The acceptance test injects a reassignment between the authorization check and the UPDATE, and asserts the stale approver's decision does not land.

**Pass:**

- **Injection leg.** A wrapped client (the T-83 pool-wrapper pattern) interposes a reassignment on a second connection, under a short `SET LOCAL lock_timeout`, at the point between check and update. With the fix: the interposition cannot land mid-decision — the row lock is held across the transaction, the reassignment times out or applies after — and the decision that lands is the current assignee's or none. Assert: `decided_by` is never a non-assigned subject; the row's final state is consistent.
- **Predicate leg.** Interpose the reassignment through the same transaction's client: the UPDATE's `assigned_approver_id` predicate misses → typed `not_assigned_approver` refusal, ledgered and audited — the stale decision does not land even defense-in-depth.
- **Doors.** The outcome (a stale approver's decision refused) is asserted through both doors; the injection mechanics may run at the service boundary — this is a concurrency test, not an authorization matrix.
- **Sweep.** No decision row exists whose actor differs from the assigned approver at decision time.

**Mutation:** (a) remove the transaction wrapping — the second-connection injection lands and the stale decision records; the leg goes red. (b) Drop `assigned_approver_id` from the predicate — the predicate leg goes red. A leg that survives both mutations is not testing B-2.

---

## T-88 — `verify` is green and able to fail

**Pass:**

- `npm run verify` exits 0: typecheck, lint, the dead-export check, and the full suite.
- The Rule-7 fix does not weaken the rule: the disable (if used) is line-scoped with a written justification naming `SLACK_TENANT_IDS` as the value's origin; `eslint .` still fails on a planted `tenantId` parameter anywhere else in `src/` (mutation leg).
- The dead-export check fails on a planted dead export — a function with no caller in `src/` (the PL-206 mutation; `sendPickupNotifications` would have been caught at commit). Allowlist entries carry justifications.

---

## Adversarial pass — Sprint AUTH additions

Attempt each, report what worked, fix nothing.

- Replay every refusal through both doors — especially after the request is decided
- Get any success-shaped thing — tool text, `structuredContent`, endpoint body, audit row, log line — back to a non-assignee, the creator, or an unresolved actor
- Race the reassignment by hand, outside the test seam
- Make the suite run as a superuser or the owner — it must refuse at setup, naming the role
- Read `progress.md` or `smoke.log` from an unphased conversation — must block
- Run `scripts/preflight.sh` with nothing exported — must report, not crash
- Plant a dead export — `npm run verify` must go red
- Find a door the rewritten T-75 does not cover — a third channel, a tool beside `decide_pickup_request`, a path that reaches the chokepoint without passing either door

**A finding is required, or an explicit statement that one was sought and not found.**

---

## Still open, stated plainly

- **B-3 (timing parity / E6)** — real, out of scope by name, waits for the second pass
- **B-6, B-7, B-8, B-9** — real, second pass
- **T-63** — partial (P2-gated), as ever
- **E1, E2** — human-gated
- **E6** — not carried this sprint; E5 is the only measurable goal

---

## Test run log

| Date | T-numbers | Result | Conditions |
| ---- | --------- | ------ | ---------- |
| 2026-09-28 | T-75 replay leg (red run — B-1 present) | **RED**: `expected null to be 'not_assigned_approver'` — the replay returned success, the Sprint 3.1 gate breach reproduced in-suite | Local Postgres (Homebrew, :5432), per-file throwaway DBs, app role `parentline_app`, transaction wired, chokepoint not yet fixed |
| 2026-09-28 | T-87 predicate + mutation legs (red run — B-2 present) | **RED**: `{ok: true}` where the refusal was expected — the stale approver's decision landed; the lock leg already green (transaction's first half effective) | Same env; second-connection injection under `lock_timeout = 150ms` |
| 2026-09-28 | T-01…T-83 carried + T-75 (rewritten) + T-84…T-88 | **368/368 green**; `tsc` clean; `eslint` clean; dead-export check clean; **`npm run verify` exit 0** | Local Postgres (Homebrew, :5432), per-file throwaway DBs, serial, warm; suite run as `parentline_app` (guard T-85 active); full verify 152s |

Record conditions with every entry: local vs remote, dataset size, warm vs cold, serial vs parallel, and the role the suite ran as.

---

## Adding tests

Append with the next ID — **T-89**. The Sprint 4 **and** Sprint 5 drafts reserved overlapping numbers and renumber when they open; do not skip around them. If a test exists because something broke in real use, say so in the description.
