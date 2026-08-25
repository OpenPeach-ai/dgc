#!/usr/bin/env bash
# Build two extension flavors from one clean commit. Add --publish for all external channels.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXT="$ROOT/editors/vscode"
OUT=${DGC_EXTENSION_OUT:-"$ROOT/dist/extension"}
PUBLISH=${1:-}
cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo "extension release tree is dirty" >&2; exit 1; }

cd "$EXT"
npm ci
npm run check-types
npm test
npm audit --audit-level=moderate
VER=$(node -p "require('./package.json').version")
mkdir -p "$OUT"

# Registry builds rely on the registry updater. The self-hosted build checks vibedgc.com.
DGC_SELF_HOSTED=false node esbuild.js --production
./node_modules/.bin/vsce package --no-dependencies -o "$OUT/dgc-$VER-registry.vsix"
DGC_SELF_HOSTED=true node esbuild.js --production
./node_modules/.bin/vsce package --no-dependencies -o "$OUT/dgc-$VER-selfhost.vsix"
(cd "$OUT" && { sha256sum dgc-"$VER"-*.vsix 2>/dev/null || shasum -a 256 dgc-"$VER"-*.vsix; } \
  > "dgc-$VER.sha256")

if [ "$PUBLISH" != "--publish" ]; then
  echo "built extension $VER → $OUT (pass --publish only after reviewing these bytes)"
  exit 0
fi
[ -n "${VSCE_PAT:-}" ] && [ -n "${OVSX_PAT:-}" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || {
  echo "--publish requires VSCE_PAT, OVSX_PAT, and CLOUDFLARE_API_TOKEN" >&2; exit 1;
}
./node_modules/.bin/vsce publish --packagePath "$OUT/dgc-$VER-registry.vsix" -p "$VSCE_PAT"
./node_modules/.bin/ovsx publish "$OUT/dgc-$VER-registry.vsix" -p "$OVSX_PAT"
cp "$OUT/dgc-$VER-selfhost.vsix" "$ROOT/site/vscode/dgc-$VER.vsix"
cp "$OUT/dgc-$VER-selfhost.vsix" "$ROOT/site/vscode/dgc.vsix"
(cd "$ROOT/site/vscode" && { sha256sum dgc.vsix 2>/dev/null || shasum -a 256 dgc.vsix; } \
  | awk '{print $1"  dgc.vsix"}' > dgc.vsix.sha256)
printf '{"version":"%s","vsix":"https://vibedgc.com/vscode/dgc.vsix","page":"https://vibedgc.com/vscode/","notes":"https://github.com/OpenPeach-ai/dgc/releases"}\n' \
  "$VER" > "$ROOT/site/vscode/version.json"
"$ROOT/scripts/deploy-site.sh"
echo "published extension $VER to Marketplace, Open VSX, and vibedgc.com"
