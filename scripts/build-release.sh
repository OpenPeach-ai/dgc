#!/usr/bin/env bash
# Build a reproducible source/install archive from the exact committed tree.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR=${DGC_RELEASE_OUT:-"$ROOT/dist/release"}
PYTHON=${DGC_PYTHON:-python3}

cd "$ROOT"
git rev-parse --verify HEAD >/dev/null
if [ -n "$(git status --porcelain --untracked-files=normal)" ] && [ "${DGC_ALLOW_DIRTY:-0}" != 1 ]; then
  echo "release builds require a clean working tree (set DGC_ALLOW_DIRTY=1 only for a local smoke build)" >&2
  exit 1
fi

VERSION=$($PYTHON -c 'from dgc import __version__; print(__version__)')
COMMIT=$(git rev-parse HEAD)
EPOCH=${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct HEAD)}
mkdir -p "$OUT_DIR"

# git archive makes the artifact an auditable projection of HEAD, not an accidental mixture of
# uncommitted files. gzip -n removes timestamps, so the same commit produces the same bytes.
git archive --format=tar --prefix=dgc/ "$COMMIT" | gzip -n -9 > "$OUT_DIR/dgc.tar.gz"
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
$PYTHON scripts/generate-sbom.py "$OUT_DIR/dgc.cdx.json"

# Do not use grep -q here: under pipefail it can close the pipe after the first match, make tar
# receive SIGPIPE, and turn a valid release build into exit 141. grep consumes the complete listing.
tar -tzf "$OUT_DIR/dgc.tar.gz" | grep -Fx 'dgc/dgc/__init__.py' >/dev/null
tar -tzf "$OUT_DIR/dgc.tar.gz" | grep -Fx 'dgc/bench/run_bench.py' >/dev/null
echo "built reproducible DGC $VERSION @ ${COMMIT:0:12} → $OUT_DIR"
