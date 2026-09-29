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
  /**
   * Block Kit blocks for the approver DM (PL-252): the message text as a
   * section, then an `actions` block whose button carries
   * `action_id: 'approve'` and `value: <request_id>` — the exact shape
   * the interaction endpoint parses. `request_id` joins the allowlist
   * because the button needs it; nothing else new enters.
   */
  readonly dmBlocks: readonly Record<string, unknown>[];
}

function approveBlocks(
  sectionText: string,
  requestId: string,
): readonly Record<string, unknown>[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: sectionText } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'approve',
          value: requestId,
        },
      ],
    },
  ];
}

/**
 * Build the notification texts from an explicit allowlist of fields.
 * Deliberately untyped against the request row: only name, time, link,
 * and the request id enter, so only they can leave (T-68's structural
 * half — the sentinel scan now covers serialized blocks too, T-76).
 */
export function buildPickupNotificationPayloads(
  studentName: string,
  pickupAt: Date,
  link: string,
  requestId: string,
): PickupNotificationPayloads {
  const when = pickupAt.toISOString();
  const dm = `Early pickup today at ${when} for ${studentName}. You are the assigned approver — review and decide: ${link}`;
  return {
    dm,
    thread: `Early pickup request routed for ${studentName} at ${when}: ${link}`,
    dmBlocks: approveBlocks(dm, requestId),
  };
}

/** The escalation DM — same allowlist, different verb (PL-252). */
export function buildEscalatedDm(
  studentName: string,
  pickupAt: Date,
  link: string,
  requestId: string,
): { dm: string; dmBlocks: readonly Record<string, unknown>[] } {
  const dm = `Early pickup today at ${pickupAt.toISOString()} for ${studentName} — escalated to you as the approver. Review and decide: ${link}`;
  return { dm, dmBlocks: approveBlocks(dm, requestId) };
}

/** The terminal handoff post — visibility thread only (PL-252). */
export function buildTerminalThread(
  studentName: string,
  pickupAt: Date,
  link: string,
  outcome: 'expired' | 'stalled',
): string {
  const when = pickupAt.toISOString();
  const why =
    outcome === 'expired'
      ? 'expired without a recorded decision'
      : 'could not be decided — escalation attempts exhausted';
  return `Early pickup request for ${studentName} at ${when} ${why}. Handle the release in person: ${link}`;
}

export type NotificationResult =
  | { ok: true; dmTs?: string; threadTs?: string }
  | {
      ok: false;
      code: 'not_found' | 'no_assigned_approver' | 'student_not_found' | 'send_failed';
      detail?: string;
    };

/**
 * What the notification is for (PL-252):
 *  - `routed`    — DM the assignee (with the approve action) + thread post
 *  - `escalated` — DM the newly-assigned approver only
 *  - `expired`/`stalled` — terminal handoff: visibility thread only;
 *    there is no DM target on a terminal state (and a DM to the last
 *    assignee would read like there is still a decision to take).
 */
export type NotificationMode = 'routed' | 'escalated' | 'expired' | 'stalled';

export async function sendPickupNotifications(
  client: PoolClient,
  slack: SlackClient,
  params: {
    requestId: string;
    /** The leadership visibility channel (id or name). */
    visibilityChannel: string;
    /** Link the approver follows to review and decide. */
    link: string;
    mode?: NotificationMode;
  },
  logger: Logger,
): Promise<NotificationResult> {
  const mode = params.mode ?? 'routed';
  const wantsDm = mode === 'routed' || mode === 'escalated';

  const request = await findPickupRequestById(client, params.requestId);
  if (request === null) {
    logger.info({
      msg: 'notification_refused',
      request_id: params.requestId,
      outcome: 'not_found',
    });
    return { ok: false, code: 'not_found' };
  }

  const student = await findStudentById(client, request.student_id);
  if (student === null) {
    // Structurally unreachable (FK), refused loudly.
    logger.warn({
      msg: 'notification_refused',
      request_id: params.requestId,
      tenant_id: request.tenant_id,
      outcome: 'student_not_found',
    });
    return { ok: false, code: 'student_not_found' };
  }

  let dmTs: string | undefined;
  if (wantsDm) {
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

    // The allowlist: name, time, link, request id. The request row is
    // never passed to a builder.
    const dmPayload =
      mode === 'escalated'
        ? buildEscalatedDm(student.student_name, request.pickup_at, params.link, request.id)
        : buildPickupNotificationPayloads(
            student.student_name,
            request.pickup_at,
            params.link,
            request.id,
          );

    const dm = await postSafely(slack, {
      channel: approver.slack_user_id,
      text: dmPayload.dm,
      blocks: dmPayload.dmBlocks,
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
    dmTs = dm.ts;
  }

  let threadTs: string | undefined;
  if (mode !== 'escalated') {
    const threadText =
      mode === 'routed'
        ? buildPickupNotificationPayloads(
            student.student_name,
            request.pickup_at,
            params.link,
            request.id,
          ).thread
        : buildTerminalThread(
            student.student_name,
            request.pickup_at,
            params.link,
            mode,
          );

    const thread = await postSafely(slack, {
      channel: params.visibilityChannel,
      text: threadText,
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
    threadTs = thread.ts;
  }

  logger.info({
    msg: 'notification_sent',
    request_id: params.requestId,
    tenant_id: request.tenant_id,
    mode,
    dm: dmTs !== undefined,
    thread: threadTs !== undefined,
  });
  return {
    ok: true,
    ...(dmTs !== undefined ? { dmTs } : {}),
    ...(threadTs !== undefined ? { threadTs } : {}),
  };
}

/**
 * The injectable notification surface (PL-252). Tool deps and the
 * worker hold this — an optional collaborator, so a deployment with no
 * Slack configuration still routes and decides; notification is a side
 * effect, never a gate.
 */
export interface PickupNotifier {
  /** DM the currently-assigned approver; `routed` also posts the thread. */
  notifyAssigned(
    client: PoolClient,
    requestId: string,
    options?: { escalated?: boolean },
  ): Promise<NotificationResult>;
  /** Terminal handoff — visibility thread only. */
  notifyTerminal(
    client: PoolClient,
    requestId: string,
    outcome: 'expired' | 'stalled',
  ): Promise<NotificationResult>;
}

export function createPickupNotifier(params: {
  slack: SlackClient;
  /** The leadership visibility channel (id or name). */
  visibilityChannel: string;
  /** Link the approver follows to review and decide. */
  link: string;
  logger: Logger;
}): PickupNotifier {
  return {
    notifyAssigned: (client, requestId, options) =>
      sendPickupNotifications(
        client,
        params.slack,
        {
          requestId,
          visibilityChannel: params.visibilityChannel,
          link: params.link,
          mode: options?.escalated === true ? 'escalated' : 'routed',
        },
        params.logger,
      ),
    notifyTerminal: (client, requestId, outcome) =>
      sendPickupNotifications(
        client,
        params.slack,
        {
          requestId,
          visibilityChannel: params.visibilityChannel,
          link: params.link,
          mode: outcome,
        },
        params.logger,
      ),
  };
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
