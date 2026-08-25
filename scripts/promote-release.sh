#!/usr/bin/env bash
# Copy a verified build into the website tree. Deployment remains a separate explicit action.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FROM=${1:-"$ROOT/dist/release"}
[ -s "$FROM/dgc.tar.gz" ] && [ -s "$FROM/dgc.tar.gz.sha256" ] && [ -s "$FROM/version.json" ] \
  && [ -s "$FROM/provenance.json" ] && [ -s "$FROM/dgc.cdx.json" ] || {
  echo "usage: promote-release.sh [directory containing archive, checksum, version, provenance, and SBOM]" >&2
  exit 1
}
(cd "$FROM" && { sha256sum -c dgc.tar.gz.sha256 2>/dev/null || shasum -a 256 -c dgc.tar.gz.sha256; })
cp "$FROM/dgc.tar.gz" "$ROOT/site/dgc.tar.gz"
cp "$FROM/dgc.tar.gz.sha256" "$ROOT/site/dgc.tar.gz.sha256"
cp "$FROM/version.json" "$ROOT/site/version.json"
cp "$FROM/provenance.json" "$ROOT/site/provenance.json"
cp "$FROM/dgc.cdx.json" "$ROOT/site/dgc.cdx.json"
cmp -s "$ROOT/install.sh" "$ROOT/site/install.sh" || cp "$ROOT/install.sh" "$ROOT/site/install.sh"
echo "promoted verified release bytes into site/ (review and commit before deploying)"
