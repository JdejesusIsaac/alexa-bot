#!/usr/bin/env python3
"""
Harness Hook: Spike Validation Gate  (Jev-backed)

Blocks writes to the plan artifact while research.md still carries unresolved
spike markers. Exit 2 = BLOCK.

v2: denials go to stderr (the stream the agent sees on exit 2); Jev decisions
are logged to .windsurf/state/jev-decisions.jsonl for threshold tuning.

BLOCKING POLICY — asymmetric on purpose:
  - Deterministic evidence blocks: markers present and no Spike Results section
    at all. Same as before.
  - Jev can block *more precisely* (a marker its own results section does not
    resolve), but only well below the uncertainty band.
  - Jev being unavailable NEVER blocks. It falls back to the old boolean.
    A vendor outage must not stop planning.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path, artifact_for, is_artifact, block, ok
import _jev

# Matches SPIKE:, `SPIKE`, **SPIKE**, SPIKE (open) — anything on a line that
# announces an unresolved investigation.
MARKER = re.compile(r"(^|[\s`*_(\[])SPIKE\b", re.MULTILINE)
RESULTS = re.compile(r"^#{2,4}\s+Spike Results\s*$", re.MULTILINE | re.IGNORECASE)

UNRESOLVED = 0.35   # below this -> block. Deliberately far from 0.5.
UNCERTAIN = 0.65    # between -> warn, allow.


def marker_lines(text):
    """The full line around each marker, deduped, in document order."""
    seen, out = set(), []
    for m in MARKER.finditer(text):
        start = text.rfind("\n", 0, m.start()) + 1
        end = text.find("\n", m.start())
        line = text[start:end if end != -1 else len(text)].strip()
        if line and line not in seen:
            seen.add(line)
            out.append(line)
    return out


def main():
    fp = file_path(read_input()).replace("\\", "/")
    if not is_artifact(fp, "plan"):
        sys.exit(0)

    research = artifact_for(fp, "research")
    if not research:
        block("SPIKE GATE: no research.md found (canonical or sprint-*/).\n"
              "  Complete Phase 0b before planning.")

    try:
        with open(research, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        sys.exit(0)   # unreadable research is not the developer's fault

    markers = marker_lines(content)
    if not markers:
        sys.exit(0)

    if not RESULTS.search(content):
        lines = "\n".join(f"  - {line[:120]}" for line in markers[:5])
        block(f"SPIKE GATE: {len(markers)} spike marker(s) in {research}, "
              "no 'Spike Results' section.\n"
              f"{lines}\n"
              "  Complete Phase 0.5 before planning.\n"
              "  Protocol: timebox -> Go/No-Go -> append results to research.md")

    # A Spike Results section exists. Old behaviour stopped here and allowed the
    # write. Ask whether it actually resolves each marker.
    results = content[RESULTS.search(content).start():]

    if not _jev.enabled():
        ok(f"Spike gate passed: {len(markers)} marker(s), Spike Results present "
           "(no semantic check — TYPESAFE_API_KEY unset).")

    questions = {
        f"m{i}": {
            "type": "noul",
            "instructions": (
                "The state contains one spike marker from a research document "
                "('marker') and that document's Spike Results section "
                "('results'). Does the results section report a completed "
                "outcome for this specific marker — a finding, a Go/No-Go, or a "
                "decision? Answer no if the marker is only restated, still "
                "labelled open, or describes a method without an outcome."
            ),
        }
        for i in range(len(markers[:10]))
    }
    answers = _jev.ask(
        {
            "results": results[:14000],
            "markers": {f"m{i}": line for i, line in enumerate(markers[:10])},
        },
        questions,
    )

    if answers is None:
        ok(f"Spike gate passed: {len(markers)} marker(s), Spike Results present "
           "(semantic check unavailable).")

    blocking, uncertain, decisions = [], [], []
    for i, line in enumerate(markers[:10]):
        p = _jev.noul(answers, f"m{i}", default=1.0)   # absent answer != unresolved
        if p < UNRESOLVED:
            blocking.append((p, line))
            decisions.append((f"m{i}", "unresolved", p))
        elif p < UNCERTAIN:
            uncertain.append((p, line))
            decisions.append((f"m{i}", "uncertain", p))
        else:
            decisions.append((f"m{i}", "resolved", p))
    _jev.log_decisions("spike-gate", decisions)

    if blocking:
        lines = "\n".join(f"  [{p:.2f}] {line[:120]}" for p, line in blocking)
        block(f"SPIKE GATE: {len(blocking)} spike marker(s) not resolved by "
              f"the Spike Results section in {research}.\n"
              f"{lines}\n"
              "  Append an outcome (finding + Go/No-Go) for each, then plan.\n"
              "  A 'No-Go' or 'this turned out not to matter' IS a valid outcome.")

    if uncertain:
        lines = "\n".join(f"  [{p:.2f}] {line[:120]}" for p, line in uncertain)
        ok("Spike gate passed with warnings — these markers read as "
           f"partially resolved:\n{lines}")

    ok(f"Spike gate passed: {len(markers)} marker(s), all resolved.")


if __name__ == "__main__":
    main()
