#!/usr/bin/env python3
"""
Harness v3 Hook: Student Data Guard  (Parent Line specific)
Blocks writes that would put real student data or forbidden file types in the repo.
Rule 6 in AGENTS.md. Exit 2 = BLOCK.
"""
import os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path

BANNED_EXT = (".csv", ".xlsx", ".xls", ".numbers")
BANNED_PATH = ("fixtures/real/", "fixtures/prod/", "/uploads/")

# Column headers that only appear when someone pasted a live roster export
LIVE_EXPORT_MARKERS = [
    r"Advisor Notes\s*-\s*Must Fill",
    r"Reason\s*\(Ops/Leaders Only\)",
    r"Time In\s*\(Ops Only\)",
    r"docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]{20,}",
]

def main():
    data = read_input()
    fp = file_path(data)
    if not fp:
        sys.exit(0)

    low = fp.lower()
    if low.endswith(BANNED_EXT):
        print("STUDENT DATA GUARD: blocked write of a spreadsheet file.")
        print(f"  Path: {fp}")
        print("  Roster exports never enter this repo. Use synthetic fixtures (see plan.md PL-011).")
        sys.exit(2)

    if any(b in fp.replace("\\", "/") for b in BANNED_PATH):
        print("STUDENT DATA GUARD: blocked write to a real-data path.")
        print(f"  Path: {fp}")
        sys.exit(2)

    # Inspect proposed content when the payload carries it
    content = ""
    ti = data.get("tool_info", {})
    for key in ("content", "new_str", "new_content", "text"):
        if isinstance(ti.get(key), str):
            content += ti[key]
    if not content:
        sys.exit(0)

    for pat in LIVE_EXPORT_MARKERS:
        if re.search(pat, content, re.IGNORECASE):
            print("STUDENT DATA GUARD: content looks like a live roster export or sheet URL.")
            print(f"  Matched: {pat}")
            print("  Record schema and column structure only — never rows, IDs, names, or document IDs.")
            sys.exit(2)

    sys.exit(0)

if __name__ == "__main__":
    main()
