# research.md — Parent Line

> **Read this first, every session.** Durable context: what was investigated, what was decided, what must not be re-litigated. If a decision here looks wrong, raise it — don't silently reverse it.

**Sprint 2 scope:** the staff-facing MCP server. OAuth 2.1, Streamable HTTP, three tools, Claude Desktop as client. No Alexa+ deployment, no parent verification.
**Last updated:** rev 9 — PL-101 observation protocol (§Spike Results): AS-agnostic three-way `aud` test, Auth0 worked path, Okta/Cognito fallbacks, Keycloak break-glass.

---

## 1. What the product is

A parent asks a routine question ("where is my scholar?", "I need the vice principal", "send me his report card") and gets a verified, consistent answer without pulling staff off dismissal duty.

**The payload is student education records.** Every design decision is downstream of that.

---

## 2. Source review (settled)

### 2a. `serversmx/alexa-mcp` — rejected

Outbound control only (Claude → Echo). No inbound path, stdio-only, auth by scraped Amazon session cookies, unofficial private API. Its "multi-instance" support is separate auth dirs, not tenant isolation. Possible future role: staff announcements only, never student data.

### 2b. Classic Alexa Skills Kit — fallback

Custom skill + endpoint, ~8s budget, OAuth 2.0 account linking. Retained only if the Alexa+ path proves unavailable.

### 2c. Alexa+ MCP Toolkit — the spine

Alexa+ acts as an **MCP client** against a remote server we host. One server, multiple clients (AD-1).

| Requirement      | Detail                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Transport        | **Streamable HTTP**, MCP spec 2025-11-25. HTTP+SSE deprecated — do not implement.                                 |
| Latency          | **Round-trip under 500 ms**                                                                                       |
| Auth             | OAuth 2.1 authorization code + **PKCE (S256)**                                                                    |
| Discovery        | `401` **without** `WWW-Authenticate`; PRM at well-known URI (RFC 9728); `/.well-known/oauth-authorization-server` |
| PKCE advertising | `code_challenge_methods_supported` must include `S256` or account linking silently fails                          |
| `resource` param | **RFC 8707. Required in BOTH the authorization and token requests.**                                              |
| Token            | Bearer in `Authorization` header. Never the query string.                                                         |
| Visuals          | Optional, via MCP Apps                                                                                            |

**Not supported:** DCR · CIMD · OIDC · **Step-Up Authorization** · `WWW-Authenticate` in 401

Tool definitions are cached until add-on redeploy (AD-9). US-only.

### 2d. Reference implementations

No Amazon sample exists or is needed — an Alexa+ MCP server is a spec-compliant OAuth-protected MCP server. Primary: official TypeScript SDK `examples/server` (`simpleStreamableHttp.ts --oauth --oauth-strict`; strict mode is Resource Identifier verification, which maps to the `resource` requirement). Secondary: `tkodev/mcp-oauth-example` for the resource-server-only shape with audience validation. Production patterns: `github/github-mcp-server` — notably it ignores `X-Forwarded-*` when building metadata URLs so an untrusted client can't influence what we advertise.

### 2e. Source data — HEMS attendance tracker (schema only, no student data stored)

Google Sheets workbook, tracker tab + per-grade pull tabs, `XLOOKUP` on student ID. Columns: ID · First/Last Name · Homeroom · Advisor · Attendance · Uniform · **DO NOT CALL** · **Advisor Notes (free text)** · Time In · Reason · Missing ID · Absence Count (concatenated string).

**F-1 — eSD is the system of record**, not the spreadsheet. If eSD exposes an API it supersedes the Sheets connector.
**F-2 — Academic redo has no source in the tracker.** Detention is derivable (Tardy, Missing ID); redo originates with teachers and never reaches the sheet. Blocked on Q10.
**F-3 — Column J is a health-and-family-data landmine.** Excluded at the connector. Never a canonical row, response, or log.
**F-4 — `DO NOT CALL` is an existing contact-permission flag.** Required canonical field; hard guardrail on proactive contact.
**F-5 — Free text is what happens without controlled vocabulary.** Every field we read must be a constrained enum.

### 2f. OAuth 2.1 as a resource server — Sprint 2 build notes

We are a **resource server only**. Token issuance is the AS's problem; a hand-rolled AS holding parent identity for student-record access is a liability we don't need.

**Validation chain, all four required:** JWKS signature · issuer · expiry · **audience**. Audience is the one that blocks token passthrough — a token the user legitimately holds for a _different_ resource must not open ours. Cache JWKS; do not fetch per request (latency budget).

**DCR is unsupported**, so clients are statically pre-provisioned: one for Claude Desktop, one placeholder for Alexa+.

**RFC 8707 `resource` is the AS selection criterion.** Managed servers differ here — Auth0 has historically used `audience` rather than RFC 8707 `resource`. Verify by observation, not documentation.

`SPIKE: Which managed AS (Cognito / Auth0 / Okta) emits and honors RFC 8707 resource in BOTH the authorization and token request? Blocks PL-102 onward.`

`SPIKE: Is there a private or org-scoped distribution path for an Alexa+ add-on? Blocks Sprint 3 planning and the production channel.`

