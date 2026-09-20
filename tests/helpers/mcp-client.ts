/**
 * Minimal MCP client for tests (PL-102, PL-107…PL-113).
 *
 * Speaks raw JSON-RPC over Streamable HTTP — deliberately NOT the SDK
 * client, so the tests assert what the wire actually carries: status
 * codes, headers, JSON-RPC error shapes, session ids.
 */

export interface JsonRpcResponse {
  readonly jsonrpc: string;
  readonly id?: string | number | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface McpClientSession {
  readonly sessionId: string;
}

export interface McpRequestOptions {
  readonly token?: string;
  readonly sessionId?: string;
  readonly origin?: string;
  readonly userAgent?: string;
  readonly headers?: Record<string, string>;
}

export class McpTestClient {
  constructor(private readonly mcpUrl: string) {}

  private async post(
    body: unknown,
    options: McpRequestOptions,
  ): Promise<{
    status: number;
    headers: Headers;
    body: JsonRpcResponse | null;
    text: string;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // The MCP Streamable HTTP spec (and the SDK) require clients to
      // accept both response shapes, even in JSON-only mode.
      accept: 'application/json, text/event-stream',
      ...(options.userAgent !== undefined ? { 'user-agent': options.userAgent } : {}),
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options.sessionId !== undefined ? { 'mcp-session-id': options.sessionId } : {}),
      ...(options.token !== undefined
        ? { authorization: `Bearer ${options.token}` }
        : {}),
      ...options.headers,
    };

    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: JsonRpcResponse | null = null;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as JsonRpcResponse) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  async initialize(options: McpRequestOptions & { protocolVersion?: string }): Promise<{
    status: number;
    body: JsonRpcResponse | null;
    sessionId: string | null;
    negotiatedVersion: string | null;
    rawHeaders: Headers;
  }> {
    const { protocolVersion, ...rest } = options;
    const res = await this.post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: protocolVersion ?? '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'mcp-test-client', version: '1.0.0' },
        },
      },
      rest,
    );
    const sessionId = res.headers.get('mcp-session-id');
    const negotiated =
      (res.body?.result as { protocolVersion?: string } | undefined)?.protocolVersion ??
      null;
    return {
      status: res.status,
      body: res.body,
      sessionId,
      negotiatedVersion: negotiated,
      rawHeaders: res.headers,
    };
  }

  /** Complete the handshake: initialize → notifications/initialized. */
  async connect(
    options: McpRequestOptions & { protocolVersion?: string },
  ): Promise<McpClientSession> {
    const init = await this.initialize(options);
    if (init.status !== 200 || init.sessionId === null) {
      throw new Error(
        `initialize failed: status=${init.status} body=${JSON.stringify(init.body)}`,
      );
    }
    const notified = await this.post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { ...options, sessionId: init.sessionId },
    );
    if (notified.status !== 202) {
      throw new Error(`initialized notification failed: status=${notified.status}`);
    }
    return { sessionId: init.sessionId };
  }

  async listTools(
    session: McpClientSession,
    options: McpRequestOptions = {},
  ): Promise<{ status: number; body: JsonRpcResponse | null }> {
    const res = await this.post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...options, sessionId: session.sessionId },
    );
    return { status: res.status, body: res.body };
  }

  async callTool(
    session: McpClientSession,
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<{ status: number; body: JsonRpcResponse | null; rawText: string }> {
    const res = await this.post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
      { ...options, sessionId: session.sessionId },
    );
    return { status: res.status, body: res.body, rawText: res.text };
  }

  /** A tools/call attempt WITHOUT a session — must never succeed. */
  async callToolSessionless(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<{ status: number; body: JsonRpcResponse | null }> {
    const res = await this.post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
      options,
    );
    return { status: res.status, body: res.body };
  }

  async get(
    path: string,
    options: McpRequestOptions = {},
  ): Promise<{
    status: number;
    headers: Headers;
    body: unknown;
    text: string;
  }> {
    const res = await fetch(new URL(path, this.mcpUrl), {
      method: 'GET',
      headers: {
        ...(options.userAgent !== undefined ? { 'user-agent': options.userAgent } : {}),
        ...(options.origin !== undefined ? { origin: options.origin } : {}),
        ...(options.token !== undefined
          ? { authorization: `Bearer ${options.token}` }
          : {}),
      },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  async delete(
    options: McpRequestOptions,
  ): Promise<{ status: number; body: JsonRpcResponse | null }> {
    const headers: Record<string, string> = {
      ...(options.sessionId !== undefined ? { 'mcp-session-id': options.sessionId } : {}),
      ...(options.token !== undefined
        ? { authorization: `Bearer ${options.token}` }
        : {}),
    };
    const res = await fetch(this.mcpUrl, { method: 'DELETE', headers });
    const text = await res.text();
    let parsed: JsonRpcResponse | null = null;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as JsonRpcResponse) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }
}

/** Extract the typed refusal reason from a tools/call response body. */
export function refusalReason(body: JsonRpcResponse | null): string | null {
  const result = body?.result as
    | { isError?: boolean; structuredContent?: { kind?: string; reason?: string } }
    | undefined;
  if (result === undefined || result.isError !== true) return null;
  return result.structuredContent?.reason ?? null;
}
