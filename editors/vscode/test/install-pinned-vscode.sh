#!/usr/bin/env bash
# Install the exact VS Code desktop build used by the extension-host CI gate.
set -euo pipefail

VERSION=1.107.1
SHA256=a9a19e20dd09c61ec1af7d67d9dec2455004d0fbd35120fe1d24588c123f9474
PLATFORM=linux-x64

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || {
  echo "the pinned CI host installer supports Linux x86_64 only" >&2
  exit 1
}
[ "$#" -eq 1 ] && [ -n "$1" ] || {
  echo "usage: install-pinned-vscode.sh DESTINATION" >&2
  exit 2
}

DEST=$1
if [ -e "$DEST" ]; then
  echo "refusing to overwrite existing VS Code test host: $DEST" >&2
  exit 1
fi

PARENT=$(dirname "$DEST")
mkdir -p "$PARENT"
SCRATCH=$(mktemp -d "$PARENT/.dgc-vscode-host.XXXXXXXX")
ARCHIVE="$SCRATCH/vscode-$VERSION-$PLATFORM.tar.gz"
URL="https://update.code.visualstudio.com/$VERSION/$PLATFORM/stable"

curl --fail --location --proto '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors --connect-timeout 20 --max-time 600 \
  --output "$ARCHIVE" "$URL"
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | sha256sum --check --strict
tar -xzf "$ARCHIVE" -C "$SCRATCH" --no-same-owner
[ -x "$SCRATCH/VSCode-linux-x64/code" ] || {
  echo "the pinned VS Code archive did not contain its desktop executable" >&2
  exit 1
}
python3 - "$SCRATCH/VSCode-linux-x64/resources/app/package.json" "$VERSION" <<'PY'
import json, pathlib, sys
package = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if package.get("version") != sys.argv[2]:
    raise SystemExit("the pinned VS Code archive reported an unexpected version")
PY
mv "$SCRATCH/VSCode-linux-x64" "$DEST"
printf 'installed pinned VS Code %s at %s\n' "$VERSION" "$DEST/code"
