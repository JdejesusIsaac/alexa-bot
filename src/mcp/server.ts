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
import { type RequestMeta, type ToolDeps } from './tools/common.js';
import {
  LOOKUP_SCHOLAR_STATUS_NAME,
  LOOKUP_SCHOLAR_STATUS_DESCRIPTION,
  LOOKUP_SCHOLAR_STATUS_INPUT,
  handleLookupScholarStatus,
  type LookupResult,
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

/**
 * Registered tool names. The HTTP boundary uses this to distinguish a
 * `tools/call` rejected because the tool does not exist from one that
 * reached dispatch and failed — the audit outcome differs (AD-42).
 */
export const TOOL_NAMES: ReadonlySet<string> = new Set([
  LOOKUP_SCHOLAR_STATUS_NAME,
  SEARCH_ROSTER_NAME,
  ROSTER_SYNC_STATUS_NAME,
]);

type RawToolHandler = (rawArgs: unknown, extra: unknown) => Promise<LookupResult>;

/**
 * Outcome-label enforcement around every tool handler (eval F-5).
 * Handlers normally stage their own `meta.toolAudit`; this wrapper
 * guarantees the label stays honest when they do not — a throw after
 * staging is recorded as `error:handler_threw` (never the staged
 * outcome), and a return without enrichment defaults to the result's
 * actual shape. The boundary can therefore read absent enrichment as
 * "the SDK rejected before dispatch" — a reachable, unaudited call no
 * longer exists.
 */
function audited(toolName: string, handler: RawToolHandler) {
  return async (a?: unknown, b?: unknown): Promise<LookupResult> => {
    // The SDK invokes schema'd tools (args, extra) and schema-less
    // tools (extra); extra is whichever argument carries authInfo.
    const extra = b ?? a;
    const rawArgs = b === undefined ? undefined : a;
    const meta = (
      extra as { authInfo?: { extra?: Partial<RequestMeta> } } | undefined
    )?.authInfo?.extra;
    const startedAt = performance.now();
    try {
      const result = await handler(rawArgs, extra);
      if (meta !== undefined && meta.toolAudit === undefined) {
        meta.toolAudit = {
          tool: toolName,
          argumentsRedacted: {},
          outcome: result?.isError === true ? 'error:tool_error' : 'success',
          toolMs: Math.round(performance.now() - startedAt),
        };
      }
      return result;
    } catch (err) {
      if (meta !== undefined) {
        meta.toolAudit = {
          tool: toolName,
          argumentsRedacted: meta.toolAudit?.argumentsRedacted ?? {},
          outcome: 'error:handler_threw',
          toolMs: Math.round(performance.now() - startedAt),
        };
      }
      throw err;
    }
  };
}

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    LOOKUP_SCHOLAR_STATUS_NAME,
    {
      description: LOOKUP_SCHOLAR_STATUS_DESCRIPTION,
      inputSchema: LOOKUP_SCHOLAR_STATUS_INPUT,
    },
    audited(LOOKUP_SCHOLAR_STATUS_NAME, (args, extra) =>
      handleLookupScholarStatus(args, extra, deps),
    ),
  );

  server.registerTool(
    SEARCH_ROSTER_NAME,
    {
      description: SEARCH_ROSTER_DESCRIPTION,
      inputSchema: SEARCH_ROSTER_INPUT,
    },
    audited(SEARCH_ROSTER_NAME, (args, extra) =>
      handleSearchRoster(args, extra, deps),
    ),
  );

  // No input schema → the SDK passes only `extra` to the callback;
  // `audited` normalizes the argument positions either way.
  server.registerTool(
    ROSTER_SYNC_STATUS_NAME,
    { description: ROSTER_SYNC_STATUS_DESCRIPTION },
    audited(ROSTER_SYNC_STATUS_NAME, (args, extra) =>
      handleRosterSyncStatus(args, extra, deps),
    ),
  );

  return server;
}
