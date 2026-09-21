# plan.md — Sprint 5: The Parent Tier on Alexa+

> **STATUS: DRAFT.** Drafted 2026-09-20 during Sprint 3, under AD-48. **Q6 is reopened and unanswered (Gate B-3).** Tasks downstream of PL-401 are provisional. Re-issue at Sprint 5 open.

**Sprint goal**

> A parent speaks to a device at the school and hears where their scholar is — verified, unassisted, in English and Spanish. The product's name becomes literal on the product's own surface.

**Duration:** 4 weeks. One gate, a verification design with no free first factor, and the first time a wrong answer reaches outside the school.

**Entry condition:** Sprint 4 closed — the Alexa+ channel live and staff-proven at one campus. Per AD-8, every bug staff found is one a parent never hears.

**Companion artifacts:** `sprint-5/research.md` (F-27…F-29, AD-49…AD-51, Q6 candidates) · `sprint-5/test.md` (T-84…T-95) · `sprint-5/progress.md`.

---

## Why this is the hard sprint

Sprint 4 needed no verification: everyone at the device was staff. Putting a parent in front of the same device removes every advantage the superseded phone plan had — no caller ID, a room full of listeners, no hangup to end a session, and no Step-Up Authorization from Alexa+.

Three consequences shape every task below:

**Nothing secret can be spoken** (AD-49). A PIN said aloud in a lobby has told the room the PIN. The second factor must happen on a device the parent holds.

**The tier has no natural end** (AD-50). There is no hangup. Explicit dismissal, inactivity timeout, and TTL are all we have, and none is as reliable as a terminated call. This is the weakest part of the design and is named as such.

**What is spoken must be safe for the room** (AD-51). Verification establishes who may ask, not what may be voiced. Sensitive fields go to the display or to a person — never to the speaker, regardless of tier.

---

## Exit criteria

| #   | Criterion                                                                                   | Met by                |
| --- | --------------------------------------------------------------------------------------------- | --------------------- |
| E1  | A parent completes a verified lookup unassisted, in English **and** Spanish                 | Observation           |
| E2  | **Zero wrong-parent disclosures.** Any one is stop-the-line                                 | T-85…T-87, observation |
| E3  | No verification factor is ever audible in the room                                          | T-84                  |
| E4  | No elevated tier is reachable by the next person at the device                               | T-88, T-89            |
| E5  | Verification failure rate recorded **by segment** — language, smartphone-on-file, time of day | T-91, pilot           |
| E6  | Q6 closed in writing before PL-402 begins                                                   | PL-401                |

**E5's segments changed from the phone plan.** "Phone on file" becomes "smartphone on file," because out-of-band verification depends on a device the family may not have. That segment is the one most likely to expose an access failure, and it is the population this product exists for.

---

## Prerequisites

| #  | Item                                                            | Blocks        | Parallel? |
| -- | ----------------------------------------------------------------- | ------------- | --------- |
| P1 | Sprint 4 closed; Alexa+ channel live and staff-proven           | Everything    | No        |
| P2 | **Q6 answered (PL-401)** — Gate B-3                             | PL-402 onward | No        |
| P3 | Tenant opted into a **parent-facing** surface (distinct from staff) | PL-408    | No        |
| P4 | Echo Show at the pilot campus, if the display path is chosen    | PL-405        | Yes       |
| P5 | Amazon policy status re-checked; assessment packet updated (F-26) | PL-408      | Yes       |

**P5 matters more now.** The packet a customer's counsel reads is materially different when parents are on the surface.

---

## Tasks

### PL-401 — Q6: the second factor `SPIKE` **[GATE B-3]**

Close Q6 from a no-caller-ID baseline. The phone-era candidate list is void (F-27); §8 of research.md has the reopened one.

**Decide by observation of real parents**, ten if possible, both languages. **Ask about the phone before asking about the factor:** do you have a smartphone, is it on you at pickup, would you tap a prompt on it while standing in the lobby.

**AC:** a written finding in research.md "## Spike Results". A method chosen with parent observation recorded. Q6 closed.
**A "most of our families can't do out-of-band" outcome is valid and likely** — escalate immediately. The sprint becomes display-plus-faster-handoff, which is still an improvement on the current process.

### PL-402 — `verify_contact` + elevated tier [PL-401, P1]

Per AD-50: explicit end, inactivity timeout, TTL, device scope. Never spans devices, never survives restart. Rate-limited.

Per AD-49: no factor is spoken. The device may state that verification was sent; it may not state, echo, or read back the factor.

