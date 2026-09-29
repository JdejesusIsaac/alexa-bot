import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { withTenant } from '../../src/db/tenant-context.js';

/**
 * Test database provisioning utility.
 *
 * Creates a uniquely-named database per test run, applies migrations as the
 * owner role, and returns two connection strings: one for the owner (seeding)
 * and one for the non-owner app role (the one RLS is tested against).
 *
 * This is test infrastructure — raw SQL here is correct and necessary. T-01
 * through T-05 must bypass the repository layer to assert database-level
 * behavior. Rule 7 (no tenant_id as argument) still applies.
 */

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'db',
  'migrations',
);

const APP_ROLE = 'parentline_app';
const APP_ROLE_PASSWORD = 'test_password';

export interface TestDb {
  ownerUrl: string;
  appUrl: string;
  dbName: string;
  ownerPool: Pool;
  appPool: Pool;
  cleanup: () => Promise<void>;
}

function parseConnectionString(url: string): {
  protocol: string;
  host: string;
  port: string;
  user: string;
} {
  const parsed = new URL(url);
  return {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port: parsed.port || '5432',
    user: parsed.username,
  };
}

function randomDbName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `parentline_test_${suffix}`;
}

/** Anything with a `.query` — a Pool or a PoolClient. */
type Queryable = Pick<Pool, 'query'>;

export interface AppRolePosture {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassrls: boolean;
  readonly ownsDatabase: boolean;
}

/**
 * The ACTUAL connected role's privilege posture (T-05's discipline:
 * check what connected, not what was intended).
 */
export async function appRolePosture(client: Queryable): Promise<AppRolePosture> {
  const res = await client.query(
    `select current_user as role,
            (select rolsuper from pg_roles where rolname = current_user) as superuser,
            (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls,
            (select pg_database.datdba = (select oid from pg_roles where rolname = current_user)
               from pg_database where datname = current_database()) as "ownsDatabase"`,
  );
  return res.rows[0] as AppRolePosture;
}

/**
 * The suite refuses to run as the owner or a superuser (PL-272, T-85).
 *
 * The isolation gate asserts that RLS holds against `parentline_app`.
 * Run as a superuser or the database owner, RLS is bypassed or
 * removable and those tests prove nothing while reporting green — the
 * exact configuration
 * T-01…T-05 exist to make impossible, which the Sprint 3.1 evaluation
 * ran under without noticing. Not a warning, not a skip: the suite
 * fails at setup, naming the role and the fix.
 */
export async function assertNonPrivilegedAppRole(client: Queryable): Promise<void> {
  const posture = await appRolePosture(client);
  if (!posture.superuser && !posture.bypassrls && !posture.ownsDatabase) return;
  const why = [
    posture.superuser ? 'a superuser' : null,
    posture.bypassrls ? 'BYPASSRLS' : null,
    posture.ownsDatabase ? 'the database owner' : null,
  ]
    .filter((reason) => reason !== null)
    .join(' and ');
  throw new Error(
    `SUITE REFUSAL (T-85): the app connection's current_user is '${posture.role}' — ${why}. ` +
      'Table owners can disable or drop RLS policies and superusers bypass RLS ' +
      'entirely, so the isolation gate would be ' +
      'vacuous while reporting green. Fix: this suite reads DATABASE_URL only and ' +
      'constructs the parentline_app connection itself — recreate parentline_app per ' +
      'the README "Setup" as a plain role (never SUPERUSER or BYPASSRLS) and point ' +
      'DATABASE_URL at the owner role. APP_DATABASE_URL is the production server ' +
      'config, not something this suite reads.',
  );
}

/**
 * Seed the `tenants` table through RLS, not around it (B-12).
 *
 * FORCE ROW LEVEL SECURITY binds the owner too — a superuser-free setup
 * cannot insert a tenant row without the session's `app.tenant_id`
 * matching the row's id, because the policy checks
 * `id = current_setting('app.tenant_id')::uuid`. Each tenant is
 * therefore inserted under its own tenant context, one withTenant per
 * row. Multi-tenant VALUES lists are not expressible this way — that
 * asymmetry is the policy doing its job.
 */
export async function seedTenants(
  ownerPool: Pool,
  tenants: ReadonlyArray<readonly [id: string, name: string]>,
): Promise<void> {
  for (const [id, name] of tenants) {
    await withTenant(ownerPool, id, (client) =>
      client.query(`insert into tenants (id, name) values ($1, $2)`, [id, name]),
    );
  }
}

