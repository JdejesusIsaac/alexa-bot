# plan.md — Sprint 4: The Alexa+ Channel

> **STATUS: DRAFT.** Drafted 2026-09-20 during Sprint 3, after AD-43 returned Alexa+ to the roadmap. Sprint 3 has not run. Re-issue at Sprint 4 open.

**Sprint goal**

> Publish the existing MCP server as an Alexa+ add-on for one opted-in campus. Staff speak to an Echo in the main office and get the same verified answers the server already gives Claude Desktop — Claude's inference in the room, reading the campus's own roster.

**Duration:** 2 weeks. Shorter than every prior sprint, and that is the point: Sprint 2 built to Alexa+'s published requirements from the first commit under AD-8, so this is an integration, not a build. **If it starts looking like three weeks, something has been discovered — stop and say what.**

**Companion artifacts:** `sprint-4/research.md` (F-20…F-26, AD-44…AD-47) · `sprint-4/test.md` (T-74…T-83) · `sprint-4/progress.md`.

**Entry condition:** Sprint 3 closed. One tenant has opted into the Alexa+ surface (precondition T-3).

---

## What this sprint is, in product terms

AllowMe LLC builds the platform; a campus adopts it and picks its channels (AD-43). Alexa+ is a **channel**, alongside the phone (Sprint 4) and Claude Desktop (Sprint 2). One MCP server, multiple clients — AD-1, finally literal. Alexa+ is the customer-facing one; Aircall joins later as a capability, not a rival surface (AD-48).

What a campus gets: Claude's inference and conversational handling, in an Echo, answering off the roster spreadsheet they already maintain. That is the product. No new system of record, no data migration, no staff typing. The spreadsheet stays theirs; the sync, validation, and quarantine built in Sprint 1 make it answerable.

---

## Why it is small

Every published Alexa+ requirement was met in Sprint 2 and verified by test: Streamable HTTP on spec 2025-11-25, OAuth 2.1 with PKCE S256, RFC 8707 `resource` in both requests, header-only bearer tokens, PRM at the RFC 9728 well-known URI, `S256` advertised in AS metadata, `401` without `WWW-Authenticate`, and a p95 far inside the 500 ms budget.

**Building to a spec before we could use it looked expensive at the time. This sprint is the return on it.** The remaining work is one real defect (F-20), a manifest, a deploy, and a spoken-tier control that is new.

---

## Exit criteria

Graded **separately from the rubric** (AD-14).

| #   | Criterion                                                                                                   | Met by              |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------- |
| E1  | A staff member completes a day of real questions on a physical Echo with no wrong answer                    | Observation           |
| E2  | The Alexa+ handshake completes: service-level `initialize` and `tools/list` succeed, user-level tools work   | T-74, PL-301          |
| E3  | **No service-level token ever reaches a tool handler or a tenant context**                                   | T-75, T-76            |
| E4  | Nothing outside the spoken tier is voiced, over a full day including interruptions and topic shifts          | T-79, T-80, observation |
| E5  | Round-trip p95 **measured on the real Alexa+ path** ≤500 ms, recorded with conditions, warm and cold         | T-81                 |
| E6  | Zero real student data in the simulator, on the device, or in any vendor console                             | T-83, audit          |

**E5 is the first time the 500 ms budget is measured rather than asserted.** Sprint 2's 2.4 ms was local Postgres with six rows and no network. This is the number that always mattered.

---

## Prerequisites

| #   | Item                                                                     | Blocks        | Parallel? |
| --- | -------------------------------------------------------------------------- | ------------- | --------- |
| P1  | Sprint 3 closed                                                          | Everything    | No        |
| P2  | **Tenant opted into the Alexa+ channel** (precondition T-3)              | PL-307        | No        |
| P3  | Amazon policy status re-checked (F-26) and stated in the assessment packet | PL-307        | Yes       |
| P4  | Alexa AI CLI installed and authenticated: Node 24+, `alexa-ai configure` | PL-302        | Yes       |
| P5  | A physical Echo at the pilot campus                                      | PL-307        | Yes       |