`SPIKE: What signal does the 401 branch key off (AD-10)? It fires before initialize, so client info is unavailable — User-Agent may be the only option. Determine and document the fragility.`

> **Gate note:** the spike gate checks for the _existence_ of a "## Spike Results" section, not per-marker resolution. That section already exists from PL-013 Q1, so these markers will **not** block planning. Treat them as a checklist, and consider tightening the hook to match markers to resolutions.

---

### 2g. MCP Add-on Design Guide — tool and data design _(reviewed Jul 21 2026 revision)_

Amazon's design guide is explicit about the model we inferred in §3b, and adds three constraints we had not accounted for.

**Confirms AD-2 verbatim:** _"You influence Alexa's response through the data you return, not by scripting it directly."_ Voice and screen are rendered together from the same tool response.

**Confirms the typed-refusal model.** _"The most common source of poor responses is a tool that returns nothing... Always return an error response."_ Our four distinct refusals (`roster_stale`, `sync_failed`, `student_not_found`, `row_quarantined`) are exactly the prescribed shape. Empty-as-success is not just our internal rule — it produces a generic dead-end for the customer.

**New — schema honesty.** _"Declare only what you honor... A parameter the model can send but your server silently ignores produces confidently wrong answers, since the model trusts the schema and fills arguments based on it."_ Also: keep output in sync with the declared schema; no undeclared extension fields. → **AD-15**

**New — tool descriptions are a customer-facing surface.** _"Your `structuredContent`, tool descriptions, and UI payload reach the model, the customer, and Alexa's voice layer."_ Descriptions are not internal documentation. → **AD-16**

**New — disclosure persists across turns.** Alexa maintains continuity through interruptions and topic shifts, re-surfacing earlier task state, and _"draws on what is known about the customer... understanding references to earlier turns in the session."_ Combined: **data we return enters Alexa's conversation context and can be restated in a later turn without a new tool call.** → **AD-17**

**Also:** one tool per meaningful customer intent; avoid overlapping tools, which cause wrong-tool selection and unnecessary parallel calls. Our `lookup_scholar_status` and `search_roster` are adjacent enough to need deliberately disjoint descriptions.

**Not yet reviewed, Sprint 3:** Display Modes · Functional Requirements ("MCP Tool Validation") · Policy Requirements · Certification Guidelines · Local Inspector · Web Simulator · Account Linking. The certification pages may impose hard tool-schema rules — read before Alexa+ deployment, not before the staff client.

---

## 3. Implications of the Alexa+ model (analysis, not doc)

**3a — The 500 ms budget forbids an LLM call in any tool path.** A tool is a validated database read. This is the final architecture for the read path, not a placeholder. Sprint 1 measured p95 = 2.4 ms on local Postgres with 6 rows/tenant and no network — real, but not predictive of production.

**3b — We don't own the model, so tool design is the only disclosure control.** Amazon's model picks tools and fills arguments. Therefore: a tool never returns data the caller isn't cleared for (not "returns it with an instruction not to say it"); tool descriptions are the only steering surface; `tenant_id` from the token is non-negotiable; **assume every returned field is spoken aloud in a lobby immediately.**

**3c — No Step-Up Authorization breaks planned verification tiering.** Tiering must live in our own session state (a `verify_contact` tool setting an elevated flag), not the auth layer. Deferred to Sprint 3 — the staff client needs no tiering, and Q6 is open.

**3g — We cannot un-disclose.** (AD-17) Once a field is returned, it lives in Alexa's session context and may be spoken again in a later turn — after an interruption, after a topic shift, possibly after a different person has walked up to the device. There is no retraction and no re-check. Three consequences: return the **minimum field set** that answers the question; never return a field whose sensitivity depends on _who is present_ or _how much time has passed_; and treat every disclosure as permanent for the session. This sharpens the Sprint 3 tiering problem — an elevated tier that discloses a reason cannot later de-elevate, because the reason is already in context.

**3d — MCP Apps could solve lobby privacy** by displaying the reason rather than speaking it. Needs an Echo Show. Sprint 3+.

**3e — Distribution is a store model.** `addon.json` carries `storeListing` and `distributionCountries`. A student-data add-on in a public store is not obviously acceptable. Unresolved.

**3f — Amazon's Alexa+ security and data policies are unpublished.** No FERPA assessment is possible against them. Hardest gate on the voice path.

---

## 4. Architecture decisions

