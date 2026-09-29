# plan.md — Sprint 7: The Alexa+ Channel

> **Re-issued 2026-09-29 as Sprint 7.** Drafted 2026-09-20 as `sprint-4`; the AUTH repair line (sprints 3.1 / AUTH / 6) ran and closed first. Test IDs renumbered T-74…T-83 → **T-92…T-101** (the live suite reached T-91; the draft's T-75 collided with the decision gate). PL numbers unchanged. Deferred-table "Sprint 4/5" references are pre-rename numbers: the parent-tier draft `sprint-5/` renames and renumbers when it opens.

**Sprint goal**

> Publish the existing MCP server as an Alexa+ add-on for one opted-in campus. Staff speak to an Echo in the main office and get the same verified answers the server already gives Claude Desktop — Claude's inference in the room, reading the campus's own roster.

**Duration:** 2 weeks. Shorter than every prior sprint, and that is the point: Sprint 2 built to Alexa+'s published requirements from the first commit under AD-8, so this is an integration, not a build. **If it starts looking like three weeks, something has been discovered — stop and say what.**

**Companion artifacts:** `sprint-7/research.md` (F-20…F-26, AD-44…AD-47) · `sprint-7/test.md` (T-92…T-101) · `sprint-7/progress.md`.

**Entry condition:** the AUTH repair line closed (Sprint 6). One tenant has opted into the Alexa+ surface (precondition T-3).

---

## What this sprint is, in product terms

AllowMe LLC builds the platform; a campus adopts it and picks its channels (AD-43). Alexa+ is a **channel** — the customer-facing one — alongside Claude Desktop (Sprint 2); Aircall/phone is a later capability on the same server, not a rival surface (AD-48). One MCP server, multiple clients — AD-1, finally literal.

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
| E2  | The Alexa+ handshake completes: service-level `initialize` and `tools/list` succeed, user-level tools work   | T-92, PL-301          |
| E3  | **No service-level token ever reaches a tool handler or a tenant context**                                   | T-93, T-94            |
| E4  | Nothing outside the spoken tier is voiced, over a full day including interruptions and topic shifts          | T-97, T-98, observation |
| E5  | Round-trip p95 **measured on the real Alexa+ path** ≤500 ms, recorded with conditions, warm and cold         | T-99                 |
| E6  | Zero real student data in the simulator, on the device, or in any vendor console                             | T-101, audit          |

**E5 is the first time the 500 ms budget is measured rather than asserted.** Sprint 2's 2.4 ms was local Postgres with six rows and no network. This is the number that always mattered.

---

## Prerequisites

| #   | Item                                                                     | Blocks        | Parallel? |
| --- | -------------------------------------------------------------------------- | ------------- | --------- |
| P1  | AUTH repair line closed (Sprint 6)                                       | Everything    | No        |
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

### PL-301 — Service-scope handshake fix + deferred observation **[the sprint's real work]**

Close F-20. `resolveIdentity` requires a tenant-claim UUID on every request, so an `mcp:service` token — `client_credentials`, no user, therefore no tenant — returns `missing_tenant_claim` and **Alexa+ would 401 at `initialize` today.** The handshake would never complete.

Per AD-44: a service branch in identity resolution, permitted **only** for `initialize`, `tools/list`, and health checks. It reaches no tool handler and no tenant context. **Rule 7 is not weakened** — a service token has no tenant because it has no user, and it is refused everywhere a tenant is needed.

**Ordering note (structural):** `verifier.verify` runs at `src/mcp/http.ts:383`, before the body parses and `rpcMethod` is known (:541). The service identity must therefore resolve at verify time and be *gated* at dispatch time — the method check lives in `handleMcp` after `rpcMethod` is extracted, before session routing, never after a tool handler. Service-tier requests audit on the NULL-tenant path (`insertUnauthenticatedMcpAuditEntry`); `auditTenantRequest`/`withTenant` never see them.

**Observation deferred by construction** (research.md Spike Results, rev 1): the instrument is `mcp_audit` on a live add-on, which does not exist until PL-309 + PL-302 land. Implement on the documented permitted set — `initialize`, `tools/list`, plus handshake housekeeping (`ping`, `notifications/*` carry no data) — then the spike runs as a verification pass at first registration: read the audit rows the real handshake writes and confirm the observed methods match the permitted list. A wider observed list re-argues AD-44, never quietly extends it. Do not take the docs table as the contract — the PL-101 lesson.

**AC:** T-92…T-94 pass. A service token completes the handshake and is refused by every data-bearing path. The observed method list is recorded in research.md "## Spike Results" at first deploy.

### PL-302 — Add-on manifest and dev-stage deploy [P4, PL-301]

`alexa-ai new mcp`, then `addon-package/addon.json`: short and full descriptions, 3–4 example phrases, privacy policy and terms URLs, six icon sizes, one 600×900 carousel image. `alexa-ai deploy` to **development stage** — not `submit`.

Per F-23, dev stage is testable in the simulator and on a device with no store listing. Certification is Sprint 5's question.

Descriptions are customer-facing copy (AD-16) and reach the model, the customer, and the voice layer.

**AC:** the add-on deploys, returns an Add-on ID, and appears in the developer console. `tools/list` reflects our three tools.

### PL-309 — Public deploy on Railway [PL-301]

The add-on needs a reachable server — today the MCP host binds loopback (`MCP_HOST` defaults to `127.0.0.1`) and nothing public exists.

- `Dockerfile` (Node 20+, `npm ci`, `npm run serve`; `tsx` is a devDependency — either install dev deps in the image or add a real build step, decided at implementation) and `railway.json` (Dockerfile builder, healthcheck `/health`).
- Env: `MCP_HOST=0.0.0.0`, `MCP_PORT` ← Railway's injected `PORT`, `RESOURCE_URL` = the public service URL (PRM and AS metadata already derive from it — T-30 discipline is config-driven), `NODE_ENV=production`, `DATABASE_URL` + `APP_DATABASE_URL`.
- The escalation worker is a second service on the same image, `npm run worker`.

**AC:** `/.well-known/oauth-protected-resource` and `/health` answer on the public URL; a cold deploy boots clean; `npm run verify` unchanged locally.

### PL-310 — App-role provisioning on managed Postgres [PL-309]

Railway's managed Postgres hands you a superuser — the exact posture that hid B-14 through three sprints. Two traps, both named: a **superuser bypasses RLS entirely** (the app connecting as one makes the isolation guarantee vacuous), and *"the owner bypasses RLS" is false under FORCE* (B-10/B-12/B-14). So:

- `parentline_app` is provisioned on the Railway database: migration 0000's `create role … login` runs under `npm run migrate` with `DATABASE_URL` as the owner; the password lands via `alter role parentline_app password '…'` (the `tests/helpers/db.ts` pattern) and lives in Railway's variable store, never the repo.
- Grants come from the migrations themselves — no hand-granted privileges.
- `APP_DATABASE_URL` is the `parentline_app` connection; `DATABASE_URL` stays owner and serves `npm run migrate` only.
- A README "Deploy" section documents the two-role posture for a hosted database — the T-89 fresh-clone contract, on real infrastructure.

**AC:** `npm run migrate` green against the Railway database; the app role connects non-superuser (`current_user = parentline_app`, `superuser = false` — the preflight's own posture check is the assertion).

### PL-303 — Spoken tier [PL-301]

New control, per AD-46. `project()` decides what a tool returns; the spoken tier decides what may be voiced. An Echo in the main office is heard by whoever is in the main office, waiting parents included, and AD-17 says we cannot un-disclose.

Implement as a second projection over the response, not as instructions to the model — AD-2 holds, and we do not own this model (3z).

**AC:** T-97 passes. A field cleared by `project()` but outside the spoken tier never appears in voiced output.

### PL-304 — Alexa+ conversational surface [PL-302, PL-303]

Tool descriptions tuned for Amazon's model as the only steering surface. Refusals must read as speech, not as API errors — a staff member should hear "let me get someone for you," never a status code.

**AC:** all four Sprint 1 refusals surface distinctly and audibly. No tool returns an empty success.

### PL-305 — Real-path latency measurement [PL-302]

Instrument the full Alexa+ round trip: their network, our auth, our tool, our response. Warm and cold JWKS separately, as in T-48.

**AC:** T-99 passes. The p95 is **recorded with its conditions**, against a 500 ms budget that has never been measured on the real path.

### PL-306 — Simulator and device testing [PL-302]

Web simulator first, then a physical Echo. Synthetic fixtures only, per E6 — **including in the vendor console and on the device.**

**AC:** T-100, T-101 pass. The published schema matches the registry fingerprint (AD-45).

### PL-307 — Campus pilot [all, P2, P3, P5]

One opted-in campus, one week, staff-facing. An Echo in the main office. Staff use it for real questions during real dismissal.

**AC:** E1, E4, E5.

### PL-308 — MCP Apps display **[STRETCH — cut first]**

Display the hold reason on an Echo Show rather than speaking it (3aa, parked since Sprint 2). Under AD-46 this is the only mechanism that gets a sensitive field to the right person without putting it in the room.

**Cut this before cutting anything else.** It needs a device we may not have, and the sprint succeeds without it.

---

## Sequencing

```
PL-301 (fix → deferred observation) ─→ PL-309 ─→ PL-310 ─→ PL-302 ─┬→ PL-303 ─→ PL-304 ─┐
                                                                  ├→ PL-305            ├→ PL-307
                                                                  └→ PL-306 ───────────┘
                                                                      PL-308 stretch, cut first
```

**Week 1:** PL-301, PL-309, PL-310, PL-302, PL-303.
**Week 2:** PL-304, PL-305, PL-306, then PL-307.

**PL-301 gates everything.** Without the service branch there is no handshake, and without a handshake there is no add-on. PL-309/310 are the deploy substrate — no public URL, no add-on.

---

## Harness debt — carried from the Sprint 6 closeout

Four items, none blocking the product work; all the same class — a mechanism
that silently stops enforcing rather than failing loudly. Product tasks take
priority, but none of these may be silently dropped.

1. **`_sprint_num`** (`.windsurf/hooks/_common.py`) — a folder name should not
   be able to disable enforcement silently (a non-draft `sprint-4` would have
   been ignored under sprint-6). One-line fix, filed at the Sprint 6 closeout.
2. **Budget guard** (`.windsurf/hooks/artifact-budget-guard.py`) — permit a
   write whose projected size is smaller than the current size; today it
   blocks the very compaction it demands.
3. **Program-wide dead-export liveness** (`scripts/check-dead-exports.mjs`) —
   the B-17/B-18/F-14 class. Replace the per-file fixpoint with a single
   program-wide one: roots are JUSTIFIED declarations, TEST_SURFACE exports
   with test callers, and non-declaration statements; a cross-file reference
   counts only when its enclosing top-level statement is alive; `export
   default` is checked like any named export. The evaluator's fix direction —
   a different program from today's script, which is why it was filed rather
   than patched at Sprint 6's close.
4. ~~F-15 (phase-trigger documentation)~~ — landed at the Sprint 6 close: the
   evaluator skill states the phase writer binds only a leading `/evaluate`.

Also decided at the Sprint 6 close: evaluation reports live in
`sprint-N/evaluations/`; `test.md` keeps definitions and the run log only.

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

1. Any of the standing gate failing or unwritten: T-01…T-05, T-33…T-35, T-52, T-60, T-68, T-75, T-84, T-87, T-88, T-89 — **plus T-93**
2. A service-level token reaching a tool handler or establishing a tenant context
3. A tenant-bearing path accepting a token with no tenant claim
4. A field outside the spoken tier voiced on any surface
5. A parent-facing tier shipped on this channel (out of scope, AD-47)
6. Real student data in the simulator, on a device, or in a vendor console
7. A published tool schema that does not match the registry fingerprint

### Evaluator requirements

- Fresh conversation **led** with `/evaluate` — the phase writer binds only a leading command; "run /evaluate" mid-sentence writes no phase file and preflight reports WRONG PHASE (post-T-91, F-15). A different model family from the builder.
- Grade against `sprint-7/plan.md` + `sprint-7/test.md` only. **Do not read `sprint-7/progress.md`**
- `DATABASE_URL` / `APP_DATABASE_URL` exported; do not `source .env`
- **Verify PL-301's permitted-method list against the observed `mcp_audit` rows, not the generator's summary** — the T-18 lesson applied to a spike
- Check rejection paths for audit rows, not log lines (AD-42)
- A finding is required, or an explicit statement that one was sought and not found

---

## Deferred

| Item                                     | Surfaced | Target                          |
| ---------------------------------------- | -------- | ------------------------------- |
| Parent tier on Alexa+                    | Sprint 4 | sprint-5 draft (renames/renumbers at open) |
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
- [ ] T-01…T-101 written and passing
- [ ] Zero hard-fail conditions triggered
- [ ] Evaluator produced a finding, or stated one was sought and not found
- [ ] AD-44…AD-47 promoted from draft into `research/research.md` §4
- [ ] Real-path p95 recorded with conditions, warm and cold
- [ ] Assessment packet updated with the current Amazon policy status (F-26)
- [ ] Sprint 5 scope drafted