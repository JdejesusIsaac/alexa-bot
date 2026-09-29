import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { provisionTestDb, type TestDb } from './helpers/db.js';

/**
 * T-86 — `scripts/preflight.sh` is the receipt (PL-273).
 *
 * The evaluation contract requires the script's output verbatim in the
 * report; a report without it is incomplete regardless of score. So the
 * script's own contract is pinned here:
 *
 * - four sections, printed regardless of earlier failures (a receipt,
 *   not a gate that stops early);
 * - absent env is a reported failed item, never a crash — and it proves
 *   the script does not source `.env`: run with the variables scrubbed,
 *   a sourcing script would find them anyway and never print NOT SET;
 * - exit non-zero iff an item failed.
 *
 * Leg B runs against the suite's own provisioned database — it passes
 * DATABASE_URL/APP_DATABASE_URL explicitly (F-9: the receipt's posture
 * item must not depend on the operator having exported the production
 * variable). It asserts exit 0: hooks 11/11 and an unprivileged app
 * role. Leg A scrubs the variables and asserts the failure is
 * reported, not crashed.
 *
 * PREFLIGHT_SKIP_VERIFY=1 is the documented self-test mode (T-86 must
 * not re-run the suite from inside the suite); it prints as skipped.
 */

const SECTIONS = [
  '--- 1. Phase state ---',
  '--- 2. verify-hooks.sh',
  '--- 3. Database posture ---',
  '--- 4. npm run verify ---',
];

/**
 * F-9 — the legs asserting a passing receipt provide their own database
 * environment. The suite contract (T-85) is `DATABASE_URL` only: the
 * app connection is constructed, so `APP_DATABASE_URL` — the production
 * server config — is not a shell prerequisite. Each spawned run gets
 * the provisioned owner/app URLs, so the posture item still runs for
 * real and the exit code reflects the item under test.
 */
let receiptDb: TestDb | undefined;

beforeAll(async () => {
  receiptDb = await provisionTestDb();
});

afterAll(async () => {
  await receiptDb?.cleanup();
});

function receiptEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: receiptDb!.ownerUrl,
    APP_DATABASE_URL: receiptDb!.appUrl,
    ...extra,
  };
}

function runPreflight(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', ['scripts/preflight.sh'], {
    env: { ...env, PREFLIGHT_SKIP_VERIFY: '1' },
    encoding: 'utf-8',
  });
}

describe('T-86 · preflight.sh is the receipt', () => {
  it('absent env is a reported failed item, never a crash — and no .env is sourced', () => {
    const scrubbed = { ...process.env };
    delete scrubbed.DATABASE_URL;
    delete scrubbed.APP_DATABASE_URL;

    const run = runPreflight(scrubbed);
    const out = `${run.stdout}${run.stderr}`;

    // Every section still printed — a receipt, not an early exit.
    for (const section of SECTIONS) {
      expect(out).toContain(section);
    }
    // The absent variables are named as failed items. This also proves
    // the script never sourced .env: a sourcing script would have
    // found DATABASE_URL there and printed a role instead.
    expect(out).toContain('DATABASE_URL: NOT SET');
    expect(out).toContain('APP_DATABASE_URL: NOT SET');
    expect(out).toContain('preflight: FAIL');
    expect(run.status).toBe(1); // failed item — not a signal, not a crash
  });

  it('with the exported environment the receipt passes: hooks 11/11, app role unprivileged', async () => {
    // Since T-91 the receipt binds its phase check to the running
    // conversation and requires `evaluation` — a pass inside a
    // generator conversation would be the F-7 hole again. This leg pins
    // a planted evaluation phase file (PREFLIGHT_TRAJECTORY_ID) so the
    // pass it asserts is the receipt's mechanics, whichever phase the
    // suite is running under.
    const probe = '.windsurf/state/phase.pl-t86-probe';
    await writeFile(probe, 'evaluation\n');
    try {
      const run = runPreflight(
        receiptEnv({ PREFLIGHT_TRAJECTORY_ID: 'pl-t86-probe' }),
      );
      const out = `${run.stdout}${run.stderr}`;

      for (const section of SECTIONS) {
        expect(out).toContain(section);
      }
      expect(out).toContain('phase binding: PASS');
      expect(out).toContain('11 passed, 0 failed');
      // The app role's posture, printed — not assumed.
      expect(out).toMatch(/APP_DATABASE_URL: current_user=\S+ superuser=false/);
      expect(out).toContain('verify: skipped (self-test mode');
      expect(out).toContain('preflight: PASS');
      expect(run.status).toBe(0);
    } finally {
      await rm(probe, { force: true });
    }
  });
});

