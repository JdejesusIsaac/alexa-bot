/**
 * PL-111 — tool schema version registry (AD-9).
 *
 * Alexa+ caches tool definitions until add-on redeploy; a schema change
 * without a version bump presents as the old definition continuing to
 * drive the model against a server that honors a different one. This
 * test pins the wire-visible schema set:
 *
 * - the fingerprint of the live tools/list output equals the committed
 *   `src/mcp/schema-registry.json`;
 * - the registry version equals `SCHEMA_VERSION` and the version the
 *   server reports in `initialize`;
 * - the changelog records the current version.
 *
 * A deliberate schema change requires: regenerate the registry
 * (`UPDATE_SCHEMA_REGISTRY=1 npm test -- schema-version`), bump
 * `SCHEMA_VERSION`, and add a changelog entry. CI runs the plain check
 * and fails on any silent drift.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestMcpServer, type TestMcpServer } from './helpers/mcp-server.js';
import { McpTestClient } from './helpers/mcp-client.js';
import {
  computeSchemaFingerprint,
  SCHEMA_CHANGELOG,
  SCHEMA_VERSION,
  type ToolFingerprintInput,
} from '../src/mcp/schema-version.js';
import { SERVER_VERSION } from '../src/mcp/server.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

const REGISTRY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'mcp',
  'schema-registry.json',
);

interface RegistryFile {
  version: string;
  fingerprint: string;
  tools: ToolFingerprintInput[];
}

let server: TestMcpServer;
let client: McpTestClient;
let wireTools: ToolFingerprintInput[];
let wireFingerprint: string;

beforeAll(async () => {
  server = await startTestMcpServer();
  client = new McpTestClient(server.mcpUrl);

  const token = await server.mintToken({ tenantId: TENANT_A });
  const session = await client.connect({ token });
  const listed = await client.listTools(session, { token });

  const tools =
    (
      listed.body?.result as
        | { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }
        | undefined
    )?.tools ?? [];

  expect(tools.length).toBe(3);
  wireTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? {},
  }));
  wireFingerprint = computeSchemaFingerprint(wireTools);
});

afterAll(async () => {
  await server.close();
});

describe('PL-111 · schema version registry', () => {
  it('the live tools/list fingerprint matches the committed registry', async () => {
    if (process.env.UPDATE_SCHEMA_REGISTRY === '1') {
      await mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
      await writeFile(
        REGISTRY_PATH,
        `${JSON.stringify({ version: SCHEMA_VERSION, fingerprint: wireFingerprint, tools: wireTools }, null, 2)}\n`,
        'utf8',
      );
    }

    const raw = await readFile(REGISTRY_PATH, 'utf8');
    const registry = JSON.parse(raw) as RegistryFile;

    expect(wireFingerprint).toBe(registry.fingerprint);
    expect(wireTools.map((t) => t.name).sort()).toEqual(
      registry.tools.map((t) => t.name).sort(),
    );
  });

  it('the registry version, SCHEMA_VERSION, and the advertised server version agree', async () => {
    const raw = await readFile(REGISTRY_PATH, 'utf8');
    const registry = JSON.parse(raw) as RegistryFile;

    expect(registry.version).toBe(SCHEMA_VERSION);
    expect(SERVER_VERSION).toBe(SCHEMA_VERSION);

    const token = await server.mintToken({ tenantId: TENANT_A });
    const init = await client.initialize({ token });
    const serverInfo = (
      init.body?.result as
        { serverInfo?: { name?: string; version?: string } } | undefined
    )?.serverInfo;
    expect(serverInfo?.version).toBe(SCHEMA_VERSION);
  });

  it('the changelog records the current version', () => {
    const entry = SCHEMA_CHANGELOG.find((c) => c.version === SCHEMA_VERSION);
    expect(entry).toBeDefined();
    expect(entry!.change.length).toBeGreaterThan(0);
  });

  it('every tool description is non-empty (AD-16 — descriptions are customer-facing)', () => {
    for (const tool of wireTools) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
