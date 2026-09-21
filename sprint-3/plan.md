# plan.md — Sprint 3: The Approval Path

**Sprint goal**

> Move the early-pickup decision from arrival-time to request-time. A parent's morning call becomes a structured request with the reason attached, routed to one named approver with an escalation clock. The coordinator stops running a Slack scramble at 1:50 pm during dismissal.

**Duration:** 3 weeks. Sprint 1 ran 19 sessions against a 2-week plan; Sprint 2 ran ~8 against 3 weeks. Slack is this sprint's variance.

**Companion artifacts:** `sprint-3/research.md` (durable context, AD-26…AD-33, spikes) · `sprint-3/test.md` (T-50…T-73) · `sprint-3/progress.md` (task board, Failed Approaches). Decisions settled here land in `research/research.md` §4 the same session.

---

## Why this sprint is not the parent voice agent

Sprint 3 was scoped, through two sprints, as "parent verification and tiering." That scope came from the original sketch — a parent walks up to a lobby Echo and asks where their scholar is. Field observation (research.md §2j) says the sketch was wrong about which problem costs the most.

Observed: a parent calls in the morning to schedule a 2:30 pm pickup. They arrive at 1:50. Security calls the coordinator. The coordinator posts to `#eastleaders`, then the grade channel, and waits for a leader to approve. Only then does the scholar get sent down, scan out, and receive a printed pass. This runs inside the dismissal window, with every operator committed and the main office closed, while parents queue at security and calls keep landing in Aircall — at a campus with high operator turnover.

Three findings follow (F-11 … F-13):

**The lookup is not the bottleneck.** Answering "where is my scholar" is seconds of a fifteen-minute process.

**The deciding information existed at 8 am.** The leader wants to know why the scholar is leaving early. The parent said why, on the phone, six hours earlier. Nothing captured it structurally.

**The channel is the failure, not the speed.** `#eastleaders` holds the principal, the vice principals, the assessment specialist, and all of ops — a request addressed to fifteen people is addressed to nobody. Fixed by naming one approver, not by faster notification.

The leader **decides** (F-14) — they are not merely informed. So the system's job is routing, SLA, and escalation. Not automation.

---

## Capability coverage

The six capabilities in the README are the product. This sprint does not deliver all of them, and the honest accounting matters more than the argument for the scope.

| Capability                | State after Sprint 2                          | Sprint 3 contribution                                                                      | Reaches a parent |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| **Scholar status lookup** | **Built.** Core + 3 MCP tools, staff-reachable | None. Unchanged — it lacks a channel and verification, not logic                           | **Sprint 4**     |
| **Escalation**            | Aspirational — typed refusals, no mechanism    | **Delivered.** AD-26 ladder, clock, expire-to-in-person, audited. First time it is real    | Sprint 4         |
| **Callback requests**     | Not built                                     | **Spine built.** Same primitive as pickup: structured request → named approver → clock      | Sprint 4         |
| **Leadership appointments** | Not built                                   | **Spine built, partially.** Routing and SLA transfer; calendar availability does not        | Sprint 5         |
| **Document delivery**     | Not built                                     | **No transfer.** Verification + approved-template library; shares nothing with the spine    | Sprint 5         |
| **Greeting & intake**     | Not built                                     | Intake exists as a coordinator-entered form (PL-209); no parent-facing greeting             | Sprint 4         |

**Read the right-hand column as the cost of this sprint.** Nothing reaches a parent in Sprint 3. The deliverables go to the coordinator and to leadership.

**And read the middle column as the reason it is still the right sprint.** Callback requests and appointments are not separate subsystems — they are request types on the `pickup_requests` spine, differing by `request_type` and routing scope. Building that spine once, against the case with the most observed pain and the hardest failure mode, is cheaper than building three request pipelines. But the transfer is not total: appointments need calendar availability, and document delivery shares nothing with this work. Four of six, not six of six.

---

## Exit criteria

Graded **separately from the rubric** (AD-14). A criterion requiring a measurement is unmet until the number is recorded.

