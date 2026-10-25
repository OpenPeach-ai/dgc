"""What Undo says, in one place: the terminal, the classic terminal and the chat line share it (the
editor's panel says the same in panel.ts)."""
from __future__ import annotations

# Why a file stops an Undo (CheckpointManager.last_rewind_reasons), as the person reads it.
REASONS = {
    "changed": "changed after DGC last wrote it",
    "between": "changed after DGC wrote it, before DGC wrote it again",
    "mode": "its permissions changed after DGC last wrote it",
    "unreadable": "DGC can't read it now",
}


def names(paths, shown: int = 4) -> str:
    """"a.py", "a.py and b.py", "a.py, b.py and c.py", "a.py, b.py, c.py, d.py and 3 more"."""
    paths = [str(path) for path in paths]
    if len(paths) > shown:
        return ", ".join(paths[:shown]) + f" and {len(paths) - shown} more"
    if len(paths) <= 1:
        return "".join(paths)
    return ", ".join(paths[:-1]) + " and " + paths[-1]


def files(n: int) -> str:
    return f"{n} file" if n == 1 else f"{n} files"


def refused(paths) -> str:
    """The chat line when Undo stops over somebody else's changes."""
    them = "it" if len(paths) == 1 else "them"
    return (f"Undo stopped: {names(paths)} changed after DGC wrote {them}, by you or another program. "
            "Nothing was restored, so those changes are intact.")


def anyway_question(paths) -> str:
    """Asked only after that refusal. "Keep my changes" is the default answer."""
    return ("These files changed after DGC wrote them, by you or another program: "
            f"{', '.join(str(path) for path in paths)}. Undo anyway puts back the version from before "
            "this turn and loses those changes.")


def failed(error: str) -> str:
    """The chat line when Undo stops for any other reason."""
    return f"Undo stopped: {error}. Nothing was changed, and the recovery point was kept."


def left(n: int) -> str:
    """Files commands changed in the undone turns, which Undo can't put back."""
    if n <= 0:
        return ""
    return ("1 file changed by a command was left as it is." if n == 1
            else f"{n} files changed by commands were left as they are.")


def stopped(n: int) -> str:
    if n <= 0:
        return ""
    return ("1 background helper from those turns was stopped." if n == 1
            else f"{n} background helpers from those turns were stopped.")


def done(restored: int, left_count: int = 0) -> str:
    """The editor's and the terminal's line after an Undo."""
    line = f"↩ Undone; DGC restored {files(restored)}."
    tail = left(left_count)
    return f"{line} {tail}" if tail else line
