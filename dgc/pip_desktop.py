"""Desktop notifications from the runner: a new alert, or something waiting for your review.

The operating system shows them (notify-send on Linux, Notification Center on macOS, and Windows' own
notifications for DGC inside WSL, where Linux has no notification service), so they reach you with the
editor closed. Each alert and each review is announced once: what was already
announced is remembered in the registry, so a restarted runner does not repeat itself. At most one
notification a minute. On by default; `dgc pips desktop-notifications off`, or the switch in the
Pips view, turns it off at once (the runner reads the setting from the registry on every check).

A notification failing to show (no notification service on a server, say) is never an error: the
digest and the Pips view still have everything.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

SETTING_KEY = "desktop_notifications"
SEEN_KEY = "desktop_notifications_seen"
LAST_KEY = "desktop_notifications_last"     # whether the last one actually showed: evidence, not a guess
CHECK_SECONDS = 60
MAX_SEEN = 400
TITLE = "DGC Pips"


def enabled(registry) -> bool:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (SETTING_KEY,)).fetchone()
    return row is None or row[0] != "off"


def set_enabled(registry, value, actor) -> dict:
    from .workspace_registry import RegistryError
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "Desktop notifications are set on this computer only.")
    if not isinstance(value, bool):
        raise RegistryError("invalid_request", "Choose on or off.")
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SETTING_KEY, "on" if value else "off"))
    return status(registry)


def status(registry) -> dict:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (LAST_KEY,)).fetchone()
    last = None
    if row:
        try:
            value = json.loads(row[0])
            if isinstance(value, dict) and isinstance(value.get("shown"), bool) and isinstance(value.get("at"), str):
                last = {"shown": value["shown"], "at": value["at"][:40]}
        except ValueError:
            pass
    return {"on": enabled(registry), "available": available(), "platform": sys.platform, "last": last}


def available() -> bool:
    if sys.platform.startswith("linux"):
        from . import wsl
        if wsl.version() and wsl.windows_program("powershell.exe") is not None:
            return True
        return _which("notify-send") is not None
    return sys.platform == "darwin"


def _which(name):
    return shutil.which(name, path="/usr/bin:/bin:/usr/local/bin")


def deliver(title: str, body: str) -> bool:
    """Show one notification. True when the system took it."""
    title, body = _plain(title, 120), _plain(body, 400)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "C.UTF-8"}
    if sys.platform.startswith("linux"):
        from . import wsl
        if wsl.version() and wsl.windows_program("powershell.exe") is not None and wsl.notify(title, body):
            return True                       # inside WSL: Windows shows it
        tool = _which("notify-send")
        if tool is None:
            return False
        bus = os.environ.get("DBUS_SESSION_BUS_ADDRESS")
        socket = Path(f"/run/user/{os.getuid()}/bus")
        if not bus and socket.exists():
            bus = f"unix:path={socket}"       # a systemd user service has no session variables
        if bus:
            env["DBUS_SESSION_BUS_ADDRESS"] = bus
        argv = [tool, "--app-name=DGC", title, body]
    elif sys.platform == "darwin":
        # The text goes in as arguments, never into the script, so nothing in it is AppleScript.
        argv = ["/usr/bin/osascript", "-e", "on run argv", "-e",
                "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]
    else:
        return False
    try:
        done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=5, env=env)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0


def _plain(text, limit):
    text = "".join(ch if ch.isprintable() else " " for ch in str(text))
    return " ".join(text.split())[:limit]


class Notifier:
    """Called on every runner heartbeat; does real work at most once a minute."""

    def __init__(self, config, *, clock=time.monotonic, send=deliver):
        self.config, self.clock, self.send = config, clock, send
        self.last = None

    def tick(self, registry) -> str | None:
        now = self.clock()
        if self.last is not None and now - self.last < CHECK_SECONDS:
            return None
        self.last = now
        alerts, headline = self._alerts(registry)
        quiet = self._quiet(registry)
        reviews = self._reviews(registry, quiet)
        from .pip_action_grants import ran_on_their_own
        ran = ran_on_their_own(registry)
        finished, asking = self._personal(registry, quiet)
        blocked = self._blocked(registry, quiet)
        seen = self._seen(registry)
        new_alerts = [i for i in alerts if i not in seen["alerts"]]
        new_reviews = [i for i in reviews if i not in seen["reviews"]]
        new_ran = [(i, said) for i, said in ran if i not in seen["ran"]]
        new_finished = [(i, said) for i, said in finished if i not in seen["finished"]]
        new_asking = [(i, said) for i, said in asking if i not in seen["asking"]]
        new_blocked = [(i, said) for i, said in blocked if i not in seen["blocked"]]
        if not new_alerts and not new_reviews and not new_ran and not new_finished and not new_asking and not new_blocked:
            return None
        shown, body = False, None
        # While off, what arrives is still marked seen, so turning it on later announces only
        # what is new from then, never a backlog.
        if enabled(registry):
            if new_alerts:
                body = headline
            elif new_blocked:
                # A scheduled Pip that can't run here: once per episode, never every retry.
                body = new_blocked[0][1] + (f" And {len(new_blocked) - 1} more." if len(new_blocked) > 1 else "")
            elif new_ran:
                # Something a Pip did on its own: say what, so it is never a surprise.
                body = new_ran[0][1] + (f" And {len(new_ran) - 1} more." if len(new_ran) > 1 else "")
            elif new_finished:
                # A routine it ran by itself is done: what it said, as Grok's bots do.
                body = new_finished[0][1] + (f" And {len(new_finished) - 1} more." if len(new_finished) > 1 else "")
            elif new_asking:
                body = new_asking[0][1] + (f" And {len(new_asking) - 1} more." if len(new_asking) > 1 else "")
            else:
                count = len(reviews)
                body = f"{count} review{'' if count == 1 else 's'} waiting for you. Open the Pips view to decide."
            shown = self.send(TITLE, body)
        # Remembered even when the system could not show it: it is not retried every minute.
        seen["alerts"] = (seen["alerts"] + new_alerts)[-MAX_SEEN:]
        seen["reviews"] = (seen["reviews"] + new_reviews)[-MAX_SEEN:]
        seen["ran"] = (seen["ran"] + [i for i, _ in new_ran])[-MAX_SEEN:]
        seen["finished"] = (seen["finished"] + [i for i, _ in new_finished])[-MAX_SEEN:]
        seen["asking"] = (seen["asking"] + [i for i, _ in new_asking])[-MAX_SEEN:]
        seen["blocked"] = (seen["blocked"] + [i for i, _ in new_blocked])[-MAX_SEEN:]
        with registry.transaction():
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SEEN_KEY, json.dumps(seen)))
            if body is not None:
                from datetime import datetime, timezone
                from .pip_schedules import timestamp
                registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                    (LAST_KEY, json.dumps({"shown": bool(shown), "at": timestamp(datetime.now(timezone.utc))})))
        return body if shown else None

    def _alerts(self, registry):
        from . import pip_digest
        digest = pip_digest.build(registry, self.config)
        if not digest or digest.get("reason") != "alert":
            return [], ""
        ids = [f"{f['run_id']}:{f['finding_index']}" for item in digest["pips"] if item["alert"]
               for f in item["new_findings"]]
        return ids, digest["headline"]

    def _blocked(self, registry, quiet=frozenset()):
        """Scheduled Pips whose runs keep failing to start: [(id, sentence)], one id per episode."""
        from .pip_schedules import blocked_schedules
        try:
            return [(f"blocked:{item['pip_id']}:{item['since']}", item["said"])
                    for item in blocked_schedules(registry) if item["pip_id"] not in quiet]
        except Exception:
            return []                     # a registry from before this record, or one being upgraded

    def _quiet(self, registry) -> set:
        """Pips whose page says not to notify you."""
        try:
            return {row[0] for row in registry.db.execute("SELECT pip_id FROM pip_profiles WHERE notify=0")}
        except Exception:
            return set()

    def _personal(self, registry, quiet):
        """A Personal Pip finished a routine on its own, or needs you (a routine or an app to say yes to,
        a robot check on its computer): [(id, sentence)] each, newest first."""
        def name(definition):
            try:
                return str(json.loads(definition).get("name") or "Your Pip")[:60]
            except ValueError:
                return "Your Pip"
        finished, asking = [], []
        try:
            for message_id, pip_id, text, definition in registry.db.execute(
                    "SELECT a.id,a.pip_id,a.text,v.definition FROM pip_chat_messages a "
                    "JOIN pip_chat_messages u ON u.run_id=a.run_id AND u.role='user' "
                    "JOIN pips p ON p.id=a.pip_id JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
                    "WHERE a.role='assistant' AND u.request_key LIKE 'routine\\_%' ESCAPE '\\' ORDER BY a.seq DESC LIMIT 20"):
                if pip_id not in quiet:
                    finished.append(("chat:" + message_id, f"{name(definition)}: {_plain(text, 160)}"))
            for routine_id, pip_id, title, definition in registry.db.execute(
                    "SELECT r.id,r.pip_id,r.title,v.definition FROM pip_routines r JOIN pips p ON p.id=r.pip_id "
                    "JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
                    "WHERE r.status='suggested' ORDER BY r.created_at DESC LIMIT 20"):
                if pip_id not in quiet:
                    asking.append(("routine:" + routine_id, f"{name(definition)} suggests a routine: {_plain(title, 80)}. Add it in its chat."))
            for link_id, pip_id, toolkit, definition in registry.db.execute(
                    "SELECT l.id,l.pip_id,l.toolkit,v.definition FROM pip_app_links l JOIN pips p ON p.id=l.pip_id "
                    "JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
                    "WHERE l.status='requested' ORDER BY l.created_at DESC LIMIT 20"):
                if pip_id not in quiet:
                    from .pip_app_links import app_name
                    asking.append(("app:" + link_id, f"{name(definition)} asks to use {app_name(toolkit)}. Answer in its chat."))
            for key, value in registry.db.execute("SELECT key,value FROM metadata WHERE key LIKE 'computer_needs_you:%'"):
                pip_id = key.split(":", 1)[1]
                row = registry.db.execute("SELECT v.definition FROM pips p JOIN pip_versions v ON v.pip_id=p.id "
                                          "AND v.version=p.current_version WHERE p.id=?", (pip_id,)).fetchone()
                if row is not None and pip_id not in quiet:
                    asking.append(("check:" + pip_id + ":" + _plain(value, 80),
                                   f"{name(row[0])} needs you on its computer: a check that it can't do for you."))
        except Exception:
            pass                          # a registry from before these tables
        return finished, asking

    def _reviews(self, registry, quiet=frozenset()):
        from .pip_overview import pending_reviews
        from .pip_schedules import timestamp
        from datetime import datetime, timezone
        ids = [item["id"] for item in pending_reviews(registry, limit=20)["reviews"]]
        now = timestamp(datetime.now(timezone.utc))
        ids += ["setup:" + row[0] for row in registry.db.execute(
            "SELECT id FROM pip_setup_proposals WHERE status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 20",
            (now,)).fetchall()]
        for table in ("pip_message_drafts", "pip_calendar_drafts", "pip_connector_drafts"):
            ids += ["draft:" + row[0] for row in registry.db.execute(
                f"SELECT id,pip_id FROM {table} WHERE status='pending' AND expires_at>? AND actor LIKE 'pip-%' "
                "ORDER BY created_at DESC LIMIT 20", (now,)).fetchall() if row[1] not in quiet]
        return ids

    def _seen(self, registry):
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (SEEN_KEY,)).fetchone()
        try:
            value = json.loads(row[0]) if row else {}
        except ValueError:
            value = {}
        return {"alerts": [i for i in value.get("alerts", []) if isinstance(i, str)],
                "reviews": [i for i in value.get("reviews", []) if isinstance(i, str)],
                "ran": [i for i in value.get("ran", []) if isinstance(i, str)],
                "finished": [i for i in value.get("finished", []) if isinstance(i, str)],
                "asking": [i for i in value.get("asking", []) if isinstance(i, str)],
                "blocked": [i for i in value.get("blocked", []) if isinstance(i, str)]}
