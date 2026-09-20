import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://owner@localhost:5432/parentline',
  RESOURCE_URL: 'https://parentline.example.org',
  AS_ISSUER: 'https://auth.example.org',
  AS_JWKS_URL: 'https://auth.example.org/.well-known/jwks.json',
  EXPECTED_AUDIENCE: 'https://parentline.example.org',
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.rosterFreshnessMinutes).toBe(45);
    expect(cfg.logLevel).toBe('info');
  });

  it('rejects a missing database url rather than guessing one', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('rejects a malformed database url', () => {
    expect(() => loadConfig({ DATABASE_URL: 'not-a-url' })).toThrow(ConfigError);
  });

  it('never echoes configuration values in the error message', () => {
    // A connection string carries credentials. Validation errors name the
    // field and nothing else.
    const secret = 'postgres://user:sup3rs3cret@localhost:5432/db';
    try {
      loadConfig({ DATABASE_URL: secret, ROSTER_FRESHNESS_MINUTES: 'nonsense' });
      expect.unreachable('expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain('sup3rs3cret');
      expect((err as Error).message).toContain('ROSTER_FRESHNESS_MINUTES');
    }
  });

  it('requires a separate application role in production', () => {
    // Owners bypass RLS silently. If the app connects as the owner, every
    // isolation test passes and production leaks — so this is fatal, not a
    // warning.
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /APP_DATABASE_URL is required in production/,
    );
  });

  it('accepts a distinct application role in production', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      APP_DATABASE_URL: 'postgres://app@localhost:5432/parentline',
    });
    expect(cfg.appDatabaseUrl).not.toBe(cfg.databaseUrl);
  });

  it('falls back to the owner url only outside production', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'test' });
    expect(cfg.appDatabaseUrl).toBe(cfg.databaseUrl);
  });

  it('returns a frozen object so config cannot drift at runtime', () => {
    const cfg = loadConfig({ ...base });
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('exposes no tenant setting — tenant_id is session-derived, never configured', () => {
    const cfg = loadConfig({ ...base, TENANT_ID: 'some-campus' });
    expect(Object.keys(cfg)).not.toContain('tenantId');
    expect(JSON.stringify(cfg)).not.toContain('some-campus');
  });

  it('defaults the audience to the resource URL in development (PL-103)', () => {
    const { EXPECTED_AUDIENCE: _omit, ...withoutAudience } = base;
    const cfg = loadConfig({ ...withoutAudience });
    expect(cfg.expectedAudience).toBe(cfg.resourceUrl);
  });

  it('requires an explicit audience in production — token passthrough has no safe default', () => {
    const { EXPECTED_AUDIENCE: _omit, ...withoutAudience } = base;
    expect(() =>
      loadConfig({
        ...withoutAudience,
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgres://app@localhost:5432/parentline',
      }),
    ).toThrow(/EXPECTED_AUDIENCE is required in production/);
  });

  it('normalizes a trailing slash off the resource URL (PRM stability, T-30)', () => {
    const cfg = loadConfig({ ...base, RESOURCE_URL: 'https://parentline.example.org/' });
    expect(cfg.resourceUrl).toBe('https://parentline.example.org');
  });

  it('parses allowed origins into a frozen, trimmed list (T-49)', () => {
    const cfg = loadConfig({
      ...base,
      ALLOWED_ORIGINS: 'https://a.example, https://b.example ,',
    });
    expect(cfg.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(Object.isFrozen(cfg.allowedOrigins)).toBe(true);
  });
});
