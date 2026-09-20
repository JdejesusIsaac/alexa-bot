/**
 * 401 response shaping (PL-104, AD-10).
 *
 * The MCP spec makes `WWW-Authenticate` a MUST on 401; Alexa+ requires it
 * absent. No single shape serves both, so the response branches by client.
 *
 * Branch signal (PL-013 finding, fragile by nature): the branch fires
 * before `initialize`, so no MCP client info is available. The only
 * workable signal is the `User-Agent` (substring `alexa`) or the presence
 * of an `x-amzn-alexa-client` header. Both are client-controlled and
 * trivially spoofable — which is acceptable here because spoofing the
 * signal only changes the *discovery hint* (whether the header is
 * present), never the token check. A spoofed Alexa-shaped client gets a
 * headerless 401 it may struggle to act on; it never gets data.
 *
 * The 401 body never carries token contents. Distinct rejection codes are
 * included so production debugging does not require guessing which
 * control fired (T-25…T-29) — codes only, never values.
 */

import { type IncomingMessage, type ServerResponse } from 'node:http';

export interface Rejection401Context {
  /** Distinct rejection code — logged and echoed in the body, values never. */
  code: string;
  /** Stable request id for correlation with logs and audit entries. */
  requestId: string;
  /** Canonical external resource URL (PRM), config-driven, never header-driven. */
  resourceUrl: string;
}

/** Alexa+ identifies itself by User-Agent — heuristic, not a security boundary. */
export function isAlexaShapedClient(req: IncomingMessage): boolean {
  const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
  return ua.includes('alexa') || req.headers['x-amzn-alexa-client'] !== undefined;
}

export function send401(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Rejection401Context,
): void {
  const omitHeader = isAlexaShapedClient(req);

  const headers: Record<string, string> = omitHeader
    ? {}
    : {
        // RFC 9728 §5.1 — points the client at the PRM document.
        'www-authenticate': `Bearer resource_metadata="${ctx.resourceUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
      };

  const body = JSON.stringify({
    error: 'unauthorized',
    error_code: ctx.code,
    request_id: ctx.requestId,
  });

  res.writeHead(401, {
    'content-type': 'application/json',
    ...headers,
  });
  res.end(body);
}
