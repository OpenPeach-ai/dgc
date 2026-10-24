"""How much a Personal Pip asks (Pips API 58): its approval level, set on its page by the user only.

Three levels, OpenMausBot's (docs/approval-levels.md) cut to what a Pip does:

- **Ask** (``ask``): today's behaviour. Careful mode asks before a new site, every submit its browser makes waits for
  Allow, and every app send is a draft waiting for Send.
- **Approve for me** (``approve``): DGC approves routine steps by itself and asks for consequential ones. Routine: a new
  site's first visit, a search, filter or sort, adding to a cart, saving a draft, an upload of a file the user sent in
  its chat, an email to someone the user already named or wrote to. Consequential, always asked: an order or checkout,
  a payment, sending to someone new, posting, deleting, account settings and passwords, anything the page calls pay,
  purchase, subscribe, transfer or book. Decided from the request itself (method, address, field names) and the words
  the page gives what was pressed; anything DGC can't place asks.
- **Full access** (``full``): no asking for sites, submits or app sends, except payments.

At every level, unchanged: a payment asks (a card number in the request, or a payment's words), a card the user types
on the Pip's screen is their own approval, the Pip never types a card, a saved login is sent only to its own site,
careful mode's check of what it read from the user's apps, and the safety floor: a Terminal command that could wipe
its Files waits for the user (OpenMausBot's safety floor, server/safety-floor.ts).

Everything here runs in the supervisor (pip_computer.Host, pip_action_grants.dispatch_for_run's neighbour): the Pip's
own process only ever reads the tool's answer. Each action a level approved is kept (a computer action ``sent`` by
``pip-level:<level>``, or an app action resolved by it), shown in the run's timeline and on the Pip's page under
"What it did on its own".
"""
from __future__ import annotations

import json
import re
import shlex
import time

from .workspace_registry import RegistryError, utc_now

ASK, APPROVE, FULL = "ask", "approve", "full"
LEVELS = (ASK, APPROVE, FULL)
# The level of every Pip nobody chose one for, new and old: no silent change in behaviour (founder, 2026-10-20).
DEFAULT = ASK
KEY = "pip_level:"                       # metadata: a Pip's chosen level, JSON {level, at, by}
FLOOR_KEY = "pip_floor_allowed:"         # metadata: Terminal commands the user let through the floor, once each
FLOOR_ALLOW_SECONDS = 30 * 60
LOCAL = ("editor-user", "local-console")
ACTOR = re.compile(r"pip-level:(approve|full)\Z")
NAMES = {ASK: "Ask", APPROVE: "Approve for me", FULL: "Full access"}
# One plain line a level: what will and won't ask. Shown with the picker and once when it is chosen.
SAYS = {
    ASK: "Asks before every new site, every submit and every send.",
    APPROVE: ("Opens new sites, searches, adds to carts and saves drafts by itself. Asks before it orders, pays, "
              "sends to someone new, posts, deletes or changes an account."),
    FULL: "Does it all by itself, sends included. Still asks before any payment.",
}
NOBODY = "nobody at the keyboard"
MAX_LISTED = 20


def name(level) -> str:
    return NAMES.get(level, NAMES[DEFAULT])


# --------------------------------------------------------------------------- the setting

def _personal(registry, pip_id) -> str:
    row = registry.db.execute("SELECT p.workspace_id FROM pips p JOIN workspaces w ON w.id=p.workspace_id "
                              "WHERE p.id=? AND w.kind='personal'", (pip_id,)).fetchone() if isinstance(pip_id, str) else None
    if row is None:
        raise RegistryError("not_found", "How much a Pip asks is set for a Personal Pip.")
    return row["workspace_id"]


def level(registry, pip_id) -> str:
    """The Pip's level: its own choice, else DEFAULT. A Project Pip, or a registry that can't say, is Ask."""
    try:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (KEY + str(pip_id),)).fetchone()
        value = json.loads(row["value"]).get("level") if row else None
    except Exception:                       # noqa: BLE001 - unreadable means the safe default
        return ASK
    if value not in LEVELS:
        return DEFAULT
    try:
        _personal(registry, pip_id)
    except RegistryError:
        return ASK
    return value