| #   | Criterion                                                                                                                      | Met by                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| E1  | One week live at one campus: every early-pickup request captured at intake, none created after the parent arrives               | Observation, not tests        |
| E2  | Median **time-to-decision** recorded, with the pre-sprint baseline from P1 alongside it                                         | P1 baseline + T-73            |
| E3  | Zero scholars released without a recorded decision. A timeout produces `expired` and an in-person handoff — never auto-approval | T-60, T-62, observation       |
| E4  | `reason_detail` never leaves Postgres: absent from every Slack payload, notification, log, trace, and tool response             | T-68, T-69, adversarial pass  |
| E5  | Every decision audited with an actor resolved through `staff_identities` — no decision attributable only to a Slack user id     | T-64, T-67                    |
| E6  | Zero cross-tenant leakage through the new tables and the Slack surface, including a forged `request_id` from another tenant     | T-52, T-66                    |

**E2 is a measurement, not a target.** We do not yet know the baseline. Setting a goal before P1 reports would be inventing one.

---

## Prerequisites

| #   | Item                                                                                                                                                               | Blocks                             | Runs in parallel?   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------- |
| P1  | **Measurement week.** Early pickups per day · how many were called in that morning · minutes from Slack post to leader response. Three numbers, one week, manual tally | E2, and the sprint's justification | **Yes — start now** |
| P2  | **Escalation policy in writing** from leadership: the ladder, the intervals, what happens on expiry                                                                | PL-204                             | No                  |
| P3  | **`reason_detail` clearance + retention decision** from leadership and network ops                                                                                 | PL-202, PL-210                     | No                  |
| P4  | **Sprint 2 closure:** PL-112 complete, soak at 10/10 business days, Sprint 1 evaluation re-issued                                                                   | Sprint 2 closure only              | Yes                 |

**If P1 reports that early pickups are rare, or that leaders already respond in under two minutes, stop and re-plan.** The sprint's justification is that a measurable wait exists. "There is no wait" is a valid and cheap result.

**P2 is a policy answer, not an engineering one.** We can propose a ladder (assigned VP → 10 min → principal → 10 min → expire) but we must not pick it. A system that releases a scholar on our invented default is a wrong answer about a child with our name on it.

---

## In scope

`service_date` grain and `student_id` linkage · `pickup_requests` state machine · per-tenant approver routing · escalation worker (DB-polled, `skip locked`) · Slack actor mapping and outbound notification · Slack approve-only interaction endpoint · in-app flag/deny via MCP tools · disclosure extension for `reason_category` vs `reason_detail` · Aircall intake webhook with caller-ID matching · time-to-decision instrumentation · one-week campus pilot

## Out of scope

Parent-facing voice agent · Alexa+ deployment of any kind · lobby device · parent verification and elevated tier · speech-to-text on the intake call · document email · appointment booking · broadcast notifications to parents · Spanish (intake is staff-entered this sprint) · after-school incident callbacks

> Out of scope means **do not scaffold it "for later."**

---

## Descoped, with reasoning

**The lobby Echo is removed from the architecture, not deferred** (AD-33). It was carried for two sprints as "blocked on Gates 1 and 3"; observation says it was also solving the wrong problem. Reasoning recorded so a future sprint does not rediscover the sketch:

- Verification is hardest on a shared device in a public room and easiest on a phone, where caller ID against `authorized_contacts.phone` is a free first factor (AD-32).
- AD-17's "cannot un-disclose" is largely a lobby-speaker problem. One listener on a handset shrinks it.
- Aircall is already the number parents call, already paid for, already carrying the 8 am request (F-17).
- The accessibility win — voice, bilingual, after-hours — is a property of voice, not of Echo.

Alexa+ certification work (Functional Requirements, Policy Requirements, Display Modes), MCP Apps, and PL-013 Q3 move to the deferred table with no target sprint. **Sprint 2's E6 should now close as "Q2 answered, Q3 descoped" rather than staying open.**

---

## Architecture decisions

AD-26 … AD-33 are defined in `sprint-3/research.md` §4 and summarized here:

