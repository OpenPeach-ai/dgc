#!/usr/bin/env bash
# Deploy an exact, reviewed public projection. Requires an explicit token in the environment or
# DGC_ENV_FILE; credentials are never sourced into the shell or copied into the staged site.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WRANGLER_VERSION=4.125.0
PROJECT=${DGC_CLOUDFLARE_PROJECT:-dgc}
BRANCH=main

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
[ -z "$(git status --porcelain --untracked-files=normal)" ] || {
  echo "production site deployment requires a clean reviewed commit" >&2
  exit 1
}
[ "$(git branch --show-current)" = "main" ] || {
  echo "production site deployment requires the public main branch" >&2; exit 1;
}
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
  echo "production site deployment requires HEAD to equal origin/main" >&2; exit 1;
}
cmp -s install.sh site/install.sh || {
  echo "site/install.sh differs from the reviewed root installer" >&2; exit 1;
}
[ -s site/dgc.tar.gz ] && [ -s site/dgc.tar.gz.sha256 ] && [ -s site/version.json ] \
  && [ -s site/provenance.json ] && [ -s site/dgc.cdx.json ] || {
  echo "site release artifacts are missing; promote a verified dist/release build first" >&2; exit 1;
}
# Static fallback text is reviewed and committed; deployment may only check it, never mutate it.
bash "$ROOT/scripts/sync-site-version.sh" --check
python3 "$ROOT/scripts/build-site.py" --check
if [ -d "$ROOT/bench/results-orig" ]; then
  python3 "$ROOT/scripts/export-benchmark-evidence.py" --check
fi
node --no-warnings "$ROOT/scripts/check-site-worker.mjs"
[ -f "$ROOT/wrangler.json" ] || {
  echo "wrangler.json is missing; production bindings are not reviewable" >&2
  exit 1
}
jq -e '
  .name == "dgc"
  and .pages_build_output_dir == "./site"
  and .vars.DGC_ENVIRONMENT == "production"
  and (.vars.DGC_FROM_EMAIL | type == "string" and length > 0)
  and any(.d1_databases[]; .binding == "DGC_SITE_DB" and .database_id != "")
  and any(.analytics_engine_datasets[]; .binding == "DGC_ANALYTICS")
' "$ROOT/wrangler.json" >/dev/null || {
  echo "wrangler.json does not declare the production D1, analytics, and environment bindings" >&2
  exit 1
}
secret_list=$(npx --yes "wrangler@$WRANGLER_VERSION" pages secret list \
  --project-name="$PROJECT" 2>/dev/null) || {
  echo "could not verify Cloudflare Pages secrets" >&2; exit 1;
}
for required_secret in RESEND_API_KEY DGC_RATE_LIMIT_SECRET DGC_CONTACT_EMAIL; do
  printf '%s\n' "$secret_list" | grep -Eq "(^|[[:space:]│])${required_secret}([[:space:]│]|$)" || {
    echo "Cloudflare Pages secret is missing: $required_secret" >&2; exit 1;
  }
done
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
python3 "$ROOT/scripts/check-site.py" --require-public-release --stage "$STAGE"
npx --yes "wrangler@$WRANGLER_VERSION" d1 migrations apply DGC_SITE_DB \
  --remote --config "$ROOT/wrangler.json"
npx --yes "wrangler@$WRANGLER_VERSION" pages deploy "$STAGE" \
  --project-name="$PROJECT" --branch="$BRANCH"
