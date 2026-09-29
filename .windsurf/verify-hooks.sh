#!/usr/bin/env bash
# Smoke-test every Harness v2 hook. Run from repo root: bash .windsurf/verify-hooks.sh
#
# v2 checks the STREAM, not just the exit code: on exit 2 the Cascade agent
# sees stderr, so a block case also asserts stderr is non-empty. v1 printed
# reasons to stdout — the block worked and the agent was never told why.
#
# v3 (Sprint AUTH, PL-271) adds the eleventh case: isolation is default-ON.
# A conversation with no phase of its own must be blocked from progress.md
# and smoke.log even while the legacy global file says 'implementation' —
# the exact configuration of the Sprint 3.1 evaluation breach. Restoring the
# old allow-unless-'evaluation' logic fails this case, which is the point.
H=.windsurf/hooks
S=.windsurf/state
ERR=$(mktemp)
pass=0; fail=0

# Per-conversation phase files written/consumed by the tests below.
TID_EVAL=verify-hooks-eval
TID_IMPL=verify-hooks-impl
# Deliberately never given a phase file of its own.
TID_UNPHASED=verify-hooks-unphased
cleanup() {
  rm -f "$ERR" "$S/phase.$TID_EVAL" "$S/phase.$TID_IMPL" "$S/phase.$TID_UNPHASED" "$S/phase.unphased-bak" "$S/last-trajectory"
}
trap cleanup EXIT

check () { # name expected_exit json script [stderr]
  out=$(echo "$3" | python3 "$H/$4" 2>"$ERR"); code=$?
  if [ "$code" -ne "$2" ]; then
    echo "  FAIL $1 (expected exit $2, got $code)"; sed 's/^/       /' "$ERR"; fail=$((fail+1)); return
  fi
  if [ "$5" = "stderr" ] && [ ! -s "$ERR" ]; then
    echo "  FAIL $1 (blocked but stderr empty — agent sees no reason)"; fail=$((fail+1)); return
  fi
  echo "  ok   $1"; pass=$((pass+1))
}

echo "Harness hook smoke test (v2)"

echo "  -- student data guard"
check "csv blocked, reason on stderr" 2 '{"tool_info":{"file_path":"f/roster.csv"}}' student-data-guard.py stderr

echo "  -- tenant isolation guard"
check "raw query blocked, stderr"     2 '{"tool_info":{"file_path":"src/services/a.ts","content":"await pool.query(x)"}}' tenant-isolation-guard.py stderr
check "repo layer allowed"            0 '{"tool_info":{"file_path":"src/repositories/a.ts","content":"await pool.query(x)"}}' tenant-isolation-guard.py

echo "  -- budget guard"
check "non-artifact ignored"          0 '{"tool_info":{"file_path":"src/index.ts"}}' artifact-budget-guard.py

echo "  -- failure check (advisory, never blocks)"
check "src edit via edits[] allowed"  0 '{"tool_info":{"file_path":"src/a.ts","edits":[{"old_string":"a","new_string":"const x = 1"}]}}' failure-check.py

echo "  -- phase writer (per-conversation)"
check "/evaluate sets phase"          0 '{"trajectory_id":"verify-hooks-eval","tool_info":{"user_prompt":"/evaluate the sprint"}}' phase-writer.py
if [ "$(cat "$S/phase.$TID_EVAL" 2>/dev/null)" = "evaluation" ]; then :; else
  echo "  FAIL /evaluate wrote no phase file"; fail=$((fail+1))
fi
echo implementation > "$S/phase.$TID_IMPL" 2>/dev/null || { mkdir -p "$S"; echo implementation > "$S/phase.$TID_IMPL"; }

echo "  -- evaluator isolation (read + terminal)"
check "read progress.md blocked"      2 '{"trajectory_id":"verify-hooks-eval","tool_info":{"file_path":"sprint-3/progress.md"}}' evaluator-isolation.py stderr
check "same read allowed in impl"     0 '{"trajectory_id":"verify-hooks-impl","tool_info":{"file_path":"sprint-3/progress.md"}}' evaluator-isolation.py
check "cat progress.md blocked"       2 '{"trajectory_id":"verify-hooks-eval","tool_info":{"command_line":"cat sprint-3/progress.md"}}' evaluator-isolation.py stderr

echo "  -- evaluator isolation (default on — PL-271)"
# The Sprint 3.1 breach as a test: a conversation with no phase of its
# own, while the legacy global file says implementation, must still be
# blocked — from progress.md, from smoke.log, and with no trajectory id
# at all. One case; three invocations. Restoring the old allow-unless-
# 'evaluation' logic fails it, which is the mutation proof.
GLOBAL="$S/phase"
if [ -f "$GLOBAL" ]; then cp "$GLOBAL" "$S/phase.unphased-bak"; fi
echo implementation > "$GLOBAL"
UNPHASED_OK=1
for PAYLOAD in \
  '{"trajectory_id":"verify-hooks-unphased","tool_info":{"file_path":"sprint-3/progress.md"}}' \
  '{"trajectory_id":"verify-hooks-unphased","tool_info":{"file_path":"soak/smoke.log"}}' \
  '{"tool_info":{"file_path":"sprint-3/progress.md"}}' \
  '{"tool_info":{"command_line":"cat soak/smoke.log"}}'; do
  echo "$PAYLOAD" | python3 "$H/evaluator-isolation.py" >/dev/null 2>"$ERR"
  CODE=$?
  if [ "$CODE" -ne 2 ] || [ ! -s "$ERR" ]; then UNPHASED_OK=0; fi
done
if [ "$UNPHASED_OK" -eq 1 ]; then
  echo "  ok   unphased conversation blocked (progress.md + smoke.log, global says implementation)"
  pass=$((pass+1))
else
  echo "  FAIL unphased conversation reads freely — isolation is not default-on"
  sed 's/^/       /' "$ERR"
  fail=$((fail+1))
fi
if [ -f "$S/phase.unphased-bak" ]; then mv "$S/phase.unphased-bak" "$GLOBAL"; else rm -f "$GLOBAL"; fi

echo "  -- mcp phase router"
if [ -f .windsurf/mcp-phases.json ]; then
  check "unassigned server blocked"   2 '{"trajectory_id":"verify-hooks-eval","tool_info":{"mcp_server_name":"conway"}}' mcp-phase-router.py stderr
else
  check "no phases file -> warn only" 0 '{"trajectory_id":"verify-hooks-eval","tool_info":{"mcp_server_name":"conway"}}' mcp-phase-router.py
fi

echo "  ---"
echo "  $pass passed, $fail failed (expect 11 cases)"
[ "$fail" -eq 0 ] || exit 1
