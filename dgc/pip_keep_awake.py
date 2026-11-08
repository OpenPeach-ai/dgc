"""Keep the computer awake for the hour before a routine, when it is plugged in (Pips package 2).

A laptop that sleeps at night misses its 8:00 routine. From an hour before a scheduled routine until a few minutes after
it, the runner holds off sleep: on Linux with ``systemd-inhibit`` (sleep and idle), on macOS with ``caffeinate -s``,
which macOS itself honours only on mains power. On Linux it holds only while the computer is on mains power (or has no
battery at all); on battery it lets the computer sleep as usual. Elsewhere (WSL, where Windows decides) it does nothing.

The hold is a child process with a time limit, so it ends by itself even if the runner is killed; the runner ends it
early when the routine has run, is moved, or the computer goes onto battery. Holding it never fails a routine.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

AHEAD = timedelta(hours=1)
AFTER = timedelta(minutes=10)            # past the due time, so the run has started
CHECK_SECONDS = 60
POWER = Path("/sys/class/power_supply")


def _instant(value) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def next_due(registry, now: datetime) -> datetime | None:
    """The next time a scheduled routine of an active Pip is due, from AFTER ago on. One overdue for longer (a routine that
    can't start, its Claude Code signed out) is not what the computer waits awake for: it hid the next real one (8 Nov)."""
    since = (now - AFTER).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        row = registry.db.execute("""SELECT min(r.next_due_at) FROM pip_routines r JOIN pips p ON p.id=r.pip_id
            WHERE r.status='on' AND p.status='active' AND r.next_due_at IS NOT NULL AND r.next_due_at>=?
            AND json_extract(r.trigger,'$.kind')='schedule'""", (since,)).fetchone()
    except Exception:                    # noqa: BLE001 - a registry from before routines
        return None
    return _instant(row[0]) if row and row[0] else None


def plugged_in(power: Path = POWER) -> bool | None:
    """True on mains power or with no battery, False on battery, None where DGC doesn't hold off sleep."""
    if sys.platform == "darwin":
        return True                      # caffeinate -s applies only on mains power: macOS decides
    if not sys.platform.startswith("linux"):
        return None
    from . import wsl
    if wsl.version():
        return None
    battery = mains = False
    try:
        entries = list(power.iterdir()) if power.is_dir() else []
    except OSError:
        entries = []
    for entry in entries:
        try:
            kind = (entry / "type").read_text().strip()
            online = (entry / "online").read_text().strip() == "1" if (entry / "online").exists() else False
        except OSError:
            continue
        if kind == "Battery":
            battery = True
        elif kind in ("Mains", "USB", "USB_C", "USB_PD") and online:
            mains = True
    return mains or not battery


def hold_argv(seconds: int, why: str, what: str = "sleep:idle") -> list[str] | None:
    """The hold's command. On Linux, ``what`` is what it holds off: sleep and idle where the system allows it (the user's
    own desktop session), idle alone elsewhere (polkit lets any process hold idle, but only an active local session hold
    sleep: a runner started at login as a user service, or over SSH, is refused it)."""
    seconds = max(1, int(seconds))
    if sys.platform == "darwin":
        return ["/usr/bin/caffeinate", "-s", "-t", str(seconds)]
    tool = shutil.which("systemd-inhibit", path="/usr/bin:/bin")
    sleep = shutil.which("sleep", path="/usr/bin:/bin")
    if tool is None or sleep is None:
        return None
    return [tool, f"--what={what}", "--who=DGC", f"--why={why}", "--mode=block", sleep, str(seconds)]


REFUSED_WITHIN = 0.5                     # a refused hold exits at once ("Failed to inhibit: Access denied")


class KeepAwake:
    """Called on every runner heartbeat; looks at most once a minute."""

    def __init__(self, *, clock=time.monotonic, now=lambda: datetime.now(timezone.utc), spawn=None, power=POWER):
        self.clock, self.now, self.power = clock, now, power
        self.spawn = spawn or (lambda argv: subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                              stderr=subprocess.DEVNULL, start_new_session=True))
        self.last = None
        self.proc = None
        self.until = None                # the due time + AFTER the hold covers
        self.what = ""                   # what it holds off: "sleep:idle", or "idle" where sleep was refused

    def holding(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def tick(self, registry) -> bool:
        """Start, keep or end the hold. True while holding."""
        if os.environ.get("DGC_PIP_KEEP_AWAKE", "").strip() == "0":
            self.stop()
            return False
        moment = self.clock()
        if self.last is not None and moment - self.last < CHECK_SECONDS:
            return self.holding()
        self.last = moment
        now = self.now()
        due = next_due(registry, now)
        power = plugged_in(self.power)
        want = due is not None and power is True and due - AHEAD <= now <= due + AFTER
        if not want:
            self.stop()
            return False
        end = due + AFTER
        if self.holding() and self.until == end:
            return True
        self.stop()
        local = due.astimezone()
        seconds, why = int((end - now).total_seconds()) + 1, f"A Pip routine is due at {local.hour}:{local.minute:02d}"
        for what in ("sleep:idle", "idle"):
            argv = hold_argv(seconds, why, what)
            if argv is None:
                return False
            try:
                proc = self.spawn(argv)
            except OSError:
                return False
            if not self._refused(proc):
                self.proc, self.until, self.what = proc, end, what
                return True
            if sys.platform == "darwin":
                return False
        return False

    def _refused(self, proc) -> bool:
        """Whether the system turned the hold down: it exits at once, unsuccessfully."""
        deadline = time.monotonic() + REFUSED_WITHIN
        while time.monotonic() < deadline:
            code = proc.poll()
            if code is not None:
                return code != 0
            time.sleep(0.05)
        return False

    def stop(self) -> None:
        proc, self.proc, self.until, self.what = self.proc, None, None, ""
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                except OSError:
                    pass
