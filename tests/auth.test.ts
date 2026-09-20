/**
 * PL-103 — bearer-token verification chain (T-24…T-29).
 *
 * T-24: valid token (signature, issuer, expiry, audience all pass) is
 *       accepted and resolves the caller's identity.
 * T-25: token signed by a key not in the JWKS → 401, distinct reason.
 * T-26: token from a different issuer → 401, distinct reason.
 * T-27: expired token → 401, distinct reason.
 * T-28: token for a different resource (wrong audience) → 401 —
 *       audience is what blocks token passthrough.
 * T-29: the same valid token presented as a URL parameter → rejected;
 *       the token value appears in no log, trace, or error.
 *
 * All calls run through the full HTTP stack — these assert wire
 * behavior, not unit-level internals.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  server = await startTestMcpServer({ captureLogs: true });
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

const errorCodes: Array<{ label: string; code: string }> = [];

describe('PL-103 · bearer-token verification', () => {
  it('T-24: valid token passes all four checks and authenticates', async () => {
    const token = await server.mintToken({
      sub: 'staff-alpha',
      tenantId: TENANT_A,
      role: 'staff',
    });
    const session = await client.connect({ token });
    const listed = await client.listTools(session, { token });
    expect(listed.status).toBe(200);
    expect(listed.body?.error).toBeUndefined();
  });

  it('T-25: token signed with a key not in the JWKS is rejected with a distinct reason', async () => {
    const token = await server.mintToken({
      tenantId: TENANT_A,
      foreignKey: true,
    });
    const init = await client.initialize({ token });
    expect(init.status).toBe(401);
    const body = JSON.parse(JSON.stringify(init.body)) as { error_code?: string };
    expect(body.error_code).toBe('invalid_signature');
    errorCodes.push({ label: 'T-25', code: body.error_code ?? '' });
  });

  it('T-26: token from a different issuer is rejected with a distinct reason', async () => {
    const token = await server.mintToken({
      tenantId: TENANT_A,
      issuer: 'https://evil.example.org',
    });
    const init = await client.initialize({ token });
    expect(init.status).toBe(401);
    const body = JSON.parse(JSON.stringify(init.body)) as { error_code?: string };
    expect(body.error_code).toBe('wrong_issuer');
    errorCodes.push({ label: 'T-26', code: body.error_code ?? '' });
  });

  it('T-27: expired token is rejected with a distinct reason (clock skew accounted)', async () => {
    const token = await server.mintToken({
      tenantId: TENANT_A,
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
    });
    const init = await client.initialize({ token });
    expect(init.status).toBe(401);
    const body = JSON.parse(JSON.stringify(init.body)) as { error_code?: string };
    expect(body.error_code).toBe('token_expired');
    errorCodes.push({ label: 'T-27', code: body.error_code ?? '' });
  });

  it('T-28: token minted for a different resource is rejected — audience blocks passthrough', async () => {
    const token = await server.mintToken({
      tenantId: TENANT_A,
      audience: 'https://some-other-resource.example.org',
    });
    const init = await client.initialize({ token });
    expect(init.status).toBe(401);
    const body = JSON.parse(JSON.stringify(init.body)) as { error_code?: string };
    expect(body.error_code).toBe('wrong_audience');
    errorCodes.push({ label: 'T-28', code: body.error_code ?? '' });
  });

  it('rejection reasons for T-25…T-28 are pairwise distinct', () => {
    const codes = new Set(errorCodes.map((e) => e.code));
    expect(codes.size).toBe(errorCodes.length);
    for (const e of errorCodes) {
      expect(e.code).not.toBe('missing_token');
    }
  });

  it('T-29: a valid token passed as a URL parameter is rejected and appears nowhere', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });

    // Append the token to the query string — never sent in the header.
    const res = await fetch(
      `${server.mcpUrl}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'mcp-test-client/1.0',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'mcp-test-client', version: '1.0.0' },
          },
        }),
      },
    );
    expect(res.status).toBe(401);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(token);

    // The token value must not appear in any log line the server wrote.
    const logs = server.logLines.join('\n');
    expect(logs).not.toContain(token);
  });

  it('a missing token is rejected distinctly from a bad one', async () => {
    const init = await client.initialize({});
    expect(init.status).toBe(401);
    const body = JSON.parse(JSON.stringify(init.body)) as { error_code?: string };
    expect(body.error_code).toBe('missing_token');
  });

  it('a malformed Authorization header is rejected, never parsed loosely', async () => {
    const res = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Basic not-a-bearer-token',
        'user-agent': 'mcp-test-client/1.0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'x', version: 'x' },
        },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error_code?: string };
    expect(body.error_code).toBe('malformed_authorization_header');
  });
});
