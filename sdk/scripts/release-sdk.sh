#!/bin/bash
# Cut local SDK artifacts. Tests first, then regenerate SBOM and sign last.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
make -C sdk test
make -C sdk sbom
make -C sdk verify
python3 -m pip wheel -q -w /tmp/dgc-sdk-dist sdk/python
echo "SDK artifacts ready. Tag sdk-vVERSION (never v0.5.x CLI tags)."
