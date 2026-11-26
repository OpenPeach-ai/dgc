"""DGC Browser (0.52, Pips API 105): one shared browser on this computer where the person signs in to their accounts
once, and each Pip works in its own tab of it (its lane), only on the sites the person lets that Pip use.

Never by copying cookies into a Pip's own box: the sign-ins stay in DGC Browser's one profile, and a Pip reaches them
only by driving its own lane there, which DGC confines (pip_computer_box.BoxedBrowser: a lane's pages open only on its
sites and their exact sign-in hosts, a write elsewhere is refused, its requests are logged per Pip and site).

DGC Browser is Google Chrome (the installed one, or DGC's own downloaded copy where none is installed) with DGC's own
profile, run on this computer as a real window: ``kind`` is ``host_profile`` and ``weaker`` is true, honestly, because
Chrome's own sandbox keeps sites apart there, not a box. The person brings their accounts by signing in to Chrome and
turning on its sync; DGC never reads or copies another browser's cookies or passwords.

This module is the model and the API (phase 1) and its window (phase 3):

- ``dgc_browser_sites`` / ``dgc_browser_site_pips``: the sites the person is signed in to there (noticed from their
  own sign-ins, never added by a Pip) and which Pips may use each. A site is ``all`` (every Pip) or ``chosen`` (only the
  Pips listed; none listed means "Ask me which Pips"). A newly noticed bank or payment site starts at ``chosen`` with
  no Pips, every other site at ``all`` (decision 3, 17 Nov); ``money_site`` is that one decision.
- ``get_dgc_browser`` and ``get_dgc_browser_recent`` (reads), ``set_dgc_browser_site``, ``sign_out_dgc_browser_site``,
  ``open_dgc_browser`` and ``use_dgc_browser_view`` (changes). Every one is local only.
- The window (phase 3, Pips API 107): the supervisor owns the one Chrome (DgcBrowserHost, one per profile): it opens it
  where the editor's command asked (to the right of the editor), reads its DevTools pipe, notes the person's own visits
  for Home's card, streams one Pip's lane at a time, clears sites signed out of, and closes it after 15 idle minutes.
  On Linux it never starts Chrome without Chrome's own sandbox (``sandbox_ok``).
- ``grants_for``: what a Pip's lane may open, for the lane gate.
- ``profile_prefs``: third-party cookies off in DGC Browser's profile (decision 2).
- ``LaneSent``: what each Pip's lane sent, per site, in the "Sent to the web" log (decision 8).
- A Pip's runs (phase 4): its run drives its own lane with the ``dgc_browser`` tool (dgc_browser_lane), and while it
  drives, HostBrowser refuses any command to a tab that isn't that Pip's (``driving``); ``allow_pip_site`` is the
  person's Allow on its chat card for a site.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from contextlib import nullcontext
from pathlib import Path
from urllib.parse import quote_plus, urlsplit

from .workspace_registry import RegistryError, utc_now

LOCAL = ("editor-user", "local-console")
MODES = ("all", "chosen")
KIND = "host_profile"           # Google Chrome with DGC's own profile, on this computer (17 Nov midday); never "box" now
# In the Pips state folder: the profile, its log and the lanes' sent log. Its name is from before DGC Browser was
# called that (it was "Your Browser" until 26 Nov): the person's sign-ins live in this profile, so it keeps its folder.
FOLDER = "your-browser"
WORK_ACTIVE_SECONDS = 60          # a Work session's tab says it is at work for this long after its last step
SIGN_OUTS = "dgc_browser_sign_outs"     # metadata: sites signed out here that DGC Browser still has to clear
MAX_SITES = 500
MAX_PIPS = 500
MAX_SSO_HOSTS = 20
SCHEMA = """
CREATE TABLE IF NOT EXISTS dgc_browser_sites(
 site TEXT PRIMARY KEY CHECK(length(site) BETWEEN 1 AND 253),
 shown TEXT NOT NULL,
 sso_hosts TEXT NOT NULL DEFAULT '[]',
 mode TEXT NOT NULL CHECK(mode IN ('all','chosen')),
 added_by TEXT NOT NULL,
 added_at TEXT NOT NULL,
 used_at TEXT);
CREATE TABLE IF NOT EXISTS dgc_browser_site_pips(
 site TEXT NOT NULL REFERENCES dgc_browser_sites(site) ON DELETE CASCADE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 PRIMARY KEY(site, pip_id));
CREATE INDEX IF NOT EXISTS dgc_browser_site_pips_pip ON dgc_browser_site_pips(pip_id)
"""


# Its names until 26 Nov ("Your Browser"): the sites tables and the metadata keys a test build wrote under them move
# to DGC Browser's names once, in the registry's upgrade to schema 56 (workspace_registry), so the sites a person
# allowed and what the supervisor was asked carry over. Never on a read: opening the registry stays a read.
_OLD_TABLES = (("your_browser_sites", "dgc_browser_sites"), ("your_browser_site_pips", "dgc_browser_site_pips"))
_OLD_KEYS = ("sign_outs", "sites_seen", "open", "clear", "cleared", "state", "view")


def moved_names(db) -> None:
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for old, new in _OLD_TABLES:
        if old in tables and new not in tables:
            db.execute(f"ALTER TABLE {old} RENAME TO {new}")      # (SQLite carries the site_pips reference along)
    if "metadata" in tables:
        for key in _OLD_KEYS:
            db.execute("UPDATE OR IGNORE metadata SET key=? WHERE key=?", (f"dgc_browser_{key}", f"your_browser_{key}"))
            db.execute("DELETE FROM metadata WHERE key=?", (f"your_browser_{key}",))


def _ensure(db) -> None:
    for statement in (part.strip() for part in SCHEMA.split(";")):
        if statement:
            db.execute(statement)


def _has_tables(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dgc_browser_sites'").fetchone() is not None


def folder(directory) -> Path:
    """DGC Browser's own folder in the Pips state folder (its profile, log and sent log): never a Pip's."""
    return Path(directory) / FOLDER


# --------------------------------------------------------------------------- sites

_PRIVATE_SUFFIXES = (".local", ".internal", ".lan", ".home", ".home.arpa", ".localhost", ".test", ".invalid",
                     ".example", ".corp", ".intranet")


def public_host(host) -> str:
    """The host, lower case, when it is a public name on the web; "" for an address, this computer, a name on the
    local network or one that can't be a site. DGC Browser never lends a Pip anything on this computer or the LAN."""
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
    """A site as DGC Browser keeps it: its registrable domain (shop.bank.co.uk -> bank.co.uk), only for public
    names."""
    from .pip_careful import site_of
    host = public_host(host)
    return site_of(host) if host else ""


# The one bank-or-payment decision (decision 3): a newly noticed site here starts at "Ask me which Pips" (mode chosen,
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
    """The person signed in to a site in DGC Browser (what DGC notices there, never a Pip's say): kept, or its last use
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
        row = registry.db.execute("SELECT * FROM dgc_browser_sites WHERE site=?", (site,)).fetchone()
        if row is None:
            if registry.db.execute("SELECT COUNT(*) FROM dgc_browser_sites").fetchone()[0] >= MAX_SITES:
                return None
            from .pip_careful import shown_host
            mode = "chosen" if money_site(host, card_fields=card_fields, paths=paths, titles=titles) else "all"
            registry.db.execute("INSERT INTO dgc_browser_sites VALUES(?,?,?,?,?,?,?)",
                                (site, shown_host(site)[:300], json.dumps(hosts[:MAX_SSO_HOSTS]), mode,
                                 str(by or "noticed")[:40], now, now))
        else:
            kept = sorted(set(_sso_list(row["sso_hosts"])) | set(hosts))[:MAX_SSO_HOSTS]
            # A site a Pip was let use from its card (added_by "you") has no sign-in DGC knows of: noticed here, it has
            # one now, and the Sites panel says Sign out for it, not Remove. The person's choice of Pips stays.
            by_now = str(by or "noticed")[:40] if row["added_by"] == "you" else row["added_by"]
            registry.db.execute("UPDATE dgc_browser_sites SET used_at=?, sso_hosts=?, added_by=? WHERE site=?",
                                (now, json.dumps(kept), by_now, site))
        _drop_sign_out(registry, site)        # signed in again: nothing waits to clear it any more
    return _site(registry, site)


SEEN_KEY = "dgc_browser_sites_seen"   # metadata: when the person last opened the Sites panel (seen_dgc_browser_sites)


def _seen_at(registry) -> str:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (SEEN_KEY,)).fetchone()
    return str(row[0]) if row else ""


def seen_sites(registry, actor) -> dict:
    """seen_dgc_browser_sites (Pips API 113): the person opened the panel of sites Pips may use in DGC Browser, so the
    ones noticed until now are no longer new."""
    _local(actor, "Only you look at the sites Pips may use in DGC Browser, on this computer.")
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SEEN_KEY, registry.clock()))
    return {"ok": True}


def _site(registry, site) -> dict | None:
    row = registry.db.execute("SELECT * FROM dgc_browser_sites WHERE site=?", (site,)).fetchone()
    if row is None:
        return None
    pips = registry.db.execute("SELECT b.pip_id, COALESCE(json_extract(v.definition,'$.name'), '') AS name "
                               "FROM dgc_browser_site_pips b JOIN pips p ON p.id=b.pip_id LEFT JOIN pip_versions v "
                               "ON v.pip_id=p.id AND v.version=p.current_version WHERE b.site=? ORDER BY name, b.pip_id",
                               (site,)).fetchall()
    return {"site": row["site"], "shown": row["shown"], "mode": row["mode"], "money": money_site(row["site"]),
            "pips": [{"pip_id": p["pip_id"], "name": p["name"]} for p in pips] if row["mode"] == "chosen" else [],
            "sso_hosts": _sso_list(row["sso_hosts"]), "added_by": row["added_by"], "added_at": row["added_at"],
            "used_at": row["used_at"],
            # Noticed from the person's own sign-in since they last opened the Sites panel (seen_sites).
            "new": row["added_by"] == "noticed" and str(row["added_at"]) > _seen_at(registry)}


def sites(registry) -> list[dict]:
    """Every site the person is signed in to in DGC Browser, the most recently used first, each with its Pips."""
    if not _has_tables(registry.db):
        return []
    rows = registry.db.execute("SELECT site FROM dgc_browser_sites ORDER BY COALESCE(used_at, added_at) DESC, site "
                               "LIMIT ?", (MAX_SITES,)).fetchall()
    return [s for s in (_site(registry, r["site"]) for r in rows) if s is not None]


class Grants:
    """What one Pip's lane may open in DGC Browser: pages on its sites (a site and every host under it) and the exact
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
    rows = registry.db.execute("SELECT s.site, s.sso_hosts FROM dgc_browser_sites s WHERE s.mode='all' OR EXISTS "
                               "(SELECT 1 FROM dgc_browser_site_pips b WHERE b.site=s.site AND b.pip_id=?)",
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
    if not _has_tables(registry.db) or registry.db.execute("SELECT 1 FROM dgc_browser_sites WHERE site=?",
                                                          (key,)).fetchone() is None:
        raise RegistryError("not_found", f"You aren't signed in to {key} in DGC Browser.")
    return key


def set_site(registry, site, mode, pips, actor) -> dict:
    """set_dgc_browser_site: All Pips, or only the Pips chosen (none chosen: "Ask me which Pips")."""
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
        registry.db.execute("UPDATE dgc_browser_sites SET mode=? WHERE site=?", (mode, key))
        registry.db.execute("DELETE FROM dgc_browser_site_pips WHERE site=?", (key,))
        registry.db.executemany("INSERT INTO dgc_browser_site_pips VALUES(?,?)", ((key, p) for p in chosen))
    return {"site": _site(registry, key)}


def allow_pip_site(registry, host, pip_id, by: str) -> dict | None:
    """The person's Allow on a Pip's "use this site in DGC Browser?" card (its chat; pip_computer.tick carries it out):
    that Pip may use the site's pages in its lane from now on. A site not on the list yet joins it as the person's own
    choice for this Pip alone ("chosen"); a chosen site gains this Pip; an All Pips site has it already. Only the
    person's own decision (``by``) grants; nothing on this computer or the local network is ever a site. Returns the
    site, or None when nothing could be granted."""
    if by not in LOCAL or not isinstance(pip_id, str):
        return None
    site = site_key(host)
    if not site or registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
        return None
    now = registry.clock()
    with nullcontext() if registry.db.in_transaction else registry.transaction():
        _ensure(registry.db)
        row = registry.db.execute("SELECT mode FROM dgc_browser_sites WHERE site=?", (site,)).fetchone()
        if row is None:
            if registry.db.execute("SELECT COUNT(*) FROM dgc_browser_sites").fetchone()[0] >= MAX_SITES:
                return None
            from .pip_careful import shown_host
            registry.db.execute("INSERT INTO dgc_browser_sites VALUES(?,?,?,?,?,?,?)",
                                (site, shown_host(site)[:300], "[]", "chosen", "you", now, now))
        if row is None or row["mode"] == "chosen":
            registry.db.execute("INSERT OR IGNORE INTO dgc_browser_site_pips VALUES(?,?)", (site, pip_id))
    return _site(registry, site)


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
    """sign_out_dgc_browser_site: no Pip may use the site from now on, and it leaves the list; DGC Browser clears its
    sign-in (its cookies and those of its sign-in hosts) as soon as it runs. ``sign_out`` says "waiting" until then."""
    _local(actor, "Only you sign out of a site in DGC Browser, on this computer.")
    key = _known_site(registry, site)
    with registry.transaction():
        row = registry.db.execute("SELECT sso_hosts FROM dgc_browser_sites WHERE site=?", (key,)).fetchone()
        registry.db.execute("DELETE FROM dgc_browser_site_pips WHERE site=?", (key,))
        registry.db.execute("DELETE FROM dgc_browser_sites WHERE site=?", (key,))
        waiting = [s for s in _sign_outs(registry) if s["site"] != key]
        waiting.append({"site": key, "sso_hosts": _sso_list(row["sso_hosts"] if row else "[]"), "at": registry.clock()})
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SIGN_OUTS, json.dumps(waiting[-MAX_SITES:])))
    return {"site": key, "sign_out": "waiting"}


def signing_out(registry) -> list[str]:
    """The sites signed out here that DGC Browser hasn't cleared yet (it clears them when it next runs)."""
    return [s["site"] for s in _sign_outs(registry)]


MAC_CHROME = ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",)


def find_chrome() -> tuple[Path | None, str]:
    """The Google Chrome DGC Browser runs and which it is: ("installed") Google Chrome on this computer, or ("dgc_copy")
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


def has_screen() -> bool:
    """Whether this computer has a screen for DGC Browser's window: always on a Mac; on Linux, a display to draw on
    (none over Remote-SSH, or a server)."""
    if sys.platform == "darwin":
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


_USERNS_KNOBS = {"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0", "/proc/sys/kernel/unprivileged_userns_clone": "1"}
APPARMOR = Path("/etc/apparmor.d")


def _knob(knobs, path, default):
    if knobs is not None:
        return str(knobs.get(path, default)).strip()
    try:
        return Path(path).read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        return default


def _apparmor_glob(pattern: str) -> re.Pattern:
    """An AppArmor path pattern as a regular expression: * within one folder, ** across folders."""
    out = ""
    for part in re.split(r"(\*\*|\*|\?)", pattern):
        out += {"**": ".*", "*": "[^/]*", "?": "[^/]"}.get(part, re.escape(part))
    return re.compile(out + r"\Z")


def _apparmor_allows(real: str, folder: Path) -> bool:
    """Whether a profile in AppArmor's folder lets this program make user namespaces (Ubuntu's own chrome profile does
    for /opt/google/chrome/chrome; DGC's copy needs one of its own)."""
    try:
        files = [f for f in Path(folder).iterdir() if f.is_file()][:400]
    except OSError:
        return False
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:20000]
        except OSError:
            continue
        for found in re.finditer(r'profile\s+\S+\s+("([^"]+)"|(/\S+))[^{]*\{(.*?)\}', text, re.S):
            pattern = found.group(2) or found.group(3)
            if re.search(r"^\s*userns\s*,", found.group(4), re.M) and _apparmor_glob(pattern).match(real):
                return True
    return False


def sandbox_ok(chrome, *, knobs=None, apparmor: Path = APPARMOR, platform: str | None = None) -> bool:
    """Whether Google Chrome's own sandbox can run here. DGC Browser never starts Chrome without it: Chrome's sandbox is
    what keeps the sites in the person's signed-in browser apart.

    On Linux the sandbox needs user namespaces. Ubuntu 24.04 allows them only to programs AppArmor names (its own
    profile names /opt/google/chrome/chrome, where Google's package installs it with a root-owned sandbox helper); DGC's
    downloaded copy is named by none, and its helper isn't root's, so Chrome would refuse to start. The answer there is
    the installed Google Chrome (install_google_chrome), never a profile from DGC."""
    if (platform or sys.platform) != "linux":
        return True
    restricted = _knob(knobs, "/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "0") == "1"
    clone_off = _knob(knobs, "/proc/sys/kernel/unprivileged_userns_clone", "1") == "0"
    if not restricted and not clone_off:
        return True
    if chrome is None:
        return False                               # (no Chrome to ask about: only whether namespaces are open)
    try:
        real = os.path.realpath(chrome)
        helper = Path(real).parent / "chrome-sandbox"
        info = helper.stat()
        if info.st_uid == 0 and info.st_mode & 0o4000 and info.st_mode & 0o111:
            return True                            # Chrome's own setuid helper, as its package installs it
    except OSError:
        real = str(chrome)
    return bool(restricted and not clone_off and _apparmor_allows(real, apparmor))


# What DGC Browser says where it can't run yet (decided 18 Nov: no pasted commands, one button on apt systems).
NEEDS_CHROME = "DGC Browser runs in Google Chrome, which isn't on this computer yet."
GET_CHROME = "Install Google Chrome from google.com/chrome, then open DGC Browser again."
NO_SANDBOX = "Google Chrome's own sandbox can't run on this computer, and DGC Browser never starts Chrome without it."


def _apt_here() -> bool:
    from . import pip_screen_setup
    try:
        return bool(pip_screen_setup.supported()[0])
    except Exception:                              # noqa: BLE001 - no apt to use
        return False


def _availability() -> tuple[bool, str, str]:
    """(available, why not, which Google Chrome). With no screen (Remote-SSH, a server) it runs headless, so a screen is
    no longer asked for. NEEDS_CHROME is the one reason that comes with Install Google Chrome (install_offer)."""
    if not (sys.platform == "darwin" or sys.platform.startswith("linux")):
        return False, "On Windows, DGC Browser runs with DGC inside WSL 2.", ""
    path, which = find_chrome()
    if path is not None:
        if sandbox_ok(path):
            return True, "", which
        if which == "installed":
            return False, NO_SANDBOX, which
        # DGC's own copy, kept from its sandbox (Ubuntu's user-namespace rule): the installed Google Chrome is the way.
        return False, (NEEDS_CHROME if sys.platform.startswith("linux") and _apt_here() else GET_CHROME), which
    if sys.platform == "darwin" or not _apt_here():
        return False, GET_CHROME, ""
    from . import pip_screen_setup
    try:
        fetching = pip_screen_setup.status().get("state") == "running"
    except Exception:                              # noqa: BLE001
        fetching = False
    if fetching and sandbox_ok(None):
        # Its own copy is on the way, and its sandbox runs here (user namespaces are open): nothing to install.
        return False, "DGC is fetching Google Chrome for DGC Browser. This happens once.", ""
    return False, NEEDS_CHROME, ""


# --------------------------------------------------------------------------- Install Google Chrome (decided 18 Nov)

INSTALL_FILE = "install.json"       # in DGC Browser's folder: how the last install went {state, pid, error, at}
INSTALL_LOG = "install.log"         # what the root step printed (apt's lines), for the words when it fails
INSTALL_SECONDS = 30 * 60
APT_KEY = "/etc/apt/keyrings/google-chrome.asc"   # apt's own folder for a source's signing key
SOURCE_LIST = "/etc/apt/sources.list.d/google-chrome.list"
_INSTALL_LOCK = threading.Lock()


def install_script(*, fingerprint: str | None = None, key_file: str = APT_KEY, source_list: str = SOURCE_LIST) -> str:
    """The ONE root step, as a plain shell script (pkexec runs it; the terminal line is the same steps for sudo):
    Google's signing key, fetched and checked to be exactly the one key DGC pins (pip_screen_setup), kept for apt;
    Google's package source signed by it; then Google Chrome from it, as a person installs it themselves. No single
    quote in it, so the terminal line can carry it whole. Exit 3: the key wasn't Google's, and nothing was written."""
    from . import pip_screen_setup as setup
    fingerprint = fingerprint or setup.GOOGLE_KEY_FINGERPRINT
    if not re.fullmatch(r"[0-9A-F]{40}", fingerprint):
        raise ValueError("a key fingerprint is 40 hex digits")
    fetch = ('(curl -fsSL "$u" || wget -qO- "$u" || python3 -c "import sys,urllib.request as r;'
             'sys.stdout.buffer.write(r.urlopen(sys.argv[1],timeout=60).read())" "$u") > "$t/key"')
    lines = [
        "set -eu",
        "export DEBIAN_FRONTEND=noninteractive",
        "t=$(mktemp -d)",
        'trap "rm -rf $t" EXIT',
        f"u={setup.GOOGLE_KEY_URL}",
        fetch,
        'k=$(gpg --homedir "$t" --batch --with-colons --show-keys "$t/key" 2>/dev/null) || k=""',
        f'[ "$(echo "$k" | grep -c ^pub:)" = 1 ] && [ "$(echo "$k" | grep -m1 ^fpr: | cut -d: -f10)" = {fingerprint} ] '
        '|| { echo "The signing key is not the one DGC trusts: nothing was installed." >&2; exit 3; }',
        f"install -d -m 755 {Path(key_file).parent}",
        f'install -m 644 "$t/key" {key_file}',
        f'echo "deb [arch=$(dpkg --print-architecture) signed-by={key_file}] {setup.GOOGLE_REPOSITORY} stable main" > {source_list}',
        "apt-get update || true",
        "apt-get install -y google-chrome-stable",
    ]
    script = "\n".join(lines)
    assert "'" not in script
    return script


def terminal_line(**script) -> str:
    """The one line to run in a terminal on that machine where no password prompt can open (Remote-SSH, a server) or
    it was closed: the same steps as the root step, for sudo."""
    return "sudo sh -c '" + install_script(**script).replace("\n", "; ") + "'"


def _pkexec() -> str | None:
    return shutil.which("pkexec")


def _alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError, OverflowError):
        return False


