"""Clean-room vector-style terminal space game."""
from __future__ import annotations

import math
import random
import time

from .base import GameFrame
from .drawing import centered, crop_origin


class Orbit:
    key = "orbit"
    title = "ORBIT"
    description = "action · thrust, turn, and clear debris"
    minimum_width = 48
    minimum_height = 10
    board_width = 50
    board_height = 12
    _INTERVAL = 0.08
    _HEADINGS = ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1),
                 (-1, 1), (-1, 0), (-1, -1))
    _SHIP_GLYPHS = ("▲", "◥", "▶", "◢", "▼", "◣", "◀", "◤")

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self.ship_x, self.ship_y = self.board_width / 2, self.board_height / 2
        self.vx = self.vy = 0.0
        self.heading = 0
        self.bullets: list[list[float]] = []
        self.rocks = [self._rock() for _ in range(5)]
        self.score = 0
        self.lives = 3
        self.over = False
        self._fire_cooldown = 0
        self._next_tick = (time.monotonic() if now is None else float(now)) + self._INTERVAL

    def _rock(self, size: int | None = None, x: float | None = None, y: float | None = None):
        if x is None or y is None:
            edge = self._rng.randrange(4)
            if edge < 2:
                x, y = self._rng.randrange(self.board_width), edge * (self.board_height - 1)
            else:
                x, y = (edge - 2) * (self.board_width - 1), self._rng.randrange(self.board_height)
        angle = self._rng.random() * math.tau
        speed = self._rng.uniform(0.16, 0.34)
        return [float(x), float(y), math.cos(angle) * speed, math.sin(angle) * speed,
                float(size or self._rng.choice((1, 1, 2)))]

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._INTERVAL

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        if key in ("left", "a"):
            self.heading = (self.heading - 1) % 8
            return True
        if key in ("right", "d"):
            self.heading = (self.heading + 1) % 8
            return True
        if key in ("up", "w"):
            dx, dy = self._HEADINGS[self.heading]
            self.vx = max(-1.2, min(1.2, self.vx + dx * 0.16))
            self.vy = max(-0.7, min(0.7, self.vy + dy * 0.11))
            return True
        if key in ("down", "s"):
            self.vx *= 0.7
            self.vy *= 0.7
            return True
        if key == "space" and self._fire_cooldown == 0:
            dx, dy = self._HEADINGS[self.heading]
            self.bullets.append([self.ship_x, self.ship_y, dx * 1.6 + self.vx,
                                 dy * 0.85 + self.vy, 22.0])
            self._fire_cooldown = 4
            return True
        return False

    def _distance(self, ax: float, ay: float, bx: float, by: float) -> float:
        dx = min(abs(ax - bx), self.board_width - abs(ax - bx))
        dy = min(abs(ay - by), self.board_height - abs(ay - by))
        return math.hypot(dx, dy)

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._INTERVAL
        self._fire_cooldown = max(0, self._fire_cooldown - 1)
        self.ship_x = (self.ship_x + self.vx) % self.board_width
        self.ship_y = (self.ship_y + self.vy) % self.board_height
        self.vx *= 0.992
        self.vy *= 0.992
        for rock in self.rocks:
            rock[0] = (rock[0] + rock[2]) % self.board_width
            rock[1] = (rock[1] + rock[3]) % self.board_height
        for bullet in self.bullets:
            bullet[0] = (bullet[0] + bullet[2]) % self.board_width
            bullet[1] = (bullet[1] + bullet[3]) % self.board_height
            bullet[4] -= 1
        self.bullets = [bullet for bullet in self.bullets if bullet[4] > 0]
        destroyed: set[int] = set()
        spent: set[int] = set()
        fragments = []
        for bi, bullet in enumerate(self.bullets):
            for ri, rock in enumerate(self.rocks):
                if ri in destroyed:
                    continue
                if self._distance(bullet[0], bullet[1], rock[0], rock[1]) <= rock[4]:
                    destroyed.add(ri)
                    spent.add(bi)
                    size = int(rock[4])
                    self.score += 25 * size
                    if size > 1:
                        fragments.extend((self._rock(1, rock[0], rock[1]),
                                          self._rock(1, rock[0], rock[1])))
                    break
        self.bullets = [bullet for i, bullet in enumerate(self.bullets) if i not in spent]
        self.rocks = [rock for i, rock in enumerate(self.rocks) if i not in destroyed] + fragments
        if any(self._distance(self.ship_x, self.ship_y, rock[0], rock[1]) <= rock[4] + 0.4
               for rock in self.rocks):
            self.lives -= 1
            self.ship_x, self.ship_y = self.board_width / 2, self.board_height / 2
            self.vx = self.vy = 0.0
            self.over = self.lives <= 0
        if not self.rocks and not self.over:
            self.rocks = [self._rock() for _ in range(5)]
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "A/D TURN · W/UP THRUST · S/DOWN BRAKE · SPACE FIRE · R RESET · Q/ESC BACK"
        visible_width = min(self.board_width, max(1, width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(round(self.ship_x), self.board_width, visible_width)
        y0 = crop_origin(round(self.ship_y), self.board_height, visible_height)
        ship = (round(self.ship_x) % self.board_width, round(self.ship_y) % self.board_height)
        rocks = {(round(r[0]) % self.board_width, round(r[1]) % self.board_height): int(r[4])
                 for r in self.rocks}
        bullets = {(round(b[0]) % self.board_width, round(b[1]) % self.board_height)
                   for b in self.bullets}
        rows = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(x0, x0 + visible_width):
                pos = (x, y)
                if pos == ship:
                    glyph, role = self._SHIP_GLYPHS[self.heading], "good"
                elif pos in bullets:
                    glyph, role = "·", "bright"
                elif pos in rocks:
                    glyph, role = "◉" if rocks[pos] > 1 else "○", "warn"
                elif (x * 7 + y * 13) % 43 == 0:
                    glyph, role = "·", "grid"
                else:
                    glyph, role = " ", "game-floor"
                cells.append((glyph, role))
            rows.append(centered(cells, width))
        status = "SHIP LOST · R RESTART" if self.over else ""
        return GameFrame(self.title, f"SCORE {self.score:05d} · SHIPS {self.lives}",
                         tuple(rows), footer, status=status)