| AD    | Decision                                                                    |
| ----- | ----------------------------------------------------------------------------- |
| AD-26 | Approval is a decision, never a timeout default                             |
| AD-27 | One named approver, never a channel broadcast                               |
| AD-28 | `reason_detail` is clearance `never` by default; notifications carry category |
| AD-29 | A Slack actor decides only through `staff_identities`                       |
| AD-30 | Escalation state lives in Postgres, not process memory                      |
| AD-31 | `service_date` is the grain of the roster                                   |
| AD-32 | A caller-ID match is an identity signal, not verification                   |
| AD-33 | The lobby device is descoped; the phone is the parent channel               |
| AD-42 | Every rejection is audited at the boundary that rejects it *(from the Sprint 2 evaluation, F-1)* |

---

## Task status convention

Unchanged from Sprint 2. ⬜ not started · 🟡 in progress · 🔵 **code-complete, AC unverified** · ✅ AC met and verified · 🔴 blocked · ⏸️ paused. **🔵 is not ✅.**

---

## Tasks

### PL-201 — Roster grain: `service_date` + `student_id` linkage

Add `service_date date not null` to `roster_entries` and `roster_syncs`. Sync writes a dated set; reads scope to a date, defaulting to today. Populate `roster_entries.student_id` at ingest by resolving `student_ref` against `students`, inserting the student row when absent.

Carried from the Sprint 2 review as housekeeping; it is not housekeeping. Routing resolves by section and grade, and the leader's decision rests on history — neither works against a table wiped on every sync that never populates `student_id`.

**AC:** T-50, T-51, T-52 pass. Two consecutive days coexist; today's lookup is unaffected by yesterday's rows; every ingested row has a non-null `student_id`; dated reads are tenant-scoped across every date scope.

### PL-202 — `pickup_requests` schema + state machine [PL-201, P3]

Table with `tenant_id`, `service_date`, `student_id`, `pickup_at`, `reason_category`, `reason_detail`, `requested_by_contact_id`, `intake_channel`, `state`, `assigned_approver_id`, `escalation_level`, `escalate_at`, decision and release timestamps. RLS enabled **and forced**, same grants posture as existing tables.

`pickup_request_events` append-only, with `unique (request_id, escalation_level)` so a double-fire cannot double-notify. INSERT and SELECT only; UPDATE and DELETE revoked at the grant level.

States: `draft → routed → approved | flagged | denied → released → completed`, plus `expired` terminal off `routed`. **All transitions go through one function.** No handler writes `state` directly — the same chokepoint discipline as `project()`.

`reason_category` is a constrained enum (F-5: free text is what happens without controlled vocabulary).

**AC:** T-53…T-57 pass. Every illegal transition is a typed refusal; the transition function is idempotent on an already-decided request and returns current state rather than erroring.

### PL-203 — Approver routing resolver [PL-202]

`approver_routing (tenant_id, scope_type: section | grade | default, scope_value, approver_id, priority)`. Most specific match wins; a `default` row is required per tenant so resolution is total.

This table is the tribal knowledge that currently leaves the building with every operator who quits (F-15). Treat it as a deliverable, not as config.

**AC:** T-58, T-59 pass. Resolution deterministic and total; a tenant with no `default` row fails at seed time, not at 1:50 pm.

### PL-204 — Escalation worker [PL-202, P2]

Poll loop over `state = 'routed' and escalate_at < now()` with `for update skip locked`, batch-limited. Advances `escalation_level`, reassigns per the P2 ladder, terminates to `expired` at the top.

Per AD-26: **expiry never approves.** It produces a typed outcome routing the coordinator to in-person handling.

Per AD-42, the poll loop **is** this component's boundary — it has no HTTP layer. A row skipped or failing to transition is audited there; a silently skipped row is the same gap as an unaudited rejection.

**AC:** T-60…T-63 pass, including two workers racing the same due row, a restart mid-ladder, and a forced worker exception. Skipped and failed rows produce audit records. The configured ladder matches the P2 decision as recorded in research.md.

### PL-205 — `staff_identities` + Slack actor mapping [PL-202]

