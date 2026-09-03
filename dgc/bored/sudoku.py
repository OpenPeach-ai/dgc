"""Clean-room terminal Sudoku board."""
from __future__ import annotations

from .base import GameFrame, Segment
from .drawing import centered, crop_origin


class Sudoku:
    key = "sudoku"
    title = "SUDOKU"
    description = "logic · arrows, digits, and delete"
    minimum_width = 34
    minimum_height = 9

    _PUZZLE = (
        "530070000", "600195000", "098000060", "800060003", "400803001",
        "700020006", "060000280", "000419005", "000080079",
    )
    _SOLUTION = (
        "534678912", "672195348", "198342567", "859761423", "426853791",
        "713924856", "961537284", "287419635", "345286179",
    )
    _DIRECTIONS = {
        "up": (0, -1), "w": (0, -1), "down": (0, 1), "s": (0, 1),
        "left": (-1, 0), "a": (-1, 0), "right": (1, 0), "d": (1, 0),
    }

    def __init__(self, *, seed: int | None = None) -> None:
        del seed
        self.restart()

    def restart(self, now: float | None = None) -> None:
        del now
        self.board = [[int(char) for char in row] for row in self._PUZZLE]
        self.givens = {(r, c) for r in range(9) for c in range(9) if self.board[r][c]}
        self.cursor = (0, 0)
        self.complete = False

    def on_resume(self, now: float) -> None:
        del now

    def tick(self, now: float) -> bool:
        del now
        return False

    def _invalid(self, row: int, col: int) -> bool:
        value = self.board[row][col]
        if not value:
            return False
        if sum(self.board[row][c] == value for c in range(9)) > 1:
            return True
        if sum(self.board[r][col] == value for r in range(9)) > 1:
            return True
        r0, c0 = (row // 3) * 3, (col // 3) * 3
        return sum(self.board[r][c] == value for r in range(r0, r0 + 3)
                   for c in range(c0, c0 + 3)) > 1

    def handle_key(self, key: str) -> bool:
        direction = self._DIRECTIONS.get(key)
        if direction:
            row, col = self.cursor
            target = ((row + direction[1]) % 9, (col + direction[0]) % 9)
            changed = target != self.cursor
            self.cursor = target
            return changed
        row, col = self.cursor
        if (row, col) in self.givens:
            return False
        if key in tuple(str(number) for number in range(1, 10)):
            self.board[row][col] = int(key)
        elif key in ("0", "backspace", "delete"):
            if self.board[row][col] == 0:
                return False
            self.board[row][col] = 0
        else:
            return False
        self.complete = all(str(self.board[r][c]) == self._SOLUTION[r][c]
                            for r in range(9) for c in range(9))
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "ARROWS/WASD MOVE · 1–9 SET · BACKSPACE CLEAR · R RESET · Q/ESC BACK"
        roomy = height >= 11 and width >= 31
        visible_rows = 9 if roomy else min(9, max(1, height))
        y0 = crop_origin(self.cursor[0], 9, visible_rows)
        lines: list[tuple[Segment, ...]] = []
        for row in range(y0, y0 + visible_rows):
            cells: list[tuple[str, str]] = []
            for col in range(9):
                if col in (3, 6):
                    cells.append(("│", "grid"))
                value = self.board[row][col]
                role = "sudoku-given" if (row, col) in self.givens else "sudoku-user"
                if self._invalid(row, col):
                    role = "error"
                if (row, col) == self.cursor:
                    role = "board-cursor"
                cells.append((f" {value or '·'} ", role))
            lines.append(centered(cells, width))
            if roomy and row in (2, 5):
                lines.append(centered([("─────────┼─────────┼─────────", "grid")], width))
        filled = sum(bool(value) for row in self.board for value in row)
        errors = sum(self._invalid(r, c) for r in range(9) for c in range(9))
        status = "PUZZLE COMPLETE" if self.complete else (f"{errors} CONFLICTS" if errors else "")
        return GameFrame(self.title, f"FILLED {filled:02d}/81", tuple(lines), footer, status=status)
