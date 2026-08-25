"""Canonical workspace-boundary helpers.

Tool arguments are untrusted model output.  Every filesystem consumer resolves through this
module so absolute paths, ``..`` segments, and symlinks cannot silently escape the project.
External access is possible only when the permission layer has explicitly approved it.
"""
from __future__ import annotations

import os
from pathlib import Path


class WorkspaceBoundaryError(ValueError):
    """A requested path is outside the active project boundary."""


def canonical_root(root: Path | str) -> Path:
    return Path(root).expanduser().resolve(strict=False)


def canonical_path(path: Path | str, root: Path | str) -> Path:
    """Resolve a model-supplied path, including existing symlink components."""
    raw = str(path)
    if not raw or "\x00" in raw:
        raise WorkspaceBoundaryError("a non-empty path inside the project is required")
    base = canonical_root(root)
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.resolve(strict=False)


def is_within(path: Path | str, root: Path | str) -> bool:
    """True when ``path`` is the root or one of its descendants."""
    target = Path(path).resolve(strict=False)
    base = canonical_root(root)
    try:
        return os.path.commonpath((str(base), str(target))) == str(base)
    except ValueError:  # different Windows drives, or otherwise incomparable paths
        return False


def resolve_path(path: Path | str, root: Path | str, *, allow_external: bool = False) -> Path:
    target = canonical_path(path, root)
    if not allow_external and not is_within(target, root):
        raise WorkspaceBoundaryError(
            f"path is outside the project: {target} (project root: {canonical_root(root)})"
        )
    return target


def relative_rule_value(path: Path | str, root: Path | str) -> str:
    """Stable permission-rule value: project-relative inside, canonical absolute outside."""
    target = canonical_path(path, root)
    base = canonical_root(root)
    if is_within(target, base):
        rel = target.relative_to(base)
        return rel.as_posix() or "."
    return str(target)
