#!/usr/bin/env python3
"""Validate one DGC runtime release bundle without extracting or executing it."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote

FILES = ("dgc.tar.gz", "dgc.tar.gz.sha256", "version.json", "provenance.json", "dgc.cdx.json")
SIDECAR_LIMITS = {
    "dgc.tar.gz.sha256": 256,
    "version.json": 16 * 1024,
    "provenance.json": 32 * 1024,
    "dgc.cdx.json": 2 * 1024 * 1024,
}
MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?\Z")
PYTHON_VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.]+)?\Z")
COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
LOCK_ENTRY_RE = re.compile(
    r"([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)=="
    r"([A-Za-z0-9](?:[A-Za-z0-9.!+_-]*[A-Za-z0-9])?)\Z"
)
SECRET_RE = re.compile(
    rb"(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{24,}|github_pat_[A-Za-z0-9_]{20,}"
    rb"|gh[pousr]_[A-Za-z0-9]{30,}|re_[A-Za-z0-9_-]{24,}"
    rb"|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)
SENSITIVE_JSON_FIELD_RE = re.compile(
    rb'"(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|private[_-]?key|secret|token)"\s*:',
    re.IGNORECASE,
)
DISALLOWED_TOP_LEVEL = {"docs", "scripts", "tests", "bench", "site", ".git", ".github", "AGENTS.md"}
RUNTIME_PATHS = ("LICENSE", "README.md", "pyproject.toml", "requirements.lock", "dgc")


class _InvalidJSON(ValueError):
    pass


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict:
    value: dict = {}
    for key, item in pairs:
        if key in value:
            raise _InvalidJSON(f"duplicate object key {key!r}")
        value[key] = item
    return value


def _invalid_json_constant(value: str) -> None:
    raise _InvalidJSON(f"non-standard numeric constant {value}")


def _read_sidecar(path: Path, errors: list[str]) -> bytes | None:
    """Read and credential-scan one known release sidecar within its fixed bound."""
    limit = SIDECAR_LIMITS[path.name]
    try:
        with path.open("rb") as stream:
            raw = stream.read(limit + 1)
    except OSError as exc:
        errors.append(f"{path.name}: could not read sidecar ({exc})")
        return None
    if len(raw) > limit:
        errors.append(f"{path.name}: exceeds the {limit}-byte sidecar bound")
        return None
    if SECRET_RE.search(raw) or SENSITIVE_JSON_FIELD_RE.search(raw):
        errors.append(f"{path.name}: credential marker detected")
    return raw


def _load_object(path: Path, raw: bytes | None, errors: list[str]) -> dict:
    if raw is None:
        return {}
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_unique_json_object,
            parse_constant=_invalid_json_constant,
        )
    except (UnicodeError, json.JSONDecodeError, _InvalidJSON) as exc:
        errors.append(f"{path.name}: invalid JSON ({exc})")
        return {}
    if not isinstance(value, dict):
        errors.append(f"{path.name}: expected a JSON object")
        return {}
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(root: Path, *args: str, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=root, input=input_bytes, capture_output=True, check=False,
    )


def _locked_python_components(lock_bytes: bytes, errors: list[str]) -> list[dict] | None:
    """Parse the exact runtime lock embedded in the archive into SBOM identities."""
    try:
        text = lock_bytes.decode("utf-8")
    except UnicodeDecodeError:
        errors.append("dgc.tar.gz: requirements.lock is not UTF-8")
        return None
    components: list[dict] = []
    seen: set[str] = set()
    for line_number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = LOCK_ENTRY_RE.fullmatch(line)
        if not match:
            errors.append(
                f"dgc.tar.gz: requirements.lock line {line_number} is not an exact package pin"
            )
            return None
        name, version = match.groups()
        normalized = re.sub(r"[-_.]+", "-", name).lower()
        if normalized in seen:
            errors.append(
                f"dgc.tar.gz: requirements.lock contains duplicate package {normalized!r}"
            )
            return None
        seen.add(normalized)
        purl = f"pkg:pypi/{quote(normalized, safe='')}@{quote(version, safe='')}"
        components.append({
            "type": "library",
            "name": name,
            "version": version,
            "purl": purl,
            "bom-ref": purl,
            "scope": "required",
        })
    if not components:
        errors.append("dgc.tar.gz: requirements.lock has no runtime package pins")
        return None
    return sorted(components, key=lambda item: item["bom-ref"])


def _validate_runtime_sbom(
    sbom: dict,
    release_version: object,
    lock_bytes: bytes | None,
    errors: list[str],
) -> None:
    """Require the core SBOM to describe exactly the archive's Python runtime closure."""
    root_ref = (
        f"pkg:pypi/dgc@{quote(release_version, safe='')}"
        if isinstance(release_version, str) and VERSION_RE.fullmatch(release_version)
        else None
    )
    expected_top_level = {"bomFormat", "specVersion", "version", "metadata", "components"}
    if set(sbom) != expected_top_level:
        errors.append("dgc.cdx.json: top-level fields do not match the deterministic runtime SBOM")
    metadata = sbom.get("metadata")
    components = sbom.get("components")
    if (sbom.get("bomFormat") != "CycloneDX" or sbom.get("specVersion") != "1.5"
            or type(sbom.get("version")) is not int or sbom.get("version") != 1
            or not isinstance(components, list)):
        errors.append("dgc.cdx.json: invalid CycloneDX 1.5 document")
        components = []
    if root_ref is not None:
        expected_metadata = {
            "component": {
                "type": "application",
                "name": "dgc",
                "version": release_version,
                "purl": root_ref,
                "bom-ref": root_ref,
            },
            "properties": [{
                "name": "dgc:source",
                "value": "https://github.com/OpenPeach-ai/dgc",
            }],
        }
        if metadata != expected_metadata:
            errors.append("dgc.cdx.json: metadata/root component does not match the runtime release")

    if lock_bytes is None:
        errors.append("dgc.cdx.json: cannot bind components without the archived requirements.lock")
        return
    expected = _locked_python_components(lock_bytes, errors)
    if expected is None:
        return

    actual_by_purl: dict[str, dict] = {}
    seen_refs: set[str] = set()
    malformed = False
    maximum_components = max(256, len(expected) * 4)
    if len(components) > maximum_components:
        errors.append("dgc.cdx.json: component count exceeds the runtime SBOM bound")
        components = components[:maximum_components]
        malformed = True
    if len(components) != len(expected):
        errors.append("dgc.cdx.json: component count does not match requirements.lock")
    duplicate_purl_reported = False
    duplicate_ref_reported = False
    non_python_reported = False
    for index, item in enumerate(components):
        if not isinstance(item, dict):
            errors.append(f"dgc.cdx.json: component {index} is not an object")
            malformed = True
            continue
        if set(item) != {"type", "name", "version", "purl", "bom-ref", "scope"}:
            errors.append(f"dgc.cdx.json: component {index} has unexpected fields")
            malformed = True
        purl, bom_ref = item.get("purl"), item.get("bom-ref")
        if not isinstance(purl, str) or not isinstance(bom_ref, str):
            errors.append(f"dgc.cdx.json: component {index} has no valid purl/bom-ref")
            malformed = True
            continue
        if purl in actual_by_purl:
            if not duplicate_purl_reported:
                errors.append(f"dgc.cdx.json: duplicate component purl {purl!r}")
                duplicate_purl_reported = True
            malformed = True
        else:
            actual_by_purl[purl] = item
        if bom_ref in seen_refs:
            if not duplicate_ref_reported:
                errors.append(f"dgc.cdx.json: duplicate component bom-ref {bom_ref!r}")
                duplicate_ref_reported = True
            malformed = True
        seen_refs.add(bom_ref)
        if not purl.startswith("pkg:pypi/"):
            if not non_python_reported:
                errors.append("dgc.cdx.json: core runtime SBOM contains a non-Python component")
                non_python_reported = True
            malformed = True

    expected_by_purl = {item["purl"]: item for item in expected}
    if not malformed:
        missing = sorted(set(expected_by_purl) - set(actual_by_purl))
        extra = sorted(set(actual_by_purl) - set(expected_by_purl))
        if missing:
            errors.append("dgc.cdx.json: missing runtime component(s): " + ", ".join(missing))
        if extra:
            errors.append("dgc.cdx.json: contains component(s) outside requirements.lock: "
                          + ", ".join(extra))
        for purl in sorted(set(expected_by_purl) & set(actual_by_purl)):
            expected_component = expected_by_purl[purl]
            actual_component = actual_by_purl[purl]
            if actual_component != expected_component:
                errors.append(f"dgc.cdx.json: runtime component metadata does not match {purl}")

    # A requirements.txt-style lock records the installed closure, not the direct edges
    # between packages.  Omitting the optional CycloneDX graph represents those relationships
    # as unknown; inventing root -> every locked package would mislabel transitives as direct.
    if "dependencies" in sbom:
        errors.append("dgc.cdx.json: must omit a dependency graph not proven by requirements.lock")


