#!/usr/bin/env python3
"""Generate a deterministic CycloneDX SBOM from DGC's committed lockfiles."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent


def locked_python() -> list[dict]:
    components = []
    for raw in (ROOT / "requirements.lock").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s]+)", line)
        if not match:
            raise SystemExit(f"requirements.lock contains a non-exact entry: {line}")
        name, version = match.groups()
        normalized = name.lower().replace("_", "-")
        purl = f"pkg:pypi/{quote(normalized)}@{quote(version)}"
        components.append({"type": "library", "name": name, "version": version,
                           "purl": purl, "bom-ref": purl, "scope": "required"})
    return components


def npm_name(path: str, record: dict) -> str:
    return str(record.get("name") or path.rsplit("node_modules/", 1)[-1])


def locked_npm() -> list[dict]:
    lock = json.loads((ROOT / "editors/vscode/package-lock.json").read_text(encoding="utf-8"))
    components = []
    for path, record in sorted((lock.get("packages") or {}).items()):
        if not path or not isinstance(record, dict) or not record.get("version"):
            continue
        name, version = npm_name(path, record), str(record["version"])
        purl = f"pkg:npm/{quote(name, safe='/')}@{quote(version)}"
        component = {"type": "library", "name": name, "version": version,
                     "purl": purl, "bom-ref": f"{purl}#{quote(path, safe='')}",
                     "scope": "optional" if record.get("optional") else
                              ("excluded" if record.get("dev") else "required")}
        if record.get("integrity"):
            component["properties"] = [{"name": "npm:integrity", "value": record["integrity"]}]
        components.append(component)
    return components


def main() -> None:
    from dgc import __version__

    output = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist/release/dgc.cdx.json"
    root_ref = f"pkg:pypi/dgc@{quote(__version__)}"
    components = locked_python() + locked_npm()
    bom = {
        "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
        "metadata": {
            "component": {"type": "application", "name": "dgc", "version": __version__,
                          "purl": root_ref, "bom-ref": root_ref},
            "properties": [{"name": "dgc:source", "value": "https://github.com/OpenPeach-ai/dgc"}],
        },
        "components": sorted(components, key=lambda c: c["bom-ref"]),
        "dependencies": [{"ref": root_ref, "dependsOn": sorted(c["bom-ref"] for c in components)}],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(bom, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote CycloneDX SBOM with {len(components)} components: {output}")


if __name__ == "__main__":
    main()
