"""Clean-room procedural terminal maze chase."""
from __future__ import annotations

import random

from .base import GameFrame
from .drawing import centered, crop_origin


class MazeRun:
    key = "maze"
    title = "MAZE RUN"
    description = "procedural · collect shards and find the exit"
    minimum_width = 40
    minimum_height = 10
    board_width = 31
    board_height = 11

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
        self.walls = [[True] * self.board_width for _ in range(self.board_height)]
        start = (1, 1)
        self.walls[1][1] = False
        stack = [start]
        while stack:
            x, y = stack[-1]
            choices = []
            for dx, dy in ((0, -2), (0, 2), (-2, 0), (2, 0)):
                nx, ny = x + dx, y + dy
                if (0 < nx < self.board_width - 1 and 0 < ny < self.board_height - 1
                        and self.walls[ny][nx]):
                    choices.append((nx, ny, dx, dy))
            if not choices:
                stack.pop()
                continue
            nx, ny, dx, dy = self._rng.choice(choices)
            self.walls[y + dy // 2][x + dx // 2] = False
            self.walls[ny][nx] = False
            stack.append((nx, ny))
        self.player = start
        self.exit = (self.board_width - 2, self.board_height - 2)
        floors = [(x, y) for y in range(1, self.board_height - 1)
                  for x in range(1, self.board_width - 1)
                  if not self.walls[y][x] and (x, y) not in (start, self.exit)]
        self.shards = set(self._rng.sample(floors, min(9, len(floors))))
        enemy_choices = [pos for pos in floors if pos not in self.shards
                         and abs(pos[0] - 1) + abs(pos[1] - 1) > 12]
        self.enemies = set(self._rng.sample(enemy_choices, min(2, len(enemy_choices))))
        self.collected = 0
        self.steps = 0
        self.over = False
        self.won = False

    def on_resume(self, now: float) -> None:
        del now

    def tick(self, now: float) -> bool:
        del now
        return False

    def _open_neighbors(self, pos: tuple[int, int]) -> list[tuple[int, int]]:
        x, y = pos
        result = []
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
            nx, ny = x + dx, y + dy
            if not self.walls[ny][nx]:
                result.append((nx, ny))
        return result

    def _move_enemies(self) -> None:
        moved: set[tuple[int, int]] = set()
        for enemy in sorted(self.enemies):
            options = [enemy, *self._open_neighbors(enemy)]
            self._rng.shuffle(options)
            options.sort(key=lambda pos: abs(pos[0] - self.player[0])
                         + abs(pos[1] - self.player[1]))
            destination = next((pos for pos in options if pos not in moved), enemy)
            moved.add(destination)
        self.enemies = moved

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        direction = self._DIRECTIONS.get(key)
        if not direction:
            return False
        x, y = self.player
        target = (x + direction[0], y + direction[1])
        if self.walls[target[1]][target[0]]:
            return False
        self.player = target
        self.steps += 1
        if target in self.shards:
            self.shards.remove(target)
            self.collected += 1
        if target == self.exit:
            self.won = self.over = True
            return True
        self._move_enemies()
        if self.player in self.enemies:
            self.over = True
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "ARROWS/WASD MOVE · COLLECT OPTIONAL SHARDS · R RESET · Q/ESC BACK"
        cell_width = 2 if width >= self.board_width * 2 else 1
        visible_width = min(self.board_width, max(1, width // cell_width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(self.player[0], self.board_width, visible_width)
        y0 = crop_origin(self.player[1], self.board_height, visible_height)
        lines = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(x0, x0 + visible_width):
                pos = (x, y)
                if pos == self.player:
                    glyph, role = "◆", "good" if not self.over else "error"
                elif pos in self.enemies:
                    glyph, role = "×", "error"
                elif pos == self.exit:
                    glyph, role = "◈", "bright"
                elif pos in self.shards:
                    glyph, role = "·", "accent"
                elif self.walls[y][x]:
                    glyph, role = "▓", "maze-wall"
                else:
                    glyph, role = " ", "maze-floor"
                cells.append((glyph + " " * (cell_width - 1), role))
            lines.append(centered(cells, width))
        status = "EXIT FOUND" if self.won else ("CAUGHT · R RESTART" if self.over else "")
        return GameFrame(self.title, f"SHARDS {self.collected:02d} · STEPS {self.steps:03d}",
                         tuple(lines), footer, status=status)
