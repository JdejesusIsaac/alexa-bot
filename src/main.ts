/**
 * Production entry — boots the MCP HTTP server (Streamable HTTP) with
 * the config-validated environment and the non-owner app pool.
 *
 * The app pool connects as `parentline_app` (APP_DATABASE_URL) — never
 * the table owner (T-05, AD-11). Auth is AS-agnostic (PL-101): issuer,
 * JWKS URL, audience, and claim names come from config.
 */

import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createLogger } from './logging/logger.js';
import { startMcpServer } from './mcp/http.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const appPool = new Pool({
    connectionString: config.appDatabaseUrl,
    max: 10,
  });

  const { close } = await startMcpServer({ config, appPool, logger });

  logger.info({
    msg: 'mcp_server_listening',
    host: config.mcpHost,
    port: config.mcpPort,
    resource_url: config.resourceUrl,
    as_issuer: config.asIssuer,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ msg: 'mcp_server_stopping', signal });
    try {
      await close();
      await appPool.end();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Config errors name fields only — never values — so this is safe.
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'startup_failed',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
