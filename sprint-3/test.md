# test.md — Sprint 3

**Carried forward: T-01 … T-49 run every sprint.** The isolation gate never retires. A Sprint 3 change that breaks Sprint 1 or 2 isolation is the most likely way this project leaks.

**The gate widens again.** T-52, T-60, and T-68 join T-01…T-05 and T-33…T-35 as stop-the-line. Sprint 1's risk was a query missing a filter. Sprint 2's was a token that shouldn't work, working. **Sprint 3's is a scholar leaving the building without a decision, or a medical reason arriving in a Slack channel.**

---

## Strategy for this sprint

**Test the write path like a liability, not a feature.** Every previous sprint was read-only; being wrong meant a bad answer. This sprint moves a child out of a building. The tests that matter most are the ones asserting what *cannot* happen: no approval without a decider, no release without an approval, no reason text outside Postgres.

**Test the timeout, not just the happy path.** The escalation ladder is where this design is most likely to quietly acquire an auto-approve — through a default parameter, a permissive `case` fallthrough, an error handler that swallows, or a "temporary" unblock during the pilot. T-60 exists because that pressure is real and constant.

**Test concurrency for real.** The escalation worker is the first component that can run in more than one process. `skip locked` is correct; asserting it requires two workers racing the same due row, not one worker and an assumption.

**Test Slack as untrusted input.** It is a second auth scheme on a write path. Unsigned, stale, and replayed payloads each get their own test and their own distinct rejection — a generic 400 hides which control fired, and this is the control nobody will remember the details of in six months.

**Assert the audit row, not the log line.** Per AD-42, a rejection is audited at the boundary that rejects it. Sprint 2 shipped a green suite alongside a violated E5 because the rejections that mattered never reached a handler, and no test asked whether a row existed. Every rejection test in this sprint queries `mcp_audit` by `request_id` rather than trusting that logging implies auditing.

**Existence must not be inferable across tenants — now through a new identifier.** `request_id` joins `student_ref` and `student_name` as something an attacker can guess at. A forbidden-but-real response and a not-found response must be indistinguishable in message, code, and timing.

**Note on T-68 vs the audit log.** These look contradictory and aren't. `reason_detail` is written to Postgres and read in-app under a tenant context with an audit entry; that is disclosure *through the chokepoint*. T-68 forbids it leaving through any path that isn't the chokepoint — notification, log line, trace, tool response, error message. Stored-and-projected is the design; stored-and-echoed is the leak.

---

## Roster grain — T-50 … T-52

### T-50 · Two service dates coexist

Ingest a roster for day 1, then day 2. Query today.
**Pass:** both dates present in `roster_entries`; today's status lookup returns only today's rows; yesterday's rows are unchanged and unreachable from a default-scoped read.
**Fail:** day 2's sync wiped day 1, or a dated read returned rows from both.

### T-51 · Student linkage complete

Ingest a sheet containing a `student_ref` not yet in `students`.
**Pass:** every resulting `roster_entries` row has a non-null `student_id`; the absent student was inserted, not skipped, and not duplicated on re-sync.

### T-52 · Dated read is tenant-scoped **(GATE)**

Tenant A and tenant B both have rosters for the same `service_date`, including a colliding `student_ref`.
**Pass:** A's dated read returns A's rows only, across every date scope including an explicit historical date.
**Fail (critical):** any cross-tenant row. The `service_date` grain adds rows previous reads never saw — this is leak vector 21.

---

## Request lifecycle — T-53 … T-57

### T-53 · Illegal transition refused

Attempt `draft → approved`, `expired → approved`, `completed → routed`.
**Pass:** each is a typed refusal naming the attempted transition; no state change; an event row records the attempt.

### T-54 · Transition idempotent on an already-decided request

Submit the same approval twice with the same request id — the Slack at-least-once case.
**Pass:** the second call returns the current state and is a no-op. **Fail:** an error the caller cannot distinguish from a real failure, or a second decision row.

### T-55 · State written only through the transition function

Structural. Grep plus lint: no `update pickup_requests set state` outside the transition module; the repository layer exposes no direct state setter.
**Pass:** zero occurrences. Same chokepoint discipline as `project()` — a single bypass is how the state machine stops being one.

### T-56 · Event log append-only

Attempt UPDATE and DELETE on `pickup_request_events` as `parentline_app`.
**Pass:** both rejected at the grant level, not by application code. Mirrors T-10.

### T-57 · Double-fire blocked at the schema

Insert two events for the same `(request_id, escalation_level)`.
**Pass:** the unique constraint rejects the second. The guarantee is in the database, so a retry, a race, or a redeployed worker cannot double-notify.

---

## Routing — T-58 … T-59

### T-58 · Resolution is deterministic, most-specific-wins, and total

