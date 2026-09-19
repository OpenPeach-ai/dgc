#!/usr/bin/env bash
# M0 diagnostic: run a set of escape probes INSIDE the sandbox profile that dgc/sandbox.py
# builds TODAY (allow-by-default sandbox-exec), for both network modes, and print LEAK or
# BLOCKED per check (with an unsandboxed control and, for side effects, an outside confirmation),
# plus the raw evidence for every verdict. macOS only.
#
# This proves nothing about a hardened profile: it records the real behaviour of the shipping
# macOS sandbox so the platform lanes can size the strict-profile work. Every LEAK is a finding.
#
# Usage: seatbelt_probe.sh [macos-label] [net-mode]
#   macos-label defaults to "macos<major>" from sw_vers; net-mode is deny|allow|both (default both).
# Env: DGC_PYTHON (a python that can import dgc; default python3), DGC_REPO_ROOT (repo checkout).
set -u

LABEL="${1:-}"
NETMODE="${2:-both}"
PY="${DGC_PYTHON:-python3}"
REPO_ROOT="${DGC_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd -P)}"

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
}
trap cleanup EXIT

# --- the current profile, straight from dgc/sandbox.py, for a given network mode ------------
profile_for() { # $1 = deny|allow  $2 = cli|sdk (default cli) -> prints line1=exec line2=profile
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
    sys.stderr.write(f"no sandbox-exec backend (available={sb.available()!r})\n"); sys.exit(3)
argv = sb.wrap("true", work, {"sandbox": True, "sandbox_network": net})
if not argv:
    sys.stderr.write("sandbox.wrap returned no argv\n"); sys.exit(4)
# argv == [exec, "-p", <profile>, "/bin/bash", "-o", "pipefail", "-c", "true"]
print(argv[0])
print(argv[2])
PYEOF
}

# --- run the probes inside a profile; classify LEAK / BLOCKED / UNTESTABLE / INCONCLUSIVE ----
run_probes_for_mode() {
  local net="$1"
  local exec_path profile out
  out=$(profile_for "$net"); local rc=$?
  if [ $rc -ne 0 ]; then
    echo "M0-RESULT seatbelt $LABEL net=$net SETUP-FAILED rc=$rc"
    echo "$out"
    return
  fi
  exec_path=$(printf '%s\n' "$out" | sed -n 1p)
  profile=$(printf '%s\n' "$out" | sed -n 2p)

  local summary="M0-RESULT seatbelt $LABEL net=$net"

  # A fresh foreign (outside-the-sandbox) process per mode, carrying a known env marker.
  pkill -x TextEdit 2>/dev/null; sleep 1
  env DGC_SEATBELT_MARK="foreign-env-$net" sleep 900 &
  local FOREIGN_PID=$!
  sleep 0.5

  # probe NAME EXPECT COMMAND   (optional CONFIRM=<unsandboxed check> in the caller's env)
  #   LEAK          succeeded inside the sandbox (and, when CONFIRM is set, the effect is visible
  #                 from outside the sandbox)
  #   INCONCLUSIVE  succeeded inside, but CONFIRM did not see the effect from outside
  #   BLOCKED       failed inside the sandbox, while the SAME command succeeds unsandboxed
  #   UNTESTABLE    failed inside AND unsandboxed: the check proves nothing on this runner
  probe() {
    local name="$1"; local expect="$2"; shift 2
    local o code verdict evidence c ctl
    # Start the sandboxed shell inside the (readable) workspace so bash's own getcwd at startup
    # does not emit a "getcwd: Operation not permitted" warning that muddies the evidence.
    o=$(cd "$W" && "$exec_path" -p "$profile" /bin/bash -o pipefail -c "$*" 2>&1); code=$?
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
    summary="$summary $name=$verdict"
    printf '%-12s [%s] %s  (exit=%s) :: %s\n' "$verdict" "$net" "$name" "$code" "$evidence"
  }

  probe home_read       "home-secret"   "cat '$HOME/.seatbelt-home-probe'"
  probe state_dir_read  "state-secret"  "cat '$HOME/.dgc/seatbelt-probe.txt'"
  probe tmp_outside     "tmp-secret"    "cat '$TMP_OUTSIDE'"
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
  CONFIRM="sleep 0.5; st=\$(ps -o stat= -p $FOREIGN_PID 2>/dev/null); case \"\$st\" in ''|Z*) echo foreign-process-gone;; *) echo still-running:\$st; false;; esac"
  probe kill_other      ""              "kill -TERM $FOREIGN_PID"; CONFIRM=""
  probe launchctl       ""              "launchctl submit -l dgc.seatbelt.probe.$net -- /usr/bin/true"
  CONFIRM="sleep 2; pgrep -x TextEdit"
  probe open_app        ""              "open -g -a TextEdit"; CONFIRM=""
  CONFIRM="defaults read dgc.seatbelt.probe k-$net"
  probe defaults_write  ""              "defaults write dgc.seatbelt.probe k-$net v"; CONFIRM=""
  probe curl_net        ""              "curl -sS -m 5 https://example.com -o /dev/null"
  kill "$FOREIGN_PID" 2>/dev/null

  # The profile an SDK session gets (isolated HOME under its state_dir): is the state_dir hidden?
  local sdk_out; sdk_out=$(profile_for "$net" sdk)
  if [ $? -eq 0 ]; then
    local cli_profile="$profile"
    profile=$(printf '%s\n' "$sdk_out" | sed -n 2p)
    probe sdk_state_read "sdk-state-secret" "cat '$SDK_STATE/audit/probe.txt'"
    profile="$cli_profile"
  else
    summary="$summary sdk_state_read=SETUP-FAILED"
  fi

  # sanity: a workspace write must still succeed, or the profile is broken, not leaky.
  if ( cd "$W" && "$exec_path" -p "$profile" /bin/bash -o pipefail -c "echo ok > '$W/written.txt'" ) 2>/dev/null \
     && [ -f "$W/written.txt" ]; then
    summary="$summary workspace_write=OK"
  else
    summary="$summary workspace_write=BROKEN"
    echo "BREAK   [$net] workspace_write  (the profile denies a legitimate workspace write)"
  fi

  echo "$summary"
}

case "$NETMODE" in
  both) run_probes_for_mode deny; run_probes_for_mode allow ;;
  deny|allow) run_probes_for_mode "$NETMODE" ;;
  *) echo "unknown net-mode: $NETMODE (want deny|allow|both)" >&2; exit 2 ;;
esac
