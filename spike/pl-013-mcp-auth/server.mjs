// PL-013 spike — Streamable HTTP MCP server with a configurable 401 shape.
// THROWAWAY. Not production code. No student data. No database. No tenant context.
//
// Exists to answer one question: can a single 401 response satisfy both the MCP
// spec (which makes WWW-Authenticate a MUST) and Alexa+ (which requires it absent)?

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8420);
const HOST = process.env.HOST ?? '127.0.0.1';
const RESOURCE = process.env.RESOURCE_URL ?? `http://${HOST}:${PORT}`;

// The authorization server. Unresolved — open question 9. Placeholder only;
// the spike does not validate real tokens.
const AS_ISSUER = process.env.AS_ISSUER ?? 'https://example-as.invalid';

// 401 shaping strategy:
//   'spec'   — WWW-Authenticate present, per RFC 9728 §5.1 (MCP spec MUST)
//   'alexa'  — WWW-Authenticate absent, per the Alexa+ requirement
//   'sniff'  — vary by client, which is the only way to serve both
const STRATEGY = process.env["FOUR01_STRATEGY"] ?? 'sniff';

const json = (res, code, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
};

// Alexa+ identifies itself by User-Agent. Treated as a heuristic, not a
// security boundary — it is client-controlled and trivially spoofable.
// Spoofing it only downgrades the *discovery hint*, never the token check,
// which is why this is acceptable here and would not be otherwise.
const isAlexaClient = (req) => {
  const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
  return ua.includes('alexa') || req.headers['x-amzn-alexa-client'] !== undefined;
};

const send401 = (req, res, reason) => {
  const omitHeader =
    STRATEGY === 'alexa' || (STRATEGY === 'sniff' && isAlexaClient(req));

  const headers = omitHeader
    ? {}
    : {
        // RFC 9728 §5.1 — points the client at the PRM document.
        'www-authenticate':
          `Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`,
      };

  json(res, 401, { error: 'unauthorized', reason }, headers);
};

// RFC 9728 Protected Resource Metadata.
// Note: built from a server-side constant, NOT from X-Forwarded-* headers.
// github/github-mcp-server ignores forwarded headers here specifically so an
// untrusted client cannot influence what the server advertises (research §2d).
const prmDocument = () => ({
  resource: RESOURCE,
  authorization_servers: [AS_ISSUER],
  bearer_methods_supported: ['header'],
  scopes_supported: ['parentline.status.read'],
});

const asMetadata = () => ({
  issuer: AS_ISSUER,
  authorization_endpoint: `${AS_ISSUER}/oauth2/authorize`,
  token_endpoint: `${AS_ISSUER}/oauth2/token`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  // OAuth 2.1 + PKCE S256. 'plain' deliberately unsupported.
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
});

// The single trivial tool. Deliberately takes NO arguments — in particular no
// tenant parameter. An external model fills tool arguments, so a tenant
// argument would be cross-campus disclosure one inference away (rule 7).
const TOOLS = [
  {
    name: 'whoami',
    description: 'Returns the identity the server derived from the access token.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const handleRpc = (msg, identity) => {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'pl-013-spike', version: '0.0.0' },
      });

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call':
      if (msg.params?.name !== 'whoami') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: `unknown tool: ${msg.params?.name}` },
        };
      }
      return reply({
        content: [
          {
            type: 'text',
            // Identity comes from the token, never from arguments.
            text: `subject=${identity.sub} via=${identity.source}`,
          },
        ],
      });

    case 'notifications/initialized':
      return null; // notification, no response

    default:
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      };
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, RESOURCE);

  // --- Discovery endpoints: unauthenticated by design ---
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return json(res, 200, prmDocument());
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return json(res, 200, asMetadata());
  }
  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, strategy: STRATEGY });
  }

  // --- MCP endpoint: Streamable HTTP ---
  if (url.pathname !== '/mcp') {
    return json(res, 404, { error: 'not_found' });
  }

  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    return send401(req, res, 'missing bearer token');
  }

  // SPIKE ONLY — accepts any non-empty token. A real deployment validates
  // signature, issuer, audience, and expiry against the AS. Never ship this.
  const token = auth.slice('Bearer '.length).trim();
  if (!token) {
    return send401(req, res, 'empty bearer token');
  }
  const identity = { sub: `spike-subject:${token.slice(0, 8)}`, source: 'access_token' };

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      });
    }

    const result = handleRpc(msg, identity);
    if (result === null) {
      res.writeHead(202).end();
      return;
    }
    json(res, 200, result, { 'mcp-session-id': randomUUID() });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`PL-013 spike listening on ${RESOURCE}`);
  console.log(`  401 strategy : ${STRATEGY}`);
  console.log(`  AS issuer    : ${AS_ISSUER}  ${AS_ISSUER.endsWith('.invalid') ? '(PLACEHOLDER — open question 9)' : ''}`);
  console.log(`  PRM          : ${RESOURCE}/.well-known/oauth-protected-resource`);
});
