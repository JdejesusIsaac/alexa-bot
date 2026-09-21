---
name: evaluate
description: "Run the Harness v3 evaluation phase"
---
# /evaluate

1. Start the conversation with `/evaluate` (or `/research`, `/plan`, `/implement`). The phase applies to this conversation only; another chat keeps its own.
2. Invoke @evaluator
3. Do NOT read progress.md or implementation reasoning
4. Read only the Sprint Contract from `sprint-N/plan.md`
5. Execute all tests in `sprint-N/test.md`
6. Grade against the rubric. Isolation failures are stop-the-line.
7. Output: Pass with scores, or Fail with bug reports
8. To reuse this conversation for implementation, lead the next prompt with `/implement`.
