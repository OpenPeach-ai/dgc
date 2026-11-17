"""Your Browser (0.52, Pips API 105): one shared browser on this computer where the person signs in to their accounts
once, and each Pip works in its own tab of it (its lane), only on the sites the person lets that Pip use.

Never by copying cookies into a Pip's own box: the sign-ins stay in Your Browser's one profile, and a Pip reaches them
only by driving its own lane there, which DGC confines (pip_computer_box.BoxedBrowser: a lane's pages open only on its
sites and their exact sign-in hosts, a write elsewhere is refused, its requests are logged per Pip and site).

Your Browser is Google Chrome (the installed one, or DGC's own downloaded copy where none is installed) with DGC's own
profile, run on this computer as a real window: ``kind`` is ``host_profile`` and ``weaker`` is true, honestly, because
Chrome's own sandbox keeps sites apart there, not a box. The person brings their accounts by signing in to Chrome and
turning on its sync; DGC never reads or copies another browser's cookies or passwords.

This module is the model and the API (phase 1):

- ``your_browser_sites`` / ``your_browser_site_pips``: the sites the person is signed in to there (noticed from their
  own sign-ins, never added by a Pip) and which Pips may use each. A site is ``all`` (every Pip) or ``chosen`` (only the
  Pips listed; none listed means "Ask me which Pips"). A newly noticed bank or payment site starts at ``chosen`` with
  no Pips, every other site at ``all`` (his answer 3, 17 Nov); ``money_site`` is that one decision.
- ``get_your_browser`` (read), ``set_your_browser_site`` and ``sign_out_your_browser_site`` (changes), and
  ``open_your_browser`` / ``use_your_browser_view``, declared now and answering ``not_ready`` until the window and its
  streamed tab exist (phase 3). Every one is local only.
- ``grants_for``: what a Pip's lane may open, for the lane gate.
- ``profile_prefs``: third-party cookies off in Your Browser's profile (his answer 2).
- ``LaneSent``: what each Pip's lane sent, per site, in the "Sent to the web" log (his answer 8).
"""
from __future__ import annotations

import ipaddress
import json
import re
import sys
import time
from contextlib import nullcontext
from pathlib import Path
from urllib.parse import urlsplit

from .workspace_registry import RegistryError, utc_now

LOCAL = ("editor-user", "local-console")
MODES = ("all", "chosen")
KIND = "host_profile"           # Google Chrome with DGC's own profile, on this computer (17 Nov midday); never "box" now
FOLDER = "your-browser"         # in the Pips state folder: the profile, its log and the lanes' sent log
SIGN_OUTS = "your_browser_sign_outs"     # metadata: sites signed out here that Your Browser still has to clear
MAX_SITES = 500
MAX_PIPS = 500
MAX_SSO_HOSTS = 20
SCHEMA = """
CREATE TABLE IF NOT EXISTS your_browser_sites(
 site TEXT PRIMARY KEY CHECK(length(site) BETWEEN 1 AND 253),
 shown TEXT NOT NULL,
 sso_hosts TEXT NOT NULL DEFAULT '[]',
 mode TEXT NOT NULL CHECK(mode IN ('all','chosen')),
 added_by TEXT NOT NULL,
 added_at TEXT NOT NULL,
 used_at TEXT);
CREATE TABLE IF NOT EXISTS your_browser_site_pips(
 site TEXT NOT NULL REFERENCES your_browser_sites(site) ON DELETE CASCADE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 PRIMARY KEY(site, pip_id));
CREATE INDEX IF NOT EXISTS your_browser_site_pips_pip ON your_browser_site_pips(pip_id)
"""


def _ensure(db) -> None:
    for statement in (part.strip() for part in SCHEMA.split(";")):
        if statement:
            db.execute(statement)


def _has_tables(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='your_browser_sites'").fetchone() is not None


def folder(directory) -> Path:
    """Your Browser's own folder in the Pips state folder (its profile, log and sent log): never a Pip's."""
    return Path(directory) / FOLDER


# --------------------------------------------------------------------------- sites

_PRIVATE_SUFFIXES = (".local", ".internal", ".lan", ".home", ".home.arpa", ".localhost", ".test", ".invalid",
                     ".example", ".corp", ".intranet")


def public_host(host) -> str:
    """The host, lower case, when it is a public name on the web; "" for an address, this computer, a name on the
    local network or one that can't be a site. Your Browser never lends a Pip anything on this computer or the LAN."""
    host = str(host or "").strip().strip(".").lower()
    if not host or len(host) > 253 or not re.fullmatch(r"[a-z0-9.-]+", host):
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            return ""
        if not re.fullmatch(r"[a-z0-9.-]{1,253}", host):
            return ""
    try:
        ipaddress.ip_address(host)
        return ""
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) < 2 or any(not label or len(label) > 63 for label in labels):
        return ""
    if host == "localhost" or any(("." + host).endswith(suffix) for suffix in _PRIVATE_SUFFIXES):
        return ""
    return host


