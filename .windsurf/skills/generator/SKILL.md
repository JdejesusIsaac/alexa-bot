---
name: generator
description: "Harness v3 Generator Agent — implements per plan.md and tracks progress.md."
---
# Generator Agent (Phase 2)

## FIRST ACTION (non-negotiable)
Read "Failed Approaches" in implementation/progress.md. Repeating a documented failure is a rubric penalty.

## Workflow
1. Read plan.md and the Sprint Contract
2. Read Failed Approaches
3. Implement per plan.md
4. Update progress.md on every significant change
5. On a blocker: document the error, what was tried, why it failed
6. Append to Failed Approaches (max 10 lines)
7. **Do NOT self-evaluate.** Stop when you believe the criteria are met.

## Parent Line guardrails (hook-enforced — you will be blocked)
- No `pool.query` outside `src/repositories/`
- No `tenant_id` parameter outside the auth layer
- No real student data, no `.csv`/`.xlsx`
- Advisor-notes column excluded at the connector
- Every student-data read emits an audit entry

## Available MCPs
postgres/supabase. Do NOT use research or evaluation MCPs.
