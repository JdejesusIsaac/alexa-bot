---
name: evaluate
description: "Run the Harness v3 evaluation phase"
---
# /evaluate

1. `echo evaluation > .windsurf/state/phase`
2. Invoke @evaluator
3. Do NOT read progress.md or implementation reasoning
4. Read only the Sprint Contract from planning/plan.md
5. Execute all tests in evaluation/test.md
6. Grade against the rubric. Isolation failures are stop-the-line.
7. Output: Pass with scores, or Fail with bug reports
8. `echo implementation > .windsurf/state/phase`