Tenant with `default`, a `grade` rule, and a `section` rule that all match one scholar.
**Pass:** the section rule wins; the same input always resolves to the same approver; every scholar resolves to exactly one.

### T-59 · A tenant without a default routing rule fails at seed

**Pass:** seeding or migrating a tenant with no `default` row fails loudly.
**Fail:** it succeeds and the first unmatched request resolves to nobody — at 1:50 pm, which is the moment this whole sprint exists to protect.

---

## Escalation — T-60 … T-63

### T-60 · Expiry never approves **(GATE)**

Drive a request through the full ladder with no response at any rung. Also: force an error inside the worker mid-ladder, and kill the worker between rungs.
**Pass:** terminal state is `expired`, with a typed outcome routing to in-person handling. No path — timeout, error, restart, or default — produces `approved` or `released`.
**Fail (critical):** any of them does. This is AD-26 and hard-fail condition 4.

### T-61 · Concurrent workers do not double-escalate

Two workers polling the same due row simultaneously.
**Pass:** exactly one advances it; the other skips. One notification, one event row, one level increment.
**Also assert (AD-42):** a row the worker skips or cannot transition produces an audit record. The worker has no HTTP boundary, so its poll loop *is* the boundary — a silently skipped row is the same gap as an unaudited rejection.

### T-62 · Restart mid-escalation resumes

Kill the worker after `escalate_at` passes but before the transition commits; restart.
**Pass:** the request escalates once on resume, at the correct level. No state was held in process memory (AD-30).

### T-63 · The ladder matches the recorded policy

Assert the configured ladder and intervals against the P2 decision as written in research.md.
**Pass:** they match, and the test fails if the config drifts from the recorded policy. We must not be running a ladder leadership did not choose.

---

## Actor and inbound auth — T-64 … T-67

### T-64 · An unmapped Slack actor cannot decide **(gate-adjacent)**

A correctly-signed interaction from a `slack_user_id` with no `staff_identities` row.
**Pass:** typed refusal, audited, no state change.
**Fail (critical):** the decision lands with an actor that is only a Slack user id. Leak vector 17, hard-fail condition 5.

### T-65 · Unsigned, stale, and replayed payloads each rejected distinctly **and audited**

Three separate cases: missing or wrong signature; a timestamp outside the replay window; a valid payload replayed after its window.

**Pass, part one — rejection:** each rejected, each with a distinct logged reason, none revealing signing material. Mirrors the T-25…T-28 discipline — four failures that all look alike make production debugging impossible.

**Pass, part two — audit (AD-42):** **each rejection writes an audit row**, queried by `request_id` after the call. Assert the row exists; do not infer it from a log line.

Part two is not decoration. In Sprint 2 the equivalent gap shipped green: `tools/call` rejections raised by the SDK before dispatch produced a `logger.debug` and no `mcp_audit` row, violating E5 while the suite passed 49/49 (evaluation F-1). **These Slack rejections have the same shape** — they fire before any request handler runs, so a handler-level audit records nothing. A T-65 that asserts only the rejection will pass in exactly the state that failed last sprint.

Auth failures have no tenant context, so these rows follow the AD-21 pattern: NULL tenant, no student data, outcome code and latency only.

### T-66 · A cross-tenant `request_id` is not-found, never forbidden-but-real

A signed interaction from tenant A's approver carrying tenant B's `request_id`.
**Pass:** resolves as not-found. Message, error code, **and timing** are indistinguishable from a genuinely nonexistent id. Extends T-42's method to a new identifier.

### T-67 · Every decision is audited with a resolved subject

**Pass:** each decision row carries the `staff_identities` subject, the tenant, the request, the decision, and the channel it arrived through. Zero decision rows whose actor is only a Slack user id.

---

## Disclosure — T-68 … T-70

### T-68 · `reason_detail` never leaves Postgres **(GATE)**

Adversarial. Create a request whose `reason_detail` contains a unique sentinel string. Then exercise: the approver DM, the channel thread, every log line, every trace span, every tool response on success and refusal, and every error path including a forced worker exception.
**Pass:** the sentinel appears nowhere outside the database and the audited in-app read.
**Fail (critical):** anywhere else. AD-28, leak vector 16, hard-fail condition 2.

### T-69 · A new column on a new table is absent without a clearance entry

Add a column to `pickup_requests`, return it from nothing, and assert it cannot appear.
**Pass:** absent from every response. Extends T-36 to the Sprint 3 tables — default-deny has to hold on the tables that carry the sensitive content, not just the ones it was written for.

### T-70 · Minimum field set per new tool

For `create_pickup_request`, `list_pending_approvals`, and `decide_pickup_request`.
**Pass:** each response carries exactly its declared minimum set, on success **and** on refusal. Nothing merely cleared rides along.

