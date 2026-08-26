"""Memory — DGC.md files (a project memory file).

Two scopes:
  project:  <project-root>/DGC.md   — project conventions, loaded every session
  user:     ~/.dgc/DGC.md         — personal preferences across all projects

Quick-add:  user types `#some fact` in the REPL, or the model calls save_memory.
"""
from __future__ import annotations

from pathlib import Path

from .config import USER_MEMORY
from .redaction import REDACTED
from .workspace import (WorkspaceBoundaryError, atomic_write_bytes, canonical_root,
                        read_regular_bytes)

MAX_MEMORY_ENTRY_CHARS = 4_000
MAX_MEMORY_FILE_BYTES = 1_048_576
MAX_MEMORY_PROMPT_CHARS = 32_768
_MEMORY_WRITE_RETRIES = 16

TEMPLATE = """# DGC.md

Project guidance for the dgc coding agent. Loaded into the system prompt every session.

## Project
- (what this project is, stack, layout)

## Conventions
- (coding style, commands to build/test/lint)

## Memory
- (facts the agent should remember — appended by `#...` or save_memory)
"""


def project_memory_path(project_root: Path) -> Path:
    return canonical_root(project_root) / "DGC.md"


def user_memory_path() -> Path:
    """Freeze the trusted config directory while leaving the final memory entry un-followed."""
    raw = Path(USER_MEMORY).expanduser()
    parent = raw.parent.resolve(strict=False)
    return parent / raw.name


