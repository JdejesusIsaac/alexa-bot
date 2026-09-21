# progress.md — Sprint 4

> **Agent: update this file at the end of every working session.**

> **STATUS: DRAFT.** Drafted 2026-09-20 during Sprint 3, after AD-43 restructured the gates and returned Alexa+ to the roadmap. **Sprint 3 has not run.** Session 0 is a drafting session, not a working session.

**Sprint:** 5 — The Alexa+ Channel
**Started:** not started
**Status:** ⬜ Draft harness. One known defect blocking the handshake (F-20), no build gates.

---

## Current state

**Next action (pre-sprint):** nothing blocking, but two things are worth doing early because they cost little and de-risk a lot.

1. **Install the Alexa AI CLI and authenticate** — Node 24+, `alexa-ai configure`. This closes Sprint 2's Q3, which sat blocked for weeks on the wrong binary (the ASK CLI, which is not the tool).
2. **Fix F-20 whenever convenient.** `resolveIdentity` rejects a tenant-less token, so Alexa+ would 401 at `initialize` today. It is a small, well-understood change (AD-44) and it is the only thing standing between the existing server and a working handshake. It does not have to wait for Sprint 4 — but the **spike must still run**, because the permitted-method list has to be observed rather than read from a docs table.

**Blocked on:** Sprint 3 closure. Precondition T-3 (a tenant opting into this channel) for the pilot only.

**Not blocked on:** Amazon's unpublished security policy. Per AD-43 that is a disclosure in the assessment packet, not a gate on building or dev-stage testing.

**Cold-start gotchas (carried):** vitest does not load `.env` — export `DATABASE_URL`/`APP_DATABASE_URL`; do not `source .env`. Auth0 claim namespaces must be valid URLs with a TLD. **New:** the Alexa AI CLI needs Node 24+; the repo runs Node 20+, so check the version before assuming an install failure is something else.

---

## Exit criteria

| #   | Criterion                                                                        | Status                  |
| --- | ---------------------------------------------------------------------------------- | ------------------------- |
| E1  | A staff day on a physical Echo with no wrong answer                              | ⬜ PL-307               |
| E2  | The Alexa+ handshake completes (service and user level)                          | ⬜ **blocked by F-20**  |
| E3  | No service-level token reaches a tool handler or a tenant context                | ⬜ T-75, T-76           |
| E4  | Nothing outside the spoken tier is voiced, across interruptions                  | ⬜ T-79, T-80          |
| E5  | Real-path p95 ≤500 ms, recorded warm and cold                                    | ⬜ **never measured**   |
| E6  | Zero real student data in the simulator, on the device, or in a vendor console    | ⬜ T-83                |

---

## Failed Approaches

> **Read before writing any code.** Max 10 lines. Survives context resets and sprint restarts.

- Evaluator mischaracterized T-18's assertion — verify against source, never against a report's characterization
- Marking a task ✅ when code is written rather than when the AC is met — use 🔵
- Zod `.nullable()` without `.default(null)` still requires the key present
- RLS `WITH CHECK` rejects INSERT omitting `tenant_id`
- `exactOptionalPropertyTypes` rejects the JWT object form — positional overload required
- Auth0 silently drops custom claims whose namespace is not a valid URL — no error anywhere; ~2h across 6 probe runs
- `source .env` crashes on multi-line `GOOGLE_SERVICE_ACCOUNT_JSON`
- **Verifying an external integration by documentation rather than observation** (PL-101). Applies to PL-301: read our own `mcp_audit` rows for which methods Alexa+ calls with which token
- **Auditing inside the handler when the rejection happens pre-dispatch** (Sprint 2 F-1) → AD-42
- **A test that cannot fail its own pass condition** (Sprint 2 F-2). State which AC clause each test can fail on
- **Chasing the wrong binary.** Q3 sat blocked on installing the ASK CLI. The tool is the **Alexa AI CLI** (`alexa-ai`). Weeks lost to a question that was never asked of the docs

---

## Task board

| ID     | Task                                | Status | Notes                                                                 |
| ------ | ----------------------------------- | ------ | ----------------------------------------------------------------------- |
| PL-301 | Service-scope handshake `SPIKE` + fix | ⬜   | **The sprint's real work.** Without it there is no handshake          |
| PL-302 | Manifest + dev-stage deploy         | ⬜     | `alexa-ai deploy`, not `submit`. No store listing needed (F-23)       |
| PL-303 | Spoken tier                         | ⬜     | New control. A second projection, never a prompt instruction          |
| PL-304 | Alexa+ conversational surface       | ⬜     | Refusals must sound like speech                                       |
| PL-305 | Real-path latency                   | ⬜     | First honest measurement of a budget cited since Sprint 2             |
| PL-306 | Simulator + device testing          | ⬜     | Synthetic fixtures, including in the vendor console                   |
| PL-307 | Campus pilot                        | ⬜     | One opted-in campus, staff-facing, Echo in the main office            |
| PL-308 | MCP Apps display                    | ⬜     | **STRETCH — cut first.** Needs an Echo Show                           |

