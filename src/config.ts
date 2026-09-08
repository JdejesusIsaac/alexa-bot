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
});

export type Config = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  appDatabaseUrl: string;
  rosterFreshnessMinutes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  googleServiceAccountJson: string | undefined;
  rosterSheetId: string | undefined;
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

  return Object.freeze({
    nodeEnv: raw.NODE_ENV,
    databaseUrl: raw.DATABASE_URL,
    appDatabaseUrl: raw.APP_DATABASE_URL ?? raw.DATABASE_URL,
    rosterFreshnessMinutes: raw.ROSTER_FRESHNESS_MINUTES,
    logLevel: raw.LOG_LEVEL,
    googleServiceAccountJson: raw.GOOGLE_SERVICE_ACCOUNT_JSON,
    rosterSheetId: raw.ROSTER_SHEET_ID,
  });
}
