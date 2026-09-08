#!/usr/bin/env python3
"""
Harness v3 Hook: Evaluator Isolation
Blocks the Evaluator from reading the Generator's progress.md.
Primary signal: explicit phase state file. Fallback: recent test.md mtime.
Exit 2 = BLOCK.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path, current_phase

def blocked():
    print("EVALUATOR ISOLATION: cannot read progress.md during evaluation.")
    print("  The Evaluator is structurally independent from the Generator.")
    print("  You may read: the Sprint Contract (planning/plan.md) + the build.")
    print("  To leave evaluation: echo implementation > .windsurf/state/phase")
    sys.exit(2)

def main():
    fp = file_path(read_input()).replace("\\", "/")
    if "progress.md" not in fp:
        sys.exit(0)

    phase = current_phase()
    if phase == "evaluation":
        blocked()
    if phase is not None:
        sys.exit(0)   # explicit non-evaluation phase — allow

    # Fallback heuristic only when no phase is declared
    marker = "evaluation/test.md"
    if os.path.exists(marker) and (time.time() - os.path.getmtime(marker)) < 1800:
        blocked()

    sys.exit(0)

if __name__ == "__main__":
    main()
