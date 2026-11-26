"""DGC Browser for a Work session (0.52; decided 26 Nov: "we need work sessions to get access to it", so a person can
say "use the DGC browser" in Work as in a Pip's chat).

A Work session gets one tab of its own in DGC Browser, the person's own Google Chrome where they are signed in, through
the same ``dgc_browser`` tool and the same lane a Pip's run has (dgc_browser_lane): its tab only, its sites only, no
password ever typed, every page untrusted, its tab seen in the dock's Watch. What differs from a Pip:

- Its sites are the ones the person allowed THIS session: opening a site is what asks them, in every mode (Work's own
  permission card: Allow once, Always allow for that site, Deny; permissions.py "dgc-browser:"), and the session sends
  the supervisor the sites allowed so far with each step. Anything else is refused by the lane gate, as for a Pip.
- Writes on those sites go, as Work's signed-in browser does; a payment, or anything sent on a bank or payment site,
  is never sent by a Work session: the step says what wasn't sent, and the person does that part themselves in DGC
  Browser (a Work chat has no card to approve a payment). A form that would send a password is never sent: the person
  signs in themselves, in DGC Browser.
- DGC Browser belongs to the Pips supervisor (its DevTools are a pipe only the supervisor holds, never a port). A Work
  session asks for its tab through the Pips registry (ASK), the supervisor answers with a private socket and token for
  that tab (PIN), as DGC Browser's view socket is published. Pips off: the session says so, and how to start them.

The supervisor side is ``tick`` (from dgc_browser.tick) and ``WorkLane``; the session side is ``step``.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from . import dgc_browser, pip_computer
from .dgc_browser_lane import LaneHost, LaneSocket, sends_password

ASK = "dgc_browser_work:"          # metadata, one per session: {session, name, workspace_id, sites, at}
PIN = "dgc_browser_work_pin:"      # metadata, one per session: the supervisor's answer {socket, token, at}
OWNER = "work:"                    # a Work session's lane owner in DGC Browser ("work:<session id>"), never a Pip's id
IDLE_SECONDS = 30 * 60             # a session that asked nothing for this long gives its tab back
PIN_WAIT = 12.0                    # how long a session waits for its tab on its first step (the supervisor ticks every 2 s)
MAX_SITES = 200

NOT_SENT = ("Not sent: this would pay, or send something on a bank or payment site, and a Work session never does "
            "that in DGC Browser. Nothing was sent. Tell the user in a sentence what you were about to send, so they "
            "can do that part themselves in DGC Browser.")
PASSWORD_NOT_SENT = ("Not sent: that form would send a password, and DGC never types or sends one for the user. Tell the "
                     "user to sign in to {site} themselves in DGC Browser (the dock's DGC Browser), then carry on once "
                     "they say they have.")
SITE_NOT_ALLOWED = ("Not opened: {host} isn't one of the sites the user let this session use in DGC Browser ({sites}). "
                    "To use it, call dgc_browser with op open and its address: DGC asks the user first.")
NOT_A_SITE = ("Not opened: {host} isn't a site on the web, and DGC Browser never opens anything on this computer or "
              "the local network.")
SIGN_IN = ("The user signs in to {site} themselves, in DGC Browser (the dock's DGC Browser): you never see, type or ask "
           "for a password or a code. Stop now and tell them in a sentence to sign in there, then carry on once they "
           "say they have.")
PIPS_OFF = ("DGC Browser runs with Pips, and Pips aren't running on this computer. Tell the user in a sentence: start "
            "Pips (the Pips tab's Start Pips), then ask again.")
UNAVAILABLE = ("DGC Browser can't run on this computer (it needs Google Chrome with its own sandbox): {why}. Tell the "
               "user in a sentence.")


def owner_of(session_id: str) -> str:
    return OWNER + str(session_id)


def is_work(owner) -> bool:
    return isinstance(owner, str) and owner.startswith(OWNER)


# --------------------------------------------------------------------------- the supervisor's side

class WorkLane(LaneHost):
    """A Work session's tab in DGC Browser: a Pip's lane, with the session's sites, its writes as Work's signed-in
    browser sends them, and what a Pip's chat would show as a card said in the step's reply instead."""

    def __init__(self, state_directory, session_id: str, workspace_id: str, name: str = "", *, yb=None):
        super().__init__(state_directory, owner_of(session_id), workspace_id, yb=yb)
        self.session_id = session_id
        self.work_sites: tuple[str, ...] = ()
        self.title_name(name)

    def title_name(self, name: str) -> None:
        """Its tab's title says whose it is ("Work · Fix the totals"), as a Pip's says its name."""
        words = " ".join(str(name or "").split())[:50]
        self.name = f"Work · {words}" if words else "Work"
        browser = self.yb.browser
        if browser is not None:
            browser.lane_names[self.pip_id] = self.name

    def _read_grants(self):
        return dgc_browser.Grants(self.work_sites)

    def _site_card(self, host: str, url: str) -> str:
        if not dgc_browser.site_key(host):
            return NOT_A_SITE.format(host=host or "that address")
        return SITE_NOT_ALLOWED.format(host=host, sites=self.grants.words())

    def _sign_in_card(self, args: dict, page: str = "") -> str:
        from urllib.parse import urlsplit
        wanted = str(args.get("site") or "").strip()
        if not page:
            browser = self.yb.browser                  # (its own tab's address, as a Pip's lane reads it)
            if browser is not None and self.front and browser.infos.get(self.front):
                page = str(browser.infos[self.front].get("url") or "")
        host = (urlsplit(wanted if "//" in wanted else "https://" + wanted).hostname or "") if wanted else \
            (urlsplit(page if page.startswith(("https://", "http://")) else "").hostname or "")
        site = dgc_browser.site_key(host)
        if not site:
            return "error: give site, the address of the site that needs the user signed in (such as example.com)."
        return SIGN_IN.format(site=site)

    # Its writes: its run's level is Do it all (tick's add_run), so what Do it all would send by itself goes;
    # LaneHost._level_approves holds what is or may be a payment, and anything on a bank or payment site, at every
    # level, and Host._may_pay finds no daily limit for a Work session's lane (it isn't a Pip), so none is ever paid.
    # What is held is never sent and never waits on a card (no hourly fuse either: that is for a Pip on its own).
    def _record_held(self) -> list[str]:
        from urllib.parse import urlsplit
        notes = []
        while self._queued:
            held = self._queued.pop(0)
            if held.request_id not in self.browser.held:
                continue
            if sends_password(held):
                self.browser.drop(held.request_id)
                self._back_from_drop()
                site = dgc_browser.site_key(urlsplit(held.url).hostname or "") or "that site"
                notes.append(PASSWORD_NOT_SENT.format(site=site))
                continue
            approval = self._level_approves(held)
            if approval is not None and self._release_by_level(held, approval):
                continue
            self.browser.drop(held.request_id)
            self._back_from_drop()
            notes.append(NOT_SENT)
        if notes:
            self.card_note = "\n".join(dict.fromkeys(notes))
        return []


class _Served:
    """One session's tab and its socket, in the supervisor."""

    def __init__(self, lane: WorkLane, sock: LaneSocket, run_id: str):
        self.lane, self.socket, self.run_id = lane, sock, run_id