def site_key(host) -> str:
    """A site as Your Browser keeps it: its registrable domain (shop.bank.co.uk -> bank.co.uk), only for public
    names."""
    from .pip_careful import site_of
    host = public_host(host)
    return site_of(host) if host else ""


# The one bank-or-payment decision (his answer 3): a newly noticed site here starts at "Ask me which Pips" (mode chosen,
# no Pips); every other site starts at All Pips. Matching more than it should only asks the person once; that is the
# safe side. Sites where people keep money, pay, borrow or trade:
MONEY_SITES = frozenset("""
paypal.com paypal.me stripe.com wise.com revolut.com venmo.com cash.app zellepay.com payoneer.com skrill.com
klarna.com afterpay.com affirm.com coinbase.com binance.com kraken.com gemini.com crypto.com robinhood.com
schwab.com fidelity.com vanguard.com etrade.com chase.com bankofamerica.com wellsfargo.com citi.com capitalone.com
americanexpress.com discover.com usbank.com pnc.com ally.com sofi.com chime.com monzo.com starlingbank.com
barclays.co.uk hsbc.com hsbc.co.uk lloydsbank.com natwest.com santander.com santander.co.uk ing.com n26.com
hdfcbank.com icicibank.com axisbank.com kotak.com onlinesbi.sbi sbi.co.in yesbank.in idfcfirstbank.com
indusind.com paytm.com phonepe.com razorpay.com zerodha.com groww.in upstox.com mobikwik.com alipay.com
""".split())
MONEY_TLDS = frozenset({"bank", "insurance", "creditunion", "sbi"})
# Words in a site's own name (its first label) that say money: northwind-bank.com, mypaywallet.io.
MONEY_WORDS = ("bank", "wallet", "credit", "loan", "invest", "broker", "crypto", "finance", "insurance", "trading")
# What the person's own sign-in showed (payment-flow signals): a card number field, a payment address, a page that names
# itself a bank or a payment.
PAYMENT_PATH = re.compile(r"/(?:checkout|payments?|billing|pay|transfers?|wallet|netbanking|banking|upi)(?:[/?#.]|$)",
                          re.I)
MONEY_TITLE = re.compile(r"\b(?:bank|banking|net ?banking|payments?|wallet|brokerage|credit card)\b", re.I)


def money_site(host, *, card_fields: bool = False, paths=(), titles=()) -> bool:
    """Whether a site the person signed in to is a bank or a payment site: on the list, under a money domain ending
    (.bank), named for money (a bank, a wallet, a name starting or ending in "pay"), or, from their sign-in, a page
    with a card number field, a payment address or a title that says so."""
    site = site_key(host)
    if not site:
        return False
    labels = site.split(".")
    name = labels[0]
    if (site in MONEY_SITES or labels[-1] in MONEY_TLDS or any(word in name for word in MONEY_WORDS)
            or name.startswith("pay") or name.endswith("pay")):
        return True
    if card_fields is True:
        return True
    if any(PAYMENT_PATH.search(urlsplit(str(p or "")).path or str(p or "")) for p in list(paths)[:20]):
        return True
    return any(MONEY_TITLE.search(str(t or "")[:300]) for t in list(titles)[:20])


def _sso_list(value) -> list[str]:
    try:
        hosts = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    return [h for h in hosts if isinstance(h, str)][:MAX_SSO_HOSTS] if isinstance(hosts, list) else []