def install_status(directory) -> dict:
    """How the last install went: {state: "" | running | done | failed, error}. A run whose process is gone (DGC
    closed while it ran) is no longer running: what is there is read again."""
    path = folder(directory) / INSTALL_FILE
    try:
        if path.is_symlink():
            return {"state": "", "error": ""}
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"state": "", "error": ""}
    if not isinstance(value, dict):
        return {"state": "", "error": ""}
    state = value.get("state") if value.get("state") in ("running", "done", "failed") else ""
    if state == "running" and not _alive(value.get("pid")):
        state = ""
    return {"state": state, "error": str(value.get("error") or "")[:400] if state == "failed" else ""}


def _write_install(directory, **fields) -> None:
    path = folder(directory) / INSTALL_FILE
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink():
            return
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(json.dumps({**fields, "at": utc_now()}), encoding="utf-8")
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except OSError:
        return


def install_offer(directory) -> dict:
    """What the card and the dock offer where Google Chrome is needed (NEEDS_CHROME): ``how`` "password" (the button:
    the system's own password prompt can open here) or "terminal" (no screen for one, as over Remote-SSH, or no
    pkexec: the line, with Copy), ``state`` ("" | running | failed), ``error`` (why the last one didn't install) and
    ``line`` (the terminal line, always there: a failed or closed prompt shows it too)."""
    status = install_status(directory)
    how = "password" if has_screen() and _pkexec() else "terminal"
    state = status["state"] if status["state"] in ("running", "failed") else ""
    return {"how": how, "state": state, "error": status["error"] if state == "failed" else "", "line": terminal_line()}


def _offer(directory, available: bool, reason: str):
    return install_offer(directory) if not available and reason == NEEDS_CHROME else None


def _run_root(argv: list[str], log) -> int:
    """The root step itself, through pkexec (the desktop's own password prompt). Its output goes to ``log``."""
    with open(log, "wb") as out:
        return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                              timeout=INSTALL_SECONDS, check=False).returncode


def _tail(log) -> str:
    try:
        lines = [l.strip() for l in Path(log).read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
    except OSError:
        return ""
    picked = [l for l in lines if l.startswith(("E:", "W:", "dpkg:"))] or lines
    return picked[-1][:240] if picked else ""


def _installing(directory, argv: list[str]) -> None:
    log = folder(directory) / INSTALL_LOG
    try:
        code = _run_root(argv, log)
    except (OSError, subprocess.SubprocessError) as exc:
        code, said = -1, str(exc)
    else:
        said = _tail(log)
    if code == 0:
        _write_install(directory, state="done")
        return
    error = {126: "Google Chrome wasn't installed: the password prompt was closed.",
             127: "No password prompt could open here.",
             3: "Google's signing key wasn't the one DGC trusts, so nothing was installed."}.get(code) \
        or f"Google Chrome didn't install: {said or f'the install ended with {code}.'}"
    _write_install(directory, state="failed", error=error[:400])


def install_chrome(registry) -> dict:
    """install_google_chrome {} (API 107): Google Chrome, installed as the person would themselves, through the system's
    own password prompt (pkexec) for ONE root step (install_script). DGC never sees the password. It runs on a thread of
    its own and answers at once ({available, install}); get_dgc_browser_recent says how it goes, and once it ends what is
    installed is read again. Where no prompt can open it runs nothing and answers the terminal line."""
    directory = registry.directory
    available, reason, _ = _availability()
    if available:
        return {"available": True, "install": None}
    if reason != NEEDS_CHROME:
        raise RegistryError("unavailable", reason)
    with _INSTALL_LOCK:
        offer = install_offer(directory)
        if offer["state"] == "running" or offer["how"] != "password":
            return {"available": False, "install": offer}
        argv = [_pkexec(), "/bin/sh", "-c", install_script()]
        _write_install(directory, state="running", pid=os.getpid())
        threading.Thread(target=_installing, args=(directory, argv), name="dgc-browser-install", daemon=True).start()
        return {"available": False, "install": install_offer(directory)}


def _state(registry) -> dict:
    """What the supervisor last said of DGC Browser (STATE_KEY): its window, the person's tabs and the lanes. Only while
    that supervisor runs: one that ended without a word (killed, a crash) left its last say behind, and none of what it
    named is there now (no window open, no tabs, no Pip's tab to watch or working). Its error is still said."""
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (STATE_KEY,)).fetchone()
    try:
        value = json.loads(row[0]) if row else {}
    except (TypeError, ValueError):
        value = {}
    if not isinstance(value, dict):
        return {}
    if (value.get("open") or value.get("tabs") or value.get("lanes")) and not _runner_live(registry):
        value = {**value, "open": False, "tabs": [], "lanes": []}
    return value


def _pip_names(registry, ids) -> dict:
    names = {}
    for pip_id in list(ids)[:MAX_PIPS]:
        row = registry.db.execute("SELECT COALESCE(json_extract(v.definition,'$.name'), '') FROM pips p LEFT JOIN "
                                  "pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.id=?",
                                  (pip_id,)).fetchone()
        if row is not None:
            names[pip_id] = row[0]
    return names


def get(registry) -> dict:
    """get_dgc_browser: what DGC Browser is here (``kind`` host_profile, ``weaker`` true), whether it can run and
    with which Google Chrome (and, where it needs one, Install Google Chrome: ``install``), how it opens here (``view``:
    its window, or with no screen a tab in the editor), the sites the person is signed in to with their Pips, the sites still waiting to be
    cleared after a sign-out, the person's own tabs (``yours``: open, tabs, error) and the Pips' lanes, as the
    supervisor that runs it last said."""
    try:
        available, reason, which = _availability()
    except Exception as exc:                  # noqa: BLE001 - a check that can't run says so, and lists the sites
        available, reason, which = False, f"DGC couldn't check for Google Chrome: {exc}"[:400], ""
    state = _state(registry)
    tabs = [{"title": str(t.get("title", ""))[:200], "url": str(t.get("url", ""))[:2000]}
            for t in state.get("tabs", []) if isinstance(t, dict)][:MAX_TABS] if isinstance(state.get("tabs"), list) else []
    return {"kind": KIND, "weaker": True, "available": available, "reason": reason, "chrome": which,
            "install": _offer(registry.directory, available, reason), "view": _view_here(),
            "sites": sites(registry), "pips": _all_pips(registry),
            "signing_out": signing_out(registry) if _has_metadata(registry) else [],
            "yours": {"open": state.get("open") is True, "tabs": tabs, "error": str(state.get("error") or "")[:400]},
            "lanes": _lanes(registry, state), "chrome_account": chrome_account(registry.directory)}


def _all_pips(registry) -> list[dict]:
    """Every Pip on this computer the person may choose for a site (never an archived one), by name."""
    rows = registry.db.execute("SELECT p.id, COALESCE(json_extract(v.definition,'$.name'), '') AS name FROM pips p LEFT JOIN "
                               "pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.status<>'archived' "
                               "ORDER BY name COLLATE NOCASE, p.id LIMIT ?", (MAX_PIPS,)).fetchall()
    return [{"pip_id": r["id"], "name": r["name"]} for r in rows]


def _lane_names(registry, lanes: list[dict]) -> dict:
    """Each lane's name here: a Pip's from this computer's Pips (a Pip no longer here has none, and is left out), a Work
    session's tab (dgc_browser_work, 26 Nov: "work:<session>") the one the supervisor gave it ("Work · lime_tiles")."""
    names = _pip_names(registry, [l["pip_id"] for l in lanes])
    for l in lanes:
        if l["pip_id"] not in names and re.fullmatch(r"work:[A-Za-z0-9_-]{1,64}", l["pip_id"]):
            names[l["pip_id"]] = " ".join(str(l.get("name") or "Work").split())[:80] or "Work"
    return names


def _lanes(registry, state) -> list[dict]:
    """The lanes the supervisor last said, each with its name here (_lane_names)."""
    lanes = [l for l in state.get("lanes", []) if isinstance(l, dict) and isinstance(l.get("pip_id"), str)][:MAX_PIPS] \
        if isinstance(state.get("lanes"), list) else []
    names = _lane_names(registry, lanes)
    # (``state`` is _state's: what a supervisor that still runs said.)
    return [{"pip_id": l["pip_id"], "name": names[l["pip_id"]], "title": str(l.get("title", ""))[:200],
             "url": str(l.get("url", ""))[:2000], "working": l.get("working") is True} for l in lanes if l["pip_id"] in names]


def lanes_now(registry) -> dict:
    """get_dgc_browser_lanes (Pips API 113): the Pips with a tab in DGC Browser, each named and saying whether its run
    is working in it now, and whether any Pip's run is waiting or running on this computer (``runs_live``: while one is,
    the dock asks again every few seconds, so a Pip's new tab shows there at once). Only what the supervisor last said
    and one look at the runs: cheap enough to ask often. Never the person's own tabs."""
    live = registry.db.execute("SELECT 1 FROM pip_runs WHERE status IN ('queued','running','cancelling') LIMIT 1").fetchone()
    return {"lanes": _lanes(registry, _state(registry)), "runs_live": live is not None}


def _has_metadata(registry) -> bool:
    return registry.db.execute("SELECT 1 FROM metadata WHERE key=?", (SIGN_OUTS,)).fetchone() is not None


# What the person types in Home's Browser card (or the streamed tab's address bar): an address opens as itself, anything
# else is a Google search, the search the person's own Chrome makes from its address bar.
SEARCH = "https://www.google.com/search?q="
_ADDRESS = re.compile(r"(?i)(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
                      r"[a-z]{2,63})(?::\d{1,5})?(?:[/?#]\S*)?")


def address(text) -> str:
    """The address to open for what the person typed: a web address as itself (https:// added; http:// for this
    computer or an address on the network), anything else (words, another kind of link) a Google search. "" for
    nothing typed. Never a link with a name and password in it."""
    text = str(text or "").strip()[:2000]
    if not text:
        return ""
    if re.match(r"(?i)https?://", text) and not re.search(r"\s", text):
        parts = urlsplit(text)
        if parts.hostname and parts.username is None and parts.password is None:
            return text
    elif not re.search(r"\s", text) and _ADDRESS.fullmatch(text):
        host = re.split(r"[:/?#]", text, maxsplit=1)[0].lower()
        local = host == "localhost" or host.startswith("[") or re.fullmatch(r"[\d.]+", host) is not None
        return ("http://" if local else "https://") + text
    return SEARCH + quote_plus(text)


# --------------------------------------------------------------------------- where its window goes

MIN_WIDTH = 520                 # narrower than this, Chrome's own bar and a page don't fit beside the editor
SHARE = 0.45                    # over a full-screen editor, the window takes this much of the screen's right side
_MOST = 100_000


def _rect(value, said: str) -> dict:
    if not isinstance(value, dict) or not {"x", "y", "width", "height"} <= set(value):
        raise RegistryError("invalid_request", f"{said} is {{x, y, width, height}} in screen pixels.")
    out = {}
    for name in ("x", "y", "width", "height"):
        number = value[name]
        if type(number) not in (int, float) or isinstance(number, bool) or number != number or abs(number) > _MOST:
            raise RegistryError("invalid_request", f"{said}'s {name} is a number of screen pixels.")
        out[name] = int(round(number))
        if name in ("width", "height") and out[name] < 1:
            raise RegistryError("invalid_request", f"{said}'s {name} is at least one pixel.")
    return out


def editor_bounds(value) -> dict | None:
    """open_dgc_browser's ``editor_bounds`` (API 107): where the editor's window is, and the screen it is on (its work
    area, ``screen``), as the editor measured them; checked. None when not given."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"x", "y", "width", "height", "screen"}:
        raise RegistryError("invalid_request", "editor_bounds is {x, y, width, height, screen?}.")
    bounds = _rect(value, "editor_bounds")
    if value.get("screen") is not None:
        bounds["screen"] = _rect(value["screen"], "editor_bounds.screen")
    return bounds


def place_window(bounds) -> dict | None:
    """Where DGC Browser's window goes, to the RIGHT of the editor (decided 17 Nov): the room between the editor and
    the screen's right edge when there is enough; over a full-screen editor, the right part of the screen. Top and
    height follow the editor's. {left, top, width, height}, or None to let Chrome place itself."""
    if not bounds:
        return None
    editor = bounds
    screen = bounds.get("screen") or {k: editor[k] for k in ("x", "y", "width", "height")}
    right = screen["x"] + screen["width"]
    top = max(screen["y"], editor["y"])
    bottom = min(screen["y"] + screen["height"], editor["y"] + editor["height"])
    if bottom - top < 300:
        top, bottom = screen["y"], screen["y"] + screen["height"]
    room = right - (editor["x"] + editor["width"])
    if room >= MIN_WIDTH:
        left, width = editor["x"] + editor["width"], room
    else:
        width = min(screen["width"], max(MIN_WIDTH, round(screen["width"] * SHARE)))
        left = right - width
    return {"left": int(left), "top": int(top), "width": int(width), "height": int(bottom - top)}


# --------------------------------------------------------------------------- the commands (editor side)

VIEW_OPS = ("frame", "click", "move", "type", "key", "scroll", "go", "back", "forward", "reload", "close")
# Your own tabs, streamed into an editor tab where this computer has no screen (API 107, decided 18 Nov): its frames,
# your own hand in it (input: mouse, keys, text in order), the address bar, your tabs, and the editor tab's size.
OWN_OPS = ("frame", "input", "go", "back", "forward", "reload", "new_tab", "tab", "close_tab", "size", "close",
           "selection")          # the text selected on your page, for your editor's clipboard (Copy, Cut)
OPEN_KEY = "dgc_browser_open"      # metadata: the person's "Open DGC Browser" asks, for the supervisor (newest last)
CLEAR_KEY = "dgc_browser_clear"    # metadata: the person's Clear browsing data ask, for the supervisor (API 112)
CLEARED_KEY = "dgc_browser_cleared"    # metadata: what the supervisor did with it, by the ask's id
CLEAR_WAIT_SECONDS = 60             # Chrome closed, its files cleared and Chrome open again: well within this
CLEAR_POLL_SECONDS = 0.25
_nap = time.sleep                   # (between two looks for the supervisor's answer)
STATE_KEY = "dgc_browser_state"    # metadata: what the supervisor says of it: {open, tabs, lanes, error, at}
VIEW_KEY = "dgc_browser_view"      # metadata: its view socket ({socket, token}), while it runs
MAX_ASKS = 5
MAX_TABS = 50
MAX_EVENTS = 20                     # what one input carries (a few keys, a click): sent in order, then the next
MAX_TEXT = 8000                     # a paste
EVENT_FIELDS = {"t", "x", "y", "button", "buttons", "clicks", "dx", "dy", "key", "code", "text", "mods"}
EVENT_KINDS = ("down", "up", "move", "wheel", "key", "text")
BUTTONS = ("left", "middle", "right", "none")


def _view_here() -> str:
    """How DGC Browser opens for an editor on this computer: its window ("window"), or with no screen (Remote-SSH, a
    server) a tab in the editor streaming your own tab ("tab")."""
    return "window" if has_screen() else "tab"


def _check_open(request) -> None:
    url, pip_id = request.get("url"), request.get("pip_id")
    if url is not None and (not isinstance(url, str) or len(url) > 2000):
        raise RegistryError("invalid_request", "url is an address or a search, up to 2,000 characters.")
    if pip_id is not None and not isinstance(pip_id, str):
        raise RegistryError("invalid_request", "pip_id names a Pip.")


def _number(value, name) -> None:
    if value is not None and (type(value) not in (int, float) or isinstance(value, bool) or value != value
                              or abs(value) > 100_000):
        raise RegistryError("invalid_request", f"{name} is a number.")


def _check_events(events) -> None:
    if not isinstance(events, list) or not 1 <= len(events) <= MAX_EVENTS:
        raise RegistryError("invalid_request", f"events is a list of 1 to {MAX_EVENTS} of your own clicks, keys and text.")
    for event in events:
        if not isinstance(event, dict) or event.get("t") not in EVENT_KINDS or set(event) - EVENT_FIELDS:
            raise RegistryError("invalid_request", "Each event is a click, a move, the wheel, a key or text.")
        for name in ("x", "y", "dx", "dy"):
            _number(event.get(name), name)
        for name, most in (("clicks", 3), ("buttons", 31), ("mods", 15)):
            value = event.get(name)
            if value is not None and (type(value) is not int or not 0 <= value <= most):
                raise RegistryError("invalid_request", f"{name} is a small whole number.")
        if event.get("button") is not None and event["button"] not in BUTTONS:
            raise RegistryError("invalid_request", "button is left, middle or right.")
        for name, most in (("key", 40), ("code", 40), ("text", MAX_TEXT)):
            value = event.get(name)
            if value is not None and (not isinstance(value, str) or len(value) > most):
                raise RegistryError("invalid_request", f"{name} is text up to {most} characters.")
        if event["t"] in ("down", "up", "move", "wheel") and not ({"x", "y"} <= set(event)):
            raise RegistryError("invalid_request", "A click, a move or the wheel says where (x, y).")
        if event["t"] == "key" and not event.get("key"):
            raise RegistryError("invalid_request", "A key says which (key).")
        if event["t"] == "text" and not isinstance(event.get("text"), str):
            raise RegistryError("invalid_request", "Text says what (text).")


