import {
  type SlackClient,
  type SlackMessage,
  type SlackPostResult,
} from './slack-client.js';

/**
 * Capture Slack client (PL-206) — the test double for the outbound
 * surface, in the FixtureSheetConnector tradition: it records every
 * message it was asked to send and never touches the network.
 *
 * T-68's instrument: the recorded texts are what the system WOULD have
 * put on the wire. A sentinel planted in `reason_detail` must appear
 * in none of them.
 *
 * Can be constructed to fail (or throw) on every send, to exercise the
 * notification error paths the way the failing connector exercises the
 * sync error paths.
 */
export class CaptureSlackClient implements SlackClient {
  private readonly sent: SlackMessage[] = [];
  private readonly mode: 'ok' | 'fail' | 'throw';
  private sequence = 0;

  constructor(opts?: { fail?: 'fail' | 'throw' }) {
    this.mode = opts?.fail ?? 'ok';
  }

  async postMessage(message: SlackMessage): Promise<SlackPostResult> {
    // Record the attempted message even on failure — what a failing
    // send WOULD have put on the wire is part of the leak surface.
    this.sent.push(message);

    if (this.mode === 'throw') {
      throw new Error('simulated Slack client exception');
    }
    if (this.mode === 'fail') {
      return { ok: false, error: 'simulated_send_failure' };
    }
    this.sequence += 1;
    return { ok: true, ts: `captured-ts-${this.sequence}` };
  }

  /** Every message attempted, in order, successful or not. */
  messages(): readonly SlackMessage[] {
    return this.sent;
  }

  /** The text of every attempted message — T-68 scans this for sentinels. */
  texts(): readonly string[] {
    return this.sent.map((m) => m.text);
  }
}
