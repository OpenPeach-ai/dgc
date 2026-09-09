"""Private, bounded high-score storage for DGC's local terminal arcade."""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from .config import USER_HOME
from .scheduler import named_process_lock
from .workspace import WorkspaceBoundaryError, atomic_write_bytes, read_regular_bytes

STATE_FILE = USER_HOME / "arcade-scores.json"
FORMAT_VERSION = 1
MAX_FILE_BYTES = 16_384
MAX_SCORE = 999_999_999
MAX_GAMES = 64
_KEY = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")


class ArcadeScoreStore:
    """Keep monotonic per-game records without exposing them outside this machine.

    Writes are atomic and owner-only.  A named OS lease makes read/merge/write safe across several
    DGC processes, while failures remain non-fatal so an unavailable score file can never interrupt
    the agent or a game.
    """

    def __init__(self, path: Path | None = None) -> None:
        raw = STATE_FILE if path is None else Path(path)
        expanded = raw.expanduser()
        # Freeze the parent once, but leave the final component unresolved so an existing score
        # symlink is rejected by the exact reader rather than followed to its target.
        self.path = expanded.parent.resolve(strict=False) / expanded.name
        self._local_lock = threading.RLock()
        self._scores = self._read()[0]

    @staticmethod
    def _clean(payload) -> dict[str, int]:
        source = payload.get("scores", {}) if isinstance(payload, dict) else {}
        if not isinstance(source, dict):
            return {}
        clean: dict[str, int] = {}
        for key, value in source.items():
            if len(clean) >= MAX_GAMES:
                break
            if (not isinstance(key, str) or not _KEY.fullmatch(key)
                    or not isinstance(value, int) or isinstance(value, bool)):
                continue
            clean[key] = max(0, min(MAX_SCORE, value))
        return clean

    def _read(self) -> tuple[dict[str, int], object | None, bool]:
        """Return scores, exact file version, and whether the path was safe to update."""
        try:
            result = read_regular_bytes(self.path, maximum=MAX_FILE_BYTES, missing_ok=True)
        except (OSError, ValueError, WorkspaceBoundaryError):
            return {}, None, False
        if result is None:
            return {}, None, True
        data, version = result
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {}
        return self._clean(payload), version, True

    def best(self, game: str) -> int:
        key = str(game or "").lower()
        with self._local_lock:
            return int(self._scores.get(key, 0))

    def refresh(self) -> None:
        """Pick up records written by another DGC process without lowering local values."""
        with self._local_lock:
            disk_scores, _version, safe = self._read()
            if safe:
                for key, value in disk_scores.items():
                    self._scores[key] = max(value, self._scores.get(key, 0))

    def record(self, game: str, score: int) -> int:
        """Persist a higher score and return the best known value."""
        key = str(game or "").lower()
        if not _KEY.fullmatch(key):
            return 0
        try:
            candidate = max(0, min(MAX_SCORE, int(score)))
        except (TypeError, ValueError, OverflowError):
            return self.best(key)
        with self._local_lock:
            if candidate <= self._scores.get(key, 0):
                return int(self._scores.get(key, 0))
            lease = named_process_lock("arcade-scores", str(self.path))
            if not lease.acquire(timeout=0.2):
                return int(self._scores.get(key, 0))
            try:
                disk_scores, expected, safe = self._read()
                if not safe:
                    return int(self._scores.get(key, 0))
                merged = dict(disk_scores)
                merged[key] = max(candidate, merged.get(key, 0))
                if len(merged) > MAX_GAMES:
                    merged = dict(sorted(merged.items())[:MAX_GAMES])
                    if key not in merged:
                        return int(self._scores.get(key, 0))
                payload = (json.dumps({"version": FORMAT_VERSION, "scores": merged},
                                      ensure_ascii=True, sort_keys=True,
                                      separators=(",", ":")) + "\n").encode("utf-8")
                try:
                    self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if os.name == "posix":
                        self.path.parent.chmod(0o700)
                    atomic_write_bytes(self.path, payload, expected=expected, mode=0o600)
                except (OSError, ValueError, WorkspaceBoundaryError):
                    return int(self._scores.get(key, 0))
                self._scores = merged
                return int(merged[key])
            finally:
                lease.release()
