import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Pool } from 'pg';
import { withTenant, withTenantTransaction } from '../db/tenant-context.js';
import {
  findPickupRequestById,
  pickupRequestBelongsToTenant,
} from '../repositories/pickup-requests.js';
import { findStaffIdentityBySlackUserId } from '../repositories/staff-identities.js';
import {
  insertTenantMcpAuditEntry,
  insertUnauthenticatedMcpAuditEntry,
} from '../repositories/mcp-audit.js';
import { decidePickupRequestAsSlackActor } from '../services/pickup-decision.js';
import { verifySlackSignature } from './verify-signature.js';
import { type Logger } from '../logging/logger.js';

/**
 * Slack interaction endpoint (PL-207) — approve-only, inbound.
 *
 * The second authentication scheme on a write path, so it gets the
 * scrutiny Sprint 2 gave OAuth. Order of operations is the security
 * property:
 *
 *   signature → freshness → replay → parse → tenant → actor → decision
 *
 * **AD-42: auditing lives HERE, at the boundary — not in any handler.**
 * Unsigned, stale, and replayed payloads fail before any request
 * handler runs; a handler-level audit would record nothing, which is
 * precisely the Sprint 2 F-1 shape that shipped green. Every
 * rejection writes an `mcp_audit` row queryable by `request_id` (T-65
 * asserts the row, never a log line). Pre-tenant rows are NULL-tenant
 * (the AD-21 pattern: outcome code and latency only, no student data).
 *
 * **T-66: a cross-tenant request_id is indistinguishable from a
 * nonexistent one** — message, code, and response time. The tenant
 * resolves silently via the SECURITY DEFINER lookup; an unmapped actor
 * in the resolved tenant produces the identical not-found response
 * (the response never says "you exist but may not act here"). The
 * audit rows distinguish internally — staff-side diagnostics — while
 * the wire stays uniform.
 *
 * **The auth equivalent of Rule 8:** nothing in this module logs the
 * signing secret, the computed signature, or the basestring. Outcome
 * codes only.
 */

const MAX_BODY_BYTES = 64 * 1024;