# A Personal Pip made from now on starts at Approve for me (founder, 2026-10-21): it removed every Allow tap in the
# bills and shirts tests while orders, payments, new recipients, posts and deletes still ask. A Pip made before has no
# saved level and stays at DEFAULT (Ask) until someone changes it.
NEW_PIP = APPROVE


def start(registry, pip_id) -> None:
    """Save NEW_PIP for a Personal Pip a creation surface just made, inside the caller's transaction. Never replaces a
    level someone chose."""
    registry.db.execute("INSERT OR IGNORE INTO metadata VALUES(?,?)",
                        (KEY + pip_id, json.dumps({"level": NEW_PIP, "at": utc_now(), "by": "new-pip"})))


def set_level(registry, pip_id, value, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you change how much a Pip asks, on this computer.")
    if value not in LEVELS:
        raise RegistryError("invalid_request", "Choose Ask, Approve for me or Full access.")
    _personal(registry, pip_id)
    with registry.transaction():
        write_level(registry, pip_id, value, actor)
    return listing(registry, pip_id)


def write_level(registry, pip_id, value, actor) -> None:
    """Save a Personal Pip's level, inside the caller's transaction (set_level, and a Pip template: pip_templates)."""
    if value not in LEVELS:
        raise RegistryError("invalid_request", "Choose Ask, Approve for me or Full access.")
    workspace = _personal(registry, pip_id)
    before = level(registry, pip_id)
    registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                        (KEY + pip_id, json.dumps({"level": value, "at": utc_now(), "by": actor})))
    registry.event(workspace, "pip_level_changed", pip_id=pip_id, payload={"level": value, "before": before, "actor": actor})


def listing(registry, pip_id) -> dict:
    """get_pip_level: the level, the three with their lines, and the newest things it did on its own."""
    _personal(registry, pip_id)
    return {"pip_id": pip_id, "level": level(registry, pip_id), "default": DEFAULT,
            "levels": [{"level": value, "name": NAMES[value], "says": SAYS[value]} for value in LEVELS],
            "on_its_own": on_its_own(registry, pip_id)}


def on_its_own(registry, pip_id, limit=MAX_LISTED) -> list[dict]:
    """What its level approved, newest first: [{at, what, level, unattended, kind}]. One line each, said once
    (the same first visit in three runs is one line)."""
    rows = []
    try:
        for row in registry.db.execute(
                "SELECT resolved_at,resolved_by,summary FROM pip_computer_actions WHERE pip_id=? AND status='sent' "
                "AND resolved_by LIKE 'pip-level:%' ORDER BY resolved_at DESC LIMIT ?", (pip_id, limit * 3)):
            summary = json.loads(row["summary"])
            rows.append({"at": row["resolved_at"], "what": str(summary.get("what") or "")[:200],
                         "level": row["resolved_by"].split(":", 1)[1], "unattended": summary.get("unattended") is True,
                         "kind": "site" if summary.get("kind") == "site" else "computer"})
    except Exception:                       # noqa: BLE001 - a registry without computers
        pass
    try:
        for row in registry.db.execute(
                "SELECT resolved_at,resolved_by,status,payload FROM pip_app_actions WHERE pip_id=? "
                "AND resolved_by LIKE 'pip-level:%' AND status IN ('succeeded','unknown') ORDER BY resolved_at DESC LIMIT ?",
                (pip_id, limit)):
            payload = json.loads(row["payload"])
            what = app_words(payload) + (" (not confirmed)" if row["status"] == "unknown" else "")
            rows.append({"at": row["resolved_at"], "what": what[:200], "level": row["resolved_by"].split(":", 1)[1],
                         "unattended": _unattended_run(registry, payload.get("source", {}).get("run_id")), "kind": "app"})
    except Exception:                       # noqa: BLE001 - a registry without app actions
        pass
    rows.sort(key=lambda r: str(r["at"]), reverse=True)
    out, seen = [], set()
    for row in rows:
        if not row["what"] or (row["what"], row["unattended"]) in seen:
            continue
        seen.add((row["what"], row["unattended"]))
        out.append(row)
    return out[:limit]


