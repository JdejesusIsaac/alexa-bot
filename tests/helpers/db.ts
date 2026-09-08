import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client, Pool } from 'pg';

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

  // 2. Connect to the new database as admin and run migrations.
  const ownerUrl = `${protocol}//${user}@${host}:${port}/${dbName}`;
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await runMigrationFiles(owner);

    // Ensure the app role can connect to this database and has a known
    // password for tests.
    await owner.query(
      `alter role ${APP_ROLE} login password '${APP_ROLE_PASSWORD}'`,
    );
    await owner.query(`grant connect on database ${dbName} to ${APP_ROLE}`);
  } finally {
    await owner.end();
  }

  // 3. Build the app connection string — explicitly as parentline_app.
  const appUrl = `${protocol}//${APP_ROLE}:${APP_ROLE_PASSWORD}@${host}:${port}/${dbName}`;

  const ownerPool = new Pool({ connectionString: ownerUrl });
  const appPool = new Pool({ connectionString: appUrl });

  const cleanup = async (): Promise<void> => {
    await ownerPool.end();
    await appPool.end();

    const dropClient = new Client({ connectionString: adminUrl });
    await dropClient.connect();
    try {
      await dropClient.query(`drop database if exists ${dbName}`);
    } finally {
      await dropClient.end();
    }
  };

  return { ownerUrl, appUrl, dbName, ownerPool, appPool, cleanup };
}
