#!/usr/bin/env bash
# Atomically publish a reviewed source tag and its later artifact-promotion commit. The
# tag-triggered workflow is the sole GitHub Release creator, avoiding split public state and races.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TAG=${1:?usage: github-release.sh <existing-tag>}
cd "$ROOT"

[ -z "$(git status --porcelain --untracked-files=normal)" ] || {
  echo "release tree is dirty" >&2; exit 1;
}
git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null || {
  echo "tag '$TAG' must already exist locally and point at the reviewed release commit" >&2; exit 1;
}
SOURCE_COMMIT=$(git rev-list -n1 "$TAG")
HEAD_COMMIT=$(git rev-parse HEAD)
git merge-base --is-ancestor "$SOURCE_COMMIT" "$HEAD_COMMIT" || {
  echo "release source tag must be an ancestor of the promotion commit" >&2; exit 1;
}
VERSION=$(git show "$SOURCE_COMMIT:dgc/__init__.py" | sed -n 's/^__version__ = "\([^"]*\)"$/\1/p')
[ "$TAG" = "v$VERSION" ] || {
  echo "tag $TAG does not match dgc version $VERSION" >&2; exit 1;
}
# Commit B is an artifact/site projection of reviewed source commit A, not another source commit.
# Use a tight allowlist (and disable rename detection so both sides of a cross-boundary move are
# examined) rather than trying to enumerate every source path that must remain frozen.
INVALID_PROMOTION_PATHS=()
while IFS= read -r -d '' changed_path; do
  case "$changed_path" in
    site/*) ;;
    *) INVALID_PROMOTION_PATHS+=("$changed_path") ;;
  esac
done < <(git diff --name-only --no-renames -z "$SOURCE_COMMIT" "$HEAD_COMMIT" --)
if [ "${#INVALID_PROMOTION_PATHS[@]}" -ne 0 ]; then
  echo "promotion commit may change only paths below site/:" >&2
  printf '  %q\n' "${INVALID_PROMOTION_PATHS[@]}" >&2
  exit 1
fi
EDITOR_VERSION=$(git show "$HEAD_COMMIT:site/vscode/version.json" | python3 -c '
import json, re, sys
version = json.load(sys.stdin).get("version")
if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
    raise SystemExit("site/vscode/version.json has an invalid version")
print(version)
')
for promoted_artifact in \
  site/dgc.tar.gz \
  site/vscode/dgc.vsix \
  "site/vscode/dgc-$EDITOR_VERSION.vsix"; do
  git cat-file -e "$HEAD_COMMIT:$promoted_artifact" 2>/dev/null || {
    echo "promotion commit does not track required release artifact: $promoted_artifact" >&2
    exit 1
  }
  artifact_mode=$(git ls-tree "$HEAD_COMMIT" -- "$promoted_artifact" | awk 'NR == 1 {print $1}')
  [ "$artifact_mode" = 100644 ] || {
    echo "promotion artifact must be a tracked regular file, not mode $artifact_mode: $promoted_artifact" >&2
    exit 1
  }
done
git fetch --quiet origin main
git merge-base --is-ancestor origin/main "$HEAD_COMMIT" || {
  echo "origin/main is not an ancestor of this promotion commit; reconcile without force-pushing" >&2
  exit 1
}
if git ls-remote --exit-code --refs origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "remote tag $TAG already exists; published tags are immutable" >&2
  exit 1
fi

"$ROOT/scripts/preflight.sh"
python3 "$ROOT/scripts/check-site.py"
git push --atomic origin \
  "HEAD:refs/heads/main" \
  "refs/tags/$TAG:refs/tags/$TAG"
REMOTE_MAIN=$(git ls-remote origin refs/heads/main | awk '{print $1}')
REMOTE_TAG=$(git ls-remote origin "refs/tags/$TAG^{}" | awk '{print $1}')
[ -n "$REMOTE_TAG" ] || REMOTE_TAG=$(git ls-remote origin "refs/tags/$TAG" | awk '{print $1}')
[ "$REMOTE_MAIN" = "$HEAD_COMMIT" ] && [ "$REMOTE_TAG" = "$SOURCE_COMMIT" ] || {
  echo "remote release refs did not verify after the atomic push" >&2; exit 1;
}
git fetch --quiet origin main
python3 "$ROOT/scripts/release_bundle.py" "$ROOT/site" --bind-git "$ROOT" --require-public
echo "published promotion ${HEAD_COMMIT:0:12} and source tag $TAG atomically; Actions owns the GitHub Release"