def notice_site(registry, host, *, sso_hosts=(), card_fields: bool = False, paths=(), titles=(),
                by: str = "noticed") -> dict | None:
    """The person signed in to a site in Your Browser (what DGC notices there, never a Pip's say): kept, or its last use
    and its sign-in hosts brought up to date. A new bank or payment site starts at "Ask me which Pips", any other at All
    Pips; a site the person already set keeps their choice. ``sso_hosts``: the exact hosts the sign-in went through
    (accounts.example-idp.com), allowed to that site's lanes by name only, never their whole domain. Nothing on this
    computer or the local network is ever a site. Returns the site, or None when it can't be one."""
    site = site_key(host)
    if not site:
        return None
    hosts = sorted({h for h in (public_host(s) for s in list(sso_hosts)[:MAX_SSO_HOSTS]) if h})
    now = registry.clock()
    with nullcontext() if registry.db.in_transaction else registry.transaction():
        _ensure(registry.db)
        row = registry.db.execute("SELECT * FROM your_browser_sites WHERE site=?", (site,)).fetchone()
        if row is None:
            if registry.db.execute("SELECT COUNT(*) FROM your_browser_sites").fetchone()[0] >= MAX_SITES:
                return None
            from .pip_careful import shown_host
            mode = "chosen" if money_site(host, card_fields=card_fields, paths=paths, titles=titles) else "all"
            registry.db.execute("INSERT INTO your_browser_sites VALUES(?,?,?,?,?,?,?)",
                                (site, shown_host(site)[:300], json.dumps(hosts[:MAX_SSO_HOSTS]), mode,
                                 str(by or "noticed")[:40], now, now))
        else:
            kept = sorted(set(_sso_list(row["sso_hosts"])) | set(hosts))[:MAX_SSO_HOSTS]
            registry.db.execute("UPDATE your_browser_sites SET used_at=?, sso_hosts=? WHERE site=?",
                                (now, json.dumps(kept), site))
        _drop_sign_out(registry, site)        # signed in again: nothing waits to clear it any more
    return _site(registry, site)


def _site(registry, site) -> dict | None:
    row = registry.db.execute("SELECT * FROM your_browser_sites WHERE site=?", (site,)).fetchone()
    if row is None:
        return None
    pips = registry.db.execute("SELECT b.pip_id, COALESCE(json_extract(v.definition,'$.name'), '') AS name "
                               "FROM your_browser_site_pips b JOIN pips p ON p.id=b.pip_id LEFT JOIN pip_versions v "
                               "ON v.pip_id=p.id AND v.version=p.current_version WHERE b.site=? ORDER BY name, b.pip_id",
                               (site,)).fetchall()
    return {"site": row["site"], "shown": row["shown"], "mode": row["mode"], "money": money_site(row["site"]),
            "pips": [{"pip_id": p["pip_id"], "name": p["name"]} for p in pips] if row["mode"] == "chosen" else [],
            "sso_hosts": _sso_list(row["sso_hosts"]), "added_by": row["added_by"], "added_at": row["added_at"],
            "used_at": row["used_at"]}


def sites(registry) -> list[dict]:
    """Every site the person is signed in to in Your Browser, the most recently used first, each with its Pips."""
    if not _has_tables(registry.db):
        return []
    rows = registry.db.execute("SELECT site FROM your_browser_sites ORDER BY COALESCE(used_at, added_at) DESC, site "
                               "LIMIT ?", (MAX_SITES,)).fetchall()
    return [s for s in (_site(registry, r["site"]) for r in rows) if s is not None]


class Grants:
    """What one Pip's lane may open in Your Browser: pages on its sites (a site and every host under it) and the exact
    sign-in hosts those sites use. Anything else is refused by the lane gate."""

    def __init__(self, sites=(), sso_hosts=()):
        self.sites = frozenset(s for s in (site_key(x) for x in sites) if s)
        self.sso_hosts = frozenset(h for h in (public_host(x) for x in sso_hosts) if h)

    def admits(self, host) -> bool:
        host = public_host(host)
        return bool(host) and (host in self.sso_hosts or site_key(host) in self.sites)

    def words(self) -> str:
        """The lane's sites, as a refusal names them."""
        names = sorted(self.sites)
        return ", ".join(names[:6]) + (f" and {len(names) - 6} more" if len(names) > 6 else "") if names else "none yet"

    def __repr__(self) -> str:
        return f"Grants(sites={sorted(self.sites)!r}, sso_hosts={sorted(self.sso_hosts)!r})"


