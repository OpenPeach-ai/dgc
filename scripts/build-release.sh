#!/usr/bin/env bash
# Build the public release tarball: site/dgc.tar.gz
# Stages the repo tree minus maintainer-only files, and ships a scrubbed
# AGENTS.md (no internal paths / token locations).
set -euo pipefail

ROOT="/home/fungigb10/dgc"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# copy the tree, excluding maintainer/build artifacts
tar -cf - \
  --exclude='.git' --exclude='.venv' --exclude='__pycache__' \
  --exclude='*.egg-info' --exclude='site' --exclude='scripts' \
  --exclude='dgc.tar.gz' --exclude='.DS_Store' \
  -C "$ROOT" . | tar -xf - -C "$STAGE"

# scrub AGENTS.md: drop maintainer sections, keep contributor-facing content
awk '/^## Releasing/{stop=1} !stop' "$ROOT/AGENTS.md" > "$STAGE/AGENTS.md"
cat >> "$STAGE/AGENTS.md" <<'EOF'
## Releasing

`install.sh` pulls `dgc.tar.gz` from `DGC_BASE_URL` (default `https://dagucchicode.com`).
Releases are cut by the maintainer from the source repo.
EOF

mkdir -p "$ROOT/site"
tar -czf "$ROOT/site/dgc.tar.gz" -C "$STAGE" --transform 's|^\./|dgc/|' ./ 2>/dev/null \
  || tar -czf "$ROOT/site/dgc.tar.gz" -C "$STAGE" .

# sanity: the scrubbed file must not mention internal paths
if tar -xzOf "$ROOT/site/dgc.tar.gz" "$(tar -tzf "$ROOT/site/dgc.tar.gz" | grep -m1 'AGENTS.md$')" | grep -qi "dgc_cloudflare_token"; then
  echo "SCRUB FAILED — token mention still in tarball" >&2; exit 1
fi
echo "built site/dgc.tar.gz ($(du -h "$ROOT/site/dgc.tar.gz" | cut -f1))"
