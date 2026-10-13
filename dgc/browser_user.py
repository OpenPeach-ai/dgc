"""The user's own Chrome, signed in as them, for a Work session (the founder, 2026-10-13: "main DGC could use the
logged-in Chrome"; Pips have computers of their own).

Claude Code and Codex reach the user's browser through extensions of their own. DGC needs none: Chrome 144 and later
let the user allow remote debugging of the browser they are running (chrome://inspect/#remote-debugging), and then
ask them, in Chrome, every time a program connects; Chrome shows its "controlled by automated test software" banner
while it is. The running browser writes DevToolsActivePort (its port and path) into its profile folder, which is how
DGC finds it, as Chrome DevTools MCP's --autoConnect does. Chrome 136+ ignores --remote-debugging-port on the user's
own profile, so no command line can do this behind their back.

DGC opens a window of its own there and works in that one tab: it never reads or touches the user's other tabs,
never reads cookies or storage (there is no arbitrary-script operation), and closes its tab when the session ends.
Which sites it may use is the user's call, one site at a time (permissions.py, "signed-in:"), in every mode.
"""
from __future__ import annotations

import os
import socket
import sys
import time
from pathlib import Path

from .browser import BrowserError, BrowserSession, _WebSocket

CONNECT_WAIT = 90.0                      # how long the user has to click Allow in Chrome's dialog

ENABLE = ("Ask the user to turn on remote debugging in the Chrome they use, once: open "
          "chrome://inspect/#remote-debugging in it (Chrome 144 or later) and allow it. Chrome then asks them, each "
          "time DGC connects, whether to allow it.")


def profile_folders() -> list[tuple[str, Path]]:
    """Where each Chromium browser keeps its default profile, most likely first: (name, folder)."""
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support"
        rows = [("Google Chrome", base / "Google" / "Chrome"), ("Google Chrome Beta", base / "Google" / "Chrome Beta"),
                ("Google Chrome Canary", base / "Google" / "Chrome Canary"), ("Microsoft Edge", base / "Microsoft Edge"),
                ("Brave", base / "BraveSoftware" / "Brave-Browser"), ("Chromium", base / "Chromium")]
    elif sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
        rows = [("Google Chrome", local / "Google" / "Chrome" / "User Data"),
                ("Google Chrome Beta", local / "Google" / "Chrome Beta" / "User Data"),
                ("Microsoft Edge", local / "Microsoft" / "Edge" / "User Data"),
                ("Brave", local / "BraveSoftware" / "Brave-Browser" / "User Data"),
                ("Chromium", local / "Chromium" / "User Data")]
    else:
        config = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        rows = [("Google Chrome", config / "google-chrome"), ("Google Chrome Beta", config / "google-chrome-beta"),
                ("Google Chrome Dev", config / "google-chrome-unstable"), ("Microsoft Edge", config / "microsoft-edge"),
                ("Brave", config / "BraveSoftware" / "Brave-Browser"), ("Chromium", config / "chromium")]
    return rows


def active_port(folder: Path) -> tuple[int, str] | None:
    """The port and browser path a running Chrome wrote, when it allows remote debugging; None otherwise."""
    try:
        text = (folder / "DevToolsActivePort").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 2 or not lines[0].isdigit() or not lines[1].startswith("/devtools/browser/"):
        return None
    port = int(lines[0])
    if not 0 < port < 65536 or len(lines[1]) > 200:
        return None
    return port, lines[1]


def find(folders: list[tuple[str, Path]] | None = None) -> tuple[str, int, str]:
    """The user's running Chrome that allows remote debugging: (name, port, path). Raises BrowserError with what to
    ask the user when there is none."""
    seen_file = False
    for name, folder in folders if folders is not None else profile_folders():
        found = active_port(folder)
        if found is None:
            continue
        seen_file = True
        try:
            socket.create_connection(("127.0.0.1", found[0]), timeout=2).close()
        except OSError:
            continue                     # a file left by a Chrome that has quit
        return name, found[0], found[1]
    if seen_file:
        raise BrowserError("The user's Chrome isn't running (or no longer allows remote debugging). Ask them to open "
                           "Chrome, and if it was turned off, to allow it again: " + ENABLE)
    raise BrowserError("DGC can't reach the user's Chrome yet. " + ENABLE)


