/**
 * PL-113 — session lifecycle, origins, cold JWKS (T-48, T-49).
 *
 * Session lifecycle: initialize issues an `Mcp-Session-Id`; the id is
 * required thereafter; DELETE terminates; idle expiry sweeps; an
 * expired id is a typed 404, never a silent new session.
 *
 * T-48: cold-JWKS latency — the first request after a key-rotation
 *       (cache dropped) pays one JWKS fetch; warm requests do not. The
 *       difference is bounded by that single fetch, and both stay far
 *       inside the Alexa+ budget headroom.
 * T-49: an unexpected `Origin` is rejected; a standalone GET returns
 *       immediately with 405 — nothing ever hangs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import { createMcpApp } from '../src/mcp/http.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

let server: TestMcpServer;
let client: McpTestClient;

beforeAll(async () => {
  // 1-minute TTL with a 150ms sweep — fast enough to observe expiry.
  server = await startTestMcpServer({
    allowedOrigins: ['https://claude.ai'],
    sessionTtlMinutes: 1,
    sweepIntervalMs: 150,
  });
  client = new McpTestClient(server.mcpUrl);
});

afterAll(async () => {
  await server.close();
});

describe('PL-113 · session lifecycle', () => {
  it('initialize issues a session id and requires it thereafter', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const sessionless = await client.callToolSessionless(
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );
    expect(sessionless.status).toBe(400);

    const session = await client.connect({ token });
    expect(session.sessionId).not.toBeNull();
    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );
    expect(res.status).toBe(200);
  });

  it('DELETE terminates the session; the id stops working', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const session = await client.connect({ token });

    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );
    expect(res.status).toBe(200);

    const terminated = await client.delete({ token, sessionId: session.sessionId });
    expect([200, 204, 405]).toContain(terminated.status);

    const after = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );
    expect(after.status).toBe(404);
    expect(after.body?.error?.code).toBe(-32001);
  });

  it('an idle session expires and is then a typed 404 — never a silent upgrade', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const session = await client.connect({ token });
    expect(server.app.sessionCount()).toBeGreaterThan(0);

    // Wait out the 1-minute TTL with the 150ms sweep.
    await new Promise((resolve) => setTimeout(resolve, 62_000));

    expect(server.app.sessionCount()).toBe(0);
    const res = await client.callTool(
      session,
      'lookup_scholar_status',
      {
        student_ref: 'A001',
      },
      { token },
    );
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe(-32001);
  }, 90_000);
});

describe('PL-113 · T-49: origin validation', () => {
  it('rejects an unexpected Origin with 403', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const init = await client.initialize({ token, origin: 'https://evil.example.org' });
    expect(init.status).toBe(403);
  });

  it('allows an explicitly allowlisted Origin', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const init = await client.initialize({ token, origin: 'https://claude.ai' });
    expect(init.status).toBe(200);
  });

  it('allows requests with no Origin at all (non-browser clients)', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const init = await client.initialize({ token });
    expect(init.status).toBe(200);
  });
});

describe('PL-113 · T-49: streaming posture', () => {
  it('a standalone GET on /mcp returns 405 immediately — nothing hangs', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const start = performance.now();
    const res = await fetch(server.mcpUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const elapsed = performance.now() - start;
    expect(res.status).toBe(405);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('PL-113 · T-48: cold-JWKS latency', () => {
  it('a cold JWKS fetch costs at most one network round trip over warm', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });

    // Warm up: this request populates the JWKS cache (if not already).
    await client.initialize({ token });

    // Warm measurements.
    const warm: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const start = performance.now();
      await client.initialize({ token });
      warm.push(performance.now() - start);
    }

    // Drop the cache — the next request pays one JWKS fetch (the
    // realistic worst case after deploy or AS key rotation).
    server.app.resetJwksCache();

    const coldStart = performance.now();
    const coldRes = await client.initialize({ token });
    const cold = performance.now() - coldStart;
    expect(coldRes.status).toBe(200);

    const warmMedian = median(warm);
    // Record the number with its conditions (eval F-2) — the cold path
    // is E3's realistic worst case, and an unrecorded bound is not a
    // measurement.
    console.log(
      `[T-48] cold JWKS request-path fetch: ${cold.toFixed(1)}ms ` +
        `(warm median ${warmMedian.toFixed(1)}ms, local JWKS) — ` +
        `E3 criterion ≤300ms, Alexa+ headroom bound <500ms`,
    );
    // The local JWKS is one localhost fetch — a few ms. The assertion is
    // that cold does not explode (no retry storm, no timeout path) and
    // that the difference is one fetch, not many.
    expect(cold).toBeLessThan(warmMedian + 250);
    expect(cold).toBeLessThan(500); // Alexa+ hard budget headroom
  });

  it('an explicit warm fetches once, and the next request performs no fetch', async () => {
    const token = await server.mintToken({ tenantId: TENANT_A });
    const before = server.as.jwksFetchCount;

    await server.app.warmJwks();
    expect(server.as.jwksFetchCount).toBe(before + 1);

    const res = await client.initialize({ token });
    expect(res.status).toBe(200);
    // The cache is warm — verification does not reach the network.
    expect(server.as.jwksFetchCount).toBe(before + 1);
  });

  it('construction prefetches the JWKS and the refresh timer refetches it', async () => {
    const before = server.as.jwksFetchCount;
    const app = createMcpApp({
      config: server.config,
      appPool: server.db.appPool,
      logger: server.logger,
      jwksRefreshIntervalMs: 50,
    });
    try {
      // Startup prefetch plus at least one refresh tick — polled, not
      // assumed, since the warmup is fire-and-forget by design.
      const deadline = Date.now() + 5_000;
      while (server.as.jwksFetchCount < before + 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(server.as.jwksFetchCount).toBeGreaterThanOrEqual(before + 2);
    } finally {
      await app.close();
    }
  });

  it('warmJwksOnStart: false performs no fetch at construction', async () => {
    const before = server.as.jwksFetchCount;
    const app = createMcpApp({
      config: server.config,
      appPool: server.db.appPool,
      logger: server.logger,
      warmJwksOnStart: false,
      jwksRefreshIntervalMs: 60_000,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(server.as.jwksFetchCount).toBe(before);
    } finally {
      await app.close();
    }
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