def grants_for(registry, pip_id) -> Grants:
    """The sites a Pip's lane may use now: every All Pips site, and each chosen site that names it."""
    if not isinstance(pip_id, str) or not _has_tables(registry.db):
        return Grants()
    rows = registry.db.execute("SELECT s.site, s.sso_hosts FROM your_browser_sites s WHERE s.mode='all' OR EXISTS "
                               "(SELECT 1 FROM your_browser_site_pips b WHERE b.site=s.site AND b.pip_id=?)",
                               (pip_id,)).fetchall()
    return Grants([r["site"] for r in rows], [h for r in rows for h in _sso_list(r["sso_hosts"])])


# --------------------------------------------------------------------------- the commands

def _local(actor, said) -> None:
    if actor not in LOCAL:
        raise RegistryError("local_only", said)


def _known_site(registry, site) -> str:
    key = site_key(site) if isinstance(site, str) else ""
    if not key:
        raise RegistryError("invalid_request", "Name the site, such as example.com.")
    if not _has_tables(registry.db) or registry.db.execute("SELECT 1 FROM your_browser_sites WHERE site=?",
                                                          (key,)).fetchone() is None:
        raise RegistryError("not_found", f"You aren't signed in to {key} in Your Browser.")
    return key


def set_site(registry, site, mode, pips, actor) -> dict:
    """set_your_browser_site: All Pips, or only the Pips chosen (none chosen: "Ask me which Pips")."""
    _local(actor, "Only you choose which Pips use your sign-ins, on this computer.")
    key = _known_site(registry, site)
    if mode not in MODES:
        raise RegistryError("invalid_request", "mode is all (every Pip) or chosen (only the Pips you list).")
    if pips is None:
        pips = []
    if not isinstance(pips, list) or len(pips) > MAX_PIPS or not all(isinstance(p, str) for p in pips):
        raise RegistryError("invalid_request", "pips is a list of Pip ids.")
    if mode == "all" and pips:
        raise RegistryError("invalid_request", "With mode all every Pip may use the site: leave pips out.")
    chosen = sorted(set(pips))
    for pip_id in chosen:
        if registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
            raise RegistryError("not_found", "One of those Pips isn't on this computer.")
    with registry.transaction():
        registry.db.execute("UPDATE your_browser_sites SET mode=? WHERE site=?", (mode, key))
        registry.db.execute("DELETE FROM your_browser_site_pips WHERE site=?", (key,))
        registry.db.executemany("INSERT INTO your_browser_site_pips VALUES(?,?)", ((key, p) for p in chosen))
    return {"site": _site(registry, key)}


def _sign_outs(registry) -> list[dict]:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (SIGN_OUTS,)).fetchone()
    try:
        value = json.loads(row["value"]) if row else []
    except (TypeError, ValueError):
        value = []
    return [s for s in value if isinstance(s, dict) and isinstance(s.get("site"), str)][:MAX_SITES] \
        if isinstance(value, list) else []


def _drop_sign_out(registry, site) -> None:
    waiting = _sign_outs(registry)
    if any(s["site"] == site for s in waiting):
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                            (SIGN_OUTS, json.dumps([s for s in waiting if s["site"] != site])))


def sign_out_site(registry, site, actor) -> dict:
    """sign_out_your_browser_site: no Pip may use the site from now on, and it leaves the list; Your Browser clears its
    sign-in (its cookies and those of its sign-in hosts) as soon as it runs. ``sign_out`` says "waiting" until then."""
    _local(actor, "Only you sign out of a site in Your Browser, on this computer.")
    key = _known_site(registry, site)
    with registry.transaction():
        row = registry.db.execute("SELECT sso_hosts FROM your_browser_sites WHERE site=?", (key,)).fetchone()
        registry.db.execute("DELETE FROM your_browser_site_pips WHERE site=?", (key,))
        registry.db.execute("DELETE FROM your_browser_sites WHERE site=?", (key,))
        waiting = [s for s in _sign_outs(registry) if s["site"] != key]
        waiting.append({"site": key, "sso_hosts": _sso_list(row["sso_hosts"] if row else "[]"), "at": registry.clock()})
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SIGN_OUTS, json.dumps(waiting[-MAX_SITES:])))
    return {"site": key, "sign_out": "waiting"}


def signing_out(registry) -> list[str]:
    """The sites signed out here that Your Browser hasn't cleared yet (it clears them when it next runs)."""
    return [s["site"] for s in _sign_outs(registry)]


MAC_CHROME = ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",)


