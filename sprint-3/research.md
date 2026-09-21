# research.md — Parent Line

> **Read this first, every session.** Durable context: what was investigated, what was decided, what must not be re-litigated. If a decision here looks wrong, raise it — don't silently reverse it.

**Sprint 3 scope:** the approval path. Structured early-pickup intake, named-approver routing, escalation with a clock, and the first write path that moves a scholar. No parent-facing voice agent, no Alexa surface.
**Last updated:** rev 1 — Sprint 3 opened. §2h/§2i source review, §2j field observation, AD-26…AD-34, leak vectors 16–21, Q11…Q16. Capability accounting in F-18; Sprint 4 committed parent-facing in AD-34. **Rev 2: AD-42 (boundary auditing), from the Sprint 2 evaluation.**

---

## 1. What the product is

**Revised this sprint.** The Sprint 1–2 statement was: a parent asks a routine question and gets a verified answer without pulling staff off dismissal duty. Field observation (§2j) says that statement described the *cheapest* part of the problem.

The revised statement: **routine parent requests are resolved before they become interruptions.** A lookup is answered without staff. A decision — which early pickups require one — is made when the decider is available, not when the parent is standing at security during dismissal.

**The payload is still student education records.** Every design decision is downstream of that. Sprint 3 adds a second fact: **we now store the reason a scholar leaves early**, which is medical content more often than not.

---

## 2. Source review (settled)

### 2a. `serversmx/alexa-mcp` — rejected (unchanged)

Outbound control only (Claude → Echo). No inbound path, stdio-only, auth by scraped Amazon session cookies against an unofficial private API. Its "multi-instance" support is separate auth directories, not tenant isolation.

### 2h. `serversmx/alexa-mcp` — second reading, Sprint 3

Re-read for the **outbound** primitive (`alexa_announce`, `alexa_speak_ssml`) rather than the architecture. Two findings.

**F-6 — Push and pull have different identity problems.** Pull (a parent asks at a device) requires establishing who is asking, which is hardest exactly where we planned to do it. Push to a known contact on file has no such problem — the recipient is already determined. This inverts the AD-17 difficulty and is the observation that led to AD-33.

**F-7 — The unofficial path exists and is rejected.** Cookie auth against a private API, one account's credentials controlling devices, no terms-of-service standing. Recording it explicitly so a future session under deadline pressure does not rediscover it as a shortcut. **It is not available to us at any urgency.**

Every tool in that repo returns `JSON.stringify(entity, null, 2)` into `content` and surfaces raw upstream error strings. Useful as a negative reference for what AD-12 and AD-17 exist to prevent; no code uptake.

### 2i. `awslabs/mcp` — reviewed, partial uptake

60+ production MCP servers plus `DESIGN_GUIDELINES.md`. Three findings.

