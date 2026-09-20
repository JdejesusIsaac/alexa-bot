# test.md — Sprint 2

**Carried forward: T-01 … T-23 run every sprint.** The isolation gate never retires. A Sprint 2 change that breaks Sprint 1 isolation is the most likely way this project leaks.

**The gate widens.** T-33…T-35 join T-01…T-05 as stop-the-line. Sprint 2 is the first sprint where a leak is reachable over a network.

---

## Strategy for this sprint

**Test the auth surface like an attacker, not a user.** Sprint 1's risk was a query missing a filter — a mistake. Sprint 2's risk is a token that shouldn't work, working. The difference matters: a valid-looking token from a legitimate issuer for a different resource _looks_ correct at every layer except the one check that catches it.

**Every rejection must be distinguishable.** Four token failures (signature, issuer, expiry, audience) that all surface as a generic 401 make production debugging impossible and hide which control actually fired.

**Nothing may reveal existence across tenants** — not a message, not an error code, not a timing difference.

**Every response is permanent.** Per AD-17, what a tool returns enters Alexa's session context and may be restated later without another call. Tests assert the _minimum_ field set, not merely an _allowed_ one — the question is not "may this field be disclosed" but "must it be, to answer what was asked."

**Note on T-34 vs AD-15.** These look contradictory and aren't. AD-15 forbids declaring a parameter and ignoring it. `tenant_id` is **never declared**, so a tenant argument arriving in a payload is not a broken promise — it's adversarial input, and ignoring it is correct. The distinction is declared-and-ignored (a bug) versus undeclared-and-rejected (a defense).

---

## Auth — T-24 … T-29

### T-24 · Valid token accepted

Correct signature, issuer, audience; unexpired.
**Pass:** the tool call proceeds.

### T-25 · Bad signature rejected

Signed with a key not in the JWKS.
**Pass:** 401. **Fail (critical):** accepted.

### T-26 · Wrong issuer rejected

Valid signature, different issuer.
**Pass:** 401, rejection reason distinct from T-25's.

### T-27 · Expired token rejected

**Pass:** 401. Clock-skew tolerance, if any, is explicit and small — not incidental.

### T-28 · Wrong audience rejected — token passthrough (GATE-adjacent)

A token that is **fully valid but minted for a different resource**.
**Pass:** rejected. **Fail (critical):** accepted.
This is the attack the audience check exists for: a token the user legitimately holds elsewhere must not open ours. It passes signature, issuer, and expiry — audience is the only thing standing between it and student records.

### T-29 · Bearer token in query string rejected

The same valid token as a URL parameter.
**Pass:** rejected, **and** the token value appears in no log, trace, or error.

---

## Discovery — T-30 … T-32

### T-30 · PRM document served correctly

Fetch the well-known URI (RFC 9728).
**Pass:** valid document naming this server's canonical resource URI. Assert it is **not** influenced by `X-Forwarded-Host` or `X-Forwarded-Proto` — an untrusted client must not shape what we advertise.

### T-31 · AS metadata advertises S256

Fetch `/.well-known/oauth-authorization-server`.
**Pass:** `code_challenge_methods_supported` present, includes `S256`.
Without it Alexa+ account linking fails **silently** in production. This test is the only warning.

### T-32 · 401 shape correct per client (AD-10)

Unauthenticated request from each client shape.
**Pass:** each receives the form it can act on; each discovers the auth server.
**Record the branching signal in the test description** — PL-013 found no single shape works, the branch fires before `initialize`, and whoever reads this next needs to know what it keys off and how fragile that is.

---

## Tool isolation — T-33 … T-35 (GATE)

### T-33 · No tool schema accepts a tenant parameter

Enumerate every registered schema.
**Pass:** no property named `tenant_id`, `tenantId`, `campus_id`, or equivalent.
**Fail (critical):** an external model fills tool arguments — a tenant parameter is cross-campus disclosure one inference away.

### T-34 · Forged tenant argument ignored

Tenant A's token, plus an extra `tenant_id` in the payload naming tenant B.
**Pass:** A's data, extra argument ignored.
**Fail (critical):** B's data, or an error revealing B exists.

### T-35 · Cross-tenant lookup through MCP

Tenant A's token, request a student existing only in B (colliding-name fixtures).
**Pass:** clean not-found.
**Fail (critical):** B's record, or a refusal whose wording confirms B's student exists.

---

## Disclosure — T-36 … T-39

### T-36 · Default-deny on new fields (AD-12)

Add a canonical field with no clearance entry; request it through a tool.
**Pass:** absent from the response.
**Fail:** present — the policy is opt-out rather than opt-in, and every future field becomes a leak waiting for someone to forget.

### T-37 · Advisor-notes unreachable through MCP

Fixture with populated notes, requested through every tool.
**Pass:** content appears in no response, error, or trace.