**AC:** T-84, T-88, T-89 pass. No factor is audible; no tier is reachable by the next speaker.

### PL-403 — `authorized_contacts` population + out-of-band delivery [PL-401]

Populate and normalize (E.164). Handle shared numbers, multi-scholar contacts, changed numbers. The table becomes the **delivery address for factor two** rather than factor one (3ac).

**AC:** T-85 passes. A contact not on the list cannot verify, regardless of what they know about the scholar.

### PL-404 — Parent-facing projection + spoken tier [PL-402]

Wire `caller: 'parent'` — built in Sprint 1, never faced a live caller — through the disclosure chokepoint. Then AD-51 on top: what reaches the speaker must be safe for the room.

**AC:** T-86, T-87, T-92 pass. Derived holds blocked (Rule 9); reason never voiced.

### PL-405 — Display path via MCP Apps [P4, PL-404]

Per F-29, no longer a stretch. With no way to narrow the audience by voice, the screen is the only channel that reaches one person. Sensitive fields route here or to a person.

**A screen is narrower than a speaker, not private** — T-93 tests that distinction rather than assuming it.

**AC:** T-93 passes. A displayed field is not voiced, and the display's own audience is documented.

### PL-406 — Spanish parity [PL-404]

Same tools, same refusals, same minimum field sets, same spoken tier. Parity asserted by test, not translation review.

**AC:** T-94 passes.

### PL-407 — Degraded path [PL-402]

Verification failure routes to the Sprint 3 callback spine or a staff handoff (Q31). **Never partial disclosure** — including confirming the scholar exists.

**AC:** T-90 passes.

### PL-408 — Campus pilot [all, P3, P5]

One campus, one week, real parents, both languages. Staff on standby, not on the line.

**AC:** E1, E2, E5.

---

## Sequencing

```
PL-401 (GATE) ─→ PL-402 ─┬→ PL-403 ─┐
                         ├→ PL-404 ─┼→ PL-406 ─┐
                         ├→ PL-405 ─┤          ├→ PL-408
                         └→ PL-407 ─┘          │
                                    ───────────┘
```

**Week 1:** PL-401 only. **Do not build verification on an assumption.**
**Week 2:** PL-402, PL-403. **Week 3:** PL-404, PL-405, PL-407. **Week 4:** PL-406, then PL-408.

**If PL-401 returns "our families can't do out-of-band," stop and re-plan.**

---

## Sprint Contract

### Rubric

| Category                       | Weight  |
| ------------------------------ | ------- |
| **Verification & Disclosure**  | **50%** |
| Functionality                  | 25%     |
| Accessibility (Spanish parity) | 15%     |
| Design                         | 10%     |

### Hard-fail conditions

1. The standing gate failing or unwritten: T-01…T-05, T-33…T-35, T-52, T-60, T-68, T-75, **plus T-84, T-88**
2. A verification factor audible in the room
3. Any disclosure to an unverified caller, including confirming a scholar exists
4. An elevated tier reachable by the next person at the device
5. A derived hold, reason code, or reason detail voiced
6. The Spanish path disclosing anything the English path does not
7. Real student data on a device, in a simulator, or in a vendor console

### Evaluator requirements

- Phase file set to `evaluation`; grade against `sprint-5/plan.md` + `sprint-5/test.md` only
- **Verify PL-401's finding against the recorded parent observations, not the generator's summary**
- Check rejection paths for audit rows, not log lines (AD-42)
- A finding is required, or an explicit statement that one was sought and not found

---

## Deferred

| Item                                       | Target                        |
| ------------------------------------------ | ----------------------------- |
| Aircall/phone as an MCP capability         | Sprint 6+, per AD-48          |
| Store certification and listing (F-24)     | When multi-campus needs it    |
| Leadership appointments; document delivery | Sprint 6                      |
| Multi-campus rollout                       | After one campus holds        |
| **Operational readiness: runbook, on-call, failure playbook** | **Unscoped and overdue** |

---

## Definition of sprint complete

- [ ] All six exit criteria met
- [ ] All 8 tasks ✅ (not 🔵)
- [ ] T-01…T-95 written and passing
- [ ] Zero hard-fail conditions triggered
- [ ] Evaluator produced a finding, or stated one was sought and not found
- [ ] AD-49…AD-51 promoted into `research/research.md` §4
- [ ] Verification failure rate recorded by segment, smartphone-on-file share stated
- [ ] Sprint 6 scope drafted