`staff_identities (tenant_id, slack_user_id, subject, role)`. Maps an inbound Slack actor to the audit subject used everywhere else. An unmapped `slack_user_id` cannot transition a request — typed refusal, audited (AD-29).

**AC:** T-64, T-67 pass. Zero decision rows whose actor is only a Slack user id.

### PL-206 — Slack notification surface (outbound) [PL-203, PL-205]

DM to the named approver; low-detail thread in `#eastleaders` for visibility. Payload carries scholar name, pickup time, `reason_category`, and a link. **`reason_detail` is never in a Slack payload** (AD-28).

**AC:** T-68 passes, including the sentinel-string adversarial case across every notification path and error path.

### PL-207 — Slack interaction endpoint (inbound) [PL-206]

Approve-only. Request-signature verification, replay window, at-least-once delivery handled idempotently by request id.

This is the sprint's auth risk: a **second authentication scheme** entering a system holding student records, on a write path. It gets the scrutiny Sprint 2 gave OAuth. `flag` and `deny` deliberately do not live here — the cases needing a human to look at context are worth a click-through to the app (PL-208), which means the fast path and the sensitive path have different bars.

Per **AD-42**, auditing lives at the **endpoint boundary, not in the handler.** These rejections fire before any request handler runs, so a handler-level audit records nothing — which is precisely how Sprint 2 shipped a violated E5 alongside 49 green tests (evaluation F-1). A handler may enrich a row by `request_id`; it may not be the only thing that writes one.

**AC:** T-65, T-66 pass. Unsigned, stale, and replayed payloads each rejected distinctly **and each writing an audit row queried by `request_id`** — asserted, not inferred from a log line. A `request_id` from another tenant resolves as not-found, in message, code, and timing.

### PL-208 — MCP tools: request lifecycle [PL-202, PL-210]

Three staff tools, each with a minimum field set (AD-17) and a description written as customer-facing copy (AD-16), deliberately disjoint from one another and from the Sprint 2 tools:

- `create_pickup_request` — coordinator-entered intake
- `list_pending_approvals` — an approver's queue for today
- `decide_pickup_request` — approve, flag, or deny with a note

Per AD-15, every declared parameter is implemented or absent from the schema. Schema registry fingerprint extended.

**AC:** T-70 passes. Each response carries exactly its minimum set on success **and** refusal; descriptions disjoint; a schema change without a version bump fails CI.

### PL-209 — Aircall intake webhook [PL-202]

**Probe before building** (research.md §Spike Results — verify by observation, not documentation; this is the PL-101 lesson). Inbound call event creates a `draft` pre-filled with the caller-ID match against `authorized_contacts.phone`. The coordinator completes reason and pickup time; nothing auto-submits.

**A caller-ID match is an identity signal, not verification** (AD-32). No disclosure decision depends on it.

Webhook validation failures are audited at the endpoint boundary (AD-42), not inside a handler that a rejected payload never reaches.

**AC:** T-71 passes. An unmatched or near-match number produces a draft with no contact linked, never a guessed one.

### PL-210 — Disclosure extension [PL-202, P3]

`FIELD_CLEARANCE` gains the new fields; `reason_detail` lands as `never` pending P3. `reason_category` gets its own tier. `TOOL_MINIMUM_FIELDS` extended for the three new tools.

Also closes a Sprint 2 review finding: demote `reason_code` from `staff` to a tier consistent with the README's "the reason goes to a private channel." It is currently kept out of responses only by the minimum-set gate, with clearance alone permitting it.

**AC:** T-69 passes. A new column on any Sprint 3 table is absent from every response without a clearance entry.

### PL-211 — Time-to-decision instrumentation [PL-202, PL-204]

Median and p90 time-to-decision, escalation rate, expiry rate, decision mix by approver. Per-tenant.

The Alexa 500 ms budget is no longer the governing SLO for this surface — state that in the runbook so nobody optimizes the wrong number. A high escalation rate means routing is wrong; a high expiry rate means the policy is wrong.

**AC:** T-73 passes. E2's number recorded with its conditions, alongside the P1 baseline.

