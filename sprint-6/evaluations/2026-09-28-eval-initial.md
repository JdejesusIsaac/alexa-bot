## Evaluation report — Sprint 6 (Evaluator, 2026-09-28) — compacted

_Condensed in the closeout pass: B-10 and B-11 below were both closed in the repair pass (see the next report). Preserved here: the findings and the rubric, because F-6 and F-8 are load-bearing for later lineage (F-6 → B-13 → B-15; F-8 → PL-291)._

**Result: FAIL** — hard-fail conditions 3 and 5. Conditions: local PG 16.14, serial, suite as `parentline_app`, `DATABASE_URL` = superuser `juanisaac`, env exported from `.env`. `npm run verify` exit 0; all gate tests green alone; T-87 door-swap and predicate-drop mutations each discriminate; the T-75 mutations reproduce red.

**B-10 (HARD FAIL 5) — closed in repair pass (PL-286).** A README-owner (`createdb createrole`, non-superuser) fresh clone cannot `npm run migrate`: 0004's second backfill joins `roster_syncs` after its RLS is re-enabled+forced, so the non-superuser owner hits `unrecognized configuration parameter "app.tenant_id"`. Superusers skip it. T-89 proved only migration 0000's one statement, not the path.

**B-11 (HARD FAIL 3) — closed in repair pass (PL-287).** The T-87 Slack predicate leg reused `racedId`, already reassigned by the app leg, so the chokepoint pre-check refused before `applyTransition`; the leg survived its control's undo. Fix: fresh routed request per leg + assert the interposition fired.

### Findings (recorded for later sprints)
- **F-5** — leg-level lone-reds in gate files (T-87 Slack predicate alone; T-75 replay describe alone — cumulative audit counts). Closed in repair pass (PL-288).
- **F-6** — dead-export heuristic bypassable by a name collision: `release` with only `client.release()` in `src/` passes (member access). Fixed for member access (PL-290); the class recurred as B-13 (string literals) and now B-15 (interface members / optional keys) — see the closeout's item 2.
- **F-7** — the default receipt let foreign `phase.*` files pose as the running conversation's phase (`phase.ubiquitous-headstand`). Closed by T-91/PL-289 (binding).
- **F-8** — a service-level decision test remained (`slack-actor.test.ts`, `decidePickupRequestAsSlackActor` beneath the door). Deleted in PL-291.
- **Observation (unverified):** the seed totality check falls back to the owner URL when `APP_DATABASE_URL` is unset (`config.ts`) — an owner that bypasses RLS would count across tenants. Probe was confounded by `--env-file-if-exists=.env`.

**Rubric:** Functionality 30% → 5/10 (B-10); Auth & Security 55% → 7/10 (B-11 a decorative leg); Design 10% → 7/10; Originality 5% → 7/10. Hard fails override.

**Next sprint input:** B-10, B-11 — "T-89 proved one migration statement, not the path; the T-87 Slack predicate leg inherited a pre-reassigned row."
