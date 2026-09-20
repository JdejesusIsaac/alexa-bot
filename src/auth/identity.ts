/**
 * Authenticated identity resolved from token claims (PL-105).
 *
 * The token identifies the caller; the MCP session id identifies the
 * connection (AD-18). This type is derived from the access token on every
 * request and is never cached against a session id.
 *
 * `tenantId` is server-side derived — it is never a tool argument, never
 * configured, and never read from anywhere but the validated token
 * (rule 7).
 */

export type Role = 'staff' | 'admin';

export interface AuthedIdentity {
  /** Token subject — the actor for audit entries. */
  readonly sub: string;
  /** Derived from the configured tenant claim. Never caller-supplied. */
  readonly tenantId: string;
  /** `staff` or `admin` — gates admin-only tools (PL-109, T-39). */
  readonly role: Role;
}

/** Rejection codes for identity resolution from an otherwise-valid token. */
export type IdentityRejectionCode =
  | 'missing_subject'
  | 'missing_tenant_claim'
  | 'invalid_tenant_claim'
  | 'missing_role_claim'
  | 'invalid_role_claim';

export type IdentityResolution =
  { ok: true; identity: AuthedIdentity } | { ok: false; code: IdentityRejectionCode };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLES: readonly Role[] = ['staff', 'admin'];

/**
 * Resolve tenant and role from a verified JWT payload using the configured
 * claim names. Claim names are config-driven (PL-101: AS-agnostic) —
 * whichever AS wins, the claim mapping plugs in here.
 */
export function resolveIdentity(
  payload: Record<string, unknown>,
  claimNames: { tenantClaim: string; roleClaim: string },
): IdentityResolution {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    return { ok: false, code: 'missing_subject' };
  }

  const rawTenant = payload[claimNames.tenantClaim];
  if (rawTenant === undefined) {
    return { ok: false, code: 'missing_tenant_claim' };
  }
  if (typeof rawTenant !== 'string' || !UUID_PATTERN.test(rawTenant)) {
    return { ok: false, code: 'invalid_tenant_claim' };
  }

  const rawRole = payload[claimNames.roleClaim];
  if (rawRole === undefined) {
    return { ok: false, code: 'missing_role_claim' };
  }
  if (typeof rawRole !== 'string' || !ROLES.includes(rawRole as Role)) {
    return { ok: false, code: 'invalid_role_claim' };
  }

  return {
    ok: true,
    identity: { sub, tenantId: rawTenant, role: rawRole as Role },
  };
}
