"""Clean-room sliding/merging tile puzzle mechanics and renderer."""
from __future__ import annotations

import random
import time

from .base import GameFrame, Segment


class Merge:
    key = "merge"
    title = "MERGE"
    description = "turn-based · arrows or WASD"
    minimum_width = 38
    minimum_height = 8
    size = 4

    _DIRECTIONS = {
        "up": "up", "w": "up", "down": "down", "s": "down",
        "left": "left", "a": "left", "right": "right", "d": "right",
    }

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        del now
        self._rng = random.Random(self._seed)
        self.board = [[0 for _ in range(self.size)] for _ in range(self.size)]
        self.score = 0
        self.over = False
        self.won = False
        self._spawn()
        self._spawn()

    def on_resume(self, now: float) -> None:
        del now

    def tick(self, now: float) -> bool:
        del now
        return False

    def _spawn(self) -> bool:
        open_cells = [(r, c) for r in range(self.size) for c in range(self.size)
                      if self.board[r][c] == 0]
        if not open_cells:
            return False
        r, c = self._rng.choice(open_cells)
        self.board[r][c] = 4 if self._rng.random() < 0.1 else 2
        return True

    @staticmethod
    def _collapse(values: list[int]) -> tuple[list[int], int]:
        packed = [value for value in values if value]
        merged: list[int] = []
        gained = 0
        i = 0
        while i < len(packed):
            if i + 1 < len(packed) and packed[i] == packed[i + 1]:
                value = packed[i] * 2
                merged.append(value)
                gained += value
                i += 2
            else:
                merged.append(packed[i])
                i += 1
        return merged + [0] * (4 - len(merged)), gained

    def _can_move(self) -> bool:
        if any(0 in row for row in self.board):
            return True
        for r in range(self.size):
            for c in range(self.size):
                value = self.board[r][c]
                if c + 1 < self.size and self.board[r][c + 1] == value:
                    return True
                if r + 1 < self.size and self.board[r + 1][c] == value:
                    return True
        return False

    def move(self, direction: str) -> bool:
        before = [row[:] for row in self.board]
        gained = 0
        if direction in ("left", "right"):
            rows = []
            for row in self.board:
                source = list(reversed(row)) if direction == "right" else row[:]
                result, points = self._collapse(source)
                rows.append(list(reversed(result)) if direction == "right" else result)
                gained += points
            self.board = rows
        else:
            columns = [[self.board[r][c] for r in range(self.size)] for c in range(self.size)]
            moved = []
            for column in columns:
                source = list(reversed(column)) if direction == "down" else column
                result, points = self._collapse(source)
                moved.append(list(reversed(result)) if direction == "down" else result)
                gained += points
            self.board = [[moved[c][r] for c in range(self.size)] for r in range(self.size)]
        if self.board == before:
            self.over = not self._can_move()
            return False
        self.score += gained
        self.won = self.won or any(value >= 2048 for row in self.board for value in row)
        self._spawn()
        self.over = not self._can_move()
        return True

    def handle_key(self, key: str) -> bool:
        direction = self._DIRECTIONS.get(key)
        return self.move(direction) if direction and not self.over else False

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "ARROWS/WASD MOVE · P PAUSE · R RESTART · Q/ESC RETURN"
        tile_width = 7
        board_width = tile_width * self.size + (self.size - 1)
        if width < board_width or height < self.size:
            message = "TERMINAL TOO SMALL — RESIZE OR Q TO RETURN"
            pad_y = max(0, (height - 1) // 2)
            lines = [tuple()] * pad_y + [(Segment(message[:width].center(width), "warn"),)]
            return GameFrame(self.title, f"SCORE {self.score:05d}", tuple(lines), footer,
                             status="WAITING FOR SPACE")
        left = max(0, (width - board_width) // 2)
        top = max(0, (height - self.size) // 2)
        lines: list[tuple[Segment, ...]] = [tuple() for _ in range(top)]
        for row in self.board:
            spans: list[Segment] = [Segment(" " * left)]
            for index, value in enumerate(row):
                if index:
                    spans.append(Segment(" ", "grid"))
                label = str(value) if value else "·"
                role = f"tile-{min(7, value.bit_length() - 1)}" if value else "empty-tile"
                spans.append(Segment(f"{label:^{tile_width}}", role))
            lines.append(tuple(spans))
        status = "NO MOVES · R RESTART" if self.over else ("2048 REACHED" if self.won else "")
        return GameFrame(self.title, f"SCORE {self.score:05d}", tuple(lines), footer,
                         status=status)