### T-38 · Derived holds labelled, not falsified (AD-13)

Staff request for a derived hold → **Pass:** `hold_source: 'derived'`, truthfully.
Parent-shaped projection → **Pass:** `hold_source` **omitted**, not `'authoritative'`.
Omitting is honest; a false value is a wrong answer about a student record.

### T-39 · Role gating on admin tools

`staff` token calling `roster_sync_status`.
**Pass:** authorization refusal, distinguishable from an empty result.
**Fail:** empty success — the failure mode this project exists to prevent, at a new layer.

---

## Audit, latency, inference — T-40 … T-42

### T-40 · Every MCP call audited; redaction holds without the fixture list

Ten calls: successes, refusals, auth failures.
**Pass:** one audit entry per call, actor from the token subject, no student identifiers in recorded arguments.
**Include a production-shaped name absent from `KNOWN_STUDENT_NAMES`.** Sprint 1's T-09 passed partly because fixture names are hardcoded in the redaction list — key-based redaction must hold on its own. Leak vector 10.

### T-41 · Full round-trip latency

200 sequential calls through the MCP surface, warm JWKS cache.
**Pass:** p95 ≤300 ms **and the number is recorded with its conditions** (dataset size, local vs network, cache state).
Report per stage — auth / tool / total — so a regression is attributable.
Sprint 1 measured 2.4 ms on local Postgres with 6 rows/tenant and no network. That is not 297 ms of headroom; it is a different measurement.

### T-42 · No existence oracle across tenants

For a ref existing only in tenant B, and a ref existing nowhere, both queried under tenant A: compare the **response shape, the error code, the message, and the timing distribution** over 200 calls each.
**Pass:** statistically indistinguishable.
**Fail (critical):** a measurable difference. `student_not_found` in both cases is correct, but if the quarantine check or audit write makes one path slower, that timing gap tells an attacker whether a scholar is enrolled at another campus. With a low-millisecond baseline, a few milliseconds is a large relative signal.
_This is one of two vectors Sprint 1's adversarial pass never attempted._

---

## Schema honesty, descriptions, field economy — T-43 … T-45

_Added from the MCP Add-on Design Guide (research.md §2g)._

### T-43 · Every declared parameter is implemented (AD-15)

Enumerate every tool schema. For each declared parameter, call the tool twice — with the parameter set to a value that should change the result, and without it.
**Pass:** every parameter demonstrably changes behavior.
**Fail (critical):** a parameter the server accepts and ignores. Amazon's guidance is blunt about why — the model trusts the schema and fills arguments from it, so an ignored `section` filter makes Alexa confidently say "here are the three scholars in 304" when no filtering occurred. A silently-ignored parameter is a _confidently wrong answer generator_, which is the exact failure mode this project exists to prevent.
Also assert the reverse: **no undeclared fields in the response.** Output stays in sync with the declared schema.

### T-44 · Tool descriptions carry no sensitive or foreign content (AD-16)

Scan every tool description, `structuredContent`, and any UI payload.
**Pass:** no campus names, no student names or refs, no internal jargon, no third-party tracking parameters, no upstream links.
These reach the model, the customer, **and Alexa's voice layer** — a description is copy that may be read aloud, not internal documentation. Assert each description states when to call the tool, why, and what it returns.
Also assert `lookup_scholar_status` and `search_roster` descriptions are **disjoint** — overlapping descriptions cause wrong-tool selection and unnecessary parallel calls.

### T-45 · Responses carry no field beyond the minimum set (AD-17)

Define a minimum field set per tool. Call each tool across success and refusal paths.
**Pass:** the response contains exactly the declared minimum, no extras.
**Fail:** any field present that isn't required to answer the question.
The reason is not tidiness. Returned data enters Alexa's session context and **can be restated in a later turn with no new tool call** — after an interruption, a topic shift, or a different person stepping up to the device. There is no retraction. A field that is merely _cleared_ but not _needed_ is a disclosure we chose to make permanent for no benefit.

---

## Remote transport — T-46 … T-49

_The concerns that exist because we deploy a reachable server. Sprint 2 is committed to remote Streamable HTTP; these are first-class, not deferred._

### T-46 · `initialize` handshake and version negotiation

Drive a full `initialize` → `notifications/initialized` → `tools/list` sequence by test, not by a manual Inspector run.
**Pass:** the handshake completes, the negotiated protocol version is asserted explicitly, and declared capabilities match what the server actually implements.
Then send an `initialize` with an unsupported protocol version.
**Pass:** a clear, typed failure. **Fail:** a connection that establishes and then silently does nothing — the shape a version mismatch with Alexa+ would take, and the hardest to diagnose from the other side.

### T-47 · Session lifecycle and cross-tenant replay

`Mcp-Session-Id` is issued on `initialize` and returned on subsequent requests.
**Pass, four cases:**

