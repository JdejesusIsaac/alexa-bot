**PRE-FLIGHT ITEM FAILED: phase binding. The receipt reports WRONG PHASE: conversation `polydactyl-menu` never declared a phase, because the message did not lead with `/evaluate` ("run /evaluate"). Every other item passed. Isolation stayed in force: the default-on hook blocks progress.md for unphased conversations (hook case 10/11), and progress.md was not read. Model-family separation cannot be verified: this evaluator is Claude (Opus), and the prior evaluator was also Claude.**

## Evaluation report: Sprint 6 final pass (Evaluator, 2026-09-29)

**Result: FAIL, hard-fail 6 (B-17, B-18).** The previous report's items are closed: B-16, F-9, F-11, F-12, and F-13. The dead-export check still passes a repository export whose only caller is in `tests/`, through two shapes the B-16 fix did not cover.

### Pre-flight receipt (verbatim, condensed only where marked)
```
=== preflight: 2026-09-29T14:27:47Z ===
--- 1. Phase state ---
global phase file: implementation (informational only — cannot satisfy this check)
[11 phase.* files listed: 4 evaluation, 7 implementation — condensed]
resolved conversation: polydactyl-menu (isolation hook marker (last-trajectory))
no phase file for conversation polydactyl-menu — failed item
--- 2. verify-hooks.sh (expect 11 cases) ---
  11 passed, 0 failed (expect 11 cases)
hooks: PASS
--- 3. Database posture ---
DATABASE_URL: current_user=juanisaac superuser=true bypassrls=true owns_database=true (owner/migrator role — informational)
APP_DATABASE_URL: current_user=parentline_app superuser=false bypassrls=false owns_database=false
--- 4. npm run verify ---
verify: PASS (exit 0)
preflight: FAIL — a pre-flight item failed. ...
  phase: WRONG PHASE — conversation polydactyl-menu never declared a phase (no .windsurf/state/phase.polydactyl-menu); start the evaluation conversation with /evaluate
```
Conditions: local PG 16.14 (Homebrew), serial, suite run as `parentline_app`, and `DATABASE_URL` set to the superuser `juanisaac`. Both URLs were exported per command; `.env` was never sourced. All mutations and probes ran in a throwaway copy (`/tmp/evtree`, now deleted). The real tree was not modified.

### Results
| Check | Result |
| ----- | ------ |
| Gate, each filtered alone: T-01(2) T-02(1) T-03(2) T-04(1) T-05(5) T-33(1) T-34(1) T-35(2) T-52(4) T-60(3) T-68(7) T-75(16) T-84(2) T-87(6) T-88(10) T-89 fresh-clone(1) T-89 slack-definer(2) T-82(4) T-90(4) T-91(6) | all green |
| `npm run verify` (full suite + typecheck + lint + dead-export) | exit 0 |
| **B-16** re-probe: recursive `zzCountDown` in `students.ts`, called only from a test | flagged DEAD. **Closed** |
| **F-12 / B-14** mutation: 0011 and 0012 removed | **both** T-89 slack-definer legs red with 500 `internal_error` under the probe owner. The T-89 fresh-clone leg is also red. The outer superuser run stays green, so the leg discriminates. **Closed** |
| **F-11** mutation: success-path restore removed from 0012 | T-82 F-11 leg red (context leaked `bbbb…` = TENANT_B). Restored and green. **Closed** |
| **F-9**: `preflight-script.test.ts` without `APP_DATABASE_URL` | 12/12. **Closed** |
| **F-13**: comment sweep | every remaining "owner bypasses" statement is now qualified with "wherever FORCE is missing" (`config.ts:14,207`, `migrate.ts:14`, `0000:5`, `0001:6,144`). The general statement is now correct. **Closed** |
| T-75/T-87 mutation audit | not re-run. The decision-path src and tests were last modified 09-28 20:07–21:28, before the audited pass, and no test imports `services/pickup-decision` |

### Bug reports

