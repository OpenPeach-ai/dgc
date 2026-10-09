"""Careful mode: a Personal Pip that both reads your apps and has a computer can't quietly carry what it read
out to a website (OpenAI's "safe URL" and Google's agent rules, for Pips).

On by default for every Pip with a computer; only you turn it off, on its page. While it is on:

- **New sites ask.** The first time the Pip's browser goes to a site (its registrable domain, like
  ``amazon.in``), its chat shows "Let Ava visit amazon.in?". Sites you named in your own messages, the
  computer's home page, and sites you opened on its screen yourself never ask. Allow adds the site for good.
- **What it read from your apps is yours to send.** Text the Pip types into a page, an option it picks, an
  address it opens and a Terminal command are checked against what it read from your apps (emails, events,
  plugin answers) in the last day. Carrying any of it out is held for your Allow, like a form it submits.
- **Unattended runs that read your apps get no computer.** A routine, schedule or event run of a Pip that can
  read your apps runs without its computer, since nobody is watching what it would carry where.

Everything here runs in the supervisor, which the Pip's own process can't reach: the worker only ever sees
"Held:" in a tool's answer. Approving lets the Pip do it once (the site stays allowed); it retries itself.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .workspace_registry import RegistryError, utc_now

OFF = "computer_careful_off:"           # metadata: careful mode turned off for this Pip
SITES = "computer_sites:"               # metadata: the sites this Pip may visit, JSON
MAX_SITES = 300
UNATTENDED = ("local-routine", "local-scheduler", "local-event-trigger")
LOCAL = ("editor-user", "local-console")
TAINT_SECONDS = 24 * 3600
MAX_HELD_TEXT = 4000                  # a careful hold shows the whole text it holds, up to this
ALLOWED_SECONDS = 30 * 60
MAX_TAINT_FEATURES = 200_000
SHINGLE = 5                             # words in a row that count as carrying text across
# Second-level public suffixes common enough to matter, and hosting suffixes whose subdomains are
# different owners. A built-in list keeps this offline. A host under a shared hosting suffix is a site
# of its own (each AWS bucket, each App Engine app); an unlisted ccTLD's com/co/net/org/gov/edu/ac level
# counts as part of the suffix (com.ua, co.th), so two owners there never share a site.
SUFFIXES = frozenset("""co.uk org.uk ac.uk gov.uk com.au net.au org.au co.in net.in org.in gov.in ac.in co.jp ne.jp or.jp
co.nz com.br com.mx com.ar com.tr com.sg com.hk com.tw com.cn co.za co.kr co.il com.my co.id com.ph com.vn com.pk
com.sa com.eg com.ng co.ke github.io gitlab.io vercel.app netlify.app pages.dev workers.dev herokuapp.com
web.app firebaseapp.com fly.dev onrender.com glitch.me repl.co ngrok.io ngrok-free.app""".split())
# Any host under these is a site of its own: each one is a different owner's (an AWS bucket, an App
# Engine app, a GitHub Pages site).
SHARED_HOSTING = ("amazonaws.com", "cloudfront.net", "appspot.com", "googleusercontent.com", "windows.net",
                  "azurewebsites.net", "azureedge.net", "blogspot.com", "wordpress.com", "web.app", "firebaseapp.com",
                  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "herokuapp.com",
                  "fly.dev", "onrender.com", "glitch.me", "repl.co", "ngrok.io", "ngrok-free.app", "r2.dev",
                  "digitaloceanspaces.com", "googleapis.com", "translate.goog")
# Hosts where anyone publishes (a Google Apps Script, Form, Doc or Site): each is its own site, never google.com.
USER_CONTENT_HOSTS = frozenset({"script.google.com", "docs.google.com", "sites.google.com", "drive.google.com",
                                "forms.gle", "colab.research.google.com", "storage.googleapis.com", "1drv.ms",
                                "onedrive.live.com", "dropbox.com", "www.dropbox.com", "pastebin.com"})
GENERIC_SECOND = frozenset("com co net org gov edu ac or ne go mil nic sch ltd plc".split())
# Pre-allowed exact hosts (never their whole domain): the computer's home page. script.google.com or a
# Google Form on another host of the same domain still asks.
def _exact_allowed() -> frozenset:
    from .pip_computer_box import HOME_PAGE
    return frozenset({(urlsplit(HOME_PAGE).hostname or "").lower()})


def site_of(host: str) -> str:
    """The registrable domain: shop.amazon.in -> amazon.in, shop.com.ua as itself; a host on shared hosting
    (a.b.github.io, a bucket on amazonaws.com) or a user-content host (script.google.com) as its whole
    name; an IP as itself."""
    host = str(host or "").strip().strip(".").lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    labels = [label for label in host.split(".") if label]
    joined = ".".join(labels)
    if joined in USER_CONTENT_HOSTS or any(joined.endswith("." + shared) for shared in SHARED_HOSTING):
        return joined
    if len(labels) <= 2:
        return joined
    take = 3 if (".".join(labels[-2:]) in SUFFIXES or (len(labels[-1]) == 2 and labels[-2] in GENERIC_SECOND)) else 2
    return ".".join(labels[-take:])


def allowed(host: str, sites) -> bool:
    """Whether careful mode lets the Pip's browser (or Terminal) reach this host without asking."""
    host = str(host or "").strip().strip(".").lower()
    return host in _exact_allowed() or site_of(host) in set(sites)


