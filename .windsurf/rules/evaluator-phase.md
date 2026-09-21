---
trigger: glob
globs: evaluation/**, tests/**, sprint-*/test.md
---
# Evaluator Phase Constraints

- Do NOT read progress.md or implementation reasoning
- Grade against the Sprint Contract rubric only
- Run all categories: isolation → validation → privacy → sync → service → latency
- Isolation failures (the standing gate in sprint-N/test.md) are stop-the-line
- Output: Pass with scores, or Fail with specific bug reports
- Each bug: what failed, expected, actual, repro steps, rubric category
