-- PL-207: cross-tenant request resolution for the Slack interaction endpoint.
--
-- The Slack endpoint verifies a Slack signature, not a tenant token —
-- there is no auth context to derive a tenant from, and the app role
-- cannot enumerate tenants (RLS by design). But T-66 requires that a
-- cross-tenant request_id be indistinguishable from a nonexistent one
-- in message, code, and timing — so the endpoint must resolve WHICH
-- tenant a request belongs to without the resolution itself leaking
-- existence.
--
-- This function is the narrow answer: SECURITY DEFINER, read-only,
-- returns tenant_id or NULL and nothing else. It is never exposed in
-- any response — the endpoint answers not-found identically whether
-- the id resolves to another tenant or to nothing.

create function find_pickup_request_tenant(p_request_id uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select tenant_id from pickup_requests where id = p_request_id;
$$;

-- Deliberately not granted to PUBLIC. The app role gets execute only;
-- the function cannot be used to read any column but tenant_id, and
-- the endpoint never discloses that.
revoke all on function find_pickup_request_tenant(uuid) from public;
grant execute on function find_pickup_request_tenant(uuid) to parentline_app;
