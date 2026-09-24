/**
 * `decide_pickup_request` — approve, flag, or deny with a note (PL-208).
 *
 * The in-app decision path: the caller's verified-token subject is the
 * audit subject (`decided_by`) — the app actor arrives AS the subject,
 * unlike a Slack actor which must resolve through `staff_identities`
 * first (AD-29's distinction). The note is the approver's reasoning,
 * recorded on the decision event; like every decision-adjacent free
 * text it is clearance `never` — never in a response.
 *
 * `flag` is the "needs a human to look at context" action; `flag` and
 * `deny` deliberately live here rather than on the Slack fast path
 * (PL-207), which is approve-only.
 *
 * Description is customer-facing copy (AD-16), deliberately disjoint
 * from the other tools.
 */

import { z } from 'zod';
import { withTenant } from '../../db/tenant-context.js';
import { transitionPickupRequest } from '../../repositories/pickup-requests.js';
import { project } from '../../disclosure/policy.js';
import { REFUSAL_COPY, requireRequestMeta, type ToolDeps } from './common.js';
import type { LookupResult } from './lookup-scholar-status.js';

export const DECIDE_PICKUP_REQUEST_NAME = 'decide_pickup_request';

export const DECIDE_PICKUP_REQUEST_DESCRIPTION = [
  'Record a decision on an early-pickup request — approve it, flag it for a closer look, or deny',
  'it — with an optional note explaining the decision. Use this tool when an approver has reviewed',
  'a pending request and made a call. Do not use it to create requests, to list what is pending,',
  'or to look up a scholar\u2019s dismissal status.',
].join(' ');

export const DECIDE_PICKUP_REQUEST_INPUT = {
  request_id: z.string().uuid(),
  decision: z.enum(['approve', 'flag', 'deny']),
  note: z.string().min(1).max(500).optional(),
} as const;

const decideArgs = z.object(DECIDE_PICKUP_REQUEST_INPUT);

export async function handleDecidePickupRequest(
  rawArgs: unknown,
  extra: unknown,
  deps: ToolDeps,
): Promise<LookupResult> {
  const meta = requireRequestMeta(extra);
  const { identity } = meta;
  const toolStart = performance.now();

  const parsed = decideArgs.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    meta.toolAudit = {
      tool: DECIDE_PICKUP_REQUEST_NAME,
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

  const result = await withTenant(deps.appPool, identity.tenantId, async (client) =>
    transitionPickupRequest(client, {
      requestId: args.request_id,
      action: args.decision,
      actor: identity.sub,
      channel: 'app',
      ...(args.note !== undefined ? { note: args.note } : {}),
    }),
  );

  const toolMs = Math.round(performance.now() - toolStart);

  // Idempotent replays are successes — the Slack at-least-once case and
  // a double-click in the app both return the current state (T-54).
  meta.toolAudit = {
    tool: DECIDE_PICKUP_REQUEST_NAME,
    argumentsRedacted: { decision: args.decision },
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
    tool: DECIDE_PICKUP_REQUEST_NAME,
    outcome: result.ok
      ? result.idempotent
        ? 'success:idempotent'
        : 'success'
      : `refusal:${result.code}`,
    tool_ms: toolMs,
  });

  if (!result.ok) {
    // `not_found` covers an id in another tenant and a nonexistent one,
    // indistinguishably (T-66's discipline).
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

  // The shaped row: PK as request_id, the decision outcome, and when
  // it was decided (PL-210's contract; `id` and internal fields stay
  // server-side).
  const shaped = {
    request_id: result.request.id,
    state: result.request.state,
    decided_at: result.request.decided_at,
  };
  const projected = project(shaped, DECIDE_PICKUP_REQUEST_NAME, identity.role);

  const summary = `Decision recorded: request is now ${result.request.state}.`;
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { kind: 'success', decision: projected },
  };
}