- A request without the session id is rejected with a typed error
- An unknown or expired session id is rejected — **never silently upgraded into a fresh session**
- A session id issued under tenant A's token, replayed with tenant B's token, resolves to **tenant B** — the token decides, always
- A session id issued under tenant A's token, replayed with **no** token, is rejected

**Fail (critical):** tenant or role resolved from the session id. The session id identifies a connection; the token identifies the caller. Conflating them turns a leaked session id into tenant impersonation (AD-18).

### T-48 · Cold JWKS path

Clear the JWKS cache (fresh process, or simulate key rotation) and issue the first authenticated request.
**Pass:** it succeeds, and the latency is **recorded separately from the warm number**.
T-41's warm measurement is the steady state. This is the realistic worst case — first request after a deploy, or after the AS rotates keys — and it is the one that blows a 500 ms round-trip budget. A warm p95 is not a headroom claim.

### T-49 · Origin rejection and streaming posture

**Origin:** a request carrying an unexpected `Origin` header is rejected. DNS-rebinding protection becomes real the moment a port is bound.
**Streaming:** a client opening a standalone `GET` for server-initiated messages receives the documented behavior **immediately** — whatever PL-113 decided — and does not hang.
A hang inside Alexa+'s 500 ms budget is a dead conversation, and it fails in production in a way no local test catches by accident.

---

## Adversarial pass — Sprint 2

Attempt each, report what worked, fix nothing.

- Reach tenant B through tenant A's token — by argument, by name collision, by error-message inference, **by timing**
- Present a token minted for a different resource
- Present a token in the query string
- Get advisor-notes content into any response, error, or trace
- Get `roster_sync_status` to answer a `staff` token
- Get a derived hold returned as authoritative
- **Get a student name into a log line using a name absent from the redaction list**
- Get a tool to answer with no token at all
- Get the 401 or the PRM document to leak whether a tenant exists
- Influence the advertised metadata URL via `X-Forwarded-*`
- **Find a declared tool parameter the server ignores** (AD-15)
- **Get a field into a response that isn't in that tool's minimum set** (AD-17)
- **Replay a session id across tokens** to see whether tenant follows the session or the token (AD-18)
- **Reach the server from an unexpected `Origin`**
- **Open a standalone `GET` and see whether it hangs**

**A finding is required, or an explicit statement that one was sought and not found.** A weakest point identified and then argued away is a finding. Sprint 1's pass named two real gaps — non-standard log keys evading redaction, and a single mapping misconfiguration reaching notes content — and filed both as theoretical. One of them is already on the deferred list as a Sprint 2 item, which means the project treats it as real while the evaluation did not.

---

## Test run log

| Date       | T-numbers             | Result                                                                                                                                                               | Conditions                                                                     |
| ---------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-09-17 | T-01…T-49             | **49/49 passing** (23 files, 214 cases)                                                                                                                              | Local Postgres via `.env`, Node 20, `npm test`, serial files, database-per-run |
| 2026-09-16 | T-01…T-05 (gate only) | **Red, by design** — P2 drill: `roster_entries` policy weakened to `using (true)`; T-01 failed `expected 6 to be 3`; reverted byte-identical; full gate re-run green | Local; remote CI push deliberately not executed                                |
| 2026-09-21 | T-01…T-49             | **49/49 passing** (23 files, 219 cases) — post-eval repair: boundary-owned `tools/call` audit (F-1), measured T-41/T-48 (F-2), T-32 signal recorded (F-3), bare `/health` (F-4), outcome-label enforcement (F-5) | Local Postgres via `.env`, Node 20, `npm test`, serial files, database-per-run |

Notes from the 2026-09-17 run: T-41's per-stage latency asserts presence and non-negativity (production p95 is E3's job, under real conditions); T-42's timing distributions over 200 calls per path compared medians and p90s within tolerance; T-48's cold-JWKS path measured against a locally served JWKS — network cost is one localhost fetch, so the absolute ceiling (<500 ms) is asserted, and the remote number waits for PL-112.

Notes from the 2026-09-21 run: T-41 now implements its spec — 200 sequential `tools/call`s with per-stage p95 from the audit trail plus client round-trip, recorded with conditions (local: auth 0 ms, tool ~3 ms, server-total ~5 ms, client p95 ~5.3 ms against a ≤300 ms criterion). T-48 records the cold-JWKS number (local ~2.5 ms vs ~2 ms warm). The F-1 test block exercises all four pre-dispatch/refusal audit outcomes including `rejected:malformed_tool_call`. Remote numbers remain unmeasured pending PL-112.

---

## Adding tests

Append with the next ID. If a test exists because something broke in real use, say so in the description — that's the difference between a test someone imagined and a test that caught a live bug, and it changes how seriously the next person takes a failure.
