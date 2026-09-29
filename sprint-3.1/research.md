# research.md — Sprint 3.1 (repair sprint)

A repair sprint does no Phase-0 research; this file exists to record
the decisions Sprint 3.1 *settled*, in the same style as sprint-3's
research record. Everything here was implemented in PL-251…PL-258.

---

## Leak vector 30 — the SECURITY DEFINER tenant oracle (settled)

`find_pickup_request_tenant` (migration 0009) ran as owner — bypassing
the forced RLS that is the rest of the schema's entire posture — and
returned the owning `tenant_id`. Any role holding EXECUTE could map a
`request_id` to its campus and confirm existence. The Sprint 3.1 author
observation, now a numbered vector.

**Settled:** migration 0010 replaces it with
`pickup_request_belongs_to_tenant(request_id, tenant_id) → boolean` —
SECURITY DEFINER with a pinned `search_path`, PUBLIC execute revoked,
`parentline_app` alone holds it. It confirms membership; it discloses
nothing. Verified by T-82 (`pg_proc`, `has_function_privilege`,
behavioral legs).

## Authorization rule — decisions come from the assigned approver (settled)

Sprint 3 implemented *resolution* (Slack id → subject via
`staff_identities`) but never *authorization*: any mapped actor could
approve, including the coordinator who created the request, and the app
channel bypassed `staff_identities` entirely.

**Settled:** the rule lives in `transitionPickupRequest` — the single
state-machine chokepoint — because a rule held by memory in two
handlers fails in the third. Decision actions require
`actorIdentityId === assigned_approver_id` and reject the creator
(compared via the `routed` event's actor). Typed refusals:
`not_assigned_approver`, `self_approval`, `unmapped_actor`,
`missing_field`. HF5 amended: any-channel unresolved actor, plus
creator self-approval. Verified by T-75 (gate).

## Level-0 clock — `initial_minutes` (settled)

Sprint 3 routed with `escalate_at = pickup_at` — the first rung fired
when the parent was already due, which is arrival-time thinking on a
request-time system.

**Settled:** `initial_minutes` is a required ladder field; route sets
`escalate_at = min(pickup_at, now + initial_minutes)`. Unconfigured
tenants keep `pickup_at` and log `initial_clock_unconfigured` — an
explicit gap, never an invented default.

## `stalled` — the attempt ceiling's terminal state (settled)

Skipped and failing due rows kept their `escalate_at`, so the
oldest-first queue starved healthy rows behind poisoned ones forever —
and skipped rows never reached any terminal handoff.

**Settled:** `escalation_attempts` (migration 0010) counts every
skip/failure; each deferral rewrites `escalate_at = now() + deferral`
inside the claim transaction after the savepoint release/rollback. At
`ESCALATION_MAX_ATTEMPTS` (default 20) the worker takes `stall`:
`routed → stalled`, terminal, audited, `reason_detail` purged,
`decided_by` null — a clock giving up is not a decision. AD-26's twin:
unreachable by `release`/`complete`/`approve`/`escalate` by
construction of the transition table. Verified by T-78.

## Per-tenant ladders — `ESCALATION_LADDER_DIR` (settled)

One shared ladder file carried per-tenant approver subjects, so a
worker covering two tenants skipped every row of the second.

**Settled:** `ESCALATION_LADDER_FILE` becomes `ESCALATION_LADDER_DIR`;
each `WORKER_TENANTS` entry loads `<dir>/<tenant_id>.json`. A missing
file refuses boot naming the tenant and the path. The web process's
level-0 clock is per-tenant too — the same ladder owns route's
`initial_minutes` for its campus. Fixture ladders live at
`src/fixtures/escalation/<tenant>.json`, obviously fake per tenant.
Verified by T-79.

## Unaudited error paths — closed on both surfaces (settled)

A thrown error in the Slack decision section produced a 500 with only
a log line; `setInterval(() => void this.tick())` turned a whole-tick
failure into an unhandled rejection — a process exit on Node 20.

**Settled:** the endpoint audits `error:slack_internal` and returns a
generic 500 (never the not-found shape, never internals). The worker
runs `tick().catch`, isolates per-tenant failures (log +
`error:worker_tenant_failed` audit), emits `worker_unhealthy` on
consecutive failures, and keeps polling. Verified by T-80/T-81.

## Still open

- **P2** — the real escalation ladder (rungs, intervals) remains a
  human decision; T-63's recorded-policy assertion stays gated on it.
- **P1** — the baseline measurement; E2 stays human-gated.
