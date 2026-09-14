#!/usr/bin/env bash
# DGC installer — curl -fsSL https://vibedgc.com/install.sh | bash
# Builds each release in its own directory with its own virtualenv, then points the `dgc` launcher
# at it in one atomic step. The version you had keeps working until the new one is complete, and
# `dgc update --rollback` switches back. Nothing here needs root.
#   DGC_DATA_DIR  where versions live (default ${XDG_DATA_HOME:-~/.local/share}/dgc; DGC_DIR is the
#                 name older installers used for their install directory and is still honoured)
#   DGC_BIN       where the dgc launcher goes (default ~/.local/bin)
#   DGC_BASE_URL  where the release is downloaded from (default https://vibedgc.com)
set -euo pipefail

BASE="${DGC_BASE_URL:-https://vibedgc.com}"
FORCE="${DGC_FORCE_OVERWRITE:-0}"

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "DGC installer"

command -v python3 >/dev/null 2>&1 || die "python3 (3.10+) is required — install it and re-run."
PYV=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
python3 - <<'PY' || die "Python $PYV found, but DGC needs 3.10 or newer."
import sys
sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)
PY

realpath_of() { python3 -c 'import os, sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$1"; }
abspath_of() { python3 -c 'import os, sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$1"; }

if [ -n "${DGC_DATA_DIR:-}" ]; then
  DATA=$(realpath_of "$DGC_DATA_DIR")
elif [ -n "${DGC_DIR:-}" ] && [ "$(realpath_of "$DGC_DIR")" != "$(realpath_of "$HOME/dgc")" ]; then
  # DGC_DIR named the single install tree of older installers. A location someone chose keeps
  # being where DGC lives (versions/ goes inside it); the old default, ~/dgc, was never a choice
  # and moves to the data directory below.
  DATA=$(realpath_of "$DGC_DIR")
else
  case "${XDG_DATA_HOME:-}" in
    /*) DATA=$(realpath_of "$XDG_DATA_HOME/dgc") ;;
    *) DATA=$(realpath_of "$HOME/.local/share/dgc") ;;
  esac
fi
BIN=$(abspath_of "${DGC_BIN:-$HOME/.local/bin}")
LAUNCHER="$BIN/dgc"

# Releases are built in $DATA/versions, never over another tree; still, a source checkout is no
# place for them, and it is the one directory where a mistake here has cost someone work before.
if [ -e "$DATA/.git" ] && [ "$FORCE" != 1 ]; then
  die "$DATA is a git checkout — refusing to install releases into it.
    Install elsewhere:  DGC_DATA_DIR=\$HOME/.local/share/dgc bash install.sh
    Or install into it anyway (the checkout's own files are not touched):  DGC_FORCE_OVERWRITE=1"
fi

# The launcher is what actually changes. Replace only a launcher an installer made: a link into a
# versions/ tree, or into an older single-tree install (<dir>/.venv/bin/dgc beside requirements.lock).
# A launcher that runs a git checkout belongs to someone working on DGC — refuse before any
# download. dgc.install_layout applies the same rules again at the moment of the switch.
LAUNCHER_KIND=missing
if [ -L "$LAUNCHER" ] || [ -e "$LAUNCHER" ]; then
  LAUNCHER_KIND=foreign
  if [ -d "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
    die "$LAUNCHER is a directory — refusing to replace it."
  fi
  if [ -L "$LAUNCHER" ]; then
    TARGET=$(realpath_of "$LAUNCHER")
    case "$TARGET" in
      */.venv/bin/dgc)
        TREE=${TARGET%/.venv/bin/dgc}
        if [ -e "$TREE/.git" ]; then LAUNCHER_KIND=checkout
        elif [ -f "$TREE/.complete" ] && [ "$(basename "$(dirname "$TREE")")" = versions ]; then LAUNCHER_KIND=managed
        elif [ -f "$TREE/requirements.lock" ]; then LAUNCHER_KIND=legacy
        elif [ ! -e "$TARGET" ]; then LAUNCHER_KIND=dangling
        fi ;;
    esac
  fi
  if [ "$LAUNCHER_KIND" = checkout ] && [ "$FORCE" != 1 ]; then
    die "$LAUNCHER runs $TREE, which is a git checkout — refusing to repoint it.
    Keep the checkout and put the release launcher elsewhere:  DGC_BIN=\$HOME/.dgc-release/bin bash install.sh
    Or repoint $LAUNCHER anyway (the checkout's files are not touched):  DGC_FORCE_OVERWRITE=1"
  fi
  if [ "$LAUNCHER_KIND" = foreign ] && [ "$FORCE" != 1 ]; then
    die "$LAUNCHER was not created by the DGC installer — refusing to replace it.
    Move it aside, or choose another launcher directory:  DGC_BIN=<dir> bash install.sh
    Or replace it anyway:  DGC_FORCE_OVERWRITE=1"
  fi
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "need curl or wget to download DGC"; fi
}

sha256_of() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | awk '{print $1}'; }