def _unattended_run(registry, run_id) -> bool:
    if not run_id:
        return False
    from .pip_careful import UNATTENDED
    row = registry.db.execute("SELECT requested_by FROM pip_runs WHERE id=?", (run_id,)).fetchone()
    return bool(row) and row[0] in UNATTENDED


def app_words(payload) -> str:
    kind = payload.get("kind")
    if kind == "gmail_send":
        return f"Sent an email to {payload.get('message', {}).get('recipient_email', '')}"
    if kind == "calendar_create":
        return f"Added “{payload.get('event', {}).get('summary', '')}” to your calendar"
    call = payload.get("call", {})
    return f"Ran {call.get('tool', '')} with {payload.get('server', '')}"


def timeline_label(value, what, unattended=False) -> str:
    """How the run's timeline names an action its level approved."""
    return f"Approved by its level: {name(value)} · {what}" + (f" · {NOBODY}" if unattended else "")


def told(value, what) -> str:
    """What the Pip's tool answer adds, so it knows the step went through."""
    return f"DGC approved that by the user's level ({name(value)}): {what}. It went through; carry on."


# --------------------------------------------------------------------------- routine or consequential

# Words are matched whole, on a lower-cased text split at anything that isn't a letter or digit (and at camelCase), so
# "addToCart", "add-to-cart" and "Add to cart" are the same three words.
def words(*texts) -> str:
    out = []
    for text in texts:
        if isinstance(text, (list, tuple, set)):
            out.append(words(*text).strip())
            continue
        spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(text or ""))
        out.extend(w for w in re.split(r"[^a-z0-9]+", spaced.lower()) if w)
    return " " + " ".join(out) + " "


def _find(pattern, text) -> str:
    found = re.search(r"(?<![a-z0-9])(?:" + pattern + r")(?![a-z0-9])", text)
    return found.group(0) if found else ""


# What a payment looks like, besides a card number (pip_computer_box.carries_card_number): the page calls it so, or it
# carries card or bank fields. A saved card sends a token, not a number: its words are how it shows.
PAYMENT = (r"pay|pays|paying|payment|payments|paynow|purchase|purchases|buy|buy now|buynow|place order|placeorder|"
           r"order now|complete order|confirm order|submit order|complete purchase|confirm purchase|donate|donation|"
           r"transfer|send money|subscribe|subscription|top up|topup|recharge|billing")
PAYMENT_FIELDS = (r"card|cardnumber|cvv|cvc|csc|cc num|cc number|ccnum|cc exp|ccexp|cc name|security code|expiry|"
                  r"exp month|exp year|iban|upi|vpa|account number|routing number|sort code|amount|payment method|"
                  r"payment token|card token")
CONSEQUENTIAL = (r"send|sends|sent|message|messages|email|mail|contact|post|posts|publish|share|tweet|comment|comments|"
                 r"reply|review|reviews|rate|rating|vote|delete|deletes|remove|erase|destroy|cancel|unsubscribe|"
                 r"password|passwd|passcode|account|accounts|settings|setting|profile|security|signup|sign up|"
                 r"register|registration|join|enroll|enrol|invite|book|booking|bookings|reserve|reservation|appointment|"
                 r"schedule|confirm|checkout|order|orders|claim|redeem|upload|uploads|attach|apply now")
# The routine ones, each with how the timeline says it.
ROUTINE = (
    (r"add to cart|addtocart|add to bag|add to basket|update cart|cart|basket|bag|quantity|qty", "Added to cart"),
    (r"save draft|savedraft|draft|drafts|autosave", "Saved a draft"),
    (r"wishlist|wish list|favourite|favorite|save for later", "Saved it for later"),
    (r"cookie|cookies|consent|gdpr|accept all|reject all|got it", "Answered the cookie notice"),
    (r"filter|filters|sort|sortby|sort by|refine", "Filtered the results"),
    (r"search|searches|find|lookup|look up|query|keyword|keywords|results|q", "Searched"),
    (r"load more|show more|see more|more results|next page", "Loaded more"),
    (r"check delivery|check availability|availability|pincode|pin code|postcode|zip", "Checked delivery"),
    (r"size|colour|color|variant|language|locale|currency", "Chose an option"),
)
UPLOAD_SECONDS = 15.0


