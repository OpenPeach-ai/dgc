#!/usr/bin/env bash
# Escape probes run INSIDE the profile dgc/sandbox.py builds, for both network modes, plus a
# compatibility pass with the toolchains a real task uses. macOS only.
#
# Each check prints LEAK, BLOCKED, UNTESTABLE or INCONCLUSIVE with the evidence behind it:
#
#   LEAK          succeeded inside the sandbox — and, when the check has a side effect, the
#                 effect was confirmed from outside. Every LEAK is a finding; the script exits 1.
#   BLOCKED       failed inside the sandbox while the SAME command succeeds unsandboxed, so the
#                 profile is what stopped it (the unsandboxed run is the control).
#   UNTESTABLE    failed inside AND unsandboxed: this runner cannot judge the check.
#   INCONCLUSIVE  succeeded inside, but the effect was not visible from outside.
#
# Two successes are BY-DESIGN rather than findings, and only under net=allow: `curl_net` (the
# session asked for network) and `keychain` (macOS needs SecurityServer for TLS, so the keychain
# is reachable again exactly when network is allowed — the frozen keychain_hidden rule, which the
# docs state). Everything else that succeeds inside the sandbox is a LEAK.
#
# Usage: seatbelt_probe.sh [macos-label] [net-mode] [--no-compat]
#   macos-label defaults to "macos<major>" from sw_vers; net-mode is deny|allow|both (default both).
# Env: DGC_PYTHON (a python that can import dgc; default python3), DGC_REPO_ROOT (repo checkout).
set -u

LABEL=""
NETMODE="both"
COMPAT=1
for arg in "$@"; do
  case "$arg" in
    --no-compat) COMPAT=0 ;;
    deny|allow|both) NETMODE="$arg" ;;
    *) [ -z "$LABEL" ] && LABEL="$arg" ;;
  esac
done

PY="${DGC_PYTHON:-python3}"
REPO_ROOT="${DGC_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd -P)}"
LEAKS=0
FINDINGS=""
COMPAT_FAILS=""

if [ "$(uname -s)" != "Darwin" ]; then
  echo "seatbelt_probe: macOS only (uname=$(uname -s)); nothing to do" >&2
  exit 0
fi
if [ -z "$LABEL" ]; then
  LABEL="macos$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
fi

# --- fixtures every probe references -------------------------------------------------------
W=$(mktemp -d); W=$(cd "$W" && pwd -P)                    # canonical workspace (writable)
echo "workspace fixture" > "$W/inside.txt"
mkdir -p "$HOME/.dgc" 2>/dev/null; echo "state-secret" > "$HOME/.dgc/seatbelt-probe.txt" 2>/dev/null
echo "home-secret" > "$HOME/.seatbelt-home-probe" 2>/dev/null
TMP_OUTSIDE=$(mktemp /tmp/dgc-seatbelt-outside.XXXXXX); echo "tmp-secret" > "$TMP_OUTSIDE"
# An SDK client's state_dir (default: a private temp dir, i.e. under DARWIN_USER_TEMP_DIR). An SDK
# session runs with HOME=DGC_HOME=<state>/home and DGC_SDK_ISOLATED=1; its audit/usage logs sit
# beside that HOME and must be hidden from the sandboxed shell.
SDK_STATE=$(mktemp -d); SDK_STATE=$(cd "$SDK_STATE" && pwd -P)
mkdir -p "$SDK_STATE/home/.dgc" "$SDK_STATE/audit"; echo "sdk-state-secret" > "$SDK_STATE/audit/probe.txt"
CONFIRM=""                                               # set per probe; see probe()
BOXES=""                                                 # private call folders to remove at exit
KEY_SERVICE="dgc-seatbelt-probe"
KEY_SECRET="PROBE-SECRET-9c1f"
KEYCHAIN_READY=0
if security add-generic-password -U -A -a dgc -s "$KEY_SERVICE" -w "$KEY_SECRET" 2>/dev/null; then
  KEYCHAIN_READY=1
fi

cleanup() {
  [ "$KEYCHAIN_READY" = 1 ] && security delete-generic-password -s "$KEY_SERVICE" >/dev/null 2>&1
  launchctl remove dgc.seatbelt.probe.deny 2>/dev/null; launchctl remove dgc.seatbelt.probe.allow 2>/dev/null
  defaults delete dgc.seatbelt.probe >/dev/null 2>&1; pkill -x TextEdit 2>/dev/null
  rm -f "$TMP_OUTSIDE" "$HOME/.seatbelt-home-probe" "$HOME/.dgc/seatbelt-probe.txt" 2>/dev/null
  rm -rf "$SDK_STATE" "$W" 2>/dev/null
  rm -f /private/tmp/dgc-seatbelt-w-deny /private/tmp/dgc-seatbelt-w-allow "$HOME/.seatbelt-home-write-deny" "$HOME/.seatbelt-home-write-allow" 2>/dev/null
  for box in $BOXES; do rm -rf "$box" 2>/dev/null; done
}
trap cleanup EXIT

