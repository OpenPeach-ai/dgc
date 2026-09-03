"""Clean-room terminal mine-clearing puzzle."""
from __future__ import annotations

import random
from collections import deque

from .base import GameFrame
from .drawing import centered, crop_origin


class Mines:
    key = "mines"
    title = "MINES"
    description = "logic · reveal safely and flag hazards"
    minimum_width = 32
    minimum_height = 9
    board_width = 12
    board_height = 9
    mine_count = 14

    _DIRECTIONS = {
        "up": (0, -1), "w": (0, -1), "down": (0, 1), "s": (0, 1),
        "left": (-1, 0), "a": (-1, 0), "right": (1, 0), "d": (1, 0),
    }

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        del now
        self._rng = random.Random(self._seed)
        self.cursor = (self.board_width // 2, self.board_height // 2)
        self.mines: set[tuple[int, int]] = set()
        self.flags: set[tuple[int, int]] = set()
        self.revealed: set[tuple[int, int]] = set()
        self._placed = False
        self.over = False
        self.won = False

    def on_resume(self, now: float) -> None:
        del now

    def tick(self, now: float) -> bool:
        del now
        return False

    def _neighbors(self, pos: tuple[int, int]):
        px, py = pos
        for y in range(max(0, py - 1), min(self.board_height, py + 2)):
            for x in range(max(0, px - 1), min(self.board_width, px + 2)):
                if (x, y) != pos:
                    yield x, y

    def _place(self, first: tuple[int, int]) -> None:
        excluded = {first, *self._neighbors(first)}
        choices = [(x, y) for y in range(self.board_height) for x in range(self.board_width)
                   if (x, y) not in excluded]
        self.mines = set(self._rng.sample(choices, min(self.mine_count, len(choices))))
        self._placed = True

    def _count(self, pos: tuple[int, int]) -> int:
        return sum(neighbor in self.mines for neighbor in self._neighbors(pos))

    def _reveal(self, start: tuple[int, int]) -> bool:
        if start in self.flags or start in self.revealed:
            return False
        if not self._placed:
            self._place(start)
        if start in self.mines:
            self.revealed.update(self.mines)
            self.over = True
            return True
        queue = deque([start])
        while queue:
            pos = queue.popleft()
            if pos in self.revealed or pos in self.flags or pos in self.mines:
                continue
            self.revealed.add(pos)
            if self._count(pos) == 0:
                queue.extend(self._neighbors(pos))
        safe = self.board_width * self.board_height - len(self.mines)
        self.won = len(self.revealed) == safe
        self.over = self.won
        return True

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        direction = self._DIRECTIONS.get(key)
        if direction:
            x, y = self.cursor
            nx = max(0, min(self.board_width - 1, x + direction[0]))
            ny = max(0, min(self.board_height - 1, y + direction[1]))
            changed = (nx, ny) != self.cursor
            self.cursor = (nx, ny)
            return changed
        if key in ("enter", "space"):
            return self._reveal(self.cursor)
        if key == "f" and self.cursor not in self.revealed:
            if self.cursor in self.flags:
                self.flags.remove(self.cursor)
            elif len(self.flags) < self.mine_count:
                self.flags.add(self.cursor)
            return True
        return False

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "ARROWS/WASD MOVE · ENTER REVEAL · F FLAG · R RESET · Q/ESC BACK"
        cell_width = 2 if width >= 28 else 1
        visible_width = min(self.board_width, max(1, width // cell_width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(self.cursor[0], self.board_width, visible_width)
        y0 = crop_origin(self.cursor[1], self.board_height, visible_height)
        lines = []
        for y in range(y0, y0 + visible_height):
            cells: list[tuple[str, str]] = []
            for x in range(x0, x0 + visible_width):
                pos = (x, y)
                if pos in self.revealed and pos in self.mines:
                    glyph, role = "✹", "error"
                elif pos in self.revealed:
                    count = self._count(pos)
                    glyph, role = (str(count), f"mine-{min(count, 4)}") if count else ("·", "mine-open")
                elif pos in self.flags:
                    glyph, role = "⚑", "warn"
                else:
                    glyph, role = "■", "mine-hidden"
                if pos == self.cursor and not self.over:
                    role = "board-cursor"
                cells.append((glyph + " " * (cell_width - 1), role))
            lines.append(centered(cells, width))
        safe_left = self.board_width * self.board_height - self.mine_count - len(self.revealed)
        status = "FIELD CLEARED" if self.won else ("MINE HIT · R RESTART" if self.over else "")
        return GameFrame(self.title, f"SAFE {max(0, safe_left):02d} · FLAGS {len(self.flags):02d}",
                         tuple(lines), footer, status=status)
