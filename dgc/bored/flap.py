"""Clean-room one-button terminal flight game."""
from __future__ import annotations

import random
import time

from .base import GameFrame
from .drawing import centered, crop_origin


class Flap:
    key = "flap"
    title = "FLAP"
    description = "one-button · thread the signal gates"
    minimum_width = 42
    minimum_height = 9
    board_width = 44
    board_height = 11
    bird_x = 8
    gap_size = 4
    _INTERVAL = 0.08

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self.bird_y = self.board_height / 2
        self.velocity = 0.0
        self.gates = [self._gate(30), self._gate(47)]
        self.score = 0
        self.over = False
        self._next_tick = (time.monotonic() if now is None else float(now)) + self._INTERVAL

    def _gate(self, x: int) -> list[int]:
        return [x, self._rng.randint(1, self.board_height - self.gap_size - 1), 0]

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._INTERVAL

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        if key in ("space", "up", "w"):
            self.velocity = -1.35
            return True
        return False

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._INTERVAL
        self.velocity = min(1.4, self.velocity + 0.28)
        self.bird_y += self.velocity
        for gate in self.gates:
            gate[0] -= 1
            if not gate[2] and gate[0] < self.bird_x:
                gate[2] = 1
                self.score += 1
        if self.gates and self.gates[0][0] < -1:
            self.gates.pop(0)
            self.gates.append(self._gate(self.gates[-1][0] + 17))
        by = round(self.bird_y)
        if by < 0 or by >= self.board_height:
            self.over = True
        for gx, gap, _ in self.gates:
            if abs(gx - self.bird_x) <= 0 and not gap <= by < gap + self.gap_size:
                self.over = True
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "SPACE/W/UP FLAP · P PAUSE · R RESET · Q/ESC BACK"
        visible_width = min(self.board_width, max(1, width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(self.bird_x, self.board_width, visible_width)
        y0 = crop_origin(round(self.bird_y), self.board_height, visible_height)
        bird = (self.bird_x, round(self.bird_y))
        gate_cells = {(gx, y) for gx, gap, _ in self.gates
                      for y in range(self.board_height) if not gap <= y < gap + self.gap_size}
        rows = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(x0, x0 + visible_width):
                if (x, y) == bird:
                    glyph, role = "▶", "good" if not self.over else "error"
                elif (x, y) in gate_cells:
                    glyph, role = "┃", "accent"
                elif (x * 3 + y * 5) % 37 == 0:
                    glyph, role = "·", "grid"
                else:
                    glyph, role = " ", "game-floor"
                cells.append((glyph, role))
            rows.append(centered(cells, width))
        status = "SIGNAL LOST · R RETRY" if self.over else ""
        return GameFrame(self.title, f"GATES {self.score:03d}", tuple(rows), footer, status=status)
