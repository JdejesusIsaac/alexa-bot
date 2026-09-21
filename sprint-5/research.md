# research.md — Parent Line

> **Read this first, every session.**

> **STATUS: DRAFT.** Drafted 2026-09-20 during Sprint 3, after AD-48 made Alexa+ the product surface and demoted the phone to a later capability. **Q6 is reopened and unanswered.** Sprints 3 and 4 have not run. Re-issue as rev 1 at Sprint 5 open.

**Sprint 5 scope:** the parent tier on Alexa+. A parent speaks to a device at the school and hears where their scholar is — verified, without a staff member, in English and Spanish.

---

## 1. What changed, and why this is the hard sprint

Sprint 4 delivers the product: Claude's inference in an Echo, reading a campus's roster. Staff-facing, which means verification never arises — everyone at the device is staff.

Sprint 5 puts a parent in front of it. **Every advantage the interim phone plan had is gone:**

| | Phone (superseded) | Alexa+ (actual) |
| --- | --- | --- |
| First factor | Caller ID against `authorized_contacts.phone` — free | **None.** No caller identity of any kind |
| Listeners | One, on a handset | **The room.** Whoever is standing there |
| Session boundary | A call, with a clean termination | Fuzzy. No hangup; sessions blur across speakers |
| Step-Up Authorization | N/A | **Not supported by Alexa+** |

**F-27 — Q6 is now the hardest open question in the project.** The candidate list drafted for the phone assumed caller ID carried factor one and that a spoken secret reached one ear. Neither holds. That list is void; §8 reopens it from a no-caller-ID baseline.

---

## 2. Source review

Carried. §2l (Alexa+ MCP Toolkit, re-observed 2026-09-20) stands: no DCR, no CIMD, no OIDC, **no Step-Up Authorization**, no `WWW-Authenticate` in 401.

**F-28 — Alexa voice profiles do not solve this.** Amazon's voice-ID enrollment is per household Amazon account. A school device has no enrolled parent profiles and cannot acquire them; enrollment would require each parent to have an Amazon account tied to that device. Recorded as rejected so it is not rediscovered as an obvious answer.

