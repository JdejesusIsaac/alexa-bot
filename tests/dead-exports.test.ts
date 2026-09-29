import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-88 — `npm run verify` is green and able to fail (PL-277, PL-278,
 * PL-285).
 *
 * Four legs, one per thing the sprints had to prove:
 *
 * 1. The dead-export check discriminates — the PL-206 mutation. A
 *    planted export with no caller fails the check; this is the exact
 *    shape (`sendPickupNotifications`, no caller, marked ✅) the check
 *    exists to catch at commit.
 * 2. The check passes against the real src/ tree.
 * 3. A repository export whose only caller is a TEST fails the check —
 *    the PL-285 regression: the old src/repositories/ exemption let
 *    exactly this shape through, one directory deep from the PL-206
 *    catch. The eight legitimate test-surface exports carry written
 *    JUSTIFIED entries instead; anything new must find a src/ caller.
 * 4. The Rule-7 fix (B-5) did not weaken the rule — the disable on
 *    `pickupRequestBelongsToTenant` is line-scoped and justified, and a
 *    planted `tenantId` parameter anywhere else in the repository layer
 *    still fails lint. The mutation is run, not assumed.
 *
 * The full `npm run verify` (typecheck + lint + dead-export + suite) is
 * the run-level gate recorded in progress.md per task; this file pins
 * the pieces that must be able to FAIL.
 */

