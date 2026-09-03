"""Clean-room terminal Snake mechanics and renderer."""
from __future__ import annotations

import random
import time
from collections import deque

from .base import GameFrame, Segment


class ByteSnake:
    key = "snake"
    title = "BYTE SNAKE"
    description = "real-time · arrows or WASD"
    minimum_width = 48
    minimum_height = 9
    board_width = 42
    board_height = 7
    _BASE_INTERVAL = 0.13

    _DIRECTIONS = {
        "up": (0, -1), "w": (0, -1),
        "down": (0, 1), "s": (0, 1),
        "left": (-1, 0), "a": (-1, 0),
        "right": (1, 0), "d": (1, 0),
    }

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        cy = self.board_height // 2
        cx = self.board_width // 2
        self.snake = deque([(cx, cy), (cx - 1, cy), (cx - 2, cy), (cx - 3, cy)])
        self.direction = (1, 0)
        self.pending_direction = (1, 0)
        self.food = self._spawn_food()
        self.score = 0
        self.over = False
        self._next_tick = (time.monotonic() if now is None else float(now)) + self._interval()

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._interval()

    def _interval(self) -> float:
        return max(0.075, self._BASE_INTERVAL - min(self.score, 180) * 0.00025)

    def _spawn_food(self) -> tuple[int, int] | None:
        occupied = set(self.snake)
        open_cells = [(x, y) for y in range(self.board_height)
                      for x in range(self.board_width) if (x, y) not in occupied]
        return self._rng.choice(open_cells) if open_cells else None

    def handle_key(self, key: str) -> bool:
        direction = self._DIRECTIONS.get(key)
        if direction is None:
            return False
        # Compare with the committed direction so two keys between ticks cannot reverse through an
        # intermediate turn and collide into the neck.
        if direction[0] == -self.direction[0] and direction[1] == -self.direction[1]:
            return False
        changed = direction != self.pending_direction
        self.pending_direction = direction
        return changed

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._interval()  # never fast-forward after a hidden pane
        self.direction = self.pending_direction
        hx, hy = self.snake[0]
        dx, dy = self.direction
        head = hx + dx, hy + dy
        growing = head == self.food
        body = set(self.snake if growing else tuple(self.snake)[:-1])
        if (head[0] < 0 or head[0] >= self.board_width
                or head[1] < 0 or head[1] >= self.board_height or head in body):
            self.over = True
            return True
        self.snake.appendleft(head)
        if growing:
            self.score += 10
            self.food = self._spawn_food()
            if self.food is None:
                self.over = True
        else:
            self.snake.pop()
        return True

    @staticmethod
    def _runs(chars: list[tuple[str, str]]) -> tuple[Segment, ...]:
        result: list[Segment] = []
        for char, role in chars:
            if result and result[-1].role == role:
                previous = result[-1]
                result[-1] = Segment(previous.text + char, role)
            else:
                result.append(Segment(char, role))
        return tuple(result)

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "ARROWS/WASD MOVE · P PAUSE · R RESTART · Q/ESC RETURN"
        if width < self.board_width or height < self.board_height:
            message = "TERMINAL TOO SMALL — RESIZE OR Q TO RETURN"
            pad_y = max(0, (height - 1) // 2)
            lines = [tuple()] * pad_y + [(Segment(message[:width].center(width), "warn"),)]
            return GameFrame(self.title, f"SCORE {self.score:04d}", tuple(lines), footer,
                             status="WAITING FOR SPACE")
        snake = set(self.snake)
        head = self.snake[0]
        left = max(0, (width - self.board_width) // 2)
        top = max(0, (height - self.board_height) // 2)
        lines: list[tuple[Segment, ...]] = [tuple() for _ in range(top)]
        for y in range(self.board_height):
            cells: list[tuple[str, str]] = [(" " * left, "text")]
            for x in range(self.board_width):
                pos = (x, y)
                if pos == head:
                    cells.append(("◆", "good" if not self.over else "error"))
                elif pos in snake:
                    cells.append(("●", "accent"))
                elif pos == self.food:
                    cells.append(("◇", "bright"))
                elif x % 6 == 0 and y % 2 == 0:
                    cells.append(("·", "grid"))
                else:
                    cells.append((" ", "text"))
            lines.append(self._runs(cells))
        status = "GAME OVER · R RESTART" if self.over else ""
        return GameFrame(self.title, f"SCORE {self.score:04d}", tuple(lines), footer,
                         status=status)
