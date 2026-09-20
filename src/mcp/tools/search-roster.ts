/**
 * `search_roster` — the roster listing tool (PL-108).
 *
 * Today's roster, optionally filtered by section, hold type, or
 * attendance status, paginated and capped. Every declared filter is
 * implemented (AD-15, T-43) — a declared-but-ignored filter makes the
 * model confidently assert a narrowing that never happened.
 *
 * An empty result is a success with zero entries — distinguishable by
 * construction from a failure (the page carries its own total).
 *
 * Description is customer-facing copy (AD-16), deliberately disjoint
 * from `lookup_scholar_status` (wrong-tool selection; PL-107/PL-108).
 *
 * Like the lookup tool, this refuses on a stale or failed roster rather
 * than presenting yesterday's list as today's (AD-7).
 */

import { z } from 'zod';
import { withTenant } from '../../db/tenant-context.js';
import {
  searchRosterEntries,
  type RosterSearchPage,
} from '../../repositories/roster-entries.js';
import { isRosterFresh, findLatestSync } from '../../repositories/roster-syncs.js';
import { project } from '../../disclosure/policy.js';
import { REFUSAL_COPY, requireRequestMeta, type ToolDeps } from './common.js';
import type { LookupResult } from './lookup-scholar-status.js';

export const SEARCH_ROSTER_NAME = 'search_roster';

export const SEARCH_ROSTER_DESCRIPTION = [
  'List the scholars on today\u2019s dismissal roster, optionally narrowed by homeroom section,',
  'hold type, or attendance status. Use this tool when someone asks for a group — a whole roster,',
  'a section, or everyone with a given hold. Do not use it to look up one specific scholar.',
  'Returns a page of scholars with the total match count; the result can be paged.',
].join(' ');

export const SEARCH_ROSTER_INPUT = {
  section: z.string().min(1).optional(),
  hold_type: z.string().min(1).optional(),
  attendance_status: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
} as const;

const MAX_PAGE_SIZE = 50;

interface SearchOutcome {
  readonly kind: 'success';
  readonly page: RosterSearchPage;
  readonly projected: ReadonlyArray<Record<string, unknown>>;
}

export async function handleSearchRoster(
  rawArgs: unknown,
  extra: unknown,
  deps: ToolDeps,
): Promise<LookupResult> {
  const meta = requireRequestMeta(extra);
  const { identity } = meta;
  const toolStart = performance.now();

  const parsed = z
    .object(SEARCH_ROSTER_INPUT)
    .passthrough()
    .safeParse(rawArgs ?? {});
  if (!parsed.success) {
    // Enrichment only — the boundary writes the audit row (AD-42).
    meta.toolAudit = {
      tool: SEARCH_ROSTER_NAME,
      argumentsRedacted: {},
      outcome: 'refusal:invalid_arguments',
      toolMs: Math.round(performance.now() - toolStart),
    };
    return {
      content: [{ type: 'text', text: REFUSAL_COPY.invalid_arguments! }],
      isError: true,
      structuredContent: { kind: 'refusal', reason: 'invalid_arguments' },
    };
  }

  const args = parsed.data;
  const recordedFilters = {
    filters: {
      section: args.section ?? null,
      hold_type: args.hold_type ?? null,
      attendance_status: args.attendance_status ?? null,
    },
    limit: Math.min(args.limit, MAX_PAGE_SIZE),
    offset: args.offset,
  };

  const result = await withTenant(deps.appPool, identity.tenantId, async (client) => {
    const fresh = await isRosterFresh(client, deps.rosterFreshnessMinutes);
    if (!fresh) {
      const latest = await findLatestSync(client);
      return latest && latest.outcome === 'failure'
        ? { kind: 'refusal' as const, reason: 'sync_failed' }
        : { kind: 'refusal' as const, reason: 'roster_stale' };
    }

    const filters: { section?: string; holdType?: string; attendanceStatus?: string } =
      {};
    if (args.section !== undefined) filters.section = args.section;
    if (args.hold_type !== undefined) filters.holdType = args.hold_type;
    if (args.attendance_status !== undefined) {
      filters.attendanceStatus = args.attendance_status;
    }

    const page = await searchRosterEntries(client, filters, {
      limit: Math.min(args.limit, MAX_PAGE_SIZE),
      offset: args.offset,
    });

    const projected = page.entries.map((entry) =>
      project(
        entry as unknown as Record<string, unknown>,
        SEARCH_ROSTER_NAME,
        identity.role,
      ),
    );

    return { kind: 'success' as const, page, projected } satisfies SearchOutcome;
  });

  const toolMs = Math.round(performance.now() - toolStart);
  const totalMs = Math.round(performance.now() - meta.requestStartedAt);

  // One enrichment slot, every outcome — the boundary writes the audit
  // row from it (AD-42).
  meta.toolAudit = {
    tool: SEARCH_ROSTER_NAME,
    argumentsRedacted: recordedFilters,
    outcome: result.kind === 'refusal' ? `refusal:${result.reason}` : 'success',
    toolMs,
  };

  if (result.kind === 'refusal') {
    return {
      content: [{ type: 'text', text: REFUSAL_COPY[result.reason] ?? result.reason }],
      isError: true,
      structuredContent: { kind: 'refusal', reason: result.reason },
    };
  }

  deps.logger.info({
    msg: 'tool_call',
    tenant_id: identity.tenantId,
    request_id: meta.requestId,
    tool: SEARCH_ROSTER_NAME,
    outcome: 'success',
    tool_ms: toolMs,
    total_ms: totalMs,
    result_count: result.page.total,
  });

  const summary =
    result.page.total === 0
      ? 'No scholars on today\u2019s roster match those filters.'
      : `${result.page.entries.length} of ${result.page.total} matching scholars shown.`;

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: {
      kind: 'success',
      total: result.page.total,
      limit: result.page.limit,
      offset: result.page.offset,
      scholars: result.projected,
    },
  };
}
