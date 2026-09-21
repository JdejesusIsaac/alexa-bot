#!/usr/bin/env python3
"""
Harness Hook: Spike Validation Gate  (Jev-backed)

Blocks writes to the plan artifact while research.md still carries unresolved
spike markers. Exit 2 = BLOCK.

WHY THIS CHANGED (harness review, 2026-09-20):
  1. It only fired on paths containing "planning/", so sprint-N/plan.md never
     matched. Inert.
  2. It counted the literal string "SPIKE:" — the Sprint 3/4/5 research files
     write `SPIKE` in backticks with no colon, so they registered zero markers.
  3. Resolution was one repo-wide boolean: a single "## Spike Results" heading
     anywhere satisfied any number of markers, forever. Already on the deferred
     list as "tighten the spike gate to match markers to resolutions."

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
from _common import read_input, file_path, artifact_for, is_artifact
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
        print("SPIKE GATE: no research.md found (canonical or sprint-*/).")
        print("  Complete Phase 0b before planning.")
        sys.exit(2)

    try:
        with open(research, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        sys.exit(0)   # unreadable research is not the developer's fault

    markers = marker_lines(content)
    if not markers:
        sys.exit(0)

    if not RESULTS.search(content):
        print(f"SPIKE GATE: {len(markers)} spike marker(s) in {research}, "
              "no 'Spike Results' section.")
        for line in markers[:5]:
            print(f"  - {line[:120]}")
        print("  Complete Phase 0.5 before planning.")
        print("  Protocol: timebox -> Go/No-Go -> append results to research.md")
        sys.exit(2)

    # A Spike Results section exists. Old behaviour stopped here and allowed the
    # write. Ask whether it actually resolves each marker.
    results = content[RESULTS.search(content).start():]

    if not _jev.enabled():
        print(f"Spike gate passed: {len(markers)} marker(s), Spike Results present "
              "(no semantic check — TYPESAFE_API_KEY unset).")
        sys.exit(0)

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
        print(f"Spike gate passed: {len(markers)} marker(s), Spike Results present "
              "(semantic check unavailable).")
        sys.exit(0)

    blocking, uncertain = [], []
    for i, line in enumerate(markers[:10]):
        p = _jev.noul(answers, f"m{i}", default=1.0)   # absent answer != unresolved
        if p < UNRESOLVED:
            blocking.append((p, line))
        elif p < UNCERTAIN:
            uncertain.append((p, line))

    if blocking:
        print(f"SPIKE GATE: {len(blocking)} spike marker(s) not resolved by "
              f"the Spike Results section in {research}.")
        for p, line in blocking:
            print(f"  [{p:.2f}] {line[:120]}")
        print("  Append an outcome (finding + Go/No-Go) for each, then plan.")
        print("  A 'No-Go' or 'this turned out not to matter' IS a valid outcome.")
        sys.exit(2)

    if uncertain:
        print("Spike gate passed with warnings — these markers read as "
              "partially resolved:")
        for p, line in uncertain:
            print(f"  [{p:.2f}] {line[:120]}")
        sys.exit(0)

    print(f"Spike gate passed: {len(markers)} marker(s), all resolved.")
    sys.exit(0)


if __name__ == "__main__":
    main()
