# Parent Line

A parent asks a routine question — "where is my scholar?" — and gets a verified, consistent answer without pulling a staff member off dismissal duty.

**The payload is student education records (FERPA).** Every design decision is downstream of that fact.

## What it is

Parent Line is a voice-first customer service agent for school front offices. A parent speaks to an Alexa device — in the lobby, or by phone into the same backend — and a Claude-powered agent greets them, verifies who they are, answers the question that brought them in, and takes the follow-up action: booking a leadership appointment, emailing a document, or arranging a callback.

It replaces the front-desk interrupt loop: the parent who walks in at 3:40 pm asking where their scholar is, while the ops coordinator is on the phone, mid-dismissal, with a line forming behind them.

## What it does

| Capability | What the parent experiences |
|---|---|
| Greeting & intake | "Good afternoon, welcome to [School]. May I have your name?" → opens into "How can I help you today?" |
| Scholar status lookup | Answers "Where is my scholar?" from the day's academic-redo and detention rosters — status, release time, next step |
| Leadership appointments | Books time with a principal, vice principal, or dean against their live calendar |
| Document delivery | Emails the correct document — report card, IEP meeting notice, uniform policy, calendar, incident summary — to the address on file |
| Callback requests | Logs a request for a specific administrator to call back, with the reason attached |
| Escalation | Hands off to a live staff member the moment the request exceeds its scope |

## What it deliberately does not do

Discipline decisions. Grade explanations. Anything about another family's child. Anything requiring judgment about a student's record. Custody or enrollment disputes. Every one of these routes to a human immediately — the agent's job is to absorb the routine 80% so staff have room for the 20% that actually needs them.

## Problem statement

The front office is the school's most interrupted role, and most of those interruptions are the same six questions.

During dismissal and pickup windows, a single ops coordinator is simultaneously running dismissal logistics, answering the phone, and fielding walk-in parents. The recurring asks are almost entirely lookup-and-relay:

- "Is my scholar in redo today? Why? When does he get out?"
- "I need to talk to the vice principal."
- "Can you send me his report card / the uniform policy / the meeting notice?"

Each one costs 3–8 minutes of a staff member's attention. Each one is answerable from a spreadsheet or a calendar. And each one arrives at exactly the moment that attention is scarcest.

The downstream costs compound:

- **Staff time** is consumed by lookups, not by work only staff can do. Coordination, escalation, and relationship-building get displaced by roster reads.
- **Parents wait**, and information arrives inconsistently. The same question gets a different answer depending on who is at the desk and how busy they are.
- **Language access** is uneven. In a bilingual community, whether a parent gets served in Spanish depends on who happens to be working that shift.
- **Requests fall through.** Callback requests taken on sticky notes during dismissal don't reliably reach the administrator.
- **After hours**, there is nothing. A parent with a 7 pm question waits until morning.

The information parents need already exists — in the redo roster, the detention log, the student information system, and leadership calendars. The bottleneck isn't data. It's that a human has to be free at the exact moment a parent asks.

## Solution statement

Parent Line puts a verified, bilingual, always-available voice interface in front of data the school already maintains — and takes action on it.

A parent walks up and speaks normally. The agent greets them, confirms identity against the authorized-contacts list, retrieves the scholar's status from the day's roster, delivers it clearly, and offers the next step. If the parent wants the vice principal, it books the slot. If they want the document, it emails it. If it can't help, it gets a person — with a structured summary so the parent doesn't repeat themselves.

The result: routine parent questions get answered in under a minute, consistently, in English or Spanish, without pulling a staff member off dismissal. Staff time redirects to the requests that genuinely need a human. Every interaction is logged, so nothing depends on a sticky note.

## How it works

```
Parent (voice)
      ↓
Alexa device — speech-to-text / text-to-speech
      ↓
Backend service  ← deterministic code owns: identity, authorization, actions
      ↓
Claude — conversation, intent, tone, language, summarization
      ↓
Data + action layer
   ├── Roster sync (redo / detention spreadsheet → validated daily import)
   ├── Student information system (read-only, scoped)
   ├── Leadership calendars (availability + booking)
   ├── Document library (approved templates only)
   └── Email service (sends only to the address on file)
      ↓
Audit log + human escalation queue
```

The architectural rule that makes this safe: **Claude runs the conversation, but never the authorization.** Identity verification, "is this person allowed to hear this," which document may be sent, and where email goes are all enforced in deterministic code before the model is allowed to say anything specific. The model can't be talked into disclosing a record, because it isn't the thing deciding.

On the spreadsheet: rather than having the agent read a live file, the daily redo/detention sheet is imported and validated on a schedule — schema-checked, with rows that fail validation flagged to staff instead of guessed at. A malformed cell should surface as "let me get someone for you," never as a wrong answer about a child.

## The constraint that determines whether this ships: verification

The sample script — "Your scholar is currently being held in academic redo for X reason" — is exactly the right content and exactly the wrong moment. Spoken before verification, on a lobby speaker, it discloses a student education record to whoever happens to be standing there. That's a FERPA exposure and a parent-trust problem in one.

Voice is a weak identifier. Names are guessable, voices are overheard, and a lobby is a public space. So verification has to be designed in from the first turn:

- **Verify before disclosing.** Name alone is not identity. Match the caller against the authorized-contacts list using a second factor — a PIN, the last four of the phone on file, or a one-time code pushed to the number on record.
- **Tier what's spoken aloud.** That a scholar is in redo and when they're released is low-sensitivity and can be spoken. Why — the disciplinary reason — should default to email or a staff conversation, not a lobby speaker.
- **Match the room.** A handset or a headset in the lobby, not an open speaker. If it stays an open speaker, the spoken tier shrinks further.
- **Authorized contacts only.** Custody arrangements are live data; the agent honors the SIS's authorized-contact list and never reasons about who "should" count.
- **Log everything.** Who asked, what was verified, what was disclosed, what was sent — a complete audit trail.

