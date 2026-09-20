/**
 * `lookup_scholar_status` — the single-scholar status tool (PL-107).
 *
 * Wraps the Sprint 1 `getScholarStatus` core and projects the result
 * through the disclosure policy (AD-12/17). The four Sprint 1 refusals
 * surface distinctly as returned error responses — never an empty
 * success (the guide's "always return something").
 *
 * Args: exactly one of `student_ref` or `student_name`. No tenant —
 * `tenant_id` is derived from the token, and a forged tenant argument
 * is stripped by schema validation (T-34: ignored, never honored).
 *
 * Description is customer-facing copy (AD-16), deliberately disjoint
 * from `search_roster` (wrong-tool selection; PL-107/PL-108).
 */

import { z } from 'zod';
import { withTenant } from '../../db/tenant-context.js';
import {
  getScholarStatus,
  type ScholarStatusResult,
} from '../../services/scholar-status.js';
import { findByStudentName } from '../../repositories/roster-entries.js';
import { project } from '../../disclosure/policy.js';
import { REFUSAL_COPY, requireRequestMeta, type ToolDeps } from './common.js';

export const LOOKUP_SCHOLAR_STATUS_NAME = 'lookup_scholar_status';

export const LOOKUP_SCHOLAR_STATUS_DESCRIPTION = [
  'Look up the current dismissal status of one specific scholar by student ID or by full name —',
  'their homeroom section, whether they are being held after dismissal, the hold type, the release',
  'time, and the location to collect them. Use this tool when someone asks about one scholar.',
  'Do not use it to list or compare multiple scholars. Returns the scholar\u2019s status, or a clear',
  'explanation of why the status cannot be answered right now.',
].join(' ');

export const LOOKUP_SCHOLAR_STATUS_INPUT = {
  student_ref: z.string().min(1).optional(),
  student_name: z.string().min(1).optional(),
} as const;

const lookupArgs = z
  .object(LOOKUP_SCHOLAR_STATUS_INPUT)
  .refine((v) => (v.student_ref !== undefined) !== (v.student_name !== undefined), {
    message: 'provide exactly one of student_ref or student_name',
  });

export interface LookupResult {
  readonly [key: string]: unknown;
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

export async function handleLookupScholarStatus(
  rawArgs: unknown,
  extra: unknown,
  deps: ToolDeps,
): Promise<LookupResult> {
  const meta = requireRequestMeta(extra);
  const { identity } = meta;
  const toolStart = performance.now();

  const parsed = lookupArgs.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    // Invalid arguments are a refusal, not an empty success — the caller
    // must be able to distinguish and correct. Enrichment only: the
    // boundary writes the audit row (AD-42).
    meta.toolAudit = {
      tool: LOOKUP_SCHOLAR_STATUS_NAME,
      argumentsRedacted: { lookup_by: 'invalid' },
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

  const result = await withTenant(deps.appPool, identity.tenantId, async (client) => {
    // Resolve name → ref inside the tenant context; a name that exists
    // only in another tenant is simply not found here (T-35).
    let studentRef = args.student_ref;
    if (studentRef === undefined) {
      const entry = await findByStudentName(client, args.student_name!);
      if (entry === null) {
        const refusal: ScholarStatusResult = {
          kind: 'refusal',
          reason: 'student_not_found',
        };
        meta.toolAudit = {
          tool: LOOKUP_SCHOLAR_STATUS_NAME,
          argumentsRedacted: { lookup_by: 'student_name' },
          outcome: 'refusal:student_not_found',
          toolMs: Math.round(performance.now() - toolStart),
        };
        return refusal;
      }
      studentRef = entry.student_ref;
    }

    const status = await getScholarStatus(client, {
      studentRef,
      caller: 'staff',
      actor: identity.sub,
      freshnessMinutes: deps.rosterFreshnessMinutes,
    });

    // T-40 — every call audited, success included; the boundary writes
    // the row from this enrichment (AD-42). Recorded arguments carry no
    // student identifiers: which lookup mode was used, not the value.
    meta.toolAudit = {
      tool: LOOKUP_SCHOLAR_STATUS_NAME,
      argumentsRedacted: {
        lookup_by: args.student_ref !== undefined ? 'student_ref' : 'student_name',
      },
      outcome:
        status.kind === 'refusal' ? `refusal:${status.reason}` : 'success',
      toolMs: Math.round(performance.now() - toolStart),
    };
    return status;
  });

  if (result.kind === 'refusal') {
    return {
      content: [{ type: 'text', text: REFUSAL_COPY[result.reason] ?? result.reason }],
      isError: true,
      structuredContent: { kind: 'refusal', reason: result.reason },
    };
  }

  const scholar = project(result, LOOKUP_SCHOLAR_STATUS_NAME, identity.role);
  const toolMs = Math.round(performance.now() - toolStart);
  const totalMs = Math.round(performance.now() - meta.requestStartedAt);

  deps.logger.info({
    msg: 'tool_call',
    tenant_id: identity.tenantId,
    request_id: meta.requestId,
    tool: LOOKUP_SCHOLAR_STATUS_NAME,
    outcome: 'success',
    tool_ms: toolMs,
    total_ms: totalMs,
  });

  const summary =
    result.hold_type !== null
      ? `${result.student_name} — ${result.hold_type}, release ${result.release_time ?? 'TBD'}, ${result.hold_location ?? 'location TBD'}.`
      : `${result.student_name} — no hold on today\u2019s roster.`;

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { kind: 'success', scholar },
  };
}
