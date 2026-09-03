"""Small game protocol and lifecycle controller for DGC's in-process arcade pane."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, replace
from typing import Protocol


@dataclass(frozen=True)
class Segment:
    """One styled run in a game frame; roles are mapped to the active DGC theme by the TUI."""

    text: str
    role: str = "text"


@dataclass(frozen=True)
class GameFrame:
    """Renderer-neutral snapshot produced by a game."""

    title: str
    score: str
    lines: tuple[tuple[Segment, ...], ...]
    footer: str
    status: str = ""
    paused: bool = False


class ArcadeGame(Protocol):
    key: str
    title: str
    description: str
    minimum_width: int
    minimum_height: int

    def handle_key(self, key: str) -> bool: ...
    def tick(self, now: float) -> bool: ...
    def restart(self, now: float | None = None) -> None: ...
    def on_resume(self, now: float) -> None: ...
    def frame(self, width: int, height: int) -> GameFrame: ...


@dataclass(frozen=True)
class GameChoice:
    key: str
    title: str
    description: str


_CHOICES = (
    GameChoice("snake", "01  BYTE SNAKE", "real-time · arrows or WASD"),
    GameChoice("merge", "02  MERGE", "turn-based · arrows or WASD"),
)


def game_choices() -> tuple[GameChoice, ...]:
    return _CHOICES


def _make_game(key: str, seed: int | None = None) -> ArcadeGame:
    if key == "snake":
        from .snake import ByteSnake
        return ByteSnake(seed=seed)
    if key == "merge":
        from .merge import Merge
        return Merge(seed=seed)
    raise ValueError(f"unknown game: {key}")


class BoredController:
    """Thread-safe lifecycle around one game.

    Agent callbacks arrive on a worker thread while rendering/input happens on prompt_toolkit's
    thread.  The lock makes completion/permission auto-pauses atomic without introducing another
    ticker thread.  The application's existing refresh cadence drives ``tick`` only while the pane
    is actually rendered.
    """

    def __init__(self, game: str, *, seed: int | None = None,
                 now: float | None = None) -> None:
        self._lock = threading.RLock()
        self.game = _make_game(game, seed=seed)
        self.paused = False
        self.pause_reason = ""
        self.started_at = time.monotonic() if now is None else float(now)
        self.game.on_resume(self.started_at)

    @property
    def key(self) -> str:
        return self.game.key

    def pause(self, reason: str = "PAUSED") -> bool:
        with self._lock:
            changed = not self.paused or self.pause_reason != reason
            self.paused = True
            self.pause_reason = str(reason or "PAUSED").upper()
            return changed

    def resume(self, now: float | None = None) -> bool:
        with self._lock:
            if not self.paused:
                return False
            moment = time.monotonic() if now is None else float(now)
            self.paused = False
            self.pause_reason = ""
            self.game.on_resume(moment)
            return True

    def restart(self, now: float | None = None) -> None:
        with self._lock:
            moment = time.monotonic() if now is None else float(now)
            self.game.restart(moment)
            self.paused = False
            self.pause_reason = ""

    def handle_key(self, key: str, *, now: float | None = None) -> str:
        """Handle one normalized key and return ``exit``, ``changed``, or ``ignored``."""
        token = str(key or "").lower()
        moment = time.monotonic() if now is None else float(now)
        with self._lock:
            if token in ("q", "escape"):
                return "exit"
            if token == "p":
                if self.paused:
                    self.resume(moment)
                else:
                    self.pause("PAUSED")
                return "changed"
            if token == "r":
                self.restart(moment)
                return "changed"
            if self.paused:
                return "ignored"
            return "changed" if self.game.handle_key(token) else "ignored"

    def frame(self, width: int, height: int, *, now: float | None = None) -> GameFrame:
        moment = time.monotonic() if now is None else float(now)
        with self._lock:
            if not self.paused:
                self.game.tick(moment)
            frame = self.game.frame(max(1, int(width)), max(1, int(height)))
            if self.paused:
                return replace(frame, status=self.pause_reason or "PAUSED", paused=True)
            return frame
