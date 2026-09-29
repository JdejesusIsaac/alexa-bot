-- PL-254 / PL-256 (Sprint 3.1 repair): queue fairness and a narrower
-- cross-tenant resolution.
--
-- Three changes, one file — they are the same repair:
--
-- 1. `escalation_attempts` + the `stalled` state. Skipped and failing
--    due rows used to keep their `escalate_at`, so the oldest-first due
--    query starved every healthy row behind them — permanently. Now a
--    skip/fail defers the row and counts the attempt; at the configured
--    ceiling the worker transitions it to `stalled`: terminal, audited,
--    `reason_detail` purged like every other terminal state, and routed
--    to a HUMAN (AD-26: `stalled` never behaves like `approved` — it is
--    unreachable by release/complete by construction of the transition
--    table and by this constraint).
--
-- 2. `pickup_request_belongs_to_tenant(request_id, tenant_id)` replaces
--    `find_pickup_request_tenant`. The old function returned the owning
--    `tenant_id` — an existence-and-mapping oracle for any EXECUTE
--    holder (leak vector 30). The new function confirms membership and
--    returns nothing else: boolean in, boolean out.
--    Still SECURITY DEFINER because the Slack endpoint has no tenant
--    context to query under; the grant is pinned to parentline_app.
--    NOTE (B-14, fixed in migration 0011): SECURITY DEFINER runs as the
--    owner, and the owner is bound by FORCE RLS (it bypasses only when
--    it is a superuser — the superuser-era assumption behind B-10/B-12).
--    The body below queries `pickup_requests` with no tenant context, so
--    as a non-superuser owner it raises `unrecognized configuration
--    parameter "app.tenant_id"`. Migration 0011 replaces this body with
--    one that sets the tenant context transaction-locally first.
--
-- 3. The state/event check constraints gain 'stalled'.

alter table pickup_requests
  drop constraint pickup_requests_state_check,
  add constraint pickup_requests_state_check
    check (state in ('draft', 'routed', 'approved', 'flagged', 'denied',
                     'released', 'completed', 'expired', 'stalled'));

alter table pickup_request_events
  drop constraint pickup_request_events_event_type_check,
  add constraint pickup_request_events_event_type_check
    check (event_type in ('routed', 'escalated', 'approved', 'flagged',
                          'denied', 'released', 'completed', 'expired',
                          'refused', 'stalled'));

alter table pickup_requests
  add column escalation_attempts integer not null default 0
    check (escalation_attempts >= 0);

-- ── Membership-only tenant resolution (leak vector 30) ────────────────

drop function find_pickup_request_tenant(uuid);

create function pickup_request_belongs_to_tenant(
  p_request_id uuid,
  p_tenant_id uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(
    select 1 from pickup_requests
    where id = p_request_id and tenant_id = p_tenant_id
  );
$$;

-- Pinned grant: PUBLIC gets nothing; the application role alone probes
-- membership. A function returning a tenant_id for any EXECUTE holder
-- is exactly what this migration removes.
revoke all on function pickup_request_belongs_to_tenant(uuid, uuid) from public;
grant execute on function pickup_request_belongs_to_tenant(uuid, uuid) to parentline_app;
