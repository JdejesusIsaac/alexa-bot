#!/usr/bin/env python3
"""
Harness Hook: Artifact Budget Guard
Blocks writes to artifacts already over their context budget. Exit 2 = BLOCK.

CHANGED 2026-09-20: matched only `fp.endswith("planning/plan.md")` and friends,
so no sprint-N/ path could ever satisfy it. Inert since sprint folders began.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path, artifact_kind, BUDGETS, ARTIFACTS


def main():
    fp = file_path(read_input()).replace("\\", "/")
    kind = artifact_kind(fp)
    if not kind:
        sys.exit(0)

    limit = BUDGETS[kind]
    if not os.path.exists(fp):
        sys.exit(0)

    size = os.path.getsize(fp)
    if size > limit:
        print(f"BUDGET GUARD: {fp} is over budget")
        print(f"  Current: {size:,} bytes / Limit: {limit:,}")
        print("  Compact before adding content: merge overlapping points,")
        print("  drop stale detail, keep only what future-you must be primed with.")
        sys.exit(2)

    print(f"Budget OK: {fp} ({size:,}/{limit:,}, {limit-size:,} free)")
    sys.exit(0)


if __name__ == "__main__":
    main()
