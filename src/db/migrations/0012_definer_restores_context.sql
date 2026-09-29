-- F-11 (Sprint 6 final pass): a SECURITY DEFINER function must not leak
-- the tenant it probed into the caller's transaction.
--
-- 0011 set `app.tenant_id` transaction-locally (`set_config(…, true)`)
-- and relied on "each caller query is its own transaction, so nothing
-- lingers." That is a property of the call SITE — the Slack endpoint's
-- dedicated autocommit probe — not of the function. Inside a caller's
-- transaction that already has a tenant set, the probed tenant stayed
-- set for the rest of that transaction: any future caller inside
-- `withTenantTransaction` would continue under the tenant the function
-- checked — a cross-tenant leak waiting for a caller.
--
-- The function now saves the caller's context and restores it before
-- returning, on the success path AND the error path (a caller catching
-- the error inside its own plpgsql handler would otherwise continue
-- under the probed tenant). A previously-unset context restores to ''
-- — the codebase's reset convention (`withTenant` resets with
-- `set_config('app.tenant_id', '', …)`); under the tenant policy ''
-- still fails closed at the `::uuid` cast.
--
-- A NEW migration, not an in-place edit of 0011: the runner applies
-- files by name, so an already-migrated database receives this fix too
-- (F-10). CREATE OR REPLACE preserves the SECURITY DEFINER flag, the
-- boolean signature, and the `parentline_app`-only EXECUTE grant that
-- T-82 pins.

create or replace function pickup_request_belongs_to_tenant(
  p_request_id uuid,
  p_tenant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
  v_belongs boolean;
begin
  -- Save the caller's context, then scope RLS to the tenant under
  -- question (B-14): the owner is bound by FORCE RLS, so the policy's
  -- current_setting must resolve while the probe runs.
  v_prev := current_setting('app.tenant_id', true);
  perform set_config('app.tenant_id', p_tenant_id::text, true);
  select exists(
    select 1 from pickup_requests
    where id = p_request_id and tenant_id = p_tenant_id
  ) into v_belongs;
  perform set_config('app.tenant_id', coalesce(v_prev, ''), true);
  return v_belongs;
exception when others then
  perform set_config('app.tenant_id', coalesce(v_prev, ''), true);
  raise;
end;
$$;