### PL-212 — JWKS warm path + session-store decision [carry-over]

Fetch JWKS at startup and refresh on a timer. A cold fetch in the request path is a defect, not a cost — measured at up to 500 ms against a 300 ms criterion.

Session store: **decide and record**, do not necessarily build. The in-memory `Map` in `createMcpApp` is a single-instance assumption. PL-204's worker is a second process but does not touch sessions, so the assumption holds for now. Write the trigger condition that forces externalization (a second web instance, or autoscale) into research.md.

**AC:** T-72 passes — a cold-start request is served from a warm cache. The session-store trigger condition is recorded.

### PL-213 — Campus pilot [all]

One week live at one campus. Every early-pickup request goes through the system. Coordinator and at least two approvers using it daily.

**AC:** E1, E2, E3. Findings recorded regardless of outcome.

---

## Sequencing

```
P1 measurement ──── runs now, reports end of week 1 ──────────────────┐
P2 policy ──→ PL-204                                                  │
P3 clearance ──→ PL-202, PL-210                                       │
                                                                      ▼
PL-201 ─→ PL-202 ─┬→ PL-203 ─┬→ PL-206 ─→ PL-207 ─┐
                  ├→ PL-204 ─┘                     ├→ PL-213
                  ├→ PL-205 ───────────────────────┤
                  ├→ PL-210 ─→ PL-208 ─────────────┤
                  ├→ PL-209 ───────────────────────┤
                  └→ PL-211 ───────────────────────┘
PL-212 ─── independent, any week ─────────────────────────────────────
```

**Week 1:** P1 running. PL-201, PL-202, PL-212. Do not start PL-204 before P2 lands.
**Week 2:** PL-203, PL-204, PL-205, PL-210, PL-211.
**Week 3:** PL-206, PL-207, PL-208, PL-209, then PL-213.

**If P1 reports no measurable wait, stop and re-plan.**

---

## Sprint Contract

### Rubric

| Category                        | Weight  |
| ------------------------------- | ------- |
| **Disclosure & Data Integrity** | **40%** |
| Auth & Security                 | 25%     |
| Functionality                   | 25%     |
| Design                          | 10%     |

Weighting shifts from Sprint 2's auth-heavy 50%. Auth remains serious — PL-207 adds a second scheme on a write path — but this is the first sprint that **stores sensitive content on purpose** and the first with a write path that **moves a child out of a building**. Disclosure and integrity carry the most weight.

Pass threshold ≥90% weighted, **and** zero hard-fails, **and** the isolation gate green.

### Hard-fail conditions — any one fails the sprint

1. Any of T-01…T-05, T-33…T-35, or T-52 / T-60 / T-68 failing or unwritten (the standing gate, widened)
2. `reason_detail` present in any Slack payload, notification, log, trace, or tool response
3. A scholar released, or a request approved, without a recorded human decision
4. A timeout, error, restart, or retry path that auto-approves
5. A decision attributable only to a Slack user id, with no `staff_identities` mapping
6. A tool schema accepting a tenant parameter, or a forged tenant argument honored
7. A state transition written outside the transition function
8. A rejection path on any new surface — Slack endpoint, worker, webhook — that writes no audit row (AD-42)
9. Real student data anywhere in the repo

### Evaluator requirements

- `.windsurf/state/phase` set to `evaluation` before the run; flip back to `implementation` after
- Grade against `sprint-3/plan.md` + `sprint-3/test.md` only. **Do not read `sprint-3/progress.md`**
- `DATABASE_URL` / `APP_DATABASE_URL` exported — vitest does not load `.env`; do not `source .env`
- Generator-side observations recorded in progress.md are **not** findings; reach your own independently
- Exit criteria graded separately from the rubric (AD-14)
- A finding is required, or an explicit statement that one was sought and not found
- **Check rejection paths for audit rows, not for log lines** (AD-42). Sprint 2's F-1 was reachable behavior no green test covered; assume the class recurs on every new surface until proven otherwise

---

## Sprint 4 commitment — the product surface (AD-34, amended under AD-48)