SERVED: dict[str, _Served] = {}
_LOCK = threading.Lock()


def _read(value) -> dict:
    try:
        said = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return said if isinstance(said, dict) else {}


def tick(registry) -> None:
    """In the supervisor, every heartbeat: each Work session that asked for its tab has one, confined to the sites it
    sent, and its socket's address is published for it; one that asked nothing for IDLE_SECONDS gives it back."""
    rows = registry.db.execute("SELECT key, value FROM metadata WHERE key LIKE ?", (ASK + "%",)).fetchall()
    now = time.time()
    wanted: dict[str, dict] = {}
    stale = []
    for key, value in rows:
        ask = _read(value)
        session = str(key)[len(ASK):]
        at = ask.get("at")
        if not session or not isinstance(at, (int, float)) or now - at > IDLE_SECONDS:
            stale.append(session)
            continue
        wanted[session] = ask
    if stale:
        with registry.transaction():
            for session in stale:
                registry.db.execute("DELETE FROM metadata WHERE key IN (?,?)", (ASK + session, PIN + session))
    with _LOCK:
        for session in [s for s in SERVED if s not in wanted]:
            _give_back(SERVED.pop(session))
    if not wanted:
        return
    host = dgc_browser.host_for(registry.directory)
    published = {}
    for session, ask in wanted.items():
        with _LOCK:
            served = SERVED.get(session)
            if served is not None and served.lane.yb is not host:
                _give_back(SERVED.pop(session))           # (DGC Browser started again: a tab and socket of the new one)
                served = None
            if served is None:
                served = _serve(registry, session, ask, host)
                if served is None:
                    continue
                SERVED[session] = served
        served.lane.work_sites = tuple(str(s) for s in (ask.get("sites") or [])[:MAX_SITES] if isinstance(s, str))
        served.lane.title_name(str(ask.get("name") or ""))
        pin = {**served.socket.pin(), "at": now}
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (PIN + session,)).fetchone()
        old = _read(row[0]) if row is not None else {}
        if old.get("socket") != pin["socket"] or old.get("token") != pin["token"]:
            published[session] = pin
    if published:
        with registry.transaction():
            for session, pin in published.items():
                registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (PIN + session, json.dumps(pin)))


def _serve(registry, session: str, ask: dict, host) -> _Served | None:
    workspace = str(ask.get("workspace_id") or "")
    if not workspace or registry.db.execute("SELECT 1 FROM workspaces WHERE id=?", (workspace,)).fetchone() is None:
        return None                                          # (its project isn't one the registry knows: no tab)
    lane = WorkLane(registry.directory, session, workspace, str(ask.get("name") or ""), yb=host)
    run_id = "work-" + session[-24:]
    frames = Path(registry.directory) / dgc_browser.FOLDER / "work" / session[-24:]
    lane.add_run(run_id, frames, label="a Work session", level="full", user_turn=True)
    return _Served(lane, LaneSocket(lane, run_id), run_id)


