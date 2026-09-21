#!/usr/bin/env bash
# Smoke-test every Harness hook. Run from repo root: bash .windsurf/verify-hooks.sh
#
# CHANGED 2026-09-20: the old version covered 2 of 7 hooks and used canonical
# v3 fixture paths (research/research.md), so it passed while the hooks were
# inert against the sprint-N/ paths the project actually uses. A green check
# measuring the wrong thing is the Sprint 2 F-2 failure in the harness itself.
H=.windsurf/hooks
pass=0; fail=0
check () { # name expected_exit json script
  out=$(echo "$3" | python3 "$H/$4" 2>&1); code=$?
  if [ "$code" -eq "$2" ]; then echo "  ok   $1"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2, got $code)"; echo "$out" | sed 's/^/       /'; fail=$((fail+1)); fi
}

echo "Harness hook smoke test"
echo "  -- student data guard"
check "csv blocked"             2 '{"tool_info":{"file_path":"f/roster.csv"}}' student-data-guard.py
check "clean md allowed"        0 '{"tool_info":{"file_path":"sprint-3/research.md","content":"schema only"}}' student-data-guard.py

echo "  -- tenant isolation guard"
check "raw query blocked"       2 '{"tool_info":{"file_path":"src/services/a.ts","content":"await pool.query(x)"}}' tenant-isolation-guard.py
check "repo layer allowed"      0 '{"tool_info":{"file_path":"src/repositories/a.ts","content":"await pool.query(x)"}}' tenant-isolation-guard.py
check "tenantId param blocked"  2 '{"tool_info":{"file_path":"src/tools/a.ts","content":"function f(tenantId: string){}"}}' tenant-isolation-guard.py

echo "  -- budget guard (sprint paths)"
check "non-artifact ignored"    0 '{"tool_info":{"file_path":"src/index.ts"}}' artifact-budget-guard.py
check "sprint plan recognised"  0 '{"tool_info":{"file_path":"sprint-3/plan.md"}}' artifact-budget-guard.py

echo "  -- evaluator isolation"
check "non-progress allowed"    0 '{"tool_info":{"file_path":"sprint-3/plan.md"}}' evaluator-isolation.py
if [ "$(cat .windsurf/state/phase 2>/dev/null)" = "evaluation" ]; then
  check "progress blocked in eval" 2 '{"tool_info":{"file_path":"sprint-3/progress.md"}}' evaluator-isolation.py
else
  echo "  skip progress-blocked-in-eval (phase is not 'evaluation')"
fi

echo "  -- spike gate"
check "non-plan ignored"        0 '{"tool_info":{"file_path":"src/index.ts"}}' spike-gate.py

echo "  -- failure check (advisory, never blocks)"
check "src write advisory"      0 '{"tool_info":{"file_path":"src/a.ts","content":"const x = 1"}}' failure-check.py
check "artifact write ignored"  0 '{"tool_info":{"file_path":"sprint-3/progress.md","content":"x"}}' failure-check.py

echo "  -- mcp phase router"
check "unknown server warns"    0 '{"server_name":"unknown-server"}' mcp-phase-router.py

echo "  ---"
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
