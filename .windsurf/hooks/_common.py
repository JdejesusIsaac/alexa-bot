"""Shared helpers for Harness hooks (v2).

v2 contract fixes, verified against docs.windsurf.com/windsurf/cascade/hooks
on 2026-09-21:

  1. Denials go to STDERR. On exit 2 "the Cascade agent sees the error
     message from stderr." v1 printed every reason to stdout, so each block
     reached the agent with no explanation and it could only retry blindly.
     Use block() for denials, ok() for notices.
  2. pre_write_code delivers changes as tool_info.edits[].new_string.
     v1's content_of() never read edits, returned "" on every real edit,
     and the semantic failure check was silently skipped every time.
  3. Phase is per-conversation. trajectory_id is on every payload; the
     phase lives in .windsurf/state/phase.<trajectory_id>, set by
     phase-writer.py on a leading /evaluate, /research, /plan, or
     /implement prompt. The legacy global .windsurf/state/phase remains a
     fallback. This replaces v1's 30-minute test.md mtime heuristic, which
     blocked the generator chat whenever test.md had been edited recently.
"""
import glob
import json
import os
import re
import sys

STATE_DIR = ".windsurf/state"
STATE_FILE = os.path.join(STATE_DIR, "phase")          # legacy global fallback
PAYLOADS_DIR = os.path.join(STATE_DIR, "payloads")     # step-0 probe output
JEV_LOG = os.path.join(STATE_DIR, "jev-decisions.jsonl")
MCP_PHASES_FILE = os.environ.get(
    "HARNESS_MCP_PHASES", os.path.join(".windsurf", "mcp-phases.json"))

# kind -> canonical v3 path. Sprint folders use the same basenames.
ARTIFACTS = {
    "research": "research/research.md",
    "plan":     "planning/plan.md",
    "progress": "implementation/progress.md",
    "test":     "evaluation/test.md",
}

BUDGETS = {"research": 80000, "plan": 40000, "progress": 40000, "test": 40000}

PHASES = ("research", "planning", "implementation", "evaluation")


def read_input():
    """Parse hook JSON from stdin. Fail open on unreadable input."""
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError, ValueError):
        sys.exit(0)
    return data if isinstance(data, dict) else {}


def block(message):
    """Deny the action. Exit 2 blocks pre-hooks; the agent sees STDERR."""
    print(message, file=sys.stderr)
    sys.exit(2)


def ok(message=""):
    """Allow the action. Notices go to stdout (visible with show_output)."""
    if message:
        print(message)
    sys.exit(0)


def trajectory_id(data):
    """Per-conversation id, present on every documented payload."""
    tid = data.get("trajectory_id")
    return str(tid) if tid else None


def file_path(data):
    ti = data.get("tool_info", {})
    if not isinstance(ti, dict):
        ti = {}
    return ti.get("file_path", "") or data.get("file_path", "") or ""


def content_of(data):
    """Concatenate the proposed new content the payload carries.

    pre_write_code sends edits as tool_info.edits[].{old_string,new_string};
    the legacy content/new_str/... keys are kept for older payloads and
    fixtures.
    """
    ti = data.get("tool_info", {})
    if not isinstance(ti, dict):
        return ""
    parts = []
    edits = ti.get("edits")
    if isinstance(edits, list):
        for e in edits:
            if isinstance(e, dict) and isinstance(e.get("new_string"), str):
                parts.append(e["new_string"])
    for key in ("content", "new_str", "new_content", "text", "diff", "patch"):
        if isinstance(ti.get(key), str):
            parts.append(ti[key])
    return "\n".join(parts)


def command_line(data):
    ti = data.get("tool_info", {})
    if not isinstance(ti, dict):
        return ""
    return ti.get("command_line", "") or data.get("command_line", "") or ""


def user_prompt(data):
    ti = data.get("tool_info", {})
    if not isinstance(ti, dict):
        return ""
    return ti.get("user_prompt", "") or data.get("user_prompt", "") or ""


def mcp_server(data):
    ti = data.get("tool_info", {})
    if not isinstance(ti, dict):
        ti = {}
    for holder in (ti, data):
        for key in ("mcp_server_name", "server_name", "mcp_server"):
            v = holder.get(key)
            if isinstance(v, str) and v:
                return v
    return ""


