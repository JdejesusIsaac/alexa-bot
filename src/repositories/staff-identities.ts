import { type PoolClient } from 'pg';

/**
 * Staff identities repository (PL-205) — the Slack actor maps to the
 * audit subject (AD-29).
 *
 * An inbound `slack_user_id` resolves here to the SAME audit subject the
 * auth layer mints from a verified token. Without a mapping, the actor
 * cannot transition a request — a typed, audited refusal (E5: zero
 * decision rows attributable only to a Slack user id).
 *
 * One human may hold more than one Slack account: several slack_user_ids
 * may map to the same subject, and every one of them audits as that
 * subject. The reverse never happens — one slack_user_id maps to at most
 * one subject per tenant (`unique (tenant_id, slack_user_id)`).
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in the INSERT (Rule 7).
 */

export type StaffRole = 'staff' | 'admin';

export interface StaffIdentity {
  id: string;
  tenant_id: string;
  slack_user_id: string;
  subject: string;
  role: StaffRole;
  created_at: Date;
}

/**
 * Register a staff identity. `id` may be supplied so approver config
 * (routing rules, request assignments) can reference a known identity —
 * otherwise one is generated.
 */
export async function insertStaffIdentity(
  client: PoolClient,
  params: {
    slackUserId: string;
    subject: string;
    role: StaffRole;
    id?: string;
  },
): Promise<StaffIdentity> {
  const res = await client.query<StaffIdentity>(
    `insert into staff_identities (id, tenant_id, slack_user_id, subject, role)
     values (coalesce($1, gen_random_uuid()), current_setting('app.tenant_id')::uuid, $2, $3, $4)
     returning *`,
    [params.id ?? null, params.slackUserId, params.subject, params.role],
  );
  return res.rows[0]!;
}

/**
 * Resolve an inbound Slack actor within the current tenant context. A
 * slack_user_id mapped only in another tenant — or not at all — is
 * simply not found here (RLS); the caller refuses, never guesses.
 */
export async function findStaffIdentityBySlackUserId(
  client: PoolClient,
  slackUserId: string,
): Promise<StaffIdentity | null> {
  const res = await client.query<StaffIdentity>(
    `select * from staff_identities where slack_user_id = $1`,
    [slackUserId],
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Find a staff identity by id within the current tenant context — the
 * assigned approver of a pickup request (PL-206 notifications).
 */
export async function findStaffIdentityById(
  client: PoolClient,
  identityId: string,
): Promise<StaffIdentity | null> {
  const res = await client.query<StaffIdentity>(
    `select * from staff_identities where id = $1`,
    [identityId],
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}
