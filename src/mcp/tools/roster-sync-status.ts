/**
 * `roster_sync_status` — the sync health tool (PL-109).
 *
 * Last sync, quarantine counts with reasons, and staleness — the
 * diagnostic surface for "why is the data stale." Admin only: a `staff`
 * token receives a typed authorization refusal, never an empty result
 * standing in for a denial (T-39) — the failure mode this project
 * exists to prevent, at a new layer.
 *
 * Quarantine summaries carry counts and reasons only, never row
 * contents — quarantined rows may include unvalidated free text.
 */

import { withTenant } from '../../db/tenant-context.js';
import { findLatestSync } from '../../repositories/roster-syncs.js';
import { summarizeQuarantine } from '../../repositories/quarantined-rows.js';
import { insertTenantMcpAuditEntry } from '../../repositories/mcp-audit.js';
import { REFUSAL_COPY, requireRequestMeta, type ToolDeps } from './common.js';
import type { LookupResult } from './lookup-scholar-status.js';

export const ROSTER_SYNC_STATUS_NAME = 'roster_sync_status';

export const ROSTER_SYNC_STATUS_DESCRIPTION = [
  'Check the health of the roster data feed: when the roster was last refreshed, whether it is',
  'current, and how many rows were quarantined with the reasons. Requires an administrative',
  'role. Use this tool to diagnose why dismissal-status answers might be stale or incomplete.',
].join(' ');

export async function handleRosterSyncStatus(
  _rawArgs: unknown,
  extra: unknown,
  deps: ToolDeps,
): Promise<LookupResult> {
  const meta = requireRequestMeta(extra);
  const { identity } = meta;
  const toolStart = performance.now();

  if (identity.role !== 'admin') {
    // T-39 — an authorization refusal distinguishable from an empty
    // result. Refuse before touching tenant data.
    await withTenant(deps.appPool, identity.tenantId, (client) =>
      insertTenantMcpAuditEntry(client, {
        requestId: meta.requestId,
        actor: identity.sub,
        role: identity.role,
        httpMethod: 'POST',
        rpcMethod: 'tools/call',
        tool: ROSTER_SYNC_STATUS_NAME,
        argumentsRedacted: {},
        outcome: 'refusal:insufficient_role',
        authMs: Math.round(meta.authMs),
        toolMs: Math.round(performance.now() - toolStart),
        totalMs: Math.round(performance.now() - meta.requestStartedAt),
      }),
    );
    return {
      content: [{ type: 'text', text: REFUSAL_COPY.insufficient_role! }],
      isError: true,
      structuredContent: { kind: 'refusal', reason: 'insufficient_role' },
    };
  }

  const result = await withTenant(deps.appPool, identity.tenantId, async (client) => {
    const latest = await findLatestSync(client);
    const quarantined = await summarizeQuarantine(client);
    return { latest, quarantined };
  });

  const toolMs = Math.round(performance.now() - toolStart);
  const totalMs = Math.round(performance.now() - meta.requestStartedAt);

  await withTenant(deps.appPool, identity.tenantId, (client) =>
    insertTenantMcpAuditEntry(client, {
      requestId: meta.requestId,
      actor: identity.sub,
      role: identity.role,
      httpMethod: 'POST',
      rpcMethod: 'tools/call',
      tool: ROSTER_SYNC_STATUS_NAME,
      argumentsRedacted: {},
      outcome: 'success',
      authMs: Math.round(meta.authMs),
      toolMs,
      totalMs,
    }),
  );

  const lastSyncAt = result.latest?.finished_at ?? null;
  const ageMinutes =
    lastSyncAt !== null
      ? Math.max(0, Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 60000))
      : null;
  const isFresh = ageMinutes !== null && ageMinutes <= deps.rosterFreshnessMinutes;

  deps.logger.info({
    msg: 'tool_call',
    tenant_id: identity.tenantId,
    request_id: meta.requestId,
    tool: ROSTER_SYNC_STATUS_NAME,
    outcome: 'success',
    tool_ms: toolMs,
    total_ms: totalMs,
  });

  const summary =
    lastSyncAt !== null
      ? `Roster last refreshed ${ageMinutes} minutes ago (outcome: ${result.latest?.outcome}). ${result.quarantined.total} quarantined rows.`
      : 'Roster has never been synced.';

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: {
      kind: 'success',
      last_sync_at: lastSyncAt,
      last_outcome: result.latest?.outcome ?? null,
      roster_age_minutes: ageMinutes,
      is_fresh: isFresh,
      quarantined: result.quarantined,
    },
  };
}
