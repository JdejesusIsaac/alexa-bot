# research.md — Parent Line

> **Read this first, every session.** This file is the durable context for the project: what was investigated, what was decided, and what must not be re-litigated. If a decision here looks wrong, raise it — don't silently reverse it.

**Project:** Parent Line — voice-first parent support agent for a K-12 charter network
**Sprint 1 scope:** deterministic core only. No voice, no LLM, no MCP.
**Last updated:** Sprint 1, Day 1 — rev 5. **PL-013 spike closed 3 of 5 steps: the 401 divergence has no single-shape solution (AD-10). See Spike Results.**

---

## 1. What the product is

A parent asks a routine question ("where is my scholar?", "I need to see the vice principal", "send me his report card") and gets a verified, consistent answer without pulling a staff member off dismissal duty.

**The payload is student education records.** Every design decision is downstream of that fact.

---

## 2. Source review

### 2a. `serversmx/alexa-mcp` is NOT the spine (settled — rejected)

An **outbound control** MCP server (Claude → Echo: announcements, volume, routines) built on `alexa-remote2`.

| Finding | Consequence |
|---|---|
| Outbound only — no inbound path | A parent speaking to a device cannot reach us through it |
| stdio transport, never opens a port | Cannot serve multiple campuses |
| Auth = scraped Amazon session cookies | Fleet would depend on a staff member's personal Amazon login |
| Unofficial private Amazon API | Can break without notice; outside supported terms |
| "Multi-instance" = separate auth dirs | Not tenant isolation |

**Possible future role:** outbound staff announcements only. **Never student data.**

### 2b. Classic Alexa Skills Kit — viable, but no longer first choice

Custom skill + endpoint (Lambda/HTTPS), ~8-second response budget, account linking via OAuth 2.0. Still the fallback if the Alexa+ path proves unavailable to us. **Superseded as the primary plan by 2c.**

### 2c. ⭐ Alexa+ MCP Toolkit — THIS IS THE SPINE

