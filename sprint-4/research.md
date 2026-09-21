# research.md — Parent Line

> **Read this first, every session.**

> **STATUS: DRAFT.** Drafted 2026-09-20, during Sprint 3, following the AD-43 restructure that returned Alexa+ to the roadmap. Sprint 3 has not run. Re-issue as rev 1 at Sprint 4 open.

**Sprint 4 scope:** the Alexa+ channel. Publish the existing MCP server as an Alexa+ add-on, **staff-facing first** per AD-8, on a campus that has opted into this surface (T-3).
**Product framing (AD-43):** AllowMe LLC builds the platform. A campus or network adopts it and selects channels. **Alexa+ is the product surface.** Claude Desktop is the staff/admin tool; Aircall is a later add-on capability on the same server, not a competing channel (AD-48).

---

## 1. What this sprint delivers

Claude's inference and conversational surface, in an Echo, reading a campus's own roster data out of the spreadsheet they already maintain — without a staff member typing anything.

Everything underneath already exists. Sprint 1 built the validated read; Sprint 2 built the OAuth-protected MCP server to Alexa+'s published requirements from the first commit (AD-8); Sprint 3 built the approval spine; Sprint 4 is this sprint. **This sprint is an integration, not a rebuild** — which is the payoff of having built to the spec before needing it.

---

## 2. Source review

### 2l. Alexa+ MCP Toolkit — re-observed 2026-09-20

Requirements verified against the live docs rather than the Sprint 2 notes.

**Unchanged and already satisfied:** Streamable HTTP (spec 2025-11-25) · remote URL · OAuth 2.1 + PKCE S256 · `resource` in both authorization and token requests (RFC 8707) · bearer in the `Authorization` header, never the query string · PRM at the RFC 9728 well-known URI · `/.well-known/oauth-authorization-server` advertising `S256` · `401` **without** `WWW-Authenticate` · round trip under 500 ms.

**Still unsupported by Alexa+:** DCR · CIMD · OIDC · **Step-Up Authorization** · `WWW-Authenticate` in 401.

**F-20 — Alexa+ uses a two-tier auth model, and our server fails tier 1 today.** Tier 1 is `client_credentials` (M2M, no user context) under an `mcp:service` scope, used for service registration, health checks, `initialize`, and `tools/list`. Tier 2 is `authorization_code` + PKCE under `mcp:tools` / `mcp:resources` for user-level calls.

`resolveIdentity` requires a tenant-claim UUID on **every** request and returns `missing_tenant_claim` otherwise. A service-level token carries no user and therefore no tenant, so **Alexa+ would 401 at `initialize`** — the handshake would never complete. This is the single hardest technical finding for this sprint and it is invisible until integration. (→ AD-44, PL-301)

**F-21 — Tool signatures and descriptions are locked after publication.** Changes require resubmission and re-review. AD-9 recorded that definitions are cached until redeploy; the true constraint is stricter — post-publication they are frozen behind a review cycle. Schema design is a one-shot decision per release. (→ AD-45)

**F-22 — The Category SDK does not apply.** Category MCP add-ons support one category: `ride_booking`. Education is not a category. The MCP Toolkit path is the only route, which is what Sprint 2 assumed.

**F-23 — A development stage exists that is not the store.** `alexa-ai deploy` publishes to development stage, testable in the web simulator and on a physical device; `alexa-ai submit` is a separate later step. Integration can be exercised end to end **without any store listing**, using synthetic fixtures. This substantially de-risks the sprint: certification is a Sprint 5 question, not a Sprint 4 blocker.

**F-24 — Store listing requirements, when certification does come.** `addon.json` needs `storeListing.distributionCountries`, a privacy policy URL, a terms of use URL, six icon sizes (72, 64, 88, 126, 180, 241), and at least one 600×900 carousel image. Certification additionally requires ≥3 distinct example phrases, accessibility support (VoiceView, Captions, Screen Magnifier, Color Tools), and no high-severity dead ends.