def _give_back(served: _Served) -> None:
    try:
        served.socket.close()
    finally:
        served.lane.end(served.run_id)
        served.lane.yb.close_lane(served.lane.pip_id)
        from .dgc_browser_lane import LANES, _LANES_LOCK
        with _LANES_LOCK:
            if LANES.get(served.lane.pip_id) is served.lane:
                LANES.pop(served.lane.pip_id, None)
        served.lane.yb.lane_users.pop(served.lane.pip_id, None)


def forget_all() -> None:
    """(Tests: every session's tab given back.)"""
    with _LOCK:
        served = list(SERVED.values())
        SERVED.clear()
    for one in served:
        try:
            _give_back(one)
        except Exception:                                   # noqa: BLE001 - tests only
            pass


# --------------------------------------------------------------------------- a Work session's side

def _runner_online(registry) -> bool:
    """Whether the Pips supervisor (which holds DGC Browser) is running; True when it can't tell."""
    try:
        from .pip_daemon import runner_status
        state = runner_status(registry)
    except Exception:                                       # noqa: BLE001 - can't tell: try
        return True
    return bool(state.get("online", True)) if isinstance(state, dict) else True


def closed(state_directory) -> str:
    """Why DGC Browser can't open a page for a Work session right now, in words for the model, or "" when it can (or
    when it can't tell). The agent checks this before the site card: live on 26 Nov, "Use example.com in DGC Browser?"
    was asked with Pips off, the user allowed it, and the step then said Pips aren't running. Creates nothing."""
    try:
        available, why = dgc_browser._availability()[:2]
    except Exception:                                       # noqa: BLE001 - a check that can't run: ask as before
        available = True
    if available is not True:
        return UNAVAILABLE.format(why=str(why or "it isn't set up here").rstrip("."))
    try:
        if not (Path(state_directory) / "registry.sqlite3").is_file():
            return PIPS_OFF                                 # (Pips have never run here: no registry yet)
        from .workspace_registry import WorkspaceRegistry
        with WorkspaceRegistry(state_directory) as registry:
            return "" if _runner_online(registry) else PIPS_OFF
    except Exception:                                       # noqa: BLE001 - can't tell: ask as before
        return ""


def ask(state_directory, session_id: str, *, name: str, workspace_id: str, sites) -> None:
    """Say (again) that this session uses its tab, with the sites the person allowed it so far."""
    from .workspace_registry import WorkspaceRegistry
    body = {"session": session_id, "name": " ".join(str(name or "").split())[:80], "workspace_id": workspace_id,
            "sites": sorted({s for s in (dgc_browser.site_key(x) for x in sites) if s})[:MAX_SITES], "at": time.time()}
    with WorkspaceRegistry(state_directory) as registry:
        with registry.transaction():
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (ASK + session_id, json.dumps(body)))


def _pin(state_directory, session_id: str) -> dict | None:
    from .workspace_registry import WorkspaceRegistry
    with WorkspaceRegistry(state_directory) as registry:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (PIN + session_id,)).fetchone()
    pin = _read(row[0]) if row is not None else {}
    return pin if isinstance(pin.get("socket"), str) and isinstance(pin.get("token"), str) else None


def step(state_directory, session_id: str, op: str, args: dict, *, name: str, workspace_id: str, sites,
         wait: float = PIN_WAIT, clock=time.monotonic, sleep=time.sleep) -> dict:
    """One dgc_browser step for a Work session: its ask refreshed (the sites allowed so far), its tab's socket found (the
    supervisor makes it within a heartbeat or two), the step sent. {text} and, for look, {image, width, height}.
    Never raises."""
    from .workspace_registry import RegistryError, WorkspaceRegistry
    available, why = True, ""
    try:
        available, why = dgc_browser._availability()[:2]
    except Exception:                                       # noqa: BLE001 - a check that can't run: try anyway
        available = True
    if available is not True:
        return {"text": UNAVAILABLE.format(why=str(why or "it isn't set up here").rstrip("."))}
    try:
        ask(state_directory, session_id, name=name, workspace_id=workspace_id, sites=sites)
        with WorkspaceRegistry(state_directory) as registry:
            online = _runner_online(registry)
    except (OSError, RegistryError) as error:
        return {"text": f"error: DGC Browser couldn't be asked for your tab ({str(error)[:200]})."}
    if not online:
        return {"text": PIPS_OFF}
    deadline = clock() + max(0.0, wait)
    tried = set()
    while True:
        try:
            pin = _pin(state_directory, session_id)
        except (OSError, RegistryError):
            pin = None
        if pin is not None and (pin["socket"], pin["token"]) not in tried:
            reply = pip_computer.worker_reply(pin, op, args if isinstance(args, dict) else {})
            gone = str(reply.get("text", "")).startswith("error:") and not Path(pin["socket"]).exists()
            if not gone:
                return reply
            tried.add((pin["socket"], pin["token"]))           # (a supervisor that started again publishes a new one)
        if clock() >= deadline:
            return {"text": PIPS_OFF if pin is None else "error: DGC Browser didn't answer. Try that step again."}
        sleep(0.5)
