#!/usr/bin/env bash
# Attach the exact reproducible build to an existing tag using GitHub CLI authentication.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TAG=${1:?usage: github-release.sh <existing-tag>}
OUT=${DGC_RELEASE_OUT:-"$ROOT/dist/release"}
cd "$ROOT"

command -v gh >/dev/null || { echo "GitHub CLI (gh) is required" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo "release tree is dirty" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || {
  echo "tag '$TAG' must already exist locally and point at the reviewed release commit" >&2; exit 1;
}
[ "$(git rev-list -n1 "$TAG")" = "$(git rev-parse HEAD)" ] || { echo "tag does not point at HEAD" >&2; exit 1; }

"$ROOT/scripts/preflight.sh"
"$ROOT/scripts/build-release.sh"
(cd "$OUT" && { sha256sum -c dgc.tar.gz.sha256 2>/dev/null || shasum -a 256 -c dgc.tar.gz.sha256; })
git push origin "$TAG"
gh release create "$TAG" "$OUT/dgc.tar.gz" "$OUT/dgc.tar.gz.sha256" \
  "$OUT/version.json" "$OUT/provenance.json" "$OUT/dgc.cdx.json" \
  --verify-tag --generate-notes --title "DGC $TAG"
echo "created release $TAG from $(git rev-parse --short=12 HEAD)"
