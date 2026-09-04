#!/usr/bin/env python3
"""Fail-closed validation for the two DGC extension release artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import xml.etree.ElementTree as ET
import zipfile


STATIC_MEMBERS = {
    "extension/package.json": "package.json",
    "extension/icon.png": "icon.png",
    "extension/THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
    "extension/readme.md": "README.md",
    "extension/LICENSE.txt": "LICENSE",
    "extension/changelog.md": "CHANGELOG.md",
    "extension/media/walkthrough.md": "media/walkthrough.md",
    "extension/media/main.js": "media/main.js",
    "extension/media/main.css": "media/main.css",
    "extension/media/dgc.svg": "media/dgc.svg",
    "extension/media/dgc-mark.svg": "media/dgc-mark.svg",
    "extension/media/codicon.ttf": "media/codicon.ttf",
    "extension/media/codicon.css": "media/codicon.css",
    "extension/licenses/CODICONS-CODE-MIT.txt": "licenses/CODICONS-CODE-MIT.txt",
    "extension/licenses/CODICONS-CC-BY-4.0.txt": "licenses/CODICONS-CC-BY-4.0.txt",
}
GENERATED_MEMBERS = {
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/dist/build.json",
    "extension/dist/extension.js",
}
EXPECTED_MEMBERS = frozenset(STATIC_MEMBERS) | GENERATED_MEMBERS
TEXT_SUFFIXES = frozenset({".css", ".js", ".json", ".md", ".svg", ".txt", ".xml", ".vsixmanifest"})
SECRET_NAME = re.compile(r"(?:api[_-]?key|auth|password|passwd|pat|secret|token)", re.I)
SECRET_ASSIGNMENT = re.compile(
    r"(?i)(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pat|secret|token)"
    r"\s*[=:]\s*['\"]([^'\"\r\n]{8,})['\"]"
)
KNOWN_SECRET_PATTERNS = (
    ("private key", re.compile(rb"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")),
    ("GitHub token", re.compile(rb"(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}")),
    ("OpenAI-style key", re.compile(rb"sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}")),
    ("AWS access key", re.compile(rb"(?:AKIA|ASIA)[A-Z0-9]{16}")),
    ("Slack token", re.compile(rb"xox[baprs]-[A-Za-z0-9-]{20,}")),
)
PLACEHOLDER_WORDS = frozenset({
    "changeme", "example", "lm-studio", "missing", "placeholder", "redacted", "replace-me",
    "sk-local", "undefined",
})
REPOSITORY_URL = "https://github.com/OpenPeach-ai/dgc.git"
VSIX_NS = "http://schemas.microsoft.com/developer/vsx-schema/2011"
CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"


class ValidationError(ValueError):
    pass


def _read_json(raw: bytes, label: str) -> dict:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"{label}: invalid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"{label}: expected a JSON object")
    return value


def _sensitive_environment_values() -> list[bytes]:
    values: list[bytes] = []
    for key, value in os.environ.items():
        if not SECRET_NAME.search(key) or len(value) < 8:
            continue
        encoded = value.encode("utf-8", "ignore")
        if encoded and encoded not in values:
            values.append(encoded)
    return values


def _looks_like_placeholder(value: str) -> bool:
    normalized = value.strip().lower()
    return (
        normalized in PLACEHOLDER_WORDS
        or normalized.startswith(("${", "<", "your-", "example-"))
        or set(normalized) <= {"*", "x", "-", "_"}
    )


def _scan_credentials(member: str, raw: bytes, environment_values: list[bytes]) -> None:
    for value in environment_values:
        if value in raw:
            raise ValidationError(f"{member}: contains a credential supplied by the release environment")
    for label, pattern in KNOWN_SECRET_PATTERNS:
        if pattern.search(raw):
            raise ValidationError(f"{member}: contains a probable {label}")
    if Path(member).suffix.lower() not in TEXT_SUFFIXES:
        return
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError(f"{member}: expected UTF-8 text") from exc
    if re.search(r"(?:^|[/\\])\.env(?:$|[./\\])", text, re.I | re.M):
        raise ValidationError(f"{member}: contains a private environment-file path")
    if re.search(r"(?:/home/[^/\s]+|/Users/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)", text):
        raise ValidationError(f"{member}: contains a developer-machine path")
    for match in SECRET_ASSIGNMENT.finditer(text):
        if not _looks_like_placeholder(match.group(2)):
            raise ValidationError(f"{member}: contains a literal value for {match.group(1)}")


def _validate_package(package: dict, source_package: dict, version: str) -> None:
    if package != source_package:
        raise ValidationError("extension/package.json differs from the reviewed source package")
    required = {
        "name": "dgc",
        "publisher": "vibedgc",
        "version": version,
        "license": "PolyForm-Noncommercial-1.0.0",
        "main": "./dist/extension.js",
        "homepage": "https://vibedgc.com",
    }
    for key, expected in required.items():
        if package.get(key) != expected:
            raise ValidationError(f"extension/package.json: invalid {key}")
    if package.get("repository") != {
        "type": "git", "url": REPOSITORY_URL, "directory": "editors/vscode",
    }:
        raise ValidationError("extension/package.json: invalid source repository metadata")
    if package.get("bugs") != {"url": "https://github.com/OpenPeach-ai/dgc/issues"}:
        raise ValidationError("extension/package.json: invalid issue tracker metadata")
    if package.get("engines") != {"vscode": "^1.84.0"}:
        raise ValidationError("extension/package.json: unexpected VS Code engine range")
    if package.get("capabilities", {}).get("untrustedWorkspaces", {}).get("supported") is not False:
        raise ValidationError("extension/package.json: untrusted workspaces must remain disabled")
    if package.get("activationEvents") != ["onView:dgc.chat"]:
        raise ValidationError("extension/package.json: unexpected activation surface")


def _validate_manifest(raw: bytes, package: dict, version: str) -> None:
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ValidationError("extension.vsixmanifest: invalid XML") from exc
    if root.tag != f"{{{VSIX_NS}}}PackageManifest" or root.get("Version") != "2.0.0":
        raise ValidationError("extension.vsixmanifest: unexpected package schema")
    identity = root.find(f".//{{{VSIX_NS}}}Identity")
    if identity is None or identity.attrib != {
        "Language": "en-US", "Id": "dgc", "Version": version, "Publisher": "vibedgc",
    }:
        raise ValidationError("extension.vsixmanifest: identity disagrees with the release")
    display = root.find(f".//{{{VSIX_NS}}}DisplayName")
    description = root.find(f".//{{{VSIX_NS}}}Description")
    if display is None or display.text != package.get("displayName"):
        raise ValidationError("extension.vsixmanifest: display name disagrees with package.json")
    if description is None or description.text != package.get("description"):
        raise ValidationError("extension.vsixmanifest: description disagrees with package.json")
    properties = {
        node.get("Id"): node.get("Value")
        for node in root.findall(f".//{{{VSIX_NS}}}Property")
    }
    property_nodes = root.findall(f".//{{{VSIX_NS}}}Property")
    if len(properties) != len(property_nodes):
        raise ValidationError("extension.vsixmanifest: duplicate property declarations")
    required_properties = {
        "Microsoft.VisualStudio.Code.Engine": "^1.84.0",
        "Microsoft.VisualStudio.Code.ExtensionKind": "workspace",
        "Microsoft.VisualStudio.Code.ExecutesCode": "true",
        "Microsoft.VisualStudio.Services.Links.Source": REPOSITORY_URL,
        "Microsoft.VisualStudio.Services.Links.GitHub": REPOSITORY_URL,
        "Microsoft.VisualStudio.Services.Links.Support": "https://github.com/OpenPeach-ai/dgc/issues",
        "Microsoft.VisualStudio.Services.Links.Learn": "https://vibedgc.com",
    }
    for key, expected in required_properties.items():
        if properties.get(key) != expected:
            raise ValidationError(f"extension.vsixmanifest: invalid property {key}")
    assets = {
        node.get("Type"): node.get("Path")
        for node in root.findall(f".//{{{VSIX_NS}}}Asset")
    }
    asset_nodes = root.findall(f".//{{{VSIX_NS}}}Asset")
    if len(assets) != len(asset_nodes):
        raise ValidationError("extension.vsixmanifest: duplicate asset declarations")
    if assets != {
        "Microsoft.VisualStudio.Code.Manifest": "extension/package.json",
        "Microsoft.VisualStudio.Services.Content.Details": "extension/readme.md",
        "Microsoft.VisualStudio.Services.Content.Changelog": "extension/changelog.md",
        "Microsoft.VisualStudio.Services.Content.License": "extension/LICENSE.txt",
        "Microsoft.VisualStudio.Services.Icons.Default": "extension/icon.png",
    }:
        raise ValidationError("extension.vsixmanifest: unexpected asset declarations")


def _validate_content_types(raw: bytes) -> None:
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ValidationError("[Content_Types].xml: invalid XML") from exc
    default_nodes = root.findall(f"{{{CONTENT_NS}}}Default")
    actual = {
        node.get("Extension"): node.get("ContentType")
        for node in default_nodes
    }
    expected = {
        ".css": "text/css", ".js": "application/javascript", ".json": "application/json",
        ".md": "text/markdown", ".png": "image/png", ".svg": "image/svg+xml",
        ".ttf": "font/ttf", ".txt": "text/plain", ".vsixmanifest": "text/xml",
    }
    if (actual != expected or len(actual) != len(default_nodes)
            or root.findall(f"{{{CONTENT_NS}}}Override")):
        raise ValidationError("[Content_Types].xml: unexpected content-type declarations")


def validate_artifact(
    path: Path,
    *,
    extension_root: Path,
    version: str,
    source_commit: str,
    flavor: str,
) -> dict[str, bytes]:
    """Validate one VSIX and return its member bytes for pair comparison."""
    if flavor not in {"registry", "selfhost"}:
        raise ValidationError("artifact flavor must be registry or selfhost")
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValidationError("source commit must be a full lowercase Git object ID")
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValidationError("extension version must be a release semver")
    if not path.is_file():
        raise ValidationError(f"{path.name}: artifact is missing")
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValidationError(f"{path.name}: oversized compressed VSIX")

    environment_values = _sensitive_environment_values()
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValidationError(f"{path.name}: invalid VSIX ZIP") from exc
    with archive:
        infos = archive.infolist()
        names = [item.filename for item in infos]
        if len(names) != len(set(names)):
            raise ValidationError(f"{path.name}: duplicate ZIP members are forbidden")
        actual = set(names)
        if actual != EXPECTED_MEMBERS:
            added = sorted(actual - EXPECTED_MEMBERS)
            missing = sorted(EXPECTED_MEMBERS - actual)
            raise ValidationError(
                f"{path.name}: VSIX member allowlist mismatch (added={added}, missing={missing})"
            )
        total_size = 0
        members: dict[str, bytes] = {}
        for info in infos:
            mode = info.external_attr >> 16
            if not stat.S_ISREG(mode):
                raise ValidationError(f"{path.name}: non-regular member {info.filename}")
            if info.compress_type != zipfile.ZIP_DEFLATED:
                raise ValidationError(f"{path.name}: unexpected compression for {info.filename}")
            if info.flag_bits & 0x1:
                raise ValidationError(f"{path.name}: encrypted members are forbidden")
            if info.file_size > 4 * 1024 * 1024:
                raise ValidationError(f"{path.name}: oversized member {info.filename}")
            total_size += info.file_size
            raw = archive.read(info)
            members[info.filename] = raw
            _scan_credentials(info.filename, raw, environment_values)
        if total_size > 8 * 1024 * 1024:
            raise ValidationError(f"{path.name}: oversized uncompressed VSIX")

    for member, relative_source in STATIC_MEMBERS.items():
        source = extension_root / relative_source
        if source.is_symlink() or not source.is_file() or members[member] != source.read_bytes():
            raise ValidationError(f"{path.name}: {member} differs from reviewed source")
    package = _read_json(members["extension/package.json"], f"{path.name}: package.json")
    source_package = _read_json((extension_root / "package.json").read_bytes(), "source package.json")
    _validate_package(package, source_package, version)
    expected_build = {
        "flavor": flavor,
        "schema_version": 1,
        "source_commit": source_commit,
        "version": version,
    }
    if _read_json(members["extension/dist/build.json"], f"{path.name}: build.json") != expected_build:
        raise ValidationError(f"{path.name}: embedded build provenance disagrees")
    _validate_manifest(members["extension.vsixmanifest"], package, version)
    _validate_content_types(members["[Content_Types].xml"])
    return members


def validate_pair(
    registry: Path,
    selfhost: Path,
    *,
    extension_root: Path,
    version: str,
    source_commit: str,
) -> dict[str, str]:
    registry_members = validate_artifact(
        registry, extension_root=extension_root, version=version,
        source_commit=source_commit, flavor="registry",
    )
    selfhost_members = validate_artifact(
        selfhost, extension_root=extension_root, version=version,
        source_commit=source_commit, flavor="selfhost",
    )
    permitted_differences = {"extension/dist/build.json", "extension/dist/extension.js"}
    changed = {
        name for name in EXPECTED_MEMBERS
        if registry_members[name] != selfhost_members[name]
    }
    if changed != permitted_differences:
        raise ValidationError(
            "registry/selfhost packages must differ only in compiled code and build provenance "
            f"(changed={sorted(changed)})"
        )
    return {
        "registry_sha256": hashlib.sha256(registry.read_bytes()).hexdigest(),
        "selfhost_sha256": hashlib.sha256(selfhost.read_bytes()).hexdigest(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--selfhost", type=Path, required=True)
    parser.add_argument("--extension-root", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args(argv)
    try:
        result = validate_pair(
            args.registry,
            args.selfhost,
            extension_root=args.extension_root.resolve(),
            version=args.version,
            source_commit=args.source_commit,
        )
    except (OSError, ValidationError, zipfile.BadZipFile) as exc:
        print(f"extension VSIX validation failed: {exc}", file=sys.stderr)
        return 1
    print(
        "validated exact registry/selfhost VSIX members, source metadata, provenance, and credentials "
        f"({result['registry_sha256'][:12]} / {result['selfhost_sha256'][:12]})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
