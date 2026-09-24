/**
 * `list_pending_approvals` — an approver's queue for today (PL-208).
 *
 * The requests routed to THE CALLER, still awaiting a decision, for
 * today's service date — AD-27's one named approver means the queue is
 * theirs alone. The caller is resolved through `staff_identities` by
 * audit subject: a caller with no identity in this tenant simply has
 * an empty queue (they are not an approver here), which is honest, not
 * an error.
 *
 * No arguments — the approver and the date are derived server-side
 * (today), never caller-supplied. Description is customer-facing copy
 * (AD-16), deliberately disjoint from the other tools.
 */

import { withTenant } from '../../db/tenant-context.js';
import { listPendingApprovalsForApprover } from '../../repositories/pickup-requests.js';
import { findStaffIdentityBySubject } from '../../repositories/staff-identities.js';
import { project } from '../../disclosure/policy.js';
import { todayServiceDate } from '../../util/service-date.js';
import { requireRequestMeta, type ToolDeps } from './common.js';
import type { LookupResult } from './lookup-scholar-status.js';

export const LIST_PENDING_APPROVALS_NAME = 'list_pending_approvals';

export const LIST_PENDING_APPROVALS_DESCRIPTION = [
  'List the early-pickup requests waiting for YOUR decision today — each request routed to you as',
  'the approver, with the scholar, the pickup time, the reason category, and how far it has climbed',
  'the escalation ladder. Use this tool when an approver asks what is pending for them right now.',
  'Do not use it to create a request, to look up a scholar\u2019s dismissal status, or to decide.',
].join(' ');

export async function handleListPendingApprovals(
  _rawArgs: unknown,
  extra: unknown,
  deps: ToolDeps,
): Promise<LookupResult> {
  const meta = requireRequestMeta(extra);
  const { identity } = meta;
  const toolStart = performance.now();

  const result = await withTenant(deps.appPool, identity.tenantId, async (client) => {
    const approver = await findStaffIdentityBySubject(client, identity.sub);
    if (approver === null) {
      // Not an approver in this tenant — an empty queue, not an error.
      return { kind: 'empty' as const };
    }
    const pending = await listPendingApprovalsForApprover(
      client,
      approver.id,
      todayServiceDate(),
    );
    return { kind: 'queue' as const, pending };
  });

  const toolMs = Math.round(performance.now() - toolStart);
  const outcome =
    result.kind === 'empty' ? 'success:empty_queue' : `success:${result.pending.length}`;
  meta.toolAudit = {
    tool: LIST_PENDING_APPROVALS_NAME,
    argumentsRedacted: {},
    outcome,
    toolMs,
  };

  deps.logger.info({
    msg: 'tool_call',
    tenant_id: identity.tenantId,
    request_id: meta.requestId,
    tool: LIST_PENDING_APPROVALS_NAME,
    outcome,
    tool_ms: toolMs,
  });

  if (result.kind === 'empty') {
    return {
      content: [
        {
          type: 'text',
          text: 'No pickup requests are waiting for your decision today.',
        },
      ],
      structuredContent: { kind: 'success', approvals: [], total: 0 },
    };
  }

  // Each queue row presents the PK as request_id (PL-210's contract —
  // `id` is never-cleared) and projects through the declared minimum
  // set: nothing merely cleared rides along (T-70).
  const approvals = result.pending.map((row) =>
    project(
      {
        request_id: row.id,
        student_name: row.student_name,
        pickup_at: row.pickup_at,
        reason_category: row.reason_category,
        escalation_level: row.escalation_level,
      },
      LIST_PENDING_APPROVALS_NAME,
      identity.role,
    ),
  );

  const summary =
    result.pending.length === 0
      ? 'No pickup requests are waiting for your decision today.'
      : `${result.pending.length} pickup request(s) waiting for your decision.`;

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { kind: 'success', approvals, total: result.pending.length },
  };
}
