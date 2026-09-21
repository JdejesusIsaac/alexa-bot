-- PL-202: pickup_requests schema — the request spine.
--
-- A pickup request is the first write path that moves a scholar out of a
-- building. The state machine is enforced in ONE application function
-- (src/repositories/pickup-requests.ts, transitionPickupRequest) — no
-- handler writes `state` directly, the same chokepoint discipline as
-- `project()`. This migration carries the tables; T-55 guards the
-- chokepoint structurally.
--
-- P3 decision (2026-09-21, product default per AD-28 + AD-43):
--  - reason_detail clearance `never`; no reason in Slack payloads,
--    category included. The purge below is the enforcement point.
--  - Retention: purge reason_detail at terminal states when the tenant
--    retention is 0 (the default); `tenant_settings` widens it per
--    tenant as config, not a migration.
--
-- Composite tenant FKs: a request's scholar and contact must belong to
-- the request's own tenant. A plain FK on student_id would happily
-- reference another tenant's student; the composite keys make that
-- structurally impossible (leak vector 21's write-side twin).

-- ── students / authorized_contacts: tenant-anchored uniqueness ──────
-- Anchors for the composite FKs below. (tenant_id, id) uniqueness is
-- implied today (id is the PK) but must exist explicitly as a constraint
-- for the FK to reference.

alter table students
  add constraint students_tenant_id_id_key unique (tenant_id, id);

alter table authorized_contacts
  add constraint authorized_contacts_tenant_id_id_key unique (tenant_id, id);

-- ── pickup_requests ──────────────────────────────────────────────────

create table pickup_requests (
  id                      uuid        primary key default gen_random_uuid(),
  tenant_id               uuid        not null references tenants(id),
  service_date            date        not null,
  student_id              uuid        not null,
  pickup_at               timestamptz not null,
  -- Constrained vocabulary (F-5): free text is what happens without a
  -- controlled vocabulary. Five-value product default under AD-43;
  -- widening is a written decision, not a migration.
  reason_category         text        not null
    check (reason_category in ('appointment', 'family', 'illness', 'administrative', 'other')),
  -- Clearance `never` (P3, AD-28): written at intake, read only in-app
  -- inside a tenant context, purged per the retention rule. Never in a
  -- tool response, notification, log, or trace.
  reason_detail           text,
  requested_by_contact_id uuid,
  intake_channel          text        not null
    check (intake_channel in ('coordinator', 'aircall')),
  state                   text        not null default 'draft'
    check (state in ('draft', 'routed', 'approved', 'flagged', 'denied',
                     'released', 'completed', 'expired')),
  -- Resolves against staff_identities (PL-205); no FK until that table
  -- exists. A uuid now so the reference never changes shape.
  assigned_approver_id    uuid,
  escalation_level        integer     not null default 0
    check (escalation_level >= 0),
  escalate_at             timestamptz,
  decided_at              timestamptz,
  decided_by              text,
  released_at             timestamptz,
  completed_at            timestamptz,
  expired_at              timestamptz,
  created_at              timestamptz not null default now(),

  constraint pickup_requests_student_fk
    foreign key (tenant_id, student_id) references students (tenant_id, id),
  constraint pickup_requests_contact_fk
    foreign key (tenant_id, requested_by_contact_id)
    references authorized_contacts (tenant_id, id)
);

-- ── pickup_request_events ────────────────────────────────────────────
-- Append-only ledger. `escalation_level` is NOT NULL only for ladder
-- events ('routed' at 0, 'escalated' at 1..n): unique (request_id,
-- escalation_level) means a double-fired rung cannot double-notify —
-- the guarantee lives in the database (T-57). NULL levels are distinct
-- under Postgres uniqueness, so decision and refusal events never
-- collide with the ladder.

create table pickup_request_events (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants(id),
  request_id       uuid        not null references pickup_requests(id),
  escalation_level integer,
  event_type       text        not null
    check (event_type in ('routed', 'escalated', 'approved', 'flagged',
                          'denied', 'released', 'completed', 'expired', 'refused')),
  actor            text        not null,
  created_at       timestamptz not null default now(),
  unique (request_id, escalation_level)
);

-- ── tenant_settings ──────────────────────────────────────────────────
-- Per-tenant retention for reason_detail (P3). 0 = the default: purge
-- at terminal state, nightly sweep at end of service_date. Widening is
-- a row, not a migration — "widen on a written decision" (AD-43).

create table tenant_settings (
  tenant_id                    uuid        primary key references tenants(id),
  reason_detail_retention_days integer     not null default 0
    check (reason_detail_retention_days >= 0),
  updated_at                   timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────

create index idx_pickup_requests_tenant        on pickup_requests (tenant_id);
create index idx_pickup_requests_service_date on pickup_requests (tenant_id, service_date);
-- The escalation worker's due queue (PL-204): state = 'routed' and
-- escalate_at < now(), polled with FOR UPDATE SKIP LOCKED.
create index idx_pickup_requests_due          on pickup_requests (escalate_at)
  where state = 'routed';
create index idx_pickup_request_events_request on pickup_request_events (request_id);
create index idx_pickup_request_events_tenant on pickup_request_events (tenant_id);

-- ── Row Level Security ──────────────────────────────────────────────
-- Same posture as every student-data table: enabled AND forced; the app
-- role is not the owner (AD-11, T-05). Policy identical to the rest.

alter table pickup_requests      enable row level security;
alter table pickup_requests      force  row level security;
alter table pickup_request_events enable row level security;
alter table pickup_request_events force  row level security;
alter table tenant_settings      enable row level security;
alter table tenant_settings      force  row level security;

create policy tenant_isolation on pickup_requests
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on pickup_request_events
  using (tenant_id = current_setting('app.tenant_id')::uuid);

create policy tenant_isolation on tenant_settings
  using (tenant_id = current_setting('app.tenant_id')::uuid);

-- ── Grants ───────────────────────────────────────────────────────────
-- pickup_requests: the state machine UPDATEs rows; nothing ever deletes
-- a request. pickup_request_events: INSERT and SELECT only — append-
-- only at the grant level, the audit_log posture (T-56 mirrors T-10).
-- tenant_settings: a config row — select, insert, update.

grant select, insert, update on pickup_requests to parentline_app;
grant select, insert on pickup_request_events to parentline_app;
grant select, insert, update on tenant_settings to parentline_app;

revoke update, delete on pickup_request_events from parentline_app;
revoke delete on pickup_requests from parentline_app;
