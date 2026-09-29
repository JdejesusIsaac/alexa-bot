#!/usr/bin/env python3
"""
Harness Hook: Evaluator Isolation  (v3 — default ON)

Blocks reads of the Generator's working artifacts — progress.md and
smoke.log — through the read path (pre_read_code, tool_info.file_path)
AND the terminal (pre_run_command, tool_info.command_line).

v2 blocked only when the phase was 'evaluation'. A conversation with
no phase of its own read freely — which is exactly what happened in
the Sprint 3.1 evaluation: the evaluator never led with /evaluate, the
legacy global phase file said 'implementation' (some generator chat
had set it), and isolation held by nothing.

v3 inverts the default (PL-271): the artifacts are blocked unless THIS
conversation's own phase file (phase.<trajectory_id>) reads exactly
'implementation'. The Generator already types /implement. An evaluator
that forgets /evaluate is then isolated by default rather than by
memory — the same posture as the Cursor harness, where an unphased
conversation defaults to the most restrictive phase.

The legacy global file may make isolation stricter (it can still say
'evaluation'), never looser: a global 'implementation' cannot vouch
for a conversation that never declared a phase.

Exit 2 = BLOCK. The reason goes to stderr — that is the stream the
agent sees.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import (
    read_input, file_path, command_line, conversation_phase, trajectory_id,
    mark_conversation, block,
)

MSG = (
    "EVALUATOR ISOLATION (default on): progress.md and smoke.log are the "
    "Generator's working artifacts.\n"
    "  This conversation is not in the implementation phase, so they are "
    "blocked.\n"
    "  You may read: the Sprint Contract (sprint-N/plan.md + sprint-N/test.md) "
    "and the build.\n"
    "  The Generator starts a prompt with /implement. If you are the "
    "Evaluator, start with /evaluate — grading never needs these files."
)

BLOCKED_FRAGMENTS = ("progress.md", "smoke.log")


def main():
    data = read_input()
    # Drop the conversation marker FIRST — every read/command refreshes
    # it, so the preflight receipt can bind its phase check to the
    # conversation actually running it (F-7). Enforcement is unchanged.
    mark_conversation(trajectory_id(data))
    target = (file_path(data) or command_line(data)).replace("\\", "/")
    if not any(frag in target for frag in BLOCKED_FRAGMENTS):
        sys.exit(0)
    # Allow ONLY on this conversation's own explicit implementation phase.
    # Everything else — absent phase, research, planning, evaluation, no
    # trajectory id, or a global file saying implementation — blocks.
    if conversation_phase(trajectory_id(data)) == "implementation":
        sys.exit(0)
    block(MSG)


if __name__ == "__main__":
    main()