def _check_view(request) -> None:
    _check_open(request)
    own = request.get("own")
    if own is not None and own is not True:
        raise RegistryError("invalid_request", "own is true: your own tab.")
    if request.get("op") not in (OWN_OPS if own else VIEW_OPS):
        raise RegistryError("invalid_request", "op is one of " + ", ".join(OWN_OPS if own else VIEW_OPS) + ".")
    for name in ("x", "y", "dy"):
        _number(request.get(name), name)
    for name, most in (("text", 4000), ("key", 40), ("tab", 100)):
        value = request.get(name)
        if value is not None and (not isinstance(value, str) or len(value) > most):
            raise RegistryError("invalid_request", f"{name} is text up to {most} characters.")
    for name in ("seq", "width", "height"):
        value = request.get(name)
        if value is not None and (type(value) is not int or not 0 <= value <= 2 ** 53):
            raise RegistryError("invalid_request", f"{name} is a whole number.")
    if request.get("events") is not None:
        _check_events(request["events"])


def _runner_live(registry) -> bool:
    """Whether the Pips runner (the supervisor, which owns DGC Browser's one window) runs now."""
    from .pip_daemon import runner_status
    from .pip_runtime import supervisor_is_live
    try:
        return supervisor_is_live(registry.directory, runner_status(registry))
    except RegistryError:
        return False


def _known_pip(registry, pip_id) -> None:
    if registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
        raise RegistryError("not_found", "That Pip isn't on this computer.")


def open_window(registry, request) -> dict:
    """open_dgc_browser {url?, pip_id?, editor_bounds?}: the supervisor opens DGC Browser's window (or brings it
    forward) to the right of the editor, at what the person typed (a new tab of theirs) or at a Pip's own tab. Asked
    through the registry, as a Pip's computer is opened; ready within a couple of seconds. Where this computer has no
    screen (Remote-SSH, a server) Chrome runs headless and the answer's ``view`` is "tab": the editor opens a tab that
    streams the person's own tab (use_dgc_browser_view own); else "window"."""
    _check_open(request)
    bounds = editor_bounds(request.get("editor_bounds"))
    pip_id = request.get("pip_id")
    if pip_id is not None:
        _known_pip(registry, pip_id)
    try:
        available, reason, _ = _availability()
    except Exception as exc:                      # noqa: BLE001
        available, reason = False, f"DGC couldn't check for Google Chrome: {exc}"[:400]
    if not available:
        raise RegistryError("unavailable", reason)
    if not _runner_live(registry):
        raise RegistryError("runner_required", "DGC Browser opens with the Pips runner, which isn't running. Start the "
                                               "runner in Pips, then open it again.")
    view = _view_here()
    url = address(request.get("url"))
    ask = {"url": url, "place": place_window(bounds) if view == "window" else None, "at": registry.clock(),
           **({"pip_id": pip_id} if pip_id else {}), **({"headless": True} if view == "tab" else {})}
    with registry.transaction():
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (OPEN_KEY,)).fetchone()
        try:
            asks = json.loads(row[0]) if row else []
        except (TypeError, ValueError):
            asks = []
        asks = [a for a in asks if isinstance(a, dict)] if isinstance(asks, list) else []
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (OPEN_KEY, json.dumps((asks + [ask])[-MAX_ASKS:])))
    return {"ok": True, "kind": KIND, "weaker": True, "url": url, "open": _state(registry).get("open") is True,
            "view": view}


def _clear_kinds(request) -> list[str]:
    """What the person ticked (history, sign_ins, passwords: each true or false, at least one true), checked."""
    for name in CLEAR_KINDS:
        value = request.get(name)
        if value is not None and type(value) is not bool:
            raise RegistryError("invalid_request", f"{name} is true or false.")
    kinds = [name for name in CLEAR_KINDS if request.get(name) is True]
    if not kinds:
        raise RegistryError("invalid_request", "Choose what to clear: browsing history, sign-ins or saved passwords.")
    return kinds


def clear(registry, request) -> dict:
    """clear_dgc_browser {history, sign_ins, passwords} (API 112, the person's own ask, local only): clears what was
    ticked from DGC's own profile for DGC Browser. Chrome's files are cleared only with Chrome stopped, so with the Pips
    runner on (it owns DGC Browser's Chrome) the supervisor closes it, clears and opens it again if it was open; with
    the runner off nothing of DGC's runs Chrome and it is cleared here at once (never under a Chrome that still holds
    the profile). Answers {ok, cleared, reopened, chrome_account}."""
    kinds = _clear_kinds(request)
    account = chrome_account(registry.directory)
    if not _runner_live(registry):
        if _profile_in_use(registry.directory):
            raise RegistryError("busy", "DGC Browser is still open on this computer. Close it, then clear again.")
        return {"ok": True, "cleared": clear_profile(registry.directory, kinds), "reopened": False, "chrome_account": account}
    import secrets
    ask = {"id": secrets.token_hex(8), **{name: name in kinds for name in CLEAR_KINDS}, "at": registry.clock()}
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (CLEAR_KEY, json.dumps(ask)))
    deadline = time.monotonic() + CLEAR_WAIT_SECONDS
    while time.monotonic() < deadline:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (CLEARED_KEY,)).fetchone()
        try:
            said = json.loads(row[0]) if row else None
        except (TypeError, ValueError):
            said = None
        if isinstance(said, dict) and said.get("id") == ask["id"]:
            with registry.transaction():
                registry.db.execute("DELETE FROM metadata WHERE key=?", (CLEARED_KEY,))
            if said.get("ok") is not True:
                raise RegistryError("clear_failed", str(said.get("error") or "DGC Browser couldn't clear that.")[:400])
            return {"ok": True, "cleared": [k for k in CLEAR_KINDS if k in (said.get("cleared") or [])],
                    "reopened": said.get("reopened") is True, "chrome_account": account}
        _nap(CLEAR_POLL_SECONDS)
    raise RegistryError("timeout", "DGC Browser didn't answer in time, so it may not have cleared everything. Try again.")


def answer_clear(registry, ask_id, result: dict) -> None:
    """The supervisor's answer to a Clear browsing data ask, for the editor's side waiting on it."""
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                            (CLEARED_KEY, json.dumps({**result, "id": str(ask_id or "")[:40]})))


def recent(registry) -> dict:
    """get_dgc_browser_recent (API 107): the last links the person visited in DGC Browser (their own tabs only, never
    a Pip's lane), the newest first: titles and addresses, for Home's Browser card; the Pips' lanes, which the dock's
    Browser menu offers to watch in a streamed tab; Install Google Chrome where it is needed (``install``, else None);
    and how it opens here (``view``: "window", or "tab" where this computer has no screen)."""
    try:
        available, reason, _ = _availability()
    except Exception as exc:                      # noqa: BLE001
        available, reason = False, f"DGC couldn't check for Google Chrome: {exc}"[:400]
    state = _state(registry)
    return {"links": recent_links(registry.directory, RECENT_SHOWN), "open": state.get("open") is True,
            "available": available, "reason": reason, "lanes": _lanes(registry, state),
            "new_sites": sum(1 for s in sites(registry) if s["new"]),
            "install": _offer(registry.directory, available, reason), "view": _view_here(),
            "chrome_account": chrome_account(registry.directory)}


def view_endpoint(registry) -> dict | None:
    """The supervisor's view socket for DGC Browser ({socket, token}) while it runs, else None. For the editor's side
    only: the token never leaves the backend."""
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (VIEW_KEY,)).fetchone()
    try:
        endpoint = json.loads(row[0]) if row else None
    except (TypeError, ValueError):
        endpoint = None
    if not isinstance(endpoint, dict) or not isinstance(endpoint.get("socket"), str):
        return None
    return {"socket": endpoint["socket"], "token": str(endpoint.get("token", ""))}


def _view_socket(registry, request: dict) -> dict:
    """One request to the supervisor's view socket (its token from the registry); its reply."""
    endpoint = view_endpoint(registry)
    if endpoint is None:
        return {"ok": False, "closed": True, "error": "DGC Browser is closed. Open it from the dock."}
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(30)
            client.connect(endpoint["socket"])
            client.sendall(json.dumps({**request, "token": endpoint.get("token", "")}).encode() + b"\n")
            raw = b""
            while not raw.endswith(b"\n") and len(raw) < 16 << 20:
                chunk = client.recv(1 << 20)
                if not chunk:
                    break
                raw += chunk
        reply = json.loads(raw.decode("utf-8"))
        return reply if isinstance(reply, dict) else {"ok": False, "error": "No reply from DGC Browser."}
    except (OSError, ValueError):
        return {"ok": False, "closed": True, "error": "DGC Browser closed. Open it again from the dock."}


def view_call(registry, request, actor: str = "editor-user") -> dict:
    """use_dgc_browser_view: the editor's side of a streamed tab, one request to the supervisor's view socket.

    A Pip's lane (``pip_id``), as in phase 3. Or, where this computer has no screen, YOUR OWN tab (``own`` true: his
    call, 18 Nov): only you drive it, through that editor tab (the editor's own actor, never the command line, a Pip, a
    model or a tool); where there is a screen your tabs are in its window, never streamed."""
    _check_view(request)
    pip_id, op = request.get("pip_id"), request["op"]
    if request.get("own") is True:
        if pip_id is not None:
            raise RegistryError("invalid_request", "Your own tab or a Pip's: not both.")
        if actor != "editor-user":
            raise RegistryError("local_only", "Only you, in DGC Browser's tab in the editor, can use your own tabs.")
        if has_screen():
            raise RegistryError("invalid_request", "On this computer your own tabs are in DGC Browser's window.")
        if op == "close":
            # (The editor tab closed: the supervisor stops its stream and forgets its last picture.)
            _view_socket(registry, {"op": "close", "own": True})
            return {"ok": True, "closed": True}
        fields = {k: v for k, v in request.items() if k in ("url", "seq", "events", "tab", "width", "height")}
        return _view_socket(registry, {"op": op, "own": True, **fields})
    if not pip_id:
        raise RegistryError("invalid_request", "Name the Pip whose tab to show: your own tabs show in DGC Browser's window.")
    # A Work session's tab (dgc_browser_work, 26 Nov: "work:<session>") is watched as a Pip's is; the supervisor shows
    # only a tab that is that owner's (lane_of), so a name with no tab shows nothing.
    if not (isinstance(pip_id, str) and re.fullmatch(r"work:[A-Za-z0-9_-]{1,64}", pip_id)):
        _known_pip(registry, pip_id)
    if op == "close":
        return {"ok": True, "closed": True}
    fields = {k: v for k, v in request.items() if k in ("x", "y", "text", "key", "dy", "url")}
    said = _view_socket(registry, {"op": op, "pip_id": pip_id, **fields})
    if isinstance(said, dict) and isinstance(said.get("lanes"), list):
        # The tab's row of Pips, each by its name here (the supervisor knows a Pip's name only from the run that opened
        # its tab); a Pip no longer on this computer is left out.
        lanes = [l for l in said["lanes"] if isinstance(l, dict) and isinstance(l.get("pip_id"), str)][:MAX_PIPS]
        names = _lane_names(registry, lanes)
        said = {**said, "lanes": [{**l, "name": names[l["pip_id"]]} for l in lanes if l["pip_id"] in names]}
    return said


def control(registry, command: str, request: dict, actor: str) -> dict:
    """The DGC Browser commands (Pips API 105, 107, 112, 113), from handle_control. Every one is local only."""
    _local(actor, "DGC Browser is on this computer only.")
    if command == "get_dgc_browser":
        return get(registry)
    if command == "get_dgc_browser_recent":
        return recent(registry)
    if command == "set_dgc_browser_site":
        return set_site(registry, request.get("site"), request.get("mode"), request.get("pips"), actor)
    if command == "sign_out_dgc_browser_site":
        return sign_out_site(registry, request.get("site"), actor)
    if command == "open_dgc_browser":
        return open_window(registry, request)
    if command == "use_dgc_browser_view":
        return view_call(registry, request, actor)
    if command == "install_google_chrome":
        return install_chrome(registry)
    if command == "clear_dgc_browser":
        return clear(registry, request)
    if command == "seen_dgc_browser_sites":
        return seen_sites(registry, actor)
    if command == "get_dgc_browser_lanes":
        return lanes_now(registry)
    raise RegistryError("unsupported_command", "This runner does not support that Pip command.")


COMMANDS = frozenset({"get_dgc_browser", "set_dgc_browser_site", "sign_out_dgc_browser_site", "open_dgc_browser",
                      "use_dgc_browser_view", "get_dgc_browser_recent", "install_google_chrome", "clear_dgc_browser",
                      "seen_dgc_browser_sites", "get_dgc_browser_lanes"})
COMMAND_ARGS = {
    "get_dgc_browser": set(),
    "get_dgc_browser_recent": set(),
    "set_dgc_browser_site": {"site", "mode", "pips"},
    "sign_out_dgc_browser_site": {"site"},
    "open_dgc_browser": {"url", "pip_id", "editor_bounds"},
    "use_dgc_browser_view": {"op", "x", "y", "text", "key", "dy", "url", "pip_id",
                              "own", "seq", "events", "tab", "width", "height"},
    "install_google_chrome": set(),
    "clear_dgc_browser": {"history", "sign_ins", "passwords"},
    "seen_dgc_browser_sites": set(),
    "get_dgc_browser_lanes": set(),
}


# --------------------------------------------------------------------------- the profile

def profile_prefs(profile: Path) -> bool:
    """Third-party cookies off in DGC Browser's profile (decision 2: safer between sites), set before every start, as
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


# --------------------------------------------------------------------------- Clear browsing data (API 112)
# What it clears, and how, is in its own module (dgc_browser_clear): only ever DGC's own profile for DGC Browser.
from .dgc_browser_clear import CLEAR_KINDS, chrome_account, clear_profile, _profile_in_use  # noqa: E402,F401


# --------------------------------------------------------------------------- what each lane sent

class LaneSent:
    """What each Pip's lane sent, per site (decision 8): from the lane's own Network events, never the person's tabs.
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


# --------------------------------------------------------------------------- the last links the person visited

RECENT_FILE = "recent.json"
RECENT_KEEP = 12
RECENT_SHOWN = 3
RECENT_WRITE_SECONDS = 2.0
RECENT_ICON_CHARS = 32_000      # a site's icon kept with its link for Home's card: a small picture only (about 24 KB)
_RECENT_ICON = re.compile(r"^data:image/(png|x-icon|svg\+xml|gif|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$")


def _icon(value) -> str:
    """A site's icon as Home's card may draw it: a small data: picture, else nothing (the card draws its globe)."""
    return value if isinstance(value, str) and len(value) <= RECENT_ICON_CHARS and _RECENT_ICON.match(value) else ""


def _link(url, title, at, icon="") -> dict | None:
    url, title = str(url or ""), str(title or "")
    parts = urlsplit(url)
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None
            or parts.password is not None or len(url) > 2000):
        return None
    link = {"url": url, "title": title[:200], "host": parts.hostname.lower()[:253], "at": str(at or "")[:40]}
    if _icon(icon):
        link["icon"] = icon
    return link


def recent_links(directory, n: int = RECENT_SHOWN) -> list[dict]:
    """The newest ``n`` links from the person's own tabs in DGC Browser (titles and addresses only), from its folder;
    a row that isn't one is left out, a file that can't be read gives none."""
    path = folder(directory) / RECENT_FILE
    try:
        if path.is_symlink():
            return []
        rows = json.loads(path.read_text(encoding="utf-8")).get("links", [])
    except (OSError, ValueError, AttributeError):
        return []
    out = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict) and isinstance(row.get("title", ""), str):
            link = _link(row.get("url"), row.get("title"), row.get("at"), row.get("icon"))
            if link is not None and all(l["url"] != link["url"] for l in out):
                out.append(link)
        if len(out) >= n:
            break
    return out


class Recent:
    """The person's own visits, kept for Home's Browser card: each new address (or a newer title for one) moves to the
    front; at most RECENT_KEEP; written at most every couple of seconds. Only ever told about the person's own tabs."""

    def __init__(self, path: Path, clock=time.monotonic):
        self.path = Path(path)
        self.clock = clock
        self.links = recent_links(self.path.parent.parent, RECENT_KEEP) if self.path.name == RECENT_FILE else []
        self.dirty = False
        self.written = 0.0

    def note(self, url, title, visit: bool = True, icon: str = "") -> None:
        """A tab of the person's is at ``url`` (``visit``: it just went there) or its page's title changed; ``icon``:
        its site's icon when DGC Browser has it already."""
        link = _link(url, title, utc_now(), icon)
        if link is None:
            return
        old = next((l for l in self.links if l["url"] == link["url"]), None)
        if "icon" not in link:
            # (The icon this site's other links wear, or this link's own from before: kept.)
            known = next((l.get("icon") for l in ([old] if old else []) + self.links
                          if l and l.get("icon") and l["host"] == link["host"]), "")
            if known:
                link["icon"] = known
        if old is not None and not visit:
            if link["title"] and old["title"] != link["title"]:
                old["title"] = link["title"]             # a title that came after its address: in place
                self.dirty = True
            return
        if old is not None and self.links[0] is old and old["title"] == link["title"]:
            return
        if old is not None and not link["title"]:
            link["title"] = old["title"]                 # a page reloading says no title for a moment
        self.links = [link] + [l for l in self.links if l["url"] != link["url"]][:RECENT_KEEP - 1]
        self.dirty = True

    def wear(self, url, icon) -> None:
        """A site's icon arrived for ``url``: that link and its site's other links without one wear it."""
        icon = _icon(icon)
        host = (urlsplit(str(url or "")).hostname or "").lower()
        if not icon or not host:
            return
        for link in self.links:
            if link["host"] == host and (link["url"] == url or not link.get("icon")) and link.get("icon") != icon:
                link["icon"] = icon
                self.dirty = True

    def write_due(self, force: bool = False) -> None:
        if not self.dirty or (not force and self.clock() - self.written < RECENT_WRITE_SECONDS):
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.is_symlink():
                return
            temp = self.path.with_name(self.path.name + ".tmp")
            temp.write_text(json.dumps({"links": self.links}), encoding="utf-8")
            os.chmod(temp, 0o600)
            os.replace(temp, self.path)
            self.dirty, self.written = False, self.clock()
        except OSError:
            return


# --------------------------------------------------------------------------- its window: Chrome on this computer

from .browser import BrowserError                                     # noqa: E402
from .pip_computer_box import (PERSON, BoxError, BoxedBrowser, HeldWrite, _PageChannel, _Pipe,  # noqa: E402,F401
                               _PIPE_EXEC)

IDLE_SECONDS = 15 * 60          # no Pip lane and no window of the person's: it closes (its profile stays)
CLOSE_SECONDS = 4.0             # how long a closing Chrome is given to close by itself before it is stopped
FRAME_SECONDS = 0.25            # the streamed tab gets at most four pictures a second
FRESH_SECONDS = 1.0             # a screencast frame this new is the lane as it is
CAST_SECONDS = 10.0             # a lane nobody has looked at for this long stops being cast
CAPTURE_SECONDS = 4.0           # a picture that takes longer (a page mid-load) waits for the next ask
USER_WRITE_SECONDS = 3.0        # a write right after the person's own click in a Pip's tab is theirs
LANE_IDLE_SECONDS = 10 * 60     # a Pip's lane with no run and nothing waiting for the person closes after this
LANE_MARK = " \u00b7 "          # a lane's tab title: "<Pip> · <the page's own title>" (lane_title_script)
OWN_FRAME_SECONDS = 1 / 30      # your own tab, streamed where there is no screen: every frame, up to thirty a second
OWN_WAIT_SECONDS = 0.5          # a frame asked for waits this long for one newer than the last the tab has
OWN_QUALITY = 70                # its frames' JPEG quality
OWN_SIZE = (1280, 800)          # the headless window before the editor tab says its size
# Where the computer has no screen (Remote-SSH, a server) and Xvfb is there, Chrome runs as a real window on a screen of
# its own, as a Pip's computer does: headless Chrome says "HeadlessChrome", and Google's sign-in and reCAPTCHA turn it
# away (20 Nov). Drawn at twice the pixels, so its pictures stay sharp on a Retina screen; the page's own size is unchanged.
SCREEN_SCALE = 2
SCREEN_PIXELS = (5120, 3200)


