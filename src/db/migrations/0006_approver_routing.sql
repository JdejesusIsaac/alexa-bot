-- PL-203: approver routing — the tribal-knowledge artifact (F-15).
--
-- "Which leader for which grade, and who to try next" lives in operators'
-- heads at a campus with high turnover. This table is that knowledge,
-- encoded. Treat it as a deliverable, not as config.
--
-- Resolution is most-specific-wins and TOTAL: section > grade > default.
-- A `default` row is required per tenant so every scholar resolves to
-- exactly one approver (AD-27: one named approver, never a broadcast).
-- The totality check fails loudly at seed time (T-59) — the alternative
-- is the first unmatched request resolving to nobody at 1:50 pm, which
-- is the moment this sprint exists to protect.

-- ── students: grade ──────────────────────────────────────────────────
-- The routing resolver matches grade rules against it. Nullable on
-- purpose: no sheet column populates it yet — it is set per campus when
-- their sheet maps a grade field (a canonical widening, by written
-- decision), or directly during provisioning. A null grade simply never
-- matches a grade rule and falls through to `default`.

alter table students add column grade text;

-- ── approver_routing ──────────────────────────────────────────────────

create table approver_routing (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants(id),
  scope_type  text        not null
    check (scope_type in ('section', 'grade', 'default')),
  -- NULL if and only if scope_type = 'default'.
  scope_value text
    check ((scope_type = 'default') = (scope_value is null)),
  -- Resolves against staff_identities (PL-205); no FK until that table
  -- exists — the same forward-compatible uuid as
  -- pickup_requests.assigned_approver_id.
  approver_id uuid        not null,
  -- Deterministic tiebreak within a scope level. Section, grade, and
  -- default can never collide today (one value per scholar attribute);
  -- priority guarantees stable resolution if a future scope ever allows
  -- multiple matches.
  priority    integer     not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, scope_type, scope_value)
);

-- Exactly one `default` row per tenant. The plain unique constraint
-- above treats the default row's NULL scope_value as distinct and would
-- allow two of them — resolution ambiguity at the exact rung meant to
-- guarantee totality. The partial index is the direct statement.
create unique index approver_routing_one_default
  on approver_routing (tenant_id)
  where scope_type = 'default';

create index idx_approver_routing_tenant on approver_routing (tenant_id);

-- ── Row Level Security ──────────────────────────────────────────────

alter table approver_routing enable row level security;
alter table approver_routing force  row level security;

create policy tenant_isolation on approver_routing
  using (tenant_id = current_setting('app.tenant_id')::uuid);

-- ── Grants ───────────────────────────────────────────────────────────
-- Routing rules are per-tenant administrative config: full CRUD for the
-- app role, tenant-scoped by RLS. No student data lives here.

grant select, insert, update, delete on approver_routing to parentline_app;
