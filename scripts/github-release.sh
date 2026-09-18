#!/usr/bin/env bash
# Atomically publish a reviewed product tag. The tag-triggered workflow is the
# sole GitHub Release creator. The website is not part of this public tree.
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
  echo "release source tag must be an ancestor of HEAD" >&2; exit 1;
}
VERSION=$(git show "$SOURCE_COMMIT:dgc/__init__.py" | sed -n 's/^__version__ = "\([^"]*\)"$/\1/p')
[ "$TAG" = "v$VERSION" ] || {
  echo "tag $TAG does not match dgc version $VERSION" >&2; exit 1;
}
# Public main is the tagged product commit. The website is not a git promotion.
if [ "$SOURCE_COMMIT" != "$HEAD_COMMIT" ]; then
  echo "public main must be the tagged product commit (website is not tracked)" >&2
  exit 1
fi
git fetch --quiet origin main
git merge-base --is-ancestor origin/main "$HEAD_COMMIT" || {
  echo "origin/main is not an ancestor of HEAD; reconcile without force-pushing" >&2
  exit 1
}
if git ls-remote --exit-code --refs origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "remote tag $TAG already exists; published tags are immutable" >&2
  exit 1
fi

"$ROOT/scripts/preflight.sh"
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
