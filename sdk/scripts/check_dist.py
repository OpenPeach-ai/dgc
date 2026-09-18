#!/usr/bin/env python3
"""Check built SDK release artifacts before anything publishes them.

    python3 sdk/scripts/check_dist.py DIST_DIR

DIST_DIR holds exactly one dgc_sdk wheel and sdist, and optionally the vibedgc-sdk npm tarball.
Every artifact must carry the version from sdk/python/dgc_sdk/_version.py and the Apache-2.0
LICENSE, and must contain only the package (no tests, scripts, caches or credentials).
"""
from __future__ import annotations

import io
import json
import re
import sys
import tarfile
import zipfile
from email.parser import Parser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LICENSE = (ROOT / "LICENSE").read_bytes()


def sdk_version() -> str:
    text = (ROOT / "sdk" / "python" / "dgc_sdk" / "_version.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__\s*=\s*"([^"]+)"', text, re.M)
    if not match:
        raise SystemExit("could not read __version__ from sdk/python/dgc_sdk/_version.py")
    return match.group(1)


def _forbidden(name: str) -> bool:
    parts = name.split("/")
    return (any(part in ("__pycache__", "tests", ".signing", "node_modules") for part in parts)
            or name.endswith((".pyc", ".pyo", ".key", ".pem", ".env")))


def check_wheel(path: Path, version: str) -> list[str]:
    errors: list[str] = []
    with zipfile.ZipFile(path) as wheel:
        names = wheel.namelist()
        info = f"dgc_sdk-{version}.dist-info"
        meta = Parser().parsestr(wheel.read(f"{info}/METADATA").decode("utf-8"))
        if meta.get("Version") != version:
            errors.append(f"{path.name}: METADATA version {meta.get('Version')!r}, expected {version!r}")
        if meta.get("License-Expression") != "Apache-2.0":
            errors.append(f"{path.name}: License-Expression is {meta.get('License-Expression')!r}")
        if "LICENSE" not in (meta.get_all("License-File") or []):
            errors.append(f"{path.name}: METADATA has no License-File: LICENSE")
        license_path = f"{info}/licenses/LICENSE"
        if license_path not in names:
            errors.append(f"{path.name}: {license_path} is missing")
        elif wheel.read(license_path) != LICENSE:
            errors.append(f"{path.name}: bundled LICENSE differs from the repository LICENSE")
        if "dgc_sdk/py.typed" not in names:
            errors.append(f"{path.name}: dgc_sdk/py.typed is missing")
        body = wheel.read("dgc_sdk/_version.py").decode("utf-8")
        if f'__version__ = "{version}"' not in body:
            errors.append(f"{path.name}: dgc_sdk/_version.py does not say {version}")
        stray = [name for name in names if not (name.startswith("dgc_sdk/") or name.startswith(info + "/"))]
        stray += [name for name in names if _forbidden(name)]
        if stray:
            errors.append(f"{path.name}: unexpected members {sorted(set(stray))[:8]}")
    return errors


def check_sdist(path: Path, version: str) -> list[str]:
    errors: list[str] = []
    prefix = f"dgc_sdk-{version}/"
    with tarfile.open(path) as sdist:
        names = sdist.getnames()
        if any(not name.startswith(prefix.rstrip("/")) for name in names):
            errors.append(f"{path.name}: members outside {prefix}")
        member = sdist.extractfile(prefix + "LICENSE") if prefix + "LICENSE" in names else None
        if member is None:
            errors.append(f"{path.name}: {prefix}LICENSE is missing")
        elif member.read() != LICENSE:
            errors.append(f"{path.name}: bundled LICENSE differs from the repository LICENSE")
        pkg_info = sdist.extractfile(prefix + "PKG-INFO")
        meta = Parser().parsestr(pkg_info.read().decode("utf-8")) if pkg_info else None
        if meta is None or meta.get("Version") != version:
            errors.append(f"{path.name}: PKG-INFO does not say version {version}")
        stray = [name for name in names if _forbidden(name)]
        if stray:
            errors.append(f"{path.name}: unexpected members {sorted(stray)[:8]}")
    return errors


def check_npm(path: Path, version: str) -> list[str]:
    errors: list[str] = []
    with tarfile.open(path) as tgz:
        names = set(tgz.getnames())
        manifest_file = tgz.extractfile("package/package.json")
        manifest = json.load(io.TextIOWrapper(manifest_file, encoding="utf-8")) if manifest_file else {}
        if manifest.get("version") != version:
            errors.append(f"{path.name}: package.json version {manifest.get('version')!r}, expected {version!r}")
        exports = (manifest.get("exports") or {}).get(".") or {}
        for key, target in (("import", exports.get("import")), ("types", exports.get("types")),
                            ("main", manifest.get("main"))):
            if not isinstance(target, str) or not target.startswith("./dist/") \
                    or "package/" + target[2:] not in names:
                errors.append(f"{path.name}: {key} points at {target!r}, which is not a packaged dist file")
        for needed in ("package/LICENSE", "package/README.md", "package/dist/mcp-bridge.mjs"):
            if needed not in names:
                errors.append(f"{path.name}: {needed} is missing")
        license_file = tgz.extractfile("package/LICENSE") if "package/LICENSE" in names else None
        if license_file is not None and license_file.read() != LICENSE:
            errors.append(f"{path.name}: bundled LICENSE differs from the repository LICENSE")
        sources = [name for name in names if name.endswith(".ts") and not name.endswith(".d.ts")]
        if sources or any(_forbidden(name) for name in names):
            errors.append(f"{path.name}: TypeScript sources or unexpected members are packaged")
    return errors


def check(dist: Path) -> list[str]:
    version = sdk_version()
    wheels = sorted(dist.glob("dgc_sdk-*.whl"))
    sdists = sorted(dist.glob("dgc_sdk-*.tar.gz"))
    npm = sorted(dist.glob("vibedgc-sdk-*.tgz"))
    errors: list[str] = []
    if [p.name for p in wheels] != [f"dgc_sdk-{version}-py3-none-any.whl"]:
        errors.append(f"expected exactly dgc_sdk-{version}-py3-none-any.whl, found {[p.name for p in wheels]}")
    if [p.name for p in sdists] != [f"dgc_sdk-{version}.tar.gz"]:
        errors.append(f"expected exactly dgc_sdk-{version}.tar.gz, found {[p.name for p in sdists]}")
    if npm and [p.name for p in npm] != [f"vibedgc-sdk-{version}.tgz"]:
        errors.append(f"expected vibedgc-sdk-{version}.tgz, found {[p.name for p in npm]}")
    for path in wheels:
        errors += check_wheel(path, version)
    for path in sdists:
        errors += check_sdist(path, version)
    for path in npm:
        errors += check_npm(path, version)
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    errors = check(Path(argv[0]))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"dgc-sdk {sdk_version()} artifacts ok in {argv[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