ICON_BYTES = 100_000
_ICON_TYPES = ("image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml", "image/gif", "image/jpeg",
               "image/webp")


def icon_data(body: bytes, kind: str) -> str | None:
    """A site's icon as a data: address for a tab, or None when it isn't a small picture."""
    import base64
    kind = str(kind or "").split(";")[0].strip().lower()
    if kind == "image/vnd.microsoft.icon":
        kind = "image/x-icon"
    if not body or len(body) > ICON_BYTES or kind not in _ICON_TYPES:
        return None
    return f"data:{kind};base64," + base64.b64encode(body).decode("ascii")


def fetch_icon(url: str):
    """A site's public icon, as anyone would get it (no cookies, no sign-in): (bytes, type), or None."""
    import urllib.request
    if not re.match(r"^https?://", str(url or ""), re.I):
        return None
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "image/*"})
        with urllib.request.urlopen(request, timeout=4) as response:   # noqa: S310 -- http(s) only, checked above
            return response.read(ICON_BYTES + 1), response.headers.get("Content-Type", "")
    except (OSError, ValueError):
        return None


def start_virtual_screen(which=shutil.which):
    """A private X screen for DGC Browser's Chrome: (":N", its process), or None when there is no Xvfb or it didn't
    come up. Its own display number, never one another program holds."""
    xvfb = which("Xvfb")
    if not xvfb:
        return None
    for number in range(140, 200):
        if Path(f"/tmp/.X11-unix/X{number}").exists() or Path(f"/tmp/.X{number}-lock").exists():
            continue
        try:
            proc = subprocess.Popen([xvfb, f":{number}", "-screen", "0", f"{SCREEN_PIXELS[0]}x{SCREEN_PIXELS[1]}x24",
                                     "-nolisten", "tcp"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            return None
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if Path(f"/tmp/.X11-unix/X{number}").exists():
                return f":{number}", proc
            if proc.poll() is not None:
                break                            # someone took the number first: the next one
            time.sleep(0.05)
        else:
            proc.terminate()
            return None
    return None


# Where the computer has no screen, DGC Browser's screen is the program a Pip's computer draws on (TigerVNC's Xtigervnc):
# an X screen that is also a VNC screen, so the editor's tab shows it with the Pip computer's own viewer and stream (the
# picture as it changes, the person's own mouse and keys straight to it), never a picture asked for at a time. It is
# Chrome's real window: its tabs, address bar, menus, dropdowns and password manager. It listens on one Unix socket in
# this user's private socket folder (mode 0600), never a port; the supervisor's view socket joins the editor to it.
# One of the screen's pixels for each of the page's, as a Pip's computer draws (measured 22 Nov in the editor's tab, the
# same page size: 35 pictures a second scrolling and 32 for a video at this, 15 and 10 at twice the pixels, for the
# same bytes; a click or a key shows in about 30 ms at both). The plain screen's pictures stay at SCREEN_SCALE.
VNC_SCALE = 1
VNC_START_SECONDS = 6
SCREEN_IDLE_SECONDS = 6 * 3600  # a screen stream with nothing on it for this long ends (the tab opens it again)
LANE_GAP = 400                  # how far left of the screen's edge a Pip's lane window sits, so it is never on it


def vnc_program() -> Path | None:
    """The program a Pip's computer draws its screen with (Xtigervnc: DGC's own downloaded copy first, else the
    system's), or None where there is neither (then DGC Browser's screen is a plain one and its tab shows pictures)."""
    try:
        from . import pip_screen
        found = pip_screen.components()["found"].get("vnc")
    except Exception:                        # noqa: BLE001 - no program: the plain screen and pictures, as before
        return None
    return Path(found) if found else None


def fetch_screen_program() -> bool:
    """Where a Pip computer's screen program isn't here yet: the download a Pip's computer starts (pip_screen_setup: no
    password, nothing installed on the system, DGC's own folder), so DGC Browser is the same screen as a Pip's
    computer from its next start. True when a download was started or is running."""
    try:
        from . import pip_screen_setup
        if not pip_screen_setup.supported()[0]:
            return False
        needs = pip_screen_setup.wanted()
        if pip_screen_setup.DESKTOP_PACKAGES["vnc"] not in needs:
            return False
        return bool(pip_screen_setup.start(needs=needs))
    except Exception:                        # noqa: BLE001 - a download never costs DGC Browser its pictures
        return False


def screen_pixels(size) -> tuple[int, int]:
    """The VNC screen's pixels for a page of ``size`` (the editor tab's), drawn at VNC_SCALE."""
    return int(size[0]) * VNC_SCALE, int(size[1]) * VNC_SCALE


def start_vnc_screen(size=None, *, program=None, popen=subprocess.Popen, folder=None, x11=Path("/tmp/.X11-unix")):
    """DGC Browser's own VNC screen: (":N", its process, its socket), or None when there is no program or it didn't come
    up. Its own display number, never one another program holds; its pictures and the person's input only through its
    one socket (no TCP at all, no password: the socket's folder and mode are the door, this user's only)."""
    program = Path(program) if program is not None else vnc_program()
    if program is None:
        return None
    if folder is None:
        from .pip_computer import socket_dir
        folder = socket_dir()
    width, height = screen_pixels(size or OWN_SIZE)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    from . import browser_setup
    libs = browser_setup.library_path(program)             # DGC's own copy brings its libraries
    if libs:
        env["LD_LIBRARY_PATH"] = libs
    for number in range(140, 200):
        if (Path(x11) / f"X{number}").exists() or Path(f"/tmp/.X{number}-lock").exists():
            continue
        sock = Path(folder) / f"yb-{os.getpid()}-{number}.vnc"
        try:
            sock.unlink()
        except OSError:
            pass
        # (-terminate: it ends by itself once its last window program, Chrome, is gone, even when the supervisor that
        # started it was stopped without closing it.)
        argv = [str(program), f":{number}", "-geometry", f"{width}x{height}", "-depth", "24", "-SecurityTypes", "None",
                "-AlwaysShared", "-rfbunixpath", str(sock), "-rfbunixmode", "0600", "-rfbport", "-1",
                "-nolisten", "tcp", "-terminate", "-desktop", "DGC Browser"]
        try:
            proc = popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        except OSError:
            return None
        deadline = time.monotonic() + VNC_START_SECONDS
        while time.monotonic() < deadline:
            if (Path(x11) / f"X{number}").exists() and sock.exists():
                return f":{number}", proc, sock
            if proc.poll() is not None:
                break                            # someone took the number first: the next one
            time.sleep(0.05)
        else:
            proc.terminate()
            return None
    return None


OWN_MOST = (3840, 2400)
# What Chrome needs from this computer's environment, and nothing else (never a key or token the supervisor holds): the
# screen it draws on, the session bus the computer's password store answers on, the language and the time zone.
ENV_KEEP = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY",
            "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_DATA_DIRS",
            "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "DESKTOP_SESSION", "GNOME_KEYRING_CONTROL", "KDE_FULL_SESSION")


def chrome_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k in ENV_KEEP or k.startswith("LC_")}
    return env


_SECRETS = ("org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default", "org.freedesktop.Secret.Collection")


def store_unlocked(env: dict, *, run=subprocess.run, which=shutil.which) -> bool | None:
    """Whether the computer's password store is open: its default collection's Locked property, read over the session
    bus Chrome would use (busctl, else gdbus), in a few seconds at most and never with a prompt. None when it can't be
    told: no session bus, no tool, no store answering."""
    if not env.get("DBUS_SESSION_BUS_ADDRESS"):
        return None
    name, path, interface = _SECRETS
    asks = (["busctl", "--user", "get-property", name, path, interface, "Locked"],
            ["gdbus", "call", "--session", "--dest", name, "--object-path", path, "--method",
             "org.freedesktop.DBus.Properties.Get", interface, "Locked"])
    for argv in asks:
        if not which(argv[0]):
            continue
        try:
            done = run(argv, env=dict(env), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3,
                       check=False)
        except (OSError, subprocess.SubprocessError):
            return None
        if done.returncode != 0:
            return None
        said = str(done.stdout or "").strip()
        if said in ("b true", "(<true>,)"):
            return False
        if said in ("b false", "(<false>,)"):
            return True
        return None
    return None


def chrome_argv(chrome, profile: Path, url: str = "", place: dict | None = None, test_flags=(), *,
                headless: bool = False, own_store: bool = False, virtual: bool = False, scale: int = SCREEN_SCALE) -> list[str]:
    """Full Google Chrome as the person's own window: DGC's profile, its DevTools over a pipe only DGC holds (never a
    port another program could reach), and nothing turned off. Its sandbox, sync, extensions, saved passwords and the
    computer's password store all stay on; it isn't marked as automated (Google's sign-in refuses a browser that is).
    ``headless`` (no screen here: Remote-SSH, a server): the same full Chrome, drawing for the editor's streamed tab
    instead of a window (--headless=new is full Chrome, not a cut-down one). ``own_store``: headless with the
    computer's password store locked or unknown (store_unlocked), Chrome keeps sign-ins with its own built-in key from
    the start instead of asking the store to unlock, which nobody can answer there: every start waited ~21-25 s for it
    (Chrome 158, 18 Nov) and then did the same."""
    # --test-type: Chrome otherwise puts "You are using an unsupported command-line flag" across the top of every
    # start for the flag that keeps it from being marked as automated; it keeps only Chrome's start-up bars away.
    # --profile-directory=Default: always DGC's own profile, never Chrome's profile picker. A second profile in the folder
    # (Chrome's sign-in or "Add profile" makes one) opened the picker: no tab came, and DGC Browser gave up after 15 s
    # with "its window never opened", the tab on "Opening DGC Browser…" for ever (25 Nov).
    argv = [str(chrome), "--remote-debugging-pipe", f"--user-data-dir={profile}", "--profile-directory=Default",
            "--no-first-run",
            "--no-default-browser-check", "--disable-blink-features=AutomationControlled", "--test-type", *test_flags]
    if headless and virtual:
        # A real window on its own screen (start_virtual_screen), streamed like a headless one. A Pip's lane there is a
        # window of its own off that screen (DgcBrowserHost.new_lane_tab), which Chrome would otherwise count as hidden:
        # no pictures and no clicks for it (checked, Chrome 158). Nothing else shares that screen.
        argv += ["--window-position=0,0", f"--window-size={OWN_SIZE[0]},{OWN_SIZE[1]}",
                 f"--force-device-scale-factor={scale}", "--disable-backgrounding-occluded-windows"]
        if own_store:
            argv.append("--password-store=basic")
    elif headless:
        argv += ["--headless=new", f"--window-size={OWN_SIZE[0]},{OWN_SIZE[1]}"]
        if own_store:
            argv.append("--password-store=basic")
    elif place:
        argv += [f"--window-position={place['left']},{place['top']}", f"--window-size={place['width']},{place['height']}"]
    if url:
        argv.append(url)
    return argv


def launch_chrome(argv: list[str], env: dict, log_path: Path):
    """Start Chrome with its DevTools pipe on fds 3 and 4 (the only way in). Returns (process, pipe)."""
    from . import browser_setup
    libs = browser_setup.library_path(Path(argv[0]))
    if libs:
        env = {**env, "LD_LIBRARY_PATH": libs}
    command_read, command_write = os.pipe()
    reply_read, reply_write = os.pipe()
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "ab") as log:
            proc = subprocess.Popen([sys.executable, "-c", _PIPE_EXEC, str(command_read), str(reply_write), *argv],
                                    pass_fds=(command_read, reply_write), stdin=subprocess.DEVNULL, stdout=log,
                                    stderr=log, env=env, start_new_session=True)
    except BaseException:
        for fd in (command_read, command_write, reply_read, reply_write):
            os.close(fd)
        raise
    os.close(command_read)
    os.close(reply_write)
    pipe = _Pipe(reply_read, command_write)
    pipe.fds = (reply_read, command_write)
    return proc, pipe


# Sites noticed from the person's own sign-ins: DGC's watcher in its own world of each of their pages (never
# a Pip's lane) tells DGC the page's host when they send a password from it themselves: a trusted key press or click of
# theirs on the page in the last seconds, with a password box that has something in it. The page's own scripts can't call
# it (the binding lives in DGC's world only), can't fake a person's key or click, and never learn it is there. Nothing they
# type is read out or kept: only the host, its path and title, and whether the page has a card number box.
NOTICE_WORLD = "dgc-notice"
NOTICE_BINDING = "dgcSignedIn"
SSO_FOLLOW_SECONDS = 60             # a sign-in host's page, then this tab lands on another site soon after: that site's
# A site's sign-in host (accounts.example.com, login.example.com): a sign-in there that lands on another site soon after
# is that site's sign-in (an address the person typed elsewhere is never taken for one: only a sign-in host's).
SIGN_IN_HOST = re.compile(r"^(?:accounts?|login|logon|signin|sign-in|auth|sso|id|identity|passport|secure)\d*\.", re.I)
NOTICE_SCRIPT = r"""(() => { if (window.__dgcNotice) return; window.__dgcNotice = true;
  const tell = globalThis.%s; if (typeof tell !== 'function') return;
  let acted = 0, sent = false;
  const own = (e) => e.isTrusted;
  addEventListener('keydown', (e) => { if (own(e)) acted = Date.now(); }, true);
  addEventListener('pointerdown', (e) => { if (own(e)) acted = Date.now(); }, true);
  const card = () => !!document.querySelector('input[autocomplete^="cc-"], input[name*="card" i][name*="num" i], input[id*="card" i][id*="num" i]');
  const check = () => {
    if (sent || Date.now() - acted > 10000) return;
    if (![...document.querySelectorAll('input[type=password]')].some((el) => el.value)) return;
    sent = true;
    try { tell(JSON.stringify({host: location.hostname, path: location.pathname.slice(0, 200),
                               title: (document.title || '').slice(0, 200), card: card(), trusted: true})); } catch (e) {}
  };
  addEventListener('submit', () => check(), true);
  addEventListener('keydown', (e) => { if (own(e) && e.key === 'Enter') setTimeout(check, 0); }, true);
  addEventListener('click', (e) => { if (!own(e)) return;
    const b = e.target && e.target.closest ? e.target.closest('button, input[type=submit], input[type=image], [role=button]') : null;
    if (b) setTimeout(check, 0); }, true);
})()""" % NOTICE_BINDING

# A Pip's step inside a page Chrome doesn't draw (its lane in the background of the person's window, on a computer with a
# screen): Chrome hands such a tab no input, so a click, typing, a key and a scroll are done in DGC's own world of the page,
# as a person's would land (the page's own handlers see them; what they send is held as ever).
IN_PAGE_JS = r"""function (op, ref, text, replace, key, dy) { /* dgcInPage */
  if (op === 'scroll') { window.scrollBy(0, Number(dy) || 0); return {ok: true}; }
  const el = ref ? document.querySelector('[data-dgc-ref="' + ref + '"]') : (document.activeElement || document.body);
  if (!el) return {ok: false, missing: true};
  const secret = (el.type || '').toLowerCase() === 'password' || el.hasAttribute('data-dgc-secret')
    || (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).some((t) => /^(cc-|current-password$|new-password$|one-time-code$)/.test(t))
    || /pass(word|wd|code)?|pwd|otp|cvv|cvc|card.?num|security.?code/i.test((el.name || '') + ' ' + (el.id || ''));
  const label = (el.innerText || (secret ? '' : el.value) || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (el.disabled) return {ok: false, disabled: true};
  const at = () => { const r = el.getBoundingClientRect(); return {clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}; };
  const fire = (type, Kind, extra) => el.dispatchEvent(new Kind(type, {bubbles: true, cancelable: true, composed: true, view: window, ...extra}));
  if (op === 'click' || op === 'hover') {
    el.scrollIntoView({block: 'center', inline: 'center'});
    const p = at();
    fire('pointerover', PointerEvent, p); fire('mouseover', MouseEvent, p); fire('pointermove', PointerEvent, p); fire('mousemove', MouseEvent, p);
    if (op === 'hover') return {ok: true, label};
    const a = el.closest ? el.closest('a[href]') : null;
    if (a && /^_(blank|new)$/i.test(a.target || '')) return {ok: true, label, open: a.href};
    fire('pointerdown', PointerEvent, {...p, button: 0, buttons: 1}); fire('mousedown', MouseEvent, {...p, button: 0, buttons: 1});
    if (el.focus) el.focus({preventScroll: true});
    fire('pointerup', PointerEvent, {...p, button: 0}); fire('mouseup', MouseEvent, {...p, button: 0});
    el.click();
    return {ok: true, label};
  }
  if (op === 'type') {
    if (el.focus) el.focus({preventScroll: true});
    if (el.isContentEditable) { if (replace) document.execCommand('selectAll'); document.execCommand('insertText', false, text); return {ok: true, label}; }
    if (!('value' in el)) return {ok: false, why: 'not a text field'};
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, (replace ? '' : (el.value || '')) + text);
    el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, label};
  }
  if (op === 'key') {
    const k = {key: key, code: key, bubbles: true, cancelable: true, composed: true};
    const go = el.dispatchEvent(new KeyboardEvent('keydown', k));
    if (go && key === 'Enter') {
      el.dispatchEvent(new KeyboardEvent('keypress', k));
      const form = el.form || (el.closest ? el.closest('form') : null);
      if (form && el.tagName !== 'TEXTAREA') { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
      else if (/^(BUTTON|A)$/.test(el.tagName)) el.click();
    }
    if (go && key === 'Tab') {
      const all = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
      const next = all[(all.indexOf(el) + 1) % (all.length || 1)]; if (next && next.focus) next.focus();
    }
    if (go && /^(PageDown|PageUp|Home|End)$/.test(key)) {
      window.scrollBy(0, key === 'PageDown' ? innerHeight * 0.85 : key === 'PageUp' ? -innerHeight * 0.85 : key === 'Home' ? -1e7 : 1e7);
    }
    el.dispatchEvent(new KeyboardEvent('keyup', k));
    return {ok: true, label: key};
  }
  return {ok: false, why: 'unknown step'};
}"""
IN_PAGE_KEYS = {"enter": "Enter", "tab": "Tab", "escape": "Escape", "esc": "Escape", "backspace": "Backspace",
                "arrowdown": "ArrowDown", "arrowup": "ArrowUp", "arrowleft": "ArrowLeft", "arrowright": "ArrowRight",
                "pagedown": "PageDown", "pageup": "PageUp", "home": "Home", "end": "End"}


def lane_title_script(name: str) -> str:
    """A Pip's lane says whose it is in its tab's title ("Ava · Shop"): run in DGC's own world of each page, where the
    page's scripts can't reach it; the page's own title follows after the Pip's name."""
    mark = json.dumps(" ".join(str(name or "").split())[:60] + LANE_MARK)
    return ("(() => { const mark = " + mark + "; const fix = () => { const t = document.title || '';"
            " if (!t.startsWith(mark)) document.title = mark + t; };"
            " const watch = () => { fix(); new MutationObserver(fix).observe(document.documentElement || document,"
            " {subtree: true, childList: true, characterData: true}); };"
            " if (document.documentElement) watch(); else document.addEventListener('readystatechange', watch, {once: true});"
            " })()")