**F-25 — Q3 is closed, and it was blocked on the wrong binary.** The tool is the **Alexa AI CLI**: `alexa-ai configure` (LWA browser OAuth, credentials at `~/.alexa-ai/credentials`, Node.js 24+), then `alexa-ai new mcp`, `alexa-ai deploy`, `alexa-ai submit`. Not the ASK CLI. Sprint 2's E6 can close.

**F-26 — Amazon's security and data policy is still unpublished.** Observed 2026-09-20: the section exists as a heading with a note that details will be published in a future revision; page last updated 2026-07-14. Per AD-43 this is a **disclosure obligation** in the assessment packet, not a gate. Re-check at sprint open.

---

## 3. Implications

**3w — Sprint 2's discipline is the reason this sprint is small.** Building to a spec we could not yet use looked expensive at the time. Every published requirement is already met; the integration work is a service-scope fix, a manifest, and a deploy. AD-8 earned its keep.

**3x — AD-33's two jobs, separated.** "Descoped" meant both a design judgment (verification is harder on a shared device) and a roadmap exclusion (driven by the old Gate 1). The judgment stands; the exclusion is withdrawn under AD-43. **The resolution is AD-8, not a reversal:** Alexa+ ships staff-facing first, on a device in the main office, operated by staff. That delivers the channel while touching none of the shared-device verification problem.

**3y — A staff Echo has a listener problem the phone doesn't, even staff-facing.** An Echo in the main office is heard by whoever is in the main office — including waiting parents. AD-17's "cannot un-disclose" applies in full. The mitigation is not verification; it is the **spoken tier**: what may be said aloud is narrower than what a tool may return. This is a new control surface — the projection decides data, the spoken tier decides audibility. (→ AD-46)

**3z — We do not own the model here.** Unlike Sprint 4's phone client, Amazon's model picks tools and fills arguments (§3b). AD-2 is load-bearing again in its original form: disclosure lives in return values, never in prompts, and tool descriptions are the only steering surface.

**3aa — MCP Apps solve the lobby privacy problem properly.** On an Echo Show, the reason can be *displayed* rather than spoken — §3d, parked since Sprint 2 for want of a device. Under the spoken-tier framing (3y) this stops being a nice-to-have: it is the only mechanism that lets a sensitive field reach the right person without reaching the room. Needs an Echo Show. Scoped as a stretch task, not a dependency.

---

## 4. Architecture decisions

AD-1 … AD-43 stand. AD-33 is amended at rev 3. New:

**AD-44** _(draft)_ **Service-level tokens resolve to a service identity, never a tenant.** An `mcp:service` token (`client_credentials`) authenticates the Alexa+ platform, not a user, and is permitted **only** for `initialize`, `tools/list`, and health checks. It reaches no tool handler and no tenant context. `resolveIdentity` gains a service branch; every data-bearing path continues to require a tenant claim, unchanged. **Rule 7 is not weakened:** a service token has no tenant because it has no user, and it is refused everywhere a tenant would be needed.
**AD-45** _(draft)_ **Tool schemas are frozen at publication.** Stricter than AD-9. A schema change costs a resubmission and a review cycle, so the published tool surface is a one-shot decision per release: ship the smallest set that works, and treat the schema registry fingerprint as a release gate rather than a drift detector.
**AD-46** _(draft)_ **The spoken tier is narrower than the returned tier.** On a shared-room device, a field may pass the disclosure projection and still be wrong to say aloud. Two controls, not one: `project()` decides what a tool returns; the spoken tier decides what may be voiced. Where they differ, the field goes to a display surface (3aa) or to a person.
**AD-48** _(draft)_ **Alexa+ is the product surface; other channels are capabilities on the same server.** The product is an Alexa+ MCP add-on: Claude's inference in an Echo, reading a campus's own roster spreadsheet. Aircall/phone is a later capability exposed by the same MCP server — a tool, not a competing surface — and is descoped from the roadmap until the Alexa+ channel carries both staff and parents. This reverses the interim plan in which the phone was the first parent channel; the reasoning that made the phone attractive (a free first factor, one listener) survives as **the problem Sprint 5 must solve without those advantages** (AD-49, Q6).

