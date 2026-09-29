/**
 * Slack client surface (PL-206) — the outbound notification channel.
 *
 * One named approver gets a DM (AD-27); a low-detail thread in the
 * leadership channel keeps visibility without becoming the request.
 *
 * The interface is deliberately minimal: post a message, get a typed
 * result. Real delivery goes through the Slack Web API
 * (`chat.postMessage`, no SDK — a plain HTTPS POST, same
 * no-new-infrastructure posture as the rest of the stack); tests use
 * the capture client, which records every message it was asked to send.
 *
 * Payload discipline (AD-28, P3): messages carry scholar name, pickup
 * time, and a link — **no reason at all**, category included. The
 * payload builder in the notification service never receives the
 * request row, so `reason_detail` cannot reach a message even by
 * accident (T-68's structural half; the test is the behavioral half).
 */

export interface SlackMessage {
  /** A user id (DM) or channel id/name. */
  readonly channel: string;
  readonly text: string;
  /** Reply inside a thread instead of posting top-level. */
  readonly threadTs?: string;
  /**
   * Block Kit blocks (PL-252). The notification builder owns the shape;
   * the client serializes it verbatim. The same payload discipline as
   * `text` applies — the allowlist is scholar name, pickup time, link,
   * request id (the approve button's `value`).
   */
  readonly blocks?: readonly Record<string, unknown>[];
}

export type SlackPostResult = { ok: true; ts: string } | { ok: false; error: string };

export interface SlackClient {
  postMessage(message: SlackMessage): Promise<SlackPostResult>;
}
