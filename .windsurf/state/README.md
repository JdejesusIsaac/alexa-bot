# Machine-local harness state. Everything here is gitignored except this README.
# Phase is per-conversation: phase.<trajectory_id>, written by phase-writer.py
# when a prompt leads with /evaluate, /research, /plan, or /implement.
# The legacy global `phase` file still works as a fallback:
#   mkdir -p .windsurf/state && echo evaluation > .windsurf/state/phase
# payloads/ holds step-0 captures; jev-decisions.jsonl is the tuning log.
