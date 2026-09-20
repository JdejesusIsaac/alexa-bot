# progress.md — Sprint 2

> **Agent: update this file at the end of every working session.** Append to the log, refresh the state table, set "Next action" specific enough for a cold start. This file is how continuity survives a context reset.

**Sprint:** 2 — The MCP Server (Staff)
**Started:** 2026-09-16
**Status:** 🟢 Implementation complete — PL-101 ✅ CLOSED (Auth0 honors RFC 8707; evidence in research.md §8), PL-112 ⬜ unblocked (claims wiring remains) — all other tasks ✅, 49/49 tests passing locally. **E6 corrected to 🟡: Q2 closed, Q3 still unanswered.**

---

## Current state

**Next action:** (1) **Claim-namespace fix** — `.env` `TENANT_CLAIM=https://parentline.app/tenant_id`, `ROLE_CLAIM=https://parentline.app/role`; same two keys in the Auth0 Action body; Deploy; confirm the action sits on the **Login flow** canvas. Then `npm run serve` + probe `--e2e` → §6.3 full pass (HTTP 200 + `mcp-session-id`). Root cause: the previous namespace `https://parent-line/` is not a valid URL (bare host, no TLD) and Auth0 drops such claims silently — see Failed Approaches. If claims are still absent under a valid namespace, check Auth0 **Monitoring → Logs** on the login event to see whether the action executed at all; that separates "claim dropped" from "action never ran."
(2) Register the Claude Desktop client, wire `claude_desktop_config.json` → E1 full day + E3 remote p95.
(3) `npm run soak:day` on each business day.

**Blocked on:** PL-112 needs Auth0 console steps and observation time (E1 full day). **Q3 (E6) is blocked on ASK CLI access** — not installed on this machine (`ask`, `aws` both absent, no `~/.ask` credentials); installing `ask-cli` plus an interactive `ask configure` browser login is the unblock.

**Cold-start gotcha (session 7):** vitest does not load `.env` — export `DATABASE_URL`/`APP_DATABASE_URL` before `npm test` (`export $(grep -E '^(DATABASE_URL|APP_DATABASE_URL)=' .env | xargs)`). Do NOT `source .env` — the multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` breaks it.

**P2 status:** isolation gate verified RED locally (T-01 caught the weakened `roster_entries` policy: "expected 6 to be 3"), migration reverted byte-identical (`git diff` clean). Remote CI observation (a pushed broken commit) deliberately not executed — would require a red commit on `main`; local evidence + CI wiring noted, remote drill deferred.

**P1 status:** restated as pending — re-issuing the Sprint 1 evaluation is the evaluator's action, not the generator's. Owner: user, via `/evaluate` after this sprint.

**Soak (Sprint 1 closure, parallel):** harness built (`npm run soak:day` → `soak/soak-log.md`) · **0 / 10 counted business days** — first run 2026-09-20 recorded but **not counted: Saturday/Sunday is not a business day.** Day 1 counts on the next weekday run. Observed on the first run: 12 calls across both tenants, p50 1.35 ms, p95 4.91 ms, audit completeness 100%, leakage probe clean.

---

## Exit criteria — the only scoreboard

Graded separately from the rubric (AD-14). Sprint 1 kept two lists that disagreed for nineteen sessions; this is the single one.

| #   | Criterion                                                                                          | Status                                                                                           |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| E1  | Staff completes a full day from Claude Desktop, no wrong answer                                    | ⬜ PL-112 unblocked — console wiring in progress                                                 |
| E2  | Zero cross-tenant leakage through MCP, incl. forged arguments                                      | 🟡 verified locally (T-33…T-35, T-47); remote run pending                                        |
| E3  | p95 full round trip ≤300 ms, recorded with conditions — warm **and** cold JWKS reported separately | 🟡 local conditions: warm ~ms-scale, cold JWKS <500 ms (T-48); remote measurement pending PL-112 |
| E4  | No tenant parameter in any schema; no uncleared field returned                                     | 🟡 verified locally (T-34, T-36, T-45); final grading at evaluation                              |
| E5  | Every MCP call audited, actor from token                                                           | 🟡 verified locally (T-40, T-41)                                                                 |
| E6  | PL-013 Q2 and Q3 closed in writing                                                                 | 🟡 **partial** — Q2 closed by observation (research.md §8, Auth0 HONORED); **Q3 unanswered**      |

---

## Failed Approaches

> **Generator: read this before writing any code.** Repeating a documented failure is a rubric penalty. Max 10 lines. Survives context resets **and sprint restarts** — carried forward from Sprint 1; append on failure, never clear.

- Evaluator mischaracterized T-18's assertion (≤500 ms) when the code asserts ≤150 ms — verify against source, never against a report's characterization
- Marking a task ✅ when code is written rather than when the AC is met (PL-005) — use 🔵 for code-complete-but-unverified
- A test asserting field presence is not a measurement — T-41 passed while asserting nothing about latency; spec-mandated measurements need the sample loop AND the recorded number (eval F-2)
- Auditing delegated to tool handlers misses SDK pre-dispatch rejections (unknown tool, bad args) — the HTTP layer must audit `tools/call` rejections itself (eval F-1)
- `raw_data->>$2` returns nothing — it is parallel arrays `{headers, values}`, not a key-value map
- `->>` won't take a bigint from `WITH ORDINALITY` — needs `::int`
- Zod `.nullable()` without `.default(null)` still requires the key present
- `exactOptionalPropertyTypes` rejects the JWT object form — positional overload required
- Auth0 silently drops custom claims whose namespace is not a valid URL (`https://parent-line/` — bare host, no TLD): no error at authorize, token, or in tenant logs; cost ~2h across 6 probe runs chasing deployment instead of naming
- `source .env` crashes on multi-line `GOOGLE_SERVICE_ACCOUNT_JSON` — vitest needs `DATABASE_URL`/`APP_DATABASE_URL` exported explicitly