**B-17 (HARD FAIL 6, Functionality): a default-exported repository function whose only caller is a test passes.** At `check-dead-exports.mjs:250`, `if (name === 'default') continue` skips every default export in every file. The comment says "entry-point default exports are JUSTIFIED whole-file", but the skip is not scoped to entry points.
- Repro: append `export default function zzDefault(n: number): number { return n; }` to `src/repositories/students.ts`. Add `tests/zz/a.test.ts`: `import zzDefault from '../../src/repositories/students.js'; zzDefault(1);`. Run `node scripts/check-dead-exports.mjs`.
- Expected: DEAD `zzDefault`. Actual: `clean (59 src files, 16 justified exceptions)`, exit 0.
- No `src/` file has a default export today, so the check can handle default exports like any other export at no cost. Entry points are already covered by whole-file JUSTIFIED.

**B-18 (HARD FAIL 6, Functionality): a cross-file dead cycle keeps itself alive.** B-16 made same-file liveness a fixpoint, but cross-file references still count unconditionally (`:379-380`, "cross-file use: unchanged rule"). The header's claim that "a dead recursion cycle keeps nothing alive" holds only within one file.
- Repro: in `students.ts` add `import { zzB } from './roster-entries.js'; export function zzA(n: number): number { return n <= 0 ? 0 : zzB(n - 1); }`. In `roster-entries.ts` add `import { zzA } from './students.js'; export function zzB(n: number): number { return n <= 0 ? 0 : zzA(n - 1); }`. Add a test that imports and calls `zzA` only.
- Expected: DEAD `zzA`, `zzB`. Actual: clean, exit 0. Control: the single-file recursion (B-16) is flagged.
- Cause: this is the same question as B-16, one level up. The check asks "is there a reference from `src/`?" instead of "is there a reference from reachable `src/` code?" Fix direction: run a single program-wide fixpoint. Roots are the JUSTIFIED entries, TEST_SURFACE-with-test-caller exports, and non-declaration statements. A cross-file reference counts only if its enclosing top-level statement is alive. Add T-88 legs for B-17 and B-18, and for the cross-file shape of the B-16 `typeof` probe.

### Findings (not hard-fail)
- **F-14 (Functionality, policy):** because JUSTIFIED declarations are liveness roots (`:363`), anything they call is implicitly exempt without a written entry. With the roots removed, the check flags `src/sync/scheduler.ts: runSync` and six exported types (`RoutingRule`, `MetricsJob`, `RunSyncOptions`, `SchedulerOptions`, `SyncJob`, `SyncResult`). `runSync` is a feature-layer (sync) function whose only `src/` caller is the unwired `SyncScheduler`, while the suite calls it constantly. That is the PL-206 hallway, kept alive by another exemption's reason. The "16 justified, list unchanged" count understates the real exemption surface. Either give satellites their own written entries, or state in hard-fail 6's wording that JUSTIFIED exemptions cover their callees.
- **F-15 (harness):** the receipt fails only on the phase item, because the user prompt was "run /evaluate", not a message led by `/evaluate`. The phase writer apparently matches only a leading command. That is correct per the contract, but it is the fourth receipt in a row with a phase caveat. Consider documenting the exact trigger in the evaluator skill.
- A database named `zz_b16_probe` remains on the local cluster, and its origin is unknown. I left it in place. The four `parentline_test_*` databases from the last report are gone.

### Adversarial pass
Not found: T-87's lock leg staying green without a transaction; a stale decision landing; an unmapped refusal without a ledger event; a creator replay with a success shape; T-52 red alone; preflight exiting 0 without an evaluation phase (this receipt exited 1); a test that calls the service beneath the door; a README fresh clone failing `migrate` (the T-89 fresh-clone leg is green, and red under mutation). **Found:** a dead-export pass for a test-only repository function, twice (B-17 default export, B-18 cross-file cycle).

### Rubric (hard fail overrides)
Functionality 30% → 7/10 (B-16, F-9 closed; B-17/B-18 open) · Auth & Security 55% → 9/10 (B-14 and F-11 closed with discriminating mutations; gate green alone) · Design 10% → 7/10 · Originality 5% → 7/10.

**Next sprint input:** B-17 + B-18 (make the liveness fixpoint program-wide and stop skipping `default`), plus F-14's decision on satellites. Failed approach: "B-16 made liveness a fixpoint per file, but cross-file references still counted unconditionally, and default exports were never checked at all."
