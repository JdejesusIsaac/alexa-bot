-- PL-296 (Sprint 6 closeout, B-14): the membership definer runs under
-- FORCE RLS as its owner, and the owner does NOT bypass forced RLS.
--
-- `pickup_request_belongs_to_tenant` (migration 0010) is SECURITY
-- DEFINER, so it executes as its owner. FORCE ROW LEVEL SECURITY binds
-- the owner too — that is the entire posture (0001, T-05) — and the
-- Slack endpoint calls this function with NO `app.tenant_id` set: it is
-- probing WHICH tenant a request belongs to, before any tenant context
-- exists (PL-257). The plain-SQL body then evaluates the pickup_requests
-- policy `tenant_id = current_setting('app.tenant_id')::uuid` with the
-- setting unset and raises `unrecognized configuration parameter
-- "app.tenant_id"` — a 500 on every Slack interaction as the
-- non-superuser owner the README documents. A superuser owner bypasses
-- RLS and hides it (local, CI, and Railway's superuser-by-default).
--
-- This is the third instance of one belief — "the owner bypasses RLS" —
-- after B-10 (the 0004 backfill) and B-12 (owner-role seeding). The
-- owner bypasses RLS ONLY when it is a superuser; under FORCE RLS,
-- applied deliberately here, it does not.
--
-- The fix keeps membership-only semantics and adds no disclosure. The
-- function sets the tenant context to the tenant it is ASKED about,
-- transaction-locally, then asks the RLS-scoped question. With
-- `app.tenant_id = p_tenant_id` the policy resolves to
-- `tenant_id = p_tenant_id`, so `exists(...)` is true iff the request is
-- in that tenant — exactly the boolean the endpoint needs, nothing more.
-- `is_local => true` scopes the setting to the function's own (implicit)
-- transaction; under node-postgres each caller query is its own
-- transaction, so nothing lingers on a pooled connection (verified: a
-- second statement on the same connection reads the setting back as
-- unset).
--
-- A NEW migration, not an in-place edit of 0010: the runner applies
-- files by name, so an already-migrated database receives this fix too
-- (F-10). CREATE OR REPLACE preserves the SECURITY DEFINER flag, the
-- boolean signature, and the `parentline_app`-only EXECUTE grant that
-- T-82 pins — so nothing about the leak posture (leak vector 30) changes.

create or replace function pickup_request_belongs_to_tenant(
  p_request_id uuid,
  p_tenant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Scope RLS to the tenant under question, transaction-locally. The
  -- owner is bound by FORCE RLS; without a tenant context the policy's
  -- current_setting('app.tenant_id') is unset and raises (B-14).
  perform set_config('app.tenant_id', p_tenant_id::text, true);
  return exists(
    select 1 from pickup_requests
    where id = p_request_id and tenant_id = p_tenant_id
  );
end;
$$;
