#!/usr/bin/env bash
# Install the peer coding harnesses used by the DGC league into a user-owned,
# version-pinned toolchain. Nothing is installed globally or with sudo.
set -euo pipefail
umask 077

BENCH_ROOT=${BENCH_TOOLS:-"$HOME/bench-tools"}
HARNESS_ROOT=${DGC_HARNESS_ROOT:-"$BENCH_ROOT/harnesses"}
PYTHON=${DGC_BENCH_INSTALL_PYTHON:-python3}

AIDER_VERSION=0.86.2
CODEX_VERSION=0.149.1
GOOSE_VERSION=v1.47.0
OPENCODE_VERSION=1.18.22
PI_VERSION=0.84.3

for command in "$PYTHON" npm node curl jq tar; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing installer prerequisite: $command" >&2
    exit 2
  }
done

mkdir -p "$HARNESS_ROOT/aider" "$HARNESS_ROOT/goose/bin" "$HARNESS_ROOT/npm"

echo "== Aider $AIDER_VERSION =="
"$PYTHON" -m venv "$HARNESS_ROOT/aider/venv"
"$HARNESS_ROOT/aider/venv/bin/python" -m pip install --disable-pip-version-check \
  "aider-chat==$AIDER_VERSION"
"$HARNESS_ROOT/aider/venv/bin/python" -m pip check

echo "== Codex $CODEX_VERSION · OpenCode $OPENCODE_VERSION · Pi $PI_VERSION =="
npm install --prefix "$HARNESS_ROOT/npm" --no-audit --no-fund \
  "@openai/codex@$CODEX_VERSION" \
  "opencode-ai@$OPENCODE_VERSION" \
  "@earendil-works/pi-coding-agent@$PI_VERSION"
npm ls --prefix "$HARNESS_ROOT/npm" --depth=0

case "$(uname -s)" in
  Linux) goose_os=unknown-linux-gnu ;;
  Darwin) goose_os=apple-darwin ;;
  *) echo "unsupported Goose installer OS: $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) goose_arch=x86_64 ;;
  arm64|aarch64) goose_arch=aarch64 ;;
  *) echo "unsupported Goose installer architecture: $(uname -m)" >&2; exit 2 ;;
esac
goose_asset="goose-$goose_arch-$goose_os.tar.bz2"
release_json=$(curl -fsSL "https://api.github.com/repos/aaif-goose/goose/releases/tags/$GOOSE_VERSION")
goose_url=$(printf '%s' "$release_json" | jq -r --arg asset "$goose_asset" \
  '.assets[] | select(.name == $asset) | .browser_download_url')
goose_digest=$(printf '%s' "$release_json" | jq -r --arg asset "$goose_asset" \
  '.assets[] | select(.name == $asset) | .digest')
if [ -z "$goose_url" ] || [ "$goose_url" = null ] ||
   [ -z "$goose_digest" ] || [ "$goose_digest" = null ]; then
  echo "Goose release $GOOSE_VERSION does not publish $goose_asset with a digest" >&2
  exit 2
fi
goose_digest=${goose_digest#sha256:}
goose_tmp=$(mktemp -d)
cleanup() { rm -rf -- "$goose_tmp"; }
trap cleanup EXIT

echo "== Goose ${GOOSE_VERSION#v} ($goose_arch-$goose_os) =="
curl -fL --retry 3 -o "$goose_tmp/$goose_asset" "$goose_url"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$goose_digest" "$goose_tmp/$goose_asset" | sha256sum -c -
else
  actual=$(shasum -a 256 "$goose_tmp/$goose_asset" | awk '{print $1}')
  [ "$actual" = "$goose_digest" ] || { echo "Goose SHA-256 mismatch" >&2; exit 2; }
fi
mkdir -p "$goose_tmp/out"
tar -xjf "$goose_tmp/$goose_asset" -C "$goose_tmp/out"
install -m 755 "$goose_tmp/out/goose" "$HARNESS_ROOT/goose/bin/goose"

echo
echo "Installed peer harnesses under $HARNESS_ROOT"
"$HARNESS_ROOT/aider/venv/bin/aider" --version
"$HARNESS_ROOT/npm/node_modules/.bin/codex" --version
"$HARNESS_ROOT/goose/bin/goose" --version
"$HARNESS_ROOT/npm/node_modules/.bin/opencode" --version
"$HARNESS_ROOT/npm/node_modules/.bin/pi" --version
