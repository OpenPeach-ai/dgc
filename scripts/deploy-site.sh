#!/usr/bin/env bash
# Deploy already-built site bytes. Requires an explicit token in the environment or DGC_ENV_FILE.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WRANGLER_VERSION=4.125.0
PROJECT=${DGC_CLOUDFLARE_PROJECT:-dgc}

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${DGC_ENV_FILE:-}" ]; then
  [ -f "$DGC_ENV_FILE" ] || { echo "DGC_ENV_FILE does not exist: $DGC_ENV_FILE" >&2; exit 1; }
  line=$(grep -E '^\s*dgc_cloudflare_token\s*=' "$DGC_ENV_FILE" | head -1 || true)
  export CLOUDFLARE_API_TOKEN
  CLOUDFLARE_API_TOKEN=$(printf '%s' "${line#*=}" | tr -d '"'"'"'\r' | xargs)
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || {
  echo "set CLOUDFLARE_API_TOKEN (or explicitly set DGC_ENV_FILE)" >&2; exit 1;
}

cd "$ROOT"
cmp -s install.sh site/install.sh || {
  echo "site/install.sh differs from the reviewed root installer" >&2; exit 1;
}
[ -s site/dgc.tar.gz ] && [ -s site/dgc.tar.gz.sha256 ] && [ -s site/version.json ] \
  && [ -s site/provenance.json ] && [ -s site/dgc.cdx.json ] || {
  echo "site release artifacts are missing; promote a verified dist/release build first" >&2; exit 1;
}
npx --yes "wrangler@$WRANGLER_VERSION" pages deploy site --project-name="$PROJECT"
