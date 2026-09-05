#!/usr/bin/env bash
# Deploy an exact, reviewed public projection. Requires an explicit token in the environment or
# DGC_ENV_FILE; credentials are never sourced into the shell or copied into the staged site.
set -euo pipefail

DEPLOY_TOKEN=${CLOUDFLARE_API_TOKEN:-}
DEPLOY_ACCOUNT=${CLOUDFLARE_ACCOUNT_ID:-}
DEPLOY_ENV_FILE=${DGC_ENV_FILE:-}
# No validation, build, browser, or Git subprocess should inherit deployment credentials.
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID DGC_ENV_FILE DGC_CLOUDFLARE_PROJECT
export -n DEPLOY_TOKEN DEPLOY_ACCOUNT DEPLOY_ENV_FILE 2>/dev/null || true
unset DGC_DEPLOY_ENV_LINE
export -n DGC_DEPLOY_ENV_LINE 2>/dev/null || true

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WRANGLER_VERSION=4.125.0
PROJECT=dgc
BRANCH=main

if [ -n "$DEPLOY_ENV_FILE" ]; then
  [ -f "$DEPLOY_ENV_FILE" ] || {
    echo "DGC_ENV_FILE does not exist: $DEPLOY_ENV_FILE" >&2; exit 1;
  }
  if [ -z "$DEPLOY_TOKEN" ]; then
    DGC_DEPLOY_ENV_LINE=$(grep -E '^\s*dgc_cloudflare_token\s*=' "$DEPLOY_ENV_FILE" | head -1 || true)
    DEPLOY_TOKEN=$(printf '%s' "${DGC_DEPLOY_ENV_LINE#*=}" | tr -d '"'"'"'\r' | xargs)
  fi
  if [ -z "$DEPLOY_ACCOUNT" ]; then
    DGC_DEPLOY_ENV_LINE=$(grep -E '^\s*Cloudflare_account_id\s*=' "$DEPLOY_ENV_FILE" | head -1 || true)
    DEPLOY_ACCOUNT=$(printf '%s' "${DGC_DEPLOY_ENV_LINE#*=}" | tr -d '"'"'"'\r' | xargs)
  fi
fi
unset DGC_DEPLOY_ENV_LINE
[ -n "$DEPLOY_TOKEN" ] || {
  echo "set CLOUDFLARE_API_TOKEN (or explicitly set DGC_ENV_FILE)" >&2; exit 1;
}
[ -n "$DEPLOY_ACCOUNT" ] || {
  echo "set CLOUDFLARE_ACCOUNT_ID (or explicitly set DGC_ENV_FILE)" >&2; exit 1;
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
COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MESSAGE=$(git log -1 --pretty=%s)
cmp -s install.sh site/install.sh || {
  echo "site/install.sh differs from the reviewed root installer" >&2; exit 1;
}
[ -s site/dgc.tar.gz ] && [ -s site/dgc.tar.gz.sha256 ] && [ -s site/version.json ] \
  && [ -s site/provenance.json ] && [ -s site/dgc.cdx.json ] || {
  echo "site release artifacts are missing; promote a verified dist/release build first" >&2; exit 1;
}
# Static fallback text is reviewed and committed; deployment may only check it, never mutate it.
bash "$ROOT/scripts/sync-site-version.sh" --check
python3 "$ROOT/scripts/site-measurement.py" self-test
python3 "$ROOT/scripts/site-measurement.py" check-marketplace \
  --max-age-hours 48 --allow-unavailable
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
  .["$schema"] == "node_modules/wrangler/config-schema.json"
  and .name == "dgc"
  and .pages_build_output_dir == "./site"
  and (.compatibility_date | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))
  and (keys | sort == ["$schema", "compatibility_date", "name", "pages_build_output_dir"])
' "$ROOT/wrangler.json" >/dev/null || {
  echo "wrangler.json must be a static Pages config with no dynamic bindings or variables" >&2
  exit 1
}
[ -x "$ROOT/node_modules/.bin/playwright" ] && [ -x "$ROOT/node_modules/.bin/lighthouse" ] || {
  echo "site acceptance dependencies are missing; run npm ci and install pinned Chromium" >&2
  exit 1
}
npm run qa:site:release
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
python3 "$ROOT/scripts/check-site.py" --require-public-release --stage "$STAGE"
CLOUDFLARE_API_TOKEN="$DEPLOY_TOKEN" CLOUDFLARE_ACCOUNT_ID="$DEPLOY_ACCOUNT" \
  npx --yes "wrangler@$WRANGLER_VERSION" pages deploy "$STAGE" \
  --project-name="$PROJECT" --branch="$BRANCH" \
  --commit-hash="$COMMIT_HASH" --commit-message="$COMMIT_MESSAGE" --commit-dirty=false
