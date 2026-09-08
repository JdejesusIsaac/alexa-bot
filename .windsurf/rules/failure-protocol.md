---
trigger: always_on
---
# Failure Loop Protocol

When evaluation fails:
1. The bug report becomes the new sprint input
2. Append to progress.md "Failed Approaches" (max 10 lines)
3. Compact the rest of progress.md
4. Generate a new Sprint Contract scoped to the failures
5. Rubric weights may shift based on failure type
6. The Generator MUST read Failed Approaches before restarting
