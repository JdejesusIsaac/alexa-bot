#!/usr/bin/env bash
# Pre-flight receipt (PL-273, T-86).
#
# The evaluation contract requires this script's output, verbatim, in the
# evaluation report — a report without it is incomplete regardless of
# score. A and B (isolation default-on, the suite's superuser refusal)
# are the enforcement; this is the receipt.
#
# It prints four sections and exits non-zero if any item failed:
#   1. Phase state    — CHECKED AND BOUND (T-90/T-91): the receipt fails
#                       unless THIS conversation's resolved phase is
#                       `evaluation`. Resolution: PREFLIGHT_TRAJECTORY_ID
#                       pin, then the isolation hook's last-trajectory
#                       marker, then a single phase.* file. The global
#                       file is informational only. Failures are
#                       classified WRONG PHASE vs ISOLATION HOOK BROKEN
#                       in the exit summary — different fixes.
#   2. Hooks          — verify-hooks.sh (expect 11/11)
#   3. Database posture — current_user + superuser/owner status per
#                        connection string
#   4. Verify         — npm run verify's exit code
#
# PREFLIGHT_STATE_DIR overrides the harness state dir (hermetic testing).
#
# The script NEVER sources .env (the multi-line
# secrets are files referenced by path since PL-292). It reads exported environment
# only; an absent variable is a reported failed item, not a crash.
#
# PREFLIGHT_SKIP_VERIFY=1 is a self-test mode used by T-86 so the suite
# does not re-run the suite; it is printed as skipped when used. The
# evaluator never sets it.
set -u

FAIL=0
# The harness state dir; overridable so the phase legs (T-90) run
# hermetically against a temp dir — the PREFLIGHT_SKIP_VERIFY precedent.
S="${PREFLIGHT_STATE_DIR:-.windsurf/state}"

echo "=== preflight: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ── 1. Phase state (a CHECKED item — T-90, bound in T-91) ────────────
# The receipt ASSERTS that the conversation running it is in the
# evaluation phase — not merely that some phase state exists (a foreign
# conversation's `implementation` posed as the running conversation's
# phase in the Sprint 6 receipt — F-7). Resolution, in order:
#   1. PREFLIGHT_TRAJECTORY_ID — the explicit pin
#   2. $S/last-trajectory — the isolation hook's marker, refreshed by
#      every read/command including this script's own invocation
#   3. a single phase.* file — the only conversation on record
#   4. unresolvable — the stated fallback: multiple phase files and
#      none reads `evaluation` is a fail; at least one is a pass that
#      is printed as UNBOUND so nobody mistakes it for a binding.
# The legacy global `phase` file is printed informationally only and
# can never satisfy the check. Failures classify as either
#   WRONG PHASE — this conversation's resolved phase is not evaluation
#     (fix: run the receipt inside an /evaluate conversation), or
#   ISOLATION HOOK BROKEN — the machinery produced no usable evidence of
#     this conversation (fix: verify .windsurf/hooks are wired).
echo
echo "--- 1. Phase state ---"
PHASE_ITEM_FAILED=0
PHASE_KIND=""
PHASE_DETAIL=""

fail_phase() { # kind detail
  PHASE_ITEM_FAILED=1
  PHASE_KIND="$1"
  PHASE_DETAIL="$2"
}

valid_phase() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    research|planning|implementation|evaluation) return 0 ;;
    *) return 1 ;;
  esac
}

# The global file: printed, never satisfying (informational only).
if [ -f "$S/phase" ]; then
  GLOBAL_PHASE="$(tr -d '[:space:]' < "$S/phase")"
  echo "global phase file: $GLOBAL_PHASE (informational only — cannot satisfy this check)"
  if ! valid_phase "$GLOBAL_PHASE"; then
    echo "global phase file: INVALID VALUE '$GLOBAL_PHASE' — failed item"
    fail_phase "ISOLATION HOOK BROKEN" "the global phase file holds '$GLOBAL_PHASE' — the phase writer is producing garbage"
  fi
else
  echo "global phase file: absent (informational only)"
fi

