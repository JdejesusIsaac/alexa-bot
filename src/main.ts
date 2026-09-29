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
import { WebApiSlackClient } from './slack/web-api-client.js';
import { createPickupNotifier } from './services/pickup-notification.js';
import { loadAllEscalationLaddersFromDir } from './sync/escalation-ladder.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const appPool = new Pool({
    connectionString: config.appDatabaseUrl,
    max: 10,
  });

  // The outbound Slack surface (PL-252): configured only when all three
  // parts exist; otherwise requests route and decide without it.
  const slackConfigured =
    config.slackBotToken.length > 0 &&
    config.slackVisibilityChannel.length > 0 &&
    config.pickupReviewUrl.length > 0;
  const pickupNotifier = slackConfigured
    ? createPickupNotifier({
        slack: new WebApiSlackClient({ botToken: config.slackBotToken }),
        visibilityChannel: config.slackVisibilityChannel,
        link: config.pickupReviewUrl,
        logger,
      })
    : undefined;
  if (pickupNotifier === undefined) {
    logger.info({ msg: 'slack_notifications_disabled', reason: 'not_configured' });
  }

  // Per-tenant written ladders (PL-253/254), shared with the worker:
  // each tenant's `initial_minutes` owns its level-0 clock for route.
  // Configured-but-unreadable refuses to boot, same posture as the
  // worker; unconfigured routes with pickup_at.
  const ladderDir = process.env.ESCALATION_LADDER_DIR;
  const loadedLadders =
    ladderDir !== undefined && ladderDir.length > 0
      ? await loadAllEscalationLaddersFromDir(ladderDir)
      : undefined;
  const escalationLadders =
    loadedLadders !== undefined
      ? Object.fromEntries(
          Object.entries(loadedLadders).map(([tenantId, l]) => [
            tenantId,
            { initialMinutes: l.initialMinutes },
          ]),
        )
      : undefined;

  const { close } = await startMcpServer({
    config,
    appPool,
    logger,
    ...(pickupNotifier !== undefined ? { pickupNotifier } : {}),
    ...(escalationLadders !== undefined ? { escalationLadders } : {}),
  });

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
