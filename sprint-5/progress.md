# progress.md — Sprint 5

> **Agent: update this file at the end of every working session.**

> **STATUS: DRAFT.** Drafted 2026-09-20 during Sprint 3, under AD-48. Sprints 3 and 4 have not run. Session 0 is a drafting session.

**Sprint:** 5 — The Parent Tier on Alexa+
**Started:** not started
**Status:** ⬜ Draft harness. **Gate B-3 open: Q6 reopened from a no-caller-ID baseline, unanswered.**

---

## Current state

**Next action (pre-sprint):** **open Q6 now**, during Sprint 3 or 4. It needs real parents in two languages — weeks of elapsed time against an hour of work — and it is the hardest open question in the project (F-27). Ask about the phone before asking about the factor.

**Blocked on:** Sprint 4 closure. PL-402 onward on PL-401.

**What changed:** AD-48 made Alexa+ the product surface and demoted the phone to a later capability. The interim plan had parents on the phone first, where caller ID gave a free first factor and a handset gave one listener. **Both advantages are gone.** The phone-era Q6 candidate list is void.

---

## Exit criteria

| #  | Criterion                                                          | Status                   |
| -- | -------------------------------------------------------------------- | -------------------------- |
| E1 | A parent completes a verified lookup unassisted, English and Spanish | ⬜ PL-408                |
| E2 | **Zero wrong-parent disclosures**                                  | ⬜ stop-the-line          |
| E3 | No verification factor audible in the room                         | ⬜ T-84                  |
| E4 | No tier reachable by the next person at the device                 | ⬜ T-88, T-89            |
| E5 | Failure rate by segment, incl. smartphone-on-file                  | ⬜ T-91                  |
| E6 | Q6 closed in writing before PL-402                                 | ⬜ **not started**       |

---

## Failed Approaches

> Max 10 lines. Survives context resets and sprint restarts.

- RLS `WITH CHECK` rejects INSERT omitting `tenant_id`
- Auth0 silently drops custom claims whose namespace is not a valid URL — ~2h across 6 probe runs
- `source .env` crashes on multi-line `GOOGLE_SERVICE_ACCOUNT_JSON`
- **Verifying an external integration by documentation rather than observation** (PL-101)
- **Auditing inside the handler when the rejection happens pre-dispatch** (Sprint 2 F-1) → AD-42
- **A test that cannot fail its own pass condition** (Sprint 2 F-2) — state which AC clause each test can fail on
- **Chasing the wrong binary** — Q3 sat blocked on the ASK CLI; the tool is the Alexa AI CLI
- **Carrying a candidate list across a channel change.** The phone-era Q6 list assumed caller ID and one listener. Neither holds on a shared device; re-derive from the channel's properties, don't port the list
- **A harness hook that no longer matches the repo's paths fails silently and looks healthy.** Four of seven were inert for three sprints; the smoke test passed because its fixtures used the same stale paths. When a layout changes, re-run every hook against a real path from the new layout
- **A denial the agent can't read is a denial it can't act on.** v1 hooks blocked correctly but printed the reason to stdout; Windsurf delivers stderr to the agent on exit 2. When a hook blocks, check which stream the agent receives
- **A parser that returns empty on the real shape looks like "nothing to check."** v1's `content_of()` missed `tool_info.edits[]`, so the semantic failure check silently never ran. Test hook input parsing against a captured payload, not an imagined one

---

## Task board

| ID     | Task                                    | Status | Notes                                                     |
| ------ | --------------------------------------- | ------ | ----------------------------------------------------------- |
| PL-401 | Q6: the second factor `SPIKE`           | ⬜     | **GATE B-3.** Ask about the phone before the factor       |
| PL-402 | `verify_contact` + elevated tier        | ⬜     | No hangup. Explicit end + TTL + device scope (AD-50)      |
| PL-403 | `authorized_contacts` + OOB delivery    | ⬜     | Now the delivery address for factor two, not factor one   |
| PL-404 | Parent projection + spoken tier         | ⬜     | AD-51 stacks on AD-46                                     |
| PL-405 | Display path via MCP Apps               | ⬜     | No longer a stretch — the only narrow channel (F-29)      |
| PL-406 | Spanish parity                          | ⬜     | 15% of the rubric                                         |
| PL-407 | Degraded path                           | ⬜     | Never partial disclosure                                  |
| PL-408 | Campus pilot                            | ⬜     | Real parents, both languages                              |

---

## Test status

T-01…T-83 carried. Sprint 5 adds T-84…T-95. **T-84 and T-85 need rewriting once Q6 closes.**

---

## Session log

### Session 0 — Sprint 5 drafted (during Sprint 3)

**Context:** AD-48 made Alexa+ the product surface. The parent tier moved from the phone to the shared device.

**Decisions drafted:** AD-49 no factor spoken aloud · AD-50 tier bounded by explicit end, TTL, device scope (supersedes AD-36) · AD-51 what is spoken must be safe for the room.

**Surprises:**

- **Q6 got materially harder, and the old candidate list is void.** It assumed caller ID carried factor one and that a spoken secret reached one ear. On a shared device, a spoken PIN tells the room the PIN — that is a property of the channel, not a weakness of a factor, and it eliminates spoken secrets as a class.
- **The strongest candidate fails the families this product exists for.** Out-of-band push is the best answer and it depends on a smartphone. That tension is the spike's real subject, not the cryptography. E5's segments changed to record it.
- **There is no hangup.** AD-36 let the tier die with a terminated call. Alexa has no equivalent, so the boundary is enforced rather than natural — the weakest part of the design, named as such rather than smoothed over.
- **MCP Apps stopped being a stretch.** With no way to narrow the audience by voice, a screen is the only channel that reaches one person. But a screen in a lobby is read by whoever is close — T-93 is written to produce a finding, not a green check.
- **AD-32 and AD-38 are void on this channel.** Both assumed caller ID. Recorded rather than deleted, so the reasoning survives if the phone capability returns.

**Next action:** open Q6 now.

### Session 0.5 — Harness repair + Jev semantic hooks (2026-09-20 review)

**Decisions made mid-sprint:** the 2026-09-20 harness review found 4 of 7 hooks inert — they matched the canonical v3 layout while all work lives in `sprint-N/`. Repaired on `harness/repair-and-jev`: sprint-aware artifact resolution in `_common.py`, `verify-hooks.sh` now covers 7/7 with sprint-path fixtures, `.windsurf/state/` tracked via README so the documented phase command works on fresh clones, and phase-rule `globs:` extended to `sprint-*/` artifacts. Added the optional Jev layer (`_jev.py`, stdlib-only, fails closed→open: every vendor error returns None = "no opinion", never "no"): `spike-gate` asks per-marker resolution nouls (block <0.35, warn <0.65), `failure-check` semantically matches diffs against this list (advisory, exit 0 always). `TYPESAFE_API_KEY` unset = exactly the old deterministic behaviour; hooks read it from env with a `.env` fallback. First live run correctly blocked `sprint-3/plan.md` — its Spike Results section is all methods, no outcomes.

---

## Deferred

| Item                                       | Target                     |
| ------------------------------------------ | -------------------------- |
| Aircall/phone as an MCP capability         | Sprint 6+, per AD-48       |
| Store certification and listing            | When multi-campus needs it |
| Leadership appointments; document delivery | Sprint 6                   |
| Multi-campus rollout                       | After one campus holds     |
| **Operational readiness: runbook, on-call, failure playbook** | **Unscoped and overdue — six sprints of features, no operations** |