def lane_title(title: str, name: str) -> str:
    """A lane's title without the Pip's own name in front: the page's own words."""
    mark = " ".join(str(name or "").split())[:60] + LANE_MARK
    title = str(title or "")
    return title[len(mark):] if name and title.startswith(mark) else title


class _Running:
    """What BoxedBrowser keeps as its box: Chrome on this computer, stopped by its process group."""

    def __init__(self, proc, pipe, screen=None):
        self.proc, self.pipe, self.screen = proc, pipe, screen

    def stop(self) -> None:
        screen, self.screen = self.screen, None
        try:
            self._stop_chrome()
        finally:
            if screen is not None and screen.poll() is None:
                try:
                    screen.terminate()
                    screen.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass

    def _stop_chrome(self) -> None:
        proc = self.proc
        if proc is not None and proc.poll() is None and hasattr(proc, "wait"):
            try:
                os.killpg(proc.pid, 15)
            except (OSError, AttributeError):
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, 9)
                except OSError:
                    pass
        for fd in getattr(self.pipe, "fds", ()):
            try:
                os.close(fd)
            except OSError:
                pass
        self.pipe.fds = ()


class HostBrowser(BoxedBrowser):
    """DGC Browser's Chrome, with the phase-2 lane gate: the person's tabs are theirs (never gated, never driven), each
    Pip's lane is gated and confined on its own tab. Started by DgcBrowserHost with the person's address and the
    window's place."""

    def __init__(self, root: Path, chrome: Path, launch, *, on_info=None, on_frame=None, test_flags=()):
        super().__init__(root, root / "egress.unused", chrome=chrome, log_path=root / "chrome.log", shared=True)
        self.profile = root / "profile"
        self.launch_with = launch
        self.on_info, self.on_frame = on_info, on_frame
        self.test_flags = tuple(test_flags)
        self.start_url, self.start_place, self.headless = "", None, False
        self.screen_socket: Path | None = None  # its VNC screen's socket, when it draws on one (start_vnc_screen)
        self.infos: dict[str, dict] = {}        # targetId -> {url, title, openerId}: what Chrome says of each tab
        self.born: dict[str, int] = {}          # targetId -> the order DGC first heard of it (the tabs' row, in order)
        # While a Pip's run drives its lane (dgc_browser_lane), the Pip it is: every command then goes to that Pip's own
        # tabs or is refused (the wall between lanes and the person's tabs, on DGC's side of the pipe).
        self.driving: str | None = None
        self._own_session_id = ""
        self.lane_names: dict[str, str] = {}    # pip id -> its name, for its lane's tab title
        self.frame_owners: dict[str, str] = {}  # a frame inside a lane's page -> that Pip (a download it starts)
        # While a Pip's step drives a lane Chrome doesn't draw (in the background of the person's window), its steps act
        # inside the page (IN_PAGE_JS) instead of by input, which Chrome gives no such tab.
        self.in_page = False
        self.on_sign_in = None                  # the person's own sign-in on one of their tabs (target, what the page said)
        self.making_lane = False                # (a blank tab DGC is opening for a Pip: never watched as the person's)

    def start(self) -> None:
        if self._ws is not None:
            return
        if self.binary is None:
            raise BoxError("Install Google Chrome to use DGC Browser.")
        for path in (self.home, self.profile):
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
        profile_prefs(self.profile)
        env = chrome_env()
        own_store = self.headless and store_unlocked(env) is not True
        screen = None
        if self.headless and getattr(self, "virtual", False):
            screen = self.start_screen() if callable(getattr(self, "start_screen", None)) else None
            if screen is None:
                self.virtual = False             # no screen of its own came up: headless, as before
            else:
                env = {**env, "DISPLAY": screen[0]}
                env.pop("WAYLAND_DISPLAY", None)
                self.screen_socket = Path(screen[2]) if len(screen) > 2 and screen[2] else None
        try:
            proc, pipe = self.launch_with(chrome_argv(self.binary, self.profile, self.start_url, self.start_place,
                                                      self.test_flags, headless=self.headless, own_store=own_store,
                                                      virtual=screen is not None,
                                                      scale=VNC_SCALE if self.screen_socket is not None else SCREEN_SCALE),
                                          env, self.log_path)
        except BaseException:
            if screen is not None:
                screen[1].terminate()
                self.screen_socket = None
            raise
        self._box, self._pipe = _Running(proc, pipe, screen[1] if screen else None), pipe
        try:
            self._browser_call("Browser.getVersion", timeout=25)
            # Every tab is known with its address and title (the person's own make Home's last visited links), and
            # every new one is held until it is known whose it is: a popup from a Pip's lane is gated before it runs.
            self._browser_call("Target.setDiscoverTargets", {"discover": True})
            self._browser_call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
            try:
                # The person's downloads go on as Chrome does them; DGC only hears of each, to cancel a Pip lane's.
                self._browser_call("Browser.setDownloadBehavior", {"behavior": "default", "eventsEnabled": True})
            except BrowserError:
                pass
            deadline = time.monotonic() + 15
            while not self._pages and time.monotonic() < deadline:
                self._pipe.settimeout(max(0.05, deadline - time.monotonic()))
                try:
                    self._observe(self._pipe.recv())
                except socket.timeout:
                    break
            if not self._pages:
                raise BrowserError("its window never opened")
        except (BrowserError, socket.timeout, OSError) as error:
            self._cleanup()
            raise BoxError(f"DGC Browser didn't start: {error}") from error
        first = next(iter(self._pages))
        self._ws = _PageChannel(self._pipe, self._attached[first])

    def alive(self) -> bool:
        return (self._ws is not None and self._box is not None and self._box.proc is not None
                and self._box.proc.poll() is None)

    @property
    def _session_id(self) -> str:
        """While a lane is driven, its tab's own session: a page load the step waits for is that tab's, never another's
        (BrowserSession._await_load). Else none, as before."""
        return str(getattr(self._ws, "session_id", "") or "") if getattr(self, "driving", None) else ""

    @_session_id.setter
    def _session_id(self, value) -> None:
        self._own_session_id = str(value or "")

    def command(self, method: str, params: dict | None = None, *, timeout: float = 30.0) -> dict:
        """DGC drives a Pip's lane only: the person's own tabs are theirs (their window, their sign-ins), and while one
        Pip's run drives (``driving``), only that Pip's own tabs."""
        owner = self._front_owner()
        if owner == PERSON:
            raise BrowserError("DGC never drives your own tabs in DGC Browser.")
        if self.driving is not None and owner != self.driving:
            raise BrowserError("That tab isn't this Pip's own in DGC Browser.")
        return super().command(method, params, timeout=timeout)

    def _session_owner(self, session) -> str:
        return self.owner_of(self._session_target(session))

    def _session_call(self, session: str, method: str, params: dict | None = None, *, timeout: float = 10) -> dict:
        if self.driving is not None and self._session_owner(session) != self.driving:
            raise BrowserError("That tab isn't this Pip's own in DGC Browser.")
        return super()._session_call(session, method, params, timeout=timeout)

    def _session_eval(self, session: str, expression: str):
        if self.driving is not None and self._session_owner(session) != self.driving:
            raise BrowserError("That tab isn't this Pip's own in DGC Browser.")
        return super()._session_eval(session, expression)

    # What a Pip's run may ask of the browser itself while it drives its lane: reads of the tabs and windows, a new tab of
    # its own (made by DgcBrowserHost.new_lane_tab), closing one of its own. Nothing of the person's (their cookies,
    # their windows, closing Chrome) and nothing that names another's tab.
    DRIVING_BROWSER = frozenset({"Target.getTargets", "Target.getTargetInfo", "Target.createTarget", "Target.closeTarget",
                                 "Browser.getWindowForTarget", "Browser.getVersion", "Browser.cancelDownload"})
    _NAMES_A_TAB = frozenset({"Target.getTargetInfo", "Target.closeTarget", "Browser.getWindowForTarget"})

    def _browser_call(self, method: str, params: dict | None = None, *, timeout: float = 20) -> dict:
        if self.driving is not None:
            if method not in self.DRIVING_BROWSER:
                raise BrowserError("A Pip's tab in DGC Browser can't do that.")
            target = str((params or {}).get("targetId") or "")
            if method in self._NAMES_A_TAB and self.owner_of(target) != self.driving:
                raise BrowserError("That tab isn't this Pip's own in DGC Browser.")
        return super()._browser_call(method, params, timeout=timeout)

    def _make_lane(self, target: str, pip_id: str, grants=None) -> None:
        super()._make_lane(target, pip_id, grants)
        session = self._attached.get(target)
        if session:
            self._fire("Runtime.removeBinding", {"name": NOTICE_BINDING}, session)    # (a lane's sign-ins are never the person's)

    def _guard_lane(self, session: str) -> None:
        """A Pip's lane, as BoxedBrowser keeps it, and in DGC Browser also: no file picker ever opens on the person's
        screen from it (Chrome hands it to DGC, which leaves it unanswered), and its page's tab says whose it is."""
        super()._guard_lane(session)
        target = self._session_target(session)
        if self._kinds.get(target) != "page":
            return
        self._fire("Page.setInterceptFileChooserDialog", {"enabled": True}, session)
        name = self.lane_names.get(self.owner_of(target), "")
        if name:
            self._fire("Page.addScriptToEvaluateOnNewDocument", {"source": lane_title_script(name), "worldName": "dgc-lane",
                                                                 "runImmediately": True}, session)

    # What the person's own hand does in their own tab, streamed where there is no screen: these and nothing else, and
    # only from DgcBrowserHost.view_own (the editor tab's own events). DGC itself never drives the person's tabs.
    PERSON_METHODS = frozenset({"Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Page.navigate",
                                "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Page.reload", "Page.enable",
                                "Page.startScreencast", "Page.stopScreencast", "Page.captureScreenshot"})

    def person_call(self, target: str, method: str, params: dict | None = None, *, timeout: float = 10.0) -> dict:
        if method not in self.PERSON_METHODS or self.whose(target) != PERSON or target not in self._attached:
            raise BrowserError("That isn't one of your own tabs.")
        return self._session_call(self._attached[target], method, params or {}, timeout=timeout)

    def _observe(self, message: dict) -> None:
        method = message.get("method", "")
        params = message.get("params", {}) or {}
        if method == "Runtime.bindingCalled" and params.get("name") == NOTICE_BINDING:
            self._signed_in(str(message.get("sessionId", "")), params.get("payload"))
            return
        if method.startswith("Runtime.") and message.get("sessionId") and self._session_owner(message["sessionId"]) == PERSON:
            return                    # (the person's own pages: what their scripts say is never read, kept or shown)
        if method == "Target.attachedToTarget" and isinstance(params.get("targetInfo"), dict) and not self.making_lane:
            # The person's own tab (or one theirs opened), watched before Chrome lets it run: its first page has the
            # watcher too (a binding reaches only pages made after it).
            info = params["targetInfo"]
            opener = str(info.get("openerId") or "")
            if info.get("type") == "page" and params.get("sessionId") and (not opener or self.owner_of(opener) == PERSON):
                self._watch_sign_ins(str(params["sessionId"]))
        if method in ("Page.frameAttached", "Page.frameNavigated"):
            self._frame_seen(params, str(message.get("sessionId", "")))
        elif method == "Browser.downloadWillBegin" and self._lane_download(params):
            return                                   # (a Pip's: cancelled, never on the person's computer)
        if method in ("Target.targetCreated", "Target.targetInfoChanged") and isinstance(params.get("targetInfo"), dict):
            self.told(params["targetInfo"])
        elif method == "Target.targetDestroyed":
            self.infos.pop(str(params.get("targetId", "")), None)
        elif method == "Page.screencastFrame" and self.on_frame is not None:
            self.on_frame(str(message.get("sessionId", "")), params)
            return
        super()._observe(message)
        if method == "Target.attachedToTarget" and isinstance(params.get("targetInfo"), dict):
            # What a tab is when DGC first hears of it (a tab open before DGC listened says nothing more until it moves).
            if str(params["targetInfo"].get("targetId", "")) not in self.infos:
                self.told(params["targetInfo"])

    def _watch_sign_ins(self, session: str) -> None:
        """The person's own tab: DGC's watcher for their own sign-ins, in DGC's own world of each of its pages. Chrome runs
        such a script only with the tab's Page events on, and puts the binding in only with its Runtime events on; DGC
        keeps nothing of either (the Runtime ones from the person's pages are dropped as they come)."""
        self._fire("Page.enable", {}, session)
        self._fire("Runtime.enable", {}, session)     # (a binding is put in a page only with it on; its events are dropped)
        self._fire("Runtime.addBinding", {"name": NOTICE_BINDING, "executionContextName": NOTICE_WORLD}, session)
        self._fire("Page.addScriptToEvaluateOnNewDocument", {"source": NOTICE_SCRIPT, "worldName": NOTICE_WORLD,
                                                             "runImmediately": True}, session)

    def _signed_in(self, session: str, payload) -> None:
        """What DGC's watcher said: a sign-in of the person's own, on one of their tabs (never a Pip's lane)."""
        target = self._session_target(session)
        if not target or target not in self._pages or self.owner_of(target) != PERSON or not callable(self.on_sign_in):
            return
        try:
            said = json.loads(payload) if isinstance(payload, str) and len(payload) <= 4000 else None
        except ValueError:
            said = None
        if isinstance(said, dict) and said.get("trusted") is True and isinstance(said.get("host"), str):
            self.on_sign_in(target, {"host": said["host"][:253], "path": str(said.get("path") or "")[:200],
                                     "title": str(said.get("title") or "")[:200], "card": said.get("card") is True})

    def _frame_seen(self, params: dict, session: str) -> None:
        """A frame inside a Pip's lane page (in the page's own process): its Pip, so a download it starts is known as
        that Pip's."""
        frame = params.get("frame") if isinstance(params.get("frame"), dict) else params
        frame_id = str(frame.get("id") or frame.get("frameId") or "")
        owner = self._session_owner(session) if session else PERSON
        if frame_id and owner != PERSON:
            self.frame_owners[frame_id] = owner
            while len(self.frame_owners) > 2000:
                self.frame_owners.pop(next(iter(self.frame_owners)))

    def download_owner(self, frame_id: str) -> str:
        frame_id = str(frame_id or "")
        if self._tab_of(frame_id):
            return self.owner_of(frame_id)
        return self.frame_owners.get(frame_id, PERSON)

    def _lane_download(self, params: dict) -> bool:
        """A download a Pip's lane started: cancelled at once (it would land among the person's own files, which no Pip
        reads), told to its run as refused, and kept as refused in the lane's sent log. The person's own go on as Chrome
        does them. True when it was a lane's."""
        owner = self.download_owner(str(params.get("frameId", "")))
        if owner == PERSON:
            return False
        self._fire("Browser.cancelDownload", {"guid": str(params.get("guid", ""))})
        url = str(params.get("url", ""))[:2000]
        host = (urlsplit(url).hostname or "a site").lower()
        lane = self.lane(owner)
        reason = f"DGC didn't download {str(params.get('suggestedFilename') or 'that file')[:120]} from {host}: a Pip's tab in DGC Browser downloads nothing."
        lane.refused.append(reason)
        del lane.refused[:-20]
        self.seq += 1
        lane.refusals.append((self.seq, host, True, url, reason))
        del lane.refusals[:-20]
        if self.lane_sent is not None:
            self.lane_sent.refused(owner, host)
        return True

    def told(self, info: dict) -> None:
        """What Chrome says of a tab (its address and title): kept, and the person's own visits passed on. Chrome tells
        a tab's new address as it goes there but not always the title that comes after, so a read of the tabs
        (DgcBrowserHost.refresh) tells the rest."""
        if info.get("type") != "page":
            return
        target = str(info.get("targetId", ""))
        if target not in self.born:
            self.born[target] = len(self.born) + 1 if not self.born else max(self.born.values()) + 1
            while len(self.born) > 1000:
                self.born.pop(next(iter(self.born)))
        before = self.infos.get(target, {})
        url, title = str(info.get("url", ""))[:2000], str(info.get("title", ""))[:200]
        if before.get("url") == url and before.get("title") == title:
            return
        self.infos[target] = {"url": url, "title": title,
                              "openerId": str(info.get("openerId") or before.get("openerId", ""))}
        while len(self.infos) > 400:
            self.infos.pop(next(iter(self.infos)))
        if self.on_info is not None:
            self.on_info(target, before.get("url") != url)

    # -- a Pip's steps inside a page Chrome doesn't draw ------------------------------------------------------------
    def _inside(self) -> bool:
        return bool(self.driving) and self.in_page

    def _in_page(self, op: str, ref: str = "", text: str = "", replace: bool = True, key: str = "", dy: float = 0.0) -> dict:
        said = self._in_world(self._isolated(), IN_PAGE_JS, op, ref, text, bool(replace), key, float(dy))
        if not isinstance(said, dict):
            raise BrowserError("the page didn't answer")
        if said.get("missing"):
            raise BrowserError(f"{ref or 'that'} is not on the page. Take a fresh read: refs change whenever the page does.")
        if said.get("disabled"):
            raise BrowserError(f"{ref} is disabled")
        if said.get("ok") is not True:
            raise BrowserError(str(said.get("why") or "the page didn't take that"))
        return said

    def click(self, ref: str) -> str:
        if not self._inside():
            return super().click(ref)
        self.acted_at = time.monotonic()
        said = self._in_page("click", ref)
        if said.get("open"):
            # (A link that opens a tab: a page in the background may open none, so its own tab goes there, gated as ever.)
            self.navigate(str(said["open"])[:2000])
        self._pump(0.8)
        return str(said.get("label") or "")

    def type_text(self, ref: str, text: str, *, replace: bool = True) -> str:
        if not self._inside():
            return super().type_text(ref, text, replace=replace)
        self.acted_at = time.monotonic()
        said = self._in_page("type", ref, str(text), replace)
        self._pump(0.4)
        return str(said.get("label") or "")

    def type_into_focus(self, text: str) -> None:
        if not self._inside():
            return super().type_into_focus(text)
        self.acted_at = time.monotonic()
        self._in_page("type", "", str(text)[:2000], False)
        self.acted_at = time.monotonic()

    def press(self, key: str) -> str:
        if not self._inside():
            return super().press(key)
        name = IN_PAGE_KEYS.get(str(key).strip().lower())
        if name is None:
            raise BrowserError(f"{key!r} is not a supported key; use one of {', '.join(sorted(IN_PAGE_KEYS))}")
        self.acted_at = time.monotonic()
        self._in_page("key", "", "", False, name)
        self._pump(0.8)
        return name

    def scroll_by(self, dy: float) -> None:
        if not self._inside():
            return super().scroll_by(dy)
        self._in_page("scroll", dy=float(dy))

    def hover_ref(self, ref: str) -> str:
        if not self._inside():
            return super().hover_ref(ref)
        self.acted_at = time.monotonic()
        said = self._in_page("hover", ref)
        self._pump(0.4)
        return str(said.get("label") or "")

    def whose(self, target: str) -> str:
        """Whose a tab is, even before DGC has attached to it: a tab a lane opened is that Pip's."""
        if target in self._tabs:
            return self._tabs[target].owner
        opener = self.infos.get(target, {}).get("openerId", "")
        return self.whose(opener) if opener and opener != target and opener in self._tabs else PERSON