**This is a commitment in the plan, not an intention in someone's head.** **Amended 2026-09-20 under AD-48:** Sprint 4 delivers the **Alexa+ channel, staff-facing** — the product surface. The parent tier is Sprint 5, on that same surface. The interim plan routed parents through Aircall first; the phone is now a later capability on the same MCP server, not a channel.

It exists because Sprint 3 is the **second consecutive staff-only sprint.** Sprint 2 was staff-only deliberately under AD-8, and that was right — every bug found by a staff member who can say "that's wrong" is one a parent never hears. Doing it twice is defensible. Doing it three times is how a parent-facing product stays permanently one sprint away, and the drift is invisible while each individual sprint has a good reason.

So the commitment binds:

- **Sprint 4 ships the product surface; Sprint 5 puts parents on it.** A Sprint 5 that defers parents again requires arguing the product thesis at the CEO level, not adjusting scope. AD-8 justifies one staff-facing pass on a new channel — not two.
- **The verification work moves to Sprint 5 and got harder, not easier.** Q6 is reopened from a no-caller-ID baseline (Sprint 5 research F-27): no caller identity, a room of listeners, no hangup, no Step-Up. Open it during Sprint 3 or 4 — it needs real parents and weeks of elapsed time.
- **The channel is Alexa+** (AD-48). AD-32 and AD-38 are void there — caller ID does not exist on a shared device. `authorized_contacts` becomes the delivery address for an out-of-band factor (AD-49).
- **The first parent-facing capability is status lookup only.** Already built since Sprint 1; it needs a channel (Sprint 4) and verification (Sprint 5). Appointments, callbacks, and document delivery follow.

**Entry condition:** E1 and E2 reported. If time-to-decision did not move, that is a finding about the approval path — it does not defer the channel, since Sprint 4 is an integration that does not depend on it.

---

## Deferred

| Item                                                                          | Surfaced        | Target                            |
| ------------------------------------------------------------------------------- | --------------- | --------------------------------- |
| **Alexa+ channel, staff-facing — the product surface**                        | Sprint 3        | **Sprint 4 — committed (AD-34/48)** |
| **Parent tier on Alexa+ + verification (Q6, reopened)**                        | Sprint 3        | **Sprint 5**                      |
| Aircall/phone as an MCP capability                                            | Sprint 3        | Sprint 6+, per AD-48              |
| Callback requests as a `pickup_requests` request type                         | Sprint 3        | Sprint 4                          |
| After-school incident callback scheduling (F-16, scheduling only, no content)  | Sprint 3        | Sprint 4                          |
| Leadership appointments — needs calendar availability beyond the spine        | Sprint 3        | Sprint 5                          |
| Document delivery — verification + approved-template library, no spine transfer | Sprint 3      | Sprint 5                          |
| Speech-to-text reason capture on the intake call                              | Sprint 3        | Sprint 5+                         |
| Broadcast notifications to parents (consent, opt-out, TCPA)                   | Sprint 3        | **Not scoped — a second product** |
| Alexa+ certification docs · PL-013 Q3 · MCP Apps · lobby device               | Sprint 2        | **Descoped under AD-33**          |
| Per-tenant validation sets (`VALID_ATTENDANCE_STATUSES`, `VALID_REASON_CODES`) | Sprint 2 review | Before campus two                 |
| Session store externalization                                                 | Sprint 2 review | On trigger (PL-212)               |
| Does eSD expose an API that supersedes the Sheets connector?                   | Sprint 1        | Sprint 4 research                 |

---

## Definition of sprint complete

- [ ] All six exit criteria met (E1–E6)
- [ ] All 13 tasks ✅ (not 🔵)
- [ ] T-01…T-73 written and passing
- [ ] Zero hard-fail conditions triggered
- [ ] Evaluator produced at least one finding, or stated one was sought and not found
- [ ] Evaluator confirmed the phase file was set to `evaluation`
- [ ] `research/research.md` reconciled — AD-26…AD-33 in §4, decisions table all ✅
- [ ] P1 baseline and E2 measurement recorded side by side
- [ ] Sprint 4 scope drafted