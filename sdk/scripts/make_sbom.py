#!/usr/bin/env python3
"""Write CycloneDX-ish SBOM + SHA256SUMS for the in-tree SDK. Does not publish."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "sdk"
OUT = SDK / "sbom"
SIGNING = SDK / ".signing"


def _files() -> list[Path]:
    paths = []
    for folder in (SDK / "python" / "dgc_sdk", SDK / "typescript" / "src"):
        if folder.is_dir():
            paths.extend(sorted(p for p in folder.rglob("*") if p.is_file()))
    extra = [SDK / "python" / "pyproject.toml", SDK / "typescript" / "package.json", SDK / "README.md"]
    paths.extend(p for p in extra if p.is_file())
    return paths


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    components = []
    sums = []
    for path in _files():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rel = path.relative_to(ROOT).as_posix()
        components.append({
            "type": "file",
            "name": rel,
            "hashes": [{"alg": "SHA-256", "content": digest}],
        })
        sums.append(f"{digest}  {rel}")
    bom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {"type": "library", "name": "dgc-sdk", "version": "0.5.0"},
        },
        "components": components,
    }
    (OUT / "cyclonedx.json").write_text(json.dumps(bom, indent=2) + "\n", encoding="utf-8")
    (OUT / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    SIGNING.mkdir(parents=True, exist_ok=True)
    key = SIGNING / "sdk.key"
    pub = SIGNING / "sdk.pub"
    if not key.is_file():
        subprocess.run(
            ["openssl", "genrsa", "-out", str(key), "2048"],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["openssl", "rsa", "-in", str(key), "-pubout", "-out", str(pub)],
            check=True, capture_output=True,
        )
    sig = OUT / "SHA256SUMS.sig"
    subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(key), "-out", str(sig), str(OUT / "SHA256SUMS")],
        check=True, capture_output=True,
    )
    print(f"wrote {OUT / 'cyclonedx.json'} ({len(components)} files), SHA256SUMS, SHA256SUMS.sig")
    print("verify: openssl dgst -sha256 -verify sdk/.signing/sdk.pub -signature sdk/sbom/SHA256SUMS.sig sdk/sbom/SHA256SUMS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