---

## Test status

T-01…T-73 carried. Sprint 4 adds T-74…T-83.

| Group                        | Written | Passing |
| ---------------------------- | ------- | ------- |
| T-01…T-73 (carried)          | 73      | —       |
| T-74…T-76 service-scope auth | 0       | 0       |
| T-77…T-78 integration        | 0       | 0       |
| T-79…T-80 spoken tier       | 0       | 0       |
| T-81…T-83 perf + integrity | 0       | 0       |

---

## Session log

### Session 0 — Sprint 4 drafted (during Sprint 3)

**Context:** AD-43 restructured the gates — customer adoption decisions became tenant provisioning preconditions rather than engineering blockers, and AD-33 was amended so Alexa+ returns as a channel rather than staying descoped.

**Done:** Re-observed the Alexa+ docs against live pages rather than Sprint 2's notes. F-20…F-26, §3w…§3aa, AD-44…AD-47 draft, leak vectors 23–27, T-74…T-83.

**Decisions drafted (none settled):** AD-44 service tokens resolve to a service identity, never a tenant · AD-45 tool schemas freeze at publication · AD-46 the spoken tier is narrower than the returned tier · AD-47 Alexa+ ships staff-facing first.

**Surprises:**

- **F-20 — the add-on could not connect today.** `resolveIdentity` requires a tenant-claim UUID on every request; Alexa+ calls `initialize` and `tools/list` with a `client_credentials` token that has no user and therefore no tenant. The handshake would 401 and never complete. Invisible until integration, and found by reading the auth docs rather than the transport docs.
- **Sprint 2's discipline is why this sprint is two weeks.** Every published requirement was already met — transport, OAuth, PKCE, `resource`, PRM, the 401 branch, the latency target. AD-8 said building to an unusable spec was cheaper than retrofitting. This is the return.
- **Q3 was blocked on the wrong binary for weeks.** It is the Alexa AI CLI, not the ASK CLI. Nobody asked the docs which tool it was.
- **A development stage exists that is not the store** (F-23). Full simulator and device testing with no listing, no certification, no `distributionCountries`. The old distribution gate was narrower than it looked.
- **AD-33 was doing two jobs.** A sound design judgment (verification is harder on a shared device) and a roadmap exclusion driven by an unanswerable vendor gate. Separating them is what let the channel come back without discarding the reasoning — AD-8 resolves it: staff-facing first.
- **The 500 ms budget has been cited for four sprints and never measured on the real path.** Sprint 2's 2.4 ms was local Postgres with six rows and no network.

**Next action:** install the CLI; fix F-20 when convenient; run the spike at sprint open.

---

## Decisions made mid-sprint

| Session | Decision            | Why                                              | In research.md |
| ------- | --------------------- | -------------------------------------------------- | -------------- |
| S0      | AD-44…AD-47 drafted | Sprint 4 scope draft after the AD-43 restructure | ⬜ draft only  |

**Promote AD-44…AD-47 at Sprint 4 open**, after PL-301 reports. AD-44's permitted-method list in particular is provisional until observed.

---

## Deferred

| Item                                      | Surfaced | Target                        |
| ----------------------------------------- | -------- | ----------------------------- |
| Parent tier on Alexa+                     | S0       | **Sprint 4**                  |
| Store certification and listing (F-24)    | S0       | Sprint 5, or never for one tenant |
| MCP Apps display                          | Sprint 2 | Stretch here, else Sprint 5   |
| Spanish on the Alexa+ channel             | S0       | Sprint 5                      |
| Leadership appointments; document delivery | Sprint 3 | Sprint 5                      |
| Multi-campus rollout                      | Sprint 4 | After one campus holds        |
| **Operational readiness: runbook, on-call, failure playbook** | Sprint 4 | **Unscoped and overdue — five sprints of features, no operations** |

---

## Definition of sprint complete

- [ ] All six exit criteria met (E1–E6)
- [ ] All 7 tasks ✅ (PL-308 stretch may be cut)
- [ ] T-01…T-83 written and passing
- [ ] Zero hard-fail conditions triggered
- [ ] Evaluator produced a finding, or stated one was sought and not found
- [ ] AD-44…AD-47 promoted into `research/research.md` §4
- [ ] Real-path p95 recorded with conditions
- [ ] Assessment packet updated with the current Amazon policy status
- [ ] Sprint 5 scope drafted