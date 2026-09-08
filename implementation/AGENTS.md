# Implementation Phase (Phase 2)

- FIRST ACTION: read "Failed Approaches" in progress.md
- Build per plan.md. Deviate only on blockers — document immediately
- Update progress.md on every significant change
- Failed Approaches section: max 10 lines, persists across resets
- You do NOT evaluate your own work. Period.

## Parent Line guardrails
- No `pool.query` outside `src/repositories/`
- No `tenant_id` in any exported function signature outside the auth layer
- No student names, IDs, or real data in code, tests, or fixtures
- Every student-data read writes an audit entry
- Every failure path returns a typed refusal, never an empty success
