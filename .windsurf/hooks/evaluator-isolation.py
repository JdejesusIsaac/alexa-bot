#!/usr/bin/env python3
"""
Harness Hook: Evaluator Isolation
Blocks the Evaluator from reading the Generator's progress.md.
Primary signal: explicit phase state file. Fallback: recent test.md mtime.
Exit 2 = BLOCK.

CHANGED 2026-09-20: the fallback marker was the canonical `evaluation/test.md`,
which does not exist here, so with no phase file declared the hook allowed
everything. It now resolves the live test artifact (sprint-N/ or canonical),
and the remediation message creates the state directory, which is gitignored
and therefore absent on a fresh clone — `echo evaluation > .windsurf/state/phase`
fails with ENOENT without the mkdir.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path, current_phase, artifact, is_artifact


def blocked():
    print("EVALUATOR ISOLATION: cannot read progress.md during evaluation.")
    print("  The Evaluator is structurally independent from the Generator.")
    print("  You may read: the Sprint Contract (plan.md + test.md) + the build.")
    print("  To leave evaluation:")
    print("    mkdir -p .windsurf/state && echo implementation > .windsurf/state/phase")
    sys.exit(2)


def main():
    fp = file_path(read_input()).replace("\\", "/")
    if not is_artifact(fp, "progress") and "progress.md" not in fp:
        sys.exit(0)

    phase = current_phase()
    if phase == "evaluation":
        blocked()
    if phase is not None:
        sys.exit(0)

    marker = artifact("test")
    if marker and (time.time() - os.path.getmtime(marker)) < 1800:
        blocked()

    sys.exit(0)


if __name__ == "__main__":
    main()
