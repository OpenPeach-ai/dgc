"""Clean-room fixed-screen terminal space defense game."""
from __future__ import annotations

import random
import time

from .base import GameFrame
from .drawing import centered, crop_origin


class SpaceRaid:
    key = "raid"
    title = "SPACE RAID"
    description = "arcade · defend the prompt line"
    minimum_width = 44
    minimum_height = 10
    board_width = 44
    board_height = 12
    _INTERVAL = 0.08

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self.score = 0
        self.lives = 3
        self.wave = 1
        self.over = False
        self.player_x = self.board_width // 2
        self.player_bullets: list[list[int]] = []
        self.enemy_bullets: list[list[int]] = []
        self._ticks = 0
        self._fire_cooldown = 0
        self._reset_wave()
        self._next_tick = (time.monotonic() if now is None else float(now)) + self._INTERVAL

    def _reset_wave(self) -> None:
        self.enemies = {(row, col) for row in range(3) for col in range(8)}
        self.formation_x = 2
        self.formation_y = 1
        self.formation_dx = 1
        self.player_bullets.clear()
        self.enemy_bullets.clear()

    def _enemy_position(self, enemy: tuple[int, int]) -> tuple[int, int]:
        row, col = enemy
        return self.formation_x + col * 5, self.formation_y + row * 2

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._INTERVAL

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        if key in ("left", "a"):
            old = self.player_x
            self.player_x = max(1, self.player_x - 2)
            return old != self.player_x
        if key in ("right", "d"):
            old = self.player_x
            self.player_x = min(self.board_width - 2, self.player_x + 2)
            return old != self.player_x
        if key in ("space", "up", "w") and self._fire_cooldown == 0:
            self.player_bullets.append([self.player_x, self.board_height - 2])
            self._fire_cooldown = 4
            return True
        return False

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._INTERVAL
        self._ticks += 1
        self._fire_cooldown = max(0, self._fire_cooldown - 1)
        if self._ticks % max(2, 5 - min(3, self.wave // 2)) == 0:
            positions = [self._enemy_position(enemy) for enemy in self.enemies]
            next_left = min((x for x, _ in positions), default=1) + self.formation_dx
            next_right = max((x for x, _ in positions), default=self.board_width - 2) + self.formation_dx
            if next_left <= 0 or next_right >= self.board_width - 1:
                self.formation_dx *= -1
                self.formation_y += 1
            else:
                self.formation_x += self.formation_dx
        for bullet in self.player_bullets:
            bullet[1] -= 1
        for bullet in self.enemy_bullets:
            bullet[1] += 1
        if self.enemies and self._ticks % max(8, 20 - self.wave) == 0:
            lowest: dict[int, tuple[int, int]] = {}
            for enemy in self.enemies:
                if enemy[0] > lowest.get(enemy[1], (-1, -1))[0]:
                    lowest[enemy[1]] = enemy
            shooter = self._rng.choice(list(lowest.values()))
            x, y = self._enemy_position(shooter)
            self.enemy_bullets.append([x, y + 1])
        positions = {self._enemy_position(enemy): enemy for enemy in self.enemies}
        hit_enemies = {positions[(x, y)] for x, y in self.player_bullets if (x, y) in positions}
        if hit_enemies:
            self.enemies.difference_update(hit_enemies)
            self.score += 20 * len(hit_enemies) * self.wave
        self.player_bullets = [[x, y] for x, y in self.player_bullets
                               if y >= 0 and (x, y) not in positions]
        player_y = self.board_height - 1
        hits = sum(y >= player_y and abs(x - self.player_x) <= 1
                   for x, y in self.enemy_bullets)
        if hits:
            self.lives -= hits
            self.over = self.lives <= 0
        self.enemy_bullets = [[x, y] for x, y in self.enemy_bullets
                              if y < player_y and not (y >= player_y and abs(x - self.player_x) <= 1)]
        if any(y >= player_y - 1 for _, y in positions):
            self.lives = 0
            self.over = True
        if not self.enemies and not self.over:
            self.wave += 1
            self._reset_wave()
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "A/D OR ←/→ MOVE · SPACE/W/UP FIRE · P PAUSE · R RESET · Q/ESC BACK"
        visible_width = min(self.board_width, max(1, width))
        visible_height = min(self.board_height, max(1, height))
        x0 = crop_origin(self.player_x, self.board_width, visible_width)
        y0 = max(0, self.board_height - visible_height)
        enemies = {self._enemy_position(enemy) for enemy in self.enemies}
        player_bullets = {tuple(bullet) for bullet in self.player_bullets}
        enemy_bullets = {tuple(bullet) for bullet in self.enemy_bullets}
        player = (self.player_x, self.board_height - 1)
        rows = []
        for y in range(y0, y0 + visible_height):
            cells = []
            for x in range(x0, x0 + visible_width):
                pos = (x, y)
                if pos == player:
                    glyph, role = "▲", "good" if not self.over else "error"
                elif pos in enemies:
                    glyph, role = "▼", "accent"
                elif pos in player_bullets:
                    glyph, role = "│", "bright"
                elif pos in enemy_bullets:
                    glyph, role = "·", "warn"
                elif y == self.board_height - 1:
                    glyph, role = "·", "grid"
                else:
                    glyph, role = " ", "game-floor"
                cells.append((glyph, role))
            rows.append(centered(cells, width))
        status = "PROMPT OVERRUN · R RESTART" if self.over else ""
        return GameFrame(self.title,
                         f"SCORE {self.score:05d} · WAVE {self.wave:02d} · SHIPS {self.lives}",
                         tuple(rows), footer, status=status)