# Install the editor extension into EVERY editor CLI on PATH (skip with DGC_SKIP_EXTENSION=1).
install_extension() {
  if [ -n "${DGC_SKIP_EXTENSION:-}" ]; then return 0; fi
  local editors="" e
  for e in cursor code codium; do
    if command -v "$e" >/dev/null 2>&1; then editors="$editors $e"; fi
  done
  if [ -z "$editors" ]; then return 0; fi
  if ! fetch "$BASE/vscode/dgc.vsix" "$TMP/dgc.vsix" 2>/dev/null; then return 0; fi
  if ! fetch "$BASE/vscode/dgc.vsix.sha256" "$TMP/dgc.vsix.sha256" 2>/dev/null; then
    printf '  note: extension checksum is unavailable — skipping automatic extension install\n'
    return 0
  fi
  local want got
  want=$(awk '{print $1}' "$TMP/dgc.vsix.sha256")
  got=$(sha256_of "$TMP/dgc.vsix")
  [ "${#want}" -eq 64 ] && [ "$want" = "$got" ] || die "extension checksum mismatch (the CLI itself is installed)"
  for e in $editors; do
    if "$e" --install-extension "$TMP/dgc.vsix" --force </dev/null >/dev/null 2>&1; then
      say "editor extension installed/updated in $e (reload the window to see the DGC panel)"
    else
      printf '  note: could not auto-install the extension into %s — get it at %s/vscode/\n' "$e" "$BASE"
    fi
  done
}

TMP=""
BUILD_DIR=""
cleanup() {
  if [ -n "$BUILD_DIR" ]; then rm -rf "$BUILD_DIR"; fi
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TMP=$(mktemp -d)

# One install at a time per data directory. flock(2) on an inherited descriptor: the kernel drops
# it when this script ends, however it ends, so there is no stale lock to reason about.
mkdir -p "$DATA/versions"
exec 9>>"$DATA/update.lock"
if ! python3 -c 'import fcntl, sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(3)'; then
  HOLDER=$(sed -n '1p' "$DATA/update.lock" 2>/dev/null || true)
  printf '\033[1;31m✗ another DGC update is running%s — try again when it finishes\033[0m\n' \
    "${HOLDER:+ (pid $HOLDER)}" >&2
  exit 3
fi
printf '%s\n' "$$" > "$DATA/update.lock"

say "downloading DGC from $BASE"
fetch "$BASE/dgc.tar.gz" "$TMP/dgc.tar.gz" || die "download failed from $BASE/dgc.tar.gz"

# Integrity is mandatory for the production installer. A custom/private mirror can opt out
# explicitly with DGC_ALLOW_UNVERIFIED=1, but a missing checksum never downgrades silently.
SHA=""
if ! fetch "$BASE/dgc.tar.gz.sha256" "$TMP/sum" 2>/dev/null || [ ! -s "$TMP/sum" ]; then
  [ "${DGC_ALLOW_UNVERIFIED:-0}" = 1 ] || die "release checksum is unavailable — refusing an unverified install"
  printf '  warning: DGC_ALLOW_UNVERIFIED=1 — installing without an integrity check\n' >&2
else
  want=$(awk '{print $1}' "$TMP/sum")
  got=$(sha256_of "$TMP/dgc.tar.gz")
  [ "${#want}" -eq 64 ] || die "published checksum is malformed"
  [ "$want" = "$got" ] || die "checksum mismatch — refusing to install (want $want, got $got)"
  SHA=$got
  say "checksum verified"
fi

VER=$(tar -xzOf "$TMP/dgc.tar.gz" dgc/dgc/__init__.py 2>/dev/null \
  | sed -n 's/^__version__ = "\([^"]*\)"$/\1/p') || VER=""
VER=${VER%%$'\n'*}
VERSION_RE='^[0-9]+(\.[0-9]+){1,3}([.+-]?[0-9A-Za-z]+)*$'
[[ "$VER" =~ $VERSION_RE ]] || die "the downloaded release does not name a valid version"
# The switch below runs the release's own dgc.install_layout. A release older than the versioned
# layout does not have it: stop before building anything rather than fail after a full build.
# (No grep -q: under pipefail it can SIGPIPE tar.)
tar -tzf "$TMP/dgc.tar.gz" | grep -Fx 'dgc/dgc/install_layout.py' >/dev/null \
  || die "DGC $VER predates this installer's versioned layout — nothing was changed"
if [ -n "${DGC_INSTALL_VERSION:-}" ] && [ "$DGC_INSTALL_VERSION" != "$VER" ]; then
  die "DGC $DGC_INSTALL_VERSION was requested, but $BASE publishes $VER (only the latest release is downloadable)"
fi

VDIR="$DATA/versions/$VER"
in_use() {  # a process still runs this version (see dgc.install_layout.hold_runtime_lock)
  local lock
  for lock in "$DATA/locks/$VER"/*; do
    [ -e "$lock" ] || continue
    if kill -0 "${lock##*/}" 2>/dev/null; then return 0; fi
  done
  return 1
}
CURRENT_TARGET=""
if [ -L "$LAUNCHER" ]; then CURRENT_TARGET=$(realpath_of "$LAUNCHER"); fi