# --- the argv dgc/sandbox.py builds, for a given network mode -------------------------------
# Prints NUL-separated fields: [0] = the private call folder, [1..] = the argv prefix, to which
# the caller appends one command. Nothing is reconstructed by hand: this is what DGC runs.
argv_for() { # $1 = deny|allow  $2 = cli|sdk (default cli)
  local -a iso=()
  if [ "${2:-cli}" = sdk ]; then
    iso=(HOME="$SDK_STATE/home" DGC_HOME="$SDK_STATE/home" DGC_SDK_ISOLATED=1)
  fi
  env ${iso[@]+"${iso[@]}"} DGC_SBX_NET="$1" DGC_SBX_WORK="$W" PYTHONPATH="$REPO_ROOT" "$PY" - <<'PYEOF'
import os, sys
try:
    import dgc.sandbox as sb
except Exception as exc:                       # pragma: no cover - import failure is a finding
    sys.stderr.write(f"cannot import dgc.sandbox: {exc}\n"); sys.exit(2)
work = os.environ["DGC_SBX_WORK"]
net = os.environ["DGC_SBX_NET"] == "allow"
if sb.available() != "sandbox-exec":
    sys.stderr.write(f"no sandbox-exec backend (available={sb.available()!r}, "
                     f"reason={sb.unavailable_reason()!r})\n")
    sys.exit(3)
argv = sb.wrap("PLACEHOLDER", work, {"sandbox": True, "sandbox_network": net})
if not argv:
    sys.stderr.write("sandbox.wrap returned no argv\n"); sys.exit(4)
box = ""
for item in argv:
    if item.startswith("-DSESSION_TMP="):
        box = item.split("=", 1)[1]
# This process is about to exit, and its atexit hook would delete the folder the probes are
# about to use as HOME/TMPDIR. Hand ownership to the shell script instead.
sb._CALL_DIRS.discard(box)
out = sys.stdout.buffer
out.write(box.encode() + b"\0")
for item in argv[:-1]:                         # everything but the command itself
    out.write(item.encode() + b"\0")
PYEOF
}