def shown_host(host: str) -> str:
    """How the card names a host: an internationalised name also in its xn-- form, so a look-alike shows."""
    host = str(host or "").lower()
    try:
        ascii_name = host.encode("idna").decode("ascii")
    except UnicodeError:
        return host
    return host if ascii_name == host else f"{host} ({ascii_name})"


# --------------------------------------------------------------------------- the switch and the sites

def is_on(registry, pip_id) -> bool:
    return registry.db.execute("SELECT 1 FROM metadata WHERE key=?", (OFF + pip_id,)).fetchone() is None


def set_on(registry, pip_id, on, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you change careful mode, on this computer.")
    if type(on) is not bool:
        raise RegistryError("invalid_request", "Turn careful mode on or off.")
    _personal(registry, pip_id)
    with registry.transaction():
        if on:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (OFF + pip_id,))
        else:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (OFF + pip_id, utc_now()))
        registry.event(_personal(registry, pip_id), "pip_careful_changed", pip_id=pip_id, payload={"on": on, "actor": actor})
    return listing(registry, pip_id)


def _personal(registry, pip_id) -> str:
    row = registry.db.execute("SELECT p.workspace_id FROM pips p JOIN workspaces w ON w.id=p.workspace_id "
                              "WHERE p.id=? AND w.kind='personal'", (pip_id,)).fetchone() if isinstance(pip_id, str) else None
    if row is None:
        raise RegistryError("not_found", "Careful mode belongs to a Personal Pip.")
    return row["workspace_id"]


def _sites(registry, pip_id) -> list[dict]:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (SITES + pip_id,)).fetchone()
    try:
        value = json.loads(row["value"]) if row else []
    except ValueError:
        value = []
    return [s for s in value if isinstance(s, dict) and isinstance(s.get("site"), str)] if isinstance(value, list) else []


def add_site(registry, pip_id, site, by) -> None:
    site = site_of(site)
    if not site:
        return
    with registry.transaction():
        sites = [s for s in _sites(registry, pip_id) if s["site"] != site]
        sites.insert(0, {"site": site, "at": utc_now(), "by": by})
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SITES + pip_id, json.dumps(sites[:MAX_SITES])))


def forget_site(registry, pip_id, site, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you change the sites a Pip may visit, on this computer.")
    _personal(registry, pip_id)
    with registry.transaction():
        sites = [s for s in _sites(registry, pip_id) if s["site"] != site_of(site)]
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SITES + pip_id, json.dumps(sites)))
    return listing(registry, pip_id)


def listing(registry, pip_id) -> dict:
    _personal(registry, pip_id)
    return {"pip_id": pip_id, "careful": is_on(registry, pip_id), "sites": _sites(registry, pip_id)[:MAX_SITES]}


URL_IN_TEXT = re.compile(r"(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,24})(?=[/:?#\s)\]>,.;!'\"]|$)", re.I)


