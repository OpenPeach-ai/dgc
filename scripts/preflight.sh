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

if git grep -nEI '(BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{32,})' -- \
    . ':!scripts/preflight.sh'; then
  echo "tracked secret marker detected" >&2
  exit 1
fi

"$PYTHON" -m compileall -q dgc tests/run_tests.py
"$PYTHON" -m py_compile bench/*.py scripts/generate-sbom.py
"$PYTHON" tests/run_tests.py
"$PYTHON" -m pip check
SBOM_TMP=$(mktemp)
"$PYTHON" scripts/generate-sbom.py "$SBOM_TMP"
"$PYTHON" -c 'import json,sys; b=json.load(open(sys.argv[1])); assert b["bomFormat"] == "CycloneDX" and b["components"]' "$SBOM_TMP"

# Edit-primitive safety gate — the release gate that guards against DGC silently
# corrupting a user's code (WRONG must stay 0). It MUST run; never silently skip.
# The corpus is large + gitignored, so regenerate it deterministically from the
# pinned dataset when absent, and fail loudly if neither corpus nor dataset exists.
CORPUS=bench/edit_corpus/all.jsonl
if [ ! -f "$CORPUS" ] && [ -d bench/data/polyglot-benchmark ]; then
  echo "edit corpus absent — regenerating from the pinned dataset…"
  mkdir -p bench/edit_corpus
  "$PYTHON" bench/gen_edit_corpus.py > "$CORPUS.tmp" && mv "$CORPUS.tmp" "$CORPUS"
fi
if [ ! -f "$CORPUS" ]; then
  echo "FATAL: the edit-primitive safety corpus is absent and cannot be regenerated" >&2
  echo "  (bench/data/polyglot-benchmark is missing). This gate must not be skipped —" >&2
  echo "  fetch the dataset, then re-run. See bench/gen_edit_corpus.py." >&2
  exit 1
fi
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
