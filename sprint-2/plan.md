# plan.md — Sprint 2: The MCP Server (Staff)

**Sprint goal**

> Expose the Sprint 1 core as a remote MCP server a staff member uses from Claude Desktop — Streamable HTTP, OAuth 2.1 with PKCE, tenant and role from the token, disclosure enforced by projection. Built to Alexa+ requirements from the first commit; **not deployed to Alexa+ this sprint.**

**Duration:** 3 weeks. Sprint 1 planned 2 and ran 19 sessions — planning to the observed rate.

---

## Exit criteria

Graded **separately from the rubric** (AD-14). Rubric evidence may not satisfy an exit criterion, and a criterion requiring a measurement is unmet until the number is recorded.

| #   | Criterion                                                                                                                  | Met by                 |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| E1  | A staff member completes a full day of real questions from Claude Desktop with no wrong answer                             | Observation, not tests |
| E2  | Zero cross-tenant leakage through the MCP surface, including forged arguments                                              | T-33…T-35, T-42        |
| E3  | p95 **full round trip** (auth + tool + response) ≤300 ms, **number recorded** — warm **and** cold JWKS reported separately | T-41, T-48             |
| E4  | No tool schema accepts a tenant parameter; no tool returns an uncleared field                                              | T-33, T-36             |
| E5  | Every MCP call audited, actor from the token                                                                               | T-40                   |
| E6  | PL-013 Q2 closed in writing; **Q3 descoped under AD-33** (private distribution is a Sprint 3 decision)                      | PL-101                 |

---

## Prerequisites

| #   | Item                                                                                                                                                                        | Blocks                | Runs in parallel?      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------- |
| P1  | Sprint 1 evaluation re-issued: exit criteria restored, verdict downgraded to "Rubric PASS, Sprint not complete," redaction gap filed as a finding, phase file confirmed set | Sprint 1 closure      | —                      |
| P2  | CI gate observed failing: break T-01, confirm CI reds, revert                                                                                                               | Sprint 1 closure      | —                      |
| P3  | **Soak: 10 business days**                                                                                                                                                  | Sprint 1 closure only | **Yes — start it now** |
| P4  | **An AS verified to support RFC 8707 `resource`**                                                                                                                           | PL-102 onward         | No — this is PL-101    |

**The soak does not block Sprint 2.** It is monitoring; it runs alongside development. Sprint 1 _closes_ when it completes, but waiting two idle weeks for it would be a scheduling error. P1 and P2 are a day's work and should land first.

---

## Why this scope

**Staff client only.** Per AD-8, the staff surface ships first because it exercises the whole stack — auth, tenancy, tools, disclosure, audit — against users who can see a wrong answer and say so. Every bug found here is one a parent never hears.

That defers work honestly rather than half-building it:

- **No parent verification, no elevated tier.** Everyone on Claude Desktop is staff. Tiering exists because Alexa+ lacks Step-Up (§3c); that problem arrives with the parent client, and Q6 is open. Building now means building blind.
- **No Alexa+ deployment.** Gates 1 and 3 unresolved. Building _to_ the requirements costs nothing; deploying against unpublished policy is not our decision to make.
- **No MCP Apps, appointments, or document email.** Additive once the read path is proven.

**Auth is this sprint's risk.** It's the first network-exposed component holding student records. Sprint 1's isolation was enforced by Postgres; Sprint 2's is enforced by token validation, and a mistake there fails differently.

---

## In scope

MCP server over Streamable HTTP · OAuth 2.1 resource server (JWKS, issuer, expiry, **audience**, `resource`) · PRM + AS metadata discovery · client-conditional 401 (AD-10) · token → tenant + role · three staff tools · default-deny disclosure policy (AD-12) · MCP audit + tracing · tool schema version registry · **schema-honesty audit (AD-15)** · **minimum field sets (AD-17)** · **session lifecycle, Origin validation, streaming posture** · Claude Desktop end to end

## Out of scope

Alexa+ deployment · parent verification · elevated tier · MCP Apps · appointment booking · document email · Spanish · onboarding UI · academic redo ingestion (Q8)

> Out of scope means **do not scaffold it "for later."**

---

## Task status convention

Sprint 1 marked tasks ✅ when the code was written, not when the AC was met — PL-005 shipped ✅ with an untestable acceptance criterion. Sprint 2 uses four states:

