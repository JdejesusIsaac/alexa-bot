## Evaluation report — Sprint 6 repair pass (PL-286…PL-292), Evaluator, 2026-09-28

**Pre-flight receipt: FAILED. This conversation was not started with `/evaluate`, so it resolves to `probable-lion` with no phase file (WRONG PHASE).** The check worked as designed, and I did not forge a phase file. Evaluator isolation still held: default-on isolation means this conversation never read `sprint-6/progress.md`. The receipt's other items pass: hooks 11/11, `parentline_app` unprivileged, and `verify` exit 0. A binding receipt needs a re-run from inside an `/evaluate` conversation.

**Result: FAIL. Hard-fail conditions 5 and 6 are triggered.** B-11, F-5, F-7 and F-8 are closed.

Conditions: local PostgreSQL 16 (Homebrew), serial, and the suite ran as `parentline_app` (T-85 guard active) with `DATABASE_URL` = superuser `juanisaac`. For B-12 I used a **fresh `initdb` cluster** (port 55439, torn down afterwards) with `DATABASE_URL` = the README's `parentline_owner`. Every mutation was made by file copy, restored the same way, and checked with `cmp`.

### Independently verified (green)

| Check | Result |
| ----- | ------ |
| `npm run verify` (via the receipt) | exit 0 |
| Gate, filtered by T-number alone | T-01 (2), T-02 (1), T-03 (4), T-04 (1), T-05 (5), T-33 (1), T-34 (1), T-35 (2), T-52 (4), T-60 (3), T-68 (7), T-75 (16), T-84 (2), T-87 (6), T-88 (5), T-89 (1), T-90 (4), T-91 (6): all green |
| PL-288: every leg of T-87 (6), T-75 (16) and T-52 (4) filtered alone | **26/26 green. F-5 closed.** |
| B-11: assignee guard made a tautology for `slack` only | **Exactly the Slack predicate leg goes red. B-11 closed.** |
| Guard made a tautology for `app` only | App predicate leg and mutation (a) go red; the Slack legs stay green (correct discrimination) |
| App door `withTenantTransaction` → `withTenant` | Only the app lock leg goes red |
| Slack door `withTenantTransaction` → `withTenant` | Only the Slack lock leg goes red |
| PL-286 / B-10: `npm run migrate` as a `createdb createrole` owner on a fresh DB | 11/11 migrations apply. `roster_syncs` and `roster_entries` end with ENABLE + FORCE |
| PL-289 / T-91: phase check weakened to any valid phase | The `implementation` leg goes red |
| PL-290: planted `release` with only `client.release()` elsewhere | Flagged dead (the fixed case holds) |
| PL-291: no test imports the decision service; `slack-actor.test.ts` deleted | Confirmed |
| PL-292: connector reads `GOOGLE_SERVICE_ACCOUNT_FILE`; errors name the variable and path only; `secrets/` gitignored | Confirmed |

### Bug reports

**B-12 (HARD FAIL 5, Functionality; blocks the gate on a fresh clone): a clone that follows the README can migrate but cannot run the suite. The isolation gate can't even seed.**
- Repro: `initdb` a fresh cluster. As a superuser, run `create role parentline_owner login password '…' createdb createrole;` then `createdb -O parentline_owner parentline`. Set `DATABASE_URL` to that owner, then run `npm run migrate` (exit 0) and `npx vitest run --bail=0`.
- Expected: the suite runs, and the gate is green.
- Actual: **33 of 39 files fail. 23 tests failed, 283 were skipped, and only 72 passed.** Most files fail in `beforeAll` with `unrecognized configuration parameter "app.tenant_id"`. The failing statement is the owner-pool seed `insert into tenants …` (for example `tests/isolation.test.ts:48` and `tests/helpers/mcp-server.ts:120`). T-01…T-05, T-52, T-75 and T-87 never execute. T-89 itself also fails as this owner: `must be able to SET ROLE "pl_fresh_owner_…"` at `suite-refuses-superuser.test.ts:132`, because it needs a superuser setup connection.
- Cause: this is B-10's class one layer on. The test harness seeds through `db.ownerPool` with no tenant context. A superuser bypasses FORCE RLS, so this never shows up locally or in CI; the documented non-superuser owner hits it. T-89 widened to cover `migrate` and stopped there, not at "run the suite", which is what hard fail 5 names.
- Side effect: when setup fails, the per-file throwaway databases are never dropped (6 were leaked by my probe run, since cleaned).
- Fix direction (for the Generator): seed under an explicit tenant context, or through a policy-exempt path. Extend T-89 to run at least the isolation gate as the probe owner.

