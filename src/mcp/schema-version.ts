/**
 * Tool schema version registry (PL-111, AD-9).
 *
 * Alexa+ caches tool definitions until add-on redeploy — a schema change
 * without a version bump presents as the old definition continuing to
 * drive the model against a server that honors a different one. The
 * registry makes the schema set a versioned interface:
 *
 * - `SCHEMA_VERSION` is the current version, exposed via `initialize`.
 * - `SCHEMA_CHANGELOG` records every change with its version.
 * - `schema-registry.json` pins the fingerprint of the current schema
 *   set. A test recomputes the fingerprint from the registered tools and
 *   compares — a schema change without a version bump fails CI.
 */

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = '2.0.0';

export interface SchemaChangeEntry {
  readonly version: string;
  readonly date: string;
  readonly change: string;
}

export const SCHEMA_CHANGELOG: readonly SchemaChangeEntry[] = [
  {
    version: '2.0.0',
    date: '2026-09-16',
    change:
      'Sprint 2 initial staff toolset: lookup_scholar_status, search_roster, roster_sync_status.',
  },
];

/** Shape used for fingerprinting — mirrors what a client sees in tools/list. */
export interface ToolFingerprintInput {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/**
 * Stable fingerprint of a tool schema set: canonical JSON (sorted keys)
 * of name + description + inputSchema, SHA-256, hex. Deterministic so the
 * committed `schema-registry.json` never churns on key ordering.
 */
export function computeSchemaFingerprint(tools: readonly ToolFingerprintInput[]): string {
  const canonical = tools
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => canonicalize(t));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const result: Record<string, unknown> = {};
    for (const [key, val] of entries) result[key] = canonicalize(val);
    return result;
  }
  return value;
}
