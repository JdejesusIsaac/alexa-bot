# Parent Line

A parent asks a routine question — "where is my scholar?" — and gets a verified, consistent answer without pulling a staff member off dismissal duty.

**The payload is student education records (FERPA).** Every design decision is downstream of that fact.

Sprint 1 builds the deterministic core: scheduled roster ingestion, validation, enforced tenant isolation, and one audited read. **No voice, no LLM, no MCP server** — those come later, on top of a core where being wrong is unacceptable.

## Non-negotiables

These are enforced by lint rules, database grants, and CI — not by convention.

| Rule | Enforced by |
|---|---|
| No real student data, ever. Fixtures are synthetic | `.gitignore`, CI tree check, `.windsurf/hooks/student-data-guard.py` |
| `tenant_id` is never a caller-supplied argument — it is derived from the session | ESLint `no-restricted-syntax`, `tenant-isolation-guard.py` |
| No query outside the repository layer | ESLint, scoped per-directory |
| The advisor-notes column never enters a canonical row, response, or log | Excluded at the connector (PL-004/PL-005), test T-19 |
| Derived holds are staff-facing only | Service-level block, test T-21 |
| Degrade to human, never to a guess | Typed refusals, test T-15 |

## Setup

Requires **Node 20+** and a reachable **PostgreSQL 15+**. No Docker needed — see `research/research.md` AD-11.

```bash
npm install
cp .env.example .env        # then edit
createdb parentline_dev
npm run migrate
npm run verify              # typecheck + lint + test
```

### Two database roles, deliberately

`DATABASE_URL` is an **owner** connection that runs migrations. `APP_DATABASE_URL` is a **non-owner, non-superuser** connection that serves reads.

This is not ceremony. **Table owners and superusers bypass RLS silently.** If the application connects as the owner, every isolation test passes and production leaks. `APP_DATABASE_URL` is required in production for exactly this reason, and test T-05 aborts the suite if the effective role can bypass RLS.

## Scripts

| Command | Purpose |
|---|---|
| `npm run verify` | The CI gate: typecheck → lint → test |
| `npm run test:isolation` | T-01…T-05 only. Run before every commit |
| `npm run migrate` | Apply migrations as the owner role |
| `npm run lint` | Includes the rule 7 and rule 11 guardrails |

## Layout

```
research/research.md        durable context — read first, every session
planning/plan.md            tasks + Sprint Contract (the grading rubric)
implementation/progress.md  task board, session log, Failed Approaches
evaluation/test.md          T-01…T-23 definitions
src/                        application code
tests/                      isolation gate + suite
spike/                      throwaway spikes; deleted at sprint end
```

Development follows Harness Engineering v3: Research → Spike → Planning → Implementation → Evaluation. The agent that builds does not evaluate its own work. See `AGENTS.md`.

## Status

Sprint 1, PL-001 complete. `PL-005` (Google Sheets connector) is blocked pending read-only OAuth credentials and a test sheet.