**B-13 (HARD FAIL 6, Functionality): the dead-export check still passes a repository export whose only caller is a test, via a string-literal collision.**
- Repro: create `src/repositories/zz-probe.ts` containing `export function release() { return 1; }`, plus a test-tree file that imports it and calls it. Run `node scripts/check-dead-exports.mjs`.
- Expected: `DEAD EXPORTS … release`.
- Actual: `clean`, exit 0. A sibling export with a unique name in the same file *is* flagged, which isolates the cause.
- Cause: PL-290 counts "an exact quoted specifier" as a reference. `src/` contains `'release'` as a data value (`case 'release':` in `pickup-requests.ts:608`, `z.enum(['release', 'complete'])` in `record-pickup-outcome.ts:43`, and the schema registry). F-6 was fixed for member access only, and T-88's probe leg only plants the member-access shape.
- Fix direction (for the Generator): count quoted specifiers only in import/export `from '…'` or `import('…')` position, and add T-88 legs for `case '<name>':` and `['<name>']`.

### Findings (not hard-fail)

- **F-9:** the T-86 and T-91 legs of `preflight-script.test.ts` fail when `APP_DATABASE_URL` isn't exported. Seen in the fresh-clone run. T-91's phase legs read as hermetic but depend on the database-posture item.
- **F-10:** migration `0004_service_date.sql` was edited in place after it had already shipped. The final state is equivalent, but the migration runner applies files by name, so already-migrated databases never see the edit. That's acceptable only if no deployed database exists; this should be stated.
- **Carried, still unverified:** the seed's totality check falls back to the owner URL when `APP_DATABASE_URL` is unset (`config.ts:231`). I did not re-pursue it.

### Adversarial pass

| Attempt | Outcome |
| ------- | ------- |
| T-87 lock leg passing with the door's transaction removed | Not found (both doors go red) |
| Stale decision landing with the lock and predicate in place | Not found |
| Unmapped refusal leaving no ledger event | Not re-mutated this pass. The legs are green; the prior evaluation's reds are carried |
| Creator-as-assignee replay getting a success shape | Not found |
| T-52 red alone | Not found (per-leg too) |
| README on a fresh cluster, making the suite fail | **Found: B-12** (`migrate` passes; the suite does not) |
| Dead-export check passing a test-only repository function | **Found: B-13** |
| Preflight exit 0 with no phase state | Not found (this conversation's own receipt failed correctly) |
| A decision-path test calling the service | Not found |

### Rubric (the hard fails override the weights)

| Category | Weight | Score | Basis |
| -------- | ------ | ----- | ----- |
| Functionality | 30% | 5/10 | PL-286, PL-289, PL-291 and PL-292 are delivered. B-12 (the fresh clone can't run the suite) and B-13 (the matcher bypass) are not |
| Auth & Security | 55% | 9/10 | Every T-87 mutation I applied discriminates per door and per channel. B-11 and F-5 are closed |
| Design | 10% | 7/10 | Per-leg provisioning is clean. The harness still assumes superuser seeding |
| Originality | 5% | 7/10 | Channel-isolated mutation exposure is now present |

**Next sprint input:** B-12 and B-13. The failed approach to record: "T-89 proved `migrate`, not the suite, under the README owner; PL-290 fixed member-access collisions but kept string-literal collisions."
