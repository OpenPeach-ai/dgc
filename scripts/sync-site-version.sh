#!/usr/bin/env bash
# Keep the site's STATIC version text (any element with class="js-ver") in sync
# with site/version.json. The page's JS already rewrites these on load, but a
# non-JS fetch / scraper / social preview sees the static fallback — so if it is
# stale the site "shows" an old version to anything that doesn't run JS.
# deploy-site.sh runs this before every deploy, so the fallback can never drift.
# Idempotent. Local-only tooling (scripts/ is not in the public overlay).
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON=${DGC_PYTHON:-python3}
VER=$("$PYTHON" -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$ROOT/site/version.json")
[ -n "$VER" ] || { echo "sync-site-version: no version in site/version.json" >&2; exit 1; }
for f in "$ROOT"/site/*.html; do
  [ -f "$f" ] || continue
  grep -q 'js-ver' "$f" || continue
  sed -i -E "s#(class=\"js-ver\"[^>]*>)v?[0-9]+\.[0-9]+\.[0-9]+(<)#\1v${VER}\2#g" "$f"
done
echo "sync-site-version: site .js-ver fallback → v${VER}"
