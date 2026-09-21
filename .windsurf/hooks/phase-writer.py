#!/usr/bin/env python3
"""
Harness Hook: Phase Writer  (v2, new)

Runs on pre_user_prompt. A leading phase command sets the Harness phase for
THIS conversation (keyed by trajectory_id), so the generator and evaluator
chats run in parallel without blocking each other — the separation the
harness's agent-separation rule requires.

Recognised leading commands:
  /evaluate  -> evaluation     /plan      -> planning
  /research  -> research       /implement -> implementation
  /new-sprint -> research      (a new sprint starts at Phase 0a/0b)

Any later prompt that leads with a phase command moves the conversation to
that phase — that is how a chat leaves evaluation. Never blocks.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, user_prompt, trajectory_id, set_phase, ok

COMMANDS = {
    "/evaluate": "evaluation",
    "/research": "research",
    "/new-sprint": "research",
    "/plan": "planning",
    "/implement": "implementation",
}


def command_of(prompt):
    """The phase command a prompt leads with, or None.

    Only the first meaningful line counts — a command mentioned mid-prompt
    is not a phase change. Two shapes are accepted because which one arrives
    is a Step-0 question: the literal "/evaluate ..." the user typed, or the
    expanded workflow doc (frontmatter "name: evaluate" or "# /evaluate").
    """
    for line in prompt.splitlines()[:8]:
        s = line.strip()
        if not s or s == "---":
            continue
        m = re.match(r"name:\s*([A-Za-z-]+)\s*$", s)   # workflow frontmatter
        if m:
            cand = "/" + m.group(1).lower()
            if cand in COMMANDS:
                return cand
        tok = s.lstrip("#").strip().split()[0].lower() if s.lstrip("#").strip() else ""
        if tok in COMMANDS:
            return tok
        break   # first meaningful line carried no command
    return None


def main():
    data = read_input()
    cmd = command_of(user_prompt(data))
    if not cmd:
        sys.exit(0)
    path = set_phase(COMMANDS[cmd], trajectory_id(data))
    ok(f"Phase set: {COMMANDS[cmd]} (this conversation only, {path}). "
       "Other chats keep their own phase.")


if __name__ == "__main__":
    main()
