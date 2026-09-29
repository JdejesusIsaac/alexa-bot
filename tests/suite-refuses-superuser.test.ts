import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { TestDb } from './helpers/db.js';
import {
  provisionTestDb,
  assertNonPrivilegedAppRole,
} from './helpers/db.js';

/**
 * T-85 — the suite refuses to run as the owner or a superuser (PL-272).
 *
 * The isolation gate asserts that RLS holds against `parentline_app`.
 * Run as a superuser or the database owner, RLS is bypassed and T-01…T-05
 * prove nothing while reporting green — the exact configuration those
 * tests exist to make impossible, and the one the Sprint 3.1 evaluation
 * graded under (the `.env.example` `owner` role did not exist locally, so
 * a superuser stood in). The guard fires at setup, naming the role and
 * the fix. Not a warning, not a skip.
 *
 * Mutation leg: the guard is driven with a deliberately privileged
 * connection — the provisioned database's owner, who is its `datdba` by
 * construction (the `create database` ran as them). A guardless setup
 * has nothing to assert here; this leg exists to prove the guard
 * discriminates. The setup guard itself runs in every provisionTestDb
 * call in the suite — this file's own `beforeAll` passing IS the
 * negative control.
 *
 * Doc honesty leg: `.env.example` must document an owner role the README
 * actually creates — a fresh clone following the docs can run the suite
 * without substituting a superuser.
 */

let db: TestDb;
let ownerRole: string;

beforeAll(async () => {
  // provisionTestDb runs the guard on the app pool first — if the
  // suite were running privileged, this line would throw, not fail.
  db = await provisionTestDb();
  const res = await db.ownerPool.query<{ role: string }>(`select current_user as role`);
  ownerRole = res.rows[0]!.role;
});

afterAll(async () => {
  await db.cleanup();
});

