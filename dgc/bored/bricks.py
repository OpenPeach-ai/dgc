"""Clean-room paddle-and-bricks terminal arcade game."""
from __future__ import annotations

import random
import time

from .base import GameFrame
from .drawing import centered, crop_origin


class Bricks:
    key = "bricks"
    title = "BRICKS"
    description = "arcade · rebound through a neon wall"
    minimum_width = 44
    minimum_height = 10
    board_width = 60
    board_height = 12
    paddle_width = 9
    brick_width = 4
    brick_rows = 4
    _INTERVAL = 0.05
    redraw_interval = 0.05

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self.score = 0
        self.lives = 3
        self.level = 1
        self.over = False
        self.bricks = {(row, col) for row in range(self.brick_rows)
                       for col in range(self.board_width // self.brick_width)}
        moment = time.monotonic() if now is None else float(now)
        self._serve(moment)

    def _serve(self, now: float) -> None:
        self.paddle_x = (self.board_width - self.paddle_width) // 2
        self.ball_x = self.board_width / 2
        self.ball_y = self.board_height - 3
        self.ball_dx = self._rng.choice((-0.75, 0.75))
        self.ball_dy = -0.38
        self._next_tick = float(now) + 0.45

    def _new_wall(self, now: float) -> None:
        self.level += 1
        self.bricks = {(row, col) for row in range(self.brick_rows)
                       for col in range(self.board_width // self.brick_width)}
        self._serve(now)

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._INTERVAL

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        if key in ("left", "a"):
            old = self.paddle_x
            self.paddle_x = max(0, self.paddle_x - 3)
            return old != self.paddle_x
        if key in ("right", "d"):
            old = self.paddle_x
            self.paddle_x = min(self.board_width - self.paddle_width, self.paddle_x + 3)
            return old != self.paddle_x
        return False

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._INTERVAL
        nx, ny = self.ball_x + self.ball_dx, self.ball_y + self.ball_dy
        if nx < 0:
            nx = -nx
            self.ball_dx = abs(self.ball_dx)
        elif nx > self.board_width - 1:
            nx = 2 * (self.board_width - 1) - nx
            self.ball_dx = -abs(self.ball_dx)
        if ny < 0:
            ny = -ny
            self.ball_dy = abs(self.ball_dy)
        paddle_y = self.board_height - 2
        if (self.ball_dy > 0 and ny >= paddle_y - 0.4
                and self.paddle_x - 0.5 <= nx <= self.paddle_x + self.paddle_width - 0.5):
            ny = paddle_y - 0.4
            self.ball_dy = -abs(self.ball_dy)
            offset = (nx - (self.paddle_x + self.paddle_width / 2)) / self.paddle_width
            self.ball_dx = max(-1.1, min(1.1, self.ball_dx + offset * 0.35))
        brick = (int(ny), max(0, min(self.board_width - 1, int(nx))) // self.brick_width)
        if brick in self.bricks:
            self.bricks.remove(brick)
            self.score += 10 * self.level
            self.ball_dy = -self.ball_dy
            ny = self.ball_y + self.ball_dy
            if not self.bricks:
                self._new_wall(float(now))
                return True
        self.ball_x, self.ball_y = nx, ny
        if self.ball_y >= self.board_height:
            self.lives -= 1
            self.over = self.lives <= 0
            if not self.over:
                self._serve(float(now))
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "A/D OR ←/→ MOVE · P PAUSE · R RESET · Q/ESC BACK"
        visible_width = min(self.board_width, max(1, width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(round(self.ball_x), self.board_width, visible_width)
        y0 = crop_origin(round(self.ball_y), self.board_height, visible_height)
        ball = (round(self.ball_x), round(self.ball_y))
        paddle_y = self.board_height - 2
        rows = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(x0, x0 + visible_width):
                brick = (y, x // self.brick_width)
                if (x, y) == ball:
                    glyph, role = "●", "bright"
                elif y == paddle_y and self.paddle_x <= x < self.paddle_x + self.paddle_width:
                    glyph, role = "━", "good"
                elif brick in self.bricks:
                    glyph, role = "▀", f"stack-{1 + y % 7}"
                else:
                    glyph, role = "·" if (x * 5 + y * 3) % 41 == 0 else " ", "game-floor"
                cells.append((glyph, role))
            rows.append(centered(cells, width))
        status = "OUT OF ORBITS · R RETRY" if self.over else ""
        return GameFrame(self.title,
                         f"SCORE {self.score:05d} · WALL {self.level:02d} · ORBITS {self.lives}",
                         tuple(rows), footer, status=status)
