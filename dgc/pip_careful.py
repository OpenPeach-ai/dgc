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
import re
import threading
import time
from urllib.parse import unquote, urlsplit

from .workspace_registry import RegistryError, utc_now

OFF = "computer_careful_off:"           # metadata: careful mode turned off for this Pip
SITES = "computer_sites:"               # metadata: the sites this Pip may visit, JSON
MAX_SITES = 300
UNATTENDED = ("local-routine", "local-scheduler", "local-event-trigger")
LOCAL = ("editor-user", "local-console")
TAINT_SECONDS = 24 * 3600
ALLOWED_SECONDS = 30 * 60
MAX_TAINT_FEATURES = 200_000
SHINGLE = 5                             # words in a row that count as carrying text across
# Second-level public suffixes common enough to matter, and hosting suffixes whose subdomains are
# different owners. A built-in list keeps this offline; a miss errs toward asking more, never less.
SUFFIXES = frozenset("""co.uk org.uk ac.uk gov.uk com.au net.au org.au co.in net.in org.in gov.in ac.in co.jp ne.jp or.jp
co.nz com.br com.mx com.ar com.tr com.sg com.hk com.tw com.cn co.za co.kr co.il com.my co.id com.ph com.vn com.pk
com.sa com.eg com.ng co.ke github.io gitlab.io vercel.app netlify.app pages.dev workers.dev herokuapp.com
web.app firebaseapp.com azurewebsites.net cloudfront.net s3.amazonaws.com blogspot.com wordpress.com fly.dev
onrender.com glitch.me repl.co ngrok.io ngrok-free.app""".split())


def site_of(host: str) -> str:
    """The registrable domain: shop.amazon.in -> amazon.in, a.b.github.io -> b.github.io, an IP as itself."""
    host = str(host or "").strip().strip(".").lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    labels = [label for label in host.split(".") if label]
    if len(labels) <= 2:
        return ".".join(labels)
    take = 3 if ".".join(labels[-2:]) in SUFFIXES else 2
    return ".".join(labels[-take:])


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
    from .pip_computer_box import HOME_PAGE
    return ({s["site"] for s in _sites(registry, pip_id)} | user_sites(registry, pip_id)
            | {site_of(urlsplit(HOME_PAGE).hostname or "")})


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
    """What a Pip read from your apps in the last day, per Pip, in the supervisor only."""

    def __init__(self):
        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}
        self._allowed: dict[str, float] = {}

    def add(self, text) -> None:
        now = time.monotonic()
        with self._lock:
            for feature in features(text):
                if len(self._seen) >= MAX_TAINT_FEATURES:
                    break
                self._seen[feature] = now

    def _live(self, now):
        for key in [k for k, at in self._seen.items() if now - at > TAINT_SECONDS]:
            del self._seen[key]
        for key in [k for k, until in self._allowed.items() if until < now]:
            del self._allowed[key]

    def carried(self, text, said="") -> list[str]:
        """The features of `text` it read from apps and the user didn't say themselves."""
        if not self._seen:
            return []
        now = time.monotonic()
        with self._lock:
            self._live(now)
            if _digest(text) in self._allowed:
                return []
            mine = features(said)
            return sorted(f for f in features(text) if f in self._seen and f not in mine)[:5]

    def allow(self, text) -> None:
        with self._lock:
            self._allowed[_digest(text)] = time.monotonic() + ALLOWED_SECONDS


def _digest(text) -> str:
    return hashlib.sha256(_norm(text).encode()).hexdigest()


def preview(text, limit=200) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else flat[:limit - 1] + "…"


# --------------------------------------------------------------------------- unattended runs

def computer_paused(registry, config, pip_id, requested_by, manifest) -> bool:
    """A routine, schedule or event run that can read the user's apps gets no computer while careful is on."""
    if requested_by not in UNATTENDED or not is_on(registry, pip_id):
        return False
    if manifest.get("app_plan") is not None or manifest.get("app_references"):
        return True
    from . import pip_app_links, pip_plugins
    try:
        if pip_app_links.connected(registry, pip_id):
            return True
    except Exception:
        return True
    try:
        return bool(pip_plugins.allowed(registry, pip_id, config))
    except Exception:
        return True


PAUSED_NOTE = ("Careful mode: your computer is off in this run. Nobody is watching it and you can read the user's "
               "apps here, so nothing you read can be carried to a website. Do what you can without it; if the "
               "task needs the computer, say so in one sentence, and the user can run it from your chat.")
