"""Clean-room simulated process-defense game; it never inspects or signals real processes."""
from __future__ import annotations

import random
import time
from dataclasses import dataclass

from .base import GameFrame, Segment
from .drawing import crop_origin


@dataclass
class SimProcess:
    pid: int
    name: str
    cpu: int
    runaway: bool


class ProcessDefender:
    key = "process"
    title = "PROCESS DEFENDER"
    description = "reaction · stop simulated runaway jobs"
    minimum_width = 42
    minimum_height = 7
    process_count = 7
    _INTERVAL = 0.16
    _SAFE_NAMES = ("indexer", "renderer", "lsp-core", "test-run", "watcher", "cache-db")
    _ROGUE_NAMES = ("spinloop", "fork-storm", "leakd", "rogue-job", "zombie")

    def __init__(self, *, seed: int | None = None) -> None:
        self._seed = seed
        self._rng = random.Random(seed)
        self.restart()

    def restart(self, now: float | None = None) -> None:
        self._rng = random.Random(self._seed)
        self._next_pid = 4100
        self.processes = [self._make_process(runaway=index in (2, 5))
                          for index in range(self.process_count)]
        self.cursor = 0
        self.score = 0
        self.integrity = 3
        self.streak = 0
        self.over = False
        self.note = "FIND THE RUNAWAYS"
        self._next_tick = (time.monotonic() if now is None else float(now)) + self._INTERVAL

    def _make_process(self, *, runaway: bool | None = None) -> SimProcess:
        if runaway is None:
            runaway = self._rng.random() < 0.34
        self._next_pid += self._rng.randint(3, 23)
        names = self._ROGUE_NAMES if runaway else self._SAFE_NAMES
        cpu = self._rng.randint(28, 52) if runaway else self._rng.randint(1, 16)
        return SimProcess(self._next_pid, self._rng.choice(names), cpu, runaway)

    def _replace(self, index: int) -> None:
        # Keep at least one visible threat so a cleared board never becomes an idle waiting screen.
        other_runaways = sum(proc.runaway for i, proc in enumerate(self.processes) if i != index)
        self.processes[index] = self._make_process(runaway=True if not other_runaways else None)

    def on_resume(self, now: float) -> None:
        self._next_tick = float(now) + self._INTERVAL

    def handle_key(self, key: str) -> bool:
        if self.over:
            return False
        if key in ("up", "w"):
            self.cursor = (self.cursor - 1) % len(self.processes)
            return True
        if key in ("down", "s"):
            self.cursor = (self.cursor + 1) % len(self.processes)
            return True
        if key in ("space", "k", "enter"):
            process = self.processes[self.cursor]
            if process.runaway:
                self.streak += 1
                self.score += 75 + process.cpu + self.streak * 10
                self.note = f"STOPPED {process.pid} · STREAK {self.streak}"
            else:
                self.integrity -= 1
                self.streak = 0
                self.note = f"FALSE POSITIVE · {process.name} WAS HEALTHY"
                self.over = self.integrity <= 0
            if not self.over:
                self._replace(self.cursor)
            return True
        return False

    def tick(self, now: float) -> bool:
        if self.over or now < self._next_tick:
            return False
        self._next_tick = float(now) + self._INTERVAL
        breached = []
        for index, process in enumerate(self.processes):
            if process.runaway:
                process.cpu = min(100, process.cpu + self._rng.randint(3, 8))
                if process.cpu >= 100:
                    breached.append(index)
            else:
                process.cpu = max(0, min(35, process.cpu + self._rng.randint(-3, 3)))
        for index in breached:
            self.integrity -= 1
            self.streak = 0
            self.note = f"CPU BREACH · PID {self.processes[index].pid}"
            if self.integrity > 0:
                self._replace(index)
        self.over = self.integrity <= 0
        return True

    @staticmethod
    def _bar(cpu: int, width: int) -> str:
        filled = max(0, min(width, round(cpu / 100 * width)))
        return "█" * filled + "░" * (width - filled)

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "W/S OR ↑/↓ SELECT · K/SPACE/ENTER STOP · P PAUSE · R RESET · Q/ESC BACK"
        visible = min(len(self.processes), max(1, height))
        y0 = crop_origin(self.cursor, len(self.processes), visible)
        lines = []
        for index in range(y0, y0 + visible):
            process = self.processes[index]
            hot = index == self.cursor
            state = "RUNAWAY" if process.runaway else "HEALTHY"
            state_role = "error" if process.runaway else "good"
            prefix = Segment("❯ " if hot else "  ", "accent" if hot else "text")
            if width >= 58:
                bar_width = max(8, min(20, width - 42))
                segments = [
                    prefix,
                    Segment(f"{process.pid:05d}  ", "muted-data"),
                    Segment(f"{process.name:<12.12} ", "strong" if hot else "text"),
                    Segment(self._bar(process.cpu, bar_width),
                            "process-hot" if process.runaway else "process-cool"),
                    Segment(f" {process.cpu:3d}%  ", "warn" if process.cpu >= 70 else "text"),
                    Segment(state, state_role),
                ]
            else:
                segments = [prefix, Segment(f"{process.pid:05d} ", "muted-data"),
                            Segment(f"{process.name:<10.10} ", "strong" if hot else "text"),
                            Segment(f"{process.cpu:3d}% ", "warn" if process.cpu >= 70 else "text"),
                            Segment("RUN" if process.runaway else "OK", state_role)]
            lines.append(tuple(segments))
        # Ordinary feedback belongs inside the playfield so it does not replace the controls in
        # the shared footer.  Very short panes favor the process rows and controls over the note.
        if not self.over and height > visible:
            lines.append((Segment(f"  {self.note}", "muted-data"),))
        status = "KERNEL PANIC · R RESTART" if self.over else ""
        return GameFrame(self.title,
                         f"SCORE {self.score:05d} · INTEGRITY {'◆' * max(0, self.integrity)}",
                         tuple(lines), footer, status=status)
