"""Clean-room interactive cellular automaton."""
from __future__ import annotations

import random
import time

from .base import GameFrame
from .drawing import centered, crop_origin


class Life:
    key = "life"
    title = "LIFE"
    description = "sandbox · draw cells and evolve generations"
    minimum_width = 40
    minimum_height = 10
    board_width = 24
    board_height = 12
    _INTERVAL = 0.16

    _DIRECTIONS = {
        "up": (0, -1), "w": (0, -1), "down": (0, 1), "s": (0, 1),
        "left": (-1, 0), "a": (-1, 0), "right": (1, 0), "d": (1, 0),
    }

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self.cells: set[tuple[int, int]] = set()
        cx, cy = self.board_width // 2, self.board_height // 2
        pattern = ((0, -1), (1, 0), (-1, 1), (0, 1), (1, 1))
        self.cells.update(((cx + dx) % self.board_width, (cy + dy) % self.board_height)
                          for dx, dy in pattern)
        self.cursor = (cx, cy)
        self.generation = 0
        self.running = True
        self._next_tick = (time.monotonic() if now is None else float(now)) + self._INTERVAL

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._INTERVAL

    def _step(self) -> None:
        counts: dict[tuple[int, int], int] = {}
        for x, y in self.cells:
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx or dy:
                        pos = ((x + dx) % self.board_width, (y + dy) % self.board_height)
                        counts[pos] = counts.get(pos, 0) + 1
        self.cells = {pos for pos, count in counts.items()
                      if count == 3 or (count == 2 and pos in self.cells)}
        self.generation += 1

    def tick(self, now: float) -> bool:
        if not self.running or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._INTERVAL
        self._step()
        return True

    def handle_key(self, key: str) -> bool:
        direction = self._DIRECTIONS.get(key)
        if direction:
            x, y = self.cursor
            self.cursor = ((x + direction[0]) % self.board_width,
                           (y + direction[1]) % self.board_height)
            return True
        if key == "space":
            if self.cursor in self.cells:
                self.cells.remove(self.cursor)
            else:
                self.cells.add(self.cursor)
            return True
        if key == "enter":
            self.running = not self.running
            return True
        if key == "n" and not self.running:
            self._step()
            return True
        if key == "c":
            self.cells.clear()
            self.generation = 0
            self.running = False
            return True
        return False

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "MOVE ARROWS/WASD · SPACE DRAW · ENTER RUN/HOLD · N STEP · C CLEAR"
        cell_width = 2 if width >= 36 else 1
        visible_width = min(self.board_width, max(1, width // cell_width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(self.cursor[0], self.board_width, visible_width)
        y0 = crop_origin(self.cursor[1], self.board_height, visible_height)
        lines = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(x0, x0 + visible_width):
                pos = (x, y)
                glyph = "■" if pos in self.cells else "·"
                role = "life-cell" if pos in self.cells else "life-empty"
                if pos == self.cursor:
                    role = "board-cursor"
                cells.append((glyph + " " * (cell_width - 1), role))
            lines.append(centered(cells, width))
        mode = "RUN" if self.running else "HOLD"
        return GameFrame(self.title, f"GEN {self.generation:04d} · LIVE {len(self.cells):03d} · {mode}",
                         tuple(lines), footer)
