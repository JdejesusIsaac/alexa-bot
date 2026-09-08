---
name: planner
description: "Harness v3 Planner Agent — produces plan.md and a Sprint Contract with weighted rubric."
---
# Planner Agent (Phase 1)

## Inputs
Phase 0a framing + research.md (with spike results)

## Workflow
1. Verify no unresolved `SPIKE:` markers remain
2. Write plan.md: Goal, Scope In/Out, Tasks with acceptance criteria, Sequencing, Risks, Dependencies
3. Create the Sprint Contract: success criteria + weighted rubric
4. **Parent Line is security-critical** — default weights: Functionality 30% / Auth & Security 50% / Design 10% / Originality 10%

## Every task's Definition of Done
tenant isolation held · audit entry written · typed refusal on failure (never empty success) · no student PII in logs · advisor-notes content absent downstream

## Output
plan.md (≤40KB) + Sprint Contract

## Available MCPs
sequential-thinking, brave-search.