_At the 10-line cap, prune the oldest code-specific entries first; they remain in Sprint 1's progress.md. The two process lessons at the top stay._

---

## Task board

| ID     | Task                                       | Status | Notes                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PL-101 | Authorization server selection             | ✅     | Observed 2026-09-17: Auth0 **HONORED** — token `aud` array carries our resource URL (2 earlier REJECTEDs were dashboard config: API Application Access). Evidence: research.md §8 + `spike/pl-101-as-probe/evidence.md`. §6.1/§6.2 done; §6.3 pending claims Action |
| PL-102 | MCP server skeleton (Streamable HTTP)      | ✅     | T-46 green — version gate rejects unsupported versions with a typed error before the SDK's silent downgrade                                                                                                                                                         |
| PL-103 | OAuth resource server                      | ✅     | T-24…T-29 green — four distinct rejection codes; audience checked; query-string tokens rejected                                                                                                                                                                     |
| PL-104 | Discovery + client-conditional 401         | ✅     | T-30…T-32 green — PRM from config only; S256-only AS metadata; Alexa-shaped 401 omits WWW-Authenticate                                                                                                                                                              |
| PL-105 | Token → tenant + role                      | ✅     | T-33…T-35, T-47 green — forged tenant args stripped; identity per-request, never session-cached                                                                                                                                                                     |
| PL-106 | Disclosure policy layer                    | ✅     | T-36…T-38, T-45 green — single chokepoint at `src/disclosure/policy.ts`                                                                                                                                                                                             |
| PL-107 | Tool: `lookup_scholar_status`              | ✅     | Refusals surface distinctly E2E; description disjoint (T-44)                                                                                                                                                                                                        |
| PL-108 | Tool: `search_roster`                      | ✅     | T-43 green — every filter narrows; pagination verified; empty ≠ failure                                                                                                                                                                                             |
| PL-109 | Tool: `roster_sync_status`                 | ✅     | T-39 green — staff gets typed `insufficient_role` refusal, admin gets status                                                                                                                                                                                        |
| PL-110 | MCP audit + observability                  | ✅     | T-40…T-42 green — `mcp_audit` table, per-stage latency, timing oracle closed (200-call distributions)                                                                                                                                                               |
| PL-111 | Tool schema version registry               | ✅     | `schema-registry.json` pinned; fingerprint test fails CI on silent drift                                                                                                                                                                                            |
| PL-113 | Transport hardening & connection lifecycle | ✅     | T-48, T-49 green — session TTL sweep, DELETE termination, Origin rejection, GET 405, cold JWKS                                                                                                                                                                      |
| PL-112 | Claude Desktop end to end                  | ⬜     | Unblocked. Remaining: Auth0 claims Action, test-user app_metadata, static client registration, Claude Desktop config, then E1/E3                                                                                                                                    |

