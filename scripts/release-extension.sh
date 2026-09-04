#!/usr/bin/env bash
# Build, stage, or publish one already-reviewed extension artifact. Every external channel is an
# independent explicit phase so a registry failure can never cascade into a site deployment.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXT="$ROOT/editors/vscode"
OUT=${DGC_EXTENSION_OUT:-"$ROOT/dist/extension"}
MODE=${1:---build}
cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=normal)" ] || {
  echo "extension release phases require a clean reviewed commit" >&2; exit 1;
}

VER=$(node -p "require('$EXT/package.json').version")
COMMIT=$(git rev-parse HEAD)
REGISTRY="$OUT/dgc-$VER-registry.vsix"
SELFHOST="$OUT/dgc-$VER-selfhost.vsix"
CHECKSUMS="$OUT/dgc-$VER.sha256"
MANIFEST="$OUT/dgc-$VER.manifest.json"

verify_bundle() {
  SOURCE_COMMIT=$(python3 - "$MANIFEST" <<'PY'
import json, pathlib, re, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
commit = value.get("source_commit", "")
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
    raise SystemExit("extension manifest has an invalid source commit")
print(commit)
PY
  )
  git cat-file -e "$SOURCE_COMMIT^{commit}" 2>/dev/null || {
    echo "extension source commit does not exist locally" >&2; exit 1;
  }
  git merge-base --is-ancestor "$SOURCE_COMMIT" HEAD || {
    echo "extension source commit is not an ancestor of HEAD" >&2; exit 1;
  }
  git diff --quiet "$SOURCE_COMMIT" HEAD -- \
    editors/vscode dgc/editor_protocol.py dgc/headless.py schemas || {
    echo "extension/backend protocol sources changed after the artifact was built" >&2; exit 1;
  }
  python3 - "$OUT" "$VER" "$SOURCE_COMMIT" <<'PY'
import hashlib, json, pathlib, sys
root, version, source_commit = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
names = [f"dgc-{version}-registry.vsix", f"dgc-{version}-selfhost.vsix"]
manifest_path = root / f"dgc-{version}.manifest.json"
checksum_path = root / f"dgc-{version}.sha256"
if not manifest_path.is_file() or not checksum_path.is_file():
    raise SystemExit("extension bundle manifest/checksums are missing; run --build")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
expected = {"schema_version": 1, "version": version, "source_commit": source_commit,
            "files": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                      for name in names if (root / name).is_file()}}
if manifest != expected or set(manifest.get("files", {})) != set(names):
    raise SystemExit("extension bundle does not match this exact reviewed commit")
lines = checksum_path.read_text(encoding="utf-8").splitlines()
if lines != [f'{manifest["files"][name]}  {name}' for name in names]:
    raise SystemExit("extension checksum file disagrees with the manifest")
PY
  python3 "$ROOT/scripts/check-extension-vsix.py" \
    --registry "$REGISTRY" \
    --selfhost "$SELFHOST" \
    --extension-root "$EXT" \
    --version "$VER" \
    --source-commit "$SOURCE_COMMIT"
}

require_public_head() {
  [ "$(git branch --show-current)" = "main" ] || {
    echo "registry publication requires the public main branch" >&2; exit 1;
  }
  git fetch --quiet origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
    echo "registry publication requires HEAD to equal origin/main" >&2; exit 1;
  }
  python3 "$ROOT/scripts/check-site.py"
}

case "$MODE" in
  --build)
    cd "$EXT"
    npm ci
    npm run check-types
    npm test
    npm audit --audit-level=moderate
    mkdir -p "$OUT"
    # Run the release-signoff smoke in a real VS Code extension host. The runner fails when no
    # desktop executable is available; there is deliberately no unit-test-only skip path.
    DGC_SOURCE_COMMIT="$COMMIT" DGC_SELF_HOSTED=false npm run package
    npm run test:host
    # vsce runs vscode:prepublish itself. Pass the flavor through that child process so the
    # self-hosted package cannot be silently rebuilt with registry defaults.
    DGC_SOURCE_COMMIT="$COMMIT" DGC_SELF_HOSTED=false \
      ./node_modules/.bin/vsce package --no-dependencies -o "$REGISTRY"
    DGC_SOURCE_COMMIT="$COMMIT" DGC_SELF_HOSTED=true \
      ./node_modules/.bin/vsce package --no-dependencies -o "$SELFHOST"
    python3 - "$OUT" "$VER" "$COMMIT" <<'PY'
import hashlib, json, pathlib, sys
root, version, commit = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
names = [f"dgc-{version}-registry.vsix", f"dgc-{version}-selfhost.vsix"]
files = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}
(root / f"dgc-{version}.sha256").write_text(
    "".join(f"{files[name]}  {name}\n" for name in names), encoding="utf-8")
(root / f"dgc-{version}.manifest.json").write_text(json.dumps({
    "schema_version": 1, "version": version, "source_commit": commit, "files": files,
}, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
    verify_bundle
    echo "built verified extension $VER @ ${COMMIT:0:12} → $OUT"
    ;;
  --stage-site)
    verify_bundle
    mkdir -p "$OUT/prior-site"
    for old in "$ROOT"/site/vscode/dgc-*.vsix; do
      [ -e "$old" ] || continue
      [ "$(basename "$old")" = "dgc-$VER.vsix" ] || mv "$old" "$OUT/prior-site/"
    done
    cp "$SELFHOST" "$ROOT/site/vscode/dgc-$VER.vsix"
    cp "$SELFHOST" "$ROOT/site/vscode/dgc.vsix"
    python3 - "$ROOT/site/vscode" "$VER" <<'PY'
import hashlib, json, pathlib, sys
root, version = pathlib.Path(sys.argv[1]), sys.argv[2]
artifact = root / "dgc.vsix"
(root / "dgc.vsix.sha256").write_text(
    f"{hashlib.sha256(artifact.read_bytes()).hexdigest()}  dgc.vsix\n", encoding="utf-8")
(root / "version.json").write_text(json.dumps({
    "version": version, "vsix": "https://vibedgc.com/vscode/dgc.vsix",
    "page": "https://vibedgc.com/vscode/",
    "notes": "https://vibedgc.com/changelog#extension",
}, separators=(",", ":")) + "\n", encoding="utf-8")
PY
    echo "staged verified self-hosted extension $VER in site/; review and commit separately"
    ;;
  --publish-marketplace)
    require_public_head
    verify_bundle
    [ -n "${VSCE_PAT:-}" ] || { echo "VSCE_PAT is required" >&2; exit 1; }
    "$EXT/node_modules/.bin/vsce" publish --packagePath "$REGISTRY"
    ;;
  --publish-open-vsx)
    require_public_head
    verify_bundle
    [ -n "${OVSX_PAT:-}" ] || { echo "OVSX_PAT is required" >&2; exit 1; }
    "$EXT/node_modules/.bin/ovsx" publish "$REGISTRY"
    ;;
  --publish|--publish-registries)
    echo "$MODE is intentionally unsupported; publish each registry and stage the site explicitly" >&2
    exit 2
    ;;
  *)
    echo "usage: release-extension.sh [--build|--stage-site|--publish-marketplace|--publish-open-vsx]" >&2
    exit 2
    ;;
esac
