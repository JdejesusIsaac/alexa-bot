#!/usr/bin/env python3
"""
Harness Hook: Evaluator Isolation  (v2)

Blocks the Evaluator from reading the Generator's progress.md — through the
read path (pre_read_code, tool_info.file_path) AND the terminal
(pre_run_command, tool_info.command_line). v1 guarded reads only, so
`cat sprint-3/progress.md` in a Cascade terminal bypassed isolation entirely.

Phase is per-conversation now (trajectory_id), with the legacy global
.windsurf/state/phase as fallback. The 30-minute test.md mtime heuristic is
gone: it blocked the generator chat whenever test.md had been edited
recently. A conversation is in evaluation only if it led with /evaluate —
or the legacy global file says so.

Exit 2 = BLOCK. The reason goes to stderr — that is the stream the agent sees.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import (
    read_input, file_path, command_line, current_phase, trajectory_id,
    block, ok,
)

MSG = (
    "EVALUATOR ISOLATION: progress.md is the Generator's reasoning and "
    "this conversation is in the evaluation phase.\n"
    "  You may read: the Sprint Contract (sprint-N/plan.md + sprint-N/test.md) "
    "and the build.\n"
    "  To leave evaluation, start a prompt with /implement — the phase is "
    "per-conversation, so this changes nothing in other chats."
)


def main():
    data = read_input()
    target = (file_path(data) or command_line(data)).replace("\\", "/")
    if "progress.md" not in target:
        sys.exit(0)
    if current_phase(trajectory_id(data)) == "evaluation":
        block(MSG)
    sys.exit(0)


if __name__ == "__main__":
    main()
