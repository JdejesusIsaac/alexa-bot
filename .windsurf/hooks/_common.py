"""Shared helpers for Harness hooks.

CHANGED 2026-09-20 (harness review): artifact paths are now resolved against
both the canonical v3 layout AND per-sprint folders (sprint-2/, sprint-3/...).
Four of seven hooks were inert because they matched only the canonical paths
while all real work lives in sprint-*/ .
"""
import glob
import json
import os
import re
import sys

STATE_DIR = ".windsurf/state"
STATE_FILE = os.path.join(STATE_DIR, "phase")

# kind -> canonical v3 path. Sprint folders use the same basenames.
ARTIFACTS = {
    "research": "research/research.md",
    "plan":     "planning/plan.md",
    "progress": "implementation/progress.md",
    "test":     "evaluation/test.md",
}

BUDGETS = {"research": 80000, "plan": 40000, "progress": 40000, "test": 40000}


def read_input():
    """Parse hook JSON from stdin. Fail open on unreadable input."""
    try:
        return json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError, ValueError):
        sys.exit(0)


def file_path(data):
    return data.get("tool_info", {}).get("file_path", "") or data.get("file_path", "")


def content_of(data):
    """Concatenate whatever proposed content the payload carries."""
    ti = data.get("tool_info", {})
    out = ""
    for key in ("content", "new_str", "new_content", "text", "diff", "patch"):
        if isinstance(ti.get(key), str):
            out += ti[key]
    return out


def _sprint_num(path):
    m = re.search(r"sprint-(\d+)/", path.replace("\\", "/"))
    return int(m.group(1)) if m else -1


def artifact(kind):
    """Path to the live artifact of `kind`: the highest-numbered sprint-N/ copy
    if any exist, else the canonical v3 path. Returns None when neither exists."""
    base = os.path.basename(ARTIFACTS[kind])
    candidates = sorted(glob.glob("sprint-*/" + base), key=_sprint_num)
    if candidates:
        return candidates[-1]
    canonical = ARTIFACTS[kind]
    return canonical if os.path.exists(canonical) else None


def artifact_for(fp, kind):
    """Artifact of `kind` in the same sprint folder as `fp`, when fp is inside
    one; else the live artifact (latest sprint, canonical fallback).
    sprint-3/plan.md gates on sprint-3/research.md, not the newest sprint's."""
    m = re.search(r"(^|/)(sprint-\d+)/", (fp or "").replace("\\", "/"))
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
    return bool(re.search(r"(^|/)sprint-\d+/" + re.escape(base) + "$", fp))


def artifact_kind(fp):
    for kind in ARTIFACTS:
        if is_artifact(fp, kind):
            return kind
    return None


def ensure_state_dir():
    """.windsurf/state/ is gitignored, so it is absent on a fresh clone and
    `echo evaluation > .windsurf/state/phase` fails with ENOENT. Create it."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except OSError:
        pass


def current_phase():
    """Explicit phase from .windsurf/state/phase, else None.
    Set with: mkdir -p .windsurf/state && echo evaluation > .windsurf/state/phase"""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                p = f.read().strip().lower()
        except OSError:
            return None
        if p in ("research", "planning", "implementation", "evaluation"):
            return p
    return None