/** Slack's interaction payload shape (block_actions) as we mint it. */
const interactionSchema = z.object({
  type: z.literal('block_actions'),
  user: z.object({ id: z.string().min(1) }),
  actions: z
    .array(z.object({ action_id: z.string().min(1), value: z.string().min(1) }))
    .min(1)
    .max(1),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bounded digest cache of processed payloads. A delivery whose body
 * was already processed within the window is a replay — rejected
 * distinctly (`slack_replayed`). At-least-once delivery beyond the
 * cache is the decision path's idempotency (T-54), and beyond the
 * window the freshness check rejects: three layers, none of which
 * double-decide. In-process by design (AD-52's single-instance
 * posture).
 */
class ReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  has(digest: string, now: number): boolean {
    const expires = this.seen.get(digest);
    return expires !== undefined && expires > now;
  }

  add(digest: string, now: number): void {
    if (this.seen.size >= this.maxEntries) this.prune(now);
    this.seen.set(digest, now + this.ttlMs);
  }

  private prune(now: number): void {
    for (const [key, expires] of this.seen) {
      if (expires <= now) this.seen.delete(key);
      if (this.seen.size < this.maxEntries) break;
    }
  }
}

export interface SlackInteractionDeps {
  readonly appPool: Pool;
  readonly logger: Logger;
  /** Shared with Slack; synthetic in development, never logged. */
  readonly signingSecret: string;
  /**
   * Every configured tenant (SLACK_TENANT_IDS). The endpoint probes
   * ALL of them for every request — constant work is what makes a
   * cross-tenant id indistinguishable from a nonexistent one (T-66).
   */
  readonly tenantIds: readonly string[];
  readonly replayWindowSeconds?: number;
}

export function createSlackInteractionHandler(deps: SlackInteractionDeps) {
  const replayWindowSeconds = deps.replayWindowSeconds ?? 300;
  const replayCache = new ReplayCache(replayWindowSeconds * 1000);

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  /** Boundary audit — the one writer for every outcome on this surface. */
  async function audit(
    requestId: string,
    outcome: string,
    detail: {
      tenantId: string | null;
      actor: string;
      authMs: number;
      startedAt: number;
      toolMs?: number | null;
    },
  ): Promise<void> {
    // Latency columns are int — round here, once, so every caller is safe.
    const toolMs =
      detail.toolMs !== undefined && detail.toolMs !== null
        ? Math.round(detail.toolMs)
        : null;
    try {
      if (detail.tenantId !== null) {
        await withTenant(deps.appPool, detail.tenantId, (client) =>
          insertTenantMcpAuditEntry(client, {
            requestId,
            actor: detail.actor,
            role: null,
            httpMethod: 'POST',
            rpcMethod: 'slack_interaction',
            tool: null,
            argumentsRedacted: {},
            outcome,
            authMs: Math.round(detail.authMs),
            toolMs,
            totalMs: Math.round(performance.now() - detail.startedAt),
          }),
        );
      } else {
        await insertUnauthenticatedMcpAuditEntry(deps.appPool, {
          requestId,
          actor: detail.actor,
          role: null,
          httpMethod: 'POST',
          rpcMethod: 'slack_interaction',
          tool: null,
          argumentsRedacted: {},
          outcome,
          authMs: Math.round(detail.authMs),
          toolMs,
          totalMs: Math.round(performance.now() - detail.startedAt),
        });
      }
    } catch (err) {
      // Audit failures are logged, never swallowed silently. The log
      // carries the outcome and error message only — never the request
      // body, signature material, or student data.
      deps.logger.error({
        msg: 'audit_write_failed',
        request_id: requestId,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  return async function handleSlackInteraction(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const requestId = randomUUID();
    const startedAt = performance.now();

    if (req.method !== 'POST') {
      await audit(requestId, 'rejected:method_not_allowed', {
        tenantId: null,
        actor: 'slack',
        authMs: 0,
        startedAt,
      });
      json(res, 404, { error: 'not_found', request_id: requestId });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      await audit(requestId, 'rejected:body_too_large', {
        tenantId: null,
        actor: 'slack',
        authMs: 0,
        startedAt,
      });
      json(res, 413, { error: 'payload_too_large', request_id: requestId });
      return;
    }
    const rawBody = raw.toString('utf8');

    // No secret configured → fail closed. An endpoint that cannot
    // verify signatures does not accept interactions at all.
    if (deps.signingSecret.length === 0) {
      deps.logger.warn({
        msg: 'slack_interaction_rejected',
        request_id: requestId,
        reason: 'not_configured',
      });
      await audit(requestId, 'rejected:slack_not_configured', {
        tenantId: null,
        actor: 'slack',
        authMs: performance.now() - startedAt,
        startedAt,
      });
      json(res, 401, { error: 'slack_not_configured', request_id: requestId });
      return;
    }

    // 1. Signature — unsigned or stale, distinctly, before anything else.
    const authStart = performance.now();
    const signature = verifySlackSignature({
      signingSecret: deps.signingSecret,
      timestamp:
        typeof req.headers['x-slack-request-timestamp'] === 'string'
          ? (req.headers['x-slack-request-timestamp'] as string)
          : undefined,
      signature:
        typeof req.headers['x-slack-signature'] === 'string'
          ? (req.headers['x-slack-signature'] as string)
          : undefined,
      rawBody,
      replayWindowSeconds,
    });
    const authMs = performance.now() - authStart;
    if (!signature.ok) {
      // Outcome code only — no signature material in any output path.
      await audit(requestId, `rejected:${signature.code}`, {
        tenantId: null,
        actor: 'slack',
        authMs,
        startedAt,
      });
      json(res, 401, { error: signature.code, request_id: requestId });
      return;
    }

    // 2. Replay — a body already processed inside the window.
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const nowMs = Date.now();
    if (replayCache.has(digest, nowMs)) {
      await audit(requestId, 'rejected:slack_replayed', {
        tenantId: null,
        actor: 'slack',
        authMs,
        startedAt,
      });
      json(res, 401, { error: 'slack_replayed', request_id: requestId });
      return;
    }

    // 3. Parse — Slack delivers interactions form-encoded with a JSON
    //    `payload` field.
    let interaction: z.infer<typeof interactionSchema>;
    try {
      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.includes('application/x-www-form-urlencoded')) {
        throw new Error('wrong content type');
      }
      const payloadStr = new URLSearchParams(rawBody).get('payload');
      if (payloadStr === null) throw new Error('no payload field');
      interaction = interactionSchema.parse(JSON.parse(payloadStr));
    } catch {
      await audit(requestId, 'rejected:slack_malformed_payload', {
        tenantId: null,
        actor: 'slack',
        authMs,
        startedAt,
      });
      json(res, 400, { error: 'slack_malformed_payload', request_id: requestId });
      return;
    }

    const action = interaction.actions[0]!;
    if (action.action_id !== 'approve') {
      // Approve-only by design (PL-207): flag and deny are worth a
      // click-through to the app, where context can be reviewed.
      await audit(requestId, 'rejected:slack_unsupported_action', {
        tenantId: null,
        actor: 'slack',
        authMs,
        startedAt,
      });
      json(res, 400, { error: 'slack_unsupported_action', request_id: requestId });
      return;
    }

    // 4. Tenant — EVERY configured tenant is probed via the membership
    //    function, unconditionally (PL-257). The probe count is the
    //    same for an existent, cross-tenant, nonexistent, or malformed
    //    id, because early-exit is the timing side channel: a found id
    //    used to return after one query while a missing one returned
    //    after a cheap lookup. The response never discloses which
    //    tenant — or whether any — matched (T-66).
    const pickupRequestId = action.value;
    // PL-258: an error thrown in the probe/decision section is an
    // audited `error:slack_internal` plus a generic 500 — never the
    // not-found shape (a 500 that looks like not-found teaches callers
    // to retry an id into a distinguishable fast path), never the
    // error's content (error text is not wire data).
    try {
      const probeId = UUID_PATTERN.test(pickupRequestId)
        ? pickupRequestId
        : '00000000-0000-0000-0000-000000000000';
      let tenantId: string | null = null;
      for (const t of deps.tenantIds) {
        const belongs = await pickupRequestBelongsToTenant(
          deps.appPool,
          probeId,
          t,
        );
        if (belongs && tenantId === null) tenantId = t;
      }

      if (tenantId === null) {
        // The decoy (PL-257): a no-match id still runs the real path's
        // work shape under the first configured tenant — tenant
        // context, the request lookup, the actor lookup, and the
        // boundary audit — so existent and nonexistent ids share a
        // timing distribution, not just a wire response.
        const decoyTenant = deps.tenantIds[0] ?? null;
        if (decoyTenant !== null) {
          await withTenant(deps.appPool, decoyTenant, async (client) => {
            await findPickupRequestById(client, probeId);
            await findStaffIdentityBySlackUserId(
              client,
              interaction.user.id,
            );
          });
        }
        await audit(requestId, 'slack_not_found', {
          tenantId: decoyTenant,
          actor: 'slack',
          authMs,
          startedAt,
        });
        // Byte-identical to every other not-found shape below.
        json(res, 200, { ok: false, error: 'request_not_found', request_id: requestId });
        return;
      }

      // 5. The decision — under the request's tenant, through the actor
      //    mapping (AD-29), with the boundary auditing the outcome. One
      //    transaction for the whole read-check-update (PL-275): the row
      //    lock holds across it, so a concurrent reassignment cannot
      //    land between the check and the UPDATE, and the service's
      //    audit_log rows commit atomically with the decision they
      //    describe.
      const result = await withTenantTransaction(deps.appPool, tenantId, (client) =>
        decidePickupRequestAsSlackActor(client, {
          requestId: pickupRequestId,
          action: 'approve',
          slackUserId: interaction.user.id,
        }),
      );
      const toolMs = performance.now() - startedAt - authMs;

      if (result.ok) {
        replayCache.add(digest, nowMs);
        await audit(requestId, result.idempotent ? 'success:idempotent' : 'success', {
          tenantId,
          actor: 'slack',
          authMs,
          startedAt,
          toolMs,
        });
        deps.logger.info({
          msg: 'slack_interaction',
          tenant_id: tenantId,
          request_id: requestId,
          outcome: result.idempotent ? 'success:idempotent' : 'success',
          total_ms: Math.round(performance.now() - startedAt),
        });
        json(res, 200, { ok: true, request_id: requestId });
        return;
      }

      if (result.code === 'not_found' || result.code === 'unmapped_slack_actor') {
        // T-66: identical wire response whether the request is in
        // another tenant, nonexistent, or the actor is unmapped in the
        // request's tenant. The audit row distinguishes — staff-side.
        await audit(
          requestId,
          result.code === 'unmapped_slack_actor'
            ? 'slack_unmapped_actor'
            : 'slack_not_found',
          { tenantId, actor: 'slack', authMs, startedAt, toolMs },
        );
        json(res, 200, { ok: false, error: 'request_not_found', request_id: requestId });
        return;
      }

      if (result.code === 'not_assigned_approver' || result.code === 'self_approval') {
        // PL-251: reached only by an actor mapped in the request's tenant.
        // "Not your request to decide" is honest for authenticated tenant
        // staff — the T-66 indistinguishability covers actors the tenant
        // does not know at all, not staff told the request isn't theirs.
        await audit(requestId, `slack:${result.code}`, {
          tenantId,
          actor: 'slack',
          authMs,
          startedAt,
          toolMs,
        });
        json(res, 200, {
          ok: false,
          error: result.code,
          request_id: requestId,
        });
        return;
      }

      // illegal_transition — the request was already decided differently.
      // Reached only by an actor mapped in the request's tenant; an
      // approver learning "already decided" is honest, not a leak.
      await audit(requestId, `slack:${result.code}`, {
        tenantId,
        actor: 'slack',
        authMs,
        startedAt,
        toolMs,
      });
      json(res, 200, {
        ok: false,
        error: 'request_already_decided',
        request_id: requestId,
      });
    } catch (err) {
      deps.logger.error({
        msg: 'slack_interaction_failed',
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      // The audit may itself fail if the pool is down — that is logged
      // by audit()'s own catch; the response is generic either way.
      await audit(requestId, 'error:slack_internal', {
        tenantId: null,
        actor: 'slack',
        authMs,
        startedAt,
      });
      json(res, 500, { error: 'internal_error', request_id: requestId });
    }
  };
}