---

## Intake and operations — T-71 … T-73

### T-71 · An unmatched caller ID produces an unlinked draft

Inbound call from a number matching no `authorized_contacts` row.
**Pass:** a draft is created with no contact linked and no contact guessed. A near-match — same area code, transposed digits, a second contact at the same number — links nothing.
This is AD-32 as a test: a signal that narrows, never one that establishes.

### T-72 · Cold JWKS served from a warm cache

Fresh process; issue the first authenticated request.
**Pass:** served from the cache warmed at startup; no network fetch on the request path. Closes the Sprint 2 carry-over where the cold path measured up to 500 ms against a 300 ms criterion.

### T-73 · Time-to-decision is recorded

**Pass:** median and p90 time-to-decision, escalation rate, expiry rate, and decision mix by approver are all emitted per tenant, and E2's number is recorded **alongside the P1 baseline**.
A measurement with no baseline is not a result.

---

## Adversarial pass — Sprint 3

Attempt each, report what worked, fix nothing.

- Get `reason_detail` into a Slack payload, a log line, a trace, or an error — including through a forced exception
- Approve a request without being a mapped approver
- Approve a request for another tenant's scholar
- Make a timeout, an error, a restart, or a retry produce an approval
- Replay a Slack interaction to double-decide, or to reverse a decision
- Get two workers to double-escalate, or to skip a ladder rung
- Reach a historical `service_date` belonging to another tenant
- Infer that a `request_id` exists in another tenant — by message, by code, **by timing**
- Get a scholar released with the request still in `routed`
- Write `state` without going through the transition function
- Get a `reason_category` value outside the enum into a row
- **Find a rejection path that writes no audit row** — Slack pre-handler rejections, worker skips, webhook validation failures (AD-42). This is the Sprint 2 F-1 class; assume it recurs until proven otherwise
- Guess a contact from a near-match phone number
- Get a declared tool parameter the server ignores (AD-15, still applies)
- Get a field into a response that isn't in that tool's minimum set (AD-17, still applies)

**A finding is required, or an explicit statement that one was sought and not found.** A weakest point identified and then argued away is a finding. Sprint 2's pass is the standard to beat.

---

## Carried into Sprint 4

Sprint 4 is the **Alexa+ channel, staff-facing** (AD-34 as amended, AD-48) — the product surface. The parent tier is Sprint 5, on that same device. Recording now what this sprint's test surface owes both, so the debt is visible at planning rather than discovered at implementation.

**AD-42 is the direct inheritance.** T-65 and T-61 assert that a rejection writes an audit row at the boundary that rejects it. Sprint 4 has the same shape twice over: Alexa+ calls `initialize` and `tools/list` with a service-level token that reaches no handler, and the current `resolveIdentity` rejects it outright. Every one of those rejections needs a row, and the spike that confirms which methods Alexa+ actually calls **reads those rows as its instrument.** The audit trail this sprint hardens is what makes Sprint 4's gate task measurable.

**The gate widens again in both.** T-52, T-60, and T-68 join the standing set here. Sprint 4 adds T-75 (a service token reaching no tool or tenant) — the first deliberate exception to a rule enforced since Sprint 1. Sprint 5 adds T-84 and T-88, the first tests where a wrong disclosure reaches **someone outside the school, standing in a room with other people.**

**T-68's sentinel method transfers twice.** Plant a unique string in the sensitive field, then exercise every output path including forced exceptions. In Sprint 4 the output surface becomes voiced speech (the spoken tier, AD-46) rather than a returned field. In Sprint 5 it becomes speech in a room whose audience has changed since the last turn.

**What Sprint 3 does not test, and the later sprints must:** a tenant-less token by design · anything spoken aloud · a shared listener · a session with no clean termination · a second factor of any kind · Spanish-language paths · anything a parent hears.

**One carried caution.** `authorized_contacts` is still unpopulated after this sprint. It was the phone plan's first factor; under AD-49 it becomes the **delivery address for an out-of-band second factor**. Either way it is a Sprint 5 dependency that nothing before it fills, so PL-403 starts from an empty table.

---

## Test run log

| Date | T-numbers | Result | Conditions |
| ---- | --------- | ------ | ---------- |
|      |           |        |            |

Record conditions with every entry: local vs remote, dataset size, warm vs cold, serial vs parallel. Sprint 2's p95 of 2.4 ms was real and not predictive; the same trap applies to a time-to-decision measured with two cooperative approvers during a pilot.

---

## Adding tests

Append with the next ID. If a test exists because something broke in real use, say so in the description — that's the difference between a test someone imagined and a test that caught a live bug, and it changes how seriously the next person takes a failure.