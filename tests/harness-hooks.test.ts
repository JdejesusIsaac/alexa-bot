import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * T-84 — isolation defaults to on (PL-271).
 *
 * `evaluator-isolation.py` blocks progress.md and smoke.log unless THIS
 * conversation's own phase file reads exactly `implementation`. The
 * legacy global file may block, never allow — the Sprint 3.1 evaluation
 * read the Generator's progress.md because its conversation had no phase
 * of its own while the global file said `implementation`. Isolation held
 * by nothing; now it holds by default.
 *
 * `verify-hooks.sh` is the hook suite's own test, and its unphased case IS
 * the mutation proof: restoring the old allow-unless-`evaluation` logic
 * makes that case expect exit 2 and get exit 0, failing the script. This
 * file makes that script part of CI rather than a hand-run — enforcement
 * that is never run looks identical to enforcement that passed (the
 * documented Sprint 2/3 failure).
 *
 * Bash + python3 are the hook runtime this harness already depends on;
 * the npm scripts assume them.
 */

const run = promisify(execFile);

const EXPECTED_CASES = 11;

describe('T-84 · isolation defaults to on — the hook suite', () => {
  it('verify-hooks.sh passes all cases, including the unphased one', async () => {
    const { stdout } = await run('bash', ['.windsurf/verify-hooks.sh'], {
      cwd: process.cwd(),
    });

    // The unphased case is the Sprint 3.1 breach as a test: no phase of
    // the conversation's own, global file saying implementation — and
    // the read still blocks, for progress.md and smoke.log alike.
    expect(stdout).toContain('unphased conversation blocked');

    // 11 cases, all passing. A case count below EXPECTED_CASES means the
    // unphased case was dropped; above means the suite grew — update the
    // plan's expectation deliberately, not by accident.
    const m = stdout.match(/(\d+) passed, (\d+) failed/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(EXPECTED_CASES);
    expect(Number(m![2])).toBe(0);
  });

  it('the unphased case runs against the real hook, not a fixture of it', async () => {
    // The script exercises .windsurf/hooks/evaluator-isolation.py via
    // stdin payloads. If the hook file were replaced by a stub, the
    // first suite above would still pass — so assert the hook itself
    // still contains the default-on rule this test exists to guard.
    // A structural check on the enforcement, not a copy of it.
    const { readFile } = await import('node:fs/promises');
    const hook = await readFile('.windsurf/hooks/evaluator-isolation.py', 'utf-8');
    expect(hook).toContain('conversation_phase');
    expect(hook).toContain('smoke.log');
    // The global file must never be consulted to ALLOW a read: the old
    // logic gated on current_phase(...) == "evaluation", which a global
    // "implementation" satisfied. That call must be gone.
    expect(hook).not.toContain('current_phase');
  });
});
