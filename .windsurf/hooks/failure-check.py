#!/usr/bin/env python3
"""
Harness v3 Hook: Failure Check
Surfaces documented Failed Approaches before implementation writes. Warn only.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path

PROGRESS = "implementation/progress.md"
IMPL_DIRS = ("src/", "lib/", "scripts/", "implementation/")

def main():
    fp = file_path(read_input()).replace("\\", "/")
    if not any(fp.startswith(d) or f"/{d}" in fp for d in IMPL_DIRS):
        sys.exit(0)
    if fp.endswith("progress.md") or not os.path.exists(PROGRESS):
        sys.exit(0)

    with open(PROGRESS, encoding="utf-8") as f:
        lines = f.read().split("\n")

    collected, inside = [], False
    for line in lines:
        if "Failed Approaches" in line:
            inside = True
            continue
        if inside:
            if line.startswith(("## ", "### ")):
                break
            if line.strip():
                collected.append(line.strip())

    if collected:
        print(f"FAILURE CHECK: {len(collected)} documented failed approach(es):")
        for item in collected[:5]:
            print(f"  - {item[:100]}")
        print("  Do NOT repeat these. The Evaluator flags repeats as a rubric penalty.")
    sys.exit(0)

if __name__ == "__main__":
    main()
