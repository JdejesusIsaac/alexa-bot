/**
 * Streamable HTTP host for the MCP server (PL-102, PL-104, PL-105,
 * PL-110, PL-113).
 *
 * Request path for POST /mcp — order matters:
 *
 *   Origin check → query-string rejection → bearer verification →
 *   body parse → protocol version gate → session routing → SDK transport
 *
 * Invariants enforced here:
 *
 * - **Tokens come from the `Authorization` header only** (T-29). Any
 *   query parameter on /mcp is rejected — we never read values from the
 *   query string, so anything there is dead weight at best and a token
 *   in a log line at worst.
 * - **The token identifies the caller, not the session** (AD-18, T-47).
 *   Verification runs on every request; identity rides to tool handlers
 *   on `extra.authInfo`. A session id replayed under a different token
 *   resolves to the new token's tenant and role — always.
 * - **Unknown or expired sessions get a typed 404** — never a silent
 *   upgrade into a fresh session (T-47).
 * - **`initialize` with an unsupported protocol version fails loudly**
 *   with a typed JSON-RPC error (T-46) instead of the SDK's silent
 *   negotiation down to its own version.
 * - **An unexpected `Origin` is rejected** (T-49, DNS rebinding).
 * - **Discovery documents are built from config, never from request
 *   headers** (T-30) — an untrusted client cannot shape what we
 *   advertise, `X-Forwarded-*` included.
 * - **Every request is audited** (E5, T-40): auth failures with a NULL
 *   tenant row, everything else inside the caller's tenant context.
 *   Tool calls write their own row from the handler; this layer audits
 *   handshake/list/notifications and rejections.
 * - **Standalone GET returns immediately** (T-49) — request/response
 *   JSON only (PL-113 streaming posture); no SSE, nothing to hang.
 */

import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type Config } from '../config.js';
import { type Logger } from '../logging/logger.js';
import { TokenVerifier } from '../auth/token-verifier.js';
import { send401, isAlexaShapedClient } from '../auth/http401.js';
import { createMcpServer } from './server.js';
import {
  insertTenantMcpAuditEntry,
  insertUnauthenticatedMcpAuditEntry,
  type McpAuditInsert,
} from '../repositories/mcp-audit.js';
import { withTenant } from '../db/tenant-context.js';

const MAX_BODY_BYTES = 1_000_000;
const SWEEP_INTERVAL_MS = 60_000;

