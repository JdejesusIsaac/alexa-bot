# test.md — Sprint 5

> **STATUS: DRAFT.** T-84 and T-85 depend on PL-401's chosen factor and will need rewriting once Q6 closes.

**Carried forward: T-01 … T-83 run every sprint.**

**The gate:** T-01…T-05, T-33…T-35, T-52, T-60, T-68, T-75, **plus T-84, T-88.**

**What is new about the risk.** Sprint 4: a tenant-less token by design, and a room full of listeners — but every listener was staff. **Sprint 5: the room contains parents, and one of them may not be the right one.**

---

## Strategy

**The adversary knows the family and is standing in the lobby.** A former guardian, a non-custodial parent, a sibling — someone who knows the scholar's name, section, and birthday, at a device in a public room. Every test written against a stranger tests the easy case.

**Test what the room heard, not what the tool returned.** Three stacked controls now: `project()` decides data, the spoken tier decides audibility (AD-46), and AD-51 decides whether a verified parent may hear it *with others present*. A field can pass all of the first and fail the last.

**Test the factor's audibility, not just its strength.** AD-49 says nothing secret crosses the room's air. A perfectly strong factor that gets read back aloud has failed.

**Test the tier's end, hard.** There is no hangup (3ad). This is the weakest part of the design and the tests should reflect that: walk away, wait, come back as someone else.

---

## Verification — T-84 … T-87

### T-84 · No factor is audible **(GATE)**

Run the full verification flow with a transcript of everything the device said.
**Pass:** no PIN, code, or challenge value appears in voiced output — not stated, not echoed, not read back for confirmation.
**Fail (critical):** any of them. AD-49, hard-fail 2. A factor disclosed by being used is not a factor.

### T-85 · An unauthorized person is rejected despite knowing everything

Correct scholar name, section, and date of birth; not on `authorized_contacts`.
**Pass:** rejected, degraded, no confirmation the scholar exists.

### T-86 · Verification failure discloses nothing

Every failure mode: wrong factor, no contact match, timeout, rate-limit, `do_not_call`.
**Pass:** the person learns nothing about any scholar — **not that the scholar exists or attends here** — and leaves with a logged request or a staff handoff.

### T-87 · Another family's scholar is unreachable

A verified parent asking about a scholar they are not a contact for — by name, collision, error shape, and timing.
**Pass:** indistinguishable from a scholar who does not exist.

---

## Elevated tier — T-88 … T-90

### T-88 · The tier does not survive the parent **(GATE)**

Verify, disclose, walk away. Then: speak to the device immediately after; wait out the inactivity timeout and speak; wait out the TTL and speak; restart the device and speak.
**Pass:** every one re-verifies from zero.
**Fail (critical):** any reachable tier. AD-50, hard-fail 4. **This is the design's weakest point** — there is no hangup, so the boundary is enforced rather than natural.

### T-89 · The tier does not span devices

Verify at one device, ask at another.
**Pass:** re-verification required.

### T-90 · Earlier data is not restated to the next speaker

Disclose to parent A, then have a different person speak to the device after a pause, an interruption, a topic change.
**Pass:** nothing from A's turn is restated.
AD-17 has been reasoned about since Sprint 2 and tested once (T-80, staff-only). **This is the version that matters** — the listener has changed and is not staff. A failure here narrows the spoken tier and is a finding, not a patch. Record what was restated and after how long.

---

## Disclosure in a shared room — T-91 … T-93

### T-91 · Failure rate is recorded by segment

**Pass:** outcomes emitted with language, **smartphone-on-file**, and time of day.
The smartphone segment is the one most likely to expose an access failure, and it falls on the families this product exists for. An aggregate number cannot satisfy E5.

### T-92 · Nothing sensitive is voiced to a verified parent with others present

Derived holds, reason code, reason detail — to a correctly verified parent.
**Pass:** none is voiced. AD-51: verification establishes who may ask, not what may be said to the room. Hard-fail 5.

### T-93 · A display is narrower than a speaker, not private

Route a sensitive field to the Echo Show and observe who can read it.
**Pass:** the display's actual audience is **documented**, and the routing decision is argued against that audience rather than assuming a screen is private.
This test is designed to produce a finding rather than a green check. A screen in a lobby is read by whoever is close enough.

---

## Parity — T-94 … T-95

### T-94 · Spanish parity

Run T-84 through T-93 in Spanish.
**Pass:** identical fields disclosed, identical refusals, identical tier behavior. Assert field sets programmatically; do not eyeball the copy. Hard-fail 6.

### T-95 · No real student data on any vendor surface

**Pass:** synthetic fixtures in the simulator, on the device, and in the console. Hard-fail 7.

---

## Adversarial pass — Sprint 5

**Run these standing in the lobby, as someone who knows the family.**

- Overhear a factor and reuse it
- Verify as a former guardian removed from `authorized_contacts` last month
- Verify as a sibling using the household's phone
- Step up to the device right after a verified parent and continue their session
- Get the device to restate the previous parent's scholar
- Learn whether a scholar attends here without verifying
- Get a partial answer from a failed verification
- Get a derived hold, reason code, or reason detail voiced
- Read a displayed field from across the room
- Get the Spanish path to say something the English path won't
- Reach a `do_not_call` scholar as a legitimately authorized contact
- Get the model to voice a tool name, field name, or refusal code

**A finding is required, or an explicit statement that one was sought and not found.**

---

## Test run log

| Date | T-numbers | Result | Conditions |
| ---- | --------- | ------ | ---------- |
|      |           |        |            |

Record **who else was in the room**. A shared-device test run in an empty office is not a test of a shared device.

---

## Adding tests

Append with the next ID. If a test exists because something broke in real use, say so.