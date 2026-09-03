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

    @staticmethod
    def _tile_label(value: int, width: int) -> str:
        if not value:
            return "·"
        label = str(value)
        if len(label) <= width:
            return label
        if value >= 1024 and width >= 2:
            compact = f"{value // 1024}K"
            if len(compact) <= width:
                return compact
        exponent = value.bit_length() - 1
        return (f"^{exponent}" if width >= 2 else str(exponent)[-1])[-width:]

    def _row_spans(self, row: list[int], tile_width: int, *, labels: bool = True) -> list[Segment]:
        spans: list[Segment] = []
        for index, value in enumerate(row):
            if index:
                spans.append(Segment(" ", "grid"))
            label = self._tile_label(value, tile_width) if labels else ""
            role = f"tile-{min(7, value.bit_length() - 1)}" if value else "empty-tile"
            spans.append(Segment(f"{label:^{tile_width}}", role))
        return spans

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "WASD/ARROWS MOVE · P PAUSE · R RESET · Q/ESC BACK"
        # With enough vertical room, tiles get a real two-row surface instead of looking like a
        # coloured spreadsheet. Short split terminals retain the compact row-grouping fallback.
        if height >= 11:
            tile_width = max(3, min(11, (width - (self.size - 1)) // self.size))
            board_width = tile_width * self.size + (self.size - 1)
            left = max(0, (width - board_width) // 2)
            pad = Segment(" " * left)
            board_height = self.size * 2 + (self.size - 1)
            top = max(0, (height - board_height) // 2)
            lines: list[tuple[Segment, ...]] = [tuple() for _ in range(top)]
            for row_index, row in enumerate(self.board):
                lines.append(tuple([pad, *self._row_spans(row, tile_width, labels=False)]))
                lines.append(tuple([pad, *self._row_spans(row, tile_width)]))
                if row_index + 1 < self.size:
                    lines.append(tuple())
            maximum = max(value for row in self.board for value in row)
            status = ("NO MOVES · R RESTART" if self.over else
                      "2048 REACHED" if self.won else "")
            return GameFrame(self.title, f"SCORE {self.score:05d} · MAX {maximum}",
                             tuple(lines), footer, status=status)

        visible_rows = max(1, min(self.size, height))
        base, extra = divmod(self.size, visible_rows)
        group_sizes = [base + (1 if i < extra else 0) for i in range(visible_rows)]
        largest_group = max(group_sizes)
        separator_width = 3 * (largest_group - 1)       # ` │ ` between logical rows
        per_board = max(7, (width - separator_width) // largest_group)
        tile_width = max(1, min(7, (per_board - (self.size - 1)) // self.size))
        board_width = tile_width * self.size + (self.size - 1)
        top = max(0, (height - len(group_sizes)) // 2)
        lines: list[tuple[Segment, ...]] = [tuple() for _ in range(top)]
        row_index = 0
        for group_size in group_sizes:
            total_width = board_width * group_size + 3 * (group_size - 1)
            spans: list[Segment] = [Segment(" " * max(0, (width - total_width) // 2))]
            for group_index in range(group_size):
                if group_index:
                    spans.append(Segment(" │ ", "grid"))
                spans.extend(self._row_spans(self.board[row_index], tile_width))
                row_index += 1
            lines.append(tuple(spans))
        status = "NO MOVES · R RESTART" if self.over else ("2048 REACHED" if self.won else "")
        maximum = max(value for row in self.board for value in row)
        return GameFrame(self.title, f"SCORE {self.score:05d} · MAX {maximum}", tuple(lines), footer,
                         status=status)
