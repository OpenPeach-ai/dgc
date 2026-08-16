#!/usr/bin/env bash
# Create the public GitHub repo for DGC and push main.
# Token read from evolving-fungi/.env (github_dgc_token); never printed or persisted.
set -euo pipefail

ENV_FILE="/home/fungigb10/evolving-fungi/.env"
line=$(grep -E '^\s*github_dgc_token\s*=' "$ENV_FILE" | head -1 || true)
[ -n "$line" ] || { echo "github_dgc_token not found in $ENV_FILE" >&2; exit 1; }
TOKEN=$(printf '%s' "${line#*=}" | tr -d '"'"'"'\r' | xargs)
[ -n "$TOKEN" ] || { echo "token empty" >&2; exit 1; }

api() { curl -sf -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

USER=$(api https://api.github.com/user | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')
echo "github user: $USER"

DESC="A coding-agent CLI for the models you run — local (Ollama, llama.cpp, LM Studio, vLLM) or any OpenAI-compatible cloud. Permission modes, plan mode, thinking levels, memory, skills. Pure Python, 3 deps, MIT."
REPO=""
for name in dgc dagucchicode dagucchi-code; do
  if api -X POST https://api.github.com/user/repos -d "{\"name\":\"$name\",\"description\":\"$DESC\",\"homepage\":\"https://dagucchicode.com\",\"private\":false,\"has_issues\":true}" >/dev/null 2>&1; then
    REPO="$name"; break
  fi
  # maybe it already exists and is ours
  if api "https://api.github.com/repos/$USER/$name" >/dev/null 2>&1; then
    REPO="$name"; echo "repo $USER/$name already exists — using it"; break
  fi
done
[ -n "$REPO" ] || { echo "could not create repo (names taken?)" >&2; exit 1; }
echo "repo: https://github.com/$USER/$REPO"

# topics + homepage (covers the already-exists path too)
api -X PATCH "https://api.github.com/repos/$USER/$REPO" \
  -d "{\"description\":\"$DESC\",\"homepage\":\"https://dagucchicode.com\"}" >/dev/null
api -X PUT "https://api.github.com/repos/$USER/$REPO/topics" \
  -H "Accept: application/vnd.github.mercy-preview+json" \
  -d '{"names":["cli","coding-agent","llm","local-llm","ollama","openai-compatible","ai-agent","developer-tools","python","terminal"]}' >/dev/null
echo "description, homepage and topics set"

cd /home/fungigb10/dgc
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$USER/$REPO.git"
# push via one-time token URL — the token is never written to .git/config
git push "https://x-access-token:${TOKEN}@github.com/$USER/$REPO.git" main:main 2>&1 | grep -v "$TOKEN" || true
echo "pushed main"
echo "https://github.com/$USER/$REPO"