def find_chrome() -> tuple[Path | None, str]:
    """The Google Chrome Your Browser runs and which it is: ("installed") Google Chrome on this computer, or ("dgc_copy")
    the copy DGC downloaded for Pip computers where none is installed (on ARM Linux /opt/google/chrome is often a stand-in
    for another browser, never used). Only Google Chrome: its sign-in and sync are how the person brings their
    accounts."""
    if sys.platform == "darwin":
        for path in (*MAC_CHROME, str(Path.home() / MAC_CHROME[0].lstrip("/"))):
            if Path(path).is_file():
                return Path(path), "installed"
        return None, ""
    from .pip_computer_box import GOOGLE_CHROME, _real_binary
    for path in GOOGLE_CHROME:
        if _real_binary(path):
            return Path(path), "installed"
    from . import pip_screen_setup
    own = pip_screen_setup.chrome_path()
    if own is not None and _real_binary(own):
        return own, "dgc_copy"
    return None, ""


def _availability() -> tuple[bool, str, str]:
    if not (sys.platform == "darwin" or sys.platform.startswith("linux")):
        return False, "On Windows, Your Browser runs with DGC inside WSL 2.", ""
    path, which = find_chrome()
    if path is not None:
        return True, "", which
    if sys.platform == "darwin":
        return False, "Install Google Chrome to use Your Browser.", ""
    from . import pip_screen_setup
    if pip_screen_setup.supported()[0]:
        setup = pip_screen_setup.status()
        if setup.get("state") == "failed" and setup.get("error"):
            return False, f"DGC couldn't fetch Google Chrome: {setup['error']}"[:400], ""
        return False, "DGC is fetching Google Chrome for Your Browser. This happens once.", ""
    return False, "Install Google Chrome to use Your Browser.", ""


def get(registry) -> dict:
    """get_your_browser: what Your Browser is here (``kind`` host_profile, ``weaker`` true), whether it can run and
    with which Google Chrome, the sites the person is signed in to with their Pips, the sites still waiting to be
    cleared after a sign-out, the person's own tabs and the Pips' lanes (empty until Your Browser runs, phase 3)."""
    try:
        available, reason, which = _availability()
    except Exception as exc:                  # noqa: BLE001 - a check that can't run says so, and lists the sites
        available, reason, which = False, f"DGC couldn't check for Google Chrome: {exc}"[:400], ""
    return {"kind": KIND, "weaker": True, "available": available, "reason": reason, "chrome": which,
            "sites": sites(registry), "signing_out": signing_out(registry) if _has_metadata(registry) else [],
            "yours": {"open": False, "tabs": []}, "lanes": []}


def _has_metadata(registry) -> bool:
    return registry.db.execute("SELECT 1 FROM metadata WHERE key=?", (SIGN_OUTS,)).fetchone() is not None


NOT_READY = "Your Browser's window isn't in this version of DGC yet."
VIEW_OPS = ("click", "move", "type", "key", "scroll", "go", "back", "forward", "reload", "close")


def _check_open(request) -> None:
    url, pip_id = request.get("url"), request.get("pip_id")
    if url is not None and (not isinstance(url, str) or len(url) > 2000):
        raise RegistryError("invalid_request", "url is an address or a search, up to 2,000 characters.")
    if pip_id is not None and not isinstance(pip_id, str):
        raise RegistryError("invalid_request", "pip_id names a Pip.")


def _check_view(request) -> None:
    _check_open(request)
    if request.get("op") not in VIEW_OPS:
        raise RegistryError("invalid_request", "op is one of " + ", ".join(VIEW_OPS) + ".")
    for name in ("x", "y", "dy"):
        value = request.get(name)
        if value is not None and (type(value) not in (int, float) or isinstance(value, bool)):
            raise RegistryError("invalid_request", f"{name} is a number.")
    for name, most in (("text", 4000), ("key", 40)):
        value = request.get(name)
        if value is not None and (not isinstance(value, str) or len(value) > most):
            raise RegistryError("invalid_request", f"{name} is text up to {most} characters.")


def control(registry, command: str, request: dict, actor: str) -> dict:
    """The five Your Browser commands (Pips API 105), from handle_control. Every one is local only."""
    _local(actor, "Your Browser is on this computer only.")
    if command == "get_your_browser":
        return get(registry)
    if command == "set_your_browser_site":
        return set_site(registry, request.get("site"), request.get("mode"), request.get("pips"), actor)
    if command == "sign_out_your_browser_site":
        return sign_out_site(registry, request.get("site"), actor)
    if command == "open_your_browser":
        _check_open(request)
    elif command == "use_your_browser_view":
        _check_view(request)
    else:
        raise RegistryError("unsupported_command", "This runner does not support that Pip command.")
    raise RegistryError("not_ready", NOT_READY)


