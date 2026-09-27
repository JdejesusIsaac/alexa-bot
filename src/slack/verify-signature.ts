import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Slack request-signature verification (PL-207).
 *
 * The real Slack signing scheme — a synthetic secret in development,
 * but the verification path is the production one: basestring
 * `v0:{timestamp}:{body}`, HMAC-SHA256 with the shared signing secret,
 * hex, compared timing-safe against the `X-Slack-Signature` header,
 * with a freshness window on `X-Slack-Request-Timestamp`.
 *
 * **The auth equivalent of Rule 8:** this module never logs — and no
 * caller may log — the secret, the computed signature, or the
 * basestring. The thing being protected must not leak through the
 * diagnostics added while protecting it. Failure results carry codes
 * only; even at debug level, the signature material stays out of every
 * output path. Tests assert this against the captured log lines.
 *
 * This is the sprint's second authentication scheme on a write path
 * (PL-207) and gets the scrutiny Sprint 2 gave OAuth: distinct codes
 * for distinct failures, timing-safe comparison, fail closed on
 * anything malformed.
 */

export type SlackSignatureResult =
  { ok: true } | { ok: false; code: 'slack_unsigned' | 'slack_stale' };

/** Slack's documented recommendation: reject timestamps older than 5 minutes. */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

const SIGNATURE_PATTERN = /^v0=[0-9a-f]{64}$/;

export function verifySlackSignature(params: {
  signingSecret: string;
  /** X-Slack-Request-Timestamp. */
  timestamp: string | undefined;
  /** X-Slack-Signature. */
  signature: string | undefined;
  rawBody: string;
  /** Injectable for tests. */
  now?: number;
  replayWindowSeconds?: number;
}): SlackSignatureResult {
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const windowSeconds = params.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;

  // 1. Freshness first: a timestamp outside the window is stale
  //    regardless of signature validity — this is the replay window.
  if (params.timestamp === undefined || !/^\d+$/.test(params.timestamp)) {
    return { ok: false, code: 'slack_unsigned' };
  }
  const timestamp = parseInt(params.timestamp, 10);
  if (Math.abs(now - timestamp) > windowSeconds) {
    return { ok: false, code: 'slack_stale' };
  }

  // 2. Signature shape: v0= plus 64 lowercase hex chars. A malformed
  //    header is unsigned — no signature material is echoed, ever.
  if (params.signature === undefined || !SIGNATURE_PATTERN.test(params.signature)) {
    return { ok: false, code: 'slack_unsigned' };
  }

  // 3. The real computation: HMAC-SHA256 over v0:{ts}:{body}, compared
  //    timing-safe. Length mismatch short-circuits (timingSafeEqual
  //    requires equal lengths) without leaking which byte differed.
  const computed = createHmac('sha256', params.signingSecret)
    .update(`v0:${params.timestamp}:${params.rawBody}`)
    .digest('hex');
  const expected = params.signature.slice(3); // strip the "v0=" prefix
  if (expected.length !== computed.length) {
    return { ok: false, code: 'slack_unsigned' };
  }
  const match = timingSafeEqual(
    Buffer.from(computed, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );
  if (!match) {
    return { ok: false, code: 'slack_unsigned' };
  }

  return { ok: true };
}
