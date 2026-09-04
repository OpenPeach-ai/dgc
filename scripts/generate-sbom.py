#!/usr/bin/env python3
"""Generate the deterministic CycloneDX SBOM for DGC's runtime archive."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
LOCK_ENTRY_RE = re.compile(
    r"([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)=="
    r"([A-Za-z0-9](?:[A-Za-z0-9.!+_-]*[A-Za-z0-9])?)\Z"
)


def locked_python() -> list[dict]:
    """Return the exact dependency closure installed from requirements.lock."""
    components = []
    seen: set[str] = set()
    for raw in (ROOT / "requirements.lock").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = LOCK_ENTRY_RE.fullmatch(line)
        if not match:
            raise SystemExit(f"requirements.lock contains a non-exact entry: {line}")
        name, version = match.groups()
        normalized = re.sub(r"[-_.]+", "-", name).lower()
        if normalized in seen:
            raise SystemExit(f"requirements.lock contains a duplicate package: {name}")
        seen.add(normalized)
        purl = f"pkg:pypi/{quote(normalized, safe='')}@{quote(version, safe='')}"
        components.append({"type": "library", "name": name, "version": version,
                           "purl": purl, "bom-ref": purl, "scope": "required"})
    return components


def main() -> None:
    from dgc import __version__

    output = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist/release/dgc.cdx.json"
    root_ref = f"pkg:pypi/dgc@{quote(__version__, safe='')}"
    # This document is attached to dgc.tar.gz, whose installer consumes only
    # requirements.lock.  The separately published editor extension is a different
    # artifact and its npm build/dev graph must not be represented as core runtime code.
    components = locked_python()
    bom = {
        "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
        "metadata": {
            "component": {"type": "application", "name": "dgc", "version": __version__,
                          "purl": root_ref, "bom-ref": root_ref},
            "properties": [{"name": "dgc:source", "value": "https://github.com/OpenPeach-ai/dgc"}],
        },
        "components": sorted(components, key=lambda c: c["bom-ref"]),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(bom, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote runtime CycloneDX SBOM with {len(components)} Python components: {output}")


if __name__ == "__main__":
    main()