describe('T-88 · verify is green and able to fail', () => {
  let tmp: string | undefined;

  afterAll(async () => {
    // Guarded: `tmp` is set only by the first leg. A filtered run that
    // skips that leg (e.g. `-t "B-15"`) must not fail cleanup on an
    // undefined path — a false red under filtering is the F-5/PL-288
    // class. Every other leg provisions and cleans its own dir.
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  });

  it('the dead-export check fails on a planted dead export (the PL-206 mutation)', async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'dead-export-'));
    await mkdir(path.join(tmp, 'services'), { recursive: true });
    // A service-layer function with no caller anywhere — the hallway,
    // not the wiring. The check must fail on exactly this shape.
    await writeFile(
      path.join(tmp, 'services', 'planted.ts'),
      'export async function neverCalledByAnyone(x: string): Promise<string> {\n  return x;\n}\n',
      'utf-8',
    );

    const check = spawnSync('node', [
      'scripts/check-dead-exports.mjs',
      '--root',
      tmp,
    ]);
    const out = `${check.stdout}${check.stderr}`;
    expect(check.status).toBe(1);
    expect(out).toContain('DEAD EXPORTS');
    expect(out).toContain('neverCalledByAnyone');
  });

  it('the dead-export check passes against the real src/ tree', () => {
    const check = spawnSync('node', ['scripts/check-dead-exports.mjs']);
    expect(check.status).toBe(0);
    expect(String(check.stdout)).toContain('dead-export check: clean');
  });

  it('a member-access collision does not keep an export alive — planted `release` (F-6)', async () => {
    // The evaluator's probe: an export named `release` with no callers
    // used to pass, because the bare-name regex counted
    // `client.release()` — a property on an unrelated object — as a
    // caller. References are member-access/property-key aware now.
    const dir = await mkdtemp(path.join(tmpdir(), 'dead-export-release-'));
    try {
      await writeFile(
        path.join(dir, 'pool.ts'),
        'export function release(): void {}\n',
        'utf-8',
      );
      // Only member access — a property on some other object, never a
      // call or read of THIS module's binding. (No exports of its own:
      // an exported helper would itself be dead.)
      await writeFile(
        path.join(dir, 'user.ts'),
        'function detach(client: { release: () => void }): void {\n  client.release();\n}\nvoid detach;\n',
        'utf-8',
      );

      const dead = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const deadOut = `${dead.stdout}${dead.stderr}`;
      expect(dead.status).toBe(1);
      expect(deadOut).toContain('DEAD EXPORTS');
      expect(deadOut).toContain('release');

      // The other half of discrimination: a caller of the actual
      // binding (import + bare call) keeps the same export alive.
      await writeFile(
        path.join(dir, 'caller.ts'),
        "import { release } from './pool.js';\nfunction done(): void {\n  release();\n}\nvoid done;\n",
        'utf-8',
      );
      const alive = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const aliveOut = `${alive.stdout}${alive.stderr}`;
      expect(alive.status).toBe(0);
      expect(aliveOut).toContain('dead-export check: clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a string-literal collision does not keep an export alive — `case` labels and enum values (B-13)', async () => {
    // The evaluator's second probe on the same seam: F-6 fixed member
    // access, but `['"\`]name['"\`]` still counted ANY quoted occurrence —
    // so `case 'release':` or `z.enum(['release', …])` in src/ kept a
    // dead export named `release` alive. String contents are masked as
    // data now; a quoted name counts only in module-specifier position.
    const dir = await mkdtemp(path.join(tmpdir(), 'dead-export-stringlit-'));
    try {
      await writeFile(
        path.join(dir, 'pool.ts'),
        'export function release(): void {}\n',
        'utf-8',
      );
      // Only string-literal occurrences of the name — a case label and
      // an enum-style array. Both are DATA: they name a wire/state
      // value, not this module's binding.
      await writeFile(
        path.join(dir, 'state.ts'),
        'function label(s: string): string {\n' +
          "  switch (s) {\n    case 'release':\n      return 'r';\n    default:\n      return s;\n  }\n}\n" +
          "const kinds = ['release', 'complete'] as const;\nvoid label;\nvoid kinds;\n",
        'utf-8',
      );

      const dead = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const deadOut = `${dead.stdout}${dead.stderr}`;
      expect(dead.status).toBe(1);
      expect(deadOut).toContain('DEAD EXPORTS');
      expect(deadOut).toContain('release');

      // The other half of discrimination: a real import + call of the
      // binding still keeps the same export alive.
      await writeFile(
        path.join(dir, 'caller.ts'),
        "import { release } from './pool.js';\nfunction done(): void {\n  release();\n}\nvoid done;\n",
        'utf-8',
      );
      const alive = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const aliveOut = `${alive.stdout}${alive.stderr}`;
      expect(alive.status).toBe(0);
      expect(aliveOut).toContain('dead-export check: clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an interface-member collision does not keep an export alive — planted `release` (B-15)', async () => {
    // The third collision on the same seam (PL-297): F-6 fixed member
    // access, B-13 fixed string literals, but the property-key exclusion
    // only suppressed `{`/`,`-prefixed keys. An interface member is
    // `;`/newline-separated, so `interface X { release: T }` was counted
    // as a caller of a dead export named `release`. The compiler resolves
    // the member to its OWN symbol now, not this module's binding.
    const dir = await mkdtemp(path.join(tmpdir(), 'dead-export-iface-'));
    try {
      await writeFile(
        path.join(dir, 'pool.ts'),
        'export function release(): void {}\n',
        'utf-8',
      );
      // Only an interface member named `release` (a property signature —
      // its own symbol) plus a member-access call. Neither is a use of
      // THIS module's binding. No exports of its own.
      await writeFile(
        path.join(dir, 'user.ts'),
        'interface Detacher {\n  release: () => void;\n}\n' +
          'function detach(d: Detacher): void {\n  d.release();\n}\nvoid detach;\n',
        'utf-8',
      );

      const dead = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const deadOut = `${dead.stdout}${dead.stderr}`;
      expect(dead.status).toBe(1);
      expect(deadOut).toContain('DEAD EXPORTS');
      expect(deadOut).toContain('release');

      // A real import + call of the binding keeps the same export alive.
      await writeFile(
        path.join(dir, 'caller.ts'),
        "import { release } from './pool.js';\nfunction done(): void {\n  release();\n}\nvoid done;\n",
        'utf-8',
      );
      const alive = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const aliveOut = `${alive.stdout}${alive.stderr}`;
      expect(alive.status).toBe(0);
      expect(aliveOut).toContain('dead-export check: clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an optional-key collision does not keep an export alive — planted `release` (B-15)', async () => {
    // The optional-key variant: `release?:` breaks the pre-B-15 `after`
    // regex (`^\s*[:[(]`) because a `?` sits between the name and the
    // colon, so the property-key exclusion never fired and `release?:`
    // counted as a bare reference. Symbol resolution does not care about
    // punctuation — an optional property signature is its own symbol.
    const dir = await mkdtemp(path.join(tmpdir(), 'dead-export-optkey-'));
    try {
      await writeFile(
        path.join(dir, 'pool.ts'),
        'export function release(): void {}\n',
        'utf-8',
      );
      await writeFile(
        path.join(dir, 'user.ts'),
        'interface Opts {\n  release?: () => void;\n}\n' +
          'function detach(o: Opts): void {\n  o.release?.();\n}\nvoid detach;\n',
        'utf-8',
      );

      const dead = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const deadOut = `${dead.stdout}${dead.stderr}`;
      expect(dead.status).toBe(1);
      expect(deadOut).toContain('DEAD EXPORTS');
      expect(deadOut).toContain('release');

      await writeFile(
        path.join(dir, 'caller.ts'),
        "import { release } from './pool.js';\nfunction done(): void {\n  release();\n}\nvoid done;\n",
        'utf-8',
      );
      const alive = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        dir,
      ]);
      const aliveOut = `${alive.stdout}${alive.stderr}`;
      expect(alive.status).toBe(0);
      expect(aliveOut).toContain('dead-export check: clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a recursive self-reference does not keep a test-only export alive (B-16)', async () => {
    // The evaluator's probe: the compiler resolved the reference
    // correctly — the liveness question was wrong. `zzCountDown` calls
    // itself, and a self-reference was still "a reference from src/",
    // so a test-only export passed as clean. References inside the
    // export's own declaration are not callers now.
    const dir = await mkdtemp(path.join(tmpdir(), 'dead-export-recursion-'));
    try {
      await mkdir(path.join(dir, 'src', 'repositories'), { recursive: true });
      await mkdir(path.join(dir, 'tests'), { recursive: true });
      await writeFile(
        path.join(dir, 'src', 'repositories', 'planted.ts'),
        'export function zzCountDown(n: number): number {\n' +
          '  return n <= 0 ? 0 : zzCountDown(n - 1);\n}\n',
        'utf-8',
      );
      await writeFile(
        path.join(dir, 'tests', 'planted-caller.test.ts'),
        "import { zzCountDown } from '../src/repositories/planted.js';\nvoid zzCountDown;\n",
        'utf-8',
      );

      const dead = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        path.join(dir, 'src'),
        '--tests-root',
        path.join(dir, 'tests'),
      ]);
      const deadOut = `${dead.stdout}${dead.stderr}`;
      expect(dead.status).toBe(1);
      expect(deadOut).toContain('DEAD EXPORTS');
      expect(deadOut).toContain('zzCountDown');

      // The other half of discrimination: a real src caller — itself in
      // reachable code — keeps the same export alive.
      await writeFile(
        path.join(dir, 'src', 'caller.ts'),
        "import { zzCountDown } from './repositories/planted.js';\n" +
          'export function counted(n: number): number {\n  return zzCountDown(n);\n}\n',
        'utf-8',
      );
      // `counted` is itself called from a top-level (root) statement so
      // the caller chain is genuinely reachable.
      await writeFile(
        path.join(dir, 'src', 'entry.ts'),
        "import { counted } from './caller.js';\nvoid counted(3);\n",
        'utf-8',
      );
      const alive = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        path.join(dir, 'src'),
        '--tests-root',
        path.join(dir, 'tests'),
      ]);
      const aliveOut = `${alive.stdout}${alive.stderr}`;
      expect(alive.status).toBe(0);
      expect(aliveOut).toContain('dead-export check: clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a reference from dead in-file code does not keep a test-only export alive (B-16)', async () => {
    // The evaluator's second probe: `type X = ReturnType<typeof zzProbe>`
    // is a real resolved reference, but `X` is itself dead code — a
    // mention from a dead declaration is not a caller. Same-file
    // references now count only from alive top-level code.
    const dir = await mkdtemp(path.join(tmpdir(), 'dead-export-typeof-'));
    try {
      await mkdir(path.join(dir, 'src', 'repositories'), { recursive: true });
      await mkdir(path.join(dir, 'tests'), { recursive: true });
      await writeFile(
        path.join(dir, 'src', 'repositories', 'planted.ts'),
        'export function zzProbe(): number {\n  return 1;\n}\n' +
          'type ZzProbeResult = ReturnType<typeof zzProbe>;\n',
        'utf-8',
      );
      await writeFile(
        path.join(dir, 'tests', 'planted-caller.test.ts'),
        "import { zzProbe } from '../src/repositories/planted.js';\nvoid zzProbe;\n",
        'utf-8',
      );

      const dead = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        path.join(dir, 'src'),
        '--tests-root',
        path.join(dir, 'tests'),
      ]);
      const deadOut = `${dead.stdout}${dead.stderr}`;
      expect(dead.status).toBe(1);
      expect(deadOut).toContain('DEAD EXPORTS');
      expect(deadOut).toContain('zzProbe');

      await writeFile(
        path.join(dir, 'src', 'caller.ts'),
        "import { zzProbe } from './repositories/planted.js';\n" +
          'export function viaProbe(): number {\n  return zzProbe();\n}\n',
        'utf-8',
      );
      await writeFile(
        path.join(dir, 'src', 'entry.ts'),
        "import { viaProbe } from './caller.js';\nvoid viaProbe();\n",
        'utf-8',
      );
      const alive = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        path.join(dir, 'src'),
        '--tests-root',
        path.join(dir, 'tests'),
      ]);
      const aliveOut = `${alive.stdout}${alive.stderr}`;
      expect(alive.status).toBe(0);
      expect(aliveOut).toContain('dead-export check: clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a repository export whose only caller is a TEST fails the check (PL-285 — the dropped exemption)', async () => {
    // The old TEST_SURFACE exempted all of src/repositories/: a
    // repository function called only by tests passed one directory
    // deep from the PL-206 catch ("no caller in src/"). The exemption
    // is gone; the eight legitimate test-surface exports carry written
    // JUSTIFIED entries instead. This is the regression leg for the
    // exact shape the exemption let through.
    const dir = await mkdtemp(path.join(tmpdir(), 'dead-export-repo-'));
    try {
      await mkdir(path.join(dir, 'src', 'repositories'), { recursive: true });
      await mkdir(path.join(dir, 'tests'), { recursive: true });
      await writeFile(
        path.join(dir, 'src', 'repositories', 'planted.ts'),
        'export async function onlyTestsCallMe(x: string): Promise<string> {\n  return x;\n}\n',
        'utf-8',
      );
      // The only caller is a test file — alive under the old exemption,
      // dead now that repositories are a feature layer.
      await writeFile(
        path.join(dir, 'tests', 'planted-caller.test.ts'),
        "import { onlyTestsCallMe } from '../src/repositories/planted.js';\n",
        'utf-8',
      );

      const check = spawnSync('node', [
        'scripts/check-dead-exports.mjs',
        '--root',
        path.join(dir, 'src'),
        '--tests-root',
        path.join(dir, 'tests'),
      ]);
      const out = `${check.stdout}${check.stderr}`;
      expect(check.status).toBe(1);
      expect(out).toContain('DEAD EXPORTS');
      expect(out).toContain('onlyTestsCallMe');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the Rule-7 fix is line-scoped and justified — and the rule still bites elsewhere', async () => {
    // The disable sits on the one parameter, with its reason written
    // where the disable is. A file-scoped override would have weakened
    // the rule for every function in pickup-requests.ts.
    const repo = await readFile('src/repositories/pickup-requests.ts', 'utf-8');
    const disableLine = repo
      .split('\n')
      .find((l) => l.includes('eslint-disable-next-line no-restricted-syntax'));
    expect(disableLine).toBeDefined();
    expect(disableLine).toContain('SLACK_TENANT_IDS'); // the config origin, named
    expect(repo).not.toContain('eslint-disable no-restricted-syntax'); // no file-wide disable

    // The mutation: a planted tenantId parameter in the repository layer
    // still fails lint — the rule is alive outside the one justified
    // line. stdin carries the planted file; eslint never touches disk.
    const lint = spawnSync(
      path.join('node_modules', '.bin', 'eslint'),
      ['--stdin', '--stdin-filename', 'src/repositories/planted.ts'],
      {
        input: 'export function planted(x: string, tenantId: string) { return x; }\n',
        encoding: 'utf-8',
      },
    );
    const out = `${lint.stdout}${lint.stderr}`;
    expect(lint.status).toBe(1);
    expect(out).toContain('Rule 7');
  });
});
