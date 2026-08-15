#!/usr/bin/env bash
# One-off deploy of ~/dgc/site to the Cloudflare Pages project "dgc".
# Reads the token from evolving-fungi/.env without printing it.
set -euo pipefail

line=$(grep -E '^\s*dgc_cloudflare_token\s*=' /home/fungigb10/evolving-fungi/.env | head -1 || true)
[ -n "$line" ] || { echo "token var not found in .env" >&2; exit 1; }
token=${line#*=}
token=$(printf '%s' "$token" | tr -d '"'"'"'\r' | xargs)
[ -n "$token" ] || { echo "token empty" >&2; exit 1; }
echo "token loaded (len ${#token})"

cd /home/fungigb10/dgc
CLOUDFLARE_API_TOKEN="$token" npx -y wrangler@4.123.0 pages deploy site --project-name=dgc
