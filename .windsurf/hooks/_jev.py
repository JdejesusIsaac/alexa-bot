"""
Shared TypeSafe Jev client for Harness hooks.

Design constraints, in priority order:
  1. NEVER block the developer because a vendor is unreachable.
     Every failure path returns None. Callers treat None as "no opinion"
     and fall back to their deterministic behaviour.
  2. No third-party dependency. Hooks run under whatever python3 Windsurf
     has; stdlib only.
  3. Bounded latency. A pre-write hook that hangs is worse than one that
     is wrong.

If TYPESAFE_API_KEY is unset, ask() returns None and every hook behaves
exactly as it did before this file existed. That is the intended default
for anyone who clones the repo without a key.

API shape verified 2026-09-20 against https://docs.typesafe.ai/api
  POST https://api.typesafe.ai/v1/systemone
  {"model": "...", "state": <str|obj|list>, "questions": {"<id>": {...}}}
  -> {"model": "...", "answers": {"<id>": {...}}, "usage": {...}}

Known quirk: malformed-question validation returns 400, not the documented
422 (typesafe-ai/skills#1). Do not branch on 422.

v2: decisions are logged to .windsurf/state/jev-decisions.jsonl as
{ts, hook, qid, label, prob} — never the state. This is how the
0.35 / 0.55 / 0.65 thresholds get tuned on real traces instead of guessed.
"""
import json
import os
import time
import urllib.error
import urllib.request

ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
JEV_LOG = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "state",
    "jev-decisions.jsonl")


def _env(name):
    """Process env first; if the var is absent, fall back to .env at repo root.

    Hook processes are spawned by Windsurf without .env loaded, so without
    this the semantic layer silently never runs even when the key is on disk.
    A var that is set-but-empty is returned as-is (falsy): TYPESAFE_API_KEY=
    is how you explicitly disable Jev while a key exists in .env.
    """
    v = os.environ.get(name)
    if v is not None:
        return v
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return None


ENDPOINT = _env("TYPESAFE_ENDPOINT") or "https://api.typesafe.ai/v1/systemone"
MODEL = _env("TYPESAFE_MODEL") or "jev-latest"
try:
    TIMEOUT = float(_env("TYPESAFE_TIMEOUT") or 4.0)
except ValueError:
    TIMEOUT = 4.0

# jev-1.13 allows 64k total, 32k for state + longest question. Stay well under:
# accuracy falls as state grows with irrelevant detail, so this cap is a
# quality guard as much as a limit guard.
MAX_STATE_CHARS = 24000


def enabled():
    return bool(_env("TYPESAFE_API_KEY"))


def _truncate(state):
    """Cap the state. Structured state that fits is passed through as-is;
    oversized structured state degrades to a truncated JSON string, which the
    API accepts as text."""
    if isinstance(state, str):
        return state[:MAX_STATE_CHARS]
    try:
        blob = json.dumps(state)
    except (TypeError, ValueError):
        return None
    return state if len(blob) <= MAX_STATE_CHARS else blob[:MAX_STATE_CHARS]


def ask(state, questions):
    """Evaluate `state` against `questions`. Returns the answers map, or None.

    None means "no opinion available" — unset key, network failure, bad
    response, anything. It NEVER means "no".
    """
    key = _env("TYPESAFE_API_KEY")
    if not key or not questions:
        return None

    state = _truncate(state)
    if state is None:
        return None

    body = json.dumps({"model": MODEL, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "User-Agent": "parent-line-harness-hooks/1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            json.JSONDecodeError, ValueError, OSError):
        return None

    answers = payload.get("answers")
    return answers if isinstance(answers, dict) else None


def noul(answers, qid, default=None):
    """Read a noul probability (0..1) out of an answers map. default on absence."""
    if not isinstance(answers, dict):
        return default
    a = answers.get(qid)
    if not isinstance(a, dict):
        return default
    v = a.get("noul")
    return v if isinstance(v, (int, float)) else default


def log_decisions(hook, entries):
    """Append Jev decisions to the tuning log.

    entries: iterable of (qid, label, prob). `label` is the classification the
    hook assigned (e.g. "unresolved", "hit"), NEVER the marker/failure text —
    the state stays out of the log. Best-effort: a logging failure must not
    change what the hook decided.
    """
    try:
        os.makedirs(os.path.dirname(JEV_LOG), exist_ok=True)
        with open(JEV_LOG, "a", encoding="utf-8") as f:
            for qid, label, prob in entries:
                f.write(json.dumps({
                    "ts": int(time.time()),
                    "hook": hook,
                    "qid": qid,
                    "label": label,
                    "prob": prob,
                }) + "\n")
    except OSError:
        pass
