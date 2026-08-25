#!/usr/bin/env bash
# DGC installer — curl -fsSL https://vibedgc.com/install.sh | bash
# Downloads DGC, sets up a private virtualenv, and puts `dgc` on your PATH.
# Nothing here needs root. Override the source with DGC_BASE_URL, the target with DGC_DIR.
set -euo pipefail

BASE="${DGC_BASE_URL:-https://vibedgc.com}"
DEST="${DGC_DIR:-$HOME/dgc}"
BIN="${DGC_BIN:-$HOME/.local/bin}"

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "DGC installer"

command -v python3 >/dev/null 2>&1 || die "python3 (3.10+) is required — install it and re-run."
PYV=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
python3 - <<'PY' || die "Python $PYV found, but DGC needs 3.10 or newer."
import sys
sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)
PY

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "need curl or wget to download DGC"; fi
}

# Install the editor extension too, if an editor CLI is on PATH (skip with DGC_SKIP_EXTENSION=1).
install_extension() {
  [ -n "${DGC_SKIP_EXTENSION:-}" ] && return 0
  local editor="" e
  for e in cursor code codium; do
    command -v "$e" >/dev/null 2>&1 && { editor="$e"; break; }
  done
  [ -z "$editor" ] && return 0
  if fetch "$BASE/vscode/dgc.vsix" "$TMP/dgc.vsix" 2>/dev/null; then
    if ! fetch "$BASE/vscode/dgc.vsix.sha256" "$TMP/dgc.vsix.sha256" 2>/dev/null; then
      printf '  note: extension checksum is unavailable — skipping automatic extension install\n'
      return 0
    fi
    local want got
    want=$(awk '{print $1}' "$TMP/dgc.vsix.sha256")
    got=$( { sha256sum "$TMP/dgc.vsix" 2>/dev/null || shasum -a 256 "$TMP/dgc.vsix"; } | awk '{print $1}')
    [ "${#want}" -eq 64 ] && [ "$want" = "$got" ] || die "extension checksum mismatch"
    if "$editor" --install-extension "$TMP/dgc.vsix" --force >/dev/null 2>&1; then
      say "editor extension installed/updated in $editor (reload the window to see the DGC panel)"
    else
      printf '  note: could not auto-install the extension — get it at %s/vscode/\n' "$BASE"
    fi
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "downloading DGC from $BASE"
fetch "$BASE/dgc.tar.gz" "$TMP/dgc.tar.gz" || die "download failed from $BASE/dgc.tar.gz"

# Integrity is mandatory for the production installer. A custom/private mirror can opt out
# explicitly with DGC_ALLOW_UNVERIFIED=1, but a missing checksum never downgrades silently.
if ! fetch "$BASE/dgc.tar.gz.sha256" "$TMP/sum" 2>/dev/null || [ ! -s "$TMP/sum" ]; then
  [ "${DGC_ALLOW_UNVERIFIED:-0}" = 1 ] || die "release checksum is unavailable — refusing an unverified install"
  printf '  warning: DGC_ALLOW_UNVERIFIED=1 — installing without an integrity check\n' >&2
else
  want=$(awk '{print $1}' "$TMP/sum")
  got=$( { sha256sum "$TMP/dgc.tar.gz" 2>/dev/null || shasum -a 256 "$TMP/dgc.tar.gz"; } | awk '{print $1}')
  [ "${#want}" -eq 64 ] || die "published checksum is malformed"
  [ "$want" = "$got" ] || die "checksum mismatch — refusing to install (want $want, got $got)"
  say "checksum verified"
fi

mkdir -p "$DEST"
tar -xzf "$TMP/dgc.tar.gz" -C "$DEST" --strip-components=1

say "creating virtualenv + installing (this is self-contained, no system changes)"
python3 -m venv "$DEST/.venv"
[ -f "$DEST/requirements.lock" ] || die "release is missing requirements.lock"
"$DEST/.venv/bin/pip" install -q -r "$DEST/requirements.lock" >/dev/null
"$DEST/.venv/bin/pip" install -q --no-deps -e "$DEST" >/dev/null

mkdir -p "$BIN"
ln -sf "$DEST/.venv/bin/dgc" "$BIN/dgc"
say "installed → $BIN/dgc"

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

  Editor extension (VS Code / Cursor): auto-installed if 'cursor' or 'code' was found;
  otherwise grab it at $BASE/vscode/

EOF
