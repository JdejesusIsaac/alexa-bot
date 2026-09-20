/**
 * PL-102 / PL-104 — HTTP host, discovery, handshake (T-30…T-32, T-46).
 *
 * T-30: PRM document served; `resource` equals the configured external
 *       URL; an X-Forwarded-Host/Proto poisoning attempt does not
 *       change what we advertise.
 * T-31: AS metadata includes code_challenge_methods_supported with
 *       S256 and without plain.
 * T-32: 401 responses split by client — Alexa+ shape omits
 *       WWW-Authenticate; default shape includes it (PRM pointer).
 * T-46: handshake with a supported protocol version completes and the
 *       negotiated version is asserted; an unsupported version yields a
 *       clear, typed failure — never a connection that silently does
 *       nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  server = await startTestMcpServer();
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

describe('PL-104 · discovery endpoints', () => {
  it('T-30: serves the PRM with the configured resource and authorization server', async () => {
    const res = await client.get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const prm = res.body as {
      resource?: string;
      authorization_servers?: string[];
      bearer_methods_supported?: string[];
    };
    expect(prm.resource).toBe(server.config.resourceUrl);
    expect(prm.authorization_servers).toContain(server.as.issuer);
    expect(prm.bearer_methods_supported).toEqual(['header']);
  });

  it('T-30: X-Forwarded-* poisoning does not shape the advertised resource', async () => {
    const res = await fetch(`${server.url}/.well-known/oauth-protected-resource`, {
      headers: {
        'x-forwarded-host': 'evil.example.org',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.9',
      },
    });
    const prm = (await res.json()) as { resource?: string };
    expect(prm.resource).toBe(server.config.resourceUrl);
    expect(prm.resource).not.toContain('evil.example.org');
  });

  it('T-31: AS metadata advertises PKCE S256 (never plain)', async () => {
    const res = await client.get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const metadata = res.body as {
      issuer?: string;
      code_challenge_methods_supported?: string[];
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    expect(metadata.issuer).toBe(server.as.issuer);
    expect(metadata.code_challenge_methods_supported).toContain('S256');
    expect(metadata.code_challenge_methods_supported).not.toContain('plain');
    expect(metadata.authorization_endpoint).toBeDefined();
    expect(metadata.token_endpoint).toBeDefined();
  });
});

// T-32 — the 401 branch signal, recorded per spec: User-Agent contains
// the substring "alexa", or the `x-amzn-alexa-client` header is present
// (src/auth/http401.ts). It fires before `initialize`, so no MCP client
// info exists yet. The signal is spoofable — deliberately acceptable
// because it only shapes the discovery hint (WWW-Authenticate present
// or absent), never the token check. PL-013 found no single 401 shape
// serves both clients (AD-10), so the branch exists at all.
describe('PL-104 · client-conditional 401 (AD-10) — signal: "alexa" in User-Agent or x-amzn-alexa-client header, pre-initialize, spoofable', () => {
  it('T-32: Alexa-shaped client gets a 401 without WWW-Authenticate', async () => {
    const init = await client.initialize({
      userAgent: 'AlexaPlus/1.0 AlexaDevice/25',
    });
    expect(init.status).toBe(401);
    expect(init.rawHeaders.get('www-authenticate')).toBeNull();
    const body = init.body as { error?: string } | null;
    expect(body?.error).toBe('unauthorized');
  });

  it('T-32: default client gets a 401 WITH WWW-Authenticate pointing at the PRM', async () => {
    const init = await client.initialize({
      userAgent: 'claude-desktop/1.0 (linux) node/20',
    });
    expect(init.status).toBe(401);
    const header = init.rawHeaders.get('www-authenticate');
    expect(header).not.toBeNull();
    expect(header).toContain('Bearer');
    expect(header).toContain('resource_metadata');
    expect(header).toContain('/.well-known/oauth-protected-resource');
  });

  it('T-32: the two 401 shapes are distinguishable without disabling either client', async () => {
    const alexa = await client.initialize({ userAgent: 'AlexaPlus/1.0' });
    const other = await client.initialize({ userAgent: 'claude-desktop/1.0' });
    expect(alexa.rawHeaders.get('www-authenticate')).toBeNull();
    expect(other.rawHeaders.get('www-authenticate')).not.toBeNull();
    // Both are 401 — auth outcome identical; only the discovery hint differs.
    expect(alexa.status).toBe(other.status);
  });
});

describe('PL-102 · initialize handshake', () => {
  it('T-46: supported protocol version completes the handshake and is echoed', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const session = await client.connect({ token, protocolVersion: '2025-11-25' });
    expect(session.sessionId).not.toBeNull();

    const listed = await client.listTools(session, { token });
    expect(listed.status).toBe(200);
    const result = listed.body?.result as
      { tools?: Array<{ name?: string }> } | undefined;
    const names = (result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('lookup_scholar_status');
    expect(names).toContain('search_roster');
    expect(names).toContain('roster_sync_status');
  });

  it('T-46: unsupported protocol version fails loudly with a typed error', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const init = await client.initialize({ token, protocolVersion: '1999-01-01' });
    expect(init.status).toBe(400);
    expect(init.body?.error).toBeDefined();
    expect(init.body?.error?.code).toBe(-32602);
    expect(init.body?.error?.message).toMatch(/protocol version/i);
    expect(init.sessionId).toBeNull();
  });

  it('T-46: the negotiated version matches what the client requested (when supported)', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const init = await client.initialize({ token, protocolVersion: '2025-11-25' });
    expect(init.status).toBe(200);
    expect(init.negotiatedVersion).toBe('2025-11-25');
  });

  it('T-47 precondition: a tools/call without any session is rejected, not adopted', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const res = await client.callToolSessionless(
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );
    expect(res.status).toBe(400);
    expect(res.body?.error).toBeDefined();
  });
});
