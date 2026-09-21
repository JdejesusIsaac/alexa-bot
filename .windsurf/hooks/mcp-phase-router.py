#!/usr/bin/env python3
"""
Harness Hook: MCP Phase Router  (v2)

Enforces the per-phase MCP allowlist from .windsurf/mcp-phases.json:

    { "research": ["brave-search", ...], "planning": [...], ... }

Until that file exists the router only WARNS — v1's behaviour, now explicit
instead of a hardcoded list naming servers this project does not run. Once
the file exists, a server assigned to another phase is denied, and a server
assigned to no phase at all is denied in every phase.

A conversation with no phase set gets a warning and is allowed: the phase
commands opt a chat into the harness rather than breaking MCP for ad-hoc
conversations.

Exit 2 = BLOCK. Denials go to stderr; notices to stdout.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import (
    MCP_PHASES_FILE, PHASES, read_input, mcp_server, current_phase,
    trajectory_id, block, ok,
)


def load_mapping():
    try:
        with open(MCP_PHASES_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    out = {}
    for phase, servers in raw.items():
        if isinstance(servers, list):
            out[phase] = [s for s in servers if isinstance(s, str)]
    return out


def main():
    data = read_input()
    server = mcp_server(data)
    if not server:
        ok("MCP ROUTER: no mcp_server_name in payload; allowing.")

    mapping = load_mapping()
    if mapping is None:
        ok(f"MCP ROUTER: {MCP_PHASES_FILE} not written — warn-only mode. "
           f"Call to '{server}' allowed; assign phases to enforce.")

    phase = current_phase(trajectory_id(data))
    if not phase:
        ok(f"MCP ROUTER: no phase set for this conversation; '{server}' "
           "allowed. Start the chat with /evaluate, /research, /plan, or "
           "/implement to route MCPs.")

    if server in mapping.get(phase, []):
        sys.exit(0)

    elsewhere = [p for p in PHASES if server in mapping.get(p, [])]
    if elsewhere:
        block(f"MCP ROUTER: '{server}' is assigned to "
              f"{', '.join(elsewhere)}, not {phase}.\n"
              f"  Allowed here: {', '.join(mapping.get(phase, [])) or '(none)'}")
    block(f"MCP ROUTER: '{server}' is not assigned to any phase in "
          f"{MCP_PHASES_FILE}.\n"
          "  Unassigned servers are blocked in every phase. Assign it, or "
          "disable the server in mcp_config.json.")


if __name__ == "__main__":
    main()