**Legend:** ⬜ Not started · 🟡 In progress · 🔵 **Code-complete, AC unverified** · ✅ AC met and verified · 🔴 Blocked · ⏸️ Paused

**🔵 is not ✅.** A task blocked on credentials or an external dependency stays 🔵.

---

## Test status

Sprint 1's T-01…T-23 continue to run every sprint. Sprint 2 adds T-24…T-49.

| Group                                                     | Written     | Passing     |
| --------------------------------------------------------- | ----------- | ----------- |
| Carried forward (T-01…T-23)                               | 23 / 23     | 23 / 23     |
| Auth (T-24…T-29)                                          | 6 / 6       | 6 / 6       |
| Discovery (T-30…T-32)                                     | 3 / 3       | 3 / 3       |
| **Tool isolation (T-33…T-35) — GATE**                     | 3 / 3       | 3 / 3       |
| Disclosure (T-36…T-39)                                    | 4 / 4       | 4 / 4       |
| Audit / latency / inference (T-40…T-42)                   | 3 / 3       | 3 / 3       |
| Schema honesty / descriptions / field economy (T-43…T-45) | 3 / 3       | 3 / 3       |
| Remote transport (T-46…T-49)                              | 4 / 4       | 4 / 4       |
| **Total**                                                 | **49 / 49** | **49 / 49** |

Full suite: 23 files, 214 test cases, all passing (2026-09-17, local Postgres via `.env`, Node 20). Includes the isolation gate re-run green after the P2 drill.

Individual case count is reported alongside T-number coverage, not instead of it — Sprint 1 ran four contradictory totals for nineteen sessions.

---

## Session log

_Newest at the top. Copy the template, don't reformat it._

```
### YYYY-MM-DD — session N
**Worked on:** PL-1XX
**Done:** what actually landed (commits, files, migrations)
**Decisions made:** anything that changes research.md — copy it there the same session
**Surprises:** what didn't behave as expected
**Next action:** specific enough to start cold
```

---

### Session 8 — JWKS warming, re-issue rule, evaluator dispatch
**Worked on:** E3 hardening (JWKS warm path), evaluator preparation
**Done:** (a) Added `JWKS_REFRESH_MINUTES` config (default 10) + `TokenVerifier.warmJwksCache()` (jose `reload()`) + startup prefetch and refresh timer in `createMcpApp` (`warmJwksOnStart`, `jwksRefreshIntervalMs` options; `McpApp.warmJwks()` exposed; timer cleared in `close()`). Motivation: E3's cold number was measured against a request-path fetch the refresh timer now removes — warming had to land before the remote p95 run, not after. (b) `LocalAs.jwksFetchCount` + three new T-48-block tests: warm→no-fetch on request, construction prefetch + timer refetch, `warmJwksOnStart:false` opt-out. (c) **Re-issue rule written into `sprint-2/plan.md` evaluator requirements** — a second pass amends E1/E3/E6 only; rubric regraded only if code changed. (d) Ran the evaluator as an isolated subagent pass (phase flip `evaluation`→`implementation`, contract-only inputs, no seeded findings). **Verdict: Rubric PASS 93/100, isolation gate green, zero hard-fails — sprint NOT complete.** Findings: **F-1 (MED-HIGH)** reachable MCP calls write no audit row — SDK rejects unknown tool/invalid args pre-dispatch, `search_roster` invalid-args branch doesn't audit, authenticated 405s unaudited (E5 violated). **F-2 (MED)** T-41 asserts field presence, not the 200-call p95 the spec requires; T-48 asserts bounds but records no number (E3 root cause). **F-3 (LOW)** T-32 test header doesn't record the 401 branch signal. **F-4 (LOW/info)** unauthenticated `GET /health` discloses live session count.
**Decisions made:** refresh timer calls `reload()` unconditionally rather than relying on jose's `cacheMaxAge` expiry — every tick is a real fetch, no staleness window. `.env` claim fix still user-side.
**Surprises:** the evaluator found a genuinely new attack surface (pre-dispatch rejections evade audit) — the green suite did not cover it. jose 6 exposes `reload()`/`fresh`/`coolingDown` directly on the resolver.
**Next action:** failure loop — findings become the sprint input. Fix F-1 (audit at HTTP layer for `tools/call` rejections + 405s; search_roster invalid-args parity), F-2 (T-41 implements its spec: 200 calls, recorded warm p95; T-48 records the cold number), F-3 (one-line doc). F-4 needs a decision: drop `sessions` from `/health` or gate it. Then re-issue scoped per the new rule — code changed, so the touched rubric rows regrade; E1/E3( remote )/E6 remain user-gated.

