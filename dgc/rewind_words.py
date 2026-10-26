"""What Undo says, in one place: the terminal, the classic terminal and the chat line share it (the
editor's panel says the same in panel.ts)."""
from __future__ import annotations

# Why a file stops an Undo (CheckpointManager.last_rewind_reasons), as the person reads it.
REASONS = {
    "changed": "changed after DGC last wrote it",
    "between": "changed after DGC wrote it, before DGC wrote it again",
    "overlap": "your edits overlap DGC's",
    "binary": "changed after DGC wrote it, and DGC can't merge a binary file",
    "large": "changed after DGC wrote it, and is too large for DGC to merge",
    "link": "changed after DGC wrote it, and DGC can't merge a link",
    "deleted": "deleted after DGC wrote it",
    "mode": "its permissions changed after DGC last wrote it",
    "unreadable": "DGC can't read it now",
}


# Undo's question, file by file, about the files somebody changed after DGC wrote them: a clean merge
# keeps their edits and takes DGC's out; an overlap is held back (left as it is).
def merged_line(path) -> str:
    return f"{path}: your later edits are kept and DGC's are taken out"


def held_line(path) -> str:
    return f"{path}: your edits overlap DGC's; it is left as it is"


def question_lines(question: dict, shown: int = 8) -> list[str]:
    """The per-file lines of Undo's question (CheckpointManager.undo_question), merged ones first."""
    lines = [merged_line(path) for path in question.get("merged") or ()]
    lines += [held_line(row["path"]) for row in question.get("held") or () if row.get("reason") == "overlap"]
    if len(lines) > shown:
        lines = lines[:shown] + [f"…and {len(lines) - shown} more"]
    return lines


def overlapping(question: dict) -> list[str]:
    """The files the question holds back: Undo leaves them as they are unless the person says Undo anyway."""
    return [str(row["path"]) for row in question.get("held") or () if row.get("reason") == "overlap"]


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
    """Undo's question, about the files it puts back because they changed while one of the turns' commands
    ran: "Also puts back 2 files changed while a command ran: rates.py, README.md." Nothing is restored
    unseen. A save no editor reported is taken by time for the command's (KEEP_EDITED lets the person
    keep one)."""
    paths = [str(path) for path in paths]
    if not paths:
        return ""
    named = ", ".join(paths[:shown]) + (f" and {len(paths) - shown} more" if len(paths) > shown else "")
    return f"Also puts back {files(len(paths))} changed while a command ran: {named}."


# The choice about those files: put them all back, or pick the ones the person edited themselves.
RESTORE_ALL = "Restore all"
KEEP_EDITED = "Keep the ones I edited…"
PICK_QUESTION = ("Which of these did you edit yourself while the command ran? The ones you tick are left "
                 "as they are; the rest are put back.")


def anyway_overlap(paths) -> str:
    """The question's other choice when it holds files back: put them back too, losing those edits."""
    return f"Undo anyway: put back {names(paths)} too, losing your edits there"


# After a refusal that names a file whose edits overlap DGC's: leave it, and undo everything else.
UNDO_THE_REST = "Undo the rest"


def undo_the_rest(paths) -> str:
    paths = [str(path) for path in paths]
    return f"Undo the rest leaves {names(paths)} as {'it is' if len(paths) == 1 else 'they are'}."


def kept(paths) -> str:
    """After an Undo: the files left as they are (held back, or kept by the person's choice)."""
    paths = [str(path) for path in paths]
    if not paths:
        return ""
    return f"{names(paths)} {'was' if len(paths) == 1 else 'were'} left as {'it is' if len(paths) == 1 else 'they are'}."


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


def done(restored: int, left_count: int = 0, git: bool = False, merged: int = 0, kept_paths=()) -> str:
    """The editor's and the terminal's line after an Undo. `restored` counts every file written, the
    `merged` ones among them ("↩ Undone; DGC restored 2 files and merged 1 with your edits.")."""
    merged = max(0, min(int(merged), int(restored)))
    put_back = int(restored) - merged
    if merged and put_back:
        line = f"↩ Undone; DGC restored {files(put_back)} and merged {merged} with your edits."
    elif merged:
        line = f"↩ Undone; DGC merged {files(merged)} with your edits."
    else:
        line = f"↩ Undone; DGC restored {files(restored)}."
    for tail in (kept(kept_paths), left(left_count), GIT_LEFT if git else ""):
        if tail:
            line = f"{line} {tail}"
    return line