| State | Meaning                                                          |
| ----- | ---------------------------------------------------------------- |
| ⬜    | Not started                                                      |
| 🟡    | In progress                                                      |
| 🔵    | **Code-complete, AC not yet verified** (blocked on a dependency) |
| ✅    | AC met and verified                                              |

**🔵 is not ✅.** A task blocked on credentials or an external dependency stays 🔵.

---

## Tasks

### PL-101 — Authorization server selection [P1]

Close PL-013 Q2 and Q3. Evaluate Cognito, Auth0, Okta against **one criterion first**: does it emit and honor RFC 8707 `resource` in _both_ the authorization and token request? Auth0 has historically used `audience` instead — **verify by observation, not documentation.** Then PKCE S256, static client registration, JWKS rotation.
Provision a dev tenant. Register two clients: Claude Desktop, and an Alexa+ placeholder.
**AC:** written finding in research.md "## Spike Results". An AS chosen with `resource` behavior **demonstrated**. Q3 answered.
**A "none of them support it" outcome is a valid result** — escalate immediately; it reshapes the architecture.

### PL-102 — MCP server skeleton [PL-101]

Streamable HTTP, spec 2025-11-25. `initialize` → `notifications/initialized` → `tools/list` → `tools/call`. Do not implement legacy HTTP+SSE.
**AC:** T-46 passes — the handshake is asserted by test, not by a manual Inspector run. Protocol version negotiation and capability declaration are explicit; a version mismatch fails loudly rather than producing a connection that silently does nothing.

### PL-103 — OAuth resource server [PL-102]

Validate every bearer token: JWKS signature, issuer, expiry, **audience**. Verify `resource` binding. Header only — **reject tokens in the query string**. Cache JWKS.
**AC:** T-24…T-29 pass. Each rejection reason distinct and logged; no token contents in logs.

### PL-104 — Discovery + client-conditional 401 [PL-103]

PRM at the well-known URI (RFC 9728); `/.well-known/oauth-authorization-server` advertising `code_challenge_methods_supported` including `S256`. Ignore `X-Forwarded-*` when building metadata URLs.
Implement AD-10's per-client branch. **Determine and document the signal** — it fires before `initialize`, so client info is unavailable and User-Agent may be the only option. Record the fragility in research.md.
**AC:** T-30…T-32 pass. Both client shapes discover successfully.

### PL-105 — Token → tenant + role [PL-103]

Resolve `tenant_id` and role (`staff` / `admin`) from token claims, then enter `withTenant`. **No handler receives a tenant argument; a tenant value in a tool payload is ignored, not honored.**
**Session binding:** Streamable HTTP issues an `Mcp-Session-Id` on `initialize` which the client returns on subsequent requests. **Tenant and role are resolved from the token on every request, never cached against the session id.** The session id identifies a connection; the token identifies the caller. Conflating them makes a stolen or replayed session id into a tenant impersonation (AD-18).
**AC:** T-33…T-35 and T-47 pass, including the forged-argument and cross-tenant replay cases.

### PL-106 — Disclosure policy layer [PL-105]

Per AD-12: one chokepoint mapping every canonical field to `staff` / `admin` / `never`. Responses built by projection. New fields default to `never`.
Per AD-13: **omit a field rather than returning a false value.**
Per **AD-17**: clearance alone is insufficient — a cleared field still has to _earn its place_. Define a **minimum field set** per tool: the fewest fields that answer the question. Anything returned persists in Alexa's session context and can be restated later to whoever is standing there.
**AC:** T-36…T-38 and **T-45** pass. An uncleared new field is absent from responses, and each tool's response carries no field beyond its declared minimum set.

### PL-107 — Tool: `lookup_scholar_status` [PL-106]