### Session 7 — verify, commit, serve smoke test
**Worked on:** commit hygiene, dev-DB migration, serve smoke test
**Done:** (a) `npm run verify` green — 23 files, 214 cases, 49/49 T-numbers (needed `DATABASE_URL`/`APP_DATABASE_URL` exported; vitest does not read `.env`). (b) Applied migrations 0002 + 0003 to the dev database — the first `npm run serve` smoke test logged `audit_write_failed: relation "mcp_audit" does not exist` until migrate ran. (c) Smoke test clean: PRM 200, unauthenticated POST → 401 (`missing_token`), audit write lands. (d) Committed the entire working tree in two commits: Sprint 1 corrective pass + soak harness, then the Sprint 2 MCP stack. `*.code-workspace` added to `.gitignore` (IDE artifact).
**Decisions made:** `.env` claim-namespace fix confirmed as a **user paste step** — the file is ignore-protected and unreadable by the agent. Probe `--e2e` not attempted: it needs the client_id (never stored), an interactive Auth0 login, and the redeployed Action — all user-side.
**Surprises:** dev DB was behind on migrations (0002 as well as 0003) despite the soak having seeded it — seed doesn't migrate.
**Next action:** unchanged — user applies the two claim-name lines to `.env`, redeploys the Auth0 Action with `https://parentline.app/` namespaces, confirms it sits on the Login flow canvas, then `npm run serve` + `node spike/pl-101-as-probe/probe.mjs --tenant <as> --client-id <id> --e2e` for §6.3.

### Session 6 — namespace root cause, soak harness, E6 corrected
**Worked on:** PL-112 diagnosis, P3, artifact accuracy
**Done:** (a) Identified the claims root cause as **namespace validity**, not deployment: `https://parent-line/tenant_id` has a bare host with no TLD, which Auth0 will not accept as a custom-claim namespace, and it drops such claims with no error at authorize, at the token endpoint, or in tenant logs. Recorded in Failed Approaches and research.md §8. (b) Built the **soak harness** — `src/soak/soak-day.ts` + `src/soak/soak-log.ts`, `npm run soak:day`, appending one dated row to `soak/soak-log.md`; service/repository layer only (rule 11), tenant ids and counts only in output (no student identifiers), idempotent per date. First run: 12 calls, p50 1.35 ms, p95 4.91 ms, audit 100%, leakage clean — **not counted, 2026-09-20 is a Sunday.** (c) Corrected **E6 🟢 → 🟡** (Q2 closed, Q3 unanswered) and fixed the mojibake in that row. (d) Fixed `npm run serve/migrate/seed` to load `.env` via `tsx --env-file-if-exists` — previously they depended on ambient shell exports, which is why serve failed with `DATABASE_URL: Required` in a fresh terminal.
**Decisions made:** soak harness is TypeScript under `src/soak/` rather than the planned `scripts/soak-day.mjs`, so it imports the real service and repositories instead of duplicating queries in JS (rule 11 would otherwise be violated by a standalone script).
**Surprises:** the dev database was empty (`tenants=0`), so the first soak run failed on an audit FK before seeding — seeded, then clean. Also: no ASK CLI or AWS CLI on this machine, so the Q3 "30-minute CLI probe" cannot start without an install + interactive login.
**Next action:** see Current state — namespace fix first.

### Session 5 — PL-101 observed and closed

