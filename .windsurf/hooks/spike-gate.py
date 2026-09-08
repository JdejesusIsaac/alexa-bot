#!/usr/bin/env python3
"""
Harness v3 Hook: Spike Validation Gate
Blocks writes to planning/ while research.md has unresolved SPIKE: markers.
Wired to pre_write_code (needs file_path). Exit 2 = BLOCK.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path

RESEARCH = "research/research.md"

def main():
    fp = file_path(read_input()).replace("\\", "/")
    if "planning/" not in fp:
        sys.exit(0)

    if not os.path.exists(RESEARCH):
        print("SPIKE GATE: no research/research.md. Complete Phase 0b before planning.")
        sys.exit(2)

    with open(RESEARCH, encoding="utf-8") as f:
        content = f.read()

    markers = content.count("SPIKE:")
    resolved = "## Spike Results" in content or "### Spike Results" in content

    if markers and not resolved:
        print(f"SPIKE GATE: {markers} unresolved spike candidate(s) in research.md")
        print("  Markers present, no 'Spike Results' section.")
        print("  Complete Phase 0.5 before planning.")
        print("  Protocol: timebox -> Go/No-Go -> append results to research.md")
        sys.exit(2)

    if markers:
        print(f"Spike gate passed: {markers} marker(s) with Spike Results present.")
    sys.exit(0)

if __name__ == "__main__":
    main()
