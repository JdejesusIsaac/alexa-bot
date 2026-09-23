-- PL-205: staff_identities — the Slack actor maps to the audit subject.
--
-- AD-29: a Slack actor decides only through staff_identities. An inbound
-- slack_user_id resolves to the SAME audit subject used everywhere else
-- (the auth layer's `sub`), or it cannot transition a request — typed
-- refusal, audited. E5: zero decision rows attributable only to a Slack
-- user id.
--
-- This is also the table pickup_requests.assigned_approver_id and
-- approver_routing.approver_id were held FK-less for ("no FK until that
-- table exists"): the composite tenant FKs land here. Approvers must be
-- registered staff — the fast decision path (PL-207) arrives over Slack,
-- so a configured approver without a Slack mapping could never be
-- notified.

-- ── staff_identities ──────────────────────────────────────────────────

create table staff_identities (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants(id),
  slack_user_id text        not null,
  -- The audit subject used everywhere else — never the Slack id.
  subject       text        not null,
  role          text        not null check (role in ('staff', 'admin')),
  created_at    timestamptz not null default now(),
  unique (tenant_id, slack_user_id)
);

-- Anchor for the composite tenant FKs below (same pattern as students).
alter table staff_identities
  add constraint staff_identities_tenant_id_id_key unique (tenant_id, id);

create index idx_staff_identities_tenant on staff_identities (tenant_id);
create index idx_staff_identities_subject on staff_identities (tenant_id, subject);

-- ── Decision events carry the channel they arrived through ────────────
-- T-67: each decision row carries the subject, the tenant, the request,
-- the decision, AND the channel. Existing rows were written by the app,
-- so the backfill default is 'app'.

alter table pickup_request_events
  add column channel text not null default 'app'
    check (channel in ('slack', 'app', 'worker'));

-- ── The deferred FKs land ─────────────────────────────────────────────
-- NOT VALID on purpose: approver rows seeded before this registry exist
-- in dev databases, and a validated FK would fail the migration there.
-- New writes ARE checked — the seed inserts identities before routing,
-- so freshly seeded databases are fully consistent. VALIDATE the
-- constraints after any pre-registry dev database is re-seeded.

alter table approver_routing
  add constraint approver_routing_approver_fk
  foreign key (tenant_id, approver_id) references staff_identities (tenant_id, id)
  not valid;

alter table pickup_requests
  add constraint pickup_requests_approver_fk
  foreign key (tenant_id, assigned_approver_id)
  references staff_identities (tenant_id, id)
  not valid;

-- ── Row Level Security ──────────────────────────────────────────────

alter table staff_identities enable row level security;
alter table staff_identities force  row level security;

create policy tenant_isolation on staff_identities
  using (tenant_id = current_setting('app.tenant_id')::uuid);

-- ── Grants ───────────────────────────────────────────────────────────
-- The staff registry is administrative config: full CRUD, tenant-scoped.

grant select, insert, update, delete on staff_identities to parentline_app;