### Rewritten script

> **Agent:** Good afternoon, welcome to [School]. May I have your name?
> **Parent:** Maria Reyes.
> **Agent:** Thank you, Ms. Reyes. To pull up your scholar's information, can you confirm the four-digit family PIN?
> **Parent:** 4-8-1-2.
> **Agent:** Verified — thank you. How can I help you today?
> **Parent:** Where is my son? He wasn't at pickup.
> **Agent:** Daniel is in academic redo this afternoon and will be released at 4:30. I can email you the details on why, or arrange a call with Vice Principal Ortiz — which would you prefer?

Same information, delivered after verification, with the sensitive part moved to a private channel and a clear next action offered. Note the language shift too: "in academic redo" rather than "being held" — the second sounds custodial, and a parent hearing it about their child at 3:45 pm will react to the word before the facts.

## Success metrics

Define these before building — they're what proves it works:

| Metric | Why it matters |
|---|---|
| Front-desk interruptions during dismissal | The core problem being solved |
| Containment rate (resolved without staff) | Measures actual offload, not usage |
| Median time to answer | Parent experience |
| Verification failure rate | Too high = parents locked out; too low = check is too weak |
| Disclosure errors | Target: zero. Any wrong-parent disclosure is a stop-the-line event |
| Escalation quality | Did the human receive enough context to continue? |
| Spanish-language session share | Confirms the access problem is actually being solved |
| Booking / email completion rate | Did the action land, or just get promised? |

Report these by segment — walk-in vs. phone, English vs. Spanish, by grade band. A 95% aggregate containment rate can easily hide a 40% failure rate in Spanish, and that's precisely the failure that would matter most here.

## Open decisions before build

- **Verification method** — family PIN, phone-on-file callback, or one-time code? Determines both security and friction.
- **Device placement and form factor** — open lobby speaker vs. handset. This decision sets how much can be spoken aloud.
- **Roster source of truth** — does the redo/detention sheet stay a spreadsheet, or move behind an API? Spreadsheets are fine as an input; they're fragile as a live dependency.
- **Approval path** — school leadership, network ops, and legal/compliance sign-off on what the agent may disclose without a human.
- **After-hours scope** — full service, or status-and-message-taking only?
- **Pilot boundary** — one school, one dismissal window, status lookup only. Add appointments and email once disclosure accuracy holds at zero errors.

Recommended first phase: status lookup and callback requests only, at one campus, with verification live from day one. Appointments and document email come in phase two. Nothing about the concept is hard to build — the risk is entirely in disclosure correctness, so prove that first on the narrowest possible surface.

---

## Current sprint: deterministic core

Sprint 1 builds the deterministic core: scheduled roster ingestion, validation, enforced tenant isolation, and one audited read. **No voice, no LLM, no MCP server** — those come later, on top of a core where being wrong is unacceptable.

## Non-negotiables

These are enforced by lint rules, database grants, and CI — not by convention.

| Rule | Enforced by |
|---|---|
| No real student data, ever. Fixtures are synthetic | `.gitignore`, CI tree check, `.windsurf/hooks/student-data-guard.py` |
| `tenant_id` is never a caller-supplied argument — it is derived from the session | ESLint `no-restricted-syntax`, `tenant-isolation-guard.py` |
| No query outside the repository layer | ESLint, scoped per-directory |
| The advisor-notes column never enters a canonical row, response, or log | Excluded at the connector (PL-004/PL-005), test T-19 |
| Derived holds are staff-facing only | Service-level block, test T-21 |
| Degrade to human, never to a guess | Typed refusals, test T-15 |

## Setup

Requires **Node 20+** and a reachable **PostgreSQL 15+**. No Docker needed — see `research/research.md` AD-11.

```bash
npm install
cp .env.example .env        # then edit
createdb parentline_dev
npm run migrate
npm run verify              # typecheck + lint + test
```

### Two database roles, deliberately

`DATABASE_URL` is an **owner** connection that runs migrations. `APP_DATABASE_URL` is a **non-owner, non-superuser** connection that serves reads.

This is not ceremony. **Table owners and superusers bypass RLS silently.** If the application connects as the owner, every isolation test passes and production leaks. `APP_DATABASE_URL` is required in production for exactly this reason, and test T-05 aborts the suite if the effective role can bypass RLS.

## Scripts

| Command | Purpose |
|---|---|
| `npm run verify` | The CI gate: typecheck → lint → test |
| `npm run test:isolation` | T-01…T-05 only. Run before every commit |
| `npm run migrate` | Apply migrations as the owner role |
| `npm run seed` | Seed synthetic two-tenant fixture data |
| `npm run lint` | Includes the rule 7 and rule 11 guardrails |

## Layout

```
research/research.md        durable context — read first, every session
planning/plan.md            tasks + Sprint Contract (the grading rubric)
implementation/progress.md  task board, session log, Failed Approaches
evaluation/test.md          T-01…T-23 definitions
src/                        application code
tests/                      isolation gate + suite
spike/                      throwaway spikes; deleted at sprint end
```

Development follows Harness Engineering v3: Research → Spike → Planning → Implementation → Evaluation. The agent that builds does not evaluate its own work. See `AGENTS.md`.

## Status

Sprint 1 (Parent Line Core): **all PL tasks complete** (PL-001 through PL-012). 146 tests passing across 15 test files. Isolation gate (T-01…T-05) green. p95 latency: 2.4 ms (target ≤150 ms). Zero hard-fail conditions.

`PL-005` (Google Sheets connector) is code-complete but integration testing is blocked pending read-only OAuth credentials and a test sheet.
