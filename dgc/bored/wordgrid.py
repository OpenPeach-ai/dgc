"""Clean-room five-letter deduction game."""
from __future__ import annotations

import random

from .base import GameFrame
from .drawing import centered


class WordGrid:
    key = "wordgrid"
    title = "WORD GRID"
    description = "words · six tries, five letters"
    minimum_width = 30
    minimum_height = 6
    text_input = True
    _WORDS = ("CACHE", "PATCH", "STACK", "SHELL", "TOKEN", "ARRAY", "BYTES", "LINUX",
              "MODEL", "TOOLS", "QUERY", "REACT", "SWIFT", "CRATE", "CLOUD", "DEBUG")

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        del now
        self._rng = random.Random(self._seed)
        self.secret = self._rng.choice(self._WORDS)
        self.guesses: list[str] = []
        self.current = ""
        self.won = False
        self.over = False

    def on_resume(self, now: float) -> None:
        del now

    def tick(self, now: float) -> bool:
        del now
        return False

    def _roles(self, guess: str) -> list[str]:
        roles = ["word-absent"] * 5
        remaining: dict[str, int] = {}
        for index, char in enumerate(self.secret):
            if guess[index] == char:
                roles[index] = "word-exact"
            else:
                remaining[char] = remaining.get(char, 0) + 1
        for index, char in enumerate(guess):
            if roles[index] == "word-exact":
                continue
            if remaining.get(char, 0):
                roles[index] = "word-present"
                remaining[char] -= 1
        return roles

    def handle_key(self, key: str) -> bool:
        if self.over:
            if key == "enter":
                self.restart()
                return True
            return False
        if len(key) == 1 and "a" <= key <= "z" and len(self.current) < 5:
            self.current += key.upper()
            return True
        if key in ("backspace", "delete") and self.current:
            self.current = self.current[:-1]
            return True
        if key == "enter" and len(self.current) == 5:
            guess = self.current
            self.guesses.append(guess)
            self.current = ""
            self.won = guess == self.secret
            self.over = self.won or len(self.guesses) >= 6
            return True
        return False

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "TYPE LETTERS · ENTER SUBMIT · BACKSPACE ERASE · ESC BACK"
        rows = []
        for index in range(6):
            if index < len(self.guesses):
                word = self.guesses[index]
                roles = self._roles(word)
            elif index == len(self.guesses):
                word = self.current.ljust(5, "·")
                roles = ["word-input"] * 5
            else:
                word = "·" * 5
                roles = ["word-empty"] * 5
            cells = []
            for col, char in enumerate(word):
                if col:
                    cells.append((" ", "text"))
                cells.append((f" {char} ", roles[col]))
            rows.append(centered(cells, width))
        visible = rows[:max(1, min(6, height))]
        status = ("SOLVED · ENTER AGAIN" if self.won else
                  f"WORD WAS {self.secret} · ENTER AGAIN" if self.over else "")
        return GameFrame(self.title, f"TRY {min(6, len(self.guesses) + 1)}/6",
                         tuple(visible), footer, status=status)