**AD-47** _(draft)_ **Alexa+ ships staff-facing first** (AD-8 applied to a new channel). The parent tier on this surface is Sprint 4 and does not ship here. Per AD-8 the staff surface exercises the whole stack against users who can say "that's wrong" — every bug found here is one a parent never hears.

---

## 5. Stack

Carried. **Sprint 4 additions:** Alexa AI CLI (Node 24+) · `addon-package/addon.json` · a cloudflared-style tunnel for local development · optionally the MCP Apps SDK (`@modelcontextprotocol/ext-apps`) for the stretch display task.

---

## 6. Constraints and gates

Per AD-43, split as in Sprint 3 §6.

**Build gates:** none new. Every published Alexa+ requirement is already met; F-20 is a defect to fix, not a gate.

**Tenant provisioning preconditions:** T-1 (agreement and school-official designation), T-2 (customer's own channel assessment), **T-3 — this tenant has explicitly opted into the Alexa+ surface.** A campus may adopt the phone channel and decline this one; the architecture supports that per-tenant and the pilot assumes exactly one tenant has opted in.

**Vendor-side disclosures:** F-26. Re-check at sprint open; state plainly in the assessment packet.

**Standing:** no real student data, anywhere — including the web simulator, a physical device, and any vendor console.

---

## 7. Known leak vectors

Carried 1–22. New:

23. **A service-level token reaching a tool handler or a tenant context** (AD-44) → T-74, T-75
24. **A field spoken aloud that passed the projection but fails the spoken tier** (AD-46) → T-79
25. **Alexa restating an earlier turn's data to a different listener in the room** (AD-17 on a shared device) → T-80
26. **A published tool schema drifting from the reviewed one** (AD-45) → T-82
27. **Real student data reaching a vendor simulator, device, or console** → T-83

---

## 8. Open questions

23. Does a staff Echo live in the main office, and who is in earshot? Determines how narrow the spoken tier must be (3y).
24. Is an Echo Show available for the MCP Apps stretch task (3aa)?
25. What does the assessment packet need to contain for a customer's counsel — template or bespoke?
26. Does the add-on stay in development stage indefinitely for a single tenant, or does certification become necessary for multi-campus? (F-23, F-24)
27. Carried: Q2, Q8, Q9, Q10, Q15, Q23–Q26 carried.

**Q3 closed** (F-25). **Q4 (private/org-scoped distribution)** partially answered by F-23: dev stage serves a single opted-in tenant without a store listing.

---

## Spike Results

### PL-301 — Service-scope handshake `SPIKE` (open)

**Question:** F-20. Confirm by observation which methods Alexa+ calls with a `client_credentials` token versus a user token, against our actual server — not from the docs table. The PL-101 lesson: two documented "rejections" turned out to be dashboard configuration.

**Method:** deploy to development stage behind a tunnel, register, and read our own `mcp_audit` rows. The audit trail built in Sprint 2 and hardened under AD-42 is exactly the instrument for this — every handshake call lands as a row with its outcome.

**A "tier 1 is called for more than we assumed" outcome is a valid result** and widens AD-44's permitted method list, which must then be re-argued rather than quietly extended.

---

## Changelog

| Rev | Date | Change |
| --- | ---- | ------ |
| 0 (draft) | 2026-09-20 | Drafted during Sprint 3 after the AD-43 restructure. **Restructured same day: Alexa+ became Sprint 4 (staff-facing) and the product surface (AD-48); the phone channel is demoted to a later capability; the parent tier is Sprint 5.** §2l re-observed against live docs (F-20…F-26), §3w…§3aa, AD-44…AD-47 draft, leak vectors 23–27, Q23–Q26. **F-20 is the sprint's defining finding.** |