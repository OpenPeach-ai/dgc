#!/usr/bin/env bash
# Local equivalent of the release-blocking CI gates. It makes no external changes.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PYTHON=${DGC_PYTHON:-"$ROOT/.venv/bin/python"}
[ -x "$PYTHON" ] || PYTHON=python3
cd "$ROOT"

if [ "${DGC_ALLOW_DIRTY:-0}" != 1 ] && [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "preflight requires a clean tree (DGC_ALLOW_DIRTY=1 is for local development only)" >&2
  exit 1
fi

for script in scripts/*.sh bench/*.sh install.sh site/install.sh; do bash -n "$script"; done
cmp -s install.sh site/install.sh || { echo "root and site installers differ" >&2; exit 1; }

# The redaction suite must contain synthetic credentials by construction — that is exactly what it
# asserts on. Exclude only that fixture-bearing test path; every other tracked path is still scanned.
if git grep -nEI '(BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{32,})' -- \
    . ':!scripts/preflight.sh' ':!tests/'; then
  echo "tracked secret marker detected" >&2
  exit 1
fi

"$PYTHON" -m compileall -q dgc tests/run_tests.py
"$PYTHON" -m py_compile bench/*.py scripts/generate-sbom.py scripts/release_bundle.py
"$PYTHON" tests/run_tests.py
"$PYTHON" -m pip check
SBOM_TMP=$(mktemp)
EDIT_GATE_TMP=
cleanup_preflight() {
  [ -z "$SBOM_TMP" ] || rm -f -- "$SBOM_TMP"
  [ -z "$EDIT_GATE_TMP" ] || rm -rf -- "$EDIT_GATE_TMP"
}
trap cleanup_preflight EXIT
"$PYTHON" -I scripts/generate-sbom.py "$SBOM_TMP"
"$PYTHON" - "$SBOM_TMP" "$ROOT/requirements.lock" "$ROOT/scripts/release_bundle.py" <<'PY'
import copy
import importlib.util
import json
import pathlib
import sys
import tempfile

sbom_path, lock_path, validator_path = map(pathlib.Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("dgc_release_bundle", validator_path)
if spec is None or spec.loader is None:
    raise SystemExit("could not load the release-bundle validator")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
lock = lock_path.read_bytes()
version = sbom.get("metadata", {}).get("component", {}).get("version")

errors = []
validator._validate_runtime_sbom(sbom, version, lock, errors)
if errors:
    raise SystemExit("generated runtime SBOM failed validation: " + "; ".join(errors))

def rejected(label, mutate, expected):
    candidate = copy.deepcopy(sbom)
    mutate(candidate)
    candidate_errors = []
    validator._validate_runtime_sbom(candidate, version, lock, candidate_errors)
    if not any(expected in error for error in candidate_errors):
        raise SystemExit(f"SBOM validator accepted {label}: {candidate_errors!r}")

rejected("a duplicate component", lambda b: b["components"].append(
    copy.deepcopy(b["components"][0])), "duplicate component purl")
rejected("an editor npm component", lambda b: b["components"].append({
    "type": "library", "name": "typescript", "version": "0",
    "purl": "pkg:npm/typescript@0", "bom-ref": "pkg:npm/typescript@0",
    "scope": "excluded",
}), "non-Python component")
rejected("a missing locked component", lambda b: b["components"].pop(),
         "missing runtime component")
rejected("mismatched component metadata", lambda b: b["components"][0].update(
    {"version": "wrong"}), "component metadata does not match")
rejected("an extra component field", lambda b: b["components"][0].update(
    {"description": "not emitted"}), "has unexpected fields")
rejected("a malformed component", lambda b: b["components"].append("malformed"),
         "is not an object")
rejected("an unproven dependency graph", lambda b: b.update({"dependencies": []}),
         "must omit a dependency graph")
rejected("an extra top-level field", lambda b: b.update({"annotations": []}),
         "top-level fields do not match")
rejected("an extra root-component field", lambda b: b["metadata"]["component"].update(
    {"description": "not emitted"}), "metadata/root component does not match")

duplicate_errors = []
validator._locked_python_components(
    b"Example_Package==1.0\nexample-package==2.0\n", duplicate_errors)
if not any("duplicate package" in error for error in duplicate_errors):
    raise SystemExit("runtime-lock parser accepted duplicate normalized package names")
invalid_errors = []
validator._locked_python_components(b"example==1;python_version>='3.10'\n", invalid_errors)
if not any("not an exact package pin" in error for error in invalid_errors):
    raise SystemExit("runtime-lock parser accepted a conditional/non-version entry")

with tempfile.TemporaryDirectory() as temp_dir:
    sidecar = pathlib.Path(temp_dir) / "version.json"
    sidecar.write_bytes(b'{"api_key":"short-secret"}')
    sidecar_errors = []
    validator._read_sidecar(sidecar, sidecar_errors)
    if not any("credential marker" in error for error in sidecar_errors):
        raise SystemExit("release sidecar credential field was not rejected")
    sidecar.write_bytes(b" " * (16 * 1024 + 1))
    bound_errors = []
    validator._read_sidecar(sidecar, bound_errors)
    if not any("sidecar bound" in error for error in bound_errors):
        raise SystemExit("oversized release sidecar was not rejected")
    duplicate_errors = []
    validator._load_object(sidecar, b'{"version":1,"version":2}', duplicate_errors)
    if not any("duplicate object key" in error for error in duplicate_errors):
        raise SystemExit("duplicate JSON sidecar key was not rejected")
print(f"runtime SBOM contract verified: {len(sbom['components'])} Python components")
PY

# Edit-primitive safety gate — the release gate that guards against DGC silently corrupting a
# user's code (WRONG must stay 0). The corpus contains upstream Exercism reference solutions, so it
# stays ignored instead of redistributing that material without its per-exercise notices. When a
# reviewed local corpus is absent, fetch the exact pinned benchmark commit and regenerate it.
CORPUS=bench/edit_corpus/all.jsonl
CORPUS_SHA256=8d5a5f39088e5779921260a683bfca6fa4f4d1163c78e1c68fdb36cd7426eaac
DATASET_COMMIT=7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f
if [ ! -f "$CORPUS" ]; then
  EDIT_GATE_TMP=$(mktemp -d)
  DATASET="$EDIT_GATE_TMP/polyglot-benchmark"
  echo "edit corpus absent — regenerating from pinned polyglot benchmark $DATASET_COMMIT…"
  git init -q "$DATASET"
  git -C "$DATASET" remote add origin https://github.com/Aider-AI/polyglot-benchmark.git
  git -C "$DATASET" fetch -q --depth=1 origin "$DATASET_COMMIT"
  git -C "$DATASET" checkout -q --detach FETCH_HEAD
  [ "$(git -C "$DATASET" rev-parse HEAD)" = "$DATASET_COMMIT" ] || {
    echo "FATAL: fetched edit-corpus dataset does not match its reviewed commit" >&2
    exit 1
  }
  CORPUS="$EDIT_GATE_TMP/all.jsonl"
  DGC_EDIT_DATASET="$DATASET" "$PYTHON" bench/gen_edit_corpus.py > "$CORPUS"
fi
"$PYTHON" - "$CORPUS" "$CORPUS_SHA256" <<'PY'
import hashlib, pathlib, sys
path, expected = pathlib.Path(sys.argv[1]), sys.argv[2]
digest = hashlib.sha256()
with path.open("rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
digest = digest.hexdigest()
if digest != expected:
    raise SystemExit(f"edit corpus digest mismatch: {digest}")
PY
"$PYTHON" bench/edit_micro.py "$CORPUS"

(
  cd editors/vscode
  npm ci
  npm run check-types
  npm test
  npm run package
  npm audit --audit-level=moderate
)
echo "all DGC preflight gates passed"