**F-29 — MCP Apps stop being a stretch and become a mechanism.** On an Echo Show, a field can be *displayed* rather than spoken (§3aa, AD-46's spoken tier). With no way to narrow the audience by voice, the display is the only channel that reaches one person in a shared room. Parked since Sprint 2 for want of a device; it is now on the critical path and the device is a dependency, not a nice-to-have.

---

## 3. Implications

**3ab — On a shared speaker, any spoken factor is disclosed by being used.** A parent saying a PIN aloud in a lobby has told the room the PIN. A one-time code read back aloud is audible to anyone waiting. This is not a weakness of a particular factor — it is a property of the channel, and it eliminates the entire class of spoken secrets. (→ AD-49)

**The consequence is strong and worth stating plainly: the second factor must be out-of-band.** It has to happen on a device the parent holds — a push they approve, a code they enter on their own phone, a tap in an app. Nothing secret crosses the room's air.

**3ac — Out-of-band verification needs a number on file, which is the same dependency the phone plan had.** `authorized_contacts` still has to be populated and normalized. The work built for the phone channel is not wasted; it moves from "factor one" to "the delivery address for factor two."

**3ad — There is no hangup, so the tier has no natural end.** AD-36 scoped the elevated tier to a call and let it die with termination. Alexa sessions have no equivalent boundary: a conversation lapses, resumes, and may resume with a different person standing there. The tier therefore needs an explicit end, a short TTL, and a device scope — and none of those is as clean as a hangup. **This is the weakest part of the design and should be treated as such.** (→ AD-50)

**3ae — AD-17 is at its most dangerous here.** Disclosure is permanent for the session, the device restates earlier task state after interruptions, and the listener may have changed. The spoken tier (AD-46) narrows what may be voiced; it cannot un-say it. Combined with 3ad, the honest reading is that **a parent tier on a shared speaker is safe only if what it speaks is safe to say to anyone in the room.**

That is a real constraint, not a defeat: status and release time were always the low-sensitivity tier. The reason was always going to a private channel. On this surface, "private channel" means the display (F-29) or a person.

---

## 4. Architecture decisions

AD-1 … AD-48 stand. AD-32 and AD-38 are **void on this channel** — both assumed caller ID as factor one, which does not exist here. AD-36 is superseded by AD-50.

**AD-49** _(draft)_ **No verification factor may be spoken aloud on a shared-room device.** The second factor is out-of-band, on a device the parent holds. A spoken PIN or a read-back code is disclosed to the room by being used (3ab). This eliminates spoken secrets as a class, not as a preference.
**AD-50** _(draft)_ **The elevated tier is bounded by an explicit end, a short TTL, and a device scope.** With no hangup (3ad), the tier ends on explicit dismissal, on inactivity timeout, or on TTL expiry, whichever is first. It never spans devices and never survives a restart. Supersedes AD-36 on this channel; the acknowledged weakness is that none of these is as reliable as a terminated call.
**AD-51** _(draft)_ **What the parent tier speaks must be safe to say to anyone in the room.** Verification establishes *who may ask*, not what may be voiced. Sensitive fields go to the display (F-29) or to a person, never to the speaker, regardless of tier. AD-46 and AD-51 stack: clearance, then spoken tier, then audience.

---

## 6. Constraints and gates

Per AD-43.

**Build gates:** **Gate B-3 — Q6, the second factor, from a no-caller-ID baseline.** Blocks everything downstream of verification. This is Sprint 5's PL-101.

**Tenant provisioning preconditions:** T-1, T-2, T-3 (the tenant has opted into a parent-facing surface, which is a distinct decision from opting into the staff surface).

**Vendor-side disclosures:** F-26 (Amazon's unpublished security policy) — re-check; materially more relevant now that parents are on the surface. Update the assessment packet.

**Device dependency:** an Echo Show, if F-29's display path is chosen. Confirm before planning.

---

## 7. Known leak vectors

Carried 1–27. New:

28. **A verification factor audible to the room** (AD-49) → T-84
29. **An elevated tier persisting past the parent's departure**, reached by the next person at the device (AD-50) → T-88, T-89
30. **A sensitive field voiced to a verified parent with others present** (AD-51) → T-92
31. **A displayed field readable by the room** — a screen is narrower than a speaker, not private → T-93
32. **Alexa restating an earlier parent's data to the next speaker** (AD-17, 3ae) → T-90

---

## 8. Open questions

**Q6 — REOPENED. What second factor works with no caller ID, on a shared device, with nothing spoken aloud?** `SPIKE` — PL-401, Gate B-3. The phone-era candidate list is void (F-27).

| Candidate | Mechanism | Strength | Fails whom |
| --- | --- | --- | --- |
| **Out-of-band push approval** | Parent taps approve on their own phone | **Strongest.** Proves possession, nothing crosses the room | Parents without a smartphone or the app |
| **Code entered on the parent's phone** | Device shows/says a challenge; parent enters it in a web page or SMS reply | Strong; no secret spoken | No-data-plan phones; slow mid-conversation |
| **Display-and-confirm on Echo Show** | Screen shows a prompt only the person at the device can read | Medium; proximity, not identity | Anyone standing close |
| Spoken PIN | Parent says it aloud | **Rejected (AD-49).** Discloses itself to the room | — |
| Voice profile | Amazon voice ID | **Rejected (F-28).** Household-account enrollment, not school | — |
| Staff-mediated handoff | Staff verify, then hand over | Strong, and it is the current process — the thing we set out to remove | Nobody, which is the point |

**The honest position going in:** out-of-band push is the leading candidate and its failure mode is the families least likely to have a smartphone — which is the population this product exists to serve. **That tension is the spike's real subject**, not the cryptography.

29. Does the pilot campus have an Echo Show, and where would it sit?
30. Is a parent-facing device in the lobby, at security, or in the main office? Determines the room, which determines AD-51's tier.
31. What is the fallback when verification fails — the Sprint 3 callback spine, or staff handoff?
32. Carried: Q2, Q8, Q9, Q10, Q15, Q23–Q26.

---

## Spike Results

### PL-401 — Q6, no-caller-ID baseline `SPIKE` (open) — **Gate B-3**

**Method:** the PL-301 discipline — decide by observation of real parents, not by reasoning about them. Ten if possible, both languages, at the pilot campus.

**The question is not "is this secure."** It is: *do you have a smartphone, do you have it on you at pickup, and would you tap a prompt on it while standing at a device in the lobby?* Ask about the phone before asking about the factor.

**A "most of our families can't do out-of-band" outcome is a valid and likely result** — escalate immediately. The fallback is that the parent tier stays staff-mediated and Sprint 5 delivers the display path plus a faster handoff, which is still a real improvement over the current process.

---

## Changelog

| Rev | Date | Change |
| --- | ---- | ------ |
| 0 (draft) | 2026-09-20 | Drafted during Sprint 3 under AD-48. **Q6 reopened from a no-caller-ID baseline (F-27).** F-28 voice profiles rejected, F-29 MCP Apps promoted to mechanism. §3ab…§3ae, AD-49…AD-51 draft, leak vectors 28–32. AD-32 and AD-38 void on this channel; AD-36 superseded by AD-50. |