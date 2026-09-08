---
trigger: glob
globs: implementation/**, src/**, lib/**, scripts/**
---
# Generator Phase Constraints

- Read progress.md "Failed Approaches" before writing any code
- Repeating a documented failed approach = rubric penalty
- Update progress.md on every significant code change
- Deviate from plan.md ONLY on a blocker — document immediately
- No `pool.query` outside the repository layer
- No `tenant_id` parameter in exported signatures outside the auth layer
- Every student-data read emits an audit entry
