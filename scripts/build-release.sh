#!/usr/bin/env bash
# Build a reproducible runtime archive from an exact reviewed commit.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR=${DGC_RELEASE_OUT:-"$ROOT/dist/release"}
PYTHON=${DGC_PYTHON:-python3}

cd "$ROOT"
REQUESTED_REF=${DGC_RELEASE_REF:-HEAD}
if [ "$REQUESTED_REF" != HEAD ]; then
  echo "DGC_RELEASE_REF must be HEAD so the archive and working-tree SBOM cannot describe different revisions" >&2
  exit 1
fi
RELEASE_REF=HEAD
git rev-parse --verify "$RELEASE_REF^{commit}" >/dev/null
if [ -n "$(git status --porcelain --untracked-files=normal)" ] && [ "${DGC_ALLOW_DIRTY:-0}" != 1 ]; then
  echo "release builds require a clean working tree (set DGC_ALLOW_DIRTY=1 only for a local smoke build)" >&2
  exit 1
fi

COMMIT=$(git rev-parse "$RELEASE_REF^{commit}")
VERSION=$(git show "$COMMIT:dgc/__init__.py" | sed -n 's/^__version__ = "\([^"]*\)"$/\1/p')
[ -n "$VERSION" ] || { echo "could not read the release version from $COMMIT" >&2; exit 1; }
EPOCH=${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct "$COMMIT")}
mkdir -p "$OUT_DIR"

# Keep the customer payload deliberately narrow. Maintainer automation, tests, CI configuration,
# benchmark material, the website, and internal documentation never belong in the live installer.
# git archive still makes every included byte an auditable projection of the reviewed commit;
# gzip -n removes timestamps, so the same commit produces the same bytes.
git archive --format=tar --prefix=dgc/ "$COMMIT" -- \
  LICENSE README.md pyproject.toml requirements.lock dgc \
  | gzip -n -9 > "$OUT_DIR/dgc.tar.gz"
(cd "$OUT_DIR" && { sha256sum dgc.tar.gz 2>/dev/null || shasum -a 256 dgc.tar.gz; } \
  | awk '{print $1"  dgc.tar.gz"}' > dgc.tar.gz.sha256)

$PYTHON - "$OUT_DIR" "$VERSION" "$COMMIT" "$EPOCH" <<'PY'
import hashlib, json, pathlib, platform, sys
out, version, commit, epoch = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
artifact = out / "dgc.tar.gz"
sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
(out / "version.json").write_text(json.dumps({
    "schema_version": 1,
    "version": version,
    "commit": commit,
    "source_date_epoch": epoch,
    "sha256": sha,
    "artifact": "dgc.tar.gz",
    "sbom": "dgc.cdx.json",
    "provenance": "provenance.json",
    "install": "https://vibedgc.com/install.sh",
}, sort_keys=True, separators=(",", ":")) + "\n")
(out / "provenance.json").write_text(json.dumps({
    "schema_version": 1,
    "subject": {"name": "dgc.tar.gz", "sha256": sha, "bytes": artifact.stat().st_size},
    "source": {"repository": "https://github.com/OpenPeach-ai/dgc", "commit": commit},
    "build": {"source_date_epoch": epoch, "python": platform.python_version()},
}, sort_keys=True, indent=2) + "\n")
PY
$PYTHON -I scripts/generate-sbom.py "$OUT_DIR/dgc.cdx.json"

# Do not use grep -q here: under pipefail it can close the pipe after the first match, make tar
# receive SIGPIPE, and turn a valid release build into exit 141. grep consumes the complete listing.
tar -tzf "$OUT_DIR/dgc.tar.gz" | grep -Fx 'dgc/dgc/__init__.py' >/dev/null
tar -tzf "$OUT_DIR/dgc.tar.gz" | grep -Fx 'dgc/pyproject.toml' >/dev/null
if tar -tzf "$OUT_DIR/dgc.tar.gz" | grep -E '^dgc/(docs|scripts|tests|bench|site|\.git|\.github|AGENTS\.md)(/|$)' >/dev/null; then
  echo "release archive contains a non-runtime path" >&2
  exit 1
fi
"$PYTHON" "$ROOT/scripts/release_bundle.py" "$OUT_DIR"
echo "built reproducible DGC $VERSION @ ${COMMIT:0:12} → $OUT_DIR"
