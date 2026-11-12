"""Import a bot (pips-18): from a GitHub link, or from a Grok bot.

GitHub: a team file or one Pip's file at a github.com, raw.githubusercontent.com or gist address, fetched as a small
file (never a page, never another host, never a redirect elsewhere), then read by pip_share as any shared file.

Grok has no export. DGC gives the user a prompt to paste into their Grok bot (GROK_PROMPT), and the user pastes back what
the bot writes: one JSON block with its name, job, kind, skills and routines. That becomes one Personal Pip's file; its
skills and routines come along as notes on the card, to add on its page. Either way the result is setup cards the user
approves: no keys, no grants, nothing running until then. What comes back is data, never instructions.
"""
from __future__ import annotations

import json
import re
import urllib.request
from urllib.parse import urlsplit

from .workspace_registry import RegistryError

MAX_FETCH = 256 * 1024
MAX_ANSWER = 64 * 1024
FETCH_SECONDS = 15
KINDS = ("scout", "lens", "rook", "lock", "quill")      # a Personal Pip's kinds (a Pulse belongs to a project)
GROK_PROMPT = (
    "I'm moving you to another app called DGC. Describe yourself so it can set up the same assistant there. Reply with "
    "only one JSON code block, nothing before or after it, in exactly this shape:\n"
    "```json\n"
    '{"dgc_import": 1, "name": "your name", "job": "what you do for me, in two or three plain sentences", '
    '"kind": "scout", "skills": ["a skill you use"], "routines": [{"when": "every Monday at 9:00", "what": "what you do then"}]}\n'
    "```\n"
    "kind is one of: scout (finds and researches things), lens (watches something and tells me when it changes), "
    "quill (writes), rook (reviews and checks), lock (looks after security and accounts). Use an empty list when you "
    "have no skills or routines. Never include a password, key, token, account name, email address or anything private."
)


def _fail(message, code="invalid_import"):
    raise RegistryError(code, message)


def _line(value, most) -> str:
    return " ".join(str(value or "").split())[:most]


def parse_grok(text) -> tuple[dict, list[str]]:
    """What the user pasted from their Grok bot: (one Pip's shared file, the notes for its card)."""
    if not isinstance(text, str) or not text.strip():
        _fail("Paste what your Grok bot wrote.")
    if len(text) > MAX_ANSWER:
        _fail("That is longer than a Grok bot's description should be.")
    found = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S) or re.search(r"(\{.*\})", text, re.S)
    if not found:
        _fail("There is no JSON block in what you pasted. Ask your Grok bot again with the prompt DGC gave you.")
    try:
        value = json.loads(found.group(1))
    except ValueError:
        _fail("The JSON block in what you pasted couldn't be read. Ask your Grok bot again with the prompt.")
    if not isinstance(value, dict) or value.get("dgc_import") != 1:
        _fail("This isn't the description DGC asked for. Paste the JSON block your Grok bot wrote for the prompt.")
    name, job = _line(value.get("name"), 80), _line(value.get("job"), 2000)
    if not name or not job:
        _fail("The description needs the bot's name and its job.")
    kind = value.get("kind") if value.get("kind") in KINDS else "scout"
    notes = []
    skills = [_line(s, 120) for s in value.get("skills") or [] if isinstance(s, str) and s.strip()][:12]
    if skills:
        notes.append(("Its skills in Grok: " + ", ".join(skills) + ". Add the ones you want on its page.")[:300])
    for item in [r for r in value.get("routines") or [] if isinstance(r, dict)][:5]:
        when, what = _line(item.get("when"), 80), _line(item.get("what"), 160)
        if when and what:
            notes.append(f"A routine it had: {when}: {what}. Add it on its page."[:300])
    notes.append("Imported from a Grok bot: it arrives with no keys and no app access.")
    document = {"format": "dgc-pip", "version": 1, "left_out": notes[:8],
                "pip": {"name": name, "goal": job, "pip_type": kind, "scope": "personal", "schedule": None}}
    return document, notes[:8]


def raw_url(url) -> str:
    """The raw file behind a GitHub link: a file on github.com (…/blob/<ref>/<path>), or already a raw or gist file."""
    if not isinstance(url, str) or len(url) > 2048:
        _fail("Paste a GitHub link to a team file or a Pip file.")
    parts = urlsplit(url.strip())
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
        _fail("Paste an https GitHub link to a team file or a Pip file.")
    host = (parts.hostname or "").lower()
    if host in ("raw.githubusercontent.com", "gist.githubusercontent.com") and parts.path.count("/") >= 3:
        return f"https://{host}{parts.path}"
    m = re.fullmatch(r"/([^/]+)/([^/]+)/blob/([^/]+)/(.+)", parts.path) if host == "github.com" else None
    if not m:
        _fail("Paste a link to a file on GitHub (github.com/…/blob/…, or its raw address).")
    return f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}/{m.group(4)}"


def fetch(url, *, opener=None) -> str:
    """A small file from GitHub, never from anywhere it redirects to outside GitHub's raw hosts."""
    target = raw_url(url)
    request = urllib.request.Request(target, headers={"User-Agent": "DGC", "Accept": "application/json, text/plain"})
    try:
        with (opener or urllib.request.urlopen)(request, timeout=FETCH_SECONDS) as reply:
            landed = urlsplit(reply.geturl())
            if landed.scheme != "https" or (landed.hostname or "").lower() not in ("raw.githubusercontent.com", "gist.githubusercontent.com"):
                _fail("GitHub sent DGC somewhere else for that file, so nothing was read.")
            body = reply.read(MAX_FETCH + 1)
    except RegistryError:
        raise
    except Exception as exc:                      # noqa: BLE001 - said in words
        _fail(f"DGC couldn't read that file from GitHub ({type(exc).__name__}).", "fetch_failed")
    if len(body) > MAX_FETCH:
        _fail(f"That file is over {MAX_FETCH // 1024} KiB: too big for a team file.")
    try:
        return body.decode("utf-8")
    except UnicodeError:
        _fail("That file isn't text.")
