# Harness Engineering v3.0 — Parent Line

All work follows: Research → Spike → Planning → Implementation → Evaluation.

## Non-Negotiable Rules — Harness

1. **Agent Separation:** the agent that builds does NOT evaluate its own work.
2. **Artifact State:** only 4 files persist — research/research.md, planning/plan.md, implementation/progress.md, evaluation/test.md
3. **Context Budget:** research.md ≤40% of working context, others ≤20%. Compact aggressively.
4. **Failed Approaches:** ALWAYS read implementation/progress.md → "Failed Approaches" before coding. Repeating a documented failure is a rubric penalty.
5. **Spike Before Commit:** uncertain integrations get a timeboxed spike before planning.

## Non-Negotiable Rules — Parent Line

This project handles **student education records (FERPA)**. These are enforced by hooks, not trust.

6. **No real student data. Ever.** No names, student IDs, exports, screenshots, or `.csv`/`.xlsx` in the repo. Fixtures are synthetic.
7. **`tenant_id` is never a caller- or model-supplied argument.** It is derived server-side from the authenticated session. An external model fills tool arguments — a tenant parameter is cross-campus disclosure one inference away.
8. **The advisor-notes column never enters a canonical row, a response, or a log.** It carries medical and family detail. Excluded at the connector, not filtered downstream.
9. **Derived holds are staff-facing only.** A derived detention is an inference; staff may have waived it. Never parent-facing.
10. **Degrade to human, never to a guess.** Stale sync, failed validation, unreachable dependency → "let me get someone for you." A confident wrong answer about a child is worse than no answer.
11. **No query outside the repository layer.** No `pool.query` in application code.

## Phase Routing

- `/research/` → Researcher. Scope all work to the Phase 0a problem statement.
- `/planning/` → Planner. Produce plan.md + Sprint Contract.
- `/implementation/`, `/src/`, `/lib/` → Generator. Build per plan.md. Update progress.md.
- `/evaluation/`, `/tests/` → Evaluator. Grade against Sprint Contract only. You do NOT read progress.md.

## Project Context

- **Stack:** TypeScript, Node 20+, PostgreSQL 15+ (RLS forced), Drizzle + explicit SQL migrations, Zod, Vitest + Testcontainers
- **Isolation:** shared DB, shared schema, `tenant_id` on every row, RLS enabled AND forced, app role is not the table owner
- **Target runtime:** MCP server over **Streamable HTTP** (spec 2025-11-25) with **OAuth 2.1 + PKCE (S256)**. Clients: Alexa+ (parents) and Claude Desktop (staff).
- **Hard constraint:** Alexa+ enforces a **500 ms round-trip** budget. No LLM call may sit in a tool's request path. Target p95 ≤150 ms.
- **Alexa+ divergence:** 401 responses must NOT carry a `WWW-Authenticate` header.

## MCP Stack — phase routing

Tool distribution follows the 4–5 tools per agent principle. Phase routing is enforced in `.windsurf/hooks/mcp-phase-router.py`.

- **Research (0b):** brave-search, sequential-thinking
- **Planning (1):** sequential-thinking, brave-search
- **Implementation (2):** postgres/supabase
- **Evaluation (3):** playwright, puppeteer

Disable MCPs this project doesn't use (figma, flowglad, conway, upstash) rather than leaving them loaded — every unused tool definition costs context and degrades selection reliability.
