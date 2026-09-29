/**
 * Shared context for MCP tool handlers (PL-107…PL-109).
 *
 * Identity is resolved from the verified access token on EVERY request and
 * rides on `extra.authInfo.extra` — never on the session (AD-18). A tool
 * handler that cannot see an identity is a wiring bug; it refuses closed.
 *
 * Recorded arguments are tenant-safe by construction: student identifiers
 * (refs, names) are never placed in audit rows or logs (T-40) — we record
 * WHICH argument was used, not its value.
 */

import { type Pool } from 'pg';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { type AuthedIdentity } from '../../auth/identity.js';
import { type Logger } from '../../logging/logger.js';
import { type PickupNotifier } from '../../services/pickup-notification.js';

/**
 * What a handler leaves behind for the boundary's audit row (AD-42).
 * The HTTP layer writes exactly one `mcp_audit` row per `tools/call`
 * request — including calls the SDK rejects before dispatch — and the
 * handler enriches it through this slot. Append-only table, so the
 * enrichment is staged here and folded in when the boundary writes.
 */
export interface ToolCallAudit {
  readonly tool: string;
  /** Tenant-safe by construction — which argument was used, never values. */
  readonly argumentsRedacted: Record<string, unknown>;
  readonly outcome: string;
  readonly toolMs: number;
}

export interface RequestMeta {
  /** Verified caller identity — from this request's token, not the session. */
  readonly identity: AuthedIdentity;
  readonly requestId: string;
  /** Epoch ms when the HTTP request was received (for total latency). */
  readonly requestStartedAt: number;
  /** Token verification duration in ms (for per-stage tracing, T-41). */
  readonly authMs: number;
  /**
   * Audit enrichment written by the handler, read by the boundary after
   * dispatch (AD-42). Mutable by design — it is the per-request slot,
   * not session state. Absent after dispatch means the call was rejected
   * before reaching a handler.
   */
  toolAudit?: ToolCallAudit;
}

export interface ToolDeps {
  readonly appPool: Pool;
  readonly rosterFreshnessMinutes: number;
  readonly logger: Logger;
  /**
   * The outbound Slack surface (PL-252). Optional: absent Slack config,
   * notifications are skipped with a log line and every transition is
   * unaffected — the system works without the channel.
   */
  readonly pickupNotifier?: PickupNotifier;
  /**
   * Per-tenant level-0 clocks (PL-253/254): keyed by tenant id, loaded
   * from `ESCALATION_LADDER_DIR` — the same written ladders the worker
   * climbs, so a tenant's initial deadline is ITS policy. A tenant with
   * no entry falls back to `escalate_at = pickup_at` with an
   * `initial_clock_unconfigured` warning.
   */
  readonly escalationLadders?: Readonly<
    Record<string, { readonly initialMinutes: number }>
  >;
}

/**
 * Extract the per-request context a tool handler needs. Throws a typed
 * error when absent — the auth gate is upstream, so absence is a bug,
 * and the correct behavior is a loud refusal, not a default.
 */
export function requireRequestMeta(extra: unknown): RequestMeta {
  const e = extra as RequestHandlerExtra<never, never> | undefined;
  const meta = e?.authInfo?.extra as Partial<RequestMeta> | undefined;
  if (
    meta === undefined ||
    meta.identity === undefined ||
    meta.requestId === undefined ||
    meta.requestStartedAt === undefined ||
    meta.authMs === undefined
  ) {
    throw new Error('missing request auth context — auth gate is upstream of every tool');
  }
  return meta as RequestMeta;
}

/**
 * Customer-facing refusal copy (AD-16, AD-7). Degrade to a human, never
 * to a guess — and never to a phrasing that confirms what it refuses to
 * reveal. These strings reach the model, the customer, and the voice
 * layer; no jargon, no campus names, no student-data examples.
 */
export const REFUSAL_COPY: Readonly<Record<string, string>> = {
  roster_stale:
    'The roster is not current enough to answer reliably. Please try again shortly or check with the front office.',
  sync_failed:
    'The most recent roster refresh did not complete. Please check with the front office for the latest information.',
  student_not_found:
    'No scholar matching that reference is on today\u2019s roster. Double-check the spelling or ID, or check with the front office.',
  row_quarantined:
    'That record could not be validated and is pending staff review. Please check with the front office.',
  insufficient_role:
    'That information requires an administrative role. Please contact an administrator.',
  invalid_arguments:
    'That request is missing a required detail. Provide either a scholar ID or a scholar name.',
  routing_not_total:
    'This pickup request could not be routed to an approver. Please check with the front office to handle it in person.',
  request_not_found:
    'No pickup request matches that ID. Double-check the ID, or check the pending list for today\u2019s requests.',
  illegal_transition:
    'That request is not in a state where this action is possible — it may already have been decided. Check the pending list or the front office.',
  unmapped_actor:
    'Your account is not registered as staff for this campus. Please check with the front office.',
  not_assigned_approver:
    'That request is assigned to a different approver. Check your pending list for the requests routed to you.',
  self_approval:
    'A request you submitted cannot be decided by you — it will escalate to another approver. Check with the front office if it is urgent.',
};
