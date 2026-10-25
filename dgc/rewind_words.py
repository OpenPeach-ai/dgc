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


def also_puts_back(paths, shown: int = 5) -> str:
    """Undo's question, about the files it restores from Git because one of the turns' commands changed
    them: "Also puts back 2 files a command changed: rates.py, README.md." Nothing is restored unseen."""
    paths = [str(path) for path in paths]
    if not paths:
        return ""
    named = ", ".join(paths[:shown]) + (f" and {len(paths) - shown} more" if len(paths) > shown else "")
    return f"Also puts back {files(len(paths))} a command changed: {named}."


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


# Undo rewrites files and nothing else: never the index, HEAD, a branch, a stash or a commit (Codex's
# server-side undo reset people's staging, openai/codex#8214). When a command in the undone turns moved
# one of those, the question and the line after say so.
GIT_LEFT_QUESTION = "Your files are put back; Git's commits, branches, stashes and staging are left as they are."
GIT_LEFT = "Git's commits, branches, stashes and staging are left as they are."


def done(restored: int, left_count: int = 0, git: bool = False) -> str:
    """The editor's and the terminal's line after an Undo."""
    line = f"↩ Undone; DGC restored {files(restored)}."
    for tail in (left(left_count), GIT_LEFT if git else ""):
        if tail:
            line = f"{line} {tail}"
    return line