def classify(cues) -> dict:
    """Routine or not, from what DGC itself saw of one held request.

    cues: method, host, path, fields (names), payment (a card number in it), target (the words of what the Pip pressed,
    when it pressed something), buttons (the submit buttons of the form it sent, read in DGC's own world of the page),
    upload (the name of a file from the user's chat the Pip just put in the page, if any).

    Returns {"verdict": "payment" | "consequential" | "routine" | "unsure", "what": a few words, "why": the word that
    decided}. Payment beats consequential beats routine; "unsure" asks at Approve for me."""
    host = str(cues.get("host") or "")
    method = str(cues.get("method") or "").upper()
    target = str(cues.get("target") or "")
    fields = [str(f) for f in cues.get("fields") or []]
    said = words(target) if target.strip() else words(cues.get("buttons") or [])
    path = words(cues.get("path") or "")
    names = words(fields)
    everything = said + path + names
    if cues.get("payment") is True:
        return {"verdict": "payment", "what": f"A payment on {host}", "why": "card number"}
    hit = _find(PAYMENT, said + path) or _find(PAYMENT_FIELDS, names)
    if hit:
        return {"verdict": "payment", "what": f"A payment on {host}", "why": hit.strip()}
    if method == "DELETE":
        return {"verdict": "consequential", "what": f"Deleted something on {host}", "why": "DELETE"}
    upload = str(cues.get("upload") or "")
    check = everything
    if upload:
        # The file the user sent, going where they asked: an upload page says "upload", and that is the point.
        check = " " + " ".join(w for w in everything.split() if w not in ("upload", "uploads", "attach", "file", "files")) + " "
    hit = _find(CONSEQUENTIAL, check)
    if hit:
        return {"verdict": "consequential", "what": _said_what(target, host, method, cues.get("path")), "why": hit.strip()}
    if upload:
        return {"verdict": "routine", "what": f"Uploaded {upload} to {host}", "why": "your file"}
    graphql = _graphql(cues)
    if graphql is not None:
        return graphql
    if any(f.strip().lower() in ("q", "query", "search", "s", "keyword", "keywords", "term") for f in fields):
        return {"verdict": "routine", "what": f"Searched on {host}", "why": "search field"}
    for pattern, verb in ROUTINE:
        hit = _find(pattern, everything)
        if hit:
            return {"verdict": "routine", "what": f"{verb} on {host}", "why": hit.strip()}
    return {"verdict": "unsure", "what": _said_what(target, host, method, cues.get("path")), "why": ""}


def _graphql(cues) -> dict | None:
    """A GraphQL request carries everything in one field named query: what it does is its operation (a query reads, a
    mutation changes) and the operation's name ("AddToCart", "PlaceOrder"). None when it isn't one. A payment or a
    consequential word anywhere was already caught; a mutation is routine only by its own name."""
    names = {str(f).strip().lower() for f in cues.get("fields") or []}
    values = cues.get("values") or {}
    if "graphql" not in str(cues.get("path") or "").lower() and "operationname" not in names:
        return None
    host = str(cues.get("host") or "")
    operation = str(values.get("operationName") or values.get("operationname") or "")
    text = str(values.get("query") or "").lstrip()
    said = words(operation)
    if _find(PAYMENT, said):
        return {"verdict": "payment", "what": f"A payment on {host}", "why": "graphql " + operation[:40]}
    if _find(CONSEQUENTIAL, said):
        return {"verdict": "consequential", "what": f"Sent {operation[:40]} to {host}", "why": "graphql " + operation[:40]}
    if text.startswith("mutation"):
        for pattern, verb in ROUTINE:
            if _find(pattern, said):
                return {"verdict": "routine", "what": f"{verb} on {host}", "why": "graphql " + operation[:40]}
        return {"verdict": "unsure", "what": f"Sent {operation[:40] or 'a change'} to {host}", "why": "graphql mutation"}
    if text.startswith(("query", "{")) and "mutation" not in text[:200]:
        return {"verdict": "routine", "what": f"Looked something up on {host}", "why": "graphql query"}
    return {"verdict": "unsure", "what": f"Sent a request to {host}", "why": "graphql"}