class UserChromeSession(BrowserSession):
    """One tab, in a window DGC opens in the user's running Chrome: the user's logins, their browser, DGC's tab."""

    signed_in = True

    def __init__(self, folders=None):
        super().__init__(Path("user-chrome"))
        self.folders = folders
        self.browser_name = ""
        self.allowed_hosts: set[str] = set()     # the sites the user allowed this session (opened through permission)
        self._target_id = ""

    def start(self) -> None:
        if self._ws is not None:
            return
        self.browser_name, port, path = find(self.folders)
        try:
            # Chrome asks the user before it lets DGC in: the connection waits for their Allow.
            self._ws = _WebSocket(f"ws://127.0.0.1:{port}{path}", timeout=CONNECT_WAIT)
            self._session_id = ""
            created = self.command("Target.createTarget", {"url": "about:blank", "newWindow": True}, timeout=CONNECT_WAIT)
            self._target_id = str(created.get("targetId") or "")
            attached = self.command("Target.attachToTarget", {"targetId": self._target_id, "flatten": True})
            self._session_id = str(attached.get("sessionId") or "")
            if not self._target_id or not self._session_id:
                raise BrowserError("Chrome opened no tab for DGC")
            for domain in ("Page", "Runtime", "Log", "Network"):
                self.command(f"{domain}.enable")
        except (BrowserError, OSError) as error:
            self._cleanup()
            name = self.browser_name or "Chrome"
            # Measured with Chrome 155 (2026-10-13): Chrome holds the connection until the user answers its "Allow remote
            # debugging?" dialog; Cancel answers 403 Forbidden.
            if "websocket upgrade" in str(error) and "403" in str(error):
                raise BrowserError(f"The user said no in {name} (they chose Cancel when Chrome asked). Carry on without "
                                   "their Chrome; ask them first if this task really needs it.") from None
            if isinstance(error, (socket.timeout, TimeoutError)) or "timed out" in str(error):
                raise BrowserError(f"Nobody answered {name}'s \"Allow remote debugging?\" in time. Ask the user whether "
                                   "they want DGC to use their Chrome, and to click Allow when Chrome asks.") from None
            if isinstance(error, ConnectionRefusedError) or "closed the connection" in str(error):
                raise BrowserError(f"{name} isn't running, or remote debugging was turned off. Ask the user to open Chrome, "
                                   "and if it was turned off: " + ENABLE) from None
            raise BrowserError(f"DGC couldn't use the user's Chrome: {error}") from None

    def _cleanup(self) -> None:
        """Close DGC's own tab and the connection. The user's browser, and every other tab in it, stay as they were."""
        if self._ws is not None:
            if self._target_id:
                self._session_id = ""
                try:
                    # Tabs its page opened (target=_blank, window.open) are DGC's too: closed with it. Only their opener
                    # is looked at; the user's tabs are left as they are.
                    infos = [i for i in (self.command("Target.getTargets", timeout=5).get("targetInfos") or [])
                             if i.get("type") == "page"]
                    mine, grew = {self._target_id}, True
                    while grew:                    # and the tabs those opened, however deep
                        found = {i.get("targetId") for i in infos if i.get("openerId") in mine} - mine
                        grew = bool(found)
                        mine |= found
                    for target in mine - {self._target_id}:
                        self.command("Target.closeTarget", {"targetId": target}, timeout=5)
                except Exception:          # noqa: BLE001
                    pass
                try:
                    self.command("Target.closeTarget", {"targetId": self._target_id}, timeout=5)
                except Exception:          # noqa: BLE001 -- the tab may already be gone
                    pass
            try:
                self._ws.close()
            except Exception:              # noqa: BLE001
                pass
        self._ws, self._target_id, self._session_id = None, "", ""
        self._proc, self._profile = None, ""
