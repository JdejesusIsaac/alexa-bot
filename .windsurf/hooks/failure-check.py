#!/usr/bin/env python3
"""
Harness Hook: Failure Check  (Jev-backed)

Before an implementation write, check the proposed change against the
documented Failed Approaches in progress.md.

v2: content_of() now reads tool_info.edits[].new_string — the documented
pre_write_code shape — so the semantic check actually runs on real edits.
v1 read only content/new_str/..., got "" every time, and silently skipped
the Jev path on every real edit.

ADVISORY ONLY. Exit 0 always. A repeat is a rubric penalty, not a build break,
and blocking on a probabilistic match would train people to disable the hook.

Degrades cleanly: no TYPESAFE_API_KEY, or Jev unreachable -> prints the list,
exactly the old behaviour.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path, content_of, artifact, artifact_kind, ok
import _jev

IMPL_DIRS = ("src/", "lib/", "scripts/", "tests/", "implementation/")

# Tuned conservatively: a false "you are repeating X" is costlier to trust than
# a missed one, because the whole value of this hook is that people believe it.
LOUD = 0.75
MENTION = 0.55


def failed_approaches(path):
    """Lines under '## Failed Approaches' up to the next heading.
    Only bullet lines — skips the instruction blockquote and trailing italics
    that the old positional parser swept up as if they were failures."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().split("\n")
    except OSError:
        return []

    out, inside = [], False
    for line in lines:
        if "Failed Approaches" in line and line.lstrip().startswith("#"):
            inside = True
            continue
        if inside:
            if line.startswith(("## ", "### ")):
                break
            s = line.strip()
            if s.startswith("- "):
                out.append(s[2:].strip())
    return out


def main():
    data = read_input()
    fp = file_path(data).replace("\\", "/")
    if not fp:
        sys.exit(0)

    # Never fire on the artifacts themselves — editing progress.md is not
    # implementation work.
    if artifact_kind(fp):
        sys.exit(0)
    if not any(fp.startswith(d) or "/" + d in fp for d in IMPL_DIRS):
        sys.exit(0)

    progress = artifact("progress")
    if not progress:
        sys.exit(0)

    failures = failed_approaches(progress)
    if not failures:
        sys.exit(0)

    change = content_of(data)

    if not _jev.enabled() or not change.strip():
        lines = "\n".join(f"  - {item[:100]}" for item in failures[:5])
        ok(f"FAILURE CHECK: {len(failures)} documented failed approach(es):\n"
           f"{lines}\n"
           "  Do NOT repeat these. The Evaluator flags repeats as a rubric penalty.")

    # One atomic question per failure, batched into a single call. Each is
    # evaluated in parallel and in isolation, so adding failures costs latency
    # only marginally — and decomposing beats one "does this repeat anything"
    # question, which would hide N judgments inside one.
    questions = {
        f"f{i}": {
            "type": "noul",
            "instructions": (
                "The state contains a documented past mistake from this "
                "codebase ('failure') and a proposed code change ('change'). "
                "Is the proposed change making that same mistake again? "
                "Answer yes only if the change actually exhibits the mistake, "
                "not merely if it touches the same area or file."
            ),
        }
        for i in range(len(failures[:12]))
    }
    # Jev is literal by design, so the state names exactly the two things the
    # instruction refers to. Send the diff, not the file: accuracy drops as the
    # state fills with detail the question does not need.
    answers = _jev.ask(
        {
            "file": fp,
            "change": change[:8000],
            "failures": {f"f{i}": t for i, t in enumerate(failures[:12])},
        },
        questions,
    )

    if answers is None:
        lines = "\n".join(f"  - {item[:100]}" for item in failures[:5])
        ok(f"FAILURE CHECK: {len(failures)} documented failed approach(es) "
           "(semantic check unavailable — listing only):\n"
           f"{lines}")

    hits, decisions = [], []
    for i, text in enumerate(failures[:12]):
        p = _jev.noul(answers, f"f{i}", default=0.0)
        if p >= LOUD:
            hits.append((p, text))
            decisions.append((f"f{i}", "likely", p))
        elif p >= MENTION:
            hits.append((p, text))
            decisions.append((f"f{i}", "possible", p))
        else:
            decisions.append((f"f{i}", "clear", p))
    hits.sort(reverse=True)
    _jev.log_decisions("failure-check", decisions)

    if not hits:
        ok(f"Failure check passed: no documented failure matches this change "
           f"({len(failures)} checked).")

    lines = "\n".join(
        f"  [{'LIKELY' if p >= LOUD else 'possible'} {p:.2f}] {text[:140]}"
        for p, text in hits[:3])
    ok("FAILURE CHECK: this change may repeat a documented failure.\n"
       f"{lines}\n"
       f"  File: {fp}\n"
       "  Advisory only — the Evaluator flags repeats as a rubric penalty.")


if __name__ == "__main__":
    main()
