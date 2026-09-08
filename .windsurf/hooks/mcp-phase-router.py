#!/usr/bin/env python3
"""
Harness v3 Hook: MCP Phase Router
Warns when an MCP outside the active phase's allowance is called.
4-5 tools per agent. Set enforce=True below to block.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, current_phase

ENFORCE = False

ALLOWED = {
    "research":       ["brave-search", "sequential-thinking"],
    "planning":       ["sequential-thinking", "brave-search"],
    "implementation": ["postgres", "supabase-mcp-server"],
    "evaluation":     ["playwright", "puppeteer"],
}

def main():
    data = read_input()
    server = data.get("server_name", "") or data.get("tool_info", {}).get("server_name", "")
    phase = current_phase()
    if not phase or not server:
        sys.exit(0)   # fail open when phase is undeclared
    if server not in ALLOWED.get(phase, []):
        print(f"MCP ROUTER: '{server}' is not assigned to the {phase} phase.")
        print(f"  Allowed: {', '.join(ALLOWED.get(phase, []))}")
        if ENFORCE:
            sys.exit(2)
    sys.exit(0)

if __name__ == "__main__":
    main()
