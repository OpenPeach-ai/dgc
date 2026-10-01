"""Memory — DGC.md files (a project memory file).

Two scopes:
  project:  <project-root>/DGC.md   — project conventions, loaded every session
  user:     ~/.dgc/DGC.md         — personal preferences across all projects

Quick-add:  user types `#some fact` in the REPL, or the model calls save_memory.
"""
from __future__ import annotations

import re

from pathlib import Path

from .config import USER_MEMORY
from .redaction import bounded_redacted_view
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


# A RULE is a block of an instruction file that must survive truncation whole. Two ways to mark one:
# a heading whose text begins with the WORD "Rule" or "Rules" (`## Rule: run the visual pass`,
# `## Rules`) -- "Rulebook" does not count -- or the explicit marker `<!-- dgc:rule -->` anywhere in
# the block, for a rule whose heading should read naturally.
_RULE_HEADING = re.compile(r"^#{1,6}[ \t]+rules?\b", re.IGNORECASE)
_RULE_MARKER = "<!-- dgc:rule -->"
_ANY_HEADING = re.compile(r"^#{1,6}[ \t]")
_RULES_LABEL = "[Rules from this file -- always kept in full]\n\n"


def _instruction_blocks(text: str) -> list[str]:
    """Split at Markdown headings; each block starts with its heading, the first may be a preamble.

    Splitting at line boundaries is what keeps this sentinel-safe: a `[REDACTED]` marker never spans
    a newline, so keeping or dropping WHOLE blocks can never leave half of one behind.
    """
    blocks: list[str] = []
    current: list[str] = []
    for line in text.splitlines(keepends=True):
        if _ANY_HEADING.match(line) and current:
            blocks.append("".join(current))
            current = []
        current.append(line)
    if current:
        blocks.append("".join(current))
    return blocks


def _is_rule(block: str) -> bool:
    stripped = block.lstrip("\n")
    first = stripped.splitlines()[0] if stripped else ""
    return bool(_RULE_HEADING.match(first)) or _RULE_MARKER in block


def _rule_name(block: str) -> str:
    first = block.strip().splitlines()[0] if block.strip() else ""
    return re.sub(r"^#{1,6}[ \t]+", "", first).strip()[:80] or "(an unnamed rule)"


def bounded_memory_view(text: str, maximum: int = MAX_MEMORY_PROMPT_CHARS) -> str:
    """Return a useful bounded head/newest-tail view, never dropping a rule from the middle.

    The head/tail view this used to be keeps the first third and the newest tail of an over-long file
    and silently drops everything between -- and a rule written in the middle of a long DGC.md was
    simply gone: not summarised, absent. Measured on the shipping code: 96,079 characters in, 32,768
    out, the middle not kept. A fact can be lost cheaply. A rule cannot.

    So when a file would be truncated, every RULE block (see `_RULE_HEADING`) is kept whole and put
    first under a label saying so, and the remaining budget is spent on the rest exactly as before.
    If the rules alone are larger than the budget, as many as fit are kept in order and the rest are
    NAMED in a notice rather than dropped quietly -- the file needs consolidating, and only its
    author can decide what to cut.

    A file that fits is returned unchanged. Rule-keeping only engages where truncation would otherwise
    lose something, so nobody under the limit sees their instructions reordered.
    """
    maximum = max(256, min(MAX_MEMORY_PROMPT_CHARS, int(maximum)))
    text = str(text or "").strip()
    if len(text) <= maximum:
        return text
    blocks = _instruction_blocks(text)
    rules = [block for block in blocks if _is_rule(block)]
    if not rules:
        return bounded_redacted_view(
            text, maximum, label="memory characters", head_fraction=1 / 3)

    pieces = [block.rstrip() + "\n\n" for block in rules]
    names = [_rule_name(block) for block in rules]
    kept: list[str] = []
    dropped: list[str] = []
    used = len(_RULES_LABEL)
    for index, piece in enumerate(pieces):
        # Keep this rule only if, after keeping it, the notice naming EVERY rule that could still
        # end up left out -- the ones already dropped plus all the ones after this -- still fits.
        # The final notice names a subset of that set, and a notice only grows with its names, so
        # the result is provably within budget and never has to be cut. Cutting it is how a
        # `[REDACTED]` sentinel inside a kept rule would be sliced in half.
        could_drop = dropped + names[index + 1:]
        reserve = len(_dropped_notice(could_drop, maximum)) if could_drop else 0
        if used + len(piece) + reserve <= maximum:
            kept.append(piece)
            used += len(piece)
        else:
            dropped.append(names[index])
    out = _RULES_LABEL + "".join(kept)
    if dropped:
        return out + _dropped_notice(dropped, maximum - len(out))

    rest = "".join(block for block in blocks if not _is_rule(block)).strip()
    room = maximum - len(out)
    if not rest:
        return out.rstrip()
    if room >= 128:
        return out + bounded_redacted_view(
            rest, room, label="memory characters", head_fraction=1 / 3)
    note = "[The rest of this file did not fit after its rules.]"
    return out + note if len(out) + len(note) <= maximum else out.rstrip()

def _dropped_notice(names: list[str], room: int = MAX_MEMORY_PROMPT_CHARS) -> str:
    """Name the rules left out, bounded so it can never itself overrun the budget.

    Names are listed until the next one would not fit; the remainder is counted, not dropped, so
    the reader always learns HOW MANY rules are missing even when it cannot be told which.
    """
    head = f"[{len(names)} rule(s) from this file did not fit in the instruction budget and are NOT in effect: "
    tail = ". The file needs its rules consolidated.]"
    listed: list[str] = []
    for name in names:
        trial = "; ".join(listed + [name])
        more = len(names) - len(listed) - 1
        suffix = f"; and {more} more" if more else ""
        if len(head) + len(trial) + len(suffix) + len(tail) > room:
            break
        listed.append(name)
    more = len(names) - len(listed)
    body = "; ".join(listed) + (f"; and {more} more" if more and listed else
                                 f"{more} unnamed" if more else "")
    return head + body + tail


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
