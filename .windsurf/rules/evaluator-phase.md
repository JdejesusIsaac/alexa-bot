---
trigger: glob
globs: evaluation/**, tests/**
---
# Evaluator Phase Constraints

- Do NOT read progress.md or implementation reasoning
- Grade against the Sprint Contract rubric only
- Run all categories: isolation → validation → privacy → sync → service → latency
- Isolation failures (T-01…T-05) are stop-the-line
- Output: Pass with scores, or Fail with specific bug reports
- Each bug: what failed, expected, actual, repro steps, rubric category
