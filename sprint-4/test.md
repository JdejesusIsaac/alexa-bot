# test.md — Sprint 4

> **STATUS: DRAFT.** Drafted during Sprint 3. T-74…T-76 depend on PL-301's observed method list and may need adjusting once the spike reports.

**Carried forward: T-01 … T-73 run every sprint.**

**The gate:** T-01…T-05, T-33…T-35, T-52, T-60, T-68, **plus T-75.**

**What is new about the risk.** Sprint 1: a query missing a filter. Sprint 2: a token that shouldn't work, working. Sprint 3: a scholar leaving without a decision. **Sprint 4: a tenant-less token by design, and a room full of listeners.**

---

## Strategy

**AD-44 is the first deliberate exception to a rule enforced since Sprint 1.** `tenant_id` has never been absent from an authenticated path. A service token has no tenant because it has no user — correct, and exactly the shape of reasoning that precedes a leak. Test the exception's boundary harder than the exception itself: not "does a service token work for `initialize`," but "what happens when one is presented to `lookup_scholar_status`."

**Test the room, not the request.** Every previous sprint's disclosure tests asked what a tool returned. On a shared device the question is what was *said*, to a room that may contain a waiting parent. A field can pass `project()` and still be wrong aloud (AD-46). The projection is necessary and no longer sufficient.

**Test across turns, not within one.** AD-17 has been reasoned about since Sprint 2 and never faced a device that restates earlier task state after an interruption. T-80 is the first test of the claim.

**Measure the budget that always mattered.** Sprint 2's p95 of 2.4 ms was local Postgres, six rows, no network. The 500 ms figure has been cited across four sprints and never measured on the real path. T-81 is the first honest number.

**Synthetic fixtures extend to the vendor.** "No real student data in this repo" now also means not in the simulator, not on the device, not in a vendor console — surfaces with retention we neither own nor can inspect.

---

## Service-scope auth — T-74 … T-76

### T-74 · The Alexa+ handshake completes

A `client_credentials` token with `mcp:service` scope against `initialize` and `tools/list`.
**Pass:** both succeed. All three tools appear in `tools/list`.
**Fail:** `missing_tenant_claim` — the current behavior, and the reason the add-on cannot connect today (F-20).

### T-75 · A service token reaches no tool and no tenant **(GATE)**

Present an `mcp:service` token to `lookup_scholar_status`, `search_roster`, and `roster_sync_status`.
**Pass:** typed refusal on every one, audited, with no `withTenant` call made and no tenant context established. Assert the absence of the tenant context, not only the refusal.
**Fail (critical):** any tool executes, or any path resolves a tenant for a service token. Hard-fail 2. AD-44's entire safety argument is that this boundary holds.

### T-76 · A tenant-bearing path still requires a tenant claim

A user-level token stripped of its tenant claim, against every data-bearing path.
**Pass:** `missing_tenant_claim`, exactly as before AD-44. The service branch must not have widened the general case — this is the regression test for Rule 7 itself.

---

## Alexa+ integration — T-77 … T-78

### T-77 · Refusals are audible, not technical

All four Sprint 1 refusals — stale roster, sync failed, student not found, row quarantined — spoken through the Alexa+ surface.
**Pass:** each is distinguishable and sounds like speech. A staff member hears "let me get someone for you," never a status code, a field name, or the word "roster."

### T-78 · No tool returns an empty success

**Pass:** every path returns either data or a typed refusal, per AD-7 and the design guide's "always return something." Carried forward because the failure mode is worse here: a silent tool on a voice surface is a conversation that dies with no explanation.

---

## Spoken tier and the room — T-79 … T-80

### T-79 · Nothing outside the spoken tier is voiced **(gate-adjacent)**

Plant a sentinel in a field that `project()` clears but the spoken tier excludes. Exercise every voiced path, including refusals and errors.
**Pass:** the sentinel appears in no voiced output.
**Fail (critical):** anywhere. AD-46, hard-fail 4. The T-68 sentinel method transfers directly; the output surface is what changed.

### T-80 · Earlier data is not restated to the room

Elicit a disclosure, then interrupt, change topic, pause, and return.
**Pass:** the device does not restate the earlier field unprompted.
AD-17 has been reasoned about since Sprint 2 and never tested against a device that re-surfaces task state. **If this fails, the spoken tier must narrow further** — and that is a finding, not a bug to patch quietly. Record what was restated and after how long.

---

## Performance and integrity — T-81 … T-83

### T-81 · Real-path round trip

Full Alexa+ path: their network, our auth, our tool, our response. Warm **and** cold JWKS, reported separately.
**Pass:** p95 ≤500 ms, **recorded with its conditions.**
Four sprints have cited this budget. This is the first measurement of it. A number without conditions does not satisfy E5 — the T-41 lesson.

### T-82 · The published schema matches the registry

**Pass:** the deployed `tools/list` matches the Sprint 2 schema registry fingerprint.
Per AD-45, signatures freeze at publication behind a review cycle — so the fingerprint is a **release gate here**, not the drift detector it was in Sprint 2.

### T-83 · No real student data reaches a vendor surface

Audit the simulator session, the device, and the developer console.
**Pass:** synthetic fixtures only, everywhere. Hard-fail 6.
Rule 6 has been enforced by repo hooks since Sprint 1. Those hooks cannot see a vendor console, so this one is a procedural check with a named owner.

---

## Adversarial pass — Sprint 4

- Reach a tool with a service-level token
- Establish a tenant context from a token with no tenant claim
- Get a field outside the spoken tier voiced — on success, on refusal, on error
- Get Alexa to restate an earlier turn's data after an interruption
- Get a student identifier into a vendor-side log, transcript, or console
- Get the model to reveal a tool name, a field name, or an internal refusal code aloud
- Get a wrong-tool selection by exploiting overlapping descriptions (AD-16, still applies)
- Blow the 500 ms budget with a cold JWKS on the real path
- Deploy a schema that differs from the reviewed one
- **Reach tenant B from the opted-in tenant's add-on** — the standing question on every new surface

**A finding is required, or an explicit statement that one was sought and not found.**

---

## Test run log

| Date | T-numbers | Result | Conditions |
| ---- | --------- | ------ | ---------- |
|      |           |        |            |

For T-81 record the network path, warm vs cold, and time of day. For T-80 record who else was in the room — a test run in an empty office is not a test of the room.

---

## Adding tests

Append with the next ID. If a test exists because something broke in real use, say so in the description.