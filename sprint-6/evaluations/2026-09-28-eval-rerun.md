## Evaluation report — Sprint 6, re-run (Evaluator, 2026-09-28 21:33 EDT)

**Pre-flight receipt: PASS, and this time it is BOUND.** It resolved to `nonstop-legal` through the isolation-hook marker, and the phase is `evaluation`. Hooks 11/11. `parentline_app` has superuser=false and bypassrls=false. `verify` exit 0. The env was exported from `.env` (DATABASE_URL/APP_DATABASE_URL only).

**Result: FAIL. Hard-fail conditions 5 and 6 are still triggered.** No build change has been made since the previous report: every `src/`, `tests/` and `scripts/` file is older than it. `tests/helpers/db.ts` and `scripts/check-dead-exports.mjs` are byte-for-byte what B-12 and B-13 were filed against.

| Bug | Re-verified | Conditions / repro |
| --- | ----------- | ------------------ |
| **B-12** (HF-5) | **Reproduced.** Fresh `initdb` cluster (PG 16, port 55440, torn down). `create role parentline_owner login createdb createrole;`, then `createdb -O parentline_owner`. `npm run migrate` exits 0: 11 migrations applied, so PL-286 holds. Running `isolation`, `pickup-decision-transaction`, `pickup-decision-authorization` and `roster-grain` as that owner: **4 of 4 files fail in setup** with `unrecognized configuration parameter "app.tenant_id"`. T-89 fails with `must be able to SET ROLE "pl_fresh_owner_…"`. The gate never executes. | Temp cluster only, serial |
| **B-13** (HF-6) | **Reproduced.** Copied the tree to a temp dir and planted `src/repositories/zz-probe.ts` with `release` and `zzUniqueProbe`, whose only caller is a test. Result: `zzUniqueProbe` is flagged DEAD and `release` **passes**. The quoted-specifier clause (`['"\`]name['"\`]` at line 200) still matches `case 'release':` and `z.enum(['release', …])` anywhere in `src/`. | Temp tree only; the repo was not mutated |

**Not re-mutated this pass:** the T-75/T-87 mutation audit. The code under test is unchanged since the prior pass, which verified it (26/26 legs alone; every per-door and per-channel mutation went red).

**Rubric:** unchanged from the repair-pass report. Functionality 5/10, Auth & Security 9/10, Design 7/10, Originality 7/10. The hard fails override the weights.

**Next sprint input (failure protocol):** B-12 and B-13, as filed above. The Generator has not yet acted on them.