COMMANDS = frozenset({"get_your_browser", "set_your_browser_site", "sign_out_your_browser_site", "open_your_browser",
                      "use_your_browser_view"})
COMMAND_ARGS = {
    "get_your_browser": set(),
    "set_your_browser_site": {"site", "mode", "pips"},
    "sign_out_your_browser_site": {"site"},
    "open_your_browser": {"url", "pip_id"},
    "use_your_browser_view": {"op", "x", "y", "text", "key", "dy", "url", "pip_id"},
}


# --------------------------------------------------------------------------- the profile

def profile_prefs(profile: Path) -> bool:
    """Third-party cookies off in Your Browser's profile (his answer 2: safer between sites), set before every start, as
    a person would in Chrome's settings. Everything else in the profile stays the person's own: their saved passwords,
    sync and extensions are untouched. Never fails a start; a link in place of the file is never followed. Returns
    whether the file says so now."""
    path = Path(profile) / "Default" / "Preferences"
    try:
        if any(p.is_symlink() for p in (Path(profile), path.parent, path)):
            return False
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(data, dict):
            return False
        prefs = data.get("profile") if isinstance(data.get("profile"), dict) else {}
        if prefs.get("cookie_controls_mode") == 1 and prefs.get("block_third_party_cookies") is True:
            return True
        # 1 = block third-party cookies (0 allows them, 2 blocks them only in private windows).
        data["profile"] = {**prefs, "cookie_controls_mode": 1, "block_third_party_cookies": True}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
        return True
    except (OSError, ValueError):
        return False


# --------------------------------------------------------------------------- what each lane sent

class LaneSent:
    """What each Pip's lane sent, per site (his answer 8): from the lane's own Network events, never the person's tabs.
    Requests to one host are added up and written as one line ({at, host, kind "request", up, down, requests, pip_id,
    site}) when the lane opens another page, after FLUSH_SECONDS, or on flush(); a refused page or write is written at
    once as kind "refused". The "Sent to the web" log (list_pip_sent) reads a Pip's lines from here beside its own
    computers'."""
    FLUSH_SECONDS = 30.0
    MAX_PENDING = 200

    def __init__(self, path: Path, *, clock=time.monotonic):
        self.path = Path(path)
        self.clock = clock
        self._pending: dict[tuple[str, str], list] = {}     # (pip_id, host) -> [requests, up, down, since]

    def add(self, pip_id: str, host: str, up: int = 0, down: int = 0) -> None:
        """One request the lane finished: its bytes out and back."""
        if not pip_id or not host:
            return
        key = (pip_id, str(host).lower()[:255])
        entry = self._pending.setdefault(key, [0, 0, 0, self.clock()])
        entry[0] += 1
        entry[1] += max(0, int(up or 0))
        entry[2] += max(0, int(down or 0))
        if len(self._pending) > self.MAX_PENDING:
            self.flush()
        else:
            self.flush_due()

    def flush_due(self) -> None:
        """Write what has waited FLUSH_SECONDS or more (the browser calls this as it runs)."""
        now = self.clock()
        for key in [k for k, e in self._pending.items() if now - e[3] >= self.FLUSH_SECONDS]:
            requests, up, down, _ = self._pending.pop(key)
            if requests or up or down:
                self._write(key[0], key[1], "request", up, down, requests)

    def refused(self, pip_id: str, host: str) -> None:
        self._write(pip_id, str(host).lower()[:255], "refused", 0, 0)

    def flush(self, pip_id: str | None = None) -> None:
        for key in [k for k in self._pending if pip_id is None or k[0] == pip_id]:
            requests, up, down, _ = self._pending.pop(key)
            if requests or up or down:
                self._write(key[0], key[1], "request", up, down, requests)

    def _write(self, pip_id, host, kind, up, down, requests=1) -> None:
        from .leak_guard import record_sent
        from .pip_careful import site_of
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return
        record_sent(self.path, {"at": utc_now(), "host": host or "?", "kind": kind, "up": up, "down": down,
                                "requests": requests, "pip_id": pip_id, "site": site_of(host)})