def _said_what(target, host, method, path) -> str:
    label = " ".join(str(target or "").split())[:60]
    if label:
        return f"Pressed “{label}” on {host}"
    return f"Sent a form to {host}{str(path or '/')[:80]}"


def decide_write(value, cues) -> dict | None:
    """Whether the level lets this held write through now. None: it waits for the user, as at Ask.
    Else {"what", "verdict"}."""
    if value not in (APPROVE, FULL):
        return None
    found = classify(cues)
    if found["verdict"] == "payment":
        return None                          # every level: a payment asks
    if value == FULL or found["verdict"] == "routine":
        return found
    return None


def site_words(site) -> str:
    return f"Opened {site} for the first time"


# --------------------------------------------------------------------------- the safety floor

FLOOR_LINE = "could delete everything in its Files"
_WRAPPERS = frozenset({"sudo", "doas", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "stdbuf",
                       "timeout", "busybox", "eval"})
_SEPARATORS = frozenset({";", "&&", "||", "|", "&", "(", ")", "\n", "|&", ";;", "{", "}"})
_FORK_BOMB = re.compile(r"(?:^|[\s;&|(){}])([A-Za-z_:.][\w:.-]{0,63})\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?![\w:.-])")


def _roots() -> set[str]:
    """Every name for its Files, or something holding them, in its Terminal (Files is its home, /home/pip) and in the
    desktop's apps (/home/pip/Files)."""
    out = set()
    for base in ("/", "/home", "/home/pip", "/home/pip/Files", "~", "~/Files", "$HOME", "${HOME}", "$HOME/Files",
                 "${HOME}/Files", ".", "..", "../..", "Files", "./Files"):
        stem = base.rstrip("/") or "/"
        out |= {stem, stem + "/", stem + "/*", stem + "/.*", stem + "/*.*", stem + "/{*,.*}"}
    return out | {"*", ".*", "./*", "*.*", "-- *"}


