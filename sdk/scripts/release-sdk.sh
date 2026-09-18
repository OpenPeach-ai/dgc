#!/bin/bash
# Local dry run of an SDK release build: the same checks the publish workflow runs on the tag.
# Publishing happens only in .github/workflows/publish-dgc-sdk.yml, from an sdk-vX.Y.Z tag.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT=$(mktemp -d "${TMPDIR:-/tmp}/dgc-sdk-dist.XXXXXX")
python3 sdk/scripts/make_sbom.py --verify
python3 -m build sdk/python --outdir "$OUT"
python3 -m twine check --strict "$OUT"/*
(cd sdk/typescript && npm ci && npm pack --pack-destination "$OUT")
python3 sdk/scripts/check_dist.py "$OUT"
make -C sdk test
python3 sdk/scripts/make_sbom.py --dist "$OUT"
echo "SDK artifacts in $OUT. Release by pushing tag sdk-v$(python3 -c 'import re,sys;print(re.search(r"__version__ = \"([^\"]+)\"", open("sdk/python/dgc_sdk/_version.py").read()).group(1))')."