class DgcBrowserHost:
    """The supervisor's one DGC Browser (one Chrome per profile): its window, its lanes, its streamed tab's frames,
    Home's last visited links, its idle close and the sign-outs it clears. Every use of the browser holds ``lock``; a
    thread reads Chrome's pipe between uses, so a tab the person opens is let run at once."""

    def __init__(self, directory, *, chrome=None, launch=launch_chrome, run=None, which=None, platform=None, clock=None,
                 pump_thread: bool = True, test_flags=()):
        self.directory = Path(directory)
        self.root = folder(self.directory)
        self.chrome = Path(chrome) if chrome is not None else None
        self.launch = launch
        self.run = run or (lambda argv, **kw: subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                              stderr=subprocess.DEVNULL, timeout=5, check=False))
        self.which = which or shutil.which
        self.platform = platform or sys.platform
        self.clock = clock or time.monotonic
        self.pump_thread = pump_thread
        self.test_flags = tuple(test_flags)
        self.lock = threading.RLock()
        self.browser: HostBrowser | None = None
        self.recent = Recent(self.root / RECENT_FILE, clock=self.clock)
        self.error = ""
        self.empty_since: float | None = None
        self.frames: dict[str, tuple] = {}       # lane session -> (jpeg base64, width, height, when)
        self.casting: dict[str, float] = {}      # lane session -> when the streamed tab last asked for it
        self.acks: dict[str, tuple] = {}         # lane session -> (frame id to ack, when it came)
        self.acked: dict[str, float] = {}
        self.person_acted: dict[str, float] = {}  # pip id -> the person's last input in its streamed tab
        self.published = ""
        self.viewer = None
        self.refreshed = -1e9
        # Your own tab, streamed where there is no screen (headless): which tab it is, the editor tab's size, its last
        # frame (seq, jpeg base64, width, height, when: in memory only, never written), and when the tab last asked.
        self.headless = False
        self.icons: dict[str, str] = {}           # icon address -> data: address ("" when it wasn't a small picture)
        self.icon_of: dict[str, str] = {}         # page address -> its icon's address
        self.icon_pending: set[str] = set()
        self.icon_asking: set[str] = set()      # pages whose icon is being looked up off Chrome's message loop
        self.fetch_icon, self.icon_wait = fetch_icon, False
        self.own: str | None = None
        self.own_size = OWN_SIZE
        self.screen_size = (OWN_SIZE[0] * VNC_SCALE, OWN_SIZE[1] * VNC_SCALE)   # its VNC screen's, as the last size said
        self.own_cast: tuple | None = None       # (target, size) being cast
        self.own_cast_at = -1e9
        self.own_info_at = -1e9
        self.own_frame: tuple | None = None
        self.own_seq = 0
        self.own_viewed = -1e9
        self.own_wait = OWN_WAIT_SECONDS
        self.frame_ready = threading.Condition(threading.Lock())
        self._followed: set[str] = set()
        # Its VNC screen, where it has one: how many editor tabs show it now, and the pages a Pip's lane opened, to be
        # moved off it (only the person's own window is ever on it).
        self.screen_viewers = 0
        self._viewers_lock = threading.Lock()
        self._off_screen_due: set[str] = set()
        self._off_screen: set[str] = set()
        # The Pips whose runs drive a lane here (dgc_browser_lane.LaneHost, by pip id): what their lane holds goes to
        # their run, and a lane nobody's run uses closes after LANE_IDLE_SECONDS.
        self.lane_users: dict[str, object] = {}
        # The person's own sign-ins, to be noticed at the next tick (notice_site), and the tab whose sign-in went through
        # a sign-in host, so the site it lands on next keeps that exact host.
        self.signed_in: list[dict] = []
        self.sso_pending: dict[str, tuple] = {}

    # -- running -------------------------------------------------------------------------------------

    def running(self) -> bool:
        return self.browser is not None and self.browser.alive()

    def screen_socket(self) -> Path | None:
        """Its VNC screen's own socket while Chrome draws on one (no screen here: the editor's tab shows that screen);
        None everywhere else (its window beside the editor, a plain screen, headless)."""
        browser = self.browser
        if browser is None or not self.headless or not browser.alive():
            return None
        return getattr(browser, "screen_socket", None)

    def screen_opened(self) -> None:
        """An editor tab shows its screen now: while one does, it is being looked at (never closed for being idle). Counted
        under a small lock of its own: the person's screen never waits for a Pip's step that holds the browser."""
        with self._viewers_lock:
            self.screen_viewers += 1
            self.own_viewed = self.clock()

    def screen_closed(self) -> None:
        with self._viewers_lock:
            self.screen_viewers = max(0, self.screen_viewers - 1)
            self.own_viewed = self.clock()

    def person_input(self) -> None:
        """The person's own hand on its screen (a click, a key): their tab is in use."""
        self.own_viewed = self.clock()

    def _new_browser(self) -> HostBrowser:
        chrome = self.chrome or find_chrome()[0]
        if chrome is None:
            raise BoxError("Install Google Chrome to use DGC Browser.")
        browser = HostBrowser(self.root, chrome, self.launch, on_info=self._noticed, on_frame=self._frame_came,
                              test_flags=self.test_flags)
        browser.on_write = self.write_held
        browser.on_sign_in = self._sign_in_seen
        browser.lane_sent = LaneSent(self.root / "sent.jsonl")
        return browser

    def _sign_in_seen(self, target: str, said: dict) -> None:
        """The person signed in on one of their own tabs: kept for the next tick, which notices the site (never one on
        this computer or the network: notice_site)."""
        host = public_host(said.get("host"))
        if not host:
            return
        self.signed_in.append({"host": host, "sso_hosts": [], "card_fields": said.get("card") is True,
                               "paths": [said.get("path") or ""], "titles": [said.get("title") or ""]})
        del self.signed_in[:-50]
        if SIGN_IN_HOST.match(host):
            self.sso_pending[target] = (host, self.clock())
        while len(self.sso_pending) > 50:
            self.sso_pending.pop(next(iter(self.sso_pending)))

    def _notice_signed_in(self, registry) -> None:
        waiting, self.signed_in = self.signed_in, []
        for entry in waiting:
            try:
                notice_site(registry, entry["host"], sso_hosts=entry["sso_hosts"], card_fields=entry["card_fields"],
                            paths=entry["paths"], titles=entry["titles"])
            except (RegistryError, OSError, ValueError):
                pass

    def open(self, url: str = "", place: dict | None = None, pip_id: str | None = None, *, headless: bool = False) -> dict:
        """Open the window (or bring it forward), at ``url`` in a new tab of the person's, or at a Pip's own tab, and put
        it where ``place`` says. Returns {opened (a new Chrome), target}.

        ``headless``: the editor that asked has no screen (Remote-SSH): Chrome runs headless (as it does where this
        computer has no screen at all) and the editor streams the person's own tab. A window asked for where Chrome
        runs headless opens it again as a window (its profile, and so every sign-in, stays); a headless ask where the
        window is open keeps the window, which streams as well."""
        with self.lock:
            opened = False
            if self.running() and self.headless and not headless and has_screen():
                self.close()                       # back at the screen: its window
            if not self.running():
                self._drop()
                self.browser = self._new_browser()
                self.headless = bool(headless or not has_screen())
                self.browser.start_url, self.browser.start_place = url, None if self.headless else place
                self.browser.headless = self.headless
                # No screen here: a real Chrome on a screen of its own. The Pip computer's VNC screen where its program is
                # here (the editor's tab then shows it as a Pip's computer is shown), else a plain one where Xvfb is
                # (start_virtual_screen: pictures, as before).
                linux = str(self.platform).startswith("linux")
                vnc = vnc_program() if self.headless and linux else None
                if self.headless and linux and vnc is None:
                    fetch_screen_program()         # pictures this time; the Pip computer's screen once it is here
                self.browser.virtual = self.headless and linux and bool(vnc or self.which("Xvfb"))
                self.browser.start_screen = lambda: ((start_vnc_screen(self.own_size, program=vnc) if vnc else None)
                                                     or start_virtual_screen(self.which))
                try:
                    self.browser.start()
                except (BoxError, BrowserError, OSError) as error:
                    self.error = str(error)[:400]
                    self._drop()
                    raise
                opened, self.error, self.empty_since = True, "", None
                self.own, self.own_viewed = None, self.clock()
                target = self.person_tabs()[0] if self.person_tabs() else None
                if url and target:
                    # Chrome loaded its first page before DGC was attached to it, so that page has no sign-in watcher:
                    # loaded once more, it has (a sign-in on the very page DGC Browser opened at is noticed too).
                    try:
                        self.browser.person_call(target, "Page.reload", {}, timeout=5)
                    except (BrowserError, socket.timeout, OSError):
                        pass
                self._start_pump()
            elif pip_id:
                target = self.lane_of(pip_id)
                if target is None:
                    raise RegistryError("not_found", "That Pip has no tab in DGC Browser yet.")
                self.browser._browser_call("Target.activateTarget", {"targetId": target})
            elif url:
                target = str(self.browser._browser_call("Target.createTarget", {"url": url}).get("targetId", ""))
            else:
                tabs = self.person_tabs()
                target = tabs[-1] if tabs else None
                if target is None:
                    target = str(self.browser._browser_call("Target.createTarget", {"url": "chrome://newtab/"}).get("targetId", ""))
                else:
                    self.browser._browser_call("Target.activateTarget", {"targetId": target})    # its window comes forward
            if pip_id and opened:
                raise RegistryError("not_found", "That Pip has no tab in DGC Browser yet.")
            if target and not pip_id:
                self.own, self.own_viewed = target, self.clock()   # the tab the streamed tab shows, where it streams
            self._place(target, place)
            return {"opened": opened, "target": target}

    def _place(self, target, place) -> None:
        """Its window, to the right of the editor: Chrome's own window controls first (every platform), then the
        computer's: X11's tools bring it forward when present, AppleScript on a Mac. Never fails the open."""
        browser = self.browser
        if self.headless:
            return                                 # no window: the editor's streamed tab is where it shows
        if target:
            try:
                window = browser._browser_call("Browser.getWindowForTarget", {"targetId": target}).get("windowId")
                if window is not None and place:
                    browser._browser_call("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "normal"}})
                    browser._browser_call("Browser.setWindowBounds", {"windowId": window, "bounds": dict(place)})
            except (BrowserError, socket.timeout, OSError):
                pass
        pid = getattr(getattr(browser._box, "proc", None), "pid", None)
        if not pid:
            return
        try:
            if self.platform == "darwin" and self.which("osascript"):
                where = (f" set position of window 1 to {{{place['left']}, {place['top']}}}\n"
                         f" set size of window 1 to {{{place['width']}, {place['height']}}}\n") if place else ""
                self.run(["osascript", "-e", 'tell application "System Events"\n'
                          f'tell (first process whose unix id is {int(pid)})\n set frontmost to true\n{where}end tell\nend tell'])
            elif self.platform.startswith("linux") and os.environ.get("DISPLAY") and self.which("xdotool"):
                self.run(["xdotool", "search", "--onlyvisible", "--pid", str(int(pid)), "windowactivate"])
        except (OSError, subprocess.SubprocessError):
            pass

    def _start_pump(self) -> None:
        if not self.pump_thread:
            return
        browser = self.browser
        threading.Thread(target=self._pump_loop, args=(browser,), name="dgc-browser", daemon=True).start()

    def _pump_loop(self, browser) -> None:
        from .pip_computer_box import _readable
        while True:
            pipe = getattr(browser, "_pipe", None)
            # Chrome is waited for WITHOUT the lock: a frame or a key the streamed tab asks for meanwhile is never held
            # behind the wait. Then what has come is read, never waiting, under the lock.
            if pipe is not None and hasattr(pipe, "read_fd") and b"\0" not in getattr(pipe, "_buffer", b""):
                try:
                    _readable([pipe.read_fd], self._wait())
                except (OSError, ValueError):
                    pass
            with self.lock:
                if self.browser is not browser or not browser.alive():
                    return
                try:
                    self._drain(browser)
                except (BrowserError, OSError):
                    pass
                self.after_pump()
            time.sleep(0.002)

    def _wait(self) -> float:
        """How long the pump may wait for Chrome: until a held frame's ack falls due (Chrome draws the next frame only
        once it is acked), at most 50 ms."""
        now, wait = self.clock(), 0.05
        for session, (frame, came) in list(self.acks.items()):
            wait = min(wait, self.acked.get(session, -1e9) + self._interval(session) - now)
        return max(0.0, wait)

    @staticmethod
    def _drain(browser) -> None:
        """Every whole message Chrome has sent by now, handled; returns as soon as there is none (a pipe without a
        descriptor, as tests script it, is read as before)."""
        from .pip_computer_box import _readable
        pipe = browser._pipe
        if pipe is None or not hasattr(pipe, "read_fd"):
            browser._pump(0.01)
            return
        for _ in range(500):
            if b"\0" not in pipe._buffer and not _readable([pipe.read_fd], 0):
                return
            pipe.settimeout(0.05)
            try:
                browser._observe(pipe.recv())
            except socket.timeout:
                return

    def after_pump(self) -> None:
        """Between reads of the pipe: acks for frames that waited their turn, what each lane sent, the links file."""
        now = self.clock()
        for session, (frame, came) in list(self.acks.items()):
            if now - self.acked.get(session, -1e9) >= self._interval(session) - 1e-6:
                self._ack(session, frame)
        if self.own_cast is not None and now - self.own_viewed > CAST_SECONDS:
            self._stop_own_cast()                  # nobody asks: no frames, and its last picture forgotten
        for session, asked in list(self.casting.items()):
            if now - asked > CAST_SECONDS:
                self.casting.pop(session, None)
                self.frames.pop(session, None)
                try:
                    self.browser._fire("Page.stopScreencast", {}, session)
                except (OSError, AttributeError):
                    pass
        if self.browser is not None and self.browser.lane_sent is not None:
            self.browser.lane_sent.flush_due()
        for target in list(self._off_screen_due):
            self._off_screen_due.discard(target)
            self._move_off_screen(target)
        self.refresh()
        self.recent.write_due()

    def _move_off_screen(self, target: str) -> None:
        """A page a Pip's lane opened (a popup in a window of its own) never stays on the person's VNC screen: its window
        goes left of the screen's edge, where nobody sees or drives it from the editor's tab."""
        if target in self._off_screen or self.browser is None or self.screen_socket() is None:
            return
        self._off_screen.add(target)
        while len(self._off_screen) > 400:
            self._off_screen.pop()
        try:
            got = self.browser._browser_call("Browser.getWindowForTarget", {"targetId": target}, timeout=5)
            window, bounds = got.get("windowId"), got.get("bounds") or {}
            if window is None:
                return
            width = int(bounds.get("width") or self.own_size[0])
            if int(bounds.get("left") or 0) + width <= 0:
                return                             # (already off it: a lane's own window)
            self.browser._browser_call("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "normal"}})
            self.browser._browser_call("Browser.setWindowBounds", {"windowId": window, "bounds": {
                "left": -(width + LANE_GAP), "top": 0}})
        except (BrowserError, socket.timeout, OSError, TypeError, ValueError):
            pass

    def close(self) -> None:
        with self.lock:
            if self.browser is not None and self.browser._pipe is not None:
                try:
                    self.browser._fire("Browser.close")
                except OSError:
                    pass
                # A moment for Chrome to close by itself: it saves what it still holds (the last pages' history) as
                # it does, which stopping it at once loses.
                proc = getattr(self.browser._box, "proc", None)
                if proc is not None and hasattr(proc, "wait"):
                    try:
                        proc.wait(timeout=CLOSE_SECONDS)
                    except subprocess.TimeoutExpired:
                        pass
            self._drop()
            self.recent.write_due(force=True)

    def _drop(self) -> None:
        browser, self.browser = self.browser, None
        if browser is not None:
            sock = getattr(browser, "screen_socket", None)
            try:
                browser._cleanup()
            except Exception:                    # noqa: BLE001 - it is gone either way
                pass
            if sock is not None:
                browser.screen_socket = None
                try:
                    Path(sock).unlink()          # (its screen stopped with it: the socket file is all that is left)
                except OSError:
                    pass
        self._off_screen_due.clear()
        self._off_screen.clear()
        self.frames.clear()
        self.casting.clear()
        self.acks.clear()
        self.own_cast, self.own = None, None
        with self.frame_ready:
            self.own_frame = None
            self.frame_ready.notify_all()
        if self.viewer is not None:
            self.viewer.close()
            self.viewer = None

    # -- whose tabs ----------------------------------------------------------------------------------

    def person_tabs(self) -> list[str]:
        """The person's own tabs, in the order they were opened (the newest last)."""
        browser = self.browser
        if not browser:
            return []
        tabs = [t for t in browser._pages if browser._tabs.get(t) and browser._tabs[t].owner == PERSON]
        return sorted(tabs, key=lambda t: (browser.born.get(t, 1 << 40), t))

    def lane_of(self, pip_id: str) -> str | None:
        browser = self.browser
        if browser is None:
            return None
        return next((t for t in browser._pages if t in browser._tabs and browser._tabs[t].owner == pip_id
                     and t in browser._attached), None)

    def lanes(self) -> list[dict]:
        browser = self.browser
        if browser is None:
            return []
        seen, out = set(), []
        for target in browser._pages:
            owner = browser._tabs[target].owner if target in browser._tabs else PERSON
            if owner != PERSON and owner not in seen:
                seen.add(owner)
                info = browser.infos.get(target, {})
                # (working: a run of its Pip is on its tab now, from its first step to its end: what the dock's tile and
                # the Pip's chat say, "Ava is working in it".)
                user = self.lane_users.get(owner)
                working = getattr(user, "run_id", None) is not None
                if working and str(owner).startswith("work:"):
                    # A Work session's tab is its for the whole session: at work while its steps come, not for 30 minutes.
                    working = time.monotonic() - float(getattr(user, "last_used", 0) or 0) < WORK_ACTIVE_SECONDS
                out.append({"pip_id": owner, "name": browser.lane_names.get(owner, ""),
                            "title": lane_title(info.get("title", ""), browser.lane_names.get(owner, "")),
                            "url": info.get("url", ""), "working": working})
        return out

    def open_lane(self, pip_id: str, url: str, grants, name: str = "") -> str:
        """A Pip's own tab (its lane), in the background of the person's window, gated and confined to ``grants`` by
        the phase-2 lane gate before it loads anything, then sent to ``url``. Its one tab, reused. Returns its id.
        ``name``: the Pip's, for its tab's title ("Ava · Shop")."""
        with self.lock:
            if not self.running():
                self.open("", None)
            browser = self.browser
            if name:
                browser.lane_names[pip_id] = " ".join(str(name).split())[:60]
            target = self.lane_of(pip_id)
            if target is None:
                target = self.new_lane_tab(pip_id, grants)
            elif grants is not None:
                browser.lane(pip_id).grants = grants
            session = browser._attached[target]
            browser._fire("Page.enable", {}, session)
            if url:
                browser._fire("Page.navigate", {"url": url}, session)
            return target

    def new_lane_tab(self, pip_id: str, grants=None) -> str:
        """One more tab of a Pip's own (its lane, or a tab its run opens there), made blank and gated before it loads
        anything: in the background of the person's window, never brought to the front; where Chrome draws on a VNC
        screen, a window of its own left of that screen's edge, never on the screen the person sees. Returns its id."""
        with self.lock:
            browser = self.browser
            made = {"url": "about:blank", "background": True}
            if self.screen_socket() is not None or self.headless:
                # On the VNC screen the editor's tab shows, only the person's own window is there: a lane is a
                # window of its own left of the screen's edge, never a tab in theirs (the dock's Watch shows it). So it
                # is on any screen of Chrome's own (no screen here): a tab in the background draws no picture of
                # itself after its first (Chrome 158), so neither the Watch nor the Pip's own steps could show it.
                width, height = self.own_size
                made.update(newWindow=True, left=-(width + LANE_GAP), top=0, width=width, height=height)
            browser.making_lane = True
            try:
                target = str(browser._browser_call("Target.createTarget", made).get("targetId", ""))
                self._off_screen.add(target)
                browser._wait_attached(target)
            finally:
                browser.making_lane = False
            browser._opened.add(target)
            browser._make_lane(target, pip_id, grants)
            return target

    def close_lane(self, pip_id: str) -> int:
        """Close every tab of a Pip's lane (none of the person's, none of another Pip's). Returns how many."""
        with self.lock:
            browser = self.browser
            if browser is None or not isinstance(pip_id, str) or not pip_id or pip_id == PERSON:
                return 0
            closed = 0
            for target in [t for t in browser._pages if t in browser._tabs and browser._tabs[t].owner == pip_id]:
                try:
                    browser._browser_call("Target.closeTarget", {"targetId": target}, timeout=5)
                    closed += 1
                except (BrowserError, socket.timeout, OSError):
                    pass
            return closed

    def _noticed(self, target: str, visit: bool = True) -> None:
        """Chrome said a tab's address or title: the person's own visits are kept for Home's card, never a lane's."""
        browser = self.browser
        if browser is None:
            return
        if browser.whose(target) != PERSON:
            if target not in self._off_screen and getattr(browser, "screen_socket", None) is not None and self.headless:
                self._off_screen_due.add(target)   # (moved between reads of the pipe, never inside one)
            return
        info = browser.infos.get(target, {})
        url = info.get("url")
        pending = self.sso_pending.get(target)
        if pending and visit:
            # Signed in through a sign-in host, then on to another site: that site, with that exact host (its lanes may
            # follow its own sign-in there).
            here = public_host(urlsplit(str(url or "")).hostname or "")
            if self.clock() - pending[1] > SSO_FOLLOW_SECONDS:
                self.sso_pending.pop(target, None)
            elif here and site_key(here) != site_key(pending[0]):
                self.sso_pending.pop(target, None)
                self.signed_in.append({"host": here, "sso_hosts": [pending[0]], "card_fields": False, "paths": [],
                                       "titles": [str(info.get("title") or "")]})
        self.recent.note(url, info.get("title"), visit, self.icons.get(self.icon_of.get(url, ""), ""))
        self._icon_soon(target, url)
        if self.headless and self.own and target != self.own and info.get("openerId") == self.own \
                and target not in self._followed:
            # A link from the person's own streamed tab opened a new tab: the stream follows it, as a window would.
            self._followed.add(target)
            self.own = target

    def refresh(self) -> None:
        """Every couple of seconds: the tabs as Chrome lists them, for the titles it didn't tell as they came."""
        browser = self.browser
        if browser is None or self.clock() - self.refreshed < RECENT_WRITE_SECONDS:
            return
        self.refreshed = self.clock()
        try:
            for info in browser._browser_call("Target.getTargets", timeout=5).get("targetInfos", []):
                if isinstance(info, dict):
                    browser.told(info)
        except (BrowserError, socket.timeout, OSError):
            pass

    # -- the streamed tab ----------------------------------------------------------------------------

    def _own_session(self) -> str | None:
        if self.own_cast is None or self.browser is None:
            return None
        return self.browser._attached.get(self.own_cast[0])

    def _interval(self, session) -> float:
        return OWN_FRAME_SECONDS if session and session == self._own_session() else FRAME_SECONDS

    def _frame_came(self, session: str, params: dict) -> None:
        meta = params.get("metadata") or {}
        data = params.get("data")
        if session and session == self._own_session():
            # The person's own tab: every frame, kept in memory only (the latest), for the one editor tab that asks.
            if isinstance(data, str):
                with self.frame_ready:
                    self.own_seq += 1
                    self.own_frame = (self.own_seq, data, int(meta.get("deviceWidth") or 0),
                                      int(meta.get("deviceHeight") or 0), self.clock())
                    self.frame_ready.notify_all()
            frame = params.get("sessionId")
            if self.clock() - self.acked.get(session, -1e9) >= OWN_FRAME_SECONDS - 1e-6:
                self._ack(session, frame)
            else:
                self.acks[session] = (frame, self.clock())
            return
        if isinstance(data, str):
            self.frames[session] = (data, int(meta.get("deviceWidth") or 0), int(meta.get("deviceHeight") or 0), self.clock())
        frame = params.get("sessionId")
        if self.clock() - self.acked.get(session, -1e9) >= FRAME_SECONDS:
            self._ack(session, frame)
        else:
            self.acks[session] = (frame, self.clock())     # throttled: Chrome sends the next once this one is acked

    def _ack(self, session, frame) -> None:
        self.acks.pop(session, None)
        self.acked[session] = self.clock()
        try:
            self.browser._fire("Page.screencastFrameAck", {"sessionId": frame}, session)
        except (OSError, AttributeError):
            pass

    def view(self, pip_id: str, op: str, fields: dict) -> dict:
        """One request from a Pip's streamed tab: a picture of its lane (never of the person's tabs), or the person's
        own hand in it. Returns a frame after anything that acts."""
        import base64
        with self.lock:
            if not self.running():
                return {"ok": False, "closed": True, "error": "DGC Browser is closed. Open it from the dock."}
            browser = self.browser
            target = self.lane_of(pip_id) if isinstance(pip_id, str) and pip_id and pip_id != PERSON else None
            if target is None:
                return {"ok": False, "error": "This Pip has no tab in DGC Browser yet: it opens one when it works there."}
            session = browser._attached[target]
            try:
                hidden = self._lane_hidden(session)
                if hidden:
                    return hidden
                if op not in ("frame", "move"):
                    refused = self._act(pip_id, target, session, op, fields)
                    if refused:
                        return {"ok": False, "error": refused}
                return self._picture(pip_id, target, session, base64)
            except (BrowserError, socket.timeout, OSError, ValueError) as error:
                return {"ok": False, "error": str(error)[:300] or "DGC Browser didn't answer."}

    def _lane_hidden(self, session) -> dict | None:
        """A lane in the background of the person's window (a computer with a screen): Chrome draws no new picture of
        it and takes no input for it, so its Watch says where it is instead of showing a picture that no longer moves."""
        browser = self.browser
        try:
            state = browser._session_call(session, "Runtime.evaluate", {"expression": "document.visibilityState",
                                                                         "returnByValue": True}, timeout=3)
        except (BrowserError, socket.timeout, OSError):
            return None
        if ((state.get("result") or {}).get("value")) != "hidden":
            return None
        target = browser._session_target(session)
        name = browser.lane_names.get(browser.owner_of(target), "") or "This Pip"
        return {"ok": False, "hidden": True, "error": (f"{name}'s tab is in the background of your DGC Browser window, so "
                f"it can't be pictured here. To watch it live, click its tab there (“{name} · …”).")}

    def _act(self, pip_id, target, session, op, fields) -> str:
        browser = self.browser
        call = lambda method, params=None: browser._session_call(session, method, params or {}, timeout=10)   # noqa: E731
        now = self.clock()
        if op in ("click", "type", "key", "scroll"):
            self.person_acted[pip_id] = now
            browser._tabs[target].acted_at = time.monotonic()
        if op == "click":
            x, y = float(fields.get("x") or 0), float(fields.get("y") or 0)
            for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
                call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left" if kind != "mouseMoved" else "none",
                                                  "clickCount": 1 if kind != "mouseMoved" else 0})
        elif op == "type":
            call("Input.insertText", {"text": str(fields.get("text") or "")[:4000]})
        elif op == "key":
            key = str(fields.get("key") or "")[:40]
            for kind in ("keyDown", "keyUp"):
                call("Input.dispatchKeyEvent", {"type": kind, "key": key, **({"windowsVirtualKeyCode": 13, "code": "Enter"}
                                                                            if key == "Enter" else {})})
        elif op == "scroll":
            call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": 200, "y": 200, "deltaX": 0,
                                              "deltaY": float(fields.get("dy") or 0)})
        elif op == "go":
            url = address(fields.get("url"))
            if not url:
                return "Type an address for this Pip's tab."
            grants = browser.lane(pip_id).grants
            host = urlsplit(url).hostname or ""
            if grants is not None and not grants.admits(host):
                return (f"This Pip uses only the sites you allowed it in DGC Browser ({grants.words()}). Open "
                        f"{host or 'that'} in your own tab instead.")
            call("Page.navigate", {"url": url})
        elif op in ("back", "forward"):
            history = call("Page.getNavigationHistory")
            entries, at = history.get("entries") or [], int(history.get("currentIndex") or 0)
            step = at - 1 if op == "back" else at + 1
            if 0 <= step < len(entries):
                call("Page.navigateToHistoryEntry", {"entryId": entries[step]["id"]})
        elif op == "reload":
            call("Page.reload")
        return ""

    def _picture(self, pip_id, target, session, base64) -> dict:
        browser = self.browser
        now = self.clock()
        if session not in self.casting:
            browser._fire("Page.enable", {}, session)
            browser._fire("Page.startScreencast", {"format": "jpeg", "quality": 55, "maxWidth": 1600, "maxHeight": 1200,
                                                   "everyNthFrame": 1}, session)
        self.casting[session] = now
        cached = self.frames.get(session)
        if cached is None or (now - cached[3] > FRESH_SECONDS and now - cached[3] >= FRAME_SECONDS):
            # A lane in the background of the person's window draws no screencast frames: a capture pictures it.
            try:
                data = str(browser._session_call(session, "Page.captureScreenshot", {"format": "jpeg", "quality": 55},
                                                 timeout=CAPTURE_SECONDS).get("data", ""))
            except socket.timeout:
                if cached is None:
                    return {"ok": False, "error": "Its page is still loading. The picture comes in a moment."}
                data = cached[0]
            from . import image_views
            width, height = image_views.dimensions(base64.b64decode(data or ""))
            cached = self.frames[session] = (data, width, height, now)
        info = browser.infos.get(target, {})
        data, width, height, _ = cached
        # (Its title the page's own words, as the row of tabs says them: never the lane's name in front again.)
        return {"ok": True, "pip_id": pip_id, "url": info.get("url", ""),
                "title": lane_title(info.get("title", ""), browser.lane_names.get(pip_id, "")),
                "width": int(width), "height": int(height), "image": "data:image/jpeg;base64," + data,
                "lanes": self.lanes()}

    # -- your own tab, streamed where there is no screen (decided 18 Nov) ------------------------------------------
    # Only the person drives it, through the editor tab's own events (view_call refuses everyone else): DGC itself never
    # drives the person's tabs (HostBrowser.command), and their frames are kept in memory only, never written or logged.

    def own_tab(self) -> str | None:
        """The person's tab the streamed tab shows: the one opened or chosen last, while it is there; else their newest."""
        browser = self.browser
        if browser is None:
            return None
        tabs = self.person_tabs()
        if self.own in tabs:
            return self.own
        if self.own and self.own in browser.infos and browser.whose(self.own) == PERSON:
            return self.own                        # (a tab just opened, not attached yet)
        self.own = tabs[-1] if tabs else None
        return self.own

    def _own_state(self) -> dict:
        browser, own = self.browser, self.own_tab()
        tabs = [{"id": t, "title": browser.infos.get(t, {}).get("title", ""), "url": browser.infos.get(t, {}).get("url", ""),
                 "current": t == own} for t in self.person_tabs()[:MAX_TABS]] if browser else []
        for tab in tabs:                          # each site's icon, once DGC has it (_want_icon)
            icon = self.icons.get(self.icon_of.get(tab["url"], ""))
            if icon:
                tab["icon"] = icon
        info = browser.infos.get(own, {}) if browser and own else {}
        return {"own": True, "current": own or "", "url": info.get("url", ""), "title": info.get("title", ""), "tabs": tabs}

    def _stop_own_cast(self) -> None:
        session = self._own_session()
        if session is not None:
            try:
                self.browser._fire("Page.stopScreencast", {}, session)
            except (OSError, AttributeError):
                pass
            self.acks.pop(session, None)
        self.own_cast = None
        with self.frame_ready:
            self.own_frame = None
            self.frame_ready.notify_all()

    def _size_window(self, target) -> None:
        """The headless window at the editor tab's size, so the page is laid out for it (never the person's own window
        where there is one)."""
        if not self.headless or not target:
            return
        try:
            window = self.browser._browser_call("Browser.getWindowForTarget", {"targetId": target}).get("windowId")
            if window is None:
                return
            width, height = self.own_size
            try:
                # The page's own size (the window's is larger by Chrome's bar, even headless).
                self.browser._browser_call("Browser.setContentsSize", {"windowId": window, "width": width, "height": height})
            except BrowserError:
                self.browser._browser_call("Browser.setWindowBounds", {"windowId": window, "bounds": {"width": width,
                                                                                                        "height": height}})
        except (BrowserError, socket.timeout, OSError):
            pass

    def _fill_screen(self, target) -> tuple[int, int]:
        """Chrome's window over the VNC screen at the editor tab's size: Chrome's own bar, tabs and page, laid out for the
        tab. Chrome's window is never narrower than its own minimum (500 px, Chrome 158 on a screen with no window
        manager), so it is read back as Chrome made it. Returns the screen's size, in its pixels, for the tab's viewer to
        ask for: as large as the tab and the whole window, so a tab narrower than the window scrolls to the rest of it
        at one screen pixel per tab pixel, never a window cut off at the screen's edge."""
        width, height = self.own_size
        made = (width, height)
        if target:
            try:
                window = self.browser._browser_call("Browser.getWindowForTarget", {"targetId": target}, timeout=5).get("windowId")
                if window is not None:
                    self.browser._browser_call("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "normal"}})
                    self.browser._browser_call("Browser.setWindowBounds", {"windowId": window, "bounds": {
                        "left": 0, "top": 0, "width": width, "height": height}})
                    bounds = self.browser._browser_call("Browser.getWindowBounds", {"windowId": window}, timeout=5).get("bounds") or {}
                    made = (int(bounds.get("width") or width), int(bounds.get("height") or height))
            except (BrowserError, socket.timeout, OSError, TypeError, ValueError):
                pass
        return (min(OWN_MOST[0], max(width, made[0])) * VNC_SCALE, min(OWN_MOST[1], max(height, made[1])) * VNC_SCALE)

    def _ensure_own_cast(self, target) -> None:
        """A screencast of the person's own tab, every frame, sized to the editor tab: started once per tab and size."""
        if target is None or target not in self.browser._attached:
            return
        if self.own_cast == (target, self.own_size):
            return
        self._stop_own_cast()
        self._size_window(target)
        session = self.browser._attached[target]
        self.browser._fire("Page.enable", {}, session)
        scale = SCREEN_SCALE if getattr(self.browser, "virtual", False) else 1   # its pixels, for a sharp picture
        self.browser._fire("Page.startScreencast", {"format": "jpeg", "quality": OWN_QUALITY,
                                                    "maxWidth": self.own_size[0] * scale,
                                                    "maxHeight": self.own_size[1] * scale, "everyNthFrame": 1}, session)
        self.own_cast, self.own_cast_at = (target, self.own_size), self.clock()

    def view_own(self, op: str, fields: dict) -> dict:
        """One request from the editor tab that streams the person's own tab: a frame (one newer than ``seq``, waited for
        a moment), or the person's own hand in it. Answers the tab's address and title and their own tabs (never a
        Pip's) with every reply."""
        if op == "frame":
            return self._own_frame(fields.get("seq") if type(fields.get("seq")) is int else 0)
        with self.lock:
            if not self.running():
                return {"ok": False, "closed": True, "error": "DGC Browser is closed. Open it again from the dock."}
            self.own_viewed = self.clock()
            if op == "close":
                self._stop_own_cast()
                return {"ok": True, "closed": True}
            if op == "selection":
                try:
                    return {"ok": True, "text": self._own_selection(self.own_tab()), **self._own_state()}
                except (BrowserError, socket.timeout, OSError, ValueError) as error:
                    return {"ok": False, "error": str(error)[:300] or "DGC Browser didn't answer.", **self._own_state()}
            try:
                refused = self._own_act(op, self.own_tab(), fields)
            except (BrowserError, socket.timeout, OSError, ValueError) as error:
                return {"ok": False, "error": str(error)[:300] or "DGC Browser didn't answer.", **self._own_state()}
            # (On its VNC screen, the size answers how many of the screen's pixels Chrome draws each of the page's with,
            # and the screen's size in them: the tab's own size, or Chrome's whole window where that is larger (a tab
            # narrower than Chrome's least width). The editor's tab asks the screen for it and shows it one to one.)
            scale = ({"scale": VNC_SCALE, "screen": {"width": self.screen_size[0], "height": self.screen_size[1]}}
                     if op == "size" and self.screen_socket() is not None and not refused else {})
            return {"ok": not refused, **({"error": refused} if refused else {}), **self._own_state(), **scale}

    def _own_frame(self, seq: int) -> dict:
        with self.lock:
            if not self.running():
                return {"ok": False, "closed": True, "error": "DGC Browser is closed. Open it again from the dock."}
            self.own_viewed = self.clock()
            target = self.own_tab()
            if target is None:
                target = self._own_new_tab("")
            self._ensure_own_cast(target)
            if target and self.clock() - self.own_info_at >= 0.5:
                # Its title and address as they are now (Chrome doesn't always say a title that comes after a page).
                self.own_info_at = self.clock()
                try:
                    info = self.browser._browser_call("Target.getTargetInfo", {"targetId": target}, timeout=5).get("targetInfo")
                    if isinstance(info, dict):
                        self.browser.told(info)
                except (BrowserError, socket.timeout, OSError):
                    pass
                self._want_icon(target)
        with self.frame_ready:
            if self.own_wait > 0 and not (self.own_frame is not None and self.own_frame[0] > seq):
                self.frame_ready.wait_for(lambda: self.own_frame is not None and self.own_frame[0] > seq,
                                          timeout=self.own_wait)
            frame = self.own_frame
        with self.lock:
            if not self.running():
                return {"ok": False, "closed": True, "error": "DGC Browser is closed. Open it again from the dock."}
            if frame is None and self.own_cast is not None and self.clock() - self.own_cast_at > 1.0:
                frame = self._own_capture()        # (a window that draws no frames now: a picture of it)
            reply = {"ok": True, **self._own_state(), "seq": seq}
            if frame is not None and frame[0] > seq:
                reply.update(seq=frame[0], image="data:image/jpeg;base64," + frame[1], width=frame[2], height=frame[3])
            elif frame is not None:
                reply.update(width=frame[2], height=frame[3])
            return reply

    _ICON_SOURCE = ("(() => { const l = [...document.querySelectorAll('link[rel~=\"icon\"], link[rel=\"shortcut icon\"]')]"
                    ".map(n => n.href).find(h => /^https?:/.test(h)); return l || (/^https?:/.test(location.href) ?"
                    " location.origin + '/favicon.ico' : ''); })()")

    def _icon_soon(self, target, url) -> None:
        """A visit of the person's to a page whose icon isn't known yet: looked up off Chrome's message loop (this is
        called from it, and the lookup waits for Chrome's answer), as the streamed tab looks it up while it draws; so
        the window beside the editor brings Home's Browser card its sites' icons too."""
        url = str(url or "")
        if self.headless or not url.startswith(("http://", "https://")) or url in self.icon_of or url in self.icon_asking:
            return                                      # (the streamed tab looks its icon up as it draws: view_own)
        self.icon_asking.add(url)

        def look():
            try:
                with self.lock:
                    if self.browser is not None:
                        self._want_icon(target)
            finally:
                self.icon_asking.discard(url)
        threading.Thread(target=look, daemon=True, name="dgc-browser-icon-ask").start()

    def _want_icon(self, target) -> None:
        """The site's icon for this tab: where its page says it is (asked once per address; the site's /favicon.ico
        for a tab Chrome hasn't let DGC into), downloaded once and kept by that address (in memory only), off the lock;
        a tab whose address has one already wears it."""
        url = self.browser.infos.get(target, {}).get("url", "") if self.browser else ""
        if not url.startswith(("http://", "https://")) or url in self.icon_of:
            return
        session = self.browser._attached.get(target)
        href = None
        if session is not None:
            try:
                reply = self.browser._session_call(session, "Runtime.evaluate", {"expression": self._ICON_SOURCE,
                                                                                  "returnByValue": True}, timeout=3)
                href = (reply.get("result") or {}).get("value") if isinstance(reply, dict) else None
            except (BrowserError, socket.timeout, OSError):
                return
        else:
            parts = urlsplit(url)
            href = f"{parts.scheme}://{parts.netloc}/favicon.ico" if parts.hostname else None
        if not isinstance(href, str) or not href.startswith(("http://", "https://")):
            return
        self.icon_of[url] = href[:2000]
        if self.icons.get(href):
            self.recent.wear(url, self.icons[href])      # (another page of the site brought it already)
        if href in self.icons or href in self.icon_pending:
            return
        self.icon_pending.add(href)

        def download():
            got = self.fetch_icon(href)
            data = icon_data(*got) if got else None
            with self.lock:
                self.icon_pending.discard(href)
                if len(self.icons) > 300:            # a long session's worth; never grows without end
                    self.icons.clear()
                    self.icon_of.clear()
                self.icons[href] = data or ""
                if data:                             # Home's Browser card wears it with the visit (22 Nov)
                    for page, source in list(self.icon_of.items()):
                        if source == href:
                            self.recent.wear(page, data)
        if self.icon_wait:
            download()
        else:
            threading.Thread(target=download, daemon=True, name="dgc-browser-icon").start()

    def _own_capture(self):
        target = self.own_tab()
        if target is None or target not in self.browser._attached:
            return None
        import base64
        from . import image_views
        try:
            data = str(self.browser.person_call(target, "Page.captureScreenshot", {"format": "jpeg", "quality": 70},
                                                timeout=CAPTURE_SECONDS).get("data", ""))
            width, height = image_views.dimensions(base64.b64decode(data or ""))
        except (BrowserError, socket.timeout, OSError, ValueError):
            return None
        with self.frame_ready:
            self.own_seq += 1
            self.own_frame = (self.own_seq, data, int(width), int(height), self.clock())
            return self.own_frame

    def _own_new_tab(self, url: str) -> str | None:
        browser = self.browser
        target = str(browser._browser_call("Target.createTarget", {"url": url or "chrome://newtab/"}).get("targetId", ""))
        if target:
            try:
                browser._wait_attached(target)
            except (BrowserError, socket.timeout, OSError):
                pass
            self.own = target
        return target or None

    _SELECTION = ("(() => { const a = document.activeElement;"
                  " if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|email|tel|number)$/i.test(a.type)))"
                  " && typeof a.selectionStart === 'number') return a.value.slice(a.selectionStart, a.selectionEnd);"
                  " return String(getSelection() || ''); })()")

    def _own_selection(self, target) -> str:
        """What is selected on your own page (a field's selected text, else the page's selection), for Copy and Cut in
        the editor's tab: it lands on the editor's clipboard, not Chrome's on this computer. Never a password field's."""
        session = self.browser._attached.get(target) if target else None
        if session is None:
            return ""
        reply = self.browser._session_call(session, "Runtime.evaluate", {"expression": self._SELECTION,
                                                                          "returnByValue": True}, timeout=5)
        value = (reply.get("result") or {}).get("value") if isinstance(reply, dict) else None
        return value[:100_000] if isinstance(value, str) else ""

    def _own_act(self, op: str, target, fields: dict) -> str:
        browser = self.browser
        if op == "size":
            width, height = fields.get("width"), fields.get("height")
            if type(width) is not int or type(height) is not int:
                return "The editor tab's size is its width and height."
            self.own_size = (max(320, min(OWN_MOST[0], width)), max(240, min(OWN_MOST[1], height)))
            if self.screen_socket() is not None:
                self.screen_size = self._fill_screen(target)   # (its screen streams itself: no pictures to make)
                return ""
            self._ensure_own_cast(target)
            return ""
        if op == "new_tab":
            self._own_new_tab(address(fields.get("url")))
            self._ensure_own_cast(self.own_tab())
            return ""
        if op in ("tab", "close_tab"):
            chosen = fields.get("tab") or target
            if chosen not in self.person_tabs():
                return "That isn't one of your tabs."
            if op == "tab":
                self.own = chosen
                browser._fire("Target.activateTarget", {"targetId": chosen})
            else:
                left = [t for t in self.person_tabs() if t != chosen]
                if not left:
                    left = [self._own_new_tab("")]     # (your last tab closed: a new one, as a window keeps one)
                if chosen == self.own:
                    self.own = left[-1]
                browser._browser_call("Target.closeTarget", {"targetId": chosen})
            self._ensure_own_cast(self.own_tab())
            return ""
        if target is None:
            return "DGC Browser has no tab open. Open a new one."
        call = lambda method, params=None: browser.person_call(target, method, params or {})   # noqa: E731
        if op == "input":
            for event in fields.get("events") or []:
                self._own_event(call, event)
        elif op == "go":
            url = address(fields.get("url"))
            if not url:
                return "Type an address or a search."
            call("Page.navigate", {"url": url})
        elif op in ("back", "forward"):
            history = call("Page.getNavigationHistory")
            entries, at = history.get("entries") or [], int(history.get("currentIndex") or 0)
            step = at - 1 if op == "back" else at + 1
            if 0 <= step < len(entries):
                call("Page.navigateToHistoryEntry", {"entryId": entries[step]["id"]})
        elif op == "reload":
            call("Page.reload")
        return ""

    # What a key is to Chrome: its Windows key code (for Enter, Tab, the arrows...) and the edit a shortcut makes.
    _KEY_CODES = {"Enter": 13, "Backspace": 8, "Tab": 9, "Escape": 27, " ": 32, "PageUp": 33, "PageDown": 34, "End": 35,
                  "Home": 36, "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40, "Insert": 45, "Delete": 46}
    _SHORTCUTS = {"a": "selectAll", "z": "undo", "y": "redo", "x": "cut", "c": "copy", "v": "paste"}

    def _own_event(self, call, event: dict) -> None:
        kind, mods = event["t"], int(event.get("mods") or 0)
        if kind in ("down", "up", "move", "wheel"):
            x, y = float(event["x"]), float(event["y"])
            if kind == "wheel":
                call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "modifiers": mods,
                                                  "deltaX": float(event.get("dx") or 0), "deltaY": float(event.get("dy") or 0)})
                return
            button = event.get("button") or ("left" if int(event.get("buttons") or 0) & 1 else "none")
            call("Input.dispatchMouseEvent", {"type": {"down": "mousePressed", "up": "mouseReleased", "move": "mouseMoved"}[kind],
                                              "x": x, "y": y, "modifiers": mods, "button": button,
                                              "buttons": int(event.get("buttons") or 0),
                                              "clickCount": int(event.get("clicks") or (0 if kind == "move" else 1))})
            return
        if kind == "text":
            call("Input.insertText", {"text": str(event.get("text") or "")[:MAX_TEXT]})
            return
        key, code = str(event.get("key") or ""), str(event.get("code") or "")
        shortcut = mods & (2 | 4)                  # Ctrl or Cmd: a shortcut, never text
        text = "\r" if key == "Enter" else ("" if shortcut else str(event.get("text") or (key if len(key) == 1 else "")))
        vk = self._KEY_CODES.get(key) or (ord(key.upper()) if len(key) == 1 and key.isascii() and key.isalnum() else 0)
        down = {"type": "keyDown" if text else "rawKeyDown", "key": key, "code": code, "modifiers": mods,
                "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
        if text:
            down.update(text=text, unmodifiedText=text)
        if shortcut and key.lower() in self._SHORTCUTS:
            down["commands"] = [self._SHORTCUTS[key.lower()]]
        call("Input.dispatchKeyEvent", down)
        call("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "code": code, "modifiers": mods,
                                        "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})

    def write_held(self, held) -> None:
        """A write a Pip's lane wanted to send. Right after the person's own click or key in that Pip's streamed tab it
        is theirs and goes. While that Pip's run drives its lane, it is handed to the run, which decides it as its own
        computer would (its level, careful mode, payments, an Allow card). With no run of that Pip, it isn't sent."""
        browser = self.browser
        if browser is None or held.request_id not in browser.held:
            return
        if self.clock() - self.person_acted.get(held.owner, -1e9) <= USER_WRITE_SECONDS:
            browser.release(held.request_id)
            return
        user = self.lane_users.get(held.owner)
        if user is not None and getattr(user, "run_id", None) is not None and isinstance(getattr(user, "_queued", None), list):
            user._queued.append(held)
            return
        browser.drop(held.request_id)

    # -- Clear browsing data (API 112) -----------------------------------------------------------------

    def clear(self, kinds) -> dict:
        """Clear browsing data, the person's own ask: Chrome is closed first (its files are only ever cleared with it
        stopped), then the kinds asked go from DGC's profile, then it opens again as it was (its window, or your tab in
        the editor), with a new tab of yours. Home's last links are forgotten here too for history, never written back."""
        with self.lock:
            was_open, headless = self.running(), self.headless
            pid = getattr(getattr(self.browser._box, "proc", None), "pid", None) if was_open else None
            real = was_open and hasattr(getattr(self.browser._box, "proc", None), "wait")
            if was_open:
                self.close()
                if real and pid:
                    _wait_group_gone(pid)          # (its helpers too: the network process holds the cookies)
            elif self.browser is not None:
                self._drop()
            cleared = clear_profile(self.directory, kinds)
            if "history" in cleared:
                self.recent.links, self.recent.dirty = [], False
            reopened = False
            if was_open:
                try:
                    self.open("", None, headless=headless)
                    reopened = True
                except (RegistryError, BoxError, BrowserError, OSError) as error:
                    self.error = str(error)[:400]
            return {"ok": True, "cleared": cleared, "reopened": reopened}

    # -- now and then (the supervisor's tick) --------------------------------------------------------

    def tick(self, registry) -> None:
        with self.lock:
            if registry is not None and self.signed_in:
                self._notice_signed_in(registry)
            if self.browser is not None and not self.browser.alive():
                self._drop()                       # its Chrome ended (the person quit it): nothing to close
            if not self.running():
                self._publish(registry)
                return
            if registry is not None:
                self._clear_sign_outs(registry)
            self._close_idle_lanes()
            if self.headless:
                # Headless, the person's tabs are always there: what keeps it open is the editor tab watching them
                # (or a Pip's lane). Nobody watching for 15 minutes, it closes (the profile stays).
                if not self.lanes() and not self.screen_viewers and self.clock() - self.own_viewed >= IDLE_SECONDS:
                    self.close()
                self._publish(registry)
                return
            busy = bool(self.browser._pages)
            if busy:
                self.empty_since = None
            elif self.empty_since is None:
                self.empty_since = self.clock()
            elif self.clock() - self.empty_since >= IDLE_SECONDS:
                self.close()
            self._publish(registry)

    def _close_idle_lanes(self) -> None:
        """A Pip's lane nobody's run has used for LANE_IDLE_SECONDS, with nothing of it waiting for the person, closes
        (its next run opens it again); so does one whose Pip has no run here at all."""
        browser = self.browser
        for lane in self.lanes():
            owner = lane["pip_id"]
            user = self.lane_users.get(owner)
            if any(h.owner == owner for h in browser.held.values()):
                continue
            if user is not None and (getattr(user, "run_id", None) is not None
                                     or time.monotonic() - float(getattr(user, "ended_at", 0.0)) < LANE_IDLE_SECONDS):
                continue
            self.close_lane(owner)

    def _clear_sign_outs(self, registry) -> None:
        """Sites the person signed out of while DGC Browser wasn't running (or since): their cookies, and those of
        their exact sign-in hosts, go now; then nothing waits for them."""
        waiting = _sign_outs(registry) if _has_metadata(registry) else []
        if not waiting:
            return
        browser = self.browser
        try:
            cookies = browser._browser_call("Storage.getCookies", {}).get("cookies") or []
            for entry in waiting:
                hosts = {h for h in entry.get("sso_hosts", []) if isinstance(h, str)}
                for cookie in cookies:
                    domain = str(cookie.get("domain", "")).lstrip(".").lower()
                    if domain and (site_key(domain) == entry["site"] or domain in hosts):
                        browser._browser_call("Network.deleteCookies", {"name": cookie.get("name", ""),
                                                                        "domain": cookie.get("domain", ""),
                                                                        "path": cookie.get("path", "/")})
        except (BrowserError, socket.timeout, OSError):
            return
        with registry.transaction():
            left = [s for s in _sign_outs(registry) if s["site"] not in {e["site"] for e in waiting}]
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SIGN_OUTS, json.dumps(left)))

    def publish_now(self) -> None:
        """What get_dgc_browser and the dock read, written at once: a lane's run began or ended, and the dock's tile and
        the Pip's chat say "working in it" while it is, not a tick later. Never in the way of the run."""
        from .workspace_registry import WorkspaceRegistry
        try:
            with WorkspaceRegistry(self.directory) as registry:
                with self.lock:
                    self._publish(registry)
        except Exception:                          # noqa: BLE001 - the next tick writes it anyway
            pass

    def _publish(self, registry) -> None:
        """What get_dgc_browser shows (the window, the person's tabs, the lanes) and the view's socket, written only
        when it changed."""
        if registry is None:
            return
        running = self.running()
        if running and self.viewer is None:
            self.viewer = ViewServer(self)
        tabs = []
        if running:
            for target in self.person_tabs()[:MAX_TABS]:
                info = self.browser.infos.get(target, {})
                tabs.append({"title": info.get("title", ""), "url": info.get("url", "")})
        state = {"open": running, "tabs": tabs, "lanes": self.lanes(), "error": self.error}
        said = json.dumps([state, self.viewer.endpoint() if self.viewer else None], sort_keys=True)
        if said == self.published:
            return
        with registry.transaction():
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (STATE_KEY, json.dumps({**state, "at": utc_now()})))
            if self.viewer is not None:
                registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (VIEW_KEY, json.dumps(self.viewer.endpoint())))
            else:
                registry.db.execute("DELETE FROM metadata WHERE key=?", (VIEW_KEY,))
        self.published = said