*(Reviewed from Amazon's Alexa+ MCP QuickStart, doc last updated Jul 10 2026.)*

**Alexa+ acts as an MCP client and connects directly to a remote MCP server we host.** A parent speaks; Alexa+ handles ASR, NLU, model reasoning, and TTS; it calls *our* MCP tools. This is the inbound path that `alexa-mcp` lacked, and it is officially supported.

**The consequence: we build one MCP server, not a skill plus a separate staff tool.** Alexa+ is one client, Claude Desktop is another. Same server, same tools, same authorization.

#### Hard technical requirements (verified from the doc)

| Requirement | Detail |
|---|---|
| **Transport** | **Streamable HTTP** (MCP spec 2025-11-25). Legacy HTTP+SSE is deprecated — do not build on it. |
| **Reachability** | Remote HTTPS URL. `cloudflared` or similar tunnel for local dev. |
| **Latency** | **Round-trip query response under 500 ms.** |
| **Auth** | OAuth 2.1 authorization code flow with **PKCE (S256)**. |
| **Discovery** | `401 Unauthorized` **without** a `WWW-Authenticate` header for unauthenticated requests. |
| **Metadata** | Protected Resource Metadata document at the well-known URI (RFC 9728); auth server metadata at `/.well-known/oauth-authorization-server`. |
| **PKCE advertising** | `code_challenge_methods_supported` must be present and include `S256`. **Account linking will not proceed without it.** |
| **`resource` parameter** | Required in *both* the authorization request and the token request; set to our MCP server's canonical URI. |
| **Token usage** | Bearer token in the `Authorization` header on every request. **Never in the query string.** |
| **Visuals** | Optional, via the MCP Apps standard (`@modelcontextprotocol/ext-apps`). Text-only servers connect as-is. |

#### Explicitly NOT supported yet

Dynamic Client Registration (DCR) · Client ID Metadata Documents (CIMD) · OpenID Connect (OIDC) · **Step-Up Authorization** · `WWW-Authenticate` header in 401 responses

#### Onboarding mechanics

- CLI: `alexa-ai configure` → `alexa-ai new mcp` → `alexa-ai deploy` → `alexa-ai submit`. Credentials at `~/.alexa-ai/credentials`.
- Manifest: `addon-package/addon.json` — store listing, `examplePhrases` (3–4), privacy policy URL, terms of use URL, six icon sizes, ≥1 carousel image (600x900), and the MCP endpoint URI under `integrations[].config.endpoints.default.uri`.
- There is an **Add-on Agent Skill** that drives onboarding from Claude Code / Cursor / Kiro. Relevant to our Windsurf harness — it can scaffold the add-on once the server exists.
- **Alexa+ refreshes tool information only on deployment.** Changing a tool's schema or description in our server does nothing until we redeploy the add-on. Treat tool definitions as a versioned, deploy-gated interface.

### 2d. Reference implementations — what to actually copy

**Key reframe:** Amazon's overview states you can *"bring your existing MCP server built for other AI hosts."* **There is no such thing as an "Alexa+ MCP server."** It is a standard MCP server (spec 2025-11-25) over Streamable HTTP with OAuth 2.1, and Alexa+ is just another client. Amazon publishes **no sample server repo** — because the server isn't Amazon-specific.

So the right examples are spec-compliant, OAuth-protected MCP servers. Ranked:

| # | Repo | Why | Caveats |
|---|---|---|---|
| **1** | **`modelcontextprotocol/typescript-sdk` → `examples/server`** | Canonical. `simpleStreamableHttp.ts` runs with `--oauth` and `--oauth-strict` (strict Resource Identifier verification — maps directly to Alexa+'s required `resource` parameter, RFC 8707). Also ships a minimal OAuth resource-server example using `mcpAuthMetadataRouter` + `requireBearerAuth`, plus thin middleware packages for Express, Fastify, Hono, and raw Node http. | Examples, not a product. Take the patterns, not the structure. |
| **2** | **`tkodev/mcp-oauth-example`** | Minimal and exactly our shape: plays **resource server** only, delegating token issuance to an external OAuth 2.1 AS. Validates JWKS signature, issuer, expiry, **and audience** — audience validation is what blocks token passthrough. Ships `AGENTS.md`/`CLAUDE.md`. | Demo-grade: 9 commits, 0 stars, single author. Read it, don't depend on it. |
| **3** | **`github/github-mcp-server`** (`docs/streamable-http.md`) | The best *production* reference. Real PRM discovery, scope filtering to restrict tools by credential, and correct `--base-url` handling behind reverse proxies — it deliberately ignores `X-Forwarded-Host`/`X-Forwarded-Proto` so an untrusted client can't influence the advertised metadata URL. That last detail is a real vulnerability we'd otherwise ship. | Go, not TypeScript. Read for operational patterns. |
| 4 | `NapthaAI/http-oauth-mcp-server` | Express app wiring OAuth + Streamable HTTP. | Proxies to an upstream AS **requiring DCR** — which Alexa+ does not support. Limited applicability. |
| 5 | `n24q02m/mcp-core` | Claims 2025-11-25 transport + bundled OAuth AS. | Unvetted single-maintainer ecosystem. Do not take as a dependency. |

**Not relevant — same wrong category as §2a.** `GraysonCAdams/alexa-mcp` and `guitarbeat/Alexa-MCP-Server` are more `alexa-remote2` device-control servers (shopping lists, announcements, smart home) on scraped Amazon cookies. The name matches; the direction doesn't.

#### ⚠️ Gotcha: the 401 challenge diverges from every reference implementation

The MCP authorization spec — and all the examples above — return **401 *with* a `WWW-Authenticate` header** carrying the `resource_metadata` URL. That is the standard discovery path.

**Alexa+ requires 401 *without* `WWW-Authenticate`** and lists that header as "Not Supported Yet," relying on the well-known URI instead.

This is the one place we must knowingly deviate from the reference code. It also creates a **potential conflict with our second client**: Claude and other MCP clients treat `WWW-Authenticate` as the *preferred* discovery mechanism, with well-known URLs as fallback. Both paths should work for both clients if the PRM document is correct, but this needs an explicit test in Sprint 2 — one server, two clients, one 401 shape.

#### Authorization server choice

DCR is unsupported, so clients are pre-provisioned statically. Amazon's account-linking guidance notes that for **Auth0, AWS Cognito, and Okta**, enabling PKCE S256 is a single configuration toggle — and PKCE S256 is the whole practical difference between OAuth 2.0 and 2.1 here. **Recommendation: use a managed AS rather than writing one.** We are a resource server; token issuance is not our problem to solve, and a hand-rolled AS holding parent identity for student-record access is a liability.

#### Also confirmed

- **MCP Toolkit is US-only.** Fine for us.
- Alexa+ registers tools at deploy time; the `initialize` handshake is standard JSON-RPC 2.0.
- A **Local Inspector** and a **web simulator** exist for testing before device deployment.

### 2e. Source data — the HEMS attendance tracker (schema only)

Reviewed the live tracker's structure. **No student data recorded here or anywhere in this repo.**

**Shape:** Google Sheets workbook, one tracker tab plus per-grade roster "pull" tabs. The tracker `XLOOKUP`s against a pull tab keyed on student ID.

| Col | Header | Type | Notes for the connector |
|---|---|---|---|
| A | ID | number | Student ref. Join key against pull tabs. |
| B / C | First Name / Last Name | text | Split, not combined. |
| E | Homeroom | number | Maps to canonical `section`. |
| F | Advisor | text | Staff name. |
| G | Attendance | dropdown | `Absent`, `Tardy`, … |
| H | Uniform | dropdown | |
| I | **DO NOT CALL** | checkbox | **Contact-permission flag — see below.** |
| J | Advisor Notes | **free text** | **Never family-facing — see below.** |
| K | Time In (Ops Only) | time | |
| L | Reason (Ops/Leaders Only) | dropdown | `Unexcused`, `Excused W/O Notes`, … |
| M | Missing ID | checkbox | |
| N | Absence Count | **text** | Concatenated string (`ExAbs: n | UnExAbs: n`), not numeric. Parse or request a split. |

#### Findings that change the build

**F-1 — eSD is the system of record, not the spreadsheet.** Column J instructs staff to log contact *in eSD*, and roster data arrives via lookup against pull tabs. The tracker is a derived working layer. **This answers open question 4:** if eSD exposes an API, it is the better long-term source and the spreadsheet connector becomes a bridge, not the destination. Worth investigating before committing to Sheets permanently.

**F-2 — Academic redo has no source in this tracker.** Detention is derivable from existing fields (Tardy, Missing ID). Redo is not — it originates with teachers and never reaches this sheet. **Parent Line's headline use case currently has no data behind it.** Addressed by the column proposal; the ingestion route is a leadership decision.

**F-3 — Column J is a health-and-family-data landmine.** Free text, mandatory on absence, and in practice it accumulates medical detail, family circumstances, and staff impressions. **Column J must never be read by a tool, returned in a tool response, or spoken.** It is excluded at the connector, not filtered later. Structured reason codes (column L, plus the proposed Hold Type) are the only permitted source for anything family-facing.

**F-4 — `DO NOT CALL` is an existing contact-permission flag.** Column I already encodes a per-family communication restriction. Parent Line must honor it as a hard guardrail on any proactive contact, and it may signal custody or safety situations that also affect what may be disclosed on request. Treat as required input to the disclosure policy, not an optional field.

**F-5 — Free text is what happens without controlled vocabulary.** Column J is the empirical argument for making every new field a dropdown. Any column Parent Line reads must be a constrained enum.

---

## 3. What this changes — implications analysis

> §2c is quoted from Amazon's documentation. This section is *our* analysis of what it means for Parent Line. Treat it as reasoning to challenge, not fact.

### 3a. The 500 ms budget kills any model call inside a tool

This is far tighter than the ~8 s classic-skill budget and it settles a design question outright: **no LLM call may sit inside an MCP tool's request path.** A tool is a validated database read and nothing else.

This *vindicates* the Sprint 1 scope. The deterministic core we're building is not a stepping stone toward an LLM-backed lookup — it is the final architecture for the read path. Alexa+ supplies the language; we supply fast, correct facts.

Anything that can't finish in 500 ms (document assembly, calendar search) must return an immediate acknowledgment and complete asynchronously.

### 3b. We no longer control the model — so tool design is our *only* disclosure control

With classic ASK we owned the endpoint and could put Claude behind our own system prompt. With Alexa+, **Amazon's model decides which tool to call and with what arguments.** We cannot instruct it, constrain it with our own prompt, or audit its reasoning.

Therefore:

- **A tool must never return data the caller isn't cleared to hear.** Not "returns it with an instruction not to say it" — the model may say anything it receives. If verification hasn't passed, the reason code is simply absent from the response payload.
- **Tool descriptions are the only steering surface.** They must be precise about when each tool applies, because the model chooses on description alone.
- **`tenant_id` from the token is now non-negotiable** (AD-4). An external model is literally filling tool arguments. If tenant were an argument, cross-campus disclosure is one bad inference away.
- **Assume every returned field will be spoken aloud, in a lobby, immediately.** That's the design test for every tool response.

### 3c. No Step-Up Authorization breaks the planned verification tiering

We had planned: speak the status, but require a stronger check before disclosing the disciplinary reason. OAuth step-up is the natural mechanism and **it isn't supported.**

Workaround: handle tiering *inside our own tools* rather than at the auth layer. A `verify_contact` tool establishes an elevated state in our session store, and `lookup_scholar_status` returns the reason field only when that state exists. Our server tracks the tier; the OAuth layer only establishes baseline identity.

Cost: our own session state, our own expiry rules, our own replay protection. Needs design in Sprint 2.

### 3d. MCP Apps could solve the lobby-privacy problem

Optional visual rendering means an Echo Show could **display** the sensitive detail rather than speaking it. "Daniel is in redo until 4:30" spoken, reason shown on screen. That's a materially better privacy posture than our original email-the-reason fallback, and worth prototyping.

### 3e. Distribution is a store model — this is a real problem

`addon.json` includes `storeListing`, `distributionCountries`, carousel images, and certification via `alexa-ai submit`. This is a **consumer marketplace** shape. A school-network add-on handling student records does not obviously belong in a public store.

**Unresolved:** is there a private, org-scoped, or unlisted distribution path for Alexa+ add-ons? Until answered, we cannot commit to this as the production channel. Development stage is fine for building and testing.

### 3f. Amazon's security and data policies are not yet published

The QuickStart states security and data policy details "will be published in a future revision." **We cannot complete a FERPA assessment against a policy that doesn't exist yet.** This is now the single hardest gate on the voice path, ahead of everything else.

---

## 4. Architecture decisions

**AD-1 (revised) — One MCP server, multiple clients.** Alexa+ (parents) and Claude Desktop (staff) are both MCP clients against one remote server. *Previously "one core, two front doors"; the toolkit collapses this into a single interface.*

**AD-2 — Disclosure is enforced in tool return values, not in prompts.** Strengthened by §3b: we don't own the model, so a field we return is a field that may be spoken.

**AD-3 — Multi-tenancy: shared database, shared schema, `tenant_id` on every row, Postgres RLS forced.** Graduate to database-per-tenant only for a different legal entity, a residency requirement, or noisy-neighbor degradation.

**AD-4 — `tenant_id` is never a caller- or model-supplied argument.** Derived server-side from the OAuth token. *Now critical rather than merely important — see §3b.*

**AD-5 — Scheduled sheet sync, never a live read on the request path.** Reinforced by the 500 ms budget.

**AD-6 — Column mapping is explicit config, not inferred.**

**AD-7 — Degrade to human, never to a guess.**

**AD-8 (revised) — Ship the staff client first, on the Alexa+-compliant server.** We still expose to Claude Desktop before Alexa+, but the server must meet Alexa+ requirements (Streamable HTTP, OAuth 2.1 + PKCE, sub-500 ms) **from the first commit**. Retrofitting transport or auth later is a rewrite.

**AD-9 (new) — Tool definitions are a deploy-gated versioned interface.** Alexa+ caches tool info until redeploy. Changing a tool schema is a release event with a changelog, not a refactor.

**AD-10 (new) — The 401 response varies by client, deliberately.** Proven by PL-013: the MCP spec makes `WWW-Authenticate` on 401 a MUST, Alexa+ requires it absent, and no fixed response satisfies both. The auth layer branches. Collapsing it to one shape breaks a client. See Spike Results.

---

## 5. Stack (assumed — confirm before PL-001)

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript / Node 20+ | Team fluency; MCP SDK is first-class here |
| MCP | `@modelcontextprotocol/sdk`, **Streamable HTTP** | Required by Alexa+; SSE is deprecated |
| DB | PostgreSQL 15+ | RLS is the isolation mechanism |
| DB access | Drizzle + explicit SQL migrations | ORMs that hide session handling fight RLS |
| Validation | Zod | Schema at the boundary |
| Testing | Vitest + Testcontainers | RLS cannot be tested against a mock |
| Auth | OAuth 2.1 AS with PKCE/S256, static client registration | DCR unsupported — clients pre-provisioned |
| Scheduler | node-cron in-process (Sprint 1) | Move to a queue at the second campus |

> **Agent:** confirm before scaffolding. Changing the DB or access layer after PL-002 is expensive; changing transport or auth after Sprint 2 is worse.

---

## 6. Constraints and compliance

- **FERPA.** Roster data = education records. Disclosure limited to authorized contacts. Every read audited.
- **Gate 1 (hardest):** Amazon's Alexa+ security and data policies are unpublished (§3f). No FERPA assessment is possible until they exist. **Blocks the voice path.**
- **Gate 2:** whether student records may lawfully transit a consumer voice assistant at all, given utterance processing and retention. Network legal.
- **Gate 3:** private vs public add-on distribution (§3e).
- **None of these block Sprint 1**, which touches no voice and no Amazon surface.
- **No real student data in this repo. Ever.** Fixtures synthetic. No production dumps, no `.csv` in git.
- **Logs carry `tenant_id`, never student PII.**
- **Audit log is append-only** in code and in schema.

---

## 7. Known cross-tenant leak vectors

Each has a test in `evaluation/test.md`, named here so the claim is checkable rather than asserted.

| # | Vector | Test |
|---|---|---|
| 1 | A query written without a tenant filter | T-01, T-03 |
| 2 | Cache keys missing `tenant_id` | T-22 |
| 3 | Background jobs running without tenant context set | T-23 |
| 4 | A connection returned to the pool with `app.tenant_id` still set | T-04 |
| 5 | Logs or error traces echoing another tenant's rows | T-09 |
| 6 | **A tool returning a field the caller isn't cleared for** — the model will speak it (§3b) | Sprint 2 |
| 7 | **A tool accepting `tenant_id` as an argument** — an external model fills arguments (§3b) | Sprint 2 |

Vectors 2 and 3 had **no test** until the Sprint 1 structure audit; T-22 and T-23 were added to close them. Vector 3 is the live one — PL-007's scheduler is a background job that writes student data with no request to derive tenant from.

---

## 8. Open questions

1. **Is there a private / org-scoped distribution path for Alexa+ add-ons?** (§3e) Blocks production channel.
2. **When do Amazon's Alexa+ security and data policies publish?** (§3f) Blocks FERPA assessment.
3. Is Alexa+ available on the device classes and account types a school would deploy? Does Alexa Smart Properties intersect with the Alexa+ add-on model, or are they separate tracks?
4. ~~Where do rosters live?~~ **Answered (§2e):** Google Sheets tracker derived from **eSD**, the system of record. Follow-up: does eSD expose an API we can use instead?
5. Canonical `reason_code` list — network-standard set, or per campus? Existing enums: Attendance (`Absent`/`Tardy`/…), Reason (`Unexcused`/`Excused W/O Notes`/…). Proposed: Hold Type (`Academic Redo`/`Detention`/`Both`).
6. Verification method for the elevated tier (§3c)?
7. Who owns tenant provisioning — network ops or campus admins self-serving?
8. Audit retention period?
9. Which managed authorization server — Cognito, Auth0, or Okta? (§2d) Needed before Sprint 2 begins.
10. **How does academic redo reach the tracker?** (§2e F-2) Leadership decision; blocks the headline use case.
11. Does eSD expose an API? (§2e F-1) Could supersede the Sheets connector.

---

## Spike Results

### PL-013 — MCP transport + auth · partial, 3 of 5 steps closed

Walking skeleton in `spike/pl-013-mcp-auth/` (throwaway, no student data, no database). Plain `node:http` — no SDK dependency was needed to answer the questions.

#### Q1: Does one 401 shape serve both Alexa+ and Claude Desktop? — **NO. Answered.**

This is the finding worth having early. The conflict is at the level of a spec **MUST**, not a preference:

- **MCP authorization spec + RFC 9728 §5.1:** a server returning 401 **MUST** send `WWW-Authenticate` carrying the `resource_metadata` URL, and clients MUST be able to parse it. It is the sole discovery path to the PRM document.
- **Alexa+:** requires 401 **without** `WWW-Authenticate` (§2d).

Measured with three server strategies against two client profiles:

| Strategy | Spec-conformant client | Alexa+ client | Result |
|---|---|---|---|
| `spec` — header always present | ✅ passes | ❌ fails | Alexa+ broken |
| `alexa` — header always absent | ❌ fails (2 assertions) | ✅ passes | Spec clients cannot discover the PRM |
| `sniff` — vary per client | ✅ passes | ✅ passes | 13/13 |

**Conclusion:** no single fixed 401 response satisfies both. The response must **vary by client**, so Sprint 2 needs an explicit branch in the auth middleware — not a constant. Plan on one of:

1. **Per-client 401 shaping** (what the spike does) — branch on `User-Agent`. Cheap, but UA is client-controlled. Acceptable *only* because it varies a discovery hint, never the token check; spoofing it downgrades discoverability and nothing else. Document that invariant or someone will later "simplify" the branch into a security decision.
2. **Separate resource endpoints** — e.g. `/mcp` (spec) and `/mcp/alexa` (header omitted). No sniffing, but two URLs to register and keep in sync.

Option 2 is likely the sounder production choice; option 1 is proven to work. **This is a Sprint 2 decision that must not be deferred past the first commit** — AD-8 already says retrofitting auth is a rewrite.

#### Q2: Which managed authorization server? — **BLOCKED**

Open question 9 stays open. Requires a cloud account (Cognito/Auth0/Okta) that the spike had no credentials for. The skeleton serves `/.well-known/oauth-authorization-server` from a placeholder issuer, advertising `S256` only with `plain` deliberately absent, so swapping in a real issuer is a config change.

#### Q3: Private / org-scoped distribution for an Alexa+ add-on? — **BLOCKED, but the signal is discouraging**

No Amazon developer account, so unverified. Search surfaced **no** private-distribution path for **Alexa+ add-ons** specifically. What exists is adjacent and predates Alexa+:

- **Alexa for Business** private skills — per-organization distribution, but that is the *classic skill* model, not the add-on model.
- **Alexa Smart Properties** — organization-scoped, and §2c already flagged whether it intersects the add-on track as unknown. It remains unknown.

The `addon.json` `storeListing` / `distributionCountries` / certification shape (§3e) still reads as a consumer marketplace. **Treat gate 3 as unresolved and assume public-store-only until Amazon confirms otherwise.** Development stage remains fine for building.

#### Incidental findings worth keeping

- The `X-Forwarded-*` hardening from `github/github-mcp-server` (§2d) is now asserted in the spike: the PRM document is built from a server-side constant, and a forged `X-Forwarded-Host` does not appear in the advertised URLs.
- A no-argument tool schema (`additionalProperties: false`, empty `properties`) is a clean structural expression of rule 7 — there is no tenant field for an external model to fill. Worth carrying into the real tool definitions.

#### What this changes

- **AD-10 (new) — the 401 response is client-varying by design.** Not a bug, not a workaround. Any refactor that collapses it back to a single shape breaks one of the two clients.
- Sprint 2 cannot begin its auth layer until open question 9 is answered.
- Gate 3 (§6) is **not** cleared, and the spike could not clear it.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **Tenant** | One campus |
| **Redo** | Academic redo — a scholar held after dismissal to redo work |
| **Roster** | The day's redo/detention list for one campus |
| **Quarantine** | Rows that failed validation; visible to staff, never surfaced to a parent |
| **Staleness guard** | Refusal to answer from a roster older than the freshness threshold |
| **Authorized contact** | An adult permitted to receive a given scholar's information |
| **Add-on** | An Alexa+ integration; ours is type `MCP`, declared in `addon.json` |
| **Elevated tier** | Session state permitting disclosure of sensitive fields (§3c) |

---

## Changelog

**Rev 5 — PL-013 spike + structure audit.** Added Spike Results: the 401 divergence is a spec-level MUST conflict with **no single-shape solution** — the response must vary by client (AD-10 added). Authorization server (Q9) and Alexa+ private distribution (Q1) both **blocked** on credentials the spike lacked; no private distribution path for Alexa+ *add-ons* was found, only the older Alexa for Business private-skill and Smart Properties tracks. §7 leak vectors now carry test IDs; vectors 2 and 3 had no test until T-22/T-23 were added. Artifacts relocated from `sprint-1/` to the routed phase paths, which is what activated `artifact-budget-guard.py` and `spike-gate.py`.

**Rev 4 — Source schema review.** Added §2e from the HEMS attendance tracker (structure only; no student data stored). Answered open question 4 — eSD is the system of record. Added F-1…F-5, notably: academic redo has no source in the tracker (F-2), the advisor-notes column carries health and family data and must never be read by a tool (F-3), and `DO NOT CALL` is an existing contact-permission flag that becomes a hard guardrail (F-4). Added open questions 10–11.

**Rev 3 — Reference implementation survey.** Added §2d. Finding: no Amazon sample repo exists and none is needed — an Alexa+ MCP server is just a spec-compliant OAuth-protected MCP server. Primary reference is the official TypeScript SDK's `examples/server`. Flagged the 401 `WWW-Authenticate` divergence (Alexa+ requires it absent; other MCP clients prefer it present) as a Sprint 2 test. Recommended a managed authorization server over a hand-rolled one.

**Rev 2 — Alexa+ MCP Toolkit review.** Added §2c, §3. Revised AD-1 and AD-8; added AD-9. Added leak vectors 6–7, gates 1 and 3, open questions 1–3. Classic ASK (§2b) demoted to fallback. Sprint 1 scope **unchanged and reinforced** — see §3a.