def user_sites(registry, pip_id) -> set[str]:
    """Sites the user named in their own messages to this Pip (DGC's own turns don't count)."""
    from .pip_chat import DGC_KEYS
    found = set()
    for row in registry.db.execute("SELECT text,request_key FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                   "ORDER BY seq DESC LIMIT 300", (pip_id,)):
        if str(row["request_key"] or "").startswith(DGC_KEYS):
            continue
        for match in URL_IN_TEXT.finditer(str(row["text"] or "")):
            name = match.group(1).lower()
            if "." in name and not name.replace(".", "").isdigit():
                found.add(site_of(name))
    return found


def known(registry, pip_id) -> set[str]:
    """The sites the Pip may visit: the ones you allowed and the ones you named (see `allowed` for the home page)."""
    return {s["site"] for s in _sites(registry, pip_id)} | user_sites(registry, pip_id)


# --------------------------------------------------------------------------- what it read from your apps

def _norm(text) -> str:
    return " ".join(unquote(str(text or "")).replace("+", " ").casefold().split())


def features(text) -> set[str]:
    """What carrying text across looks like: email addresses, long numbers, long tokens, runs of words."""
    flat = _norm(text)
    out = set(re.findall(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", flat))
    out |= {"#" + d for d in re.findall(r"(?<!\d)\d{6,}(?!\d)", re.sub(r"[ -]", "", flat))}
    out |= {"~" + t for t in re.findall(r"[a-z0-9_-]{16,}", flat)}
    words = re.findall(r"[a-z0-9']+", flat)
    out |= {" ".join(words[i:i + SHINGLE]) for i in range(max(0, len(words) - SHINGLE + 1))}
    return out


class Taint:
    """What one Pip read from your apps in the last day: hashed features only (never the text), kept on
    disk beside its other state so a closed computer or a restarted runner forgets nothing. The oldest
    go first past the cap; a full record never stops recording."""

    def __init__(self, path=None):
        self._lock = threading.Lock()
        self._path = Path(path) if path else None
        self._seen: dict[str, float] = {}         # feature digest -> when it was read (wall clock)
        self._allowed: dict[str, float] = {}      # text digest -> until when the user allowed it
        if self._path is not None:
            try:
                saved = json.loads(self._path.read_text(encoding="utf-8"))
                self._seen = {k: float(v) for k, v in (saved.get("seen") or {}).items()}
                self._allowed = {k: float(v) for k, v in (saved.get("allowed") or {}).items()}
            except (OSError, ValueError, TypeError, AttributeError):
                pass

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temp = self._path.with_suffix(".tmp")
            temp.write_text(json.dumps({"seen": self._seen, "allowed": self._allowed}), encoding="utf-8")
            os.chmod(temp, 0o600)
            os.replace(temp, self._path)
        except OSError:
            pass

    def _live(self, now):
        for key in [k for k, at in self._seen.items() if now - at > TAINT_SECONDS]:
            del self._seen[key]
        for key in [k for k, until in self._allowed.items() if until < now]:
            del self._allowed[key]
        if len(self._seen) > MAX_TAINT_FEATURES:
            for key, _ in sorted(self._seen.items(), key=lambda kv: kv[1])[:len(self._seen) - MAX_TAINT_FEATURES]:
                del self._seen[key]

    def add(self, text) -> None:
        now = time.time()
        with self._lock:
            for feature in features(text):
                self._seen[_feature(feature)] = now
            self._live(now)
            self._save()

    def carried(self, text, said="") -> list[str]:
        """The features of `text` it read from apps and the user didn't say themselves."""
        now = time.time()
        with self._lock:
            self._live(now)
            if not self._seen or _digest(text) in self._allowed:
                return []
            mine = {_feature(f) for f in features(said)}
            return sorted(f for f in features(text) if _feature(f) in self._seen and _feature(f) not in mine)[:5]

    def allow_digest(self, digest) -> None:
        with self._lock:
            self._allowed[str(digest)] = time.time() + ALLOWED_SECONDS
            self._save()

    def allow(self, text) -> None:
        self.allow_digest(_digest(text))


_TAINTS: dict[str, Taint] = {}
_TAINTS_LOCK = threading.Lock()


def taint_for(state_directory, pip_id) -> Taint:
    """The one record per Pip in this process, kept in its state folder (`careful/<pip>.json`, owner-only)."""
    key = f"{state_directory}:{pip_id}"
    with _TAINTS_LOCK:
        if key not in _TAINTS:
            _TAINTS[key] = Taint(Path(state_directory) / "careful" / f"{pip_id}.json")
        return _TAINTS[key]


def _feature(feature) -> str:
    return hashlib.sha256(("dgc-careful:" + feature).encode()).hexdigest()[:24]


def _digest(text) -> str:
    return hashlib.sha256(_norm(text).encode()).hexdigest()


def preview(text, limit=200) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else flat[:limit - 1] + "…"


# --------------------------------------------------------------------------- unattended runs

def computer_paused(registry, config, pip_id, requested_by, manifest) -> bool:
    """A routine, schedule or event run that reads the user's apps gets no computer while careful is on: apps it
    reads before the run (its reads, its references) or apps connected to it. Plugins are every Pip's since
    2026-10-09, so they don't decide it here: Lane does, in the run, whichever the Pip reaches for first."""
    if requested_by not in UNATTENDED or not is_on(registry, pip_id):
        return False
    if manifest.get("app_plan") is not None or manifest.get("app_references"):
        return True
    from . import pip_app_links
    try:
        return bool(pip_app_links.connected(registry, pip_id))
    except Exception:
        return True


class Lane:
    """In a run nobody is watching, careful mode lets a Pip use its computer or the user's plugins, not both:
    whichever it reaches for first, the other stays off for the run. With every plugin every Pip's, deciding it
    before the run (as connected apps still do) would take the computer from every routine of every Pip."""

    COMPUTER_OFF = ("Careful mode: nobody is watching this run and you have used the user's plugins in it, so your "
                    "computer stays off until they're here. Do what you can without it; if the task needs the computer, "
                    "say so in one sentence, and the user can run it from your chat.")
    PLUGINS_OFF = ("Careful mode: nobody is watching this run and you have used your computer in it, so the user's "
                   "plugins stay off in this run. Do what you can without them; if the task needs a plugin, say so in "
                   "one sentence, and the user can run it from your chat.")

    def __init__(self):
        self._first = None
        self._lock = threading.Lock()

    def __call__(self, kind: str):
        """None when ``kind`` ("computer" or "plugins") may be used in this run, else what to tell the Pip."""
        with self._lock:
            if self._first is None:
                self._first = kind
            if self._first == kind:
                return None
        return self.COMPUTER_OFF if kind == "computer" else self.PLUGINS_OFF


PAUSED_NOTE = ("Careful mode: your computer is off in this run. Nobody is watching it and you can read the user's "
               "apps here, so nothing you read can be carried to a website. Do what you can without it; if the "
               "task needs the computer, say so in one sentence, and the user can run it from your chat.")