**AD-1** One MCP server, multiple clients (Alexa+ parents, Claude Desktop staff).
**AD-2** Disclosure enforced in tool return values, never in prompts.
**AD-3** Multi-tenancy: shared DB, shared schema, `tenant_id` per row, Postgres RLS **enabled and forced**, app role non-owner and non-superuser.
**AD-4** `tenant_id` is never a caller- or model-supplied argument. Derived server-side from the session.
**AD-5** Scheduled sheet sync, never a live read on the request path.
**AD-6** Column mapping is explicit config, not inferred.
**AD-7** Degrade to human, never to a guess.
**AD-8** Staff client ships first, on an Alexa+-compliant server from the first commit. Retrofitting transport or auth later is a rewrite.
**AD-9** Tool definitions are a deploy-gated versioned interface.
**AD-10** _(S6)_ **The 401 response varies by client.** MCP spec says MUST include `WWW-Authenticate`; Alexa+ requires it absent. No single shape serves both.
**AD-11** _(S6)_ Real Postgres with controlled role and ownership, not necessarily Testcontainers. CI pins the version via `services:`.
**AD-12** _(new)_ **Disclosure is default-deny.** Every canonical field maps to a clearance (`staff` / `admin` / `never`) at a single chokepoint. A new field is `never` until explicitly cleared. Responses are built by projection, not by handlers remembering to omit.
**AD-13** _(new)_ **Omit a field rather than returning a false value for it.** A parent response omits `hold_source` entirely rather than asserting `'authoritative'` for a derived hold. Omission is honest; falsification is a wrong answer about a student record.
**AD-14** _(new, process)_ **Exit criteria are graded separately from the rubric.** The rubric asks whether the code is good; exit criteria ask whether the sprint is done. Rubric evidence may not satisfy an exit criterion, and a criterion requiring a measurement is unmet until the number is recorded.
**AD-15** _(new)_ **Declare only what you honor.** Every parameter in a tool schema is implemented; none is silently ignored. Output stays in sync with the declared schema; no undeclared extension fields. The model trusts the schema and fills arguments from it, so an unimplemented parameter produces a confidently wrong answer. If a filter isn't built, it isn't in the schema.
**AD-16** _(new)_ **Tool descriptions are customer-facing.** They reach the model, the customer, and the voice layer. No campus names, no student-data examples, no internal jargon, no third-party tracking or upstream links in `structuredContent` or UI payloads. Write them as copy, not documentation.
**AD-17** _(new)_ **Disclosure is permanent for the session.** Returned data enters Alexa's conversation context and can be restated in later turns with no new tool call. Return the minimum field set; never return anything whose sensitivity is person- or time-dependent.
**AD-18** _(new)_ **The token identifies the caller; the session id identifies the connection.** Streamable HTTP's `Mcp-Session-Id` carries transport state only. Tenant and role are resolved from token claims on **every** request and never cached against a session id — otherwise a leaked or replayed session id becomes tenant impersonation.
**AD-19** _(new)_ **Remote deployment is the path; stdio is rejected.** A stdio server never opens a port, so Alexa+ has nothing to connect to — the same disqualifier that ruled out `alexa-mcp` in §2a. A local-first staff tool was considered and declined: it would defer the auth work but could not reach Alexa+ or a second campus, and the transport boundary would have to be crossed anyway.
**AD-20** _(S3)_ **AS-agnostic by construction; dev/tests run on a local test AS.** Issuer, JWKS URL, audience, and claim names are config-driven; the validation chain (JWKS signature → issuer → expiry → audience) is standard OAuth 2.1 resource-server behavior that does not vary by vendor. Sprint 2 and T-24…T-49 run against an in-test RSA keypair with a locally served JWKS; PL-112 is blocked on AS provisioning, not code.
**AD-21** _(S3)_ **`mcp_audit.tenant_id` is nullable by design.** Auth failures happen before tenant context exists; their rows carry NULL tenant and no student data, permitted by the RLS policy, visible to any tenant session as global security events. Authenticated inserts derive the tenant from the session variable (rule 7 — the lint hook caught a `tenantId` parameter and it was fixed to the `current_setting` pattern before merge).
**AD-22** _(S3)_ **An unsupported protocol version is a typed rejection, not a silent downgrade.** The SDK negotiates an unknown requested version down to its own LATEST — exactly the "connection that establishes then silently does nothing" shape. The HTTP layer gates `initialize` against `SUPPORTED_PROTOCOL_VERSIONS` and answers `-32602` before dispatch (T-46).
**AD-23** _(S3)_ **`search_roster` refuses on a stale or failed roster.** Consistent with the lookup's staleness guard: presenting yesterday's list as today's roster is a confident wrong answer (AD-7), and staff would get inconsistent behavior between the two tools otherwise.
**AD-24** _(S3)_ **The 401 branch signal is the User-Agent** (`alexa` substring or `x-amzn-alexa-client`), documented as fragile. It fires before `initialize`, so no MCP client info exists. Spoofable by design — acceptable because the branch only shapes the discovery hint (whether `WWW-Authenticate` is present), never the token check.
**AD-25** _(S3)_ **Auth config takes dev defaults with a production guard** (the `APP_DATABASE_URL` pattern). `RESOURCE_URL`/`AS_ISSUER`/`AS_JWKS_URL` default to loopback placeholders and `EXPECTED_AUDIENCE` falls back to the resource URL; in production, all four must be set explicitly or the process refuses to boot — token validation has no safe default.
**AD-26** _(S8)_ **JWKS is warmed off the request path.** The server prefetches keys at construction (`jose` `reload()`, which bypasses the cooldown) and refetches on a `JWKS_REFRESH_MINUTES` timer (default 10), so the cold fetch T-48 measures never lands inside a request after deploy or AS key rotation. A failed warm logs and defers the cost to the next request rather than failing startup. E3's warm/cold numbers are recorded against this posture — warming landed before the remote p95 run deliberately, so the measured number is the one production will show.

---

## 5. Stack (confirmed in Sprint 1)

