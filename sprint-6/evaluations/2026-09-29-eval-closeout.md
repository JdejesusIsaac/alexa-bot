## Evaluation report — Sprint 6 closeout (Evaluator, 2026-09-29)

**Pre-flight receipt: PASS, BOUND.** It resolved to `beautiful-replace` (isolation-hook marker) → `evaluation`; hooks 11/11; `parentline_app` superuser=false/bypassrls=false; `verify` exit 0. Only DATABASE_URL/APP_DATABASE_URL were exported. Graded against plan.md + closeout.md + test.md; progress.md was not read, so I could not see the Generator's sweep dispositions. Model-family separation is asserted but I cannot verify it: this evaluator is Claude.

**Result: FAIL. Hard-fail 6 (B-16).** B-12, B-13, B-14, and B-15's collision class are closed.

Conditions: local PG 16.14, serial, suite as `parentline_app`, `DATABASE_URL` = superuser `juanisaac`. For B-12 I used a fresh `initdb` cluster (port 55441, torn down) with `DATABASE_URL` = README `parentline_owner`. Mutations were done by file copy and restored + `cmp`, and dead-export probes ran in a temp tree copy.

| Check | Result |
| ----- | ------ |
| Gate filtered alone: T-01(2) T-02(1) T-03(4) T-04(1) T-05(5) T-33(1) T-34(1) T-35(2) T-52(4) T-60(3) T-68(7) T-75(16) T-84(2) T-87(6) T-88(8) T-89(3) T-90(4) T-91(6) | all green |
| **B-12** fresh cluster, whole suite as README owner | migrate 12/12; **380/383**. Only the 3 failures are `preflight-script` (F-9, carried: needs exported `APP_DATABASE_URL`). T-89 nested runs green as this owner. **Closed.** |
| **B-14** mutation: `perform set_config` removed from 0011 | T-89 red under the probe (Slack approve → 500 `internal_error`), while the superuser main suite stays green 2/2. **Discriminates.** The wire shows `internal_error`, not the PG text. A direct probe (non-superuser owner, FORCE RLS, old SQL body) raises on the policy's `current_setting` cast, so it is the same class |
| **B-13/B-15** collisions: string literal, interface member, optional key, member access, shadowed local, real-tree `release` | all flagged DEAD (compiler resolver holds). Real tree clean (59 files, 16 justified) |
| T-75/T-87 mutation audit | not re-run: no decision-path src/test changed since the 09-28 pass that verified it |

### Bug report

**B-16 (HARD FAIL 6, Functionality): a test-only repository export stays alive through any reference in its own file.** The "internal use = alive" rule (`check-dead-exports.mjs:294`) counts self-references that are not callers.
- Repro (temp tree): append `export function zzCountDown(n: number): number { return n <= 0 ? 0 : zzCountDown(n - 1); }` to the real `src/repositories/students.ts`, and add a `tests/` file that imports and calls it. Run `node scripts/check-dead-exports.mjs`.
- Expected: DEAD `zzCountDown`. Actual: `clean`, exit 0.
- Same result for a unique-name export whose only in-file mention is an unused local `type X = ReturnType<typeof fn>`. Control: the same export without the self-reference is flagged.
- Cause: this is not the name-collision class; the resolver resolves correctly. It is the liveness policy: a reference from inside the export's own declaration (recursion), or from dead in-file code, counts as a caller.
- Fix direction: ignore references lexically inside the target's own declaration. Count an in-file reference only if the enclosing top-level declaration is itself alive (fixpoint over the file). Add T-88 legs for recursion and for a dead local type.

### Findings (not hard-fail)
- **F-11 (Auth & Security, latent):** 0011's `set_config('app.tenant_id', p_tenant_id, true)` is not scoped to the function. A function `SET` clause restores only `search_path`. Verified: inside a transaction with tenant A set, calling the definer for tenant B leaves `app.tenant_id` = B for the rest of the caller's transaction. Today's only caller (`pickupRequestBelongsToTenant`) uses a dedicated autocommit query, so nothing is exploitable now. But any future caller inside `withTenantTransaction` gets its tenant context silently switched, which is cross-tenant. The 0011 comment "nothing lingers" is true only for autocommit. Fix: save `current_setting('app.tenant_id', true)` and restore it before returning.
- **F-12:** T-89/B-14's nonexistent-id leg does not fail under the B-14 mutation: RLS quals are never evaluated when no row matches. Only the approve leg discriminates. That is not decorative for the gate, but the leg claims more than it proves.
- **F-13 (sweep residue, disposition unseen):** unqualified "owners bypass RLS silently" remains at `config.ts:13,205`, `migrate.ts:13`, `0000:4`, `0001:5`. It is correct only for non-FORCE tables, and every tenant table here is FORCE. Closeout item 1 named three of these for correction.
- **F-9 (carried):** T-86 and two T-91 legs are red without an exported `APP_DATABASE_URL`, on a fresh clone too.
- 4 `parentline_test_*` DBs (owner `juanisaac`) remain on the local cluster. Their origin is unclear, so I left them in place.

### Adversarial pass
Not found: T-87 lock green without a transaction; a stale decision landing; an unmapped refusal without a ledger event; a creator replay with a success shape; T-52 red alone; preflight exit 0 without evaluation phase; a service-level decision test (`slack-actor.test.ts` is deleted, and no test imports the decision service). Fresh-clone README → suite: **not found**, B-12 closed. Dead-export pass on a test-only repo function: **found (B-16).**

### Rubric (hard fail overrides)
Functionality 30% → 7/10 (B-12/B-14 closed; B-16) · Auth & Security 55% → 8/10 (B-14 fixed and proven at the door; F-11 latent) · Design 10% → 7/10 · Originality 5% → 7/10.

**Next sprint input:** B-16 (self-reference liveness), plus F-11 as a one-line hardening. Failed approach: "the resolver fixed who a reference points to, but the liveness rule still trusted any reference from the export's own file."
