# test.md — Sprint 7

> **Re-issued 2026-09-29 as Sprint 7.** Drafted as `sprint-4`; the AUTH repair line closed first. Test IDs renumbered T-74…T-83 → **T-92…T-101** — the live suite reached T-91 and the draft's T-75 collided with the decision gate. T-92…T-94 depend on PL-301's permitted-method list (documented set; observed `mcp_audit` rows confirm it at first deploy) and may need adjusting then.

**Carried forward: T-01 … T-91 run every sprint.**

**The gate:** T-01…T-05, T-33…T-35, T-52, T-60, T-68, T-75, T-84, T-87, T-88, T-89 — **plus T-93.**

**Evaluation reports live in `sprint-7/evaluations/`** (Sprint 6 closeout decision) — this file keeps test definitions and the run log only.

**What is new about the risk.** Sprint 1: a query missing a filter. Sprint 2: a token that shouldn't work, working. Sprint 3: a scholar leaving without a decision. **Sprint 7: a tenant-less token by design, and a room full of listeners.**

---

## Strategy

**AD-44 is the first deliberate exception to a rule enforced since Sprint 1.** `tenant_id` has never been absent from an authenticated path. A service token has no tenant because it has no user — correct, and exactly the shape of reasoning that precedes a leak. Test the exception's boundary harder than the exception itself: not "does a service token work for `initialize`," but "what happens when one is presented to `lookup_scholar_status`."

**Test the room, not the request.** Every previous sprint's disclosure tests asked what a tool returned. On a shared device the question is what was *said*, to a room that may contain a waiting parent. A field can pass `project()` and still be wrong aloud (AD-46). The projection is necessary and no longer sufficient.

**Test across turns, not within one.** AD-17 has been reasoned about since Sprint 2 and never faced a device that restates earlier task state after an interruption. T-98 is the first test of the claim.

**Measure the budget that always mattered.** Sprint 2's p95 of 2.4 ms was local Postgres, six rows, no network. The 500 ms figure has been cited across four sprints and never measured on the real path. T-99 is the first honest number.

**Synthetic fixtures extend to the vendor.** "No real student data in this repo" now also means not in the simulator, not on the device, not in a vendor console — surfaces with retention we neither own nor can inspect.

---

## Service-scope auth — T-92 … T-94

### T-92 · The Alexa+ handshake completes

A `client_credentials` token with `mcp:service` scope against `initialize` and `tools/list`.
**Pass:** both succeed. All three tools appear in `tools/list`.
**Fail:** `missing_tenant_claim` — the current behavior, and the reason the add-on cannot connect today (F-20).

### T-93 · A service token reaches no tool and no tenant **(GATE)**

Present an `mcp:service` token to `lookup_scholar_status`, `search_roster`, and `roster_sync_status`.
**Pass:** typed refusal on every one, audited, with no `withTenant` call made and no tenant context established. Assert the absence of the tenant context, not only the refusal.
**Fail (critical):** any tool executes, or any path resolves a tenant for a service token. Hard-fail 2. AD-44's entire safety argument is that this boundary holds.

### T-94 · A tenant-bearing path still requires a tenant claim

A user-level token stripped of its tenant claim, against every data-bearing path.
**Pass:** `missing_tenant_claim`, exactly as before AD-44. The service branch must not have widened the general case — this is the regression test for Rule 7 itself.

---

## Alexa+ integration — T-95 … T-96

### T-95 · Refusals are audible, not technical

All four Sprint 1 refusals — stale roster, sync failed, student not found, row quarantined — spoken through the Alexa+ surface.
**Pass:** each is distinguishable and sounds like speech. A staff member hears "let me get someone for you," never a status code, a field name, or the word "roster."

### T-96 · No tool returns an empty success

**Pass:** every path returns either data or a typed refusal, per AD-7 and the design guide's "always return something." Carried forward because the failure mode is worse here: a silent tool on a voice surface is a conversation that dies with no explanation.

---

## Spoken tier and the room — T-97 … T-98

### T-97 · Nothing outside the spoken tier is voiced **(gate-adjacent)**

Plant a sentinel in a field that `project()` clears but the spoken tier excludes. Exercise every voiced path, including refusals and errors.
**Pass:** the sentinel appears in no voiced output.
**Fail (critical):** anywhere. AD-46, hard-fail 4. The T-68 sentinel method transfers directly; the output surface is what changed.

### T-98 · Earlier data is not restated to the room

Elicit a disclosure, then interrupt, change topic, pause, and return.
**Pass:** the device does not restate the earlier field unprompted.
AD-17 has been reasoned about since Sprint 2 and never tested against a device that re-surfaces task state. **If this fails, the spoken tier must narrow further** — and that is a finding, not a bug to patch quietly. Record what was restated and after how long.

---

## Performance and integrity — T-99 … T-101

### T-99 · Real-path round trip

Full Alexa+ path: their network, our auth, our tool, our response. Warm **and** cold JWKS, reported separately.
**Pass:** p95 ≤500 ms, **recorded with its conditions.**
Four sprints have cited this budget. This is the first measurement of it. A number without conditions does not satisfy E5 — the T-41 lesson.

### T-100 · The published schema matches the registry

**Pass:** the deployed `tools/list` matches the Sprint 2 schema registry fingerprint.
Per AD-45, signatures freeze at publication behind a review cycle — so the fingerprint is a **release gate here**, not the drift detector it was in Sprint 2.

### T-101 · No real student data reaches a vendor surface

Audit the simulator session, the device, and the developer console.
**Pass:** synthetic fixtures only, everywhere. Hard-fail 6.
Rule 6 has been enforced by repo hooks since Sprint 1. Those hooks cannot see a vendor console, so this one is a procedural check with a named owner.

---

## Adversarial pass — Sprint 7

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

For T-99 record the network path, warm vs cold, and time of day. For T-98 record who else was in the room — a test run in an empty office is not a test of the room.

---

## Adding tests

Append with the next ID. If a test exists because something broke in real use, say so in the description.