class ViewServer:
    """The streamed tab's way in: a private socket (this user's only) with a token, in the supervisor."""

    def __init__(self, host: DgcBrowserHost):
        import secrets
        from .pip_computer import socket_dir
        self.host = host
        self.token = secrets.token_hex(24)
        self.path = socket_dir() / f"yb-{os.getpid()}-{secrets.token_hex(4)}.sock"
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(self.path))
        os.chmod(self.path, 0o600)
        self.server.listen(8)
        self._stopped = threading.Event()
        threading.Thread(target=self._serve, name="dgc-browser-view", daemon=True).start()

    def endpoint(self) -> dict:
        return {"socket": str(self.path), "token": self.token}

    def _serve(self) -> None:
        while not self._stopped.is_set():
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(client,), daemon=True).start()

    def _one(self, client) -> None:
        import secrets
        with client:
            try:
                client.settimeout(30)
                raw = b""
                while not raw.endswith(b"\n") and len(raw) < 131072:
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    raw += chunk
                request = json.loads(raw.decode("utf-8"))
                if not isinstance(request, dict) or not secrets.compare_digest(str(request.get("token", "")), self.token):
                    reply = {"ok": False, "error": "refused"}
                elif request.get("op") == "screen":
                    # Your own window on its VNC screen (no screen here): after one line of reply the connection is the
                    # editor tab's stream, joined to that screen's socket as a Pip computer's viewer is to its own. Only
                    # your own (never with a Pip), and only where it draws on such a screen; elsewhere, pictures.
                    path = self.host.screen_socket() if request.get("own") is True and "pip_id" not in request else None
                    if request.get("own") is not True or "pip_id" in request:
                        reply = {"ok": False, "error": "refused"}
                    elif path is None:
                        reply = {"ok": False, "pictures": True, "error": "DGC Browser shows pictures of your tab here."}
                    else:
                        client.sendall(b'{"ok": true}\n')
                        from .pip_screen import splice
                        self.host.screen_opened()
                        try:
                            splice(client, Path(path), watching=lambda: False, on_input=self.host.person_input,
                                   idle_seconds=SCREEN_IDLE_SECONDS)
                        finally:
                            self.host.screen_closed()
                        return
                elif request.get("own") is True:
                    # The person's own tab: the editor's own side asked (view_call let only the person through).
                    reply = (self.host.view_own(str(request["op"]), request) if request.get("op") in OWN_OPS
                             else {"ok": False, "error": "Unknown view action."})
                elif request.get("op") not in VIEW_OPS:
                    reply = {"ok": False, "error": "Unknown view action."}
                else:
                    reply = self.host.view(str(request.get("pip_id", "")), str(request["op"]), request)
                client.sendall(json.dumps(reply).encode("utf-8") + b"\n")
            except (OSError, ValueError):
                return

    def close(self) -> None:
        self._stopped.set()
        try:
            self.server.close()
        except OSError:
            pass
        try:
            self.path.unlink()
        except OSError:
            pass


