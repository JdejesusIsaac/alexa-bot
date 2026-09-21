#!/usr/bin/env python3
"""
Harness Hook: Artifact Budget Guard
Blocks writes to artifacts already over their context budget. Exit 2 = BLOCK.

v2: the denial goes to stderr (the stream the agent sees); notices to stdout.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path, artifact_kind, BUDGETS, block, ok


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
        block(f"BUDGET GUARD: {fp} is over budget\n"
              f"  Current: {size:,} bytes / Limit: {limit:,}\n"
              "  Compact before adding content: merge overlapping points,\n"
              "  drop stale detail, keep only what future-you must be primed with.")

    ok(f"Budget OK: {fp} ({size:,}/{limit:,}, {limit-size:,} free)")


if __name__ == "__main__":
    main()