async function dropTestDatabase(adminUrl: string, dbName: string): Promise<void> {
  const dropClient = new Client({ connectionString: adminUrl });
  await dropClient.connect();
  try {
    await dropClient.query(`drop database if exists ${dbName}`);
  } finally {
    await dropClient.end();
  }
}

async function runMigrationFiles(client: Client): Promise<void> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query(sql);
  }
}

export async function provisionTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_URL must be set for test database provisioning');
  }

  const { protocol, host, port, user } = parseConnectionString(adminUrl);
  const dbName = randomDbName();

  // 1. Connect to the default database as admin and create the test database.
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }

  // Steps 2+3 run under a single guard: any failure after `create
  // database` — migrations, grants, the role check, or the T-85
  // refusal — drops the throwaway database before propagating.
  // Without this, a setup failure leaks a `parentline_test_*` database
  // per file (the B-12 probe run leaked six).
  const ownerUrl = `${protocol}//${user}@${host}:${port}/${dbName}`;
  const appUrl = `${protocol}//${APP_ROLE}:${APP_ROLE_PASSWORD}@${host}:${port}/${dbName}`;
  let ownerPool: Pool | undefined;
  let appPool: Pool | undefined;
  try {
    // 2. Connect to the new database as admin and run migrations.
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await runMigrationFiles(owner);

      // Ensure the app role can connect to this database and has a known
      // password for tests. The owner can always grant CONNECT on a
      // database it just created, so that comes first — the fallback
      // below verifies connectivity against this database.
      await owner.query(`grant connect on database ${dbName} to ${APP_ROLE}`);
      try {
        await owner.query(`alter role ${APP_ROLE} login password '${APP_ROLE_PASSWORD}'`);
      } catch (err) {
        // The app role is cluster-global. On a cluster where a DIFFERENT
        // owner created it (a T-89 probe owner, or a superuser during a
        // manual README setup), this owner has no ADMIN on it and cannot
        // set the password — PG16 createrole semantics, error 42501.
        // The suite's contract is "parentline_app connects unprivileged",
        // not "we reset its password", so verify the documented test
        // password already authenticates instead of mutating the role.
        if ((err as { code?: string }).code !== '42501') throw err;
        const check = new Client({
          connectionString: `${protocol}//${APP_ROLE}:${APP_ROLE_PASSWORD}@${host}:${port}/${dbName}`,
        });
        try {
          await check.connect();
          await check.query('select 1');
        } catch (cause) {
          throw new Error(
            `${APP_ROLE} exists on this cluster but '${user}' cannot set its ` +
              `password (no ADMIN on the role) and '${APP_ROLE_PASSWORD}' does ` +
              `not authenticate. As a superuser, either grant ${APP_ROLE} to ` +
              `${user} or set its password once: ` +
              `alter role ${APP_ROLE} password '${APP_ROLE_PASSWORD}'. ` +
              `Original error: ${(err as Error).message}`,
            { cause },
          );
        } finally {
          await check.end().catch(() => undefined);
        }
      }
    } finally {
      await owner.end();
    }

    // 3. App connection is built explicitly as parentline_app.
    ownerPool = new Pool({ connectionString: ownerUrl });
    appPool = new Pool({ connectionString: appUrl });

    // PL-272 / T-85: refuse to run as the owner or a superuser — at setup,
    // before a single test reports green. The throwaway database is
    // dropped on refusal so a rejected run leaks nothing.
    await assertNonPrivilegedAppRole(appPool);
  } catch (err) {
    await ownerPool?.end().catch(() => undefined);
    await appPool?.end().catch(() => undefined);
    try {
      await dropTestDatabase(adminUrl, dbName);
    } catch (dropErr) {
      // Surface the leak rather than masking the original failure.
      console.error(`teardown of leaked database ${dbName} failed:`, dropErr);
    }
    throw err;
  }

  // Reaching here means the guard's try completed — both pools exist.
  if (!ownerPool || !appPool) {
    throw new Error('unreachable: provisioning completed without pools');
  }

  const cleanup = async (): Promise<void> => {
    await ownerPool.end();
    await appPool.end();
    await dropTestDatabase(adminUrl, dbName);
  };

  return { ownerUrl, appUrl, dbName, ownerPool, appPool, cleanup };
}
