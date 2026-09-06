"""Bounded local skill packages, shared by terminal and editor management commands."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from .config import USER_SKILLS
from .skills import normalize_skill_name, parse_skill_text
from .workspace import create_file_tree, read_regular_bytes, resolve_path, scan_directory_entries

MAX_PACKAGE_FILES = 128
MAX_PACKAGE_BYTES = 4 * 1024 * 1024
MAX_RESOURCE_BYTES = 512 * 1024
MAX_PACKAGE_DEPTH = 8


def _destination(config, name: str, scope: str) -> Path:
    if not name or name != normalize_skill_name(name):
        raise ValueError("Skill names use 1–64 lowercase letters, digits, hyphens, underscores or dots.")
    if scope not in ("project", "user"):
        raise ValueError("Skill scope must be project or user.")
    base = config.project_root / ".dgc/skills" if scope == "project" else USER_SKILLS
    resolve_path(base / name, config.project_root, allow_external=scope == "user")
    return Path(os.path.abspath(base / name))


def _save(config, name: str, files: dict[str, bytes], scope: str) -> dict:
    target = _destination(config, name, scope)
    try:
        create_file_tree(target, files, marker="SKILL.md")
    except FileExistsError:
        raise ValueError(f"Skill directory '{name}' already exists. Choose a new name; existing files are never overwritten.") from None
    return {"name": name, "path": str(target / "SKILL.md"), "files": len(files),
            "bytes": sum(len(payload) for payload in files.values()), "scope": scope}


def create_skill(config, name: str, description: str = "", scope: str = "project") -> dict:
    description = " ".join(str(description).split())[:320] or "Describe when this workflow should be used."
    files = {"SKILL.md": (f"---\nname: {name}\ndescription: {json.dumps(description)}\n---\n\n"
        "# Instructions\n\nReplace this scaffold with a focused workflow before using it.\n"
        "- Describe the expected inputs, steps, and deliverable.\n"
        "- Follow the user's request and project conventions.\n"
        "- Read supporting files relative to this directory only as needed.\n"
        "- State tool requirements and how to validate the result.\n").encode(),
        "agents/openai.yaml": b"policy:\n  allow_implicit_invocation: false\n",
        "references/README.md": b"Put reference material here. Link only needed files from SKILL.md.\n"}
    return _save(config, name, files, scope)


def install_skill(config, source: str, scope: str = "project", *, allow_external: bool = False) -> dict:
    """Copy a selected local package without executing scripts or following links.

    External sources require an explicit host file selection or CLI --allow-external flag. The
    model-facing installer is separate and cannot opt itself into arbitrary local filesystem access.
    """
    resolve_path(source, config.project_root, allow_external=allow_external)
    source_path = Path(source).expanduser()
    if not source_path.is_absolute():
        source_path = config.project_root / source_path
    source_path = Path(os.path.abspath(source_path))
    files, total, entries = {}, 0, 0

    def walk(directory: Path, prefix: str = "", depth: int = 0):
        nonlocal total, entries
        if depth > MAX_PACKAGE_DEPTH:
            raise ValueError("Skill package exceeds the directory depth limit.")
        rows, truncated, scanned = scan_directory_entries(directory, maximum=MAX_PACKAGE_FILES + 1)
        entries += scanned
        if truncated or entries > MAX_PACKAGE_FILES:
            raise ValueError("Skill package exceeds 128 files/directories.")
        for name, info in rows:
            relative = prefix + name
            if name in (".git", ".env", ".DS_Store", "node_modules", "__pycache__") or name.startswith(".env."):
                raise ValueError(f"Remove private/generated resource '{relative}' before installing this package.")
            if stat.S_ISDIR(info.st_mode):
                walk(directory / name, relative + "/", depth + 1)
            elif stat.S_ISREG(info.st_mode):
                captured = read_regular_bytes(directory / name, maximum=MAX_RESOURCE_BYTES)
                payload = captured[0]
                total += len(payload)
                if total > MAX_PACKAGE_BYTES:
                    raise ValueError("Skill package exceeds the 4 MiB total limit.")
                files[relative] = payload
            else:
                raise ValueError(f"Skill packages cannot contain links or special files: {relative}")

    walk(source_path)
    try:
        text = files.get("SKILL.md", b"").decode("utf-8")
    except UnicodeError:
        raise ValueError("SKILL.md must be UTF-8 text.") from None
    skill = parse_skill_text(text, source_path / "SKILL.md")
    if skill is None:
        raise ValueError("Select a directory containing a valid, bounded SKILL.md.")
    return _save(config, skill.name, files, scope)
