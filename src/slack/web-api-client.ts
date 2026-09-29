import {
  type SlackClient,
  type SlackMessage,
  type SlackPostResult,
} from './slack-client.js';

/**
 * Slack Web API client (PL-206) — `chat.postMessage` over HTTPS.
 *
 * No SDK: the Web API is one POST with a bearer token, and adding a
 * dependency for that is more surface than the call. Failures are
 * typed, never thrown — the caller decides what a failed notification
 * means (the request's state does not depend on Slack's health).
 *
 * Token comes from configuration at construction — never a per-call
 * argument, and never logged.
 */
export class WebApiSlackClient implements SlackClient {
  private readonly token: string;
  private readonly apiUrl: string;

  constructor(params: { botToken: string; apiUrl?: string }) {
    this.token = params.botToken;
    this.apiUrl = params.apiUrl ?? 'https://slack.com/api/chat.postMessage';
  }

  async postMessage(message: SlackMessage): Promise<SlackPostResult> {
    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: message.channel,
          text: message.text,
          ...(message.threadTs !== undefined ? { thread_ts: message.threadTs } : {}),
          ...(message.blocks !== undefined ? { blocks: [...message.blocks] } : {}),
        }),
      });
    } catch (err) {
      return {
        ok: false,
        error: `network_error: ${err instanceof Error ? err.message : 'unknown'}`,
      };
    }

    if (!response.ok) {
      // The HTTP status only — response bodies are never echoed, they
      // can carry Slack-side diagnostics we do not own.
      return { ok: false, error: `http_${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'invalid_response_body' };
    }

    const result = body as { ok?: boolean; ts?: string; error?: string };
    if (result.ok === true && typeof result.ts === 'string') {
      return { ok: true, ts: result.ts };
    }
    return {
      ok: false,
      error: typeof result.error === 'string' ? result.error : 'unknown_slack_error',
    };
  }
}