def _phase_file(tid):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", tid)
    return os.path.join(STATE_DIR, "phase." + safe)


def _read_phase(path):
    try:
        with open(path, encoding="utf-8") as f:
            p = f.read().strip().lower()
    except OSError:
        return None
    return p if p in PHASES else None


def set_phase(phase, tid=None):
    """Record the phase for this conversation. No trajectory_id -> legacy
    global file, so a client that omits the field still gets v1 semantics."""
    ensure_state_dir()
    path = _phase_file(tid) if tid else STATE_FILE
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(phase + "\n")
    except OSError:
        pass
    return path


def current_phase(tid=None):
    """This conversation's phase, else the legacy global file, else None."""
    if tid:
        p = _read_phase(_phase_file(tid))
        if p:
            return p
    return _read_phase(STATE_FILE)


def conversation_phase(tid):
    """This conversation's OWN phase file only — no global fallback.

    Evaluator isolation (PL-271) allows artifact reads on this value
    alone: a legacy global file saying 'implementation' must never
    vouch for a conversation that never declared a phase. That was the
    Sprint 3.1 breach — the evaluator's fresh conversation had no
    phase of its own while the global file said 'implementation', so
    isolation held by nothing. Default closed.
    """
    if not tid:
        return None
    return _read_phase(_phase_file(tid))


def mark_conversation(tid):
    """Record which conversation is running, for the receipt to bind.

    The isolation hook fires on every read and command, so the marker
    always names the conversation whose tool call is in flight —
    including the `bash scripts/preflight.sh` call itself, which is how
    the receipt resolves THIS conversation's phase without trusting a
    foreign phase.* file (F-7). Never raises, never blocks.
    """
    if not tid:
        return
    ensure_state_dir()
    try:
        with open(
            os.path.join(STATE_DIR, "last-trajectory"), "w", encoding="utf-8"
        ) as f:
            f.write(str(tid) + "\n")
    except OSError:
        pass


def _sprint_num(path):
    m = re.search(r"sprint-(\d+(?:\.\d+)?)/", path.replace("\\", "/"))
    return float(m.group(1)) if m else -1.0


def _is_draft(path):
    """Drafted-ahead sprint folders self-mark 'STATUS: DRAFT' near the top.
    A draft is not the live sprint even though its number sorts highest."""
    try:
        with open(path, encoding="utf-8") as f:
            return "STATUS: DRAFT" in f.read(4096)
    except OSError:
        return False


def artifact(kind):
    """Path to the live artifact of `kind`: the highest-numbered non-draft
    sprint-*/ copy if any exist, else the canonical v3 path. Returns None
    when neither exists."""
    base = os.path.basename(ARTIFACTS[kind])
    candidates = sorted(
        (c for c in glob.glob("sprint-*/" + base) if not _is_draft(c)),
        key=_sprint_num,
    )
    if candidates:
        return candidates[-1]
    canonical = ARTIFACTS[kind]
    return canonical if os.path.exists(canonical) else None


def artifact_for(fp, kind):
    """Artifact of `kind` in the same sprint folder as `fp`, when fp is inside
    one; else the live artifact (latest sprint, canonical fallback).
    sprint-3/plan.md gates on sprint-3/research.md, not the newest sprint's."""
    m = re.search(r"(^|/)(sprint-\d+(?:\.\d+)?)/", (fp or "").replace("\\", "/"))
    if m:
        same = m.group(2) + "/" + os.path.basename(ARTIFACTS[kind])
        if os.path.exists(same):
            return same
    return artifact(kind)


def is_artifact(fp, kind):
    """True if `fp` is an artifact of `kind`, canonical or per-sprint."""
    fp = (fp or "").replace("\\", "/")
    base = os.path.basename(ARTIFACTS[kind])
    if fp.endswith(ARTIFACTS[kind]):
        return True
    return bool(
        re.search(r"(^|/)sprint-\d+(?:\.\d+)?/" + re.escape(base) + "$", fp)
    )


def artifact_kind(fp):
    for kind in ARTIFACTS:
        if is_artifact(fp, kind):
            return kind
    return None


def ensure_state_dir():
    """.windsurf/state/ is gitignored, so it is absent on a fresh clone."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except OSError:
        pass