Wraps `getScholarStatus`. Args: `student_ref` or `student_name`. No tenant.
Write the description as **customer-facing copy** (AD-16) — it reaches the model, the customer, and the voice layer, not just our selection logic. No campus names, no student-data examples, no internal jargon.
State when to call it, why, and what it returns. Keep it **deliberately disjoint from `search_roster`** — the guide warns that overlapping tools cause wrong-tool selection and unnecessary parallel calls, and these two are adjacent.
**AC:** T-39 and T-44 pass. All four Sprint 1 refusals surface distinctly, each as a returned error response — never an empty result (the guide's "always return something").

### PL-108 — Tool: `search_roster` [PL-106]

Today's roster filtered by section, hold type, or status. Paginated, capped. Staff role.
**AD-15 applies most sharply here.** Every filter in the schema must be implemented. A declared-but-ignored filter makes the model confidently assert a narrowing that never happened — "here are the three scholars in 304" when it never filtered by section. **If a filter isn't built, it isn't in the schema.**
**AC:** T-43 passes. Tenant-scoped; empty result distinguishable from failed query; description disjoint from `lookup_scholar_status`.

### PL-109 — Tool: `roster_sync_status` [PL-106]

Last sync, quarantined counts with reasons, staleness. **Admin only.**
**AC:** a `staff` token gets an authorization refusal, not an empty result.

### PL-110 — MCP audit + observability [PL-105]

Audit: actor from token subject, tool name, tenant-safe arguments, outcome. Traces with `tenant_id`, request id, per-stage latency (auth / tool / total).
**Includes the Sprint 1 carry-over:** production redaction must not depend on hardcoded name lists (leak vector 10).
**AC:** T-40 passes, including a production-shaped name absent from the fixture list.

### PL-111 — Tool schema version registry [PL-102]

Per AD-9, Alexa+ caches definitions until redeploy. Version the schema set, changelog each change, expose the version in `initialize`.
**AC:** a schema change without a version bump fails CI.

### PL-113 — Transport hardening & connection lifecycle [PL-102, PL-103]

The remote-transport concerns that only exist because we're deploying a reachable server.

- **Session lifecycle:** issue `Mcp-Session-Id` on `initialize`; require it thereafter; define expiry; define behavior when a session is unknown or expired (a typed error, never a silent new session).
- **Streaming posture:** Streamable HTTP permits a single JSON response _or_ an SSE upgrade, and clients may open a standalone `GET` for server-initiated messages. **Decide explicitly** — for three fast read tools, request/response is almost certainly right. Document the decision and make a client's `GET` receive a clean, immediate, documented response. A hang inside Alexa+'s 500 ms budget is a dead conversation.
- **Origin validation:** reject requests with an unexpected `Origin`. DNS-rebinding protection matters the moment a real port is bound.
- **TLS termination:** specify where it terminates. If at a proxy, the `X-Forwarded-*` handling in T-30 becomes load-bearing rather than defensive — say so in the runbook.
- **Cold JWKS:** the first request after deploy or key rotation fetches JWKS over the network. That is the realistic worst case, not the warm path.

**AC:** T-46…T-49 pass. The streaming decision is recorded in research.md with its reasoning.

### PL-112 — Claude Desktop end to end [PL-107…PL-110, PL-113]

Real client, full OAuth, a day of realistic staff questions.
**AC:** E1 and E3. Record the actual p95 with its conditions.

---

## Sequencing

```
P1 ─→ PL-101 ─→ PL-102 ─→ PL-103 ─┬→ PL-104
        (gate)      │             ├→ PL-105 ─→ PL-106 ─┬→ PL-107 ─┐
                    ├→ PL-111     └→ PL-110            ├→ PL-108 ─┼→ PL-112
                    └→ PL-113 ────────────────────────→ └→ PL-109 ─┘
P3 soak ───────────────────────── runs in parallel throughout ─────────────
```

**Week 1:** PL-101 (do not proceed past it), PL-102, PL-103.
**Week 2:** PL-104, PL-105, PL-106, PL-110, PL-111, PL-113.
**Week 3:** PL-107–109, PL-112, harden.

**If PL-101 returns "no AS supports RFC 8707," stop and re-plan.**

---

## Sprint Contract

### Rubric

| Category            | Weight  |
| ------------------- | ------- |
| **Auth & Security** | **50%** |
| Functionality       | 30%     |
| Design              | 10%     |
| Originality         | 10%     |

Pass threshold ≥90% weighted, **and** zero hard-fails, **and** the isolation gate green.

### Hard-fail conditions — any one fails the sprint

1. Any of T-01…T-05 or T-33…T-35 failing or unwritten
2. A tool schema accepting a tenant parameter, or a forged tenant argument honored
3. A token accepted without audience validation
4. A bearer token accepted from the query string
5. Advisor-notes content reachable through any tool response or log
6. A derived hold presented as authoritative on any path
7. A tool returning a field not explicitly cleared
8. Any failure path returning an empty success
9. An LLM call inside a tool's request path
10. Real student data in the repo or its history
11. **A declared tool parameter that is not implemented** (AD-15) — the model trusts the schema
12. **Sensitive content in a tool description or `structuredContent`** (AD-16)
13. **Tenant or role resolved from the session id rather than the token** (AD-18)

### Evaluator requirements

Sprint 1's evaluation returned 100/100 twice, dropped the exit-criteria table on re-issue rather than correcting it, and argued away two real weakest points. These are contract terms now:

- **Set `.windsurf/state/phase` to `evaluation` before starting.** Unset, the isolation hook is inert and independence is nominal. **State in the report that it was set.**
- **Grade exit criteria in their own section, separately from the rubric** (AD-14). Omitting the section is not an alternative to grading it.
- A criterion requiring a measurement is unmet until the number is recorded. "Well under" is not a number.
- **Produce at least one finding, or state explicitly that one was sought and not found.** A weakest point identified and then argued away is a finding, not a footnote.
- Audit every tool schema against its implementation (AD-15). A declared parameter with no behavior is a finding, not a TODO.
- Run the adversarial pass including the two vectors Sprint 1 never tried: **timing/error-shape inference across tenants**, and **redaction against a name absent from the fixture list.**
- **Re-issue rule — written before the first verdict exists.** A planned second pass amends E1/E3/E6 only; the rubric is regraded only if code changed between runs. Two evaluations of the same build produce one scoreboard, not two that disagree.

---

## Risks

| Risk                                                                       | Mitigation                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **No AS supports RFC 8707 as required**                                    | PL-101 first; a "no" escalates in week 1, not week 3                                                      |
| AD-10's 401 signal is fragile (fires pre-`initialize`)                     | Document the mechanism and limits; test per client shape                                                  |
| Token passthrough accepted                                                 | Audience validation is a hard-fail, not a task detail                                                     |
| Disclosure drift as fields are added                                       | Default-deny (AD-12); T-36 enforces                                                                       |
| Latency consumed by auth                                                   | Per-stage timing; JWKS cached. Sprint 1's 2.4 ms was local, 6 rows, no network — not a headroom guarantee |
| Task board drifts to ✅ on code-complete                                   | The 🔵 state exists for exactly this                                                                      |
| Credentials block progress again                                           | P4 is a prerequisite, not a mid-sprint discovery                                                          |
| Scope pull toward Alexa+                                                   | Out-of-scope list is binding; Gates 1 and 3 unresolved                                                    |
| **A schema promise we don't keep**                                         | AD-15 is a hard-fail; T-43 enumerates every declared parameter against its implementation                 |
| **Over-returning fields that persist in session context**                  | Minimum field set per tool (AD-17); T-45                                                                  |
| `lookup_scholar_status` and `search_roster` overlap → wrong-tool selection | Deliberately disjoint descriptions; verify in PL-112 with realistic phrasings                             |
| **Session id treated as identity**                                         | AD-18 hard-fail; T-47 replays a session across tenants                                                    |
| **Cold JWKS blows the latency budget in production**                       | T-48 measures it; warm-path numbers alone are not a headroom claim                                        |
| **A standalone `GET` hangs the connection**                                | PL-113 makes the streaming posture an explicit, documented decision                                       |

---

## Dependencies outside the team

| Item                                         | Blocks                                   | Owner      |
| -------------------------------------------- | ---------------------------------------- | ---------- |
| AS account provisioning                      | PL-101                                   | Juan       |
| Google Sheets OAuth credentials + test sheet | Sprint 1 PL-005 (🔵 → ✅)                | Juan       |
| Amazon Alexa+ security & data policies       | Sprint 3                                 | Amazon     |
| Private distribution path (Q4)               | Sprint 3 planning                        | Amazon     |
| Academic redo ingestion (Q8)                 | The redo use case                        | Leadership |
| Tracker column proposal                      | Switching `hold_source` to authoritative | Leadership |

---

## Carried from the Sprint 1 review

- Failed Approaches maintained **in the session it happens**, not backfilled at the end.
- Mid-sprint decisions land in research.md §4 the same session, with the changelog filled.
- One scoreboard. Exit criteria and Definition of Sprint Complete must not be separate lists that can disagree.
- Measurements recorded with their conditions, not bare numbers.