**Worked on:** PL-101
**Done:** User provisioned the Auth0 dev tenant (`dev-zzarw43qsuyf5lm5.us.auth0.com`); probe trail 2× REJECTED (`Client … not authorized to access resource server` — client↔API authorization, fixed via the API's Application Access tab) then **HONORED** — access token `aud` array carries `http://127.0.0.1:8420`. Recorded as research.md §8 (rev 10). §6.1 `.env` values defined (file hook-protected; user pastes). §6.2 confirmed live: PRM → Auth0 AS; AS metadata mirror → Auth0's real `/authorize` + `/oauth/token`; default-UA 401 with `WWW-Authenticate`, Alexa-UA 401 without. Probe gained `--e2e` (§6.3 initialize with the in-memory token) and `evidence.md` persistence.
**Decisions made:** namespaced custom claims (`https://parent-line/tenant_id`, `https://parent-line/role`) via a login Action reading user app_metadata — Auth0's collision-safe pattern; `TENANT_CLAIM`/`ROLE_CLAIM` config absorbs the names (→ research.md §8).
**Surprises:** the two rejections were diagnostic gold — Auth0 parses RFC 8707 `resource` and resolves it against its API registry; also `iss` carries a trailing slash and `aud` is an array.
**Next action:** PL-112 sequence (see Current state).

### Session 4 — PL-101 probe helper

**Worked on:** PL-101 enablement
**Done:** `spike/pl-101-as-probe/probe.mjs` (+ README) — zero-dependency helper automating the observation protocol's mechanics: PKCE, authorize URL (`resource`/`audience` modes), loopback code capture with state validation, token exchange, decode, verdict from `aud`, and the filled evidence block (token/code/verifier never printed; client_id redacted). Verified: `--smoke` all green (9 checks), and a full run against a local fake AS confirmed the exchange carries `resource` and the HONORED path emits the §7 template. research.md rev 9 amended.
**Decisions made:** none new — this is tooling for the existing protocol.
**Surprises:** none.
**Next action:** user provisions Auth0 tenant → one probe command → record evidence → PL-112 → `/evaluate`.

### Session 3 — Sprint 2 implementation

**Worked on:** P2, PL-101…PL-111, PL-113 (PL-112 remains blocked)

**Done:** P2 drill — weakened the `roster_entries` RLS policy locally, T-01 red (`expected 6 to be 3`), reverted byte-identical, gate re-run green; remote CI push deliberately not executed (red commit on main not justified for a local observation). Built the full MCP stack: `src/auth/` (verifier, identity, 401 shaping), `src/mcp/` (http host, per-session server factory, three tools, schema registry), `src/disclosure/policy.ts` (the AD-12 chokepoint), `src/repositories/mcp-audit.ts` + migration 0003, `src/main.ts` + `npm run serve`. Test infra: local AS (RSA + JWKS + token minting), fetch-based MCP client, full-stack harness. Dependencies: `@modelcontextprotocol/sdk@1.30.0`, `jose@6.2.12`. 49/49 T-numbers green, 214 cases, lint/typecheck/prettier clean.
**Decisions made:**

- **AD-20** AS-agnostic by construction — issuer/JWKS/audience/claim names config-driven; dev+tests run on a local test AS; PL-112 blocked on provisioning, not code (→ research §4)
- **AD-21** `mcp_audit` tenant_id is nullable-by-design — auth failures audit with NULL tenant (RLS permits); authenticated inserts derive tenant from the session variable, never a parameter (rule 7 hook caught the parameter — fixed to `current_setting` pattern)
- **AD-22** unsupported protocol version → typed JSON-RPC error before the SDK's silent downgrade to LATEST (T-46)
- **AD-23** `search_roster` refuses on stale/failed roster — consistent with the lookup's staleness guard; yesterday's list presented as today's is a wrong answer (AD-7)
- **AD-24** 401 branch signal is User-Agent (`alexa` substring / `x-amzn-alexa-client`) — fires pre-initialize so no MCP client info exists; spoofable but only shapes the discovery hint, never the token check
- **AD-25** dev defaults + production guard for auth config (mirrors APP_DATABASE_URL pattern) — seed/migrate/tests work unconfigured; production refuses to boot on placeholder identity
  **Surprises:**
- The SDK's default for an unsupported protocol version is a silent negotiation down to its LATEST — exactly the "connection that silently does nothing" shape T-46 targets; had to gate before dispatch
- SDK type declarations are incompatible with `exactOptionalPropertyTypes` (server.connect) — one documented cast, not sprinkled
- The SDK requires clients to Accept both `application/json` and `text/event-stream` even in JSON-only mode — caught by the raw-fetch test client, not the SDK client
- SDK's `server.close()` after initialize kills the session transport — removed; sessions live until DELETE/sweep
  **Next action:** provision AS tenant (Juan) → PL-101 observation → record in research §Spike Results → PL-112 → `/evaluate`.

### Session 2 — Remote transport committed; transport gaps closed

**Worked on:** research (rev 7), plan.md (PL-113), test.md (T-46…T-49)
**Done:** Reviewed Sprint 2 against the remote Streamable HTTP requirements and found four transport-layer gaps. Added PL-113 and T-46…T-49. Task count 12 → 13; tests 45 → 49.
**Decisions made:**

- **AD-19** — **remote deployment is the path; stdio rejected.** A stdio server never opens a port, so Alexa+ has nothing to connect to (the same disqualifier as `alexa-mcp`, §2a). A local-first staff tool was weighed and declined: it defers auth work but reaches neither Alexa+ nor a second campus, and the transport boundary has to be crossed regardless.
- **AD-18** — the token identifies the caller; `Mcp-Session-Id` identifies the connection. Tenant and role resolve from token claims on every request, never cached against a session id. Now hard-fail 13.
  **Gaps found and closed:**
- `Mcp-Session-Id` handling was entirely absent — it is the transport's state mechanism, and treating it as identity turns a leaked id into tenant impersonation (T-47)
- PL-102's AC was "MCP Inspector completes the handshake" — a manual check. Protocol version negotiation was unasserted; a mismatch with Alexa+ would present as a connection that silently does nothing (T-46)
- Streaming posture was implicit. Streamable HTTP permits an SSE upgrade and a standalone `GET`; an unhandled `GET` hangs, and a hang inside 500 ms is a dead conversation (PL-113, T-49)
- T-41 measured only the warm JWKS path. The cold path — first request after deploy or key rotation — is the realistic worst case and the one that blows the budget (T-48)
- Also added: `Origin` rejection for DNS rebinding, and an explicit TLS-termination posture (if a proxy terminates, T-30's `X-Forwarded-*` handling becomes load-bearing rather than defensive)
  **Surprises:**
- Every one of these gaps is remote-transport-specific. Had stdio-first won, four of five would have evaporated — which is a useful check that the fork decision was load-bearing, not cosmetic.
  **Next action:** unchanged — P1, P2, start the soak, then PL-101.

### Session 1 — MCP Add-on Design Guide review

**Worked on:** research (rev 6, §2g), plan.md, test.md
**Done:** Reviewed the design guide's Conversation Surface and Tools/Schema/Data Design pages. Added AD-15/16/17, §3g, leak vectors 10–12, tests T-43…T-45, hard-fail conditions 11–12.
**Confirmed, not changed:** the guide states AD-2 verbatim ("you influence Alexa's response through the data you return, not by scripting it directly") and prescribes our typed-refusal model ("always return an error response" — a tool returning nothing is the most common source of poor responses).
**Decisions made:**

- **AD-15** declare only what you honor — every schema parameter implemented, no undeclared output fields. Hits PL-108's filters hardest.
- **AD-16** tool descriptions reach the customer and the voice layer — they are copy, not documentation.
- **AD-17** disclosure is permanent for the session — returned data enters Alexa's context and may be restated in a later turn with no new tool call. Minimum field set per tool.
  **Surprises:**
- **We cannot un-disclose.** Alexa re-surfaces earlier task state after interruptions and topic shifts. A field returned to one listener can be spoken again later, possibly to a different person at the device. This sharpens Sprint 3's tiering problem: an elevated tier that discloses a reason cannot de-elevate, because the reason is already in context.
- T-34 and AD-15 look contradictory. They aren't: declared-and-ignored is a bug; undeclared-and-rejected is a defense. `tenant_id` is never declared.
- Certification docs (Functional Requirements / "MCP Tool Validation", Policy Requirements) not yet read — may impose hard schema rules. Sprint 3, before Alexa+ deployment.
  **Next action:** unchanged — P1, P2, start the soak, then PL-101.

### Session 0 — Sprint 2 opened

**Done:** Harness written — research.md rev 5 (Sprint 1 findings compacted, §2f added, AD-12/13/14, leak vectors 8–10), plan.md with Sprint Contract, test.md T-24…T-42, this file.
**Decisions made:**

- **AD-12** disclosure is default-deny at a single chokepoint; new fields are `never` until cleared
- **AD-13** omit a field rather than returning a false value for it
- **AD-14** exit criteria graded separately from the rubric
- Sprint 2 is staff-client only; parent verification and tiering deferred to Sprint 3 (Q6 open, Alexa+ lacks Step-Up)
- 3 weeks, not 2 — planning to Sprint 1's observed rate
- 🔵 status introduced for code-complete-but-unverified
  **Surprises:**
- The spike gate checks for the _existence_ of a "## Spike Results" section, not per-marker resolution. PL-013's section already exists, so Sprint 2's new SPIKE markers will not block planning. Noted in research.md §2f; consider tightening the hook.
  **Next action:** P1, P2, start the soak, then PL-101.

---

## Decisions made mid-sprint

_Anything settled here must also land in `research/research.md` §4 **the same session**. This table is the changelog; research.md is the source of truth._

| Session | Decision                                                       | Why                                                                                                 | In research.md |
| ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------- |
| S0      | AD-12 default-deny disclosure                                  | Handlers remembering to omit is how disclosure drifts                                               | ✅ §4          |
| S0      | AD-13 omit rather than falsify                                 | A false `hold_source` is a wrong answer about a student record                                      | ✅ §4          |
| S0      | AD-14 exit criteria graded separately                          | Sprint 1's evaluation satisfied criteria with rubric evidence                                       | ✅ §4          |
| S1      | AD-15 declare only what you honor                              | The model trusts the schema; an ignored parameter generates confident wrong answers                 | ✅ §4          |
| S1      | AD-16 tool descriptions are customer-facing                    | They reach the customer and the voice layer, not just our selection logic                           | ✅ §4          |
| S1      | AD-17 disclosure is permanent for the session                  | Alexa restates returned data across turns with no new tool call                                     | ✅ §4          |
| S2      | AD-18 token identifies the caller, session id the connection   | A session id trusted as identity makes a replay into tenant impersonation                           | ✅ §4          |
| S2      | AD-19 remote deployment; stdio rejected                        | stdio never opens a port — Alexa+ cannot reach it, nor can a second campus                          | ✅ §4          |
| S3      | AD-20 AS-agnostic by construction; local test AS for dev/tests | The validation chain is standard resource-server behavior; PL-112 blocked on provisioning, not code | ✅ §4          |
| S3      | AD-21 mcp_audit tenant_id nullable-by-design                   | Auth failures happen before tenant context exists; NULL-tenant rows carry no student data           | ✅ §4          |
| S3      | AD-22 unsupported protocol version → typed rejection           | The SDK silently negotiates down to LATEST — the exact "silently does nothing" shape                | ✅ §4          |
| S3      | AD-23 search_roster refuses on stale roster                    | Yesterday's list presented as today's is a wrong answer (AD-7)                                      | ✅ §4          |
| S3      | AD-24 401 branch signal = User-Agent heuristic                 | Fires pre-initialize; spoofable, but only shapes the discovery hint — never the token check         | ✅ §4          |
| S3      | AD-25 auth config: dev defaults, production guard              | seed/migrate/tests unconfigured; production refuses placeholder identity                            | ✅ §4          |

---

## Deferred to a later sprint

_Real but out of scope. Capture, don't build._ Items that are simply _next_ belong in Next action, not here.

| Item                                                                                                                                                                                                                                           | Surfaced | Target                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- |
| Parent verification method + elevated tier (`verify_contact`) — Alexa+ lacks Step-Up, so tiering lives in our session state. **AD-17 sharpens this: an elevated tier cannot de-elevate, because disclosed data is already in Alexa's context** | S0, S1   | Sprint 3 (needs Q6)                |
| Read certification docs: Functional Requirements ("MCP Tool Validation"), Policy Requirements, Display Modes                                                                                                                                   | S1       | Sprint 3, before Alexa+ deployment |
| MCP Apps: display the hold reason rather than speaking it                                                                                                                                                                                      | S0       | Sprint 3 (needs Echo Show)         |
| Tighten the spike gate to match markers to resolutions rather than checking for a section                                                                                                                                                      | S0       | Harness maintenance                |
| Does eSD expose an API that supersedes the Sheets connector?                                                                                                                                                                                   | Sprint 1 | Sprint 3 research                  |

---

## Definition of sprint complete

Not a second scoreboard — this is the exit-criteria table plus process obligations.

- [ ] All six exit criteria met (E1–E6, table above)
- [ ] All 13 tasks ✅ (not 🔵)
- [ ] T-01…T-49 written and passing
- [ ] Zero hard-fail conditions triggered
- [ ] Evaluator produced at least one finding, or stated one was sought and not found
- [ ] Evaluator confirmed the phase file was set to `evaluation`
- [ ] research.md updated with everything learned; decisions table reconciled
- [ ] Sprint 3 scope drafted
