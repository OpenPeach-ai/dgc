#!/usr/bin/env python3
"""Write CycloneDX SBOM + SHA256SUMS for the in-tree SDK, then sign.

Run after every SDK source change, as the last step before a release cut:

    python3 sdk/scripts/make_sbom.py
    python3 sdk/scripts/make_sbom.py --verify

Hashed set is source only: no __pycache__, no .pyc, no SBOM outputs, no signing keys.
The signature is produced last, over SHA256SUMS of the current tree.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "sdk"
OUT = SDK / "sbom"
SIGNING = SDK / ".signing"
SKIP_DIR_NAMES = frozenset({"__pycache__", ".signing", "sbom"})
SKIP_SUFFIXES = (".pyc", ".pyo", ".so", ".sig")


def sdk_version() -> str:
    text = (SDK / "python" / "dgc_sdk" / "_version.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__\s*=\s*"([^"]+)"', text, re.M)
    if not match:
        raise SystemExit("could not read sdk/python/dgc_sdk/_version.py")
    return match.group(1)


def source_files() -> list[Path]:
    paths: list[Path] = []
    for folder in (SDK / "python" / "dgc_sdk", SDK / "typescript" / "src"):
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            if not path.is_file():
                continue
            if any(part in SKIP_DIR_NAMES for part in path.relative_to(SDK).parts):
                continue
            if path.suffix in SKIP_SUFFIXES:
                continue
            paths.append(path)
    extra = [
        SDK / "python" / "pyproject.toml",
        SDK / "typescript" / "package.json",
        SDK / "README.md",
        SDK / "COMPATIBILITY.md",
    ]
    paths.extend(path for path in extra if path.is_file())
    return paths


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_sbom() -> int:
    version = sdk_version()
    files = source_files()
    components = [{
        "type": "library",
        "name": "dgc-sdk",
        "version": version,
        "purl": f"pkg:generic/dgc-sdk@{version}",
    }]
    sums: list[str] = []
    for path in files:
        digest = sha256(path)
        rel = path.relative_to(ROOT).as_posix()
        components.append({
            "type": "file",
            "name": rel,
            "version": version,
            "hashes": [{"alg": "SHA-256", "content": digest}],
        })
        sums.append(f"{digest}  {rel}")
    bom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {"type": "library", "name": "dgc-sdk", "version": version},
        },
        "components": components,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "cyclonedx.json").write_text(json.dumps(bom, indent=2) + "\n", encoding="utf-8")
    sums_path = OUT / "SHA256SUMS"
    sums_path.write_text("\n".join(sums) + "\n", encoding="utf-8")
    SIGNING.mkdir(parents=True, exist_ok=True)
    key = SIGNING / "sdk.key"
    pub = SIGNING / "sdk.pub"
    if not key.is_file():
        subprocess.run(["openssl", "genrsa", "-out", str(key), "2048"], check=True, capture_output=True)
        subprocess.run(["openssl", "rsa", "-in", str(key), "-pubout", "-out", str(pub)],
                       check=True, capture_output=True)
    sig = OUT / "SHA256SUMS.sig"
    subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(key), "-out", str(sig), str(sums_path)],
        check=True, capture_output=True,
    )
    print(f"dgc-sdk {version}: {len(files)} source files, signed SHA256SUMS")
    return 0


def verify() -> int:
    version = sdk_version()
    sums_path = OUT / "SHA256SUMS"
    bom_path = OUT / "cyclonedx.json"
    if not sums_path.is_file() or not bom_path.is_file():
        print("missing sdk/sbom/SHA256SUMS or cyclonedx.json", file=sys.stderr)
        return 1
    listed: dict[str, str] = {}
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, _, rel = line.partition("  ")
        listed[rel] = digest
    expected = {path.relative_to(ROOT).as_posix(): sha256(path) for path in source_files()}
    errors: list[str] = []
    if set(listed) != set(expected):
        missing = sorted(set(expected) - set(listed))
        extra = sorted(set(listed) - set(expected))
        if missing:
            errors.append("SUMS missing: " + ", ".join(missing[:12]))
        if extra:
            errors.append("SUMS extra: " + ", ".join(extra[:12]))
    mismatches = [rel for rel, digest in listed.items() if expected.get(rel) and expected[rel] != digest]
    if mismatches:
        errors.append("checksum mismatch: " + ", ".join(mismatches[:12]))
    pyc = [rel for rel in listed if "__pycache__" in rel or rel.endswith(".pyc")]
    if pyc:
        errors.append("pycache in SUMS: " + ", ".join(pyc[:8]))
    bom = json.loads(bom_path.read_text(encoding="utf-8"))
    meta = bom.get("metadata") or {}
    component = meta.get("component") or {}
    if str(component.get("version") or "") != version:
        errors.append(f"SBOM metadata.component.version is {component.get('version')!r}, expected {version!r}")
    libs = [row for row in bom.get("components") or [] if row.get("type") == "library"]
    if not any(row.get("name") == "dgc-sdk" and row.get("version") == version for row in libs):
        errors.append("SBOM components[] has no library dgc-sdk@" + version)
    bom_files: dict[str, str] = {}
    for row in bom.get("components") or []:
        name = str(row.get("name") or "")
        if row.get("type") != "file":
            continue
        if "__pycache__" in name or name.endswith(".pyc"):
            errors.append("pycache in SBOM: " + name)
            continue
        if str(row.get("version") or "") != version:
            errors.append(f"SBOM file {name} version is {row.get('version')!r}, expected {version!r}")
        hashes = {
            str(item.get("alg")): str(item.get("content") or "")
            for item in (row.get("hashes") or [])
            if isinstance(item, dict)
        }
        digest = hashes.get("SHA-256")
        if not digest:
            errors.append("SBOM file missing SHA-256: " + name)
            continue
        bom_files[name] = digest
    if set(bom_files) != set(expected):
        missing = sorted(set(expected) - set(bom_files))
        extra = sorted(set(bom_files) - set(expected))
        if missing:
            errors.append("SBOM missing: " + ", ".join(missing[:12]))
        if extra:
            errors.append("SBOM extra: " + ", ".join(extra[:12]))
    bom_mismatch = [rel for rel, digest in bom_files.items() if expected.get(rel) != digest]
    if bom_mismatch:
        errors.append("SBOM hash mismatch: " + ", ".join(bom_mismatch[:12]))
    sums_mismatch = [rel for rel, digest in listed.items() if bom_files.get(rel) and bom_files[rel] != digest]
    if sums_mismatch:
        errors.append("SBOM/SUMS disagree: " + ", ".join(sums_mismatch[:12]))
    pub = SIGNING / "sdk.pub"
    sig = OUT / "SHA256SUMS.sig"
    if pub.is_file() and sig.is_file():
        check = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(pub), "-signature", str(sig), str(sums_path)],
            capture_output=True, text=True,
        )
        if check.returncode != 0:
            errors.append("SHA256SUMS.sig does not verify")
    else:
        errors.append("missing sdk/.signing/sdk.pub or SHA256SUMS.sig")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"SBOM ok: dgc-sdk {version}, {len(listed)} files, signature valid")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true", help="check SUMS against the current tree")
    args = parser.parse_args()
    if args.verify:
        return verify()
    write_sbom()
    return verify()


if __name__ == "__main__":
    raise SystemExit(main())
