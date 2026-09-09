"""Clean-room falling-block terminal puzzle."""
from __future__ import annotations

import random
import time

from .base import GameFrame
from .drawing import centered


class Stack:
    key = "stack"
    title = "STACK"
    description = "arcade · rotate blocks and clear rows"
    minimum_width = 30
    minimum_height = 10
    board_width = 10
    board_height = 12
    _INTERVAL = 0.48
    _BASE_SHAPES = (
        ((0, 0), (1, 0), (2, 0), (3, 0)),
        ((0, 0), (1, 0), (0, 1), (1, 1)),
        ((0, 0), (1, 0), (2, 0), (1, 1)),
        ((1, 0), (2, 0), (0, 1), (1, 1)),
        ((0, 0), (1, 0), (1, 1), (2, 1)),
        ((0, 0), (0, 1), (1, 1), (2, 1)),
        ((2, 0), (0, 1), (1, 1), (2, 1)),
    )

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self._rotations = tuple(self._make_rotations(shape) for shape in self._BASE_SHAPES)
        self.restart()

    @staticmethod
    def _normalize(cells: tuple[tuple[int, int], ...]) -> tuple[tuple[int, int], ...]:
        x0 = min(x for x, _ in cells)
        y0 = min(y for _, y in cells)
        return tuple(sorted((x - x0, y - y0) for x, y in cells))

    @classmethod
    def _make_rotations(cls, shape):
        rotations = []
        current = cls._normalize(tuple(shape))
        for _ in range(4):
            if current not in rotations:
                rotations.append(current)
            current = cls._normalize(tuple((-y, x) for x, y in current))
        return tuple(rotations)

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self.board = [[0] * self.board_width for _ in range(self.board_height)]
        self.score = 0
        self.lines = 0
        self.level = 1
        self.over = False
        self._bag: list[int] = []
        self.next_kind = self._draw()
        self._spawn()
        self._next_tick = (time.monotonic() if now is None else float(now)) + self._interval()

    def _draw(self) -> int:
        if not self._bag:
            self._bag = list(range(len(self._BASE_SHAPES)))
            self._rng.shuffle(self._bag)
        return self._bag.pop()

    def _spawn(self) -> None:
        self.kind = self.next_kind
        self.next_kind = self._draw()
        self.rotation = 0
        shape = self._shape()
        shape_width = max(x for x, _ in shape) + 1
        self.x = (self.board_width - shape_width) // 2
        self.y = 0
        if not self._fits(self.x, self.y, shape):
            self.over = True

    def _shape(self, rotation: int | None = None):
        rotations = self._rotations[self.kind]
        return rotations[(self.rotation if rotation is None else rotation) % len(rotations)]

    def _fits(self, x0: int, y0: int, shape) -> bool:
        for dx, dy in shape:
            x, y = x0 + dx, y0 + dy
            if x < 0 or x >= self.board_width or y < 0 or y >= self.board_height:
                return False
            if self.board[y][x]:
                return False
        return True

    def _lock(self) -> None:
        for dx, dy in self._shape():
            self.board[self.y + dy][self.x + dx] = self.kind + 1
        cleared = sum(all(row) for row in self.board)
        if cleared:
            self.board = [[0] * self.board_width for _ in range(cleared)] + [
                row for row in self.board if not all(row)]
            self.lines += cleared
            self.level = 1 + self.lines // 8
            self.score += (0, 100, 300, 500, 800)[cleared] * self.level
        self._spawn()

    def _drop(self, *, soft: bool = False) -> bool:
        if self._fits(self.x, self.y + 1, self._shape()):
            self.y += 1
            if soft:
                self.score += 1
            return True
        self._lock()
        return True

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._interval()

    def _interval(self) -> float:
        return max(0.12, self._INTERVAL - (self.level - 1) * 0.045)

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._interval()
        return self._drop()

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        if key in ("left", "a") and self._fits(self.x - 1, self.y, self._shape()):
            self.x -= 1
            return True
        if key in ("right", "d") and self._fits(self.x + 1, self.y, self._shape()):
            self.x += 1
            return True
        if key in ("down", "s"):
            return self._drop(soft=True)
        if key in ("up", "w"):
            target = (self.rotation + 1) % len(self._rotations[self.kind])
            shape = self._shape(target)
            for kick in (0, -1, 1, -2, 2):
                if self._fits(self.x + kick, self.y, shape):
                    self.x += kick
                    self.rotation = target
                    return True
            return False
        if key == "space":
            distance = 0
            while self._fits(self.x, self.y + 1, self._shape()):
                self.y += 1
                distance += 1
            self.score += distance * 2
            self._lock()
            return True
        return False

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "A/D MOVE · W/UP ROTATE · S/DOWN DROP · SPACE SLAM · R RESET · Q/ESC BACK"
        visible_height = min(self.board_height, max(1, height))
        # Follow the live piece in compact panes; normal terminals show the complete 12-row board.
        shape_height = max(dy for _, dy in self._shape()) + 1
        y0 = max(0, min(self.y + shape_height // 2 - visible_height // 2,
                        self.board_height - visible_height))
        active = {(self.x + dx, self.y + dy): self.kind + 1 for dx, dy in self._shape()}
        ghost_y = self.y
        while self._fits(self.x, ghost_y + 1, self._shape()):
            ghost_y += 1
        ghost = {(self.x + dx, ghost_y + dy) for dx, dy in self._shape()}
        cell_width = 2 if width >= self.board_width * 2 else 1
        rows = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(self.board_width):
                pos = (x, y)
                value = active.get(pos, self.board[y][x])
                if value:
                    glyph, role = "■", f"stack-{value}"
                elif pos in ghost:
                    glyph, role = "·", "stack-ghost"
                else:
                    glyph, role = "·" if (x + y) % 2 == 0 else " ", "game-floor"
                cells.append((glyph + " " * (cell_width - 1), role))
            rows.append(centered(cells, width))
        status = "STACK LOCKED · R RESTART" if self.over else ""
        return GameFrame(self.title,
                         f"SCORE {self.score:06d} · LINES {self.lines:02d} · LV {self.level:02d}",
                         tuple(rows), footer, status=status)
