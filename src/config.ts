import { z } from 'zod';

/**
 * Environment configuration, validated at the boundary.
 *
 * Two things here are deliberate:
 *
 * 1. There is no `TENANT_ID` and there never will be. `tenant_id` is
 *    derived from the authenticated session, never configured, never
 *    passed in (rule 7).
 *
 * 2. Two database URLs. Migrations run as an owner role; the application
 *    connects as a NON-owner, NON-superuser role. Table owners bypass RLS
 *    silently, so collapsing these into one connection string would make
 *    the entire isolation gate vacuous (AD-11, T-05).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Owner/admin connection. Runs migrations. Never serves requests. */
  DATABASE_URL: z.string().url(),

  /**
   * Application connection — non-owner, non-superuser. Serves every read.
   * Falls back to DATABASE_URL only outside production, where the suite
   * provisions the restricted role itself; T-05 still refuses to run if
   * the effective role can bypass RLS.
   */
  APP_DATABASE_URL: z.string().url().optional(),

  /** Minutes before a roster is considered stale and reads refuse. */
  ROSTER_FRESHNESS_MINUTES: z.coerce.number().int().positive().default(45),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Google service account JSON for the Sheets connector (PL-005). Optional — connector is dormant until provided. */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  /** Default roster sheet ID for scheduled sync (PL-007). Optional until sheets are configured. */
  ROSTER_SHEET_ID: z.string().optional(),

  // ── MCP server (Sprint 2) ─────────────────────────────────────────────

  /** Bind host for the MCP HTTP server. Default loopback-only. */
  MCP_HOST: z.string().default('127.0.0.1'),

  /** Bind port for the MCP HTTP server. */
  MCP_PORT: z.coerce.number().int().positive().default(8420),

  /**
   * Canonical external URL of this server (RFC 8707 resource identifier).
   * Used to build PRM/metadata URLs. Deliberately NOT derived from request
   * headers — an untrusted client must not shape what we advertise (T-30).
   * Defaults for local development; required in production.
   */
  RESOURCE_URL: z.string().url().default('http://127.0.0.1:8420'),

  /**
   * Expected access-token issuer (the AS). AS-agnostic by design (PL-101):
   * the validation chain is standard OAuth 2.1 resource-server behavior;
   * whichever AS wins PL-101 plugs in here. Placeholder default for local
   * development; required in production.
   */
  AS_ISSUER: z.string().url().default('http://127.0.0.1:8420/as'),

  /**
   * JWKS endpoint of the authorization server. Fetched and cached
   * (PL-103). Placeholder default for local development; required in
   * production.
   */
  AS_JWKS_URL: z.string().url().default('http://127.0.0.1:8420/as/jwks.json'),

  /**
   * Audience this resource requires. A token that does not carry it is
   * rejected even with valid signature, issuer, and expiry (T-28) —
   * audience is what blocks token passthrough. Defaults to the resource
   * URL; required in production.
   */
  EXPECTED_AUDIENCE: z.string().min(1).optional(),

  /**
   * Authorization-server endpoints advertised in our mirrored AS metadata
   * document (PL-104, T-31). Defaults follow the common `/oauth2/…` shape;
   * set explicitly for an AS that differs. Served by us for discovery —
   * `authorization_servers` in the PRM points at the real AS.
   */
  AS_AUTHORIZATION_ENDPOINT: z.string().url().optional(),
  AS_TOKEN_ENDPOINT: z.string().url().optional(),

  /** Token claim carrying the caller's tenant. Never a tool argument (rule 7). */
  TENANT_CLAIM: z.string().min(1).default('tenant_id'),

  /** Token claim carrying the caller's role (`staff` / `admin`). */
  ROLE_CLAIM: z.string().min(1).default('role'),

  /**
   * Explicit, small clock-skew tolerance for token expiry (T-27). A tolerance
   * that is incidental is a silent security knob; this one is deliberate.
   */
  CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

  /**
   * Allowed `Origin` values (comma-separated), for DNS-rebinding protection
   * (T-49). A request carrying an `Origin` NOT in this list is rejected;
   * requests without an `Origin` (non-browser clients) are allowed.
   */
  ALLOWED_ORIGINS: z.string().default(''),

  /** Idle-session TTL for `Mcp-Session-Id` (PL-113). */
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
});

export type Config = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  appDatabaseUrl: string;
  rosterFreshnessMinutes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  googleServiceAccountJson: string | undefined;
  rosterSheetId: string | undefined;
  mcpHost: string;
  mcpPort: number;
  resourceUrl: string;
  asIssuer: string;
  asJwksUrl: string;
  asAuthorizationEndpoint: string;
  asTokenEndpoint: string;
  expectedAudience: string;
  tenantClaim: string;
  roleClaim: string;
  clockSkewSeconds: number;
  allowedOrigins: readonly string[];
  sessionTtlMinutes: number;
}>;

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    // Report every problem at once. Field names only — never values, since
    // a connection string carries credentials.
    const fields = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid environment configuration — ${fields}`);
  }

  const raw = parsed.data;

  if (raw.NODE_ENV === 'production' && raw.APP_DATABASE_URL === undefined) {
    throw new ConfigError(
      'APP_DATABASE_URL is required in production: the application must not connect as the table owner, because owners bypass RLS silently',
    );
  }

  if (raw.NODE_ENV === 'production') {
    const requiredAuth = [
      'RESOURCE_URL',
      'AS_ISSUER',
      'AS_JWKS_URL',
      'EXPECTED_AUDIENCE',
    ] as const;
    const missing = requiredAuth.filter((field) => env[field] === undefined);
    if (missing.length > 0) {
      // The dev defaults are placeholders; production must pin the real
      // resource identity and authorization server explicitly.
      throw new ConfigError(
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required in production: token validation has no safe default`,
      );
    }
  }

  const resourceUrl = raw.RESOURCE_URL.replace(/\/$/, '');

  return Object.freeze({
    nodeEnv: raw.NODE_ENV,
    databaseUrl: raw.DATABASE_URL,
    appDatabaseUrl: raw.APP_DATABASE_URL ?? raw.DATABASE_URL,
    rosterFreshnessMinutes: raw.ROSTER_FRESHNESS_MINUTES,
    logLevel: raw.LOG_LEVEL,
    googleServiceAccountJson: raw.GOOGLE_SERVICE_ACCOUNT_JSON,
    rosterSheetId: raw.ROSTER_SHEET_ID,
    mcpHost: raw.MCP_HOST,
    mcpPort: raw.MCP_PORT,
    resourceUrl,
    asIssuer: raw.AS_ISSUER,
    asJwksUrl: raw.AS_JWKS_URL,
    asAuthorizationEndpoint:
      raw.AS_AUTHORIZATION_ENDPOINT ?? `${raw.AS_ISSUER}/oauth2/authorize`,
    asTokenEndpoint: raw.AS_TOKEN_ENDPOINT ?? `${raw.AS_ISSUER}/oauth2/token`,
    expectedAudience: raw.EXPECTED_AUDIENCE ?? resourceUrl,
    tenantClaim: raw.TENANT_CLAIM,
    roleClaim: raw.ROLE_CLAIM,
    clockSkewSeconds: raw.CLOCK_SKEW_SECONDS,
    allowedOrigins: Object.freeze(
      raw.ALLOWED_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
    sessionTtlMinutes: raw.SESSION_TTL_MINUTES,
  });
}