**P3 is a disclosure, not a gate** (AD-43). It does not block building or dev-stage testing. It goes in the packet a customer's counsel reads.

---

## In scope

Service-scope handshake support · add-on manifest and dev-stage deploy · spoken-tier control · staff-facing Alexa+ surface · real-path latency measurement · web simulator and physical device testing · one-campus pilot

## Out of scope

Parent-facing Alexa+ tier · store certification and listing · MCP Apps display (stretch only) · multi-campus · new tools · Spanish on this channel · any change to the phone channel

> **Out of scope means do not scaffold it "for later."** Note especially: **no new tools this sprint.** Per AD-45, published schemas freeze behind a review cycle — a tool added carelessly now is expensive to change later.

---

## Tasks

### PL-301 — Service-scope handshake `SPIKE` + fix **[the sprint's real work]**

Close F-20. `resolveIdentity` requires a tenant-claim UUID on every request, so an `mcp:service` token — `client_credentials`, no user, therefore no tenant — returns `missing_tenant_claim` and **Alexa+ would 401 at `initialize` today.** The handshake would never complete.

Per AD-44: a service branch in identity resolution, permitted **only** for `initialize`, `tools/list`, and health checks. It reaches no tool handler and no tenant context. **Rule 7 is not weakened** — a service token has no tenant because it has no user, and it is refused everywhere a tenant is needed.

**Spike first:** confirm by observation which methods Alexa+ actually calls with which token, against our own server, by reading our `mcp_audit` rows. Do not take the docs table as the contract — the PL-101 lesson.

**AC:** T-74…T-76 pass. A service token completes the handshake and is refused by every data-bearing path. The observed method list is recorded in research.md "## Spike Results".

### PL-302 — Add-on manifest and dev-stage deploy [P4, PL-301]

`alexa-ai new mcp`, then `addon-package/addon.json`: short and full descriptions, 3–4 example phrases, privacy policy and terms URLs, six icon sizes, one 600×900 carousel image. `alexa-ai deploy` to **development stage** — not `submit`.

Per F-23, dev stage is testable in the simulator and on a device with no store listing. Certification is Sprint 5's question.

Descriptions are customer-facing copy (AD-16) and reach the model, the customer, and the voice layer.

**AC:** the add-on deploys, returns an Add-on ID, and appears in the developer console. `tools/list` reflects our three tools.

### PL-303 — Spoken tier [PL-301]

New control, per AD-46. `project()` decides what a tool returns; the spoken tier decides what may be voiced. An Echo in the main office is heard by whoever is in the main office, waiting parents included, and AD-17 says we cannot un-disclose.

Implement as a second projection over the response, not as instructions to the model — AD-2 holds, and we do not own this model (3z).

**AC:** T-79 passes. A field cleared by `project()` but outside the spoken tier never appears in voiced output.

### PL-304 — Alexa+ conversational surface [PL-302, PL-303]

Tool descriptions tuned for Amazon's model as the only steering surface. Refusals must read as speech, not as API errors — a staff member should hear "let me get someone for you," never a status code.

**AC:** all four Sprint 1 refusals surface distinctly and audibly. No tool returns an empty success.

### PL-305 — Real-path latency measurement [PL-302]

Instrument the full Alexa+ round trip: their network, our auth, our tool, our response. Warm and cold JWKS separately, as in T-48.

**AC:** T-81 passes. The p95 is **recorded with its conditions**, against a 500 ms budget that has never been measured on the real path.

### PL-306 — Simulator and device testing [PL-302]

Web simulator first, then a physical Echo. Synthetic fixtures only, per E6 — **including in the vendor console and on the device.**

**AC:** T-82, T-83 pass. The published schema matches the registry fingerprint (AD-45).

### PL-307 — Campus pilot [all, P2, P3, P5]

One opted-in campus, one week, staff-facing. An Echo in the main office. Staff use it for real questions during real dismissal.

