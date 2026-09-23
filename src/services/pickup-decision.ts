import { type PoolClient } from 'pg';
import {
  findPickupRequestById,
  transitionPickupRequest,
  type TransitionResult,
} from '../repositories/pickup-requests.js';
import { findStudentById } from '../repositories/students.js';
import { findStaffIdentityBySlackUserId } from '../repositories/staff-identities.js';
import { insertAuditEntry } from '../repositories/audit-log.js';

/**
 * Slack-actor decision path (PL-205, AD-29).
 *
 * A Slack actor decides only through `staff_identities`: the inbound
 * `slack_user_id` resolves to the audit subject used everywhere else,
 * and the decision is recorded under THAT subject — never the Slack id
 * (E5: zero decision rows attributable only to a Slack user id; leak
 * vector 17, hard-fail 5).
 *
 * An unmapped actor cannot transition a request: typed refusal
 * `unmapped_slack_actor`, audited, no state change (T-64). A
 * slack_user_id mapped only in another tenant is equally unmapped —
 * RLS scopes the lookup, so the refusal is identical in message and
 * outcome whether the id is foreign or nonexistent.
 *
 * Every call — success, idempotent replay, or refusal — writes exactly
 * one audit entry (the T-16 discipline): the refusal rows carry the
 * raw slack id, because "who tried and failed to act" is exactly what
 * staff need when closing a mapping gap; the decision rows carry the
 * resolved subject.
 *
 * The service accepts a `PoolClient` already scoped to the request's
 * tenant via `withTenant` — the Slack endpoint (PL-207) derives the
 * tenant from the request, never the caller.
 */

/** The decision actions reachable from Slack. PL-207 wires approve only. */
export type SlackDecisionAction = 'approve' | 'flag' | 'deny';

export type SlackDecisionResult =
  | TransitionResult
  | {
      ok: false;
      code: 'unmapped_slack_actor';
      from: string | null;
      action: SlackDecisionAction;
    };

export async function decidePickupRequestAsSlackActor(
  client: PoolClient,
  params: {
    requestId: string;
    action: SlackDecisionAction;
    slackUserId: string;
  },
): Promise<SlackDecisionResult> {
  const request = await findPickupRequestById(client, params.requestId);
  if (request === null) {
    // Indistinguishable from a nonexistent id — same typed refusal
    // whether the request is in another tenant or nowhere (T-66's
    // discipline, ahead of the endpoint that needs it).
    await insertAuditEntry(client, {
      actor: params.slackUserId,
      action: 'decidePickupRequest',
      subjectStudentRef: null,
      fieldsDisclosed: [],
      outcome: 'refusal:not_found',
    });
    return { ok: false, code: 'not_found', from: null, action: params.action };
  }

  // The scholar's ref, so a refusal row names whose request was blocked —
  // diagnosable, not decorative.
  const student = await findStudentById(client, request.student_id);
  const studentRef = student?.student_ref ?? null;

  const identity = await findStaffIdentityBySlackUserId(client, params.slackUserId);
  if (identity === null) {
    await insertAuditEntry(client, {
      actor: params.slackUserId,
      action: 'decidePickupRequest',
      subjectStudentRef: studentRef,
      fieldsDisclosed: [],
      outcome: 'refusal:unmapped_slack_actor',
    });
    return {
      ok: false,
      code: 'unmapped_slack_actor',
      from: request.state,
      action: params.action,
    };
  }

  // Mapped: the decision proceeds under the audit subject — AD-29.
  const result = await transitionPickupRequest(client, {
    requestId: params.requestId,
    action: params.action,
    actor: identity.subject,
    channel: 'slack',
  });

  await insertAuditEntry(client, {
    actor: identity.subject,
    action: 'decidePickupRequest',
    subjectStudentRef: studentRef,
    fieldsDisclosed: [],
    outcome: result.ok
      ? result.idempotent
        ? 'success:idempotent'
        : 'success'
      : `refusal:${result.code}`,
  });

  return result;
}
