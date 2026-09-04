#!/usr/bin/env bash
# Keep the site's STATIC version text (any element with class="js-ver") in sync
# with site/version.json. The page's JS already rewrites these on load, but a
# non-JS fetch / scraper / social preview sees the static fallback — so if it is
# stale the site "shows" an old version to anything that doesn't run JS.
# Deployment calls --check; generation/release preparation may use the default write mode.
# Idempotent. This maintainer command never performs a deployment.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON=${DGC_PYTHON:-python3}
MODE=${1:---write}
[ "$MODE" = "--write" ] || [ "$MODE" = "--check" ] || {
  echo "usage: sync-site-version.sh [--write|--check]" >&2; exit 2;
}
VER=$("$PYTHON" -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$ROOT/site/version.json")
[ -n "$VER" ] || { echo "sync-site-version: no version in site/version.json" >&2; exit 1; }
if [ "$MODE" = "--check" ]; then
  "$PYTHON" - "$ROOT/site" "$VER" <<'PY'
import pathlib, re, sys
site, version = pathlib.Path(sys.argv[1]), sys.argv[2]
bad = []
pattern = re.compile(r'class="js-ver"[^>]*>(v?[0-9]+\.[0-9]+\.[0-9]+)<')
for path in sorted(site.glob("*.html")):
    text = path.read_text(encoding="utf-8")
    values = pattern.findall(text)
    if "js-ver" in text and (not values or any(value.lstrip("v") != version for value in values)):
        bad.append(path.name)
if bad:
    raise SystemExit("stale static version fallback: " + ", ".join(bad))
PY
  echo "sync-site-version: verified static fallback v${VER}"
  exit 0
fi
for f in "$ROOT"/site/*.html; do
  [ -f "$f" ] || continue
  grep -q 'js-ver' "$f" || continue
  sed -i -E "s#(class=\"js-ver\"[^>]*>)v?[0-9]+\.[0-9]+\.[0-9]+(<)#\1v${VER}\2#g" "$f"
done
echo "sync-site-version: site .js-ver fallback → v${VER}"