TypeScript / Node 20+ · PostgreSQL 15+ (RLS forced, `parentline_app` non-owner) · Drizzle + explicit SQL migrations · Zod · Vitest against real Postgres, database-per-run · ESLint enforcing Rules 7 and 11 · node-cron in-process scheduler

**Sprint 2 additions:** `@modelcontextprotocol/sdk` (Streamable HTTP) · a managed AS pending PL-101 · JWKS validation with caching

---

## 6. Constraints and gates

- **FERPA.** Roster data is education records. Every read audited.
- **Gate 1:** Amazon's Alexa+ security and data policies unpublished (§3f). Blocks the voice path. Not Sprint 2.
- **Gate 2:** whether student records may lawfully transit a consumer voice assistant. Network legal. Not Sprint 2.
- **Gate 3:** private vs public add-on distribution (§3e). Blocks Sprint 3.
- **Sprint 2 is not blocked by any of these** — the staff client touches no Amazon surface.
- **No real student data in this repo. Ever.** Synthetic fixtures only.
- Logs carry `tenant_id`, never student identifiers.
- Audit log append-only in code and schema.

---

## 7. Known leak vectors

Each has a test.

1. A query without a tenant filter → T-01
2. Cache keys missing `tenant_id` → T-22
3. Background jobs without tenant context → T-23
4. Pooled connection retaining `app.tenant_id` → T-04
5. Logs echoing another tenant's rows → T-09
6. A tool returning an uncleared field → T-36, T-37
7. A tool accepting `tenant_id` → T-33, T-34
8. _(new)_ **A token minted for another resource accepted** → T-28
9. _(new)_ **Error shape or timing revealing that a student exists in another tenant** → T-42
10. _(new)_ **A declared-but-unimplemented tool parameter** producing a confidently wrong answer (AD-15) → T-43
11. _(new)_ **Sensitive content in a tool description**, which reaches the customer and the voice layer (AD-16) → T-44
12. _(new)_ **Over-returning fields that persist in session context** and may be restated to a different listener later (AD-17) → T-45
13. _(new)_ **A session id trusted as identity**, letting a replayed id impersonate a tenant (AD-18) → T-47
14. _(new)_ **An unexpected `Origin` accepted** — DNS rebinding against a bound port → T-49
15. _(new)_ **Production redaction relying on hardcoded name lists.** Key-based redaction is the primary defense; the string-scan covers fixture data only. Two defenses with non-overlapping holes; one new non-standard field name closes the gap between them. Carried from Sprint 1. → T-40

---

## 8. Open questions

1. ~~Where do rosters live?~~ **Answered (§2e):** Sheets tracker derived from **eSD**. Follow-up: does eSD expose an API?
2. Canonical `reason_code` list — network-standard or per campus?
3. **Which managed AS supports RFC 8707 `resource` in both requests?** `SPIKE` — PL-101, blocks Sprint 2.
4. **Private / org-scoped distribution path for Alexa+ add-ons?** `SPIKE` — blocks Sprint 3.
5. **What does the AD-10 401 branch key off?** `SPIKE` — PL-104.
6. Parent verification method (PIN / callback / one-time code)? Sprint 3.
7. When do Amazon's Alexa+ security and data policies publish?
8. How does academic redo reach the tracker? Leadership. Blocks the headline use case.
9. Who owns tenant provisioning — network ops or campus admins?
10. Audit retention period?

---

## 9. Glossary

**Tenant** one campus · **Redo** scholar held after dismissal to redo work · **Roster** the day's redo/detention list · **Quarantine** rows failing validation, staff-visible, never parent-surfaced · **Staleness guard** refusal to answer from a roster past the freshness threshold · **Authorized contact** an adult permitted to receive a scholar's information · **Add-on** an Alexa+ integration, type MCP · **Elevated tier** session state permitting sensitive-field disclosure (Sprint 3) · **Clearance** a canonical field's disclosure level under AD-12

---

## Spike Results

### PL-101 — Authorization server selection (PRELIMINARY — observation pending, task 🔵)

**Criterion (from plan.md):** does the AS emit and honor RFC 8707 `resource` in **both** the authorization request and the token request? Verified by observation, not documentation. Auth0 has historically used `audience` instead.

**Documented positions below are superseded by observed results the moment they land — do not conflate the two (E6 depends on the distinction):**

**Documented status as of this finding — UNVERIFIED, observation requires a provisioned dev tenant (owner: Juan):**

- **Auth0** — documents `audience` as its resource-indicator mechanism on the authorization and token endpoints. RFC 8707 `resource` parameter support is not documented as the standard path. If observation confirms, Auth0 is **disqualified** on the primary criterion.
- **Cognito** — access tokens carry `client_id`/custom scopes as audience-like indicators; RFC 8707 `resource` parameter is not documented for the `authorize` or `token` endpoints. If observation confirms, Cognito is **disqualified**.
- **Okta** — Identity Engine documentation describes `resource`-parameter behavior closest to RFC 8707 among the three, but _documented is not demonstrated_ — the spike protocol requires an observed round trip: `resource` echoed in the authorization redirect, and the resulting access token carrying the corresponding `aud` (or `resource`) claim.

