/**
 * Shared context for MCP tool handlers (PL-107…PL-109).
 *
 * Identity is resolved from the verified access token on EVERY request and
 * rides on `extra.authInfo.extra` — never on the session (AD-18). A tool
 * handler that cannot see an identity is a wiring bug; it refuses closed.
 *
 * Recorded arguments are tenant-safe by construction: student identifiers
 * (refs, names) are never placed in audit rows or logs (T-40) — we record
 * WHICH argument was used, not its value.
 */

import { type Pool } from 'pg';
import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { type AuthedIdentity } from '../../auth/identity.js';
import { type Logger } from '../../logging/logger.js';

export interface RequestMeta {
  /** Verified caller identity — from this request's token, not the session. */
  readonly identity: AuthedIdentity;
  readonly requestId: string;
  /** Epoch ms when the HTTP request was received (for total latency). */
  readonly requestStartedAt: number;
  /** Token verification duration in ms (for per-stage tracing, T-41). */
  readonly authMs: number;
}

export interface ToolDeps {
  readonly appPool: Pool;
  readonly rosterFreshnessMinutes: number;
  readonly logger: Logger;
}

/**
 * Extract the per-request context a tool handler needs. Throws a typed
 * error when absent — the auth gate is upstream, so absence is a bug,
 * and the correct behavior is a loud refusal, not a default.
 */
export function requireRequestMeta(extra: unknown): RequestMeta {
  const e = extra as RequestHandlerExtra<never, never> | undefined;
  const meta = e?.authInfo?.extra as Partial<RequestMeta> | undefined;
  if (
    meta === undefined ||
    meta.identity === undefined ||
    meta.requestId === undefined ||
    meta.requestStartedAt === undefined ||
    meta.authMs === undefined
  ) {
    throw new Error('missing request auth context — auth gate is upstream of every tool');
  }
  return meta as RequestMeta;
}

/** Zod raw shape for tools that take no arguments. */
export const NO_ARGS: Readonly<Record<string, z.ZodType>> = {};

/**
 * Customer-facing refusal copy (AD-16, AD-7). Degrade to a human, never
 * to a guess — and never to a phrasing that confirms what it refuses to
 * reveal. These strings reach the model, the customer, and the voice
 * layer; no jargon, no campus names, no student-data examples.
 */
export const REFUSAL_COPY: Readonly<Record<string, string>> = {
  roster_stale:
    'The roster is not current enough to answer reliably. Please try again shortly or check with the front office.',
  sync_failed:
    'The most recent roster refresh did not complete. Please check with the front office for the latest information.',
  student_not_found:
    'No scholar matching that reference is on today\u2019s roster. Double-check the spelling or ID, or check with the front office.',
  row_quarantined:
    'That record could not be validated and is pending staff review. Please check with the front office.',
  insufficient_role:
    'That information requires an administrative role. Please contact an administrator.',
  invalid_arguments:
    'That request is missing a required detail. Provide either a scholar ID or a scholar name.',
};
