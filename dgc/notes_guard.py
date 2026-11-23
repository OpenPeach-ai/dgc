"""Home's Notes are kept from the model (0.52, decided 14 Nov: "never shown to the model unless you share a note").

The editor keeps each note as a file in its storage for the extension: <editor storage>/globalStorage/vibedgc.dgc/notes/
(VS Code, Cursor, a Remote-SSH server, macOS's Application Support alike). Any file or search tool aimed inside that
folder is refused (dgc/permissions.py), a search from a folder above never walks into it (dgc/tools.py), and a shell
command that names it is refused. Honest gap: a shell command can still reach it without naming it, since it runs as the
user; a locked note is ciphertext whose key is not on disk."""
from __future__ import annotations

import re
from pathlib import PurePath

REFUSAL = "Your notes are kept from DGC. Share a note into the chat if you want DGC to see it."
RG_EXCLUDE = "!**/vibedgc.dgc/notes/**"
_COMMAND = re.compile(r"vibedgc\.dgc[\\/]+notes(?:[\\/\s\"']|$)", re.IGNORECASE)


def is_notes_path(path) -> bool:
    """Whether a path is the editor's notes folder or inside it: ...globalStorage/vibedgc.dgc/notes[/...]."""
    try:
        parts = [part.lower() for part in PurePath(str(path)).parts]
    except Exception:                              # noqa: BLE001 -- an odd path is simply not the notes folder
        return False
    for i in range(len(parts) - 2):
        if parts[i] == "globalstorage" and parts[i + 1] == "vibedgc.dgc" and parts[i + 2] == "notes":
            return True
    return False


def mentions_notes(command: str) -> bool:
    """Whether a shell command names the editor's notes folder."""
    return bool(_COMMAND.search(str(command or "")))