# List every per-conversation phase file with its contents — foreign
# files are LABELED as such once this conversation resolves.
N_PHASE_FILES=0
HAS_EVALUATION=0
for f in "$S"/phase.*; do
  [ -e "$f" ] || continue
  N_PHASE_FILES=$((N_PHASE_FILES + 1))
  VALUE="$(cat "$f")"
  echo "$f: $VALUE"
  if ! valid_phase "$VALUE"; then
    echo "$f: INVALID VALUE '$VALUE' — failed item"
    fail_phase "ISOLATION HOOK BROKEN" "$f holds '$VALUE' — the phase writer is producing garbage"
  elif [ "$(printf '%s' "$VALUE" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" = "evaluation" ]; then
    HAS_EVALUATION=1
  fi
done
if [ "$N_PHASE_FILES" -eq 0 ]; then
  echo "per-conversation phase files: none"
fi

# Resolve THIS conversation.
OWN_TID=""
OWN_SOURCE=""
if [ -n "${PREFLIGHT_TRAJECTORY_ID:-}" ]; then
  OWN_TID="${PREFLIGHT_TRAJECTORY_ID//[^A-Za-z0-9._-]/_}"
  OWN_SOURCE="PREFLIGHT_TRAJECTORY_ID pin"
elif [ -f "$S/last-trajectory" ]; then
  MARKED="$(tr -d '[:space:]' < "$S/last-trajectory")"
  if [ -n "$MARKED" ]; then
    OWN_TID="${MARKED//[^A-Za-z0-9._-]/_}"
    OWN_SOURCE="isolation hook marker (last-trajectory)"
  fi
fi
if [ -z "$OWN_TID" ] && [ "$N_PHASE_FILES" -eq 1 ]; then
  for f in "$S"/phase.*; do OWN_TID="$(basename "$f")"; done
  OWN_TID="${OWN_TID#phase.}"
  OWN_SOURCE="only phase file on record"
fi
if [ -n "$OWN_TID" ]; then
  echo "resolved conversation: $OWN_TID ($OWN_SOURCE)"
fi

if [ -n "$OWN_TID" ]; then
  OWN="$S/phase.$OWN_TID"
  if [ -f "$OWN" ]; then
    OWN_VALUE="$(tr -d '[:space:]' < "$OWN" | tr '[:upper:]' '[:lower:]')"
    echo "this conversation's phase ($OWN_TID): $OWN_VALUE"
    if [ "$OWN_VALUE" = "evaluation" ]; then
      echo "phase binding: PASS — the receipt runs inside an evaluation conversation"
    elif valid_phase "$OWN_VALUE"; then
      fail_phase "WRONG PHASE" "this conversation resolved to '$OWN_VALUE' ($OWN via $OWN_SOURCE); the receipt attests isolation and must run inside an /evaluate conversation"
      echo "this conversation's phase: '$OWN_VALUE' — not evaluation — failed item"
    else
      fail_phase "ISOLATION HOOK BROKEN" "$OWN holds '$OWN_VALUE' — not a valid phase"
      echo "this conversation's phase: INVALID VALUE '$OWN_VALUE' — failed item"
    fi
  else
    echo "no phase file for conversation $OWN_TID — failed item"
    if [ "$OWN_SOURCE" = "isolation hook marker (last-trajectory)" ]; then
      # The hook runs (it just marked this call) but phase-writer never
      # wrote — this conversation simply never declared a phase.
      fail_phase "WRONG PHASE" "conversation $OWN_TID never declared a phase (no $OWN); start the evaluation conversation with /evaluate"
    else
      fail_phase "ISOLATION HOOK BROKEN" "no phase.$OWN_TID and no hook marker — nothing produced this conversation's phase"
    fi
  fi
elif [ "$N_PHASE_FILES" -eq 0 ]; then
  echo "phase state: NONE — failed item (no phase discipline in use; start a conversation with /implement, /evaluate, /research, or /plan)"
  fail_phase "ISOLATION HOOK BROKEN" "no marker, no pin, no phase files — the isolation machinery produced nothing to bind"
