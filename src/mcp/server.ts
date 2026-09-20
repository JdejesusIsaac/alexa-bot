/**
 * MCP server factory (PL-102).
 *
 * One `McpServer` per session — the SDK binds a server to a single
 * transport. Tools close over shared singletons (pool, config); identity
 * is NOT session state — it arrives per request on `extra.authInfo`
 * (AD-18), so the same session under a different token resolves to the
 * new token's tenant and role.
 *
 * Protocol version negotiation is explicit: the HTTP layer rejects an
 * `initialize` carrying a protocol version this server does not support
 * with a typed failure before the SDK would silently negotiate down
 * (T-46). A connection that establishes and then speaks a version the
 * client did not ask for is the "silently does nothing" shape.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ToolDeps } from './tools/common.js';
import {
  LOOKUP_SCHOLAR_STATUS_NAME,
  LOOKUP_SCHOLAR_STATUS_DESCRIPTION,
  LOOKUP_SCHOLAR_STATUS_INPUT,
  handleLookupScholarStatus,
} from './tools/lookup-scholar-status.js';
import {
  SEARCH_ROSTER_NAME,
  SEARCH_ROSTER_DESCRIPTION,
  SEARCH_ROSTER_INPUT,
  handleSearchRoster,
} from './tools/search-roster.js';
import {
  ROSTER_SYNC_STATUS_NAME,
  ROSTER_SYNC_STATUS_DESCRIPTION,
  handleRosterSyncStatus,
} from './tools/roster-sync-status.js';

export const SERVER_NAME = 'parent-line';
export const SERVER_VERSION = '2.0.0';

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    LOOKUP_SCHOLAR_STATUS_NAME,
    {
      description: LOOKUP_SCHOLAR_STATUS_DESCRIPTION,
      inputSchema: LOOKUP_SCHOLAR_STATUS_INPUT,
    },
    (args, extra) => handleLookupScholarStatus(args, extra, deps),
  );

  server.registerTool(
    SEARCH_ROSTER_NAME,
    {
      description: SEARCH_ROSTER_DESCRIPTION,
      inputSchema: SEARCH_ROSTER_INPUT,
    },
    (args, extra) => handleSearchRoster(args, extra, deps),
  );

  // No input schema → the SDK passes only `extra` to the callback.
  server.registerTool(
    ROSTER_SYNC_STATUS_NAME,
    { description: ROSTER_SYNC_STATUS_DESCRIPTION },
    (extra) => handleRosterSyncStatus({}, extra, deps),
  );

  return server;
}
