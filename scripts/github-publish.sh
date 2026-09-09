#!/usr/bin/env bash
# Publish reviewed Git history. This script deliberately never force-pushes or snapshots a dirty tree.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REMOTE=${DGC_GIT_REMOTE:-origin}
BRANCH=${DGC_GIT_BRANCH:-main}
cd "$ROOT"

[ -z "$(git status --porcelain --untracked-files=normal)" ] || {
  echo "refusing to publish a dirty working tree; commit reviewed changes first" >&2; exit 1;
}
[ "$(git branch --show-current)" = "$BRANCH" ] || {
  echo "expected branch '$BRANCH' (current: $(git branch --show-current))" >&2; exit 1;
}
git remote get-url "$REMOTE" >/dev/null

if [ "${DGC_SKIP_PREFLIGHT:-0}" != 1 ]; then
  "$ROOT/scripts/preflight.sh"
fi

# A normal fast-forward push preserves provenance, reviewability, and contribution history.
git fetch "$REMOTE" "$BRANCH"
git merge-base --is-ancestor "$REMOTE/$BRANCH" HEAD || {
  echo "remote history is not an ancestor of HEAD; reconcile it explicitly (no force push)" >&2; exit 1;
}
git push "$REMOTE" "HEAD:refs/heads/$BRANCH"
REMOTE_SHA=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk '{print $1}')
[ "$REMOTE_SHA" = "$(git rev-parse HEAD)" ] || { echo "remote SHA verification failed" >&2; exit 1; }
echo "published $(git rev-parse --short=12 HEAD) → $REMOTE/$BRANCH"
