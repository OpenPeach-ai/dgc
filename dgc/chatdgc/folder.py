"""A folder a chat may read: one the user picked, read-only. The chat can list it, read a file in it and search it;
it never writes there, and never reads outside it: a path is resolved (symlinks too) and must stay under the folder,
and a private path (a dot segment such as .git or .env, a key, a credential or secret store; dgc.artifacts'
rule) is never listed or read. "Continue in Work" (engine.work_brief) carries the chat into a coding session there,
under Work's own permissions.
"""
from __future__ import annotations

import fnmatch
import heapq
import os
from pathlib import Path

from .. import artifacts
from ..workspace import WorkspaceBoundaryError, read_regular_bytes

MAX_CALLS = 20               # folder calls in one reply
MAX_LIST = 300               # entries in one listing
MAX_READ_CHARS = 60_000      # characters of one read
MAX_READ_BYTES = 8 * 1024 * 1024
MAX_MATCHES = 80
MAX_SEARCH_FILES = 4000
MAX_SEARCH_BYTES = 2 * 1024 * 1024    # a file bigger than this isn't searched
SKIP_DIRS = frozenset({"node_modules", "__pycache__", "dist", "build", "target", "venv", "env", ".venv"})
DOCUMENTS = (".pdf", ".docx", ".xlsx", ".pptx")

FOLDER_LIST_TOOL = {"type": "function", "function": {
    "name": "folder_list",
    "description": ("List what's in the folder the user gave this chat (read-only), or in a folder inside it. Folders "
                    "end with /, files show their size. Start here to find your way around."),
    "parameters": {"type": "object", "properties": {
        "path": {"type": "string", "description": "A folder inside it, relative to it; leave out for the top."}}}}}
FOLDER_READ_TOOL = {"type": "function", "function": {
    "name": "folder_read",
    "description": ("Read a file in the user's folder: text and code as they are, with line numbers; a PDF, Word, Excel "
                    "or PowerPoint file as its text. Long files come in parts: ask for the next with start_line."),
    "parameters": {"type": "object", "properties": {
        "path": {"type": "string", "description": "The file, relative to the folder."},
        "start_line": {"type": "integer", "description": "The first line to read (1 by default)."}},
        "required": ["path"]}}}
FOLDER_SEARCH_TOOL = {"type": "function", "function": {
    "name": "folder_search",
    "description": ("Find text in the user's folder: every line that holds it (not case-sensitive), as path:line: text. "
                    "Use it to find where something is defined or mentioned before reading the file."),
    "parameters": {"type": "object", "properties": {
        "text": {"type": "string", "description": "What to find."},
        "files": {"type": "string", "description": "Only files matching this pattern, such as *.py or src/*.ts."}},
        "required": ["text"]}}}
TOOLS = (FOLDER_LIST_TOOL, FOLDER_READ_TOOL, FOLDER_SEARCH_TOOL)
NAMES = frozenset(t["function"]["name"] for t in TOOLS)


class FolderError(ValueError):
    """What the model is told when a call can't be done."""


def usable(path: str) -> Path:
    """The folder a chat may read, resolved; why not, when it can't be one."""
    raw = str(path or "").strip()
    if not raw:
        raise FolderError("Choose a folder.")
    p = Path(os.path.expanduser(raw))
    if not p.is_absolute():
        raise FolderError("Choose the folder by its full path.")
    try:
        p = p.resolve(strict=True)
    except (OSError, RuntimeError):
        raise FolderError(f"{raw} isn't there.") from None
    if not p.is_dir():
        raise FolderError(f"{p} isn't a folder.")
    if p == Path(p.anchor) or p == Path.home().resolve():
        raise FolderError("Choose a project's folder, not the whole disk or your home folder.")
    return p


def _inside(root: Path, rel: str) -> tuple[Path, str]:
    """A path under the folder, resolved, and its path relative to the folder; never a private one, never outside."""
    rel = str(rel or "").strip().replace("\\", "/").lstrip("/")
    if rel in ("", "."):
        return root, ""
    if artifacts._private_rel(rel):
        raise FolderError(f"{rel} is private (a hidden file or folder, a key or a credential): it isn't read.")
    try:
        target = (root / rel).resolve(strict=True)
    except (OSError, RuntimeError):
        raise FolderError(f"There's no {rel} in the folder.") from None
    try:
        inner = target.relative_to(root).as_posix()
    except ValueError:
        raise FolderError(f"{rel} is outside the folder.") from None
    if inner and artifacts._private_rel(inner):
        raise FolderError(f"{rel} is private: it isn't read.")
    return target, inner


