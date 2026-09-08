-- PL-002: Schema, RLS, and grants.
--
-- Nine tables with tenant_id on every student-data table. RLS enabled AND
-- forced. The application role (parentline_app) is neither superuser nor
-- table owner — owners bypass RLS silently (AD-11, T-05).
--
-- RLS policy: tenant_id = current_setting('app.tenant_id')::uuid
-- No missing_ok — an unset session variable errors rather than returning
-- everything (T-02).

-- ── tenants ──────────────────────────────────────────────────────────

create table tenants (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  created_at  timestamptz not null default now()
);

-- ── students ─────────────────────────────────────────────────────────

create table students (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants(id),
  student_ref   text        not null,
  student_name  text        not null,
  section       text,
  do_not_call   boolean     not null default false,
  unique (tenant_id, student_ref)
);

-- ── authorized_contacts ─────────────────────────────────────────────

create table authorized_contacts (
  id            uuid  primary key default gen_random_uuid(),
  tenant_id     uuid  not null references tenants(id),
  student_id    uuid  not null references students(id),
  contact_name  text  not null,
  relationship  text  not null,
  phone         text
);

-- ── roster_syncs ────────────────────────────────────────────────────

create table roster_syncs (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants(id),
  started_at        timestamptz not null,
  finished_at       timestamptz,
  rows_in           integer     not null default 0,
  rows_valid        integer     not null default 0,
  rows_quarantined  integer     not null default 0,
  outcome           text        not null default 'success'
);

-- ── roster_entries ──────────────────────────────────────────────────

create table roster_entries (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants(id),
  student_id        uuid        references students(id),
  student_ref       text        not null,
  student_name      text        not null,
  section           text,
  attendance_status text,
  reason_code       text,
  hold_type         text,
  hold_source       text        not null default 'authoritative'
    check (hold_source in ('derived', 'authoritative')),
  release_time      text,
  hold_location     text,
  do_not_call       boolean     not null default false,
  missing_id        boolean     not null default false,
  source_row_number integer     not null,
  sync_id           uuid        not null references roster_syncs(id)
);

-- ── quarantined_rows ────────────────────────────────────────────────

create table quarantined_rows (
  id                uuid     primary key default gen_random_uuid(),
  tenant_id         uuid     not null references tenants(id),
  sync_id           uuid     not null references roster_syncs(id),
  source_row_number integer  not null,
  raw_data          jsonb    not null,
  reason            text     not null
);

-- ── audit_log ───────────────────────────────────────────────────────
-- Append-only. UPDATE and DELETE are revoked at the grant level (T-10).

create table audit_log (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants(id),
  actor               text        not null,
  action              text        not null,
  subject_student_ref text,
  fields_disclosed    text[]      not null default '{}',
  outcome             text        not null,
  created_at          timestamptz not null default now()
);

-- ── column_mappings ─────────────────────────────────────────────────
-- Per-tenant header → canonical field mapping. Explicit config, no
-- inference (AD-6, PL-004).

create table column_mappings (
  id              uuid  primary key default gen_random_uuid(),
  tenant_id       uuid  not null references tenants(id),
  sheet_header    text  not null,
  canonical_field text  not null
);

-- ── derivation_rules ────────────────────────────────────────────────
-- Per-tenant hold derivation config (PL-012). Detention is derived from
-- existing columns (Tardy, Missing ID) — not hardcoded logic.

create table derivation_rules (
  id                 uuid  primary key default gen_random_uuid(),
  tenant_id          uuid  not null references tenants(id),
  rule_name          text  not null,
  condition_column   text  not null,
  condition_value    text  not null,
  derived_hold_type  text  not null
);

-- ── Indexes ──────────────────────────────────────────────────────────

create index idx_students_tenant        on students (tenant_id);
create index idx_roster_entries_tenant   on roster_entries (tenant_id);
create index idx_roster_entries_student  on roster_entries (student_id);
create index idx_roster_entries_sync     on roster_entries (sync_id);
create index idx_roster_syncs_tenant     on roster_syncs (tenant_id);
create index idx_quarantined_tenant      on quarantined_rows (tenant_id);
create index idx_audit_log_tenant        on audit_log (tenant_id);
create index idx_authorized_contacts_tenant on authorized_contacts (tenant_id);
create index idx_column_mappings_tenant  on column_mappings (tenant_id);
create index idx_derivation_rules_tenant on derivation_rules (tenant_id);

-- ── Row Level Security ──────────────────────────────────────────────
--
-- ENABLE + FORCE on every table that carries tenant_id, plus tenants
-- itself. FORCE means the table owner is also subject to the policy —
-- without it, the owner bypasses RLS silently (T-05).

alter table tenants             enable row level security;
alter table tenants             force  row level security;
alter table students            enable row level security;
alter table students            force  row level security;
alter table authorized_contacts enable row level security;
alter table authorized_contacts force  row level security;
alter table roster_syncs        enable row level security;
alter table roster_syncs        force  row level security;
alter table roster_entries      enable row level security;
alter table roster_entries      force  row level security;
alter table quarantined_rows    enable row level security;
alter table quarantined_rows    force  row level security;
alter table audit_log           enable row level security;
alter table audit_log           force  row level security;
alter table column_mappings     enable row level security;
alter table column_mappings     force  row level security;
alter table derivation_rules    enable row level security;
alter table derivation_rules    force  row level security;

-- Policy: tenant_id = current_setting('app.tenant_id')::uuid
-- No missing_ok on the cast — an unset session variable raises an error
-- rather than returning all rows (T-02).

create policy tenant_isolation on tenants
  using (id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on students
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on authorized_contacts
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on roster_syncs
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on roster_entries
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on quarantined_rows
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on audit_log
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on column_mappings
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on derivation_rules
  using (tenant_id = current_setting('app.tenant_id')::uuid);

-- ── Grants ──────────────────────────────────────────────────────────
--
-- parentline_app gets SELECT/INSERT/UPDATE on all tables except
-- audit_log, which is INSERT + SELECT only. UPDATE and DELETE on
-- audit_log are revoked explicitly — the database enforces append-only,
-- not the application (T-10).

grant usage on schema public to parentline_app;

grant select, insert, update on
  tenants, students, authorized_contacts, roster_syncs,
  roster_entries, quarantined_rows, column_mappings, derivation_rules
  to parentline_app;

-- audit_log: SELECT and INSERT only — no UPDATE, no DELETE.
grant select, insert on audit_log to parentline_app;

-- Defense-in-depth: explicitly revoke what was never granted.
revoke update, delete on audit_log from parentline_app;

-- Sequences for serial/id generation.
grant usage, select on all sequences in schema public to parentline_app;