interface SessionRecord {
  readonly transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

export interface McpApp {
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
  /** Number of live sessions — for tests and ops. */
  sessionCount(): number;
  /** Drop the cached JWKS — forces one cold fetch on the next request (T-48). */
  resetJwksCache(): void;
}

export interface McpAppOptions {
  readonly config: Config;
  readonly appPool: Pool;
  readonly logger: Logger;
  /** Idle-session sweep interval. Default 60s; faster for tests. */
  readonly sweepIntervalMs?: number;
}

export function createMcpApp(options: McpAppOptions): McpApp {
  const { config, appPool, logger } = options;
  const verifier = new TokenVerifier({
    issuer: config.asIssuer,
    jwksUrl: config.asJwksUrl,
    expectedAudience: config.expectedAudience,
    clockSkewSeconds: config.clockSkewSeconds,
    tenantClaim: config.tenantClaim,
    roleClaim: config.roleClaim,
  });
  const sessions = new Map<string, SessionRecord>();
  const sweepTimer = setInterval(
    () => sweepIdleSessions(),
    options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
  );
  sweepTimer.unref();

  function sweepIdleSessions(): void {
    const ttlMs = config.sessionTtlMinutes * 60_000;
    const now = Date.now();
    for (const [id, record] of sessions) {
      if (now - record.lastActivity > ttlMs) {
        logger.info({ msg: 'session_expired', session_id: id });
        sessions.delete(id);
        void record.transport.close().catch(() => undefined);
      }
    }
  }

  // ── Discovery documents (PL-104) ─────────────────────────────────────
  // Built from config constants only. X-Forwarded-* is deliberately
  // ignored — an untrusted client must not influence what we advertise.

  const prmDocument = {
    resource: config.resourceUrl,
    authorization_servers: [config.asIssuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['parentline.status.read'],
  };

  const asMetadata = {
    issuer: config.asIssuer,
    authorization_endpoint: config.asAuthorizationEndpoint,
    token_endpoint: config.asTokenEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // OAuth 2.1 + PKCE S256. 'plain' deliberately unsupported (T-31).
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  // ── Helpers ──────────────────────────────────────────────────────────

  const json = (
    res: ServerResponse,
    code: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json',
      ...headers,
    });
    res.end(payload);
  };

  const jsonRpcError = (
    res: ServerResponse,
    httpCode: number,
    id: string | number | null,
    code: number,
    message: string,
  ): void => {
    json(res, httpCode, {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  };

  async function auditUnauthenticated(
    requestId: string,
    httpMethod: string,
    rpcMethod: string | null,
    outcome: string,
    authMs: number | null,
    requestStartedAt: number,
  ): Promise<void> {
    const entry: McpAuditInsert = {
      requestId,
      actor: 'anonymous',
      role: null,
      httpMethod,
      rpcMethod,
      tool: null,
      argumentsRedacted: {},
      outcome,
      authMs: authMs !== null ? Math.round(authMs) : null,
      toolMs: null,
      totalMs: Math.round(performance.now() - requestStartedAt),
    };
    try {
      await insertUnauthenticatedMcpAuditEntry(appPool, entry);
    } catch (err) {
      // Audit failures are logged, never swallowed silently.
      logger.error({
        msg: 'audit_write_failed',
        request_id: requestId,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function auditTenantRequest(
    identity: { sub: string; tenantId: string; role: string },
    requestId: string,
    requestStartedAt: number,
    authMs: number,
    httpMethod: string,
    rpcMethod: string | null,
    outcome: string,
  ): Promise<void> {
    try {
      await withTenant(appPool, identity.tenantId, (client) =>
        insertTenantMcpAuditEntry(client, {
          requestId,
          actor: identity.sub,
          role: identity.role,
          httpMethod,
          rpcMethod,
          tool: null,
          argumentsRedacted: {},
          outcome,
          authMs: Math.round(authMs),
          toolMs: null,
          totalMs: Math.round(performance.now() - requestStartedAt),
        }),
      );
    } catch (err) {
      logger.error({
        msg: 'audit_write_failed',
        tenant_id: identity.tenantId,
        request_id: requestId,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // ── /mcp routing ────────────────────────────────────────────────────

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const requestId = randomUUID();
    const requestStartedAt = performance.now();

    // T-49 — reject an unexpected Origin. DNS-rebinding protection the
    // moment a real port is bound. Absent Origin (non-browser clients)
    // is allowed.
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      logger.warn({ msg: 'origin_rejected', request_id: requestId });
      await auditUnauthenticated(
        requestId,
        req.method ?? '?',
        null,
        'rejected:origin_not_allowed',
        null,
        requestStartedAt,
      );
      json(res, 403, {
        error: 'forbidden',
        error_code: 'origin_not_allowed',
        request_id: requestId,
      });
      return;
    }

    // T-29 — the query string is never read. Anything there is rejected;
    // we do not log query values, so a token placed there appears nowhere.
    if (url.search !== '') {
      await auditUnauthenticated(
        requestId,
        req.method ?? '?',
        null,
        'rejected:token_in_query_string',
        null,
        requestStartedAt,
      );
      send401(req, res, {
        code: 'token_in_query_string',
        requestId,
        resourceUrl: config.resourceUrl,
      });
      return;
    }

    // Bearer verification — header only, every request (AD-18).
    const authMsStart = performance.now();
    const verification = await verifier.verify(req.headers.authorization);
    const authMs = performance.now() - authMsStart;

    if (!verification.ok) {
      // Distinct, logged rejection; code only — token contents never
      // appear in a log line, error, or audit row (T-25…T-29).
      logger.warn({
        msg: 'auth_rejected',
        request_id: requestId,
        reason: verification.code,
        client_alexa_shaped: isAlexaShapedClient(req),
      });
      await auditUnauthenticated(
        requestId,
        req.method ?? '?',
        null,
        `auth_rejected:${verification.code}`,
        authMs,
        requestStartedAt,
      );
      send401(req, res, {
        code: verification.code,
        requestId,
        resourceUrl: config.resourceUrl,
      });
      return;
    }

    const identity = verification.identity;

    // Method routing within /mcp.
    if (req.method === 'GET') {
      // PL-113 streaming posture: request/response JSON only. A
      // standalone GET for server-initiated messages gets a clean,
      // immediate, documented response — never a hang (T-49).
      res.writeHead(405, { allow: 'POST, DELETE' });
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      const rawSessionId = req.headers['mcp-session-id'];
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;
      const record = sessionId !== undefined ? sessions.get(sessionId) : undefined;
      if (record === undefined || sessionId === undefined) {
        await auditTenantRequest(
          identity,
          requestId,
          requestStartedAt,
          authMs,
          'DELETE',
          null,
          'session_not_found',
        );
        jsonRpcError(res, 404, null, -32001, 'Session not found or expired.');
        return;
      }
      record.lastActivity = Date.now();
      await record.transport.handleRequest(req, res);
      sessions.delete(sessionId);
      await record.transport.close().catch(() => undefined);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST, DELETE' });
      res.end();
      return;
    }

    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.includes('application/json')) {
      await auditTenantRequest(
        identity,
        requestId,
        requestStartedAt,
        authMs,
        'POST',
        null,
        'rejected:unsupported_media_type',
      );
      res.writeHead(415, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'content-type must be application/json' }));
      return;
    }

    // Parse the body before routing: the version gate needs it.
    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body.toString('utf8') || 'null');
    } catch {
      await auditTenantRequest(
        identity,
        requestId,
        requestStartedAt,
        authMs,
        'POST',
        null,
        'rejected:parse_error',
      );
      jsonRpcError(res, 400, null, -32700, 'Parse error.');
      return;
    }

    if (raw === null || Array.isArray(raw) || typeof raw !== 'object') {
      await auditTenantRequest(
        identity,
        requestId,
        requestStartedAt,
        authMs,
        'POST',
        null,
        'rejected:parse_error',
      );
      jsonRpcError(
        res,
        400,
        null,
        -32600,
        'Invalid request — a single JSON-RPC message object is required.',
      );
      return;
    }

    const message = raw as {
      id?: string | number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    const rpcMethod = typeof message.method === 'string' ? message.method : null;

    // T-46 — an initialize carrying a protocol version we do not support
    // fails loudly, before the SDK would negotiate down silently.
    if (rpcMethod === 'initialize') {
      const requested = message.params?.protocolVersion;
      if (
        requested === undefined ||
        !SUPPORTED_PROTOCOL_VERSIONS.concat(LATEST_PROTOCOL_VERSION).includes(requested)
      ) {
        await auditTenantRequest(
          identity,
          requestId,
          requestStartedAt,
          authMs,
          'POST',
          'initialize',
          'rejected:unsupported_protocol_version',
        );
        jsonRpcError(
          res,
          400,
          message.id ?? null,
          -32602,
          `Unsupported protocol version. This server supports ${LATEST_PROTOCOL_VERSION}.`,
        );
        return;
      }
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionKey = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

    if (sessionKey === undefined) {
      if (rpcMethod !== 'initialize') {
        // Non-initialization requests require a session — a typed
        // rejection, never a silent fresh session (T-47).
        await auditTenantRequest(
          identity,
          requestId,
          requestStartedAt,
          authMs,
          'POST',
          rpcMethod,
          'rejected:session_required',
        );
        jsonRpcError(
          res,
          400,
          message.id ?? null,
          -32602,
          'Missing session: initialize first.',
        );
        return;
      }

      // Fresh session: new transport + per-session McpServer.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, lastActivity: Date.now() });
          logger.debug({
            msg: 'session_initialized',
            request_id: requestId,
            session_id: id,
          });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          logger.debug({ msg: 'session_closed', request_id: requestId, session_id: id });
        },
      });
      const server = createMcpServer({
        appPool,
        rosterFreshnessMinutes: config.rosterFreshnessMinutes,
        logger,
      });
      // The SDK's own type declarations predate exactOptionalPropertyTypes
      // and are not mutually assignable under it; the runtime interface is
      // sound. Narrowing cast, documented here rather than sprinkled.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

      // Identity and per-request context ride on req.auth — per request,
      // never cached against the session (AD-18).
      (req as IncomingMessage & { auth?: object }).auth = {
        token: '',
        clientId: 'static-client',
        scopes: [],
        extra: { identity, requestId, requestStartedAt, authMs },
      };

      try {
        await transport.handleRequest(req, res, message);
      } catch (err) {
        logger.error({
          msg: 'request_failed',
          tenant_id: identity.tenantId,
          request_id: requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          jsonRpcError(res, 500, message.id ?? null, -32603, 'Internal error.');
        }
      }

      logger.info({
        msg: 'mcp_request',
        tenant_id: identity.tenantId,
        request_id: requestId,
        rpc_method: 'initialize',
        outcome: 'initialized',
        auth_ms: Math.round(authMs),
        total_ms: Math.round(performance.now() - requestStartedAt),
      });
      await auditTenantRequest(
        identity,
        requestId,
        requestStartedAt,
        authMs,
        'POST',
        'initialize',
        'initialized',
      );
      return;
    }

    const record = sessions.get(sessionKey);
    if (record === undefined) {
      // Unknown or expired — typed 404, never a silent new session (T-47).
      await auditTenantRequest(
        identity,
        requestId,
        requestStartedAt,
        authMs,
        'POST',
        rpcMethod,
        'session_not_found',
      );
      jsonRpcError(res, 404, message.id ?? null, -32001, 'Session not found or expired.');
      return;
    }
    record.lastActivity = Date.now();

    (req as IncomingMessage & { auth?: object }).auth = {
      token: '',
      clientId: 'static-client',
      scopes: [],
      extra: { identity, requestId, requestStartedAt, authMs },
    };

    try {
      await record.transport.handleRequest(req, res, message);
    } catch (err) {
      logger.error({
        msg: 'request_failed',
        tenant_id: identity.tenantId,
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        jsonRpcError(res, 500, message.id ?? null, -32603, 'Internal error.');
      }
    }

    // tools/call requests are audited inside the tool handler (one row,
    // with the tool's own latency stages). Everything else is audited here.
    if (rpcMethod !== 'tools/call') {
      const outcome = rpcMethod === null ? 'received' : rpcMethod.replaceAll('/', '_');
      logger.info({
        msg: 'mcp_request',
        tenant_id: identity.tenantId,
        request_id: requestId,
        rpc_method: rpcMethod,
        outcome,
        auth_ms: Math.round(authMs),
        total_ms: Math.round(performance.now() - requestStartedAt),
      });
      await auditTenantRequest(
        identity,
        requestId,
        requestStartedAt,
        authMs,
        'POST',
        rpcMethod,
        outcome,
      );
    } else {
      logger.debug({
        msg: 'mcp_request',
        tenant_id: identity.tenantId,
        request_id: requestId,
        rpc_method: rpcMethod,
        auth_ms: Math.round(authMs),
        total_ms: Math.round(performance.now() - requestStartedAt),
      });
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, sessions: sessions.size });
      return;
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/.well-known/oauth-protected-resource'
    ) {
      // RFC 9728. Never derived from request headers (T-30).
      json(res, 200, prmDocument);
      return;
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/.well-known/oauth-authorization-server'
    ) {
      json(res, 200, asMetadata);
      return;
    }

    if (url.pathname === '/mcp') {
      await handleMcp(req, res, url);
      return;
    }

    json(res, 404, { error: 'not_found' });
  }

  return {
    handleRequest,
    sessionCount: () => sessions.size,
    resetJwksCache: () => verifier.resetJwksCache(),
    async close(): Promise<void> {
      clearInterval(sweepTimer);
      for (const [, record] of sessions) {
        await record.transport.close().catch(() => undefined);
      }
      sessions.clear();
    },
  };
}

/** Production convenience: bind an HTTP server around the MCP app. */
export function startMcpServer(options: McpAppOptions): Promise<{
  server: Server;
  app: McpApp;
  close: () => Promise<void>;
}> {
  const app = createMcpApp(options);
  const server = createServer((req, res) => {
    void app.handleRequest(req, res).catch((err) => {
      options.logger.error({
        msg: 'unhandled_request_error',
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(options.config.mcpPort, options.config.mcpHost, () => {
      resolve({
        server,
        app,
        close: async () => {
          await app.close();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
