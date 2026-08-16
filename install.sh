#!/usr/bin/env bash
# DGC installer — curl -fsSL https://dagucchicode.com/install.sh | bash
# Downloads DGC, sets up a private virtualenv, and puts `dgc` on your PATH.
# Nothing here needs root. Override the source with DGC_BASE_URL, the target with DGC_DIR.
set -euo pipefail

BASE="${DGC_BASE_URL:-https://dagucchicode.com}"
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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "downloading DGC from $BASE"
fetch "$BASE/dgc.tar.gz" "$TMP/dgc.tar.gz" || die "download failed from $BASE/dgc.tar.gz"

# integrity check: verify against the published SHA-256 (best-effort — skipped if not published)
if fetch "$BASE/dgc.tar.gz.sha256" "$TMP/sum" 2>/dev/null && [ -s "$TMP/sum" ]; then
  want=$(awk '{print $1}' "$TMP/sum")
  got=$( { sha256sum "$TMP/dgc.tar.gz" 2>/dev/null || shasum -a 256 "$TMP/dgc.tar.gz"; } | awk '{print $1}')
  [ -n "$want" ] && [ "$want" != "$got" ] && die "checksum mismatch — refusing to install (want $want, got $got)"
  [ -n "$want" ] && say "checksum verified"
fi

mkdir -p "$DEST"
tar -xzf "$TMP/dgc.tar.gz" -C "$DEST" --strip-components=1

say "creating virtualenv + installing (this is self-contained, no system changes)"
python3 -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install -q --upgrade pip >/dev/null
"$DEST/.venv/bin/pip" install -q -e "$DEST" >/dev/null

mkdir -p "$BIN"
ln -sf "$DEST/.venv/bin/dgc" "$BIN/dgc"
say "installed → $BIN/dgc"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) printf '\033[1;33m  note:\033[0m add %s to your PATH:\n    echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc && source ~/.bashrc\n' "$BIN" "$BIN" ;;
esac

cat <<EOF

  DGC is installed. Next:
    dgc setup     # pick your provider + model (Ollama, llama.cpp, OpenAI, OpenRouter …)
    dgc doctor    # verify it can reach your model
    dgc           # start coding

EOF