**AC:** E1, E4, E5.

### PL-308 — MCP Apps display **[STRETCH — cut first]**

Display the hold reason on an Echo Show rather than speaking it (3aa, parked since Sprint 2). Under AD-46 this is the only mechanism that gets a sensitive field to the right person without putting it in the room.

**Cut this before cutting anything else.** It needs a device we may not have, and the sprint succeeds without it.

---

## Sequencing

```
PL-301 (spike → fix) ─→ PL-302 ─┬→ PL-303 ─→ PL-304 ─┐
                                ├→ PL-305            ├→ PL-307
                                └→ PL-306 ───────────┘
                                   PL-308 stretch, cut first
```

**Week 1:** PL-301, PL-302, PL-303.
**Week 2:** PL-304, PL-305, PL-306, then PL-307.

**PL-301 gates everything.** Without the service branch there is no handshake, and without a handshake there is no add-on.

---

## Sprint Contract

### Rubric

| Category                        | Weight  |
| ------------------------------- | ------- |
| **Auth & Disclosure**           | **40%** |
| Integration correctness         | 30%     |
| Functionality                   | 20%     |
| Design                          | 10%     |

Auth and disclosure lead because AD-44 adds a token class that is deliberately tenant-less — the first exception to a rule enforced since Sprint 1 — and AD-46 adds a control surface that did not previously exist. Integration correctness is weighted heavily because most of this sprint is someone else's contract.

Pass threshold ≥90% weighted, **and** zero hard-fails, **and** the isolation gate green.

### Hard-fail conditions

1. Any of the standing gate failing or unwritten: T-01…T-05, T-33…T-35, T-52, T-60, T-68, **plus T-75**
2. A service-level token reaching a tool handler or establishing a tenant context
3. A tenant-bearing path accepting a token with no tenant claim
4. A field outside the spoken tier voiced on any surface
5. A parent-facing tier shipped on this channel (out of scope, AD-47)
6. Real student data in the simulator, on a device, or in a vendor console
7. A published tool schema that does not match the registry fingerprint

### Evaluator requirements

- `.windsurf/state/phase` set to `evaluation`; flip back after
- Grade against `sprint-4/plan.md` + `sprint-4/test.md` only. **Do not read `sprint-4/progress.md`**
- `DATABASE_URL` / `APP_DATABASE_URL` exported; do not `source .env`
- **Verify PL-301's permitted-method list against the observed `mcp_audit` rows, not the generator's summary** — the T-18 lesson applied to a spike
- Check rejection paths for audit rows, not log lines (AD-42)
- A finding is required, or an explicit statement that one was sought and not found

---

## Deferred

| Item                                     | Surfaced | Target                          |
| ---------------------------------------- | -------- | ------------------------------- |
| Parent tier on Alexa+                    | Sprint 4 | **Sprint 4**                    |
| Store certification and listing (F-24)   | Sprint 4 | Sprint 5, or never for a single tenant |
| MCP Apps display                         | Sprint 2 | Stretch here, else Sprint 5     |
| Spanish on the Alexa+ channel            | Sprint 4 | Sprint 5                        |
| Leadership appointments; document delivery | Sprint 3 | Sprint 5                        |
| Multi-campus rollout                     | Sprint 4 | After one campus holds          |
| Operational readiness: runbook, on-call, failure playbook | Sprint 4 | **Unscoped and overdue** |

---

## Definition of sprint complete

- [ ] All six exit criteria met (E1–E6)
- [ ] All 7 tasks ✅ (not 🔵); PL-308 stretch may be cut
- [ ] T-01…T-83 written and passing
- [ ] Zero hard-fail conditions triggered
- [ ] Evaluator produced a finding, or stated one was sought and not found
- [ ] AD-44…AD-47 promoted from draft into `research/research.md` §4
- [ ] Real-path p95 recorded with conditions, warm and cold
- [ ] Assessment packet updated with the current Amazon policy status (F-26)
- [ ] Sprint 5 scope drafted