def floor(command) -> str | None:
    """What a Terminal command could do that no level lets through by itself ("could delete everything in its Files"),
    or None. Leans to letting a
    command run: words used as data (an echo, a quoted message) are never a command. A command the shell couldn't read
    (an open quote) doesn't run at all."""
    text = str(command or "")
    if _FORK_BOMB.search(text):
        return "would stop its computer (a fork bomb)"
    try:
        lexer = shlex.shlex(text.replace("$(", " ( ").replace("`", " ` "), posix=True, punctuation_chars=";&|()<>")
        lexer.whitespace_split = True
        lexer.commenters = "#"
        tokens = list(lexer)
    except ValueError:
        return None
    roots = _roots()
    command_words: list[list[str]] = [[]]
    for token in tokens:
        if token in _SEPARATORS or token == "`":
            command_words.append([])
        else:
            command_words[-1].append(token)
    for argv in command_words:
        while argv and (argv[0] in _WRAPPERS or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", argv[0]) or argv[0] == "env"):
            argv = argv[1:]
            while argv and argv[0].startswith("-") and argv[0] not in ("--",):
                argv = argv[1:]                # a wrapper's own flags (sudo -u, timeout -s)
            if argv and re.fullmatch(r"\d+[smhd]?", argv[0]):
                argv = argv[1:]                # timeout 10 rm ...
        if not argv:
            continue
        program = argv[0].rsplit("/", 1)[-1]
        args = argv[1:]
        if program in ("bash", "sh", "zsh", "dash") and len(args) >= 2 and args[0] == "-c":
            found = floor(args[1])
            if found:
                return found
            continue
        flags = [a for a in args if a.startswith("-") and a != "--"]
        targets = [a.rstrip() for a in args if not a.startswith("-") or a == "--"]
        targets = [t for t in targets if t != "--"]
        if program == "xargs" and "rm" in args:
            index = args.index("rm")
            if any(re.fullmatch(r"-[a-zA-Z]*[rR][a-zA-Z]*|--recursive", a) for a in args[index + 1:]):
                return FLOOR_LINE
        if program in ("rm", "unlink", "rmdir"):
            recursive = any(re.fullmatch(r"-[a-zA-Z]*[rR][a-zA-Z]*", f) or f == "--recursive" for f in flags)
            for target in targets:
                if target in roots and (recursive or target in ("*", ".*", "./*", "*.*", "~/*", "/home/pip/*",
                                                                 "$HOME/*", "${HOME}/*", "Files/*", "./Files/*")):
                    return FLOOR_LINE
        elif program == "find":
            starts = [a for a in args if not a.startswith("-")][:1] or ["."]
            if starts[0] in roots and ("-delete" in args or ("-exec" in args and any(a.rsplit("/", 1)[-1] in ("rm", "shred") for a in args))):
                return FLOOR_LINE
        elif program == "shred":
            if any(t in roots for t in targets) or any(f in ("-r", "--recursive") for f in flags):
                return FLOOR_LINE
        elif program == "rsync" and "--delete" in " ".join(flags) and targets and targets[-1] in roots:
            return FLOOR_LINE
        elif program == "git" and args[:1] == ["clean"] and any("f" in f for f in flags if not f.startswith("--")) \
                and any(("x" in f or "d" in f) for f in flags if not f.startswith("--")):
            return FLOOR_LINE
        elif program.startswith("mkfs") or program in ("wipefs", "fdisk", "sfdisk", "parted"):
            return "would format a disk"
        elif program == "dd" and any(a.startswith("of=/dev/") for a in args):
            return "would erase a disk"
        elif program == "mv" and targets and targets[-1] == "/dev/null" and any(t in roots for t in targets[:-1]):
            return FLOOR_LINE
    return None


def _floor_items(registry, pip_id) -> dict:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (FLOOR_KEY + pip_id,)).fetchone()
    try:
        value = json.loads(row["value"]) if row else {}
    except ValueError:
        value = {}
    now = time.time()
    return {k: v for k, v in value.items() if isinstance(v, (int, float)) and v > now} if isinstance(value, dict) else {}


def allow_floor(registry, pip_id, digest) -> None:
    """The user's Allow on a floor card: that exact command may run once, within half an hour."""
    with registry.transaction():
        items = _floor_items(registry, pip_id)
        items[str(digest)] = time.time() + FLOOR_ALLOW_SECONDS
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (FLOOR_KEY + pip_id, json.dumps(dict(list(items.items())[-20:]))))


def take_floor(registry, pip_id, digest) -> bool:
    """Whether the user allowed exactly this command; the Allow is used up."""
    with registry.transaction():
        items = _floor_items(registry, pip_id)
        if str(digest) not in items:
            return False
        del items[str(digest)]
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (FLOOR_KEY + pip_id, json.dumps(items)))
    return True


# --------------------------------------------------------------------------- what the model is told

def instructions(value, *, drafting=False, unattended=False) -> str:
    """The Pip's line about its level, after its computer's notice and the draft notices."""
    if value == APPROVE:
        line = ("How much you ask: the user chose Approve for me. DGC approves routine steps itself (a new site's first "
                "visit, a search, a filter, adding to a cart, saving a draft, an upload of a file they sent you) and the "
                "tool says so: carry on without stopping. Placing an order, a payment, sending to someone new, posting, "
                "deleting and account changes still wait for the user, as cards below your reply.")
        if drafting:
            line += (" After your reply, DGC sends a draft to someone the user named or already wrote to; any other "
                     "draft waits for them.")
    elif value == FULL:
        line = ("How much you ask: the user chose Full access. DGC lets your submits, new sites and sends through without "
                "asking, and the tool says so: carry on without stopping. A payment still waits for the user. Do only "
                "what they asked.")
        if drafting:
            line += " After your reply, DGC sends your drafts without asking (a payment excepted); never say one already went."
    else:
        return ""
    if unattended:
        line += " Nobody is at the keyboard in this run: the user sees what went through afterwards."
    return line