**None of the above is an observed result.** A "none of them support it" outcome remains live and reshapes the architecture (e.g., AS-adjacent token exchange or an AS that issues resource-bound tokens by configuration). **Do not treat this section as closing PL-013 Q2/Q3 (E6).**

**Decision that IS closed (this sprint's build posture):** the resource server is **AS-agnostic by construction**. Issuer, JWKS URL, audience, tenant-claim name, and role-claim name are config-driven (`src/config.ts`); the validation chain (JWKS signature → issuer → expiry → audience) is standard OAuth 2.1 resource-server behavior and does not vary by vendor. Sprint 2 development and T-24…T-49 run against a **local test AS** (in-test RSA keypair, locally served JWKS, self-minted RS256 tokens). PL-112 (Claude Desktop end-to-end) is blocked on a provisioned AS with observed `resource` behavior — not on code.

**PL-101 CLOSED 2026-09-17** — dev Auth0 tenant provisioned and the observation protocol run: two REJECTED runs (client↔API authorization missing — dashboard config, fixed via the API's Application Access tab), then **HONORED** — the access token's `aud` carries our resource URL. Full evidence and decision line below under §8. Remaining follow-up wiring belongs to PL-112: the Auth0 Action emitting tenant/role claims, and registering the two static clients (Claude Desktop + Alexa+ placeholder).

### PL-101 — Observation protocol (run when a tenant exists)

**The criterion is the decoded access token's `aud` claim — never a settings page, never a parameter echoed in a redirect.** RFC 8707 `resource` is the mechanism by which Alexa+ asks for a token scoped to this server; what our resource server validates is `aud`. Three outcomes per candidate:

- **HONORED** — `aud` == our MCP URL. Pass; stop here.
- **REJECTED** — a loud error at the authorize or token endpoint (record the exact text). Annoying but safe and diagnosable.
- **SILENTLY DROPPED** — a valid token with a wrong or absent `aud`. **The dangerous middle:** account linking appears to succeed, then every request fails audience validation (or worse, passes it if we've been lax). It will look like a client bug. Record the exact signature.

Use `http://127.0.0.1:8420` as the probe's marker URL everywhere — it is this server's real `RESOURCE_URL`, so the winning observation wires directly into `EXPECTED_AUDIENCE`. **Bake-off discipline: the goal is a decoded token from each candidate, not a configured environment in one — no claims wiring, no branding, nothing past the decoded token.**

**Helper script:** `spike/pl-101-as-probe/probe.mjs` automates §1's mechanics — PKCE, authorize URL, code capture on a loopback listener, token exchange, decode, verdict, and the filled §7 evidence block (never printing the token, code, or verifier). Self-check with `--smoke`; usage in its README. The manual steps below remain the fallback and the definition of what the script does.

**1. The test — identical for every candidate (~20–30 min, no tooling)**

1. Create the cheapest public/native client (PKCE S256, no secret) and one test user. Nothing else.
2. Generate a PKCE pair:
   ```bash
   node -e "const c=require('crypto');const v=c.randomBytes(32).toString('base64url');const ch=c.createHash('sha256').update(v).digest('base64url');console.log('code_verifier =',v);console.log('code_challenge =',ch)"
   ```
3. Build the authorize URL **by hand** (one line, `&`-joined; URL-encode values):
   ```text
   $AUTHORIZE_ENDPOINT?response_type=code&client_id=$CLIENT_ID&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=probe&code_challenge=$CHALLENGE&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420
   ```
   `redirect_uri` points at a **dead loopback port** on purpose: the browser fails to connect, but the redirect URL — including `?code=…` — sits in the address bar. Copy the code from there. No callback server needed. (The helper script instead listens on that port and captures the code automatically.)
4. Open the URL, complete login. If the authorize step errors, record the exact error text — that is the REJECTED outcome.
5. Exchange the code + `code_verifier` at the token endpoint, passing `resource` again:
   ```bash
   curl -s -X POST "$TOKEN_ENDPOINT" \
     -H "content-type: application/x-www-form-urlencoded" \
     -d grant_type=authorization_code \
     -d client_id="$CLIENT_ID" \
     -d code="$CODE" \
     -d code_verifier="$VERIFIER" \
     -d redirect_uri=http://localhost:8425/callback \
     -d resource=http://127.0.0.1:8420
   ```
6. Decode the access token and read the claims:
   ```bash
   node -e "const p=process.argv[1].split('.')[1];console.log(JSON.stringify(JSON.parse(Buffer.from(p,'base64url').toString()),null,2))" "$ACCESS_TOKEN"
   ```
7. Record the verdict from the decoded token: `iss`, `aud` (exact value, or **ABSENT**), `tenant_id`/`role` presence. HONORED / REJECTED / SILENTLY DROPPED.

**Traps the outcome depends on naming:**

- A redirect that echoes `resource` back is **not** evidence — only the token's `aud` counts.
- An opaque (non-JWT) access token is itself a recorded outcome, not a decode failure — note it as such.
- A token that is valid for the AS's own `/userinfo` but carries no `aud` is the SILENTLY DROPPED signature.

**2. Auth0 — worked path (primary: fastest to a decoded token, not the predicted winner, ~15 min)**

1. Free tenant → Applications → Create → **Native** (public client; PKCE allowed by default).
2. APIs → Create API: name "Parent Line MCP", **identifier `http://127.0.0.1:8420`**, signing RS256. (The identifier is what Auth0 binds as `aud`.)
3. Application settings → Allowed Callback URLs: `http://localhost:8425/callback`.
4. Run the §1 test **twice**:
   - **Run A (the actual probe):** `resource=http://127.0.0.1:8420` on the authorize URL. Auth0's proprietary parameter is `audience`; Alexa+ sends RFC 8707 `resource` — this run tests whether that translation happens.
   - **Run B (control):** identical URL with `audience=http://127.0.0.1:8420` instead of `resource` (also on the token exchange). Run B is the known-good Auth0 path; it establishes the baseline `aud` shape.
5. Endpoints: `https://<tenant>.auth0.com/authorize` and `https://<tenant>.auth0.com/oauth/token`.
6. Verdict rule: **Run A HONORED → record, stop, done.** Run A REJECTED or SILENTLY DROPPED while Run B is honored → Auth0 fails _the Alexa+ path specifically_ — that nuance goes in the evidence, then move to Okta. (Note: with neither `resource` nor `audience`, Auth0 issues an opaque token for `/userinfo` — a useful third data point, not a failure of the probe.)

**3. Okta — fallback appendix (short)**

- Dev org → Applications → Create app integration → **Native** (PKCE, refresh off).
- Use the **default custom authorization server**: authorize `https://<org>.okta.com/oauth2/default/v1/authorize`, token `…/oauth2/default/v1/token`. The audience is bound by the AS's audience configuration — the probe tests whether `resource=` maps onto it.
- Same §1 steps, same verdict rule. Per the documented ranking, likeliest of the three to implement RFC 8707 as designed behavior.

**4. Cognito — fallback appendix (run the disqualifier FIRST)**

- **Step 0 — the five-minute disqualifier:** before any `resource` test, decode **any** access token the user pool issues (hosted UI token, or `aws cognito-idp admin-initiate-auth`). If access tokens carry no `aud` claim (historically `client_id` + `scope` only), Cognito fails hard-fail #3 — audience validation — regardless of `resource` support. Record and stop; candidate eliminated.
- If `aud` is present (behavior may have changed — this is exactly the staleness the probe corrects): user pool → app client (public, PKCE) → hosted UI domain (AWS-assigned) → callback `http://localhost:8425/callback` (loopback HTTP is permitted for dev) → same §1 steps against the hosted UI's `/authorize` and `/token`.

**5. Keycloak — break-glass (short)**

Only if all three managed candidates fail — it converts "escalate, architecture changes" into "we have a path":

```bash
docker run -p 8080:8080 quay.io/keycloak/keycloak start-dev
```

Realm + native client (PKCE) → same §1 steps against `http://localhost:8080/realms/<realm>/protocol/openid-connect/auth`. Open-source, spec-tracking, most likely of any to honor `resource` properly; operational burden is why it is last, not disqualification.

**6. End-to-end confirmation (once one candidate is HONORED — optional but strongest)**

Converts the observation into a proof against the real server:

1. `.env`:
   ```bash
   AS_ISSUER=https://<winning-as>            # must match the token's iss EXACTLY, including trailing slash
   AS_JWKS_URL=<the AS's JWKS endpoint — Auth0: https://<tenant>.auth0.com/.well-known/jwks.json ·
                Okta custom AS: https://<org>.okta.com/oauth2/default/v1/keys ·
                Cognito: https://cognito-idp.<region>.amazonaws.com/<user-pool-id>/.well-known/jwks.json>
   RESOURCE_URL=http://127.0.0.1:8420
   EXPECTED_AUDIENCE=http://127.0.0.1:8420
   ```
2. `npm run serve`, then sanity-check the PRM:
   ```bash
   curl -s http://127.0.0.1:8420/.well-known/oauth-protected-resource
   ```
3. Present the real token — a full initialize through our actual audience check (T-28):
   ```bash
   curl -s -D - -X POST http://127.0.0.1:8420/mcp \
     -H "authorization: Bearer $ACCESS_TOKEN" \
     -H "content-type: application/json" \
     -H "accept: application/json, text/event-stream" \
     -H "mcp-protocol-version: 2025-11-25" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"pl-101-probe","version":"1.0.0"}}}'
   ```
   **HTTP 200 + `mcp-session-id` header = full pass.** 401 with `invalid_token`/`audience mismatch` in the log = the SILENTLY DROPPED signature confirming itself at the resource server.
4. Then register the two static clients (Claude Desktop + Alexa+ placeholder) on the winning tenant — that is PL-101's follow-up wiring, not part of the probe.

**7. Evidence template — paste one per candidate, fill from the decoded token**

```text
### <AS> — observed <date>
| Field | Value |
|---|---|
| tenant | <name/region> |
| authorize request | <full URL, client_id redacted> |
| outcome at authorize | login OK / ERROR: <exact text> |
| code exchanged | y/n |
| access token iss | <exact> |
| access token aud | <exact value — or ABSENT> |
| tenant_id / role claims | present (values) / absent |
| verdict | HONORED / REJECTED / SILENTLY DROPPED |
| decoded token | <claims JSON — secrets and signatures redacted> |
```

**Decision line (after all attempted candidates):** the winning AS and why, or **"none honored → escalate"** — which activates the "none of them" branch above (AS-adjacent token exchange, or Keycloak as the standing path) and must be raised before any further PL-112 work.

**8. Observed result — 2026-09-17: Auth0 HONORED, PL-101 closed**

### Auth0 (dev tenant `dev-zzarw43qsuyf5lm5.us.auth0.com`) — observed 2026-09-17 (mode: resource)

| Field                   | Value                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenant                  | dev-zzarw43qsuyf5lm5.us.auth0.com                                                                                                                                                                                                                         |
| authorize request       | https://dev-zzarw43qsuyf5lm5.us.auth0.com/authorize?response_type=code&client_id=<redacted>&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Fcallback&scope=openid&state=…&code_challenge=…&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A8420 |
| outcome at authorize    | login OK                                                                                                                                                                                                                                                  |
| code exchanged          | y                                                                                                                                                                                                                                                         |
| access token iss        | https://dev-zzarw43qsuyf5lm5.us.auth0.com/                                                                                                                                                                                                                |
| access token aud        | ["http://127.0.0.1:8420","https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"]                                                                                                                                                                            |
| tenant_id / role claims | absent — expected pre-wiring (the claims Action is PL-112's remaining console step)                                                                                                                                                                       |
| verdict                 | **HONORED**                                                                                                                                                                                                                                               |

Decoded token (secrets, signatures, `sub`, and `azp` redacted here — full block in `spike/pl-101-as-probe/evidence.md`):

```json
{
  "iss": "https://dev-zzarw43qsuyf5lm5.us.auth0.com/",
  "sub": "<redacted>",
  "aud": ["http://127.0.0.1:8420", "https://dev-zzarw43qsuyf5lm5.us.auth0.com/userinfo"],
  "iat": 1789653721,
  "exp": 1789740121,
  "scope": "openid",
  "azp": "<redacted>"
}
```

**Observation trail (raw: `spike/pl-101-as-probe/evidence.md`):**

- Runs 1–2 (09:18, 09:20): **REJECTED at authorize** — `invalid_request — Client "…" is not authorized to access resource server "http://127.0.0.1:8420"`. Diagnostic value: Auth0 **parses the RFC 8707 `resource` parameter** and resolves it against its API registry — the rejection was client↔API authorization (dashboard config), not a capability gap. Fixed on the API's **Application Access** tab (User Access authorized).
- Run 3 (10:02): **HONORED** — login OK, code exchanged, `aud` array carries our resource URL.

**Claims observations that drive wiring:**

- `iss` carries a **trailing slash** — `AS_ISSUER` must match byte-for-byte.
- `aud` is an **array** (resource URL + userinfo) — the verifier must accept string-or-array (jose does natively; noted for any hand-rolled check).
- `tenant_id`/`role` are **absent without wiring** — a post-login Action emitting namespaced custom claims is required. **Wiring decision (corrected 2026-09-20):** the Action reads `app_metadata.tenant_id` / `app_metadata.role` and sets `https://parentline.app/tenant_id` + `https://parentline.app/role`; `.env` sets `TENANT_CLAIM` / `ROLE_CLAIM` to those names.

  **The namespace must be a valid URL, and "namespaced" is not sufficient.** The first attempt used `https://parent-line/tenant_id` — a bare host with no dot and no TLD. Auth0 refuses such namespaces and **drops the claim silently**: login succeeds, the access token is otherwise perfect (`aud` correct, signature valid), and there is no error at `/authorize`, at `/oauth/token`, or in the tenant logs. Six probe runs were spent on deployment and flow-attachment hypotheses before the naming was suspected. Two consequences worth carrying forward:

  1. **A silently dropped claim is indistinguishable from an action that never ran** — from the token alone. The only separator is the tenant's **Monitoring → Logs** entry for the login event, which lists executed actions. Check that first next time, before touching the Action.
  2. The resource server's behavior here was correct and worth keeping: it refused with `missing_tenant_claim` rather than defaulting a tenant. A server that had fallen back to a "default" tenant would have turned a configuration error into cross-campus disclosure (rule 7, and rule 10's degrade-to-human posture).

**§6 confirmation (2026-09-17):**

- §6.1 `.env` values defined (the file is hook-protected; pasted by hand): `AS_ISSUER=https://dev-zzarw43qsuyf5lm5.us.auth0.com/`, `AS_JWKS_URL=…/.well-known/jwks.json`, `AS_AUTHORIZATION_ENDPOINT=…/authorize`, `AS_TOKEN_ENDPOINT=…/oauth/token` (Auth0's endpoints differ from the `/oauth2/*` default derivation), `EXPECTED_AUDIENCE=http://127.0.0.1:8420`, plus the namespaced claim names above.
- §6.2 confirmed live (server booted with the winning values): PRM serves `"authorization_servers": ["https://dev-zzarw43qsuyf5lm5.us.auth0.com/"]`; the AS metadata mirror serves Auth0's real `/authorize` and `/oauth/token`; default-UA 401 carries `WWW-Authenticate: Bearer resource_metadata=…, error="invalid_token"`; Alexa-UA 401 carries **no** `WWW-Authenticate` (the Alexa+ divergence holds under real values).
- §6.3 pending: one more probe run with `--e2e` (fresh browser login) once the claims Action exists — a claims-related rejection proves the validation chain passed; HTTP 200 + `mcp-session-id` is the full pass.

**Decision line: Auth0 wins the bake-off.** RFC 8707 `resource` honored end-to-end — the access token's `aud` carries this server's URL. Okta and Cognito candidates stand down. PL-101 **closed**; PL-112 unblocked.

**Scope note for E6 — this closes Q2 only.** PL-013 Q3 ("is there a private or org-scoped distribution path for an Alexa+ add-on?") is a separate question with a separate blocker and is **still unanswered**: `spike/pl-013-mcp-auth/README.md` step 5 remains unchecked, and no ASK CLI or AWS CLI is installed on the workstation (no `~/.ask` credentials). E6 therefore stands at 🟡 **partial** — marking it met on the strength of Q2 alone would repeat precisely the Sprint 1 error of grading a partial as complete. Q3 gates Sprint 3 planning and the production channel; it gates nothing in Sprint 2.

---

## Changelog

**Rev 11 — claim-namespace root cause; E6 corrected to partial.** §8's wiring decision is corrected: the custom-claim namespace must be a **valid URL**, and `https://parent-line/` (bare host, no TLD) is not one — Auth0 drops such claims with no error on any surface, which is why six probe runs showed a perfect token with absent claims. Namespace moves to `https://parentline.app/`. Recorded the diagnostic separator (Monitoring → Logs lists executed actions) and the note that the server's `missing_tenant_claim` refusal was the correct behavior rather than defaulting a tenant. Added the E6 scope note: §8 closes **Q2 only**; **Q3 remains unanswered** (no ASK/AWS CLI on the workstation), so E6 is 🟡 partial.

**Rev 10 — PL-101 closed: Auth0 honors RFC 8707.** Observation run against the dev tenant: two REJECTED runs (client↔API authorization — dashboard config, fixed via the API's Application Access tab) proved Auth0 parses the `resource` parameter against its API registry; the third run **HONORED** — the access token's `aud` array includes our resource URL. §8 records the evidence, claims observations (trailing-slash `iss`, array `aud`, absent tenant/role pre-wiring, namespaced-claims wiring decision), and the §6.2 live confirmation (PRM, AS metadata mirror, both 401 shapes). The probe gained `--e2e` (§6.3 initialize with the in-memory token) and evidence-file persistence. PL-112 unblocked; its remaining console wiring: the claims Action + two static clients.

**Rev 9 — PL-101 observation protocol.** §Spike Results now carries the copy-paste-ready bake-off: AS-agnostic three-way `aud` test (HONORED / REJECTED / SILENTLY DROPPED — the middle outcome flagged as the dangerous one), Auth0 worked path with the `resource`-probe / `audience`-control two-run structure, Okta and Cognito fallback appendices with Cognito's access-token `aud` disqualifier first, Keycloak break-glass, end-to-end confirmation via `npm run serve` + a real initialize, and the per-candidate evidence template. Documented positions explicitly marked superseded by observed results as they land. _Amended:_ `spike/pl-101-as-probe/probe.mjs` automates the mechanics — smoke-checked and exercised end-to-end against a local fake AS (code capture, exchange with `resource` present, verdict, filled evidence block).

**Rev 8 — Sprint 2 implementation.** AD-20…AD-25 recorded (AS-agnostic posture, nullable audit tenant, version-gate rejection, search staleness refusal, 401 UA signal, dev-defaults/production-guard config). §Spike Results added with the PL-101 preliminary finding — documented AS positions, unverified, observation pending. Streaming posture observed in code: JSON-only responses (`enableJsonResponse`), standalone GET → immediate 405, no SSE upgrade path (E2 evidence partial, local).

**Rev 7 — Remote transport committed.** AD-19 records the fork: remote Streamable HTTP, stdio rejected. Added AD-18 (token identifies the caller, session id identifies the connection), leak vectors 13–14, PL-113 and T-46…T-49 covering handshake assertion, session lifecycle and cross-tenant replay, cold JWKS latency, Origin validation, and streaming posture.

**Rev 6 — MCP Design Guide review.** Added §2g. Guide confirms AD-2 and the typed-refusal model verbatim. Three new constraints: AD-15 (declare only what you honor), AD-16 (tool descriptions are customer-facing), AD-17 (disclosure is permanent for the session — Alexa restates returned data across turns with no new tool call). Added §3g, leak vectors 10–12, T-43…T-45. Certification docs flagged for Sprint 3.

**Rev 5 — Sprint 2 opening.** §2a–§2e compacted (decisions and reasons preserved, narrative dropped). Added §2f (OAuth resource-server build notes) with three SPIKE markers and a note that the spike gate won't fire on them. Added AD-12 (default-deny disclosure), AD-13 (omit rather than falsify), AD-14 (exit criteria graded separately). Added leak vectors 8–10. Recorded the Sprint 1 p95 with its conditions.

**Rev 4** — Source schema review (§2e, F-1…F-5). **Rev 3** — Reference implementation survey (§2d). **Rev 2** — Alexa+ MCP Toolkit review (§2c, §3); AD-1 and AD-8 revised, AD-9 added.
