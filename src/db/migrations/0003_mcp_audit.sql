-- PL-110 — MCP audit table.
--
-- One row per MCP request: tool calls, refusals, and auth failures (T-40).
--
-- tenant_id is NULLABLE by design: an auth failure happens before tenant
-- context exists — there is no tenant to attribute. NULL-tenant rows carry
-- no student data (actor unknown or token subject, method, outcome code,
-- latency stages) and are visible to any tenant session under the RLS
-- policy below; they are global security events, not campus records.
--
-- Tenant-attributed rows (authenticated tool calls) follow the same
-- discipline as audit_log: inserted inside the tenant context, scoped by
-- RLS, append-only (INSERT and SELECT only — no UPDATE, no DELETE).

create table mcp_audit (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        references tenants(id),
  request_id  text        not null,
  actor       text        not null,
  role        text,
  http_method text        not null,
  rpc_method  text,
  tool        text,
  arguments_redacted jsonb not null default '{}',
  outcome     text        not null,
  auth_ms     int,
  tool_ms     int,
  total_ms    int,
  created_at  timestamptz not null default now()
);

alter table mcp_audit enable row level security;
alter table mcp_audit force  row level security;

-- Tenant rows scope by the active session variable (missing_ok: outside a
-- tenant context, current_setting is NULL and only NULL-tenant rows —
-- auth failures — are visible/writable). This is the one table where an
-- insert outside withTenant is legitimate: tenant_id IS NULL there.
create policy tenant_isolation on mcp_audit
  using  (tenant_id is null or tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id is null or tenant_id = current_setting('app.tenant_id', true)::uuid);

create index idx_mcp_audit_tenant   on mcp_audit (tenant_id);
create index idx_mcp_audit_created  on mcp_audit (created_at);
create index idx_mcp_audit_actor    on mcp_audit (actor);

-- Append-only in grants as in code: INSERT and SELECT, nothing else.
grant insert, select on mcp_audit to parentline_app;