# --------------------------------------------------------------------------- app sends (drafts)

def _known_recipients(registry, pip_id) -> set[str]:
    """Addresses the user named in their own messages to this Pip, and ones they already sent to from it."""
    from .pip_chat import DGC_KEYS
    found = set()
    for row in registry.db.execute("SELECT text,request_key FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                   "ORDER BY seq DESC LIMIT 300", (pip_id,)):
        if str(row["request_key"] or "").startswith(DGC_KEYS):
            continue
        found |= {m.lower() for m in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", str(row["text"] or ""))}
    try:
        for row in registry.db.execute("SELECT payload FROM pip_app_actions WHERE pip_id=? AND status='succeeded' "
                                       "AND (resolved_by IN ('editor-user','local-console') OR resolved_by LIKE 'pip-grant:%')",
                                       (pip_id,)):
            payload = json.loads(row[0])
            if payload.get("kind") == "gmail_send":
                found.add(str(payload.get("message", {}).get("recipient_email", "")).lower())
            elif payload.get("kind") == "calendar_create":
                found |= {str(a).lower() for a in payload.get("event", {}).get("attendees") or []}
    except Exception:                       # noqa: BLE001 - no app actions yet
        pass
    return found


def decide_send(registry, pip_id, value, kind, content, *, money=False) -> dict | None:
    """Whether the level sends this draft without asking: {"what"} or None (it waits for the user).
    kind: email | calendar | connector; content: the draft's message, event or action."""
    if value not in (APPROVE, FULL) or money:
        return None
    if kind == "connector":
        call = content.get("call") or {}
        tool = str(call.get("tool") or "")
        said = words(tool, list((call.get("arguments") or {}).keys()))
        if _find(PAYMENT, said) or _find(r"charge|refund|invoice|payout|withdraw|deposit|swap|trade|order|orders", said):
            return None                      # a payment, by its own name, at every level
        from . import pip_sdk_apps
        server = str(content.get('server', ''))
        what = f"Ran {tool} with {pip_sdk_apps.display(pip_sdk_apps.name_of(server)) if pip_sdk_apps.is_app(server) else server}"
        if value == FULL:
            return {"what": what}
        if _find(CONSEQUENTIAL + r"|create|update|delete|archive|move|write|set|add", said) and not _find(r"draft|drafts", said):
            return None
        if _find(r"draft|drafts|search|find|list|get|fetch|read|lookup", said):
            return {"what": what}
        return None
    if kind == "email":
        recipient = str(content.get("recipient_email") or "")
        if value == FULL:
            return {"what": f"Sent an email to {recipient}"}
        return {"what": f"Sent an email to {recipient}"} if recipient.lower() in _known_recipients(registry, pip_id) else None
    if kind == "calendar":
        guests = [str(a).lower() for a in content.get("attendees") or []]
        what = f"Added “{content.get('summary', '')}” to your calendar"
        if value == FULL:
            return {"what": what}
        if not guests or set(guests) <= _known_recipients(registry, pip_id):
            return {"what": what}
        return None
    return None


def check(store, actor, payload) -> None:
    """An action run as its level (actor ``pip-level:<level>``) must be one its Pip's level lets through now."""
    if not isinstance(actor, str) or not ACTOR.fullmatch(actor):
        raise RegistryError("local_only", "External action reviews are available only in the local CLI and extension.")
    chosen = actor.split(":", 1)[1]
    pip_id = payload["source"]["pip_id"]
    if level(store.registry, pip_id) != chosen:
        raise RegistryError("local_only", "This Pip's level no longer lets that run without asking.")
    from .pip_action_grants import _asks_every_time
    kind = {"gmail_send": "email", "calendar_create": "calendar", "connector_call": "connector"}[payload["kind"]]
    content = payload["message"] if kind == "email" else payload["event"] if kind == "calendar" else {
        "server": payload["server"], "call": payload["call"]}
    if decide_send(store.registry, pip_id, chosen, kind, content, money=bool(_asks_every_time(payload))) is None:
        raise RegistryError("local_only", "This Pip's level doesn't let that run without asking.")


def _route(registry, config, pip_id, toolkit):
    """The connected account a level sends with: the Pip's own connected app, its account and its current schema."""
    from . import pip_app_accounts, pip_app_links
    link = next((a for a in pip_app_links.connected(registry, pip_id) if a["toolkit"] == toolkit), None)
    if link is None:
        raise RegistryError("not_connected", f"{toolkit} isn't connected to this Pip.")
    if toolkit == "gmail":
        from .pip_app_sends import inspect
    else:
        from .pip_calendar_actions import inspect
    found = inspect(config, link["server"])
    discovery = pip_app_accounts.discover(config, link["server"])
    if not any(a.get("toolkit") == toolkit and a.get("id") == link["account"] for a in discovery.get("accounts") or []):
        raise RegistryError("not_connected", f"The {toolkit} account this Pip uses is no longer connected.")
    return link["server"], discovery["connection_digest"], link["account"], found["schema_digest"]


def dispatch_for_run(registry, config, run_id) -> list:
    """After a finished run (and its Always-allow grants): send every draft it made that its level lets through, as
    that level (actor ``pip-level:<level>``). Never raises; a draft it can't send stays a draft for the user."""
    from . import pip_app_actions as actions, pip_message_drafts as drafts
    from .pip_action_grants import _asks_every_time
    from .pips import PipStore
    outcomes = []
    try:
        row = registry.db.execute("SELECT pip_id,workspace_id FROM pip_runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            return outcomes
        chosen = level(registry, row[0])
        if chosen == ASK:
            return outcomes
    except Exception:                       # noqa: BLE001
        return outcomes
    store = PipStore(registry)
    actor = "pip-level:" + chosen
    for draft_kind, table in (("email", "pip_message_drafts"), ("calendar", "pip_calendar_drafts"),
                              ("connector", "pip_connector_drafts")):
        try:
            ids = [r[0] for r in registry.db.execute(
                f"SELECT id FROM {table} WHERE source_run_id=? AND actor=? AND status='pending'",
                (run_id, f"pip-{draft_kind}:{run_id}")).fetchall()]
        except Exception:                   # noqa: BLE001 - a registry without that kind of draft
            continue
        for draft_id in ids:
            try:
                draft = drafts.get(store, draft_id, kind=draft_kind)
                field = "action" if draft_kind == "connector" else "event" if draft_kind == "calendar" else "message"
                content = draft["payload"][field]
                money = draft_kind == "connector" and bool(_asks_every_time({"kind": "connector_call", "server": content.get("server"),
                                                                             "call": content.get("call")}))
                if decide_send(registry, row[0], chosen, draft_kind, content, money=money) is None:
                    continue
                if draft_kind == "connector":
                    from .pip_connector_drafts import prepare
                    prepared = prepare(store, draft_id, draft["digest"], None, actor, config)
                else:
                    server, connection, account, schema = _route(registry, config, row[0],
                                                                 "gmail" if draft_kind == "email" else "googlecalendar")
                    prepared = drafts.prepare(store, draft_id, draft["digest"], server, connection, account, schema,
                                              content, actor, config, kind=draft_kind)
                done = actions.accept(store, prepared["id"], prepared["digest"], actor, config)
                outcomes.append({"action_id": done["id"], "status": done["status"], "level": chosen})
                registry.event(row[1], "pip_level_approved", pip_id=row[0], run_id=run_id,
                               payload={"action_id": done["id"], "level": chosen, "kind": draft_kind})
                from .pip_plugins import after_action
                after_action(store, config, done)     # a plugin action: the Pip reads its answer and carries on
            except Exception as exc:        # noqa: BLE001 - it stays a draft for the user
                outcomes.append({"draft_id": draft_id, "status": "waiting", "reason": str(exc)[:300]})
                try:
                    registry.event(row[1], "pip_level_skipped", pip_id=row[0], run_id=run_id,
                                   payload={"draft_id": draft_id, "reason": str(exc)[:300]})
                except Exception:           # noqa: BLE001
                    pass
    return outcomes