elif [ "$HAS_EVALUATION" -eq 1 ]; then
  echo "phase binding: UNBOUND PASS — $N_PHASE_FILES conversations on record, one reads evaluation; set PREFLIGHT_TRAJECTORY_ID to bind this conversation specifically"
else
  echo "phase binding: FAILED — $N_PHASE_FILES phase files on record and none reads evaluation"
  fail_phase "WRONG PHASE" "no resolved conversation and no phase file reads evaluation — either this is not an /evaluate conversation or phase-writer is not wired"
fi

if [ "$PHASE_ITEM_FAILED" -ne 0 ]; then
  FAIL=1
fi

# ── 2. Hooks ─────────────────────────────────────────────────────────
echo
echo "--- 2. verify-hooks.sh (expect 11 cases) ---"
if bash .windsurf/verify-hooks.sh; then
  echo "hooks: PASS"
else
  echo "hooks: FAIL"
  FAIL=1
fi

# ── 3. Database posture ──────────────────────────────────────────────
# current_user and its privilege posture for each connection string.
# A privileged APP role is a failed item (the suite refuses it, T-85);
# a privileged DATABASE_URL role is the normal owner/migrator posture
# and is reported informationally.
echo
echo "--- 3. Database posture ---"
if node --input-type=module <<'NODE_EOF'
import { Client } from 'pg';

const items = [
  ['DATABASE_URL', process.env.DATABASE_URL, false],
  ['APP_DATABASE_URL', process.env.APP_DATABASE_URL, true],
];
let failed = 0;

for (const [name, url, appRole] of items) {
  if (!url) {
    console.log(`${name}: NOT SET (failed item — export it; never source .env)`);
    failed = 1;
    continue;
  }
  let client;
  try {
    client = new Client({ connectionString: url });
    await client.connect();
    const r = await client.query(
      `select current_user as role,
              (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
              (select rolbypassrls from pg_roles where rolname = current_user) as rolbypassrls,
              (select pg_database.datdba = (select oid from pg_roles where rolname = current_user)
                 from pg_database where datname = current_database()) as owns_database`,
    );
    const row = r.rows[0];
    const privileged = row.rolsuper || row.rolbypassrls || row.owns_database;
    const posture =
      `current_user=${row.role}` +
      ` superuser=${row.rolsuper}` +
      ` bypassrls=${row.rolbypassrls}` +
      ` owns_database=${row.owns_database}`;
    if (appRole && privileged) {
      console.log(`${name}: ${posture} — FAILED ITEM (the suite refuses a privileged app role, T-85)`);
      failed = 1;
    } else if (appRole) {
      console.log(`${name}: ${posture}`);
    } else {
      console.log(`${name}: ${posture} (owner/migrator role — informational)`);
    }
  } catch (err) {
    console.log(`${name}: CONNECT FAILED — ${err instanceof Error ? err.message : String(err)}`);
    failed = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
NODE_EOF
then
  :
else
  FAIL=1
fi

# ── 4. Verify ────────────────────────────────────────────────────────
echo
echo "--- 4. npm run verify ---"
if [ "${PREFLIGHT_SKIP_VERIFY:-0}" = "1" ]; then
  echo "verify: skipped (self-test mode — T-86)"
else
  VERIFY_LOG=$(mktemp)
  if npm run verify >"$VERIFY_LOG" 2>&1; then
    echo "verify: PASS (exit 0)"
  else
    CODE=$?
    echo "verify: FAIL (exit $CODE)"
    FAIL=1
    echo "--- last 20 lines of verify output ---"
    tail -20 "$VERIFY_LOG"
    echo "--- end verify tail ---"
  fi
  rm -f "$VERIFY_LOG"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "preflight: PASS"
  exit 0
else
  echo "preflight: FAIL — a pre-flight item failed. If you cannot satisfy"
  echo "one, say so in the FIRST line of the report, not as a caveat at the end."
  if [ -n "$PHASE_KIND" ]; then
    echo "  phase: $PHASE_KIND — $PHASE_DETAIL"
  fi
  exit 1
fi
