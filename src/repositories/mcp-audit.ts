/**
 * MCP audit repository (PL-110, T-40).
 *
 * One entry per MCP request: tool calls, refusals, and auth failures.
 * The actor is the token subject; the outcome is a stable code. Recorded
 * arguments are tenant-safe by construction — student identifiers are
 * never included, so nothing here depends on a redaction list to be safe.
 *
 * Two insert paths, both RLS-constrained:
 *
 * - `insertTenantMcpAuditEntry` — for authenticated requests, called
 *   INSIDE `withTenant` with a tenant-scoped client. The tenant_id
 *   column value is set by RLS from the session variable — never passed
 *   as a parameter (rule 7), exactly like every other tenant insert.
 *
 * - `insertUnauthenticatedMcpAuditEntry` — for requests that failed auth.
 *   There is no tenant context (the token was rejected before one could
 *   be derived); the row is written with tenant_id NULL, which the RLS
 *   policy permits. NULL-tenant rows carry no student data.
 *
 * Append-only: this repository exposes INSERT and SELECT only.
 */

import { type Pool, type PoolClient } from 'pg';

export interface McpAuditEntry {
  id: string;
  tenant_id: string | null;
  request_id: string;
  actor: string;
  role: string | null;
  http_method: string;
  rpc_method: string | null;
  tool: string | null;
  arguments_redacted: Record<string, unknown>;
  outcome: string;
  auth_ms: number | null;
  tool_ms: number | null;
  total_ms: number | null;
  created_at: string;
}

export interface McpAuditInsert {
  readonly requestId: string;
  readonly actor: string;
  readonly role: string | null;
  readonly httpMethod: string;
  readonly rpcMethod: string | null;
  readonly tool: string | null;
  /** Tenant-safe by construction — no student identifiers, ever. */
  readonly argumentsRedacted: Record<string, unknown>;
  readonly outcome: string;
  readonly authMs: number | null;
  readonly toolMs: number | null;
  readonly totalMs: number | null;
}

const COLUMNS = `tenant_id, request_id, actor, role, http_method, rpc_method, tool, arguments_redacted, outcome, auth_ms, tool_ms, total_ms`;

/** Authenticated request — insert inside the tenant context (RLS-checked). */
export async function insertTenantMcpAuditEntry(
  client: PoolClient,
  entry: McpAuditInsert,
): Promise<McpAuditEntry> {
  const res = await client.query<McpAuditEntry>(
    `insert into mcp_audit (${COLUMNS})
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      entry.requestId,
      entry.actor,
      entry.role,
      entry.httpMethod,
      entry.rpcMethod,
      entry.tool,
      JSON.stringify(entry.argumentsRedacted),
      entry.outcome,
      entry.authMs,
      entry.toolMs,
      entry.totalMs,
    ],
  );
  return res.rows[0]!;
}

/** Auth failure — insert with tenant_id NULL (no tenant was derived). */
export async function insertUnauthenticatedMcpAuditEntry(
  pool: Pool,
  entry: McpAuditInsert,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `insert into mcp_audit (${COLUMNS})
       values (null, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.requestId,
        entry.actor,
        entry.role,
        entry.httpMethod,
        entry.rpcMethod,
        entry.tool,
        JSON.stringify(entry.argumentsRedacted),
        entry.outcome,
        entry.authMs,
        entry.toolMs,
        entry.totalMs,
      ],
    );
  } finally {
    client.release();
  }
}

/**
 * Find audit entries for the current tenant, newest first. Reads happen
 * inside a tenant context; NULL-tenant rows (auth failures) are also
 * visible there — they are global security events with no student data.
 */
export async function findMcpAuditEntries(
  client: PoolClient,
  limit: number,
): Promise<McpAuditEntry[]> {
  const res = await client.query<McpAuditEntry>(
    `select * from mcp_audit order by created_at desc limit $1`,
    [limit],
  );
  return res.rows;
}