def bounded_memory_view(text: str, maximum: int = MAX_MEMORY_PROMPT_CHARS) -> str:
    """Return a useful bounded head/newest-tail view for a prompt or terminal surface."""
    maximum = max(256, min(MAX_MEMORY_PROMPT_CHARS, int(maximum)))
    text = str(text or "").strip()
    if len(text) <= maximum:
        return text

    def safe_prefix(limit: int) -> str:
        cut = max(0, min(len(text), limit))
        start = text.rfind(REDACTED, max(0, cut - len(REDACTED) + 1),
                           min(len(text), cut + len(REDACTED)))
        if start >= 0 and start < cut < start + len(REDACTED):
            cut = start + len(REDACTED)  # retain the complete sentinel; tail pays the difference.
        return text[:cut]

    def safe_suffix(limit: int) -> str:
        if limit <= 0:
            return ""
        start = max(0, len(text) - limit)
        marker_start = text.rfind(
            REDACTED, max(0, start - len(REDACTED) + 1),
            min(len(text), start + len(REDACTED)))
        if marker_start >= 0 and marker_start < start < marker_start + len(REDACTED):
            start = marker_start + len(REDACTED)  # omit it whole rather than disclose a fragment.
        return text[start:]

    marker = ""
    head = tail = ""
    for _ in range(6):
        kept = max(0, maximum - len(marker))
        head = safe_prefix(kept // 3)
        tail = safe_suffix(max(0, kept - len(head)))
        omitted = max(0, len(text) - len(head) - len(tail))
        updated = f"\n… [{omitted} memory characters omitted from this bounded view] …\n"
        if updated == marker:
            break
        marker = updated
    # Marker digit growth can change the budget by one; enforce the hard ceiling without ever
    # slicing a redaction sentinel.
    kept = max(0, maximum - len(marker))
    head = safe_prefix(kept // 3)
    tail = safe_suffix(max(0, kept - len(head)))
    return head + marker + tail


def load_instruction_file(path: Path, *, sanitizer=None) -> str:
    """Read one internal instruction file exactly, with hard file/prompt ceilings."""
    try:
        result = read_regular_bytes(
            Path(path), maximum=MAX_MEMORY_FILE_BYTES, missing_ok=True)
    except (OSError, ValueError, WorkspaceBoundaryError):
        return ""
    if result is None:
        return ""
    text = result[0].decode("utf-8", errors="replace")
    if callable(sanitizer):
        try:
            text = str(sanitizer(text))
        except Exception:
            return ""  # A failed disclosure-boundary sanitizer must never fall back to raw text.
    return bounded_memory_view(text)


def load_memories(project_root: Path, *, sanitizer=None) -> tuple[str, str]:
    """Return (project_memory, user_memory) contents ('' when missing)."""
    return (load_instruction_file(project_memory_path(project_root), sanitizer=sanitizer),
            load_instruction_file(user_memory_path(), sanitizer=sanitizer))


def _memory_entry(text: str) -> str:
    value = str(text or "").strip()
    if not value:
        raise ValueError("memory text is empty")
    if "\x00" in value:
        raise ValueError("memory text contains a NUL byte")
    if len(value) > MAX_MEMORY_ENTRY_CHARS:
        raise ValueError(f"memory text exceeds {MAX_MEMORY_ENTRY_CHARS} characters")
    # Keep a multi-line fact inside one Markdown list item instead of allowing a continuation line
    # to become an accidental new heading/list entry.
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    return "- " + value.replace("\n", "\n  ") + "\n"


def _append_memory_content(current: bytes, entry: str) -> bytes:
    if current:
        content = current.decode("utf-8", errors="replace")
    else:
        content = "# DGC.md\n\n## Memory\n"
    if "## Memory" in content:
        updated = content.rstrip("\n") + "\n" + entry
    else:
        updated = content.rstrip("\n") + "\n\n## Memory\n" + entry
    payload = updated.encode("utf-8")
    if len(payload) > MAX_MEMORY_FILE_BYTES:
        raise ValueError(f"memory file would exceed {MAX_MEMORY_FILE_BYTES} bytes")
    return payload


def add_memory(text: str, project_root: Path, scope: str = "project", *, cancelled=None) -> Path:
    """Atomically append one bounded fact without following mutable links or losing concurrent facts."""
    scope = str(scope or "project").strip().lower()
    if scope not in ("project", "user"):
        raise ValueError("memory scope must be 'project' or 'user'")
    path = project_memory_path(project_root) if scope == "project" else user_memory_path()
    if not path.is_absolute():
        raise WorkspaceBoundaryError("memory path must be canonical and absolute")
    entry = _memory_entry(text)
    from .scheduler import acquire_cancellable, named_process_lock
    lease = named_process_lock("memory", str(path))
    if not acquire_cancellable(lease, cancelled):
        raise RuntimeError(lease.last_error or "memory save cancelled while waiting for its write lease")
    try:
        for _ in range(_MEMORY_WRITE_RETRIES):
            result = read_regular_bytes(path, maximum=MAX_MEMORY_FILE_BYTES, missing_ok=True)
            current, expected = result if result is not None else (b"", None)
            payload = _append_memory_content(current, entry)
            try:
                atomic_write_bytes(path, payload, expected=expected,
                                   mode=0o600 if scope == "user" else None)
                return path
            except WorkspaceBoundaryError:
                # A regular file may have changed between the exact read and atomic commit. Re-read
                # under the memory lease so a non-DGC writer is merged rather than overwritten; an
                # unsafe link/type is rejected by the next exact read.
                continue
        raise RuntimeError("memory changed repeatedly before the fact could be saved")
    finally:
        lease.release()


def init_project_memory(project_root: Path) -> Path:
    path = project_memory_path(project_root)
    from .scheduler import named_process_lock
    lease = named_process_lock("memory", str(path))
    if not lease.acquire(timeout=5):
        raise RuntimeError(lease.last_error or "memory initialization timed out waiting for its lease")
    try:
        current = read_regular_bytes(path, maximum=MAX_MEMORY_FILE_BYTES, missing_ok=True)
        if current is not None:
            return path
        try:
            atomic_write_bytes(path, TEMPLATE.encode("utf-8"), expected=None)
        except WorkspaceBoundaryError:
            # A concurrent creator won. It must still be an exact bounded regular file.
            read_regular_bytes(path, maximum=MAX_MEMORY_FILE_BYTES)
        return path
    finally:
        lease.release()
