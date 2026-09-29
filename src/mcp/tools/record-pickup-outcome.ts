/**
 * `record_pickup_outcome` — record the physical handoff (PL-252).
 *
 * `release` (approved → released) and `complete` (released → completed)
 * are NOT decisions — they are the front office recording that the
 * approved pickup actually happened. They live on their own tool
 * rather than in `decide_pickup_request`'s enum because releasing a
 * scholar is not a decision, and the descriptions must stay disjoint
 * (AD-16).
 *
 * Authorization: the caller resolves through `staff_identities` (an
 * unresolved subject refuses — same posture as the decision path), but
 * need not be the assignee: the front office releases, not the
 * approver. The state machine remains the chokepoint — `release` is
 * legal only from `approved`, `complete` only from `released`, and
 * terminal states (`expired`, `stalled`, `denied`) refuse both.
 *
 * `not_found` covers an id in another tenant and a nonexistent one,
 * indistinguishably (T-66's discipline). Description is
 * customer-facing copy (AD-16), deliberately disjoint from the other
 * tools.
 */

import { z } from 'zod';
import { withTenant } from '../../db/tenant-context.js';
import { transitionPickupRequest } from '../../repositories/pickup-requests.js';
import { findStaffIdentityBySubject } from '../../repositories/staff-identities.js';
import { project } from '../../disclosure/policy.js';
import { REFUSAL_COPY, requireRequestMeta, type ToolDeps } from './common.js';
import type { LookupResult } from './lookup-scholar-status.js';

export const RECORD_PICKUP_OUTCOME_NAME = 'record_pickup_outcome';

export const RECORD_PICKUP_OUTCOME_DESCRIPTION = [
  'Record the outcome of an approved early pickup — that the scholar was released to their',
  'pickup person, or that a released pickup was completed. Use this tool when the front office',
  'hands the scholar over. Do not use it to approve or deny a request, to create one, or to',
  'look up a scholar\u2019s dismissal status.',
].join(' ');

export const RECORD_PICKUP_OUTCOME_INPUT = {
  request_id: z.string().uuid(),
  outcome: z.enum(['release', 'complete']),
} as const;

const outcomeArgs = z.object(RECORD_PICKUP_OUTCOME_INPUT);

export async function handleRecordPickupOutcome(
  rawArgs: unknown,
  extra: unknown,
  deps: ToolDeps,
): Promise<LookupResult> {
  const meta = requireRequestMeta(extra);
  const { identity } = meta;
  const toolStart = performance.now();

  const parsed = outcomeArgs.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    meta.toolAudit = {
      tool: RECORD_PICKUP_OUTCOME_NAME,
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

  const result = await withTenant(deps.appPool, identity.tenantId, async (client) => {
    // The token subject resolves through staff_identities before it may
    // act — the same posture the decision path took in PL-251. An
    // unresolved caller refuses identically for existent and
    // nonexistent ids: the refusal reveals nothing about the request.
    const actor = await findStaffIdentityBySubject(client, identity.sub);
    if (actor === null) {
      return { ok: false as const, code: 'unmapped_actor' as const, from: null, action: args.outcome };
    }
    return transitionPickupRequest(client, {
      requestId: args.request_id,
      action: args.outcome,
      actor: actor.subject,
      channel: 'app',
    });
  });

  const toolMs = Math.round(performance.now() - toolStart);

  meta.toolAudit = {
    tool: RECORD_PICKUP_OUTCOME_NAME,
    argumentsRedacted: { outcome: args.outcome },
    outcome: result.ok
      ? result.idempotent
        ? 'success:idempotent'
        : 'success'
      : `refusal:${result.code}`,
    toolMs,
  };

  deps.logger.info({
    msg: 'tool_call',
    tenant_id: identity.tenantId,
    request_id: meta.requestId,
    tool: RECORD_PICKUP_OUTCOME_NAME,
    outcome: result.ok
      ? result.idempotent
        ? 'success:idempotent'
        : 'success'
      : `refusal:${result.code}`,
    tool_ms: toolMs,
  });

  if (!result.ok) {
    const copyKey =
      result.code === 'not_found'
        ? 'request_not_found'
        : result.code === 'illegal_transition'
          ? 'illegal_transition'
          : result.code;
    return {
      content: [{ type: 'text', text: REFUSAL_COPY[copyKey] ?? result.code }],
      isError: true,
      structuredContent: { kind: 'refusal', reason: result.code },
    };
  }

  const shaped = {
    request_id: result.request.id,
    state: result.request.state,
  };
  const projected = project(shaped, RECORD_PICKUP_OUTCOME_NAME, identity.role);

  const summary = `Outcome recorded: request is now ${result.request.state}.`;
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { kind: 'success', outcome: projected },
  };
}