def _size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def list_dir(root: Path, rel: str = "") -> str:
    target, inner = _inside(root, rel)
    if not target.is_dir():
        raise FolderError(f"{rel} is a file: read it with folder_read.")
    rows, hidden, visible = [], 0, 0
    try:
        with os.scandir(target) as scanned:
            def candidates():
                nonlocal hidden, visible
                for entry in scanned:
                    name = f"{inner}/{entry.name}" if inner else entry.name
                    if artifacts._private_rel(name):
                        hidden += 1
                        continue
                    visible += 1
                    yield entry
            entries = heapq.nsmallest(
                MAX_LIST, candidates(), key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
    except OSError as error:
        raise FolderError(f"{rel or 'The folder'} can't be read ({error.strerror}).") from None
    for entry in entries:
        try:
            if entry.is_dir():
                rows.append(entry.name + "/")
            else:
                rows.append(f"{entry.name}  {_size(entry.stat().st_size)}")
        except OSError:
            continue
    if visible > MAX_LIST:
        rows.append(f"… and more ({visible - MAX_LIST} not listed)")
    head = f"{inner or '.'}/ ({len(rows)} entries" + (f"; {hidden} private ones not shown" if hidden else "") + ")"
    return "\n".join([head, *rows]) if rows else head + "\n(empty)"


def _read_regular(path: Path, limit: int) -> bytes:
    """Read through a pinned parent and file descriptor; a late link cannot redirect it."""
    try:
        return read_regular_bytes(path, maximum=limit)[0]
    except WorkspaceBoundaryError as error:
        raise OSError(str(error)) from None


def read(root: Path, rel: str, start_line: int = 1) -> str:
    target, inner = _inside(root, rel)
    if target.is_dir():
        raise FolderError(f"{rel} is a folder: list it with folder_list.")
    try:
        size = target.stat().st_size
        if size > MAX_READ_BYTES:
            raise FolderError(f"{inner} is {_size(size)}, more than DGC reads here.")
        raw = _read_regular(target, MAX_READ_BYTES)
    except OSError as error:
        raise FolderError(f"{inner} can't be read ({error.strerror}).") from None
    if inner.lower().endswith(DOCUMENTS):
        from .. import documents
        try:
            text = documents.extract_text(raw, target.name).text
        except Exception as error:               # noqa: BLE001 -- the model hears why, the chat goes on
            raise FolderError(f"{inner} couldn't be read as a document ({type(error).__name__}).") from None
    elif b"\x00" in raw[:8192]:
        raise FolderError(f"{inner} isn't text ({_size(size)}).")
    else:
        text = raw.decode("utf-8", "replace")
    lines = text.splitlines()
    start = max(1, int(start_line or 1))
    out, used, end = [], 0, start - 1
    for n in range(start, len(lines) + 1):
        line = f"{n:>5}  {lines[n - 1]}"
        if used + len(line) > MAX_READ_CHARS and out:
            break
        out.append(line)
        used += len(line) + 1
        end = n
    head = f"{inner} ({len(lines)} lines)"
    tail = f"\n… lines {end + 1}–{len(lines)} not shown: read on with start_line {end + 1}." if end < len(lines) else ""
    return head + "\n" + "\n".join(out) + tail


def search(root: Path, text: str, files: str = "") -> str:
    needle = str(text or "").strip().lower()
    if not needle:
        raise FolderError("Say what to find.")
    pattern = str(files or "").strip()
    found, looked = [], 0
    for folder, dirs, names in os.walk(root):
        here = Path(folder)
        rel_dir = here.relative_to(root).as_posix()
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS
                         and not artifacts._private_rel(f"{rel_dir}/{d}" if rel_dir != "." else d))
        for name in sorted(names):
            rel = f"{rel_dir}/{name}" if rel_dir != "." else name
            if artifacts._private_rel(rel) or (pattern and not (fnmatch.fnmatch(rel, pattern)
                                                                 or fnmatch.fnmatch(name, pattern))):
                continue
            looked += 1
            if looked > MAX_SEARCH_FILES:
                found.append(f"… stopped after {MAX_SEARCH_FILES} files: narrow it with files.")
                return "\n".join(found)
            path = here / name
            try:
                if path.is_symlink():
                    continue
                raw = _read_regular(path, MAX_SEARCH_BYTES)
            except OSError:
                continue
            if b"\x00" in raw[:8192]:
                continue
            for n, line in enumerate(raw.decode("utf-8", "replace").splitlines(), 1):
                if needle in line.lower():
                    found.append(f"{rel}:{n}: {line.strip()[:200]}")
                    if len(found) >= MAX_MATCHES:
                        found.append(f"… more than {MAX_MATCHES} lines hold it: narrow it with files.")
                        return "\n".join(found)
    return "\n".join(found) if found else f"Nothing in the folder holds “{text}”."


def call(root: Path, name: str, args) -> str:
    """One folder tool call: what the model is told (an error starts with "error:")."""
    args = args if isinstance(args, dict) else {}
    try:
        if name == "folder_list":
            return list_dir(root, str(args.get("path") or ""))
        if name == "folder_read":
            start = args.get("start_line")
            return read(root, str(args.get("path") or ""), int(start) if isinstance(start, (int, float)) else 1)
        if name == "folder_search":
            return search(root, str(args.get("text") or ""), str(args.get("files") or ""))
    except FolderError as error:
        return f"error: {error}"
    return f"error: there's no tool named {name}."
