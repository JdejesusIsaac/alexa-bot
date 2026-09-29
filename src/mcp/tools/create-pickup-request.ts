/**
 * `create_pickup_request` — coordinator-entered intake (PL-208).
 *
 * The morning call becomes a structured request: scholar, pickup time,
 * reason category (and detail, stored under the P3 clearance rules).
 * The request routes immediately to the one named approver the
 * routing resolver returns (PL-203, AD-27), with the clock set to the
 * pickup time — decide before the parent arrives. Until the escalation
 * worker exists (PL-204), the clock is data; the worker owns ladder
 * semantics.
 *
 * The notification (PL-206) fires here on successful route — DM +
 * visibility thread — through `deps.pickupNotifier` when Slack is
 * configured (PL-252). A send failure never fails the tool call; no
 * configured notifier means the request still routes, logged.
 *
 * The level-0 clock (PL-253): with a written ladder the first deadline
 * is `min(pickup_at, now + initial_minutes)` — escalation starts before
 * the parent is due. Without one the request still routes with
 * `escalate_at = pickup_at` and an `initial_clock_unconfigured` warning
 * — an honest posture: without a written ladder no worker can run, so
 * the clock is inert data either way.
 *
 * Args carry no tenant (Rule 7 — derived from the token) and the
 * response carries exactly the declared minimum set on success and
 * refusal (T-70). Description is customer-facing copy (AD-16),
 * deliberately disjoint from the other tools.
 */

import { z } from 'zod';
import { withTenant } from '../../db/tenant-context.js';
import { findStudentByRef } from '../../repositories/students.js';
import {
  createPickupRequest,
  transitionPickupRequest,
  REASON_CATEGORIES,
  type ReasonCategory,
} from '../../repositories/pickup-requests.js';
import { resolveApproverForStudent } from '../../repositories/approver-routing.js';
import { project } from '../../disclosure/policy.js';
import { todayServiceDate } from '../../util/service-date.js';
import { REFUSAL_COPY, requireRequestMeta, type ToolDeps } from './common.js';
import type { LookupResult } from './lookup-scholar-status.js';

export const CREATE_PICKUP_REQUEST_NAME = 'create_pickup_request';

export const CREATE_PICKUP_REQUEST_DESCRIPTION = [
  'Record a new early-pickup request for one scholar — the student ID, the pickup time, and the',
  'reason category — and route it to the approver responsible for that scholar. Use this tool when',
  'a parent calls the school in the morning to schedule a pickup later today. Do not use it to',
  'look up an existing request, to review a queue of requests, or to record a decision.',
].join(' ');

export const CREATE_PICKUP_REQUEST_INPUT = {
  student_ref: z.string().min(1),
  pickup_at: z.string().datetime(),
  reason_category: z.enum(REASON_CATEGORIES),
  reason_detail: z.string().min(1).optional(),
} as const;

const createArgs = z.object(CREATE_PICKUP_REQUEST_INPUT);

