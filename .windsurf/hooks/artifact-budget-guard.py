#!/usr/bin/env python3
"""
Harness v3 Hook: Artifact Budget Guard
Blocks writes to artifacts already over their context budget. Exit 2 = BLOCK.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path

BUDGETS = {
    "research/research.md":        80000,   # ~40% context
    "planning/plan.md":            40000,   # ~20%
    "implementation/progress.md":  40000,   # ~20%
    "evaluation/test.md":          40000,   # ~20%
}

def main():
    fp = file_path(read_input()).replace("\\", "/")
    for artifact, limit in BUDGETS.items():
        if fp.endswith(artifact):
            if os.path.exists(fp):
                size = os.path.getsize(fp)
                if size > limit:
                    print(f"BUDGET GUARD: {artifact} is over budget")
                    print(f"  Current: {size:,} bytes / Limit: {limit:,}")
                    print("  Compact before adding content: merge overlapping points,")
                    print("  drop stale detail, keep only what future-you must be primed with.")
                    sys.exit(2)
                print(f"Budget OK: {artifact} ({size:,}/{limit:,}, {limit-size:,} free)")
            break
    sys.exit(0)

if __name__ == "__main__":
    main()
