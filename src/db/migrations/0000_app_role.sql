-- PL-002: Provision the non-owner application role.
--
-- The application connects as parentline_app — a non-superuser, non-owner
-- role. Table owners bypass RLS silently, so if the app role owned the
-- tables it would make the entire isolation gate vacuous (AD-11, T-05).
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
