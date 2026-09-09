"""Clean-room terminal paddle rally."""
from __future__ import annotations

import random
import time

from .base import GameFrame
from .drawing import centered, crop_origin


class Paddle:
    key = "paddle"
    title = "PADDLE"
    description = "arcade · rally against the terminal"
    minimum_width = 48
    minimum_height = 10
    board_width = 60
    board_height = 12
    paddle_size = 4
    _INTERVAL = 0.05
    redraw_interval = 0.05

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self.player_y = self.ai_y = (self.board_height - self.paddle_size) // 2
        self.player_score = self.ai_score = 0
        self.over = False
        moment = time.monotonic() if now is None else float(now)
        self._serve(1, moment)

    def _serve(self, direction: int, now: float) -> None:
        self.ball_x = self.board_width / 2
        self.ball_y = self.board_height / 2
        # Move one terminal column per 20 FPS frame. Smaller fractional steps repeatedly
        # round to the same glyph position and look laggy even when the simulation itself is fast.
        self.ball_dx = 1.0 * direction
        self.ball_dy = self._rng.choice((-0.30, -0.22, 0.22, 0.30))
        self._next_tick = now + 0.45

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._INTERVAL

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        if key in ("up", "w"):
            old = self.player_y
            self.player_y = max(0, self.player_y - 2)
            return old != self.player_y
        if key in ("down", "s"):
            old = self.player_y
            self.player_y = min(self.board_height - self.paddle_size, self.player_y + 2)
            return old != self.player_y
        return False

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._INTERVAL
        target = self.ball_y - self.paddle_size / 2
        if target < self.ai_y - 0.2:
            self.ai_y = max(0, self.ai_y - 0.45)
        elif target > self.ai_y + 0.2:
            self.ai_y = min(self.board_height - self.paddle_size, self.ai_y + 0.45)
        nx, ny = self.ball_x + self.ball_dx, self.ball_y + self.ball_dy
        if ny < 0:
            ny = -ny
            self.ball_dy = abs(self.ball_dy)
        elif ny > self.board_height - 1:
            ny = 2 * (self.board_height - 1) - ny
            self.ball_dy = -abs(self.ball_dy)
        if self.ball_dx < 0 and nx <= 2 and self.player_y - 0.5 <= ny <= self.player_y + self.paddle_size - 0.5:
            nx = 2
            self.ball_dx = abs(self.ball_dx) * 1.035
            self.ball_dy += (ny - (self.player_y + self.paddle_size / 2)) * 0.065
        elif self.ball_dx > 0 and nx >= self.board_width - 3 and self.ai_y - 0.5 <= ny <= self.ai_y + self.paddle_size - 0.5:
            nx = self.board_width - 3
            self.ball_dx = -abs(self.ball_dx) * 1.035
            self.ball_dy += (ny - (self.ai_y + self.paddle_size / 2)) * 0.055
        self.ball_x, self.ball_y = nx, ny
        if self.ball_x < 0:
            self.ai_score += 1
            self.over = self.ai_score >= 7
            if not self.over:
                self._serve(1, float(now))
        elif self.ball_x >= self.board_width:
            self.player_score += 1
            self.over = self.player_score >= 7
            if not self.over:
                self._serve(-1, float(now))
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "W/S OR ↑/↓ MOVE · FIRST TO 7 · P PAUSE · R RESET · Q/ESC BACK"
        visible_width = min(self.board_width, max(1, width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(round(self.ball_x), self.board_width, visible_width)
        focus_y = round((self.ball_y + self.player_y + self.paddle_size / 2) / 2)
        y0 = crop_origin(focus_y, self.board_height, visible_height)
        ball = (round(self.ball_x), round(self.ball_y))
        ai_top = round(self.ai_y)
        rows = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(x0, x0 + visible_width):
                if (x, y) == ball:
                    glyph, role = "●", "bright"
                elif x == 1 and self.player_y <= y < self.player_y + self.paddle_size:
                    glyph, role = "▐", "good"
                elif x == self.board_width - 2 and ai_top <= y < ai_top + self.paddle_size:
                    glyph, role = "▌", "accent"
                elif x == self.board_width // 2 and y % 2 == 0:
                    glyph, role = "│", "grid"
                else:
                    glyph, role = " ", "game-floor"
                cells.append((glyph, role))
            rows.append(centered(cells, width))
        status = ("YOU WIN · R REMATCH" if self.over and self.player_score > self.ai_score else
                  "TERMINAL WINS · R REMATCH" if self.over else "")
        return GameFrame(self.title, f"YOU {self.player_score}  ·  {self.ai_score} CPU",
                         tuple(rows), footer, status=status)