// ── T-90: the phase item is asserted, not just printed ────────────────

/**
 * T-90 (PL-284) — preflight ASSERTS phase.
 *
 * The receipt's first section used to print the harness's phase state
 * and assert nothing: a receipt could show a foreign conversation's
 * `implementation` (the phase.ubiquitous-headstand observation) with no
 * assertion and no attribution. Now no phase state at all is a failed
 * item, an invalid phase value is a failed item naming its file, and
 * PREFLIGHT_TRAJECTORY_ID pins the running conversation's own phase.
 *
 * All legs run against a temp PREFLIGHT_STATE_DIR — hermetic, the
 * PREFLIGHT_SKIP_VERIFY precedent. The DB env is scrubbed so the
 * assertions target the phase item's own lines (the overall exit is
 * still 1 from the absent DB variables, which the first T-86 leg
 * already covers).
 */
describe('T-90 · preflight asserts phase', () => {
  let stateDir: string | undefined;

  async function freshStateDir(): Promise<string> {
    if (stateDir !== undefined) {
      await rm(stateDir, { recursive: true, force: true });
    }
    stateDir = await mkdtemp(path.join(tmpdir(), 'preflight-phase-'));
    return stateDir;
  }

  function runWithStateDir(dir: string, extra: NodeJS.ProcessEnv = {}) {
    const scrubbed = { ...process.env };
    delete scrubbed.DATABASE_URL;
    delete scrubbed.APP_DATABASE_URL;
    return spawnSync('bash', ['scripts/preflight.sh'], {
      env: {
        ...scrubbed,
        PREFLIGHT_SKIP_VERIFY: '1',
        PREFLIGHT_STATE_DIR: dir,
        ...extra,
      },
      encoding: 'utf-8',
    });
  }

  it('no phase state at all is a failed item — the receipt attests something', async () => {
    const dir = await freshStateDir();
    try {
      const run = runWithStateDir(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('phase state: NONE — failed item');
      expect(out).toContain('preflight: FAIL');
      expect(run.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('planted phase files are listed with contents — the global file labeled informational, never satisfying', async () => {
    const dir = await freshStateDir();
    try {
      await writeFile(path.join(dir, 'phase'), 'implementation\n');
      await writeFile(path.join(dir, 'phase.probe-convo'), 'evaluation\n');

      const run = runWithStateDir(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('global phase file: implementation (informational only');
      expect(out).toContain('phase.probe-convo: evaluation');
      // The single per-conversation file resolves as this conversation.
      expect(out).toContain('resolved conversation: probe-convo');
      expect(out).toContain('phase binding: PASS');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an invalid phase value is a failed item naming its file', async () => {
    const dir = await freshStateDir();
    try {
      await writeFile(path.join(dir, 'phase'), 'evaluation\n');
      await writeFile(path.join(dir, 'phase.probe-convo'), 'implementing\n');

      const run = runWithStateDir(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain(
        "phase.probe-convo: INVALID VALUE 'implementing' — failed item",
      );
      expect(out).toContain('preflight: FAIL');
      expect(run.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('PREFLIGHT_TRAJECTORY_ID pins the running conversation — labeled when present, a failed item when missing', async () => {
    const dir = await freshStateDir();
    try {
      await writeFile(path.join(dir, 'phase.probe-convo'), 'evaluation\n');

      const present = runWithStateDir(dir, {
        PREFLIGHT_TRAJECTORY_ID: 'probe-convo',
      });
      const out = `${present.stdout}${present.stderr}`;
      expect(out).toContain(
        "this conversation's phase (probe-convo): evaluation",
      );

      const missing = runWithStateDir(dir, {
        PREFLIGHT_TRAJECTORY_ID: 'probe-other',
      });
      const missingOut = `${missing.stdout}${missing.stderr}`;
      expect(missingOut).toContain(
        'no phase file for conversation probe-other — failed item',
      );
      expect(missing.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── T-91: the phase check is BOUND — this conversation must be evaluation ──

/**
 * T-91 — the receipt fails unless THIS conversation is in the
 * evaluation phase (the F-7 close, after the Sprint 6 receipt passed on
 * three foreign `implementation` files).
 *
 * Resolution order under test: PREFLIGHT_TRAJECTORY_ID pin → the
 * isolation hook's `last-trajectory` marker → a single phase.* file →
 * unresolvable (multiple files pass only when one reads `evaluation`,
 * printed UNBOUND; none reading it is a fail). The global `phase` file
 * is informational and can never satisfy.
 *
 * These legs run with the provisioned receipt environment (database
 * posture and hooks still run — they pass here) so the exit code
 * reflects the phase item alone: plant `evaluation` → exit 0; plant
 * `implementation` → exit 1.
 * Each failure classifies itself: WRONG PHASE (the fix is the
 * conversation) vs ISOLATION HOOK BROKEN (the fix is the machinery).
 */
describe('T-91 · the receipt is bound to an evaluation conversation', () => {
  let stateDir: string | undefined;

  async function freshDir(): Promise<string> {
    if (stateDir !== undefined) {
      await rm(stateDir, { recursive: true, force: true });
    }
    stateDir = await mkdtemp(path.join(tmpdir(), 'preflight-bind-'));
    return stateDir;
  }

  function runBound(dir: string, extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', ['scripts/preflight.sh'], {
      env: receiptEnv({
        PREFLIGHT_SKIP_VERIFY: '1',
        PREFLIGHT_STATE_DIR: dir,
        ...extra,
      }),
      encoding: 'utf-8',
    });
  }

  it('a resolved evaluation phase passes — exit 0', async () => {
    const dir = await freshDir();
    try {
      await writeFile(path.join(dir, 'phase.probe-eval'), 'evaluation\n');
      const run = runBound(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('resolved conversation: probe-eval');
      expect(out).toContain('phase binding: PASS');
      expect(out).toContain('preflight: PASS');
      expect(run.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a resolved implementation phase fails — WRONG PHASE, exit 1', async () => {
    const dir = await freshDir();
    try {
      await writeFile(path.join(dir, 'phase.probe-impl'), 'implementation\n');
      const run = runBound(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain("this conversation's phase: 'implementation' — not evaluation");
      expect(out).toContain('phase: WRONG PHASE');
      expect(out).toContain('preflight: FAIL');
      expect(run.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the global file alone never satisfies — no per-conversation state is ISOLATION HOOK BROKEN', async () => {
    const dir = await freshDir();
    try {
      // A legacy global `evaluation` file with zero phase.* files: the
      // Sprint 3.1 shape that let an unphased conversation pose. The
      // receipt must fail — a global file is only informational now.
      await writeFile(path.join(dir, 'phase'), 'evaluation\n');
      const run = runBound(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('phase state: NONE — failed item');
      expect(out).toContain('phase: ISOLATION HOOK BROKEN');
      expect(run.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the hook marker binds this conversation — marker to a phaseless id is WRONG PHASE (unphased)', async () => {
    const dir = await freshDir();
    try {
      // The isolation hook wrote the marker (it is running) but no
      // phase.<tid> exists — this conversation never declared a phase.
      await writeFile(path.join(dir, 'last-trajectory'), 'unphased-convo\n');
      await writeFile(path.join(dir, 'phase.other'), 'implementation\n');
      const run = runBound(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('resolved conversation: unphased-convo (isolation hook marker');
      expect(out).toContain('no phase file for conversation unphased-convo');
      expect(out).toContain('phase: WRONG PHASE');
      expect(run.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('multiple phase files, none evaluation, nothing bound — a failure', async () => {
    const dir = await freshDir();
    try {
      await writeFile(path.join(dir, 'phase.alpha'), 'implementation\n');
      await writeFile(path.join(dir, 'phase.beta'), 'implementation\n');
      const run = runBound(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('none reads evaluation');
      expect(out).toContain('preflight: FAIL');
      expect(run.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('multiple phase files with one evaluation and nothing bound — UNBOUND pass, labeled', async () => {
    const dir = await freshDir();
    try {
      await writeFile(path.join(dir, 'phase.alpha'), 'implementation\n');
      await writeFile(path.join(dir, 'phase.beta'), 'evaluation\n');
      const run = runBound(dir);
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('phase binding: UNBOUND PASS');
      expect(run.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