def _validate_git_binding(
    root: Path,
    archive: Path,
    version: dict,
    errors: list[str],
    *,
    require_public: bool,
    require_source_tag: bool,
) -> None:
    """Bind a bundle to one source commit and, when requested, its tag/public main."""
    commit = version.get("commit")
    release_version = version.get("version")
    if (not isinstance(commit, str) or not COMMIT_RE.fullmatch(commit)
            or not isinstance(release_version, str) or not VERSION_RE.fullmatch(release_version)):
        return  # Base validation already reports the malformed identity.
    if _git(root, "cat-file", "-e", f"{commit}^{{commit}}").returncode:
        errors.append("Git binding: claimed source commit does not exist locally")
        return
    if require_source_tag:
        tag = f"v{release_version}"
        tag_commit = _git(root, "rev-parse", f"refs/tags/{tag}^{{commit}}")
        if tag_commit.returncode or tag_commit.stdout.decode("ascii", "replace").strip() != commit:
            errors.append(f"Git binding: tag {tag} does not resolve to the claimed source commit")
    if require_public:
        if _git(root, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}").returncode:
            errors.append("Git binding: origin/main is unavailable; fetch the public remote first")
        elif _git(root, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main").returncode:
            errors.append("Git binding: claimed source commit is not reachable from origin/main")
    init = _git(root, "show", f"{commit}:dgc/__init__.py")
    match = re.search(rb'^__version__\s*=\s*["\']([^"\']+)["\']\s*$',
                      init.stdout, re.MULTILINE) if not init.returncode else None
    if not match or match.group(1).decode("ascii", "replace") != release_version:
        errors.append("Git binding: source version does not match version.json")
    epoch = _git(root, "show", "-s", "--format=%ct", commit)
    try:
        source_epoch = int(epoch.stdout.strip()) if not epoch.returncode else 0
    except ValueError:
        source_epoch = 0
    if not source_epoch or version.get("source_date_epoch") != source_epoch:
        errors.append("Git binding: source_date_epoch does not match the source commit")

    archived = _git(
        root, "archive", "--format=tar", "--prefix=dgc/", commit, "--", *RUNTIME_PATHS,
    )
    if archived.returncode:
        errors.append("Git binding: could not rebuild the source archive")
        return
    if len(archived.stdout) > MAX_ARCHIVE_BYTES:
        errors.append("Git binding: rebuilt source archive exceeded the validation bound")
        return
    compressed = subprocess.run(
        ["gzip", "-n", "-9"], input=archived.stdout, capture_output=True, check=False,
    )
    if compressed.returncode:
        errors.append("Git binding: gzip could not reproduce the source archive")
    elif hashlib.sha256(compressed.stdout).hexdigest() != _sha256_file(archive):
        errors.append("Git binding: archive bytes are not the deterministic projection of the source commit")


def validate_bundle(
    directory: Path,
    *,
    source_root: Path | None = None,
    require_git_binding: bool = False,
    require_public: bool = False,
    require_source_tag: bool = True,
) -> list[str]:
    root = Path(directory)
    errors: list[str] = []
    if require_public and not require_git_binding:
        errors.append("Git binding: public reachability requires source binding")
    if require_public and not require_source_tag:
        errors.append("Git binding: public release validation requires the source tag")
    missing = [
        name for name in FILES
        if not (root / name).is_file() or (root / name).is_symlink()
        or not (root / name).stat().st_size
    ]
    if missing:
        return [f"release bundle is missing non-empty files: {', '.join(missing)}"]

    archive = root / "dgc.tar.gz"
    archive_size = archive.stat().st_size
    archive_usable = archive_size <= MAX_ARCHIVE_BYTES
    if not archive_usable:
        errors.append(f"dgc.tar.gz: exceeds the {MAX_ARCHIVE_BYTES}-byte archive bound")
    sidecars = {
        name: _read_sidecar(root / name, errors)
        for name in SIDECAR_LIMITS
    }
    actual_sha = ""
    if archive_usable:
        try:
            actual_sha = _sha256_file(archive)
        except OSError as exc:
            errors.append(f"dgc.tar.gz: could not read archive ({exc})")
            archive_usable = False
    try:
        checksum_text = (sidecars["dgc.tar.gz.sha256"] or b"").decode("ascii")
    except UnicodeDecodeError:
        checksum_text = ""
        errors.append("dgc.tar.gz.sha256: checksum is not ASCII")
    checksum_match = re.fullmatch(r"([0-9a-f]{64})  dgc\.tar\.gz\n?", checksum_text)
    if not checksum_match:
        errors.append("dgc.tar.gz.sha256: expected '<sha256>  dgc.tar.gz'")
    elif checksum_match.group(1) != actual_sha:
        errors.append("dgc.tar.gz.sha256: archive checksum mismatch")

    version = _load_object(root / "version.json", sidecars["version.json"], errors)
    release_version = version.get("version")
    release_commit = version.get("commit")
    if set(version) != {
        "schema_version", "version", "commit", "source_date_epoch", "sha256",
        "artifact", "sbom", "provenance", "install",
    }:
        errors.append("version.json: fields do not match the deterministic release manifest")
    if type(version.get("schema_version")) is not int or version.get("schema_version") != 1:
        errors.append("version.json: unsupported schema_version")
    if not isinstance(release_version, str) or not VERSION_RE.fullmatch(release_version):
        errors.append("version.json: invalid version")
    if not isinstance(release_commit, str) or not COMMIT_RE.fullmatch(release_commit):
        errors.append("version.json: invalid source commit")
    expected_manifest = {
        "schema_version": 1,
        "artifact": "dgc.tar.gz",
        "sbom": "dgc.cdx.json",
        "provenance": "provenance.json",
        "sha256": actual_sha,
        "install": "https://vibedgc.com/install.sh",
    }
    for key, expected in expected_manifest.items():
        if version.get(key) != expected:
            errors.append(f"version.json: {key} does not match the release bundle")
    epoch = version.get("source_date_epoch")
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch <= 0:
        errors.append("version.json: source_date_epoch must be a positive integer")

    provenance = _load_object(
        root / "provenance.json", sidecars["provenance.json"], errors,
    )
    subject = provenance.get("subject") if isinstance(provenance.get("subject"), dict) else {}
    source = provenance.get("source") if isinstance(provenance.get("source"), dict) else {}
    build = provenance.get("build") if isinstance(provenance.get("build"), dict) else {}
    if set(provenance) != {"schema_version", "subject", "source", "build"}:
        errors.append("provenance.json: fields do not match the deterministic provenance")
    if type(provenance.get("schema_version")) is not int or provenance.get("schema_version") != 1:
        errors.append("provenance.json: unsupported schema_version")
    if subject != {"name": "dgc.tar.gz", "sha256": actual_sha, "bytes": archive_size}:
        errors.append("provenance.json: subject does not match dgc.tar.gz")
    if source != {
        "repository": "https://github.com/OpenPeach-ai/dgc",
        "commit": release_commit,
    }:
        errors.append("provenance.json: source does not match version.json")
    if (set(build) != {"source_date_epoch", "python"}
            or type(build.get("source_date_epoch")) is not int
            or build.get("source_date_epoch") != epoch
            or not isinstance(build.get("python"), str)
            or not PYTHON_VERSION_RE.fullmatch(build["python"])):
        errors.append("provenance.json: build metadata does not match the release")

    sbom = _load_object(root / "dgc.cdx.json", sidecars["dgc.cdx.json"], errors)

    requirements_bytes = None
    if archive_usable:
        try:
            with tarfile.open(archive, "r:gz") as bundle:
                seen: set[str] = set()
                init_bytes = None
                total_bytes = 0
                member_count = 0
                for member in bundle:
                    member_count += 1
                    if member_count > 1024:
                        errors.append("dgc.tar.gz: member count exceeds 1024")
                        break
                    path = PurePosixPath(member.name)
                    if (member.name in seen or path.is_absolute() or ".." in path.parts
                            or not path.parts or path.parts[0] != "dgc"):
                        errors.append(f"dgc.tar.gz: unsafe or duplicate member {member.name!r}")
                        continue
                    seen.add(member.name)
                    if not (member.isfile() or member.isdir()):
                        errors.append(f"dgc.tar.gz: non-regular member {member.name!r}")
                        continue
                    if len(path.parts) > 1 and path.parts[1] in DISALLOWED_TOP_LEVEL:
                        errors.append(f"dgc.tar.gz: non-runtime member {member.name!r}")
                    if not member.isfile():
                        continue
                    total_bytes += member.size
                    if total_bytes > 64 * 1024 * 1024:
                        errors.append("dgc.tar.gz: expanded payload exceeds 64 MiB")
                        break
                    stream = bundle.extractfile(member)
                    data = stream.read() if stream is not None else b""
                    if len(data) != member.size:
                        errors.append(f"dgc.tar.gz: truncated member {member.name!r}")
                    if SECRET_RE.search(data):
                        errors.append(f"dgc.tar.gz: credential marker in {member.name!r}")
                    if member.name == "dgc/dgc/__init__.py":
                        init_bytes = data
                    elif member.name == "dgc/requirements.lock":
                        requirements_bytes = data
                if member_count == 0:
                    errors.append("dgc.tar.gz: archive has no members")
                if init_bytes is None:
                    errors.append("dgc.tar.gz: missing dgc/dgc/__init__.py")
                else:
                    match = re.search(rb'^__version__\s*=\s*["\']([^"\']+)["\']\s*$',
                                      init_bytes, re.MULTILINE)
                    embedded = match.group(1).decode("ascii", errors="replace") if match else ""
                    if embedded != release_version:
                        errors.append("dgc.tar.gz: embedded version does not match version.json")
                if requirements_bytes is None:
                    errors.append("dgc.tar.gz: missing dgc/requirements.lock")
        except (OSError, tarfile.TarError, EOFError) as exc:
            errors.append(f"dgc.tar.gz: invalid archive ({exc})")
    _validate_runtime_sbom(sbom, release_version, requirements_bytes, errors)
    if require_git_binding:
        if source_root is None:
            errors.append("Git binding: source root was not supplied")
        elif archive_usable:
            _validate_git_binding(
                Path(source_root), archive, version, errors, require_public=require_public,
                require_source_tag=require_source_tag,
            )
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle_directory", type=Path)
    parser.add_argument("--bind-git", type=Path, metavar="SOURCE_ROOT",
                        help="require exact local tag and source-byte binding")
    parser.add_argument(
        "--require-public", action="store_true",
        help="also require the bound source commit to be reachable from origin/main",
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.require_public and args.bind_git is None:
        parser.error("--require-public requires --bind-git")
    errors = validate_bundle(
        args.bundle_directory,
        source_root=args.bind_git,
        require_git_binding=args.bind_git is not None,
        require_public=args.require_public,
    )
    if errors:
        print("release bundle gate failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print(f"release bundle verified: {args.bundle_directory.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