if [ -f "$VDIR/.complete" ]; then
  HAVE=$(sed -n 's/^sha256=//p' "$VDIR/.complete")
  if [ -n "$SHA" ] && [ "$HAVE" != "$SHA" ]; then
    if [ "$CURRENT_TARGET" = "$VDIR/.venv/bin/dgc" ] || in_use; then
      die "DGC $VER is already installed from a different archive and is in use — refusing to rebuild it in place"
    fi
    say "DGC $VER was installed from a different archive — rebuilding it"
    rm -rf "$VDIR"
  else
    say "DGC $VER is already installed — switching to it"
  fi
fi

if [ ! -f "$VDIR/.complete" ]; then
  if [ -e "$VDIR" ]; then
    # An unfinished build from an install that was interrupted. Never switch to it; rebuild.
    in_use && die "an unfinished build of DGC $VER in $VDIR is in use — refusing to remove it"
    rm -rf "$VDIR"
  fi
  # A virtualenv is not relocatable, so the build happens at its final path. Until .complete is
  # written below, nothing treats this directory as installed, and a failure removes it.
  BUILD_DIR="$VDIR"
  mkdir -p "$VDIR"
  tar -xzf "$TMP/dgc.tar.gz" -C "$VDIR" --strip-components=1 || die "could not unpack the release"
  [ -f "$VDIR/requirements.lock" ] || die "release is missing requirements.lock"

  say "building DGC $VER in its own virtualenv (self-contained, no system changes)"
  python3 -m venv "$VDIR/.venv" \
    || die "could not create a virtualenv (on Debian/Ubuntu: sudo apt install python3-venv)"
  "$VDIR/.venv/bin/pip" install -q -r "$VDIR/requirements.lock" >/dev/null \
    || die "could not install DGC's dependencies — the previous version is still active"
  "$VDIR/.venv/bin/pip" install -q --no-deps "$VDIR" >/dev/null \
    || die "could not install DGC $VER — the previous version is still active"

  # The new build must start and name itself before anything points at it. -I keeps the caller's
  # PYTHONPATH from lending it a different dgc.
  SMOKE=$(cd / && "$VDIR/.venv/bin/python" -I "$VDIR/.venv/bin/dgc" --version 2>"$TMP/smoke.err") \
    || die "the new build does not start: $(tail -n 3 "$TMP/smoke.err" 2>/dev/null)"
  [ "$SMOKE" = "dgc $VER" ] || die "the new build reports '$SMOKE', expected 'dgc $VER'"

  printf 'version=%s\nsha256=%s\ninstalled_at=%s\n' "$VER" "${SHA:-unverified}" "$(date +%s)" \
    > "$VDIR/.complete.tmp"
  mv -f "$VDIR/.complete.tmp" "$VDIR/.complete"
  BUILD_DIR=""
fi

# The switch, the install record and retention (current + 2 newest others) run from the new
# version's own code — the same code `dgc update --rollback` uses.
FORCE_FLAG=""
if [ "$FORCE" = 1 ]; then FORCE_FLAG="--force"; fi
(cd / && "$VDIR/.venv/bin/python" -I -m dgc.install_layout activate \
    --data-dir "$DATA" --bin-dir "$BIN" --version "$VER" $FORCE_FLAG) \
  || die "could not switch $LAUNCHER to DGC $VER — the previous launcher is unchanged"
say "installed DGC $VER → $LAUNCHER"
exec 9>&-

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) printf '\033[1;33m  note:\033[0m add %s to your PATH:\n    echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc && source ~/.bashrc\n' "$BIN" "$BIN" ;;
esac

install_extension

cat <<EOF

  DGC is installed. Next:
    dgc setup     # pick your provider + model (Ollama, llama.cpp, OpenAI, OpenRouter …)
    dgc doctor    # verify it can reach your model
    dgc           # start coding

  Versions live in $DATA/versions — switch back with: dgc update --rollback

  Editor extension (Cursor / VS Code / VSCodium): auto-installed into each of 'cursor', 'code'
  and 'codium' found on PATH (set DGC_SKIP_EXTENSION=1 to skip); otherwise get it at
  $BASE/vscode/

EOF