describe('T-85 · the suite refuses to run as the owner or a superuser', () => {
  it('the guard fires on a privileged connection, naming the role and the fix', async () => {
    // The owner of the provisioned database: its datdba by construction.
    // Whether or not the local owner is also a superuser, it owns the
    // database — and an owner can disable or drop the RLS policies.
    await expect(assertNonPrivilegedAppRole(db.ownerPool)).rejects.toThrow(
      /SUITE REFUSAL/,
    );
    await expect(assertNonPrivilegedAppRole(db.ownerPool)).rejects.toThrow(
      new RegExp(ownerRole),
    );
    await expect(assertNonPrivilegedAppRole(db.ownerPool)).rejects.toThrow(
      /database owner/,
    );
    await expect(assertNonPrivilegedAppRole(db.ownerPool)).rejects.toThrow(
      /README/,
    );
  });

  it('the app role passes the guard — the negative control', async () => {
    // parentline_app: not a superuser, no BYPASSRLS, not the datdba.
    // This is the posture every provisioned run must have.
    await expect(assertNonPrivilegedAppRole(db.appPool)).resolves.toBeUndefined();
  });

  it('.env.example documents an owner role the README actually creates — with the grants a fresh clone needs', async () => {
    const envExample = await readFile('.env.example', 'utf-8');
    const readme = await readFile('README.md', 'utf-8');

    const m = envExample.match(/^DATABASE_URL=postgres:\/\/([^:@]+)@/m);
    expect(m).not.toBeNull();
    const documentedOwnerRole = m![1];

    // The README's setup section must carry the CREATE ROLE statement for
    // exactly that role — a fresh clone can create it, so nobody
    // substitutes a superuser to make the docs work. `createrole` is
    // load-bearing: migration 0000 provisions parentline_app AS the
    // owner, and without it the statement fails with "permission denied
    // to create role" (the fresh-clone blocker T-89 proves).
    expect(readme).toContain(
      `create role ${documentedOwnerRole} login createdb createrole`,
    );
  });

  it('T-89 · a fresh clone can follow the README — the documented owner role runs `npm run migrate` end to end (F-2, widened after B-10)', async () => {
    // The grants are parsed from the README, not trusted from it: a
    // probe role is created with EXACTLY what the doc grants, it creates
    // its own database (the `createdb` half — `create database ... owner`
    // would need SET ROLE, which the documented role lacks; B-12), the
    // REAL migration command runs AS the probe, and the isolation gate
    // runs against a probe-owned maintenance connection — the same
    // forced-RLS seeding path every test file's beforeAll takes.
    // Sprint 6's version of this leg proved only that migration
    // 0000's create-role statement ran; the evaluator then ran the
    // actual command and watched 0004 fail with `unrecognized
    // configuration parameter "app.tenant_id"` — its second backfill
    // joins roster_syncs after that table's RLS was re-enabled, which a
    // superuser skips and the README role does not (B-10). A check that
    // stops at one statement is not the fresh-clone path; this leg
    // walks the whole path now.
    const readme = await readFile('README.md', 'utf-8');
    const m = readme.match(/create role (\w+) login ([a-z ]+);/);
    expect(m).not.toBeNull();
    const grants = (m?.[2] ?? '').trim().split(/\s+/).sort();
    expect(grants).toEqual(['createdb', 'createrole']);

    const adminUrl = process.env.DATABASE_URL!;
    const parsed = new URL(adminUrl);
    const hostPort = `${parsed.hostname}:${parsed.port || '5432'}`;
    // The probe's maintenance connection lands on the same database
    // DATABASE_URL points at — it exists by definition, and CONNECT to
    // PUBLIC is a Postgres default grant, not one of the README's.
    const maintDb = parsed.pathname.replace(/^\//, '') || 'postgres';
    const suffix = Math.random().toString(36).slice(2, 10);
    const probeOwner = `pl_fresh_owner_${suffix}`;
    const probeDb = `parentline_fresh_${suffix}`;
    const probeUrl = `postgres://${probeOwner}:probe@${hostPort}/${probeDb}`;
    const probeMaintUrl = `postgres://${probeOwner}:probe@${hostPort}/${maintDb}`;

    const migrationFiles = (await readdir('src/db/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    let probeMaint: Client | undefined;
    try {
      // The probe owner: exactly the README's grants, nothing more.
      await admin.query(
        `create role ${probeOwner} login password 'probe' ${grants.join(' ')}`,
      );

      // The probe creates its own database — the `createdb` half of
      // the README grants, exercised as the probe. `create database
      // ... owner X` would need `SET ROLE X`, which a documented owner
      // does not have — that was the B-12 failure this leg used to hit
      // ("must be able to SET ROLE"). What the probe creates, the probe
      // owns: same coverage, no superuser step.
      probeMaint = new Client({ connectionString: probeMaintUrl });
      await probeMaint.connect();
      await probeMaint.query(`create database ${probeDb}`);

      // `npm run migrate` as the probe owner — the command a fresh
      // clone actually runs. The exported DATABASE_URL wins over
      // `--env-file-if-exists=.env` (Node gives the environment
      // precedence over the file), so this is the real entry point
      // against the probe database.
      const run = spawnSync('npm', ['run', 'migrate', '--silent'], {
        env: { ...process.env, DATABASE_URL: probeUrl },
        encoding: 'utf-8',
        timeout: 120_000,
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(run.status, out).toBe(0);
      expect(out).toContain('migrations complete');
      for (const file of migrationFiles) {
        expect(out, file).toContain(`applied  ${file}`);
      }

      // The recorded state agrees: every migration file is in
      // schema_migrations on the probe database, owned posture and all.
      const probe = new Client({ connectionString: probeUrl });
      await probe.connect();
      try {
        const res = await probe.query<{ filename: string }>(
          `select filename from schema_migrations order by filename`,
        );
        expect(res.rows.map((r) => r.filename)).toEqual(migrationFiles);
      } finally {
        await probe.end();
      }

      // The other half of B-12: the gate suite itself. The evaluator's
      // repro ran the test files under the documented owner and watched
      // four of them die at seeding (`unrecognized configuration
      // parameter "app.tenant_id"` — the owner cannot bypass FORCED
      // RLS). This leg runs the real gate against a maintenance
      // connection owned by the probe: provisionTestDb inside it does
      // `create database` (the probe's CREATEDB), migrates, and seeds —
      // every step a fresh clone performs, nothing more.
      //
      // B-14 (closeout): `test:isolation` also runs
      // isolation-slack-definer.test.ts, which drives a signed POST to
      // /slack/interactions and so calls the SECURITY DEFINER membership
      // function AS THIS PROBE OWNER. Before migration 0011 that function
      // raised `unrecognized configuration parameter "app.tenant_id"`
      // here (a non-superuser owner bound by FORCE RLS), 500-ing every
      // Slack interaction, while the superuser main suite hid it. Running
      // it under the probe is what makes B-14's class visible to CI.
      // --bail=0 so a red leg cannot mask its siblings (the suite's
      // bail:1 exists for the T-05 precondition; here every leg is the
      // evidence — F-12's mutation audit needs both definer legs red,
      // not "first red then skipped").
      const gate = spawnSync('npm', ['run', 'test:isolation', '--silent', '--', '--bail=0'], {
        env: { ...process.env, DATABASE_URL: probeMaintUrl },
        encoding: 'utf-8',
        timeout: 240_000,
      });
      const gateOut = `${gate.stdout}${gate.stderr}`;
      expect(gate.status, gateOut).toBe(0);
      expect(gateOut).toContain('isolation.test.ts');
      // The Slack SECURITY DEFINER path ran under the probe owner (B-14).
      expect(gateOut).toContain('isolation-slack-definer.test.ts');
    } finally {
      // The probe owns its database — only it (or a superuser) can drop
      // it. WITH (FORCE) closes any pooled connections the spawned
      // commands left behind (PG 13+; the README requires 15+).
      if (probeMaint !== undefined) {
        await probeMaint
          .query(`drop database if exists ${probeDb} with (force)`)
          .catch(() => undefined);
        await probeMaint.end().catch(() => undefined);
      }
      await admin
        .query(`drop database if exists ${probeDb} with (force)`)
        .catch(() => undefined);
      await admin.query(`drop role if exists ${probeOwner}`);
      await admin.end();
    }
  });
});
