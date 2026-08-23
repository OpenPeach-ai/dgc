"""Checkpoints + rewind — snapshot the conversation length and the pre-edit content of any
file DGC touches, per user turn, so the user can rewind both the conversation and the code
to an earlier point (for /rewind).

File state is captured lazily: the first time a file is written/edited in a turn, its prior
content (or None if it didn't exist) is saved. Rewinding to checkpoint K restores every file
touched at K-or-later to its earliest saved state, and truncates the conversation to K.
"""
from __future__ import annotations

from pathlib import Path


class CheckpointManager:
    def __init__(self):
        self.points: list[dict] = []   # {"msg_count", "preview", "files": {path: prior_or_None}}

    def open(self, msg_count: int, preview: str) -> None:
        self.points.append({"msg_count": msg_count,
                            "preview": (preview or "").strip()[:70] or "(turn)",
                            "files": {}})

    def record_file(self, path: str) -> None:
        """Save a file's current content before it is edited (once per file per turn)."""
        if not self.points:
            return
        files = self.points[-1]["files"]
        if path in files:
            return
        p = Path(path)
        try:
            files[path] = p.read_text() if p.exists() else None
        except OSError:
            files[path] = None

    def listing(self) -> list[tuple[int, str, int]]:
        """(index, preview, files-touched) for each checkpoint, oldest first."""
        return [(i, pt["preview"], len(pt["files"])) for i, pt in enumerate(self.points)]

    def rewind(self, idx: int) -> tuple[int, int]:
        """Restore files to their state at checkpoint idx and drop later checkpoints.
        Returns (message_count_to_truncate_to, files_restored)."""
        if not (0 <= idx < len(self.points)):
            return (-1, 0)
        restore: dict[str, str | None] = {}
        for pt in self.points[idx:]:                 # earliest saved state per file wins
            for path, prior in pt["files"].items():
                restore.setdefault(path, prior)
        for path, prior in restore.items():
            p = Path(path)
            try:
                if prior is None:
                    if p.exists():
                        p.unlink()
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(prior)
            except OSError:
                pass
        msg_count = self.points[idx]["msg_count"]
        del self.points[idx:]
        return msg_count, len(restore)