# --- run the probes inside a profile; classify LEAK / BLOCKED / UNTESTABLE / INCONCLUSIVE ----
run_probes_for_mode() {
  local net="$1"
  local -a FIELDS=() PREFIX=()
  local BOX="" field=""
  while IFS= read -r -d '' field; do FIELDS+=("$field"); done < <(argv_for "$net")
  if [ "${#FIELDS[@]}" -lt 4 ]; then
    echo "M0-RESULT seatbelt $LABEL net=$net SETUP-FAILED (argv had ${#FIELDS[@]} fields)"
    return
  fi
  BOX="${FIELDS[0]}"; BOXES="$BOXES $BOX"
  PREFIX=("${FIELDS[@]:1}")

  local summary="M0-RESULT seatbelt $LABEL net=$net"

  # A fresh foreign (outside-the-sandbox) process per mode, carrying a known env marker.
  pkill -x TextEdit 2>/dev/null; sleep 1
  env DGC_SEATBELT_MARK="foreign-env-$net" sleep 900 &
  local FOREIGN_PID=$!
  sleep 0.5

  # probe NAME EXPECT COMMAND   (optional CONFIRM=<unsandboxed check> in the caller's env)
  probe() {
    local name="$1"; local expect="$2"; shift 2
    local o code verdict evidence c ctl
    # Start the sandboxed shell inside the (readable) workspace, exactly as the bash tool does.
    o=$(cd "$W" && "${PREFIX[@]}" "$*" 2>&1); code=$?
    evidence=$(printf '%s' "$o" | head -c 180 | tr '\n' ' ')
    if [ $code -eq 0 ] && { [ -z "$expect" ] || printf '%s' "$o" | grep -qF "$expect"; }; then
      verdict=LEAK
      if [ -n "${CONFIRM:-}" ]; then
        if c=$(cd "$W" && /bin/bash -o pipefail -c "$CONFIRM" 2>&1); then
          evidence="$evidence | confirmed outside: $(printf '%s' "$c" | head -c 100 | tr '\n' ' ')"
        else
          verdict=INCONCLUSIVE
          evidence="$evidence | NOT confirmed outside: $(printf '%s' "$c" | head -c 100 | tr '\n' ' ')"
        fi
      fi
    else
      # Control: the same command, unsandboxed. If it fails there too, BLOCKED would be a lie.
      if ctl=$(cd "$W" && /bin/bash -o pipefail -c "$*" 2>&1) \
         && { [ -z "$expect" ] || printf '%s' "$ctl" | grep -qF "$expect"; }; then
        verdict=BLOCKED
      else
        verdict=UNTESTABLE
        evidence="$evidence | unsandboxed control also failed: $(printf '%s' "$ctl" | head -c 100 | tr '\n' ' ')"
      fi
    fi
    if [ "$verdict" = LEAK ]; then
      case "$net/$name" in
        allow/curl_net|allow/keychain) verdict=BY-DESIGN ;;
        *) LEAKS=$((LEAKS + 1)); FINDINGS="$FINDINGS $net/$name" ;;
      esac
    fi
    summary="$summary $name=$verdict"
    printf '%-12s [%s] %s  (exit=%s) :: %s\n' "$verdict" "$net" "$name" "$code" "$evidence"
  }

  probe home_read       "home-secret"   "cat '$HOME/.seatbelt-home-probe'"
  probe state_dir_read  "state-secret"  "cat '$HOME/.dgc/seatbelt-probe.txt'"
  probe home_list       ""              "ls '$HOME'"
  probe tmp_outside     "tmp-secret"    "cat '$TMP_OUTSIDE'"
  probe tmp_list        ""              "ls /private/tmp"
  probe tmp_write       "wrote"         "echo x > /private/tmp/dgc-seatbelt-w-$net && echo wrote"
  probe home_write      "wrote"         "echo x > '$HOME/.seatbelt-home-write-$net' && echo wrote"
  probe darwin_temp     ""              'ls "$(getconf DARWIN_USER_TEMP_DIR)"'
  probe darwin_cache    ""              'ls "$(getconf DARWIN_USER_CACHE_DIR)"'
  if [ "$KEYCHAIN_READY" = 1 ]; then
    probe keychain      "$KEY_SECRET"   "security find-generic-password -s '$KEY_SERVICE' -w"
  else
    summary="$summary keychain=SKIP"
    echo "SKIP         [$net] keychain  (could not seed the login keychain on this runner)"
  fi
  probe ps_other_env    "DGC_SEATBELT_MARK=foreign-env-$net" "ps -Eww -p $FOREIGN_PID"
  probe ps_list         ""              "ps -A -o pid= | tr -d ' ' | grep -qx $FOREIGN_PID"
  CONFIRM="sleep 0.5; st=\$(ps -o stat= -p $FOREIGN_PID 2>/dev/null); case \"\$st\" in ''|Z*) echo foreign-process-gone;; *) echo still-running:\$st; false;; esac"
  probe kill_other      ""              "kill -TERM $FOREIGN_PID"; CONFIRM=""
  probe launchctl       ""              "launchctl submit -l dgc.seatbelt.probe.$net -- /usr/bin/true"
  CONFIRM="sleep 2; pgrep -x TextEdit"
  probe open_app        ""              "open -g -a TextEdit"; CONFIRM=""
  CONFIRM="defaults read dgc.seatbelt.probe k-$net"
  probe defaults_write  ""              "defaults write dgc.seatbelt.probe k-$net v"; CONFIRM=""
  probe nested_sandbox  ""              "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true"
  probe curl_net        ""              "curl -sS -m 10 https://example.com -o /dev/null"
  kill "$FOREIGN_PID" 2>/dev/null

  # The profile an SDK session gets (isolated HOME under its state_dir): is the state_dir hidden?
  local -a SDK_FIELDS=()
  while IFS= read -r -d '' field; do SDK_FIELDS+=("$field"); done < <(argv_for "$net" sdk)
  if [ "${#SDK_FIELDS[@]}" -ge 4 ]; then
    BOXES="$BOXES ${SDK_FIELDS[0]}"
    local -a KEEP=("${PREFIX[@]}")
    PREFIX=("${SDK_FIELDS[@]:1}")
    probe sdk_state_read "sdk-state-secret" "cat '$SDK_STATE/audit/probe.txt'"
    PREFIX=("${KEEP[@]}")
  else
    summary="$summary sdk_state_read=SETUP-FAILED"
  fi

  # Sanity, not escapes: the profile must still let a real command work.
  local ok=0
  if ( cd "$W" && "${PREFIX[@]}" "echo ok > '$W/written.txt'" ) 2>/dev/null && [ -f "$W/written.txt" ]; then
    summary="$summary workspace_write=OK"; ok=$((ok + 1))
  else
    summary="$summary workspace_write=BROKEN"
    echo "BREAK        [$net] workspace_write  (the profile denies a legitimate workspace write)"
  fi
  if ( cd "$W" && "${PREFIX[@]}" "cat inside.txt" ) 2>/dev/null | grep -q "workspace fixture"; then
    summary="$summary workspace_read=OK"; ok=$((ok + 1))
  else
    summary="$summary workspace_read=BROKEN"
    echo "BREAK        [$net] workspace_read  (the profile denies reading the workspace)"
  fi
  # HOME/TMPDIR must be the private 0700 folder, writable, and gone once the command exits.
  local home_out
  home_out=$(cd "$W" && "${PREFIX[@]}" 'printf "%s|%s|" "$HOME" "$TMPDIR"; echo private > "$TMPDIR/scratch" && echo WROTE' 2>&1)
  if printf '%s' "$home_out" | grep -qxF "$BOX/t|$BOX/t|WROTE"; then
    summary="$summary private_home=OK"
  else
    summary="$summary private_home=BROKEN"
    echo "BREAK        [$net] private_home  :: $home_out"
  fi
  if [ -e "$BOX/t" ]; then
    summary="$summary tmp_removed=NO"
    echo "BREAK        [$net] tmp_removed  ($BOX/t survived the command)"
  else
    summary="$summary tmp_removed=OK"
  fi

  echo "$summary"
}