export async function handleCreatePickupRequest(
  rawArgs: unknown,
  extra: unknown,
  deps: ToolDeps,
): Promise<LookupResult> {
  const meta = requireRequestMeta(extra);
  const { identity } = meta;
  const toolStart = performance.now();

  const parsed = createArgs.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    meta.toolAudit = {
      tool: CREATE_PICKUP_REQUEST_NAME,
      argumentsRedacted: { valid: false },
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
  const pickupAt = new Date(args.pickup_at);

  const result = await withTenant(deps.appPool, identity.tenantId, async (client) => {
    // 1. The scholar must be a known student in this tenant — intake
    //    never invents a registry row.
    const student = await findStudentByRef(client, args.student_ref);
    if (student === null) {
      return { kind: 'refusal' as const, reason: 'student_not_found' };
    }

    // 2. Resolve the one named approver BEFORE creating anything — a
    //    request that cannot route is not created (no orphan drafts).
    const resolution = await resolveApproverForStudent(client, student.id);
    if (!resolution.ok) {
      // routing_not_total is an operational config failure; degrade to
      // a human (Rule 10), never to a guess.
      return { kind: 'refusal' as const, reason: 'routing_not_total' };
    }

    // 3. Create the draft, then route it: assigned to the named
    //    approver, clock set to the earlier of the pickup time and
    //    `now + initial_minutes` when a written ladder is configured
    //    (PL-253) — the first rung fires while there is still time to
    //    decide, not when the parent is already at security.
    const request = await createPickupRequest(client, {
      serviceDate: todayServiceDate(),
      studentId: student.id,
      pickupAt,
      reasonCategory: args.reason_category as ReasonCategory,
      reasonDetail: args.reason_detail ?? null,
      intakeChannel: 'coordinator',
    });

    const initialMinutes =
      deps.escalationLadders?.[identity.tenantId]?.initialMinutes;
    const escalateAt =
      initialMinutes !== undefined
        ? new Date(
            Math.min(pickupAt.getTime(), Date.now() + initialMinutes * 60_000),
          )
        : pickupAt;

    const routed = await transitionPickupRequest(client, {
      requestId: request.id,
      action: 'route',
      actor: identity.sub,
      escalateAt,
      assignedApproverId: resolution.resolution.approverId,
    });
    if (!routed.ok) {
      return { kind: 'refusal' as const, reason: 'routing_not_total' };
    }

    return {
      kind: 'success' as const,
      request: routed.request,
      studentName: student.student_name,
    };
  });

  const toolMs = Math.round(performance.now() - toolStart);
  meta.toolAudit = {
    tool: CREATE_PICKUP_REQUEST_NAME,
    argumentsRedacted: { reason_category: args.reason_category },
    outcome: result.kind === 'refusal' ? `refusal:${result.reason}` : 'success',
    toolMs,
  };

  if (result.kind === 'refusal') {
    deps.logger.info({
      msg: 'tool_call',
      tenant_id: identity.tenantId,
      request_id: meta.requestId,
      tool: CREATE_PICKUP_REQUEST_NAME,
      outcome: `refusal:${result.reason}`,
      tool_ms: toolMs,
    });
    return {
      content: [{ type: 'text', text: REFUSAL_COPY[result.reason] ?? result.reason }],
      isError: true,
      structuredContent: { kind: 'refusal', reason: result.reason },
    };
  }

  // The notification is a side effect, never a gate (PL-252): it runs
  // after the route committed, a failed or thrown send is a log line,
  // and the tool call's outcome is unaffected.
  if (deps.pickupNotifier !== undefined) {
    try {
      const notifyResult = await withTenant(deps.appPool, identity.tenantId, (client) =>
        deps.pickupNotifier!.notifyAssigned(client, result.request.id),
      );
      if (!notifyResult.ok) {
        deps.logger.warn({
          msg: 'pickup_notification_failed',
          tenant_id: identity.tenantId,
          request_id: meta.requestId,
          code: notifyResult.code,
        });
      }
    } catch {
      // The exception's message is not ours to log — it can carry the
      // one string the payload discipline exists to keep out of logs.
      deps.logger.warn({
        msg: 'pickup_notification_failed',
        tenant_id: identity.tenantId,
        request_id: meta.requestId,
        code: 'notifier_exception',
      });
    }
  }

  if (deps.escalationLadders?.[identity.tenantId] === undefined) {
    deps.logger.warn({
      msg: 'initial_clock_unconfigured',
      tenant_id: identity.tenantId,
      request_id: meta.requestId,
      detail: 'no escalation ladder configured — level-0 clock is the pickup time',
    });
  }

  deps.logger.info({
    msg: 'tool_call',
    tenant_id: identity.tenantId,
    request_id: meta.requestId,
    tool: CREATE_PICKUP_REQUEST_NAME,
    outcome: 'success',
    tool_ms: toolMs,
  });

  // The shaped row presents the PK as request_id — `id` itself is
  // never-cleared (PL-210's contract for these tools).
  const shaped = { request_id: result.request.id, state: result.request.state };
  const projected = project(shaped, CREATE_PICKUP_REQUEST_NAME, identity.role);

  const summary = `Early pickup request created and routed for ${result.studentName} at ${result.request.pickup_at.toISOString()}.`;
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { kind: 'success', request: projected },
  };
}
