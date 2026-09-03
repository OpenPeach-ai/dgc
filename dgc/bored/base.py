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
    best: str = ""


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
    GameChoice("stack", "03  STACK", "arcade · rotate blocks and clear rows"),
    GameChoice("mines", "04  MINES", "logic · reveal safely and flag hazards"),
    GameChoice("paddle", "05  PADDLE", "arcade · rally against the terminal"),
    GameChoice("bricks", "06  BRICKS", "arcade · rebound through a neon wall"),
    GameChoice("orbit", "07  ORBIT", "action · thrust, turn, and clear debris"),
    GameChoice("raid", "08  SPACE RAID", "arcade · defend the prompt line"),
    GameChoice("maze", "09  MAZE RUN", "procedural · collect shards and find the exit"),
    GameChoice("flap", "10  FLAP", "one-button · thread the signal gates"),
    GameChoice("sudoku", "11  SUDOKU", "logic · arrows, digits, and delete"),
    GameChoice("chess", "12  CHESS", "two-player · legal moves, check, and castling"),
    GameChoice("wordgrid", "13  WORD GRID", "words · six tries, five letters"),
    GameChoice("life", "14  LIFE", "sandbox · draw cells and evolve generations"),
    GameChoice("process", "15  PROCESS DEFENDER", "reaction · stop simulated runaway jobs"),
)

_SCORE_FIELDS = {
    "snake": "score",
    "merge": "score",
    "stack": "score",
    "paddle": "player_score",
    "bricks": "score",
    "orbit": "score",
    "raid": "score",
    "flap": "score",
    "process": "score",
}


def game_choices() -> tuple[GameChoice, ...]:
    return _CHOICES


def tracks_high_score(game: str) -> bool:
    return str(game or "").lower() in _SCORE_FIELDS


def _make_game(key: str, seed: int | None = None) -> ArcadeGame:
    if key == "snake":
        from .snake import ByteSnake
        return ByteSnake(seed=seed)
    if key == "merge":
        from .merge import Merge
        return Merge(seed=seed)
    if key == "stack":
        from .stack import Stack
        return Stack(seed=seed)
    if key == "mines":
        from .mines import Mines
        return Mines(seed=seed)
    if key == "paddle":
        from .paddle import Paddle
        return Paddle(seed=seed)
    if key == "bricks":
        from .bricks import Bricks
        return Bricks(seed=seed)
    if key == "orbit":
        from .orbit import Orbit
        return Orbit(seed=seed)
    if key == "raid":
        from .raid import SpaceRaid
        return SpaceRaid(seed=seed)
    if key == "maze":
        from .maze import MazeRun
        return MazeRun(seed=seed)
    if key == "flap":
        from .flap import Flap
        return Flap(seed=seed)
    if key == "sudoku":
        from .sudoku import Sudoku
        return Sudoku(seed=seed)
    if key == "chess":
        from .chess import Chess
        return Chess(seed=seed)
    if key == "wordgrid":
        from .wordgrid import WordGrid
        return WordGrid(seed=seed)
    if key == "life":
        from .life import Life
        return Life(seed=seed)
    if key == "process":
        from .process_defender import ProcessDefender
        return ProcessDefender(seed=seed)
    raise ValueError(f"unknown game: {key}")


class BoredController:
    """Thread-safe lifecycle around one game.

    Agent callbacks arrive on a worker thread while rendering/input happens on prompt_toolkit's
    thread.  The lock makes completion/permission auto-pauses atomic without introducing another
    ticker thread.  The application's existing refresh cadence drives ``tick`` only while the pane
    is actually rendered.
    """

    def __init__(self, game: str, *, seed: int | None = None,
                 now: float | None = None, scores=None) -> None:
        self._lock = threading.RLock()
        self.game = _make_game(game, seed=seed)
        self._scores = scores
        self._best_score = self._stored_best()
        self._revision = 0
        self.paused = False
        self.pause_reason = ""
        self.started_at = time.monotonic() if now is None else float(now)
        self.game.on_resume(self.started_at)

    def _current_score(self) -> int | None:
        field = _SCORE_FIELDS.get(self.game.key)
        value = getattr(self.game, field, None) if field else None
        return (max(0, int(value))
                if isinstance(value, int) and not isinstance(value, bool) else None)

    def _stored_best(self) -> int:
        if self._scores is None or not tracks_high_score(self.game.key):
            return 0
        try:
            return max(0, int(self._scores.best(self.game.key)))
        except (AttributeError, TypeError, ValueError, OverflowError):
            return 0

    def _capture_record(self) -> None:
        current = self._current_score()
        if self._scores is None or current is None or current <= self._best_score:
            return
        try:
            self._best_score = max(self._best_score,
                                   int(self._scores.record(self.game.key, current)))
        except (AttributeError, TypeError, ValueError, OverflowError):
            # High scores are deliberately subordinate to both the game and agent execution.
            return

    @property
    def key(self) -> str:
        return self.game.key

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    def pause(self, reason: str = "PAUSED") -> bool:
        with self._lock:
            changed = not self.paused or self.pause_reason != reason
            self.paused = True
            self.pause_reason = str(reason or "PAUSED").upper()
            if changed:
                self._revision += 1
            return changed

    def resume(self, now: float | None = None) -> bool:
        with self._lock:
            if not self.paused:
                return False
            moment = time.monotonic() if now is None else float(now)
            self.paused = False
            self.pause_reason = ""
            self.game.on_resume(moment)
            self._revision += 1
            return True

    def restart(self, now: float | None = None) -> None:
        with self._lock:
            moment = time.monotonic() if now is None else float(now)
            self.game.restart(moment)
            self.paused = False
            self.pause_reason = ""
            self._revision += 1

    def handle_key(self, key: str, *, now: float | None = None) -> str:
        """Handle one normalized key and return ``exit``, ``changed``, or ``ignored``."""
        token = str(key or "").lower()
        moment = time.monotonic() if now is None else float(now)
        with self._lock:
            if token == "escape":
                return "exit"
            text_input = bool(getattr(self.game, "text_input", False))
            if token == "q" and not text_input:
                return "exit"
            if token == "p":
                if self.paused:
                    self.resume(moment)
                elif not text_input:
                    self.pause("PAUSED")
                else:
                    return "changed" if self.game.handle_key(token) else "ignored"
                return "changed"
            if token == "r" and not text_input:
                self.restart(moment)
                return "changed"
            if self.paused:
                return "ignored"
            if self.game.handle_key(token):
                self._capture_record()
                self._revision += 1
                return "changed"
            return "ignored"

    def advance(self, *, now: float | None = None) -> int:
        """Advance real-time mechanics if due and return the resulting render revision."""
        moment = time.monotonic() if now is None else float(now)
        with self._lock:
            if not self.paused and self.game.tick(moment):
                self._capture_record()
                self._revision += 1
            return self._revision

    def snapshot(self, width: int, height: int) -> GameFrame:
        """Build a frame without advancing time (used after the TUI's render-cache check)."""
        with self._lock:
            frame = self.game.frame(max(1, int(width)), max(1, int(height)))
            if self._scores is not None and tracks_high_score(self.game.key):
                current = self._current_score() or 0
                frame = replace(frame, best=f"BEST {max(current, self._best_score):,}")
            if self.paused:
                return replace(frame, status=self.pause_reason or "PAUSED", paused=True)
            return frame

    def frame(self, width: int, height: int, *, now: float | None = None) -> GameFrame:
        self.advance(now=now)
        return self.snapshot(width, height)
