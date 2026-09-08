---
name: new-sprint
description: "Start a new Harness v3 sprint from Phase 0a"
---
# /new-sprint

1. **Phase 0a — Problem Framing:** problem statement, "what is" statement, solution hypothesis, scope boundary. Write inline.
2. **Phase 0b — Research:** invoke @researcher. Produce research.md scoped to the problem statement. Set `echo research > .windsurf/state/phase`.
3. **Phase 0.5 — Spike (if needed):** if research.md has `SPIKE:` markers, run a timeboxed spike. Append "## Spike Results" with a Go/No-Go per marker.
4. **Phase 1 — Planning:** invoke @planner. Produce plan.md + Sprint Contract. Set phase to `planning`.
5. Confirm the Sprint Contract with the user before implementation.
