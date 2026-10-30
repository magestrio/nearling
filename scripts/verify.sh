#!/usr/bin/env bash
# The full run of the game repo.
#
#   bash scripts/verify.sh [<change>] [--only contract,server,web,e2e,screens]
#
# One line per step: PASS <step> | FAIL <step> · <first error> | SKIP <step> · <reason>.
# The whole output of a step is in build/verify/<step>.log. Exit 0 only if no step FAILs.
#
#   contract  the wasm builds and the near-workspaces tests pass (cargo test builds it)
#   server    typecheck and the vitest suite (Workers pool)
#   web       typecheck, the vitest suite, the dev build into web/dist, and the check that a
#             production-mode build ships neither the day-1 route nor a seam fake
#   e2e       the Playwright specs (the Worker API, the RPC and Privy are fakes)
#   screens   the frame captures: web/e2e/screens, one test per frame id x viewport
#
# With <change>: e2e runs only the specs that carry a `// spec: <change> ›` anchor, and screens only
# the frames of design/bundle/manifest.json whose `req` starts with `<change> ›`; a frame of the change
# with no capture test is FAIL screens, never a skip. Without it: every spec, every capture test there is.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"

CHANGE=""
ONLY="contract,server,web,e2e,screens"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      [ "$#" -ge 2 ] || { echo "usage: verify.sh [<change>] [--only contract,server,web,e2e,screens]" >&2; exit 2; }
      ONLY="$2"; shift 2 ;;
    -*) echo "usage: verify.sh [<change>] [--only contract,server,web,e2e,screens]" >&2; exit 2 ;;
    *) [ -z "$CHANGE" ] || { echo "one change at most" >&2; exit 2; }; CHANGE="$1"; shift ;;
  esac
done
for s in ${ONLY//,/ }; do
  case "$s" in contract|server|web|e2e|screens) ;; *) echo "unknown step: $s" >&2; exit 2 ;; esac
done
if [ -n "$CHANGE" ]; then
  case "$CHANGE" in .|..|archive|*/*) echo "bad change id: $CHANGE" >&2; exit 2 ;; esac
  [ -d "openspec/changes/$CHANGE" ] || { echo "no openspec/changes/$CHANGE here" >&2; exit 2; }
fi

LOGDIR="build/verify"
mkdir -p "$LOGDIR"
FAILED=0
MANIFEST="design/bundle/manifest.json"

strip_ansi() { sed 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

first_error() {
  local line
  line="$(strip_ansi < "$1" | grep -m1 -E 'error(\[|:)|^error|FAIL|failed|panicked|✘|Error:|not found' | cut -c1-200)"
  [ -n "$line" ] || line="$(strip_ansi < "$1" | grep -v '^[[:space:]]*$' | tail -1 | cut -c1-200)"
  printf '%s' "$line"
}

pass() { echo "PASS $1"; }
skip() { echo "SKIP $1 · $2"; }
fail() { echo "FAIL $1 · $2"; FAILED=1; }

# run_step <step> <function>: the function's whole output goes to the step's log.
run_step() {
  local step="$1" fn="$2" log="$LOGDIR/$1.log"
  : > "$log"
  if ( set -o pipefail; "$fn" ) > "$log" 2>&1; then
    pass "$step"
  else
    fail "$step" "$(first_error "$log")"
  fi
}

# --- steps -----------------------------------------------------------------------------------------

step_contract() {
  cd contract && cargo test
}

step_server() {
  npm --prefix server run typecheck && npm --prefix server test
}

step_web() {
  npm --prefix web run typecheck || return 1
  npm --prefix web test || return 1
  npm --prefix web run build || return 1
  (cd web && node scripts/check-prod-build.mjs) || return 1
  # The DS is copied, never edited: a difference is a stale copy.
  if [ -d design/ds ]; then
    diff -q design/ds/components.css web/src/ds/components.css || return 1
    diff -q design/bundle/ds/tokens.css web/src/ds/tokens.css || return 1
  fi
}

e2e_specs() {
  # specs that carry an anchor of the change
  grep -l -F "// spec: $CHANGE ›" web/e2e/*.spec.ts 2>/dev/null
}

step_e2e() {
  if [ -n "$CHANGE" ]; then
    local specs
    specs="$(e2e_specs | sed 's|^web/||')"
    [ -n "$specs" ] || { echo "no spec"; return 99; }
    # shellcheck disable=SC2086
    (cd web && npx playwright test --project=e2e $specs)
  else
    npm --prefix web run e2e
  fi
}

# the frame ids of the change that the manifest knows
change_frames() {
  jq -r --arg p "$CHANGE ›" '.frames[] | select(.req | startswith($p)) | .id' "$MANIFEST"
}

step_screens() {
  local listing ids missing="" id
  # `--list` exits 1 with "No tests found" while no frame has a fixture: that is an empty list, not an error.
  if ! listing="$(cd web && npx playwright test --project=screens --list 2>&1)"; then
    case "$listing" in *"No tests found"*) listing="" ;; *) echo "$listing"; return 1 ;; esac
  fi
  if [ -n "$CHANGE" ]; then
    ids="$(change_frames)"
    for id in $ids; do
      printf '%s\n' "$listing" | grep -q -F " › $id · " || missing="$missing $id"
    done
    if [ -n "$missing" ]; then
      echo "no capture test for frame(s):$missing"
      return 1
    fi
    local pattern
    # -g matches "<project> <file> <title>", so the id is held by the space before it, not by ^.
    pattern=" ($(printf '%s' "$ids" | paste -sd'|' -)) · "
    (cd web && npx playwright test --project=screens -g "$pattern")
  else
    (cd web && npx playwright test --project=screens)
  fi
}

screens_skip_reason() {
  [ -f "$MANIFEST" ] || { echo "design/ is not in this checkout"; return 0; }
  if [ -n "$CHANGE" ]; then
    [ -n "$(change_frames)" ] || { echo "$CHANGE has no frames"; return 0; }
    return 1
  fi
  local n
  n="$(cd web && npx playwright test --project=screens --list 2>/dev/null | grep -c ' · ')"
  [ "$n" -gt 0 ] || { echo "no frame has a capture test yet"; return 0; }
  return 1
}

# --- run -------------------------------------------------------------------------------------------

want() { case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

want contract && run_step contract step_contract
want server && run_step server step_server
want web && run_step web step_web

if want e2e; then
  if [ -n "$CHANGE" ] && [ -z "$(e2e_specs)" ]; then
    skip e2e "no spec carries an anchor of $CHANGE"
  else
    run_step e2e step_e2e
  fi
fi

if want screens; then
  if reason="$(screens_skip_reason)"; then
    skip screens "$reason"
  else
    run_step screens step_screens
  fi
fi

exit "$FAILED"
