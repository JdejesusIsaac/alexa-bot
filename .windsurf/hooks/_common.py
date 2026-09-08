"""Shared helpers for Harness hooks."""
import json, os, sys

STATE_FILE = ".windsurf/state/phase"

def read_input():
    """Parse hook JSON from stdin. Fail open on unreadable input."""
    try:
        return json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError, ValueError):
        sys.exit(0)

def file_path(data):
    return data.get("tool_info", {}).get("file_path", "") or data.get("file_path", "")

def current_phase():
    """Explicit phase from .windsurf/state/phase, else None.
    Set with: echo evaluation > .windsurf/state/phase"""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, encoding="utf-8") as f:
            p = f.read().strip().lower()
        if p in ("research", "planning", "implementation", "evaluation"):
            return p
    return None