def _wait_group_gone(pid: int, seconds: float = 8.0) -> None:
    """Until every process of Chrome's group (it started its own session) has exited, or ``seconds`` pass."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            os.killpg(int(pid), 0)
        except (ProcessLookupError, PermissionError, ValueError):
            return
        except OSError:
            return
        time.sleep(0.05)


HOSTS: dict[str, DgcBrowserHost] = {}
_HOSTS_LOCK = threading.Lock()


def host_for(directory) -> DgcBrowserHost:
    with _HOSTS_LOCK:
        key = str(Path(directory))
        if key not in HOSTS:
            HOSTS[key] = DgcBrowserHost(directory)
        return HOSTS[key]


def tick(registry) -> None:
    """In the supervisor, every heartbeat: open what the person asked for (open_dgc_browser), then the window's own
    business (idle close, sign-outs to clear, what get_dgc_browser shows). Never stops the supervisor."""
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (OPEN_KEY,)).fetchone()
    asks = []
    if row is not None:
        with registry.transaction():
            registry.db.execute("DELETE FROM metadata WHERE key=?", (OPEN_KEY,))
        try:
            asks = [a for a in json.loads(row[0]) if isinstance(a, dict)][-MAX_ASKS:]
        except (TypeError, ValueError):
            asks = []
    # Clear browsing data (API 112) first: the person waits on it, and an open asked with it comes after.
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (CLEAR_KEY,)).fetchone()
    cleaning = None
    if row is not None:
        with registry.transaction():
            registry.db.execute("DELETE FROM metadata WHERE key=?", (CLEAR_KEY,))
        try:
            cleaning = json.loads(row[0])
        except (TypeError, ValueError):
            cleaning = None
        cleaning = cleaning if isinstance(cleaning, dict) else None
    # Work sessions' tabs (dgc_browser_work, 26 Nov): each session that asked has its own, confined to its sites; one
    # that stopped asking gives it back. Before the early return: a Work session's ask may be what starts DGC Browser.
    try:
        from . import dgc_browser_work
        dgc_browser_work.tick(registry)
    except Exception as error:                     # noqa: BLE001 - never stops the window's own business
        print(f"[dgc browser] work tab: {type(error).__name__}: {str(error)[:300]}", file=sys.stderr, flush=True)
    key = str(Path(registry.directory))
    if not asks and cleaning is None and key not in HOSTS:
        return
    host = host_for(registry.directory)
    if cleaning is not None:
        try:
            result = host.clear([name for name in CLEAR_KINDS if cleaning.get(name) is True])
        except (RegistryError, BoxError, BrowserError, OSError) as error:
            result = {"ok": False, "error": str(error)[:400] or "DGC Browser couldn't clear that."}
        answer_clear(registry, cleaning.get("id"), result)
    for ask in asks:
        place = ask.get("place") if isinstance(ask.get("place"), dict) else None
        try:
            host.open(str(ask.get("url") or ""), place, ask.get("pip_id") if isinstance(ask.get("pip_id"), str) else None,
                      headless=ask.get("headless") is True)
        except (RegistryError, BoxError, BrowserError, OSError) as error:
            host.error = str(error)[:400]
    host.tick(registry)
