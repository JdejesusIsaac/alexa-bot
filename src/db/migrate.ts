import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import { loadConfig } from '../config.js';

/**
 * Migration runner. Schema tooling, not application code — this is the one
 * file permitted to issue raw SQL outside the repository layer, and the
 * ESLint override is scoped to it by name.
 *
 * Runs as the OWNER role (DATABASE_URL), never the application role. The
 * application role must not own these tables: owners bypass RLS silently,
 * which would make the entire isolation gate vacuous (AD-11, T-05).
 *
 * T-17 requires this to run clean from an empty database with no manual
 * steps, so every migration is applied inside a transaction and recorded.
 */

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

async function migrationFiles(): Promise<string[]> {
  try {
    const entries = await readdir(MIGRATIONS_DIR);
    // Lexicographic order is the apply order, so files are numbered.
    return entries.filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename    text        primary key,
        applied_at  timestamptz not null default now()
      )
    `);

    const done = await client.query<{ filename: string }>(
      'select filename from schema_migrations',
    );
    const alreadyApplied = new Set(done.rows.map((r) => r.filename));

    for (const file of await migrationFiles()) {
      if (alreadyApplied.has(file)) {
        skipped.push(file);
        continue;
      }

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

      // One transaction per migration. A partially applied schema is worse
      // than an unapplied one, especially where RLS policies are concerned:
      // a table created without its policy is a table that leaks.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [
          file,
        ]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(
          `migration ${file} failed and was rolled back: ${(err as Error).message}`,
        );
      }
    }

    return { applied, skipped };
  } finally {
    await client.end();
  }
}

// Entry point when invoked via `npm run migrate`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  migrate()
    .then(({ applied, skipped }) => {
      // Log filenames and counts only. Migration output must never echo row
      // data, and student identifiers must never reach a log line.
      console.log(
        `migrations complete — ${applied.length} applied, ${skipped.length} already present`,
      );
      for (const f of applied) console.log(`  applied  ${f}`);
      if (applied.length === 0 && skipped.length === 0) {
        console.log('  (no migration files yet — PL-002 adds the schema)');
      }
    })
    .catch((err: unknown) => {
      console.error(`migration failed: ${(err as Error).message}`);
      process.exit(1);
    });
}
