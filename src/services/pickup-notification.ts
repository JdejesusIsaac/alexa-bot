import { type PoolClient } from 'pg';
import { findPickupRequestById } from '../repositories/pickup-requests.js';
import { findStudentById } from '../repositories/students.js';
import { findStaffIdentityById } from '../repositories/staff-identities.js';
import {
  type SlackClient,
  type SlackMessage,
  type SlackPostResult,
} from '../slack/slack-client.js';
import { type Logger } from '../logging/logger.js';

/**
 * Pickup notifications (PL-206) — the outbound Slack surface.
 *
 * One named approver gets a DM (AD-27); a low-detail thread in the
 * leadership visibility channel keeps the room informed without the
 * room becoming the request. Fifteen recipients is zero recipients.
 *
 * **Payload discipline (AD-28, the P3 decision):** messages carry the
 * scholar's name, the pickup time, and a link — **no reason at all**,
 * category included. This is enforced structurally: the payload
 * builder receives only the three fields it may carry and never the
 * request row, so `reason_detail` cannot reach a message even by
 * accident. T-68's sentinel pass is the behavioral half of the same
 * guarantee.
 *
 * Notifications are a side effect, never a gate: a failed send returns
 * a typed result and logs metadata only — request id, channel, outcome.
 * The request's state never depends on Slack's health, and no message
 * text, payload content, or error body ever reaches a log line.
 */

export interface PickupNotificationPayloads {
  /** The DM to the assigned approver. */
  readonly dm: string;
  /** The low-detail visibility thread post. */
  readonly thread: string;
}

/**
 * Build the notification texts from an explicit allowlist of fields.
 * Deliberately untyped against the request row: only name, time, and
 * link enter, so only name, time, and link can leave (T-68's
 * structural half).
 */
export function buildPickupNotificationPayloads(
  studentName: string,
  pickupAt: Date,
  link: string,
): PickupNotificationPayloads {
  const when = pickupAt.toISOString();
  return {
    dm: `Early pickup today at ${when} for ${studentName}. You are the assigned approver — review and decide: ${link}`,
    thread: `Early pickup request routed for ${studentName} at ${when}: ${link}`,
  };
}

export type NotificationResult =
  | { ok: true; dmTs: string; threadTs: string }
  | {
      ok: false;
      code: 'not_found' | 'no_assigned_approver' | 'student_not_found' | 'send_failed';
      detail?: string;
    };

export async function sendPickupNotifications(
  client: PoolClient,
  slack: SlackClient,
  params: {
    requestId: string;
    /** The leadership visibility channel (id or name). */
    visibilityChannel: string;
    /** Link the approver follows to review and decide. */
    link: string;
  },
  logger: Logger,
): Promise<NotificationResult> {
  const request = await findPickupRequestById(client, params.requestId);
  if (request === null) {
    logger.info({
      msg: 'notification_refused',
      request_id: params.requestId,
      outcome: 'not_found',
    });
    return { ok: false, code: 'not_found' };
  }

  if (request.assigned_approver_id === null) {
    logger.info({
      msg: 'notification_refused',
      request_id: params.requestId,
      tenant_id: request.tenant_id,
      outcome: 'no_assigned_approver',
    });
    return { ok: false, code: 'no_assigned_approver' };
  }

  const approver = await findStaffIdentityById(client, request.assigned_approver_id);
  if (approver === null) {
    // Structurally unreachable (the composite FK guarantees the
    // identity exists in this tenant) — refused loudly anyway rather
    // than guessed around. Rule 10.
    logger.warn({
      msg: 'notification_refused',
      request_id: params.requestId,
      tenant_id: request.tenant_id,
      outcome: 'no_assigned_approver',
    });
    return { ok: false, code: 'no_assigned_approver' };
  }

  const student = await findStudentById(client, request.student_id);
  if (student === null) {
    // Same: structurally unreachable (FK), refused loudly.
    logger.warn({
      msg: 'notification_refused',
      request_id: params.requestId,
      tenant_id: request.tenant_id,
      outcome: 'student_not_found',
    });
    return { ok: false, code: 'student_not_found' };
  }

  // The allowlist: name, time, link. The request row is never passed in.
  const payloads = buildPickupNotificationPayloads(
    student.student_name,
    request.pickup_at,
    params.link,
  );

  const dm = await postSafely(slack, {
    channel: approver.slack_user_id,
    text: payloads.dm,
  });
  if (!dm.ok) {
    logger.warn({
      msg: 'notification_send_failed',
      request_id: params.requestId,
      tenant_id: request.tenant_id,
      channel: 'dm',
      error: dm.error,
    });
    return { ok: false, code: 'send_failed', detail: dm.error };
  }

  const thread = await postSafely(slack, {
    channel: params.visibilityChannel,
    text: payloads.thread,
  });
  if (!thread.ok) {
    logger.warn({
      msg: 'notification_send_failed',
      request_id: params.requestId,
      tenant_id: request.tenant_id,
      channel: 'visibility_thread',
      error: thread.error,
    });
    return { ok: false, code: 'send_failed', detail: thread.error };
  }

  logger.info({
    msg: 'notification_sent',
    request_id: params.requestId,
    tenant_id: request.tenant_id,
    dm: true,
    thread: true,
  });
  return { ok: true, dmTs: dm.ts, threadTs: thread.ts };
}

/**
 * Contain a client that throws instead of returning its typed result.
 * The exception's message is deliberately NOT propagated or logged —
 * it is the one string in this path we do not control, and an
 * exception message that embeds payload content must not become the
 * leak (T-68's forced-exception leg).
 */
async function postSafely(
  slack: SlackClient,
  message: SlackMessage,
): Promise<SlackPostResult> {
  try {
    return await slack.postMessage(message);
  } catch {
    return { ok: false, error: 'client_exception' };
  }
}
