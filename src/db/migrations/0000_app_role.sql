-- PL-002: Provision the non-owner application role.
--
-- The application connects as parentline_app — a non-superuser, non-owner
-- role. An owner can disable or drop the RLS policies outright — and
-- bypasses them silently on any table where FORCE is missing — so if
-- the app role owned the tables it would make the isolation gate
-- vacuous (AD-11, T-05).
--
-- This is infrastructure, not schema. Separated from 0001 so that the
-- schema migration is pure DDL.

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'parentline_app'
  ) then
    create role parentline_app login;
  end if;
end
$$;