**F-8 — `src/mcp-lambda-handler` externalizes session state** behind a pluggable `SessionStore` (NoOp | DynamoDB), with auth at an API Gateway Lambda Authorizer ahead of the handler. Our `createMcpApp` keeps sessions in an in-memory `Map` with a TTL sweep — a single-instance assumption. Not urgent (PL-204's worker does not touch sessions), but the trigger condition is recorded in PL-212. Auth-at-the-edge is the structural argument behind the JWKS warm path.

**F-9 — Parameter descriptions as model instructions** ("CRITICAL: Assistant must always provide…"). This is AD-16 with teeth and it is **rejected as a control**. Descriptions reduce wrong-tool selection; they do not enforce anything. Our thesis is that the model is not the thing deciding. Enforcement stays in handlers. Adopted only as copy technique.

**F-10 — Their error handling is worse than ours.** They log, call `ctx.error`, and re-raise. Our typed refusals are strictly better and stay. Tool naming conventions (snake_case, 64-char fully-qualified limit) we already satisfy.

Worth naming: **none of the 60+ reference servers is multi-tenant with row-level isolation.** Most are single-user with credentials from the environment. We are not behind the reference implementations on this axis; we are ahead of them, which means there is no pattern to copy and the isolation gate carries the weight.

### 2j. Field observation — the early-pickup process *(new, primary source)*

Observed at the pilot campus. This is the highest-value research in this sprint and it came from watching, not reading.

**Sequence as it runs today:**

1. Parent calls in the morning (Aircall) or leaves a message — "picking up my scholar at 2:30 for an appointment."
2. Parent arrives at **1:50**, ahead of the stated time, and wants the scholar downstairs immediately.
3. Security calls the coordinator to say a parent is waiting.
4. Coordinator posts to `#eastleaders`, then to the grade channel.
5. Coordinator waits for a leader to verify and give the OK.
6. Scholar is sent to the main office, scans out, a pass is printed, scholar walks down.

**Context that makes it expensive:** this lands inside the dismissal window, when all operators are required on deck and the main office is closed. Parents queue at security asking questions while calls continue landing in Aircall. Operator turnover at this campus is high, so the process runs with reduced and frequently-new staff.

**F-11 — The lookup is not the bottleneck.** Answering "where is my scholar" is seconds of a fifteen-minute process. The cost is an approval chain executed at the worst available moment.

**F-12 — The deciding information existed at 8 am.** The leader wants to know *why* the scholar is leaving early. The parent said why, on the phone, six hours earlier. Nothing captured it structurally, so the question is asked again at 1:50 pm to a leader running dismissal.

**F-13 — `#eastleaders` is the failure mode, not the latency.** The channel contains the principal, the vice principals, the assessment specialist, and all of ops. A request addressed to ~15 people is addressed to nobody. This is diffusion of responsibility, and it is fixed by naming one approver — not by making notification faster. (→ AD-27)

**F-14 — The leader decides; they are not merely informed.** Confirmed with the user. This rules out the cheaper design (capture the reason, notify, proceed) and means the system's job is routing, SLA, and escalation — not automation. What the leader checks is `SPIKE` Q13/Q14.

**F-15 — The routing knowledge is tribal and leaving.** "Which leader for which grade, and who to try next" lives in operators' heads at a campus with high turnover. Encoding it (`approver_routing`) is durable value independent of any voice interface, and is arguably the cheapest high-value artifact in this sprint.

**F-16 — There is a second, distinct request type.** Parents also come in to schedule a call about what happened to their scholar after school. This is an *incident* conversation. It is scheduling only — the agent touches no content. Separate table, separate rules, deferred to Sprint 4.

**F-17 — Aircall is the incumbent channel.** Already the number parents call, already paid for, already carrying the 8 am request, and already the surface that overflows during dismissal.

**F-18 — The pickup spine carries four of the six README capabilities, not six.** Tested against the product definition rather than assumed:

| Capability              | Built?                     | Transfer from the pickup spine                                  |
| ----------------------- | -------------------------- | ----------------------------------------------------------------- |
| Scholar status lookup   | **Yes** — Sprints 1–2      | N/A. Lacks a channel and verification, not logic                 |
| Escalation              | Aspirational until now     | **Full** — AD-26 makes it a mechanism for the first time         |
| Callback requests       | No                         | **Full** — a request type on `pickup_requests`, differing by routing scope |
| Leadership appointments | No                         | **Partial** — routing and SLA transfer; calendar availability does not |
| Document delivery       | No                         | **None** — verification + approved-template library               |
| Greeting & intake       | No (parent-facing)         | Intake exists as a coordinator form; the greeting does not        |

Two consequences. The spine is worth building once rather than as three pipelines — but the claim "this unlocks everything" is false, and stating it would set up a Sprint 5 that discovers document delivery from scratch. And **nothing in Sprint 3 reaches a parent**, which is the real cost of the scope and the reason for AD-34.

---

## 3. Implications (analysis, not doc)

**3h — Moving the decision earlier is the whole intervention.** The approval is not the problem; requesting it at 1:50 pm is. Everything in this sprint serves one outcome: the decision is made while the decider is at a desk. If that holds, the arrival is a scan and a pass.

**3i — A timeout must never approve.** The blocking dependency is on the least-available person in the building, which creates constant pressure toward an auto-approve default. A timeout that releases a scholar without a decision is Rule 10's exact failure mode with our name on it. Expiry escalates, then terminates to in-person handling. (→ AD-26)

**3j — This sprint stores sensitive content on purpose.** Rule 8 (advisor notes) was written to keep medical and family detail *out*. Early-pickup reasons walk it back in through the front door: "doctor," "therapy," "specialist." Default-deny handles it mechanically, but the tier decision must be made before the first row is written, not after. (→ AD-28, Q12)

**3k — Slack is a disclosure surface with retention we do not own.** The reason currently travels over Slack anyway, typed by a coordinator into a channel of fifteen. We are not introducing the exposure; we are bounding one that exists informally. Notifications carry `reason_category` and a link; free text stays in Postgres. Worth stating to leadership in exactly those terms.

**3l — A second authentication scheme enters the system.** Slack request signing, on a write path, in a system holding education records. It gets the scrutiny Sprint 2 gave OAuth. Approve lives there; flag and deny do not — the cases needing a human to look at context are worth a click-through. (→ PL-207)

**3m — The governing SLO changes.** The 500 ms Alexa budget does not apply to this surface. Time-to-decision does, measured in minutes. Say so in the runbook so nobody optimizes the wrong number. A high escalation rate means routing is wrong; a high expiry rate means the policy is wrong.

**3n — Caller ID is a first factor we get for free, and only on the phone.** A match against `authorized_contacts.phone` narrows who is calling. It does not establish it, and no disclosure decision depends on it this sprint. (→ AD-32)

**3o — Two staff-only sprints in a row is a pattern worth naming.** Sprint 2 was staff-only under AD-8 and that was correct: a staff member who sees a wrong answer says so, and every bug caught there is one a parent never hears. Sprint 3 is staff-only for a different and also good reason — the observed cost is in the approval chain. Both are defensible individually. The risk is not either decision; it is that each successive sprint will keep producing a locally good reason while the parent-facing product recedes, and the drift is invisible from inside any single sprint. The counter is a commitment in the artifact rather than an intention. (→ AD-34)

---

## 4. Architecture decisions

AD-1 … AD-25 stand unchanged; see Sprint 2's `research.md` §4 and the reconciled `research/research.md`. **AD-17 is the one most sharpened by this sprint** — see AD-33.

**AD-26** _(new)_ **Approval is a decision, never a timeout default.** Expiry escalates and then terminates to in-person handling. No error path, no timeout, and no degraded mode ever approves a pickup or releases a scholar.
**AD-27** _(new)_ **One named approver, never a channel broadcast.** Routing resolves to a single `approver_id` with a clock. The channel keeps a low-detail visibility thread and stops being the request. Fifteen recipients is zero recipients (F-13).
**AD-28** _(new)_ **`reason_detail` is clearance `never` by default.** Notifications, logs, traces, and tool responses carry `reason_category` and a link. Free text is read in-app, inside a tenant context, audited. The category vocabulary is a constrained enum (F-5 applies).
**AD-29** _(new)_ **A Slack actor decides only through `staff_identities`.** An inbound Slack user id maps to the same audit subject used everywhere else, or it cannot transition a request. Without this, "actor from the token" (E5, Sprint 2) silently becomes "actor from whatever Slack sent" at the single point where a human made a decision about a child.
**AD-30** _(new)_ **Escalation state lives in Postgres, not process memory.** A DB-polled due-queue with `for update skip locked`. An SLA timer must survive restart and must not inherit the single-instance assumption of the in-process sync scheduler. Polling costs one interval of imprecision against an SLA measured in minutes; it buys restart-safety and concurrency-safety with no new infrastructure.
**AD-31** _(new)_ **`service_date` is the grain of the roster.** Sync writes a dated set rather than wiping; reads scope to a date, defaulting to today. The leader's judgment rests on pattern, and a table wiped on every sync cannot supply it. This also gives audit rows a school day to attach to.
**AD-32** _(new)_ **A caller-ID match is an identity signal, not verification.** It pre-fills a draft and narrows who is calling. No disclosure decision depends on it, this sprint or later, without a second factor.
**AD-34** _(new, process; amended under AD-48)_ **Sprint 4 ships the product surface — the Alexa+ channel, staff-facing — and Sprint 5 puts parents on it.** Originally written as "Sprint 4 is parent-facing" when the phone was the planned parent channel. The commitment survives the channel change: parents get a surface within two sprints, and a Sprint 5 that defers them again requires arguing the product thesis at the CEO level rather than adjusting scope. AD-8 justifies one staff-facing pass on a new channel, not two.

The verification work does not dissolve — it moves to Sprint 5 and **gets harder**. On a shared device there is no caller ID, no hangup, no Step-Up Authorization, and a room of listeners, so Q6 is reopened from a no-caller-ID baseline (Sprint 5 research, F-27) and the phone-era candidate list is void. Open it during Sprint 3 or 4: it needs real parents in two languages, which is weeks of elapsed time against an hour of work. The first parent-facing capability remains status lookup, already built since Sprint 1 (F-18), needing only a channel (Sprint 4) and a factor (Sprint 5).

**AD-42** _(new, sourced to the Sprint 2 evaluation)_ **Every rejection is audited at the boundary that rejects it.** A rejection that never reaches a handler has no handler to record it. Sprint 2 carved `tools/call` out of the HTTP layer's audit on the reasoning that "tool calls write their own row" — correct for calls that dispatch, silently wrong for the ones the SDK rejects first (unknown tool name, argument-validation failure). Those produced a `logger.debug` and no `mcp_audit` row, violating E5 while 49 tests stayed green (evaluation F-1). The same evaluation found two sibling tools disagreeing on the identical invalid-args path, which is the tell: the pattern was enforced by memory, not by structure.

**The rule, generally:** auditing belongs where the request enters, not where it succeeds. A handler may enrich the row by `request_id`; it may not be the only thing that writes one.

**Sprint 3 surfaces this rule applies to, before they are built:** PL-207's Slack endpoint rejects unsigned, stale, and replayed payloads **before any handler runs** — auditing there must live at the endpoint boundary or T-65 will pass while the E5-equivalent quietly fails, identically. PL-204's worker has the same shape for rows it skips or cannot transition. PL-209's webhook likewise.

**AD-43** _(new, rev 3)_ **Adoption decisions are tenant provisioning preconditions, not build gates.** A customer's FERPA determination, their channel selection, and their agreement terms are checked when a tenant is provisioned — they never block engineering. The product is opt-in: AllowMe LLC builds the platform, an institution decides whether to adopt it and on which surfaces. Treating a customer's decision as an engineering blocker held the entire roadmap hostage to a question that is not ours to answer. Vendor-side unknowns (such as Amazon's unpublished security policy) are **disclosure obligations** in the assessment packet, not gates on either list.

**AD-33** _(amended, rev 3)_ **The lobby device is descoped as the *parent verification* surface; it returns as a channel under AD-43.** Verification is hardest on a shared device in a public room and easiest on a phone, where caller ID is a free first factor (AD-32) and there is one listener. AD-17's "cannot un-disclose" is largely a lobby-speaker problem. The accessibility win — voice, bilingual, after-hours — is a property of *voice*, not of Echo. **What stands:** verification on a shared device in a public room is genuinely harder than on a phone, and the phone remains the right first parent channel (Sprint 4). **What changed:** "descoped" was doing two jobs — a sound design judgment about verification, and a roadmap exclusion driven by the old Gate 1. The second is withdrawn under AD-43. Alexa+ returns as a channel in Sprint 5, **staff-facing first** per AD-8, with the parent tier on that surface informed by Sprint 4's verification findings. PL-013 Q3 is closed by observation: the tool is the **Alexa AI CLI** (`alexa-ai configure`, Node 24+, credentials at `~/.alexa-ai/credentials`), not the ASK CLI — the question was blocked on the wrong binary.

**AD-52** _(new, PL-212)_ **The session store stays in process memory until a second web instance exists.** The in-memory `Map` in `createMcpApp` holds Streamable HTTP transports only — identity is re-derived from the token on every request (AD-18), so a lost session map costs a client a re-initialize, never an auth bypass or a cross-tenant disclosure. PL-204's escalation worker is a second process and never touches sessions, so the single-instance assumption holds. **Externalization trigger — either forces the move:** (a) a second web instance behind a load balancer — a session initialized on instance A 404s on instance B, and the typed-404-never-silent-upgrade rule (T-47) makes that a hard client failure, not a retry; or (b) autoscaling the web tier. When it fires, the store moves to Postgres — the system of record already in the stack, the same no-new-infrastructure reasoning as AD-30 — not to a cache broker.

---

## 5. Stack

TypeScript / Node 20+ · PostgreSQL 15+ (RLS forced, `parentline_app` non-owner) · Drizzle + explicit SQL migrations · Zod · Vitest against real Postgres, database-per-run · ESLint enforcing Rules 7 and 11 · `@modelcontextprotocol/sdk` Streamable HTTP · Auth0 as AS (PL-101, observed)

**Sprint 3 additions:** a second long-running process (escalation worker, same codebase, same repository layer) · Slack Web API + interaction endpoint with request-signature verification · Aircall webhooks

**Explicitly not added:** no queue broker, no Lambda, no cron service, no scheduler infrastructure. `skip locked` over a table is the cheapest correct answer at this stage (AD-30). Graduate to a broker only when fan-out across services is required.

---

## 6. Constraints and gates

**Restructured, rev 3 (→ AD-43).** The previous list conflated two different kinds of blocker: things that stop us writing code, and things that stop a campus going live. Treating a customer's adoption decision as an engineering blocker was a category error — it held the whole roadmap hostage to a question that isn't ours to answer and doesn't arise until a tenant is provisioned.

### 6a. Build gates — block engineering work

| # | Gate | Blocks | Answerable by |
| - | ---- | ------ | ------------- |
| **B-1** | `reason_detail` clearance and retention (Q12) | PL-202, PL-210 | Leadership + network ops (P3) |
| **B-2** | Escalation ladder and intervals (Q11) | PL-204 | Leadership (P2) |

Both are reachable people answering answerable questions. Neither involves a vendor.

### 6b. Tenant provisioning preconditions — block a campus going live

These are **onboarding checklist line items, not roadmap blockers.** They are checked when a tenant is provisioned, not before code is written. Build, dev-stage deploy, simulator testing, and device testing all proceed without them, because none of that touches real student data (Rule 6).

| # | Precondition | Checked at | Owner |
| - | ------------ | ---------- | ----- |
| **T-1** | Signed agreement; vendor designated a school official under the FERPA §99.31(a)(1) exception, with direct-control and redisclosure terms | Tenant provisioning | Customer's counsel |
| **T-2** | Customer's own assessment of the voice channel for their records | Tenant provisioning | Customer |
| **T-3** | Per-campus channel selection: which surfaces this tenant enables (phone, Alexa+, staff-only) | Tenant provisioning | Customer |

**The product is opt-in.** AllowMe LLC builds the platform; a campus or network decides whether to adopt it and on which channels. The FERPA determination belongs to the institution disclosing the records, not to the vendor building the tool. This is the ordinary edtech posture and it is why these are preconditions rather than gates.

### 6c. Vendor-side unknowns — disclosed, not blocking

**Amazon has not published an Alexa+ security and data policy.** Observed 2026-09-20: the "Security and data policies" section of the Create a Category MCP Add-on guide contains only a note that details will be published in a future revision (page last updated 2026-07-14).

This is **not** a gate on either list. It blocks no engineering and no provisioning. It is a **disclosure obligation**: it goes in the assessment packet a customer's counsel reads at T-1, stated plainly — here is what we control, here is what is pending from Amazon. A customer may reasonably decline the Alexa+ channel on that basis and adopt the phone channel instead, which is exactly what T-3 is for.

Re-check on every Alexa+ sprint open. If Amazon publishes, the packet gets stronger and nothing else changes.

### 6d. Standing constraints

- **FERPA.** Roster data and pickup reasons are education records. Every read and every decision audited.
- **No real student data in this repo. Ever.** Synthetic fixtures only — including synthetic pickup reasons, and including anything exercised through a vendor simulator or a physical device.
- Logs carry `tenant_id`, never student identifiers, and never `reason_detail`.
- Audit and event logs append-only in code and schema.

---

## 7. Known leak vectors

Carried 1–15 from Sprint 2, each with a test. New this sprint:

16. **`reason_detail` reaching a third-party channel** — Slack payload, notification, log, trace, or tool response (AD-28) → T-68
17. **A Slack actor deciding with no audit subject**, leaving a decision attributable only to a Slack user id (AD-29) → T-64, T-67
18. **A cross-tenant `request_id` distinguishable by error shape** — forbidden-but-real versus not-found → T-66
19. **A replayed Slack interaction double-deciding** a request, or reversing a decision → T-54, T-65
20. **Escalation double-firing across workers**, producing duplicate notifications or a skipped ladder rung → T-57, T-61
21. **Dated roster history widening a tenant read** — the `service_date` grain adds rows that previous reads never saw → T-52
22. **A rejection audited nowhere because it never reached a handler** (AD-42) — pre-dispatch rejections on the Slack endpoint, the worker, and the Aircall webhook → T-65, T-61

---

## 8. Open questions

Carried: Q2 (canonical `reason_code` list — network-standard or per campus), Q8 (how academic redo reaches the tracker), Q9 (tenant provisioning ownership), Q10 (audit retention). Q3 **closed** (Auth0, §Spike Results Sprint 2). Q4 and Q7 **parked under AD-33** — Alexa distribution, Amazon policy publication.

**Q6 (parent verification method) is NOT parked.** It moved channel, not status: under AD-33 the question is now "what second factor rides on top of caller ID over the phone," not "PIN or one-time code at a lobby device." **It must close before Sprint 4 planning** (AD-34) and is the one carried question with a hard date.

11. **What is the escalation ladder and what are the intervals?** `SPIKE` — P2, blocks PL-204. Proposed, not chosen: assigned VP → 10 min → principal → 10 min → expire-to-in-person.
12. **What clearance does `reason_detail` carry, and what is its retention?** `SPIKE` — P3, blocks PL-202/PL-210.
13. **Does an approval bind to `pickup_at`?** Can a parent arrive two hours early on an approved request? Determines whether `pickup_at` is advisory or enforced.
14. **Is the assessment specialist a routing scope or visibility only?** Their presence in `#eastleaders` suggests assessment windows block pickups. If so it is a routing scope, not a notification.
15. **Who owns Slack workspace retention**, and what is the policy for messages containing scholar names? (Relates to 3k.)
16. **What does the Aircall API expose** — call events, caller ID, message events — and on what latency? `SPIKE` — PL-209.

---

## 9. Glossary

Carried from Sprint 2. Additions:

**Pickup request** a structured early-departure request, captured at intake · **Approver** the single named leader a request routes to (AD-27) · **Escalation level** how many ladder rungs a request has climbed · **Expiry** terminal state when the ladder is exhausted; never an approval (AD-26) · **Reason category** constrained enum, disclosable · **Reason detail** free text, clearance `never` by default (AD-28) · **Time-to-decision** interval from `routed` to a recorded decision; this sprint's governing SLO

---

## Spike Results

### P2 — Escalation ladder and intervals `SPIKE` (open)

**Question:** Q11. **Blocks:** PL-204.
**Method:** not an engineering spike — a decision meeting with the principal and VPs. Bring the proposal, not the question: assigned VP → 10 min → principal → 10 min → expire. Record what they choose and what they reject.
**A "no timeout, wait indefinitely" answer is a valid result** and reshapes PL-204 into a queue with no clock — which should be escalated, because it reproduces today's failure with better logging.

### P3 — `reason_detail` clearance and retention `RESOLVED` (product default, 2026-09-21)

**Question:** Q12. **Unblocks:** PL-202, PL-210.
**Method:** decision with leadership and network ops. Frame per 3k — the reason already travels over Slack informally; this bounds it. Three sub-answers needed: clearance tier, retention period, and whether `reason_category` may appear in a Slack payload at all.
**Default if unanswered:** `never` for detail, no Slack category. Ship narrower, widen on a written decision.

**Decision (product default, per AD-28 and the research.md P3 fallback):**

- **Clearance:** `reason_detail` is `never`. No tool response, notification, log, or trace returns it. No reason in Slack payloads, category included — this narrows AD-28's notification clause ("notifications carry `reason_category`") until widened by a written decision.
- **Retention:** purge `reason_detail` on terminal state (`completed`, `denied`, `expired`); a nightly sweep purges any remaining at end of `service_date`. `reason_category`, the dated request row, and `pickup_request_events` persist — the leader's pattern judgment rests on those (AD-31), and none of it needs the free text.
- **Retention period is a per-tenant setting** (`tenant_settings`), defaulting to the above. Widening either value requires a written decision recorded in research.md.

Per AD-43 this default is AllowMe's to set: the campus's leadership decides later whether to widen it, and widening is then a config change, not a migration. **Implementation:** the purge is enforced in the pickup-request transition function (PL-202) — at the chokepoint, not filtered downstream (the Rule 8 discipline). `reason_category` ships with a five-value product-default enum (`appointment`, `family`, `illness`, `administrative`, `other`), widened the same way.

### PL-209 — Aircall capability probe `SPIKE` (open)

**Question:** Q16.
**Method:** verify **by observation, not documentation** — the PL-101 lesson. Confirm: inbound call webhook fires with caller number; voicemail/message events are distinguishable from calls; delivery latency is seconds not minutes; retry semantics on our 5xx.
**A "webhooks are unreliable or delayed" outcome is a valid result** — intake falls back to fully coordinator-entered, and PL-209 shrinks to a form.

---

## Changelog

| Rev | Date       | Change                                                                                                                         |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-09-20 | Sprint 3 opened. §2h/§2i source review, §2j field observation (F-11…F-18), §3h…§3o, AD-26…AD-34, leak vectors 16–21, Q11…Q16, three spikes |
| 2   | 2026-09-20 | **AD-42 added, sourced to the Sprint 2 evaluation (F-1).** Leak vector 22. Applies to PL-207, PL-204, PL-209 before they are built |
| 3   | 2026-09-20 | **§6 restructured: build gates / tenant preconditions / vendor disclosures (AD-43).** AD-33 amended — Alexa+ returns as a channel. Q3 closed: Alexa AI CLI, not ASK CLI. Amazon policy status observed 2026-09-20 |
| 4   | 2026-09-20 | **AD-48: Alexa+ is the product surface.** Sprint 4 = Alexa+ staff-facing; Sprint 5 = parent tier there; Aircall demoted to a later capability. AD-34 amended. Q6 reopened from a no-caller-ID baseline |
| 5   | 2026-09-21 | **AD-52: session-store externalization trigger recorded (PL-212).** In-memory session Map holds while there is one web instance; a second instance or autoscale moves it to Postgres. T-72 written: the first authenticated request on a fresh process is served from the startup-warmed JWKS cache — no fetch on the request path |
| 6   | 2026-09-21 | **P3 resolved as a product default (AD-28 fallback + AD-43): clearance `never`, no Slack category, purge at terminal state + end-of-service-date sweep, per-tenant retention setting.** Unblocks PL-202 and, with it, PL-203/205/206/208/210/211. PL-204 still waits on P2 |