# --- compatibility: the toolchains a real task uses must still work inside the profile -------
run_compat() {
  local -a FIELDS=() PREFIX=()
  local field=""
  while IFS= read -r -d '' field; do FIELDS+=("$field"); done < <(argv_for allow)
  if [ "${#FIELDS[@]}" -lt 4 ]; then
    echo "M0-RESULT compat $LABEL SETUP-FAILED"
    return
  fi
  BOXES="$BOXES ${FIELDS[0]}"
  PREFIX=("${FIELDS[@]:1}")
  local summary="M0-RESULT compat $LABEL net=allow"

  compat() { # NAME COMMAND...
    local name="$1"; shift
    local o code
    o=$(cd "$W" && "${PREFIX[@]}" "$*" 2>&1); code=$?
    if [ $code -eq 0 ]; then
      summary="$summary $name=OK"
      printf '%-12s [compat] %s\n' OK "$name"
    else
      summary="$summary $name=FAILED"      # reported, never counted as an escape
      COMPAT_FAILS="$COMPAT_FAILS $name"
      printf '%-12s [compat] %s  (exit=%s) :: %s\n' FAILED "$name" "$code" \
        "$(printf '%s' "$o" | head -c 300 | tr '\n' ' ')"
    fi
  }

  compat git        "git init -q repo-compat && cd repo-compat && git -c user.email=a@b -c user.name=c commit -q --allow-empty -m x && git log --oneline | head -1"
  compat clang      "printf 'int main(void){return 0;}\n' > c.c && clang -o c.out c.c && ./c.out"
  compat xcrun      "xcrun --show-sdk-path"
  compat make       "make --version | head -1"
  compat python_venv "/usr/bin/python3 -m venv venv && ./venv/bin/python -c 'import sys; print(sys.version)'"
  compat pip_install "./venv/bin/python -m pip install --quiet --disable-pip-version-check six && ./venv/bin/python -c 'import six; print(six.__version__)'"
  compat node       "node --version"
  compat npm_ci     "mkdir -p npmproj && cd npmproj && printf '{\"name\":\"p\",\"version\":\"1.0.0\",\"dependencies\":{\"left-pad\":\"1.3.0\"}}\n' > package.json && npm install --no-audit --no-fund --silent && node -e \"require('left-pad')\""
  compat brew       "command -v brew >/dev/null && brew --version | head -1 || echo 'no brew on this runner'"
  compat curl_tls   "curl -sS -m 20 https://registry.npmjs.org/left-pad -o /dev/null && echo tls-ok"

  echo "$summary"
}

case "$NETMODE" in
  both) run_probes_for_mode deny; run_probes_for_mode allow ;;
  deny|allow) run_probes_for_mode "$NETMODE" ;;
  *) echo "unknown net-mode: $NETMODE (want deny|allow|both)" >&2; exit 2 ;;
esac
[ "$COMPAT" = 1 ] && run_compat

if [ "$LEAKS" -gt 0 ]; then
  echo "M0-RESULT seatbelt $LABEL VERDICT=LEAKS leaks=$LEAKS escapes:$FINDINGS compat-failures:${COMPAT_FAILS:- none}"
  exit 1
fi
echo "M0-RESULT seatbelt $LABEL VERDICT=NO-LEAKS leaks=0 compat-failures:${COMPAT_FAILS:- none}"
[ -n "$COMPAT_FAILS" ] && exit 2
exit 0
