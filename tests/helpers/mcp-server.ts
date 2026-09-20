/**
 * Test harness for the MCP HTTP server (PL-102…PL-113).
 *
 * Boots the full stack against a real Postgres: provisions the test
 * database (RLS enforced, restricted app role), seeds both synthetic
 * tenants, runs a sync for each so both rosters are fresh, starts the
 * local test AS, and binds the MCP server to an ephemeral port.
 *
 * The config's `resourceUrl` and `expectedAudience` are built from the
 * ACTUAL bound port — the audience check (T-28) must pass on the happy
 * path and fail only for genuinely wrong-audience tokens, so both sides
 * of the check agree on the one true URL.
 */

import { createServer, type Server } from 'node:http';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger, type Logger } from '../../src/logging/logger.js';
import { createMcpApp, type McpApp } from '../../src/mcp/http.js';
import { startLocalAs, type LocalAs } from './local-as.js';
import { provisionTestDb, type TestDb } from './db.js';
import { runSync, type SyncJob } from '../../src/sync/scheduler.js';
import { FixtureSheetConnector } from '../../src/connector/fixture-sheet-connector.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_MAPPINGS,
  TENANT_B_MAPPINGS,
  TENANT_A_DERIVATION_RULES,
  TENANT_B_DERIVATION_RULES,
} from '../../src/fixtures/synthetic-data.js';

export interface TestMcpServerOptions {
  readonly rosterFreshnessMinutes?: number;
  readonly allowedOrigins?: readonly string[];
  readonly sessionTtlMinutes?: number;
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Capture log lines for leak assertions (T-40) without console noise. */
  readonly captureLogs?: boolean;
  /** Idle-session sweep interval; default 60s in prod, faster here. */
  readonly sweepIntervalMs?: number;
}

export interface TestMcpServer {
  readonly config: Config;
  readonly db: TestDb;
  readonly as: LocalAs;
  readonly logger: Logger;
  readonly app: McpApp;
  readonly url: string;
  readonly mcpUrl: string;
  readonly logLines: readonly string[];
  /** Mint a token for a caller; audience and issuer preset to pass. */
  mintToken(params: {
    readonly sub?: string;
    readonly tenantId: string;
    readonly role?: 'staff' | 'admin';
    readonly audience?: string;
    readonly issuer?: string;
    readonly expiresIn?: string;
    readonly expiresAt?: number;
    readonly foreignKey?: boolean;
    readonly omitTenantClaim?: boolean;
    readonly omitRoleClaim?: boolean;
    readonly omitSubject?: boolean;
  }): Promise<string>;
  close(): Promise<void>;
}

export async function startTestMcpServer(
  options: TestMcpServerOptions = {},
): Promise<TestMcpServer> {
  const db = await provisionTestDb();

  // Seed tenants, mappings, derivation rules — owner role, explicit SQL,
  // mirroring the Sprint 1 service tests.
  const owner = await db.ownerPool.connect();
  try {
    await owner.query(
      `insert into tenants (id, name) values ($1, 'Campus Alpha'), ($2, 'Campus Bravo')`,
      [TENANT_A, TENANT_B],
    );
    for (const [tenantId, mappings] of [
      [TENANT_A, TENANT_A_MAPPINGS],
      [TENANT_B, TENANT_B_MAPPINGS],
    ] as const) {
      for (const m of mappings) {
        await owner.query(
          `insert into column_mappings (tenant_id, sheet_header, canonical_field) values ($1, $2, $3)`,
          [tenantId, m.sheetHeader, m.canonicalField],
        );
      }
    }
    for (const [tenantId, rules] of [
      [TENANT_A, TENANT_A_DERIVATION_RULES],
      [TENANT_B, TENANT_B_DERIVATION_RULES],
    ] as const) {
      for (const r of rules) {
        await owner.query(
          `insert into derivation_rules (tenant_id, rule_name, condition_column, condition_value, derived_hold_type) values ($1, $2, $3, $4, $5)`,
          [tenantId, r.ruleName, r.conditionColumn, r.conditionValue, r.derivedHoldType],
        );
      }
    }
  } finally {
    owner.release();
  }

  // Fresh roster for both tenants (also seeds quarantined dirty rows).
  const connector = new FixtureSheetConnector();
  for (const tenantId of [TENANT_A, TENANT_B]) {
    const job: SyncJob = {
      tenantId,
      sheetId: tenantId,
      range: 'Sheet1!A1:Z1000',
    };
    const result = await runSync(db.appPool, connector, job);
    if (result.kind !== 'success') {
      throw new Error(`fixture sync failed for ${tenantId}`);
    }
  }

  const as = await startLocalAs();

  // Bind first (ephemeral port), then build config from the real port.
  const logLines: string[] = [];
  const logger = createLogger({ logLevel: options.logLevel ?? 'error' }, {
    write: (line: string) => {
      if (options.captureLogs === true) logLines.push(line);
    },
  } as NodeJS.WritableStream);

  const server: Server = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server failed to bind');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: db.ownerUrl,
    APP_DATABASE_URL: db.appUrl,
    RESOURCE_URL: baseUrl,
    AS_ISSUER: as.issuer,
    AS_JWKS_URL: as.jwksUrl,
    EXPECTED_AUDIENCE: baseUrl,
    ALLOWED_ORIGINS: (options.allowedOrigins ?? []).join(','),
    ROSTER_FRESHNESS_MINUTES: String(options.rosterFreshnessMinutes ?? 45),
    SESSION_TTL_MINUTES: String(options.sessionTtlMinutes ?? 60),
  });

  const app = createMcpApp({
    config,
    appPool: db.appPool,
    logger,
    ...(options.sweepIntervalMs !== undefined
      ? { sweepIntervalMs: options.sweepIntervalMs }
      : {}),
  });
  server.on('request', (req, res) => {
    void app.handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  const mcpUrl = `${baseUrl}/mcp`;

  return {
    config,
    db,
    as,
    logger,
    app,
    url: baseUrl,
    mcpUrl,
    get logLines(): readonly string[] {
      return logLines;
    },
    mintToken: (params) =>
      as.mintToken({
        ...params,
        audience: params.audience ?? baseUrl,
      }),
    close: async () => {
      await app.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()));
      });
      await as.close();
      await db.cleanup();
    },
  };
}
