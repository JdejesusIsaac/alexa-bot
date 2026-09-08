#!/usr/bin/env bash
# Smoke-test every Harness hook. Run from repo root: bash .windsurf/verify-hooks.sh
H=.windsurf/hooks
pass=0; fail=0
check () { # name expected json script
  out=$(echo "$3" | python3 "$H/$4" 2>&1); code=$?
  if [ "$code" -eq "$2" ]; then echo "  ok   $1"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2, got $code)"; echo "$out" | sed 's/^/       /'; fail=$((fail+1)); fi
}
echo "Harness hook smoke test"
check "csv blocked"            2 '{"tool_info":{"file_path":"f/roster.csv"}}' student-data-guard.py
check "clean md allowed"       0 '{"tool_info":{"file_path":"research/research.md","content":"schema only"}}' student-data-guard.py
check "raw query blocked"      2 '{"tool_info":{"file_path":"src/services/a.ts","content":"await pool.query(x)"}}' tenant-isolation-guard.py
check "repo layer allowed"     0 '{"tool_info":{"file_path":"src/repositories/a.ts","content":"await pool.query(x)"}}' tenant-isolation-guard.py
check "tenantId param blocked" 2 '{"tool_info":{"file_path":"src/tools/a.ts","content":"function f(tenantId: string){}"}}' tenant-isolation-guard.py
echo "  ---"
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
