"""DGC's own Microsoft MCP server: Outlook mail, Outlook calendar and OneDrive, through Microsoft Graph.

Microsoft publishes no MCP server that a personal Microsoft account can use (Work IQ is for companies with Microsoft 365
Copilot), so DGC provides this one as part of DGC. It calls Microsoft Graph (https://graph.microsoft.com/v1.0) itself
with the token of DGC's own Microsoft sign-in; nothing else is installed or downloaded, and no community server is used.

How it runs
- When DGC connects the Microsoft plugin, it runs this server inside its own process (GraphConnection), driven over
  JSON-RPC lines exactly as mcp_remote's RemoteConnection is. Signing in, the system keychain and refreshing are then
  DGC's own: mcp_remote.RemoteAuth and plugin_credentials, as for every other plugin sign-in. The plugin's servers are
  saved as the stdio command ``python3 -m dgc.microsoft_graph <app>``; DGC adds its Microsoft app (from the catalog)
  only when it launches one that the installed Microsoft plugin owns (plugins.app_sign_in_launch).
- ``python -m dgc.microsoft_graph mail calendar onedrive`` is the same server over stdin and stdout, for any MCP client
  on this computer. It uses the sign-in the Microsoft plugin keeps, and refreshes it; it can't sign in by itself.

The sign-in is one for all of the plugin's apps, made when the plugin is connected (never in the middle of a
conversation), at Microsoft's ``consumers`` sign-in server for a personal account or ``organizations`` for a work or
school account. A token about to run out is refreshed; a call Graph answers with 401 refreshes once and is tried again;
a sign-in Microsoft ended is said in plain words. Tokens go only to Graph, in the Authorization header: never into a
tool's answer, a note, a log or the model's context, and never to a download or upload address (those are
pre-authorised by Microsoft and are never shown either).

Tools are DGC's, by app, each described for the model and marked the way Pips and dashboards read MCP tools: reading is
readOnlyHint; changing, moving or deleting is destructiveHint; anything that reaches other people (sending mail,
invitations, answers to the organiser) is openWorldHint. In the main chat every MCP call is approved like DGC's other
writes. Graph's paging comes back as ``next_page``, which the model passes again for more; throttling (429 or 503 with
Retry-After) waits and tries again a few times; every refusal is said in plain words.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import threading
import time
from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

from . import plugin_credentials as credentials
from .mcp_remote import RemoteAuth, RemoteError, RemoteOptions, SignInDeclined, _allowed

GRAPH = "https://graph.microsoft.com/v1.0"
MODULE = "dgc.microsoft_graph"
COMMAND = "python3"
APPS = ("mail", "calendar", "onedrive")
PLUGIN = "microsoft"
PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_TEXT = 100_000                  # characters of a message body or a file the model is given
MAX_READ = 2 * 1024 * 1024          # bytes of a OneDrive file read as text
MAX_TRANSFER = 250 * 1024 * 1024    # bytes of a file downloaded into the project or uploaded from it
SIMPLE_UPLOAD = 4 * 1024 * 1024     # Graph's limit for a one-request upload; larger ones use an upload session
CHUNK = 10 * 320 * 1024             # an upload session's piece: a multiple of 320 KiB, as Graph requires
RETRIES = 3                         # throttled requests tried again, each after Graph's Retry-After
MAX_WAIT = 30                       # seconds: a longer Retry-After is said, not waited for
MAX_CALLS = 32                      # tool calls in flight at once
NEEDS_SIGN_IN = "Needs sign-in. Connect it in Settings → Plugins."
STANDALONE_SIGN_IN = ("Sign in to Microsoft in DGC first: install the Microsoft plugin in Settings → Plugins (or run "
                      "`dgc plugin install microsoft`), then use this server again.")
WELL_KNOWN_FOLDERS = ("inbox", "drafts", "sentitems", "deleteditems", "archive", "junkemail", "outbox")
TEXT_TYPES = ("application/json", "application/xml", "application/javascript", "application/x-yaml",
              "application/yaml", "application/x-sh", "application/sql", "application/csv")
TEXT_SUFFIXES = (".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg",
                 ".log", ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".html", ".htm", ".css", ".sql", ".sh", ".rst",
                 ".tex", ".java", ".c", ".h", ".cpp", ".cs", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".vtt",
                 ".srt")
_ID = re.compile(r"[A-Za-z0-9=_+/.!:-]{1,512}")
_EMAIL = re.compile(r"[^@\s<>,;\"]{1,128}@[^@\s<>,;\"]{1,255}")
_ZONE = re.compile(r"[A-Za-z][A-Za-z0-9_+\-/]{0,63}")


class GraphError(Exception):
    """A tool call that didn't happen, in the words the user and the model are shown."""


# ------------------------------------------------------------------------------------------------------ the command

def is_builtin_spec(spec) -> bool:
    """A saved ``python3 -m dgc.microsoft_graph APP...``: this module's own server, exactly as the catalog saves it.
    DGC's app is added only at launch (plugins.app_sign_in_launch), so a saved form that already names an app is
    someone else's, never this one."""
    if not isinstance(spec, dict) or str(spec.get("transport") or "stdio") != "stdio" or spec.get("command") != COMMAND:
        return False
    try:
        apps, info = parse_args(spec.get("args"))
    except ValueError:
        return False
    return bool(apps) and not info and "--static-oauth-client-info" not in spec.get("args", [])


def saved_args(app: str) -> list[str]:
    return ["-m", MODULE, app]


def parse_args(args) -> tuple[list[str], dict]:
    """(the apps, DGC's app for the sign-in) from ``-m dgc.microsoft_graph APP... [--static-oauth-client-info JSON]``."""
    args = [str(a) for a in (args or [])] if isinstance(args, list) else []
    if args[:2] != ["-m", MODULE]:
        return [], {}
    apps, info, index = [], {}, 2
    while index < len(args):
        arg = args[index]
        if arg == "--static-oauth-client-info" and index + 1 < len(args):
            value = json.loads(args[index + 1])
            if not isinstance(value, dict):
                raise ValueError("DGC's Microsoft app must be a JSON object")
            info = value
            index += 2
            continue
        if arg not in APPS or arg in apps:
            raise ValueError(f"not one of DGC's Microsoft apps: {arg[:40]}")
        apps.append(arg)
        index += 1
    return apps, info


# ------------------------------------------------------------------------------------------------------ Graph

def _retry_after(response, attempt: int) -> float:
    value = str(response.headers.get("Retry-After") or "").strip()
    if value.isdigit():
        return float(value)
    return float(2 ** (attempt + 1))


def _graph_error(response) -> tuple[str, str]:
    """(code, message) of Graph's error body, each bounded and on one line."""
    try:
        body = response.json() if len(response.content) <= 256 * 1024 else {}
    except ValueError:
        body = {}
    found = body.get("error") if isinstance(body, dict) else None
    if not isinstance(found, dict):
        return "", ""
    code = str(found.get("code") or "")[:80]
    message = " ".join(str(found.get("message") or "").split())[:300]
    return code, message


def _wait(seconds: float, cancelled) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if cancelled():
            raise GraphError("Cancelled.")
        time.sleep(min(0.2, max(0.0, deadline - time.monotonic())))


class Graph:
    """Microsoft Graph for one sign-in: the token on each call to Graph and nowhere else, refreshed once after a 401,
    Graph's Retry-After honoured, and every refusal turned into plain words."""

    def __init__(self, auth: RemoteAuth, session, *, base: str = "", sign_in_words: str = NEEDS_SIGN_IN,
                 note=lambda _text: None):
        self.auth, self.session, self.note = auth, session, note
        self.base = (base or GRAPH).rstrip("/")
        self.sign_in_words = sign_in_words
        self._page_links: OrderedDict[str, str] = OrderedDict()
        self._page_lock = threading.Lock()

    # the sign-in --------------------------------------------------------------------------------------------------
    def _ended(self) -> str:
        if self.auth.signed_out:
            return f"{self.auth.signed_out} Connect it in Settings → Plugins."
        return self.sign_in_words

    def _authorization(self) -> dict:
        try:
            tokens = self.auth.tokens()
        except credentials.CredentialError:
            tokens = {}
        if not tokens.get("access_token"):
            raise GraphError(self.sign_in_words)
        header = self.auth.header()                      # refreshes a token about to run out
        if not header:
            raise GraphError(self._ended())
        return header

    def _refresh(self, stale: dict) -> None:
        try:
            with self.auth.lock:
                self.auth.refresh(stale)
        except (RemoteError, credentials.CredentialError) as exc:
            self.note(f"couldn't renew the sign-in ({type(exc).__name__})")
            if self.auth.signed_out:
                raise GraphError(self._ended()) from None
            raise GraphError("Microsoft didn't accept DGC's sign-in, and DGC couldn't renew it. Connect the plugin "
                             "again in Settings → Plugins.") from None

    def granted(self) -> set[str]:
        """The permissions the sign-in was granted, as Graph names them (Mail.ReadWrite), lower-cased."""
        scope = str((self.auth.tokens() or {}).get("scope") or "")
        return {s.rstrip("/").rsplit("/", 1)[-1].lower() for s in scope.split()}

    # requests ------------------------------------------------------------------------------------------------------
    def url(self, path: str) -> str:
        if path.startswith(("https://", "http://")):
            if not path.startswith(self.base + "/") or not _allowed(path):
                raise GraphError("That next_page isn't one Microsoft Graph gave DGC; list again without it.")
            return path
        return self.base + path

    def request(self, method: str, path: str, *, params=None, body=None, data=None, headers=None, cancelled,
                stream: bool = False):
        """One Graph call, its Authorization header from the sign-in. Returns the response (any status), or raises
        GraphError when the sign-in is missing or ended, Graph is unreachable, or it keeps throttling DGC."""
        url = self.url(path)
        refreshed, throttled = False, 0
        while True:
            if cancelled():
                raise GraphError("Cancelled.")
            stale = dict(self.auth.tokens() or {})
            sent = {"Accept": "application/json", **(headers or {}), **self._authorization()}
            try:
                response = self.session.request(method, url, params=params, json=body, data=data, headers=sent,
                                                timeout=(15, 120), allow_redirects=False, stream=stream)
            except Exception as exc:                     # noqa: BLE001 -- said in words; the URL is never repeated
                raise GraphError(f"DGC couldn't reach Microsoft ({type(exc).__name__}). Check the connection and "
                                 "try again.") from None
            status = response.status_code
            if status == 401 and not refreshed:
                response.close()
                refreshed = True
                self._refresh(stale)
                continue
            if status in (429, 503, 504):
                wait = _retry_after(response, throttled)
                if throttled < RETRIES and wait <= MAX_WAIT:
                    response.close()
                    throttled += 1
                    self.note(f"Microsoft asked DGC to wait {wait:.0f} s (HTTP {status})")
                    _wait(wait, cancelled)
                    continue
                response.close()
                raise GraphError("Microsoft is limiting how often DGC can ask right now (too many requests in a short "
                                 f"time). Try again in {max(1, round(wait))} seconds.")
            return response

    def json(self, method: str, path: str, *, what: str, cancelled, expect=(200, 201), **kwargs):
        response = self.request(method, path, cancelled=cancelled, **kwargs)
        try:
            if response.status_code not in expect:
                raise GraphError(self.refusal(response, what))
            if response.status_code in (202, 204) or not response.content:
                return {}
            try:
                value = response.json()
            except ValueError:
                raise GraphError("Microsoft sent an answer DGC couldn't read.") from None
            return value if isinstance(value, dict) else {}
        finally:
            response.close()

    def refusal(self, response, what: str) -> str:
        """Graph's refusal of a call about WHAT ("message", "event", "file"), in plain words."""
        status = response.status_code
        code, message = _graph_error(response)
        said = f" Microsoft said: {message}" if message else ""
        if code == "MailboxNotEnabledForRESTAPI" or "MailboxNotEnabledForRESTAPI" in message:
            return ("Microsoft says this account has no Outlook mailbox DGC can use (an account made with another "
                    "email address has none, and some work accounts keep their mail on their own servers).")
        if status == 401:
            return "Microsoft didn't accept DGC's sign-in (HTTP 401). Connect the plugin again in Settings → Plugins."
        if status == 403:
            return f"Microsoft didn't allow this ({code or 'HTTP 403'}).{said}"
        if status == 404:
            return f"Microsoft found no {what} there. It may have been moved or deleted, or the id is wrong."
        if status == 409:
            return f"That conflicts with what is already there.{said}"
        if status == 413:
            return "That is too large for Microsoft to take in one go."
        if status == 400:
            return f"Microsoft said this request isn't valid.{said}"
        if status >= 500:
            return f"Microsoft's service had a problem (HTTP {status}). Try again in a moment."
        return f"Microsoft answered HTTP {status}.{said}"

    def page(self, path: str, params: dict, next_page: str, *, what: str, cancelled, headers=None,
             scope: str = "") -> tuple[list, str]:
        """One page of a Graph collection. A continuation must be a link this connection issued for that scope."""
        if next_page:
            with self._page_lock:
                if self._page_links.get(next_page) != scope:
                    raise GraphError("That next_page isn't one this listing gave DGC; list again without it.")
            value = self.json("GET", self.url(next_page), what=what, cancelled=cancelled, headers=headers)
        else:
            value = self.json("GET", path, params=params, what=what, cancelled=cancelled, headers=headers)
        items = [item for item in (value.get("value") or []) if isinstance(item, dict)]
        following = value.get("@odata.nextLink")
        following = (following if isinstance(following, str) and following.startswith(self.base + "/")
                     and _allowed(following) else "")
        if following:
            with self._page_lock:
                self._page_links[following] = scope
                self._page_links.move_to_end(following)
                if len(self._page_links) > 256:
                    self._page_links.popitem(last=False)
        return items, following

    def download(self, url: str, sink, limit: int, *, cancelled) -> int:
        """A file's bytes from Microsoft's pre-authorised download address, into SINK. No Authorization header goes
        there, and the address itself is never shown."""
        if not isinstance(url, str) or not _allowed(url):
            raise GraphError("Microsoft gave no download address DGC can use for this file.")
        response = None
        original_scheme = urlsplit(url).scheme
        for _hop in range(6):
            if cancelled():
                raise GraphError("Cancelled.")
            try:
                response = self.session.get(url, stream=True, timeout=(15, 120), allow_redirects=False,
                                            headers={"Accept": "*/*"})
            except Exception as exc:                     # noqa: BLE001
                raise GraphError(f"DGC couldn't download the file from Microsoft ({type(exc).__name__}).") from None
            if response.status_code not in (301, 302, 303, 307, 308):
                break
            following = urljoin(url, response.headers.get("Location") or "")
            response.close()
            if not _allowed(following) or (original_scheme == "https" and urlsplit(following).scheme != "https"):
                raise GraphError("Microsoft redirected the file to an address DGC can't use.")
            url = following
        else:
            raise GraphError("Microsoft redirected the file too many times.")
        try:
            if response.status_code != 200 or not _allowed(response.url):
                raise GraphError(f"Microsoft didn't send the file (HTTP {response.status_code}). Try again.")
            total = 0
            for chunk in response.iter_content(64 * 1024):
                if cancelled():
                    raise GraphError("Cancelled.")
                total += len(chunk)
                if total > limit:
                    raise GraphError(f"The file is larger than DGC takes ({limit // (1024 * 1024)} MB).")
                sink(chunk)
            return total
        finally:
            response.close()

    def upload(self, path: str, content: bytes, *, conflict: str, what: str, cancelled) -> dict:
        """Upload CONTENT to PATH (``/me/drive/root:/folder/name:`` or ``/me/drive/items/{id}``): one request up to
        4 MB, else an upload session in pieces sent to Microsoft's pre-authorised upload address (no token there)."""
        if len(content) <= SIMPLE_UPLOAD:
            return self.json("PUT", path + "/content", params={"@microsoft.graph.conflictBehavior": conflict},
                             data=content, headers={"Content-Type": "application/octet-stream"}, what=what,
                             cancelled=cancelled)
        session = self.json("POST", path + "/createUploadSession", what=what, cancelled=cancelled,
                            body={"item": {"@microsoft.graph.conflictBehavior": conflict}})
        target = session.get("uploadUrl")
        if not isinstance(target, str) or not _allowed(target):
            raise GraphError("Microsoft gave no upload address DGC can use.")
        done, total = {}, len(content)
        for start in range(0, total, CHUNK):
            if cancelled():
                with contextlib.suppress(Exception):
                    self.session.delete(target, timeout=(5, 10))
                raise GraphError("Cancelled. Nothing was saved in OneDrive.")
            piece = content[start:start + CHUNK]
            try:
                response = self.session.put(target, data=piece, timeout=(15, 300), allow_redirects=False, headers={
                    "Content-Length": str(len(piece)),
                    "Content-Range": f"bytes {start}-{start + len(piece) - 1}/{total}"})
            except Exception as exc:                     # noqa: BLE001
                raise GraphError(f"DGC couldn't send the file to Microsoft ({type(exc).__name__}). Nothing was "
                                 "saved in OneDrive.") from None
            try:
                if response.status_code not in (200, 201, 202):
                    raise GraphError(self.refusal(response, what))
                if response.status_code in (200, 201):
                    with contextlib.suppress(ValueError):
                        done = response.json()
            finally:
                response.close()
        return done if isinstance(done, dict) else {}


# ------------------------------------------------------------------------------------------------------ helpers

def _text(value, name: str, limit: int, *, required: bool = False) -> str:
    if value is None or value == "":
        if required:
            raise GraphError(f"{name} is needed.")
        return ""
    if not isinstance(value, str):
        raise GraphError(f"{name} must be text.")
    if len(value) > limit:
        raise GraphError(f"{name} is longer than {limit} characters.")
    return value


def _flag(value, name: str, default: bool = False) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise GraphError(f"{name} must be true or false.")
    return value


def _count(value, name: str, default: int, low: int, high: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise GraphError(f"{name} must be a whole number.")
    return max(low, min(int(value), high))


def _ident(value, name: str = "id") -> str:
    text = _text(value, name, 512, required=True)
    if not _ID.fullmatch(text):
        raise GraphError(f"That {name} isn't one Microsoft gave DGC.")
    return quote(text, safe="")


def _addresses(value, name: str) -> list[dict]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [part for part in re.split(r"[,;]", value) if part.strip()]
    if not isinstance(value, list) or len(value) > 100:
        raise GraphError(f"{name} must be a list of email addresses.")
    found = []
    for item in value:
        address = str(item or "").strip()
        match = re.fullmatch(r"(?:[^<>]*<)?\s*([^<>\s]+)\s*>?", address)
        address = match.group(1) if match else ""
        if not _EMAIL.fullmatch(address):
            raise GraphError(f"{str(item)[:80]!r} in {name} isn't an email address.")
        found.append({"emailAddress": {"address": address}})
    return found


def _person(value) -> str:
    found = (value or {}).get("emailAddress") if isinstance(value, dict) else None
    if not isinstance(found, dict):
        return ""
    name, address = str(found.get("name") or "").strip(), str(found.get("address") or "").strip()
    return f"{name} <{address}>" if name and address and name != address else (address or name)


def _people(values) -> list[str]:
    return [p for p in (_person(v) for v in (values or [])[:50] if isinstance(v, dict)) if p]


def _cut(text: str, limit: int = MAX_TEXT) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + f"\n[… {len(text) - limit} more characters not shown]"


def _zone(value) -> tuple[str, object]:
    name = _text(value, "time_zone", 64) or "UTC"
    if not _ZONE.fullmatch(name):
        raise GraphError("time_zone must be a time zone name such as Europe/London or UTC.")
    if name.upper() == "UTC":
        return "UTC", timezone.utc
    try:
        from zoneinfo import ZoneInfo
        return name, ZoneInfo(name)
    except Exception:                                    # noqa: BLE001 -- an unknown name, said plainly
        raise GraphError(f"DGC doesn't know the time zone {name!r}: use a name such as Europe/London.") from None


def _when(value, name: str, zone) -> tuple[datetime, bool]:
    """A date (2026-11-03) or date and time (2026-11-03T15:00, with or without an offset) as an aware datetime, and
    whether only a date was given. A time without an offset is in ZONE."""
    text = _text(value, name, 40, required=True).strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            day = date.fromisoformat(text)
            return datetime(day.year, day.month, day.day, tzinfo=zone), True
        moment = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text)
    except ValueError:
        raise GraphError(f"{name} must be a date like 2026-11-03 or a date and time like 2026-11-03T15:00.") from None
    return (moment.replace(tzinfo=zone) if moment.tzinfo is None else moment), False


def _graph_time(moment: datetime, zone_name: str, zone) -> dict:
    return {"dateTime": moment.astimezone(zone).replace(tzinfo=None).isoformat(timespec="seconds"),
            "timeZone": zone_name}


def _utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _drive_path(value, name: str = "path") -> str:
    """A OneDrive path (Documents/Reports/plan.docx) as Graph's path segment, each part escaped."""
    text = _text(value, name, 400).strip().strip("/")
    if not text:
        return ""
    parts = text.split("/")
    if any(not part or part in (".", "..") or any(ord(c) < 32 for c in part) for part in parts):
        raise GraphError(f"{name} must be a folder path such as Documents/Reports.")
    return "/".join(quote(part, safe="") for part in parts)


def _item_path(arguments: dict) -> str:
    """The OneDrive item a call names: by ``id`` or by ``path``."""
    if arguments.get("id"):
        return f"/me/drive/items/{_ident(arguments.get('id'))}"
    path = _drive_path(arguments.get("path"))
    if not path:
        raise GraphError("Name the file by its id (from search_files) or its path in OneDrive.")
    return f"/me/drive/root:/{path}:"


def _in_project(root: Path, value, name: str) -> Path:
    """A path inside the project (relative to it, or absolute within it), never outside it or through a link."""
    text = _text(value, name, 1000, required=True)
    base = root.resolve(strict=False)
    target = (base / text).resolve(strict=False) if not os.path.isabs(text) else Path(text).resolve(strict=False)
    try:
        target.relative_to(base)
    except ValueError:
        raise GraphError(f"{name} must be inside the project ({base}).") from None
    if target == base:
        raise GraphError(f"{name} must name a file inside the project.")
    return target


def _drive_item(item: dict) -> dict:
    parent = str(((item.get("parentReference") or {}).get("path")) or "")
    where = parent.split("root:", 1)[1] if "root:" in parent else ""
    row = {"id": item.get("id"), "name": item.get("name"), "folder": isinstance(item.get("folder"), dict),
           "size": item.get("size"), "modified": item.get("lastModifiedDateTime"),
           "path": (where.strip("/") + "/" if where.strip("/") else "") + str(item.get("name") or ""),
           "web_url": item.get("webUrl")}
    return {k: v for k, v in row.items() if v not in (None, "")}


def _event(item: dict) -> dict:
    location = (item.get("location") or {}).get("displayName") if isinstance(item.get("location"), dict) else ""
    start, end = item.get("start") or {}, item.get("end") or {}
    attendees = [a for a in (item.get("attendees") or []) if isinstance(a, dict)]
    meeting = item.get("onlineMeeting") if isinstance(item.get("onlineMeeting"), dict) else {}
    row = {"id": item.get("id"), "subject": item.get("subject"),
           "start": f"{start.get('dateTime', '')} {start.get('timeZone', '')}".strip(),
           "end": f"{end.get('dateTime', '')} {end.get('timeZone', '')}".strip(),
           "all_day": item.get("isAllDay"), "location": location, "organizer": _person(item.get("organizer")),
           "attendees": [_person(a) + (f" ({(a.get('status') or {}).get('response')})"
                                       if (a.get("status") or {}).get("response") not in (None, "none") else "")
                         for a in attendees[:20]] or None,
           "more_attendees": max(0, len(attendees) - 20) or None,
           "my_response": (item.get("responseStatus") or {}).get("response"),
           "cancelled": item.get("isCancelled") or None, "online_meeting": meeting.get("joinUrl"),
           "show_as": item.get("showAs")}
    return {k: v for k, v in row.items() if v not in (None, "", [])}


def _message(item: dict) -> dict:
    row = {"id": item.get("id"), "subject": item.get("subject"), "from": _person(item.get("from")),
           "received": item.get("receivedDateTime"), "unread": item.get("isRead") is False,
           "attachments": bool(item.get("hasAttachments")), "draft": item.get("isDraft") or None,
           "preview": " ".join(str(item.get("bodyPreview") or "").split())[:240]}
    return {k: v for k, v in row.items() if v not in (None, "")}


def _result(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=1)


# ------------------------------------------------------------------------------------------------------ the tools

_READ = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
_ADD = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False}
_CHANGE = {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": False}
_REACH = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}
_CHANGE_REACH = {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": True}

_S = {"type": "string"}
_B = {"type": "boolean"}
_EMAILS = {"type": "array", "items": {"type": "string"}, "maxItems": 100,
           "description": "Email addresses, such as ana@example.com."}
_NEXT = {"type": "string", "description": "The next_page a previous answer gave, to get the next ones."}
_ZONE_FIELD = {"type": "string", "description": "A time zone name such as Europe/London, for times given without an "
                                                "offset and for the times in the answer. UTC when not given."}


def _schema(properties: dict, required=()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


# What each app's tools need, as Graph names the permission (for a refusal that is about a permission not granted).
APP_PERMISSIONS = {"mail": ("Mail.ReadWrite", "Mail.Send"), "calendar": ("Calendars.ReadWrite",),
                   "onedrive": ("Files.ReadWrite",)}


class GraphServer:
    """The tools of the chosen apps, answering MCP's initialize, tools/list and tools/call."""

    def __init__(self, apps, graph: Graph, *, root, auth: RemoteAuth | None = None):
        self.apps = [app for app in APPS if app in apps]
        self.graph, self.auth = graph, auth
        self.root = Path(root or os.getcwd())
        self.tools: dict = {}
        for app in self.apps:
            for name, title, description, schema, marks, handler in getattr(self, f"_{app}_tools")():
                self.tools[name] = ({"name": name, "title": title, "description": description, "inputSchema": schema,
                                     "annotations": {"title": title, **marks}}, app, handler)

    # MCP ---------------------------------------------------------------------------------------------------------
    def initialize(self, params) -> dict:
        from . import __version__
        asked = params.get("protocolVersion") if isinstance(params, dict) else None
        names = {"mail": "Outlook mail", "calendar": "the Outlook calendar", "onedrive": "OneDrive"}
        return {"protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[1],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "dgc-microsoft", "title": "Microsoft (DGC)", "version": __version__},
                "instructions": ("DGC's own Microsoft server: " + ", ".join(names[a] for a in self.apps)
                                 + " for the signed-in Microsoft account, through Microsoft Graph. Ids come from the "
                                 "search and list tools; pass next_page back for more.")}

    def handle(self, message: dict, cancelled=lambda: False):
        """One JSON-RPC message in, its answer out (None for a notification)."""
        if not isinstance(message, dict) or "id" not in message or not isinstance(message.get("method"), str):
            return None
        ident, method = message.get("id"), message["method"]
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if method == "initialize":
            result = self.initialize(params)
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [tool for tool, _app, _handler in self.tools.values()]}
        elif method == "tools/call":
            result = self.call(params.get("name"), params.get("arguments"), cancelled)
        elif method in ("resources/list", "prompts/list"):
            result = {method.split("/")[0]: []}
        else:
            return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"Unknown method {method[:60]}"}}
        return {"jsonrpc": "2.0", "id": ident, "result": result}

    def call(self, name, arguments, cancelled=lambda: False) -> dict:
        found = self.tools.get(name) if isinstance(name, str) else None
        if found is None:
            return self._answer(f"There's no tool called {str(name)[:60]} here.", error=True)
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            return self._answer("The tool's arguments must be an object.", error=True)
        tool, app, handler = found
        unknown = set(arguments) - set(tool["inputSchema"]["properties"])
        if unknown:
            return self._answer(f"{name} takes no {sorted(unknown)[0]!r}.", error=True)
        try:
            return self._answer(handler(arguments, cancelled))
        except GraphError as exc:
            return self._answer(self._permission_words(app, str(exc)), error=True)
        except Exception as exc:                         # noqa: BLE001 -- one call's failure, never the server's
            return self._answer(f"{name} failed ({type(exc).__name__}).", error=True)

    def _permission_words(self, app: str, said: str) -> str:
        """A refusal that is about a permission the sign-in wasn't granted, in the words of the plugin's page."""
        if not said.startswith("Microsoft didn't allow this") or self.auth is None:
            return said
        granted = self.graph.granted()
        missing = [p for p in APP_PERMISSIONS.get(app, ()) if granted and p.lower() not in granted]
        if not missing:
            return said
        scope = " ".join(f"https://graph.microsoft.com/{p}" for p in missing)
        return self.auth._needs_permission(scope)

    @staticmethod
    def _answer(value, *, error: bool = False) -> dict:
        text = value if isinstance(value, str) else _result(value)
        return {"content": [{"type": "text", "text": text}], "isError": bool(error)}

    # mail ----------------------------------------------------------------------------------------------------------
    def _mail_tools(self):
        folder = {"type": "string", "description": "inbox, drafts, sentitems, deleteditems, archive or junkemail, or a "
                                                   "folder's name or id from list_mail_folders."}
        compose = {"to": _EMAILS, "cc": _EMAILS, "bcc": _EMAILS, "subject": _S,
                   "body": {"type": "string", "description": "The message itself."},
                   "body_type": {"type": "string", "enum": ["text", "html"],
                                 "description": "text (the default) or html."}}
        return [
            ("mail_account", "Identify the signed-in Outlook account",
             "Show the signed-in account's stable Microsoft id and email. DGC uses this to keep a Pip's mail access "
             "bound to the account the user approved.", _schema({}), _READ, self.mail_account),
            ("search_mail", "Search Outlook mail",
             "Search or list messages in the user's Outlook mailbox. With query, searches like Outlook's search box "
             "(words, from:, to:, subject:, hasattachments:true) in every folder, or in folder. Without it, lists the "
             "newest messages in folder (the inbox when not given). Gives each message's id, subject, sender, date, "
             "whether it is unread or has attachments, and a preview. Reading doesn't mark anything read.",
             _schema({"query": _S, "folder": folder, "unread_only": _B,
                      "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "At most 50; 10 when not "
                                                                                              "given."},
                      "next_page": _NEXT}), _READ, self.search_mail),
            ("list_mail_folders", "List Outlook mail folders",
             "List the mail folders in the user's Outlook mailbox, with their ids and how many messages (and unread "
             "ones) each holds.", _schema({}), _READ, self.list_mail_folders),
            ("read_mail", "Read an Outlook message",
             "Read one message from the user's Outlook mailbox by its id: sender, recipients, date, subject, the text of "
             "its body and the names of its attachments. Doesn't mark it read.",
             _schema({"id": {"type": "string", "description": "The message's id, from search_mail."}}, ["id"]),
             _READ, self.read_mail),
            ("create_draft", "Create an Outlook draft",
             "Save a new email in the user's Drafts folder without sending it. send_mail sends it later.",
             _schema(compose, ["subject"]), _ADD, self.create_draft),
            ("send_mail", "Send email",
             "Send email from the user's Outlook account: a draft (draft_id, from create_draft or reply_or_forward), "
             "or a new message (to, subject and body). It is delivered at once and can't be taken back; a copy is "
             "kept in Sent Items.",
             _schema({"draft_id": _S, **compose}), _REACH, self.send_mail),
            ("reply_or_forward", "Reply to or forward an Outlook message",
             "Reply to a message (reply or reply_all) or forward it (forward, with to). With send true it is sent at "
             "once; otherwise (the default) the reply waits in Drafts, and its draft_id goes to send_mail.",
             _schema({"id": {"type": "string", "description": "The message's id, from search_mail."},
                      "action": {"type": "string", "enum": ["reply", "reply_all", "forward"]},
                      "comment": {"type": "string", "description": "What to write above the original message."},
                      "to": _EMAILS, "send": _B}, ["id", "action"]), _REACH, self.reply_or_forward),
            ("move_mail", "Move an Outlook message",
             "Move a message to another folder: archive, deleteditems (Outlook's Deleted Items), junkemail, inbox, or "
             "a folder's name or id from list_mail_folders. The moved message gets a new id, which is returned.",
             _schema({"id": {"type": "string", "description": "The message's id, from search_mail."},
                      "folder": folder}, ["id", "folder"]), _CHANGE, self.move_mail),
        ]

    def mail_account(self, arguments: dict, cancelled):
        item = self.graph.json("GET", "/me", what="Microsoft account", cancelled=cancelled,
                               params={"$select": "id,mail,userPrincipalName,displayName"})
        ident = item.get("id") if isinstance(item, dict) else None
        if not isinstance(ident, str) or not 1 <= len(ident) <= 256:
            raise GraphError("Microsoft did not identify the signed-in account. Reconnect it in Settings → Plugins.")
        email = item.get("mail") or item.get("userPrincipalName")
        return {"id": ident, "email": email[:320] if isinstance(email, str) else "",
                "name": str(item.get("displayName") or "")[:160]}

    def _folder(self, value, cancelled) -> tuple[str, str]:
        """(Graph's name or id for a mail folder, how to say it) from a well-known name, a folder id or a name."""
        text = _text(value, "folder", 255).strip()
        if not text:
            return "", ""
        if text.lower().replace(" ", "") in WELL_KNOWN_FOLDERS:
            return text.lower().replace(" ", ""), text
        folders, _next = self.graph.page("/me/mailFolders", {"$top": 100, "$select": "id,displayName"}, "",
                                         what="mail folder", cancelled=cancelled)
        for folder in folders:
            if str(folder.get("displayName") or "").lower() == text.lower() or folder.get("id") == text:
                return quote(str(folder["id"]), safe=""), str(folder.get("displayName") or text)
        raise GraphError(f"There's no mail folder called {text[:80]!r}. list_mail_folders shows them.")

    def search_mail(self, arguments: dict, cancelled):
        query = _text(arguments.get("query"), "query", 500).strip()
        unread = _flag(arguments.get("unread_only"), "unread_only")
        limit = _count(arguments.get("limit"), "limit", 10, 1, 50)
        folder, shown = self._folder(arguments.get("folder"), cancelled)
        path = f"/me/mailFolders/{folder}/messages" if folder else (
            "/me/messages" if query else "/me/mailFolders/inbox/messages")
        params = {"$top": limit, "$select": "id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,isDraft"}
        if query:
            # Graph's $search can't be combined with $orderby or $filter on messages: unread is checked here.
            params["$search"] = '"' + query.replace("\\", "\\\\").replace('"', '\\"') + '"'
        else:
            params["$orderby"] = "receivedDateTime desc"
            if unread:
                params["$filter"] = "isRead eq false"
        items, following = self.graph.page(path, params, _text(arguments.get("next_page"), "next_page", 4000),
                                           what="mail folder", cancelled=cancelled, scope="mail")
        messages = [_message(m) for m in items if not (query and unread and m.get("isRead"))]
        answer = {"folder": shown or ("all mail" if query else "inbox"), "messages": messages}
        if following:
            answer["next_page"] = following
        if not messages:
            answer["note"] = "No messages matched." if query or unread else "This folder is empty."
        return answer

    def list_mail_folders(self, arguments: dict, cancelled):
        folders, _next = self.graph.page("/me/mailFolders", {
            "$top": 100, "$select": "id,displayName,unreadItemCount,totalItemCount,childFolderCount"}, "",
            what="mail folder", cancelled=cancelled)
        return {"folders": [{"id": f.get("id"), "name": f.get("displayName"), "messages": f.get("totalItemCount"),
                             "unread": f.get("unreadItemCount"), "subfolders": f.get("childFolderCount") or None}
                            for f in folders]}

    def read_mail(self, arguments: dict, cancelled):
        ident = _ident(arguments.get("id"))
        item = self.graph.json("GET", f"/me/messages/{ident}", what="message", cancelled=cancelled, params={
            "$select": "subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,body,"
                       "hasAttachments,isRead,isDraft,importance,conversationId,webLink"},
            headers={"Prefer": 'outlook.body-content-type="text"'})
        answer = {"id": arguments.get("id"), "subject": item.get("subject"), "from": _person(item.get("from")),
                  "to": _people(item.get("toRecipients")), "cc": _people(item.get("ccRecipients")) or None,
                  "bcc": _people(item.get("bccRecipients")) or None, "received": item.get("receivedDateTime"),
                  "unread": item.get("isRead") is False, "draft": item.get("isDraft") or None,
                  "importance": item.get("importance") if item.get("importance") not in (None, "normal") else None,
                  "web_link": item.get("webLink"),
                  "body": _cut((item.get("body") or {}).get("content") if isinstance(item.get("body"), dict) else "")}
        if item.get("hasAttachments"):
            files, _next = self.graph.page(f"/me/messages/{ident}/attachments",
                                           {"$select": "name,contentType,size,isInline"}, "", what="message",
                                           cancelled=cancelled)
            answer["attachments"] = [{"name": f.get("name"), "type": f.get("contentType"), "size": f.get("size")}
                                     for f in files if not f.get("isInline")]
        return {k: v for k, v in answer.items() if v not in (None, "", [])}

    def _compose(self, arguments: dict, *, need_to: bool) -> dict:
        to, cc, bcc = (_addresses(arguments.get(k), k) for k in ("to", "cc", "bcc"))
        if need_to and not (to or cc or bcc):
            raise GraphError("Say who it goes to (to).")
        kind = _text(arguments.get("body_type"), "body_type", 10) or "text"
        if kind not in ("text", "html"):
            raise GraphError("body_type must be text or html.")
        message = {"subject": _text(arguments.get("subject"), "subject", 1000),
                   "body": {"contentType": "HTML" if kind == "html" else "Text",
                            "content": _text(arguments.get("body"), "body", 1_000_000)}}
        for key, value in (("toRecipients", to), ("ccRecipients", cc), ("bccRecipients", bcc)):
            if value:
                message[key] = value
        return message

    def create_draft(self, arguments: dict, cancelled):
        draft = self.graph.json("POST", "/me/messages", body=self._compose(arguments, need_to=False), what="draft",
                                cancelled=cancelled)
        return {"draft_id": draft.get("id"), "subject": draft.get("subject"), "to": _people(draft.get("toRecipients")),
                "saved_in": "Drafts", "next": "send_mail with this draft_id sends it."}

    def send_mail(self, arguments: dict, cancelled):
        draft = arguments.get("draft_id")
        if draft:
            if any(arguments.get(k) not in (None, "", []) for k in ("to", "cc", "bcc", "subject", "body")):
                raise GraphError("Send either a draft (draft_id) or a new message (to, subject, body), not both.")
            ident = _ident(draft, "draft_id")
            found = self.graph.json("GET", f"/me/messages/{ident}", what="draft", cancelled=cancelled,
                                    params={"$select": "subject,toRecipients,ccRecipients,bccRecipients,isDraft"})
            if found.get("isDraft") is False:
                raise GraphError("That message isn't a draft: it was sent already.")
            if not (found.get("toRecipients") or found.get("ccRecipients") or found.get("bccRecipients")):
                raise GraphError("That draft has nobody to send it to yet.")
            self.graph.json("POST", f"/me/messages/{ident}/send", what="draft", cancelled=cancelled,
                            expect=(200, 202, 204))
            return {"sent": True, "subject": found.get("subject"), "to": _people(found.get("toRecipients")),
                    "cc": _people(found.get("ccRecipients")) or None}
        message = self._compose(arguments, need_to=True)
        if not message["subject"] and not message["body"]["content"]:
            raise GraphError("A message needs a subject or a body.")
        self.graph.json("POST", "/me/sendMail", body={"message": message, "saveToSentItems": True}, what="message",
                        cancelled=cancelled, expect=(200, 202, 204))
        return {"sent": True, "subject": message["subject"], "to": _people(message.get("toRecipients"))}

    def reply_or_forward(self, arguments: dict, cancelled):
        ident = _ident(arguments.get("id"))
        action = _text(arguments.get("action"), "action", 20, required=True)
        if action not in ("reply", "reply_all", "forward"):
            raise GraphError("action must be reply, reply_all or forward.")
        send = _flag(arguments.get("send"), "send")
        body = {"comment": _text(arguments.get("comment"), "comment", 200_000)}
        to = _addresses(arguments.get("to"), "to")
        if action == "forward":
            if not to:
                raise GraphError("Say who to forward it to (to).")
            body["toRecipients"] = to
        elif to:
            raise GraphError("to is only for forward: a reply goes to the sender (reply_all: everyone on it).")
        verb = {"reply": "reply", "reply_all": "replyAll", "forward": "forward"}[action]
        if send:
            self.graph.json("POST", f"/me/messages/{ident}/{verb}", body=body, what="message", cancelled=cancelled,
                            expect=(200, 202, 204))
            return {"sent": True, "action": action, "to": _people(to) or None}
        draft = self.graph.json("POST", f"/me/messages/{ident}/create{verb[0].upper()}{verb[1:]}", body=body,
                                what="message", cancelled=cancelled)
        return {"draft_id": draft.get("id"), "action": action, "to": _people(draft.get("toRecipients")),
                "subject": draft.get("subject"), "saved_in": "Drafts",
                "next": "send_mail with this draft_id sends it."}

    def move_mail(self, arguments: dict, cancelled):
        ident = _ident(arguments.get("id"))
        folder, shown = self._folder(arguments.get("folder"), cancelled)
        if not folder:
            raise GraphError("Say which folder to move it to.")
        moved = self.graph.json("POST", f"/me/messages/{ident}/move", body={"destinationId": folder},
                                what="message", cancelled=cancelled)
        return {"moved": True, "folder": shown, "id": moved.get("id")}

    # calendar ------------------------------------------------------------------------------------------------------
    def _calendar_tools(self):
        event = {"subject": _S,
                 "start": {"type": "string", "description": "2026-11-03T15:00 (in time_zone), with an offset, or a "
                                                            "date for an all-day event."},
                 "end": {"type": "string", "description": "When it ends, as start."},
                 "time_zone": _ZONE_FIELD, "all_day": _B, "location": _S,
                 "body": {"type": "string", "description": "The event's description."},
                 "attendees": _EMAILS, "online_meeting": {"type": "boolean", "description": "Add an online meeting "
                                                                                         "link."}}
        ident = {"type": "string", "description": "The event's id, from list_events."}
        return [
            ("list_calendars", "List Outlook calendars",
             "List the user's Outlook calendars with their ids, which is the default, and which they can change.",
             _schema({}), _READ, self.list_calendars),
            ("list_events", "List Outlook calendar events",
             "List the events on the user's Outlook calendar between start and end (from now for 7 days when not "
             "given), repeating events as each time they happen, in start order: subject, times, location, "
             "organiser, attendees and the user's answer.",
             _schema({"start": _S, "end": _S, "time_zone": _ZONE_FIELD,
                      "calendar_id": {"type": "string", "description": "A calendar's id from list_calendars; the "
                                                                        "default calendar when not given."},
                      "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "At most 100; 25 when "
                                                                                               "not given."},
                      "next_page": _NEXT}), _READ, self.list_events),
            ("read_event", "Read an Outlook calendar event",
             "Read one event by its id: times, location, description, organiser, attendees and their answers, the "
             "online meeting link and how it repeats.",
             _schema({"id": ident, "time_zone": _ZONE_FIELD}, ["id"]), _READ, self.read_event),
            ("create_event", "Create an Outlook calendar event",
             "Add an event to the user's Outlook calendar. With attendees, Microsoft sends each of them an invitation "
             "at once.",
             _schema({**event, "calendar_id": _S}, ["subject", "start", "end"]), _REACH, self.create_event),
            ("update_event", "Change an Outlook calendar event",
             "Change an event's subject, times, location, description, attendees (the list given replaces the old "
             "one) or online meeting. When the user organised it, attendees are sent the change.",
             _schema({"id": ident, **event}, ["id"]), _CHANGE_REACH, self.update_event),
            ("delete_event", "Delete an Outlook calendar event",
             "Delete an event from the user's calendar. When the user organised a meeting, its attendees are sent a "
             "cancellation.",
             _schema({"id": ident}, ["id"]), _CHANGE_REACH, self.delete_event),
            ("respond_to_event", "Answer an Outlook meeting invitation",
             "Accept, tentatively accept or decline a meeting the user was invited to. The organiser is told unless "
             "send_response is false.",
             _schema({"id": ident, "response": {"type": "string", "enum": ["accept", "tentative", "decline"]},
                      "comment": _S, "send_response": _B}, ["id", "response"]), _REACH, self.respond_to_event),
        ]

    def list_calendars(self, arguments: dict, cancelled):
        calendars, _next = self.graph.page("/me/calendars", {
            "$top": 100, "$select": "id,name,isDefaultCalendar,canEdit,owner"}, "", what="calendar",
            cancelled=cancelled)
        return {"calendars": [{k: v for k, v in {
            "id": c.get("id"), "name": c.get("name"), "default": c.get("isDefaultCalendar") or None,
            "can_change": c.get("canEdit"), "owner": _person({"emailAddress": c.get("owner")}) or None}.items()
            if v is not None} for c in calendars]}

    def list_events(self, arguments: dict, cancelled):
        zone_name, zone = _zone(arguments.get("time_zone"))
        if arguments.get("start"):
            start, _day = _when(arguments.get("start"), "start", zone)
        else:
            start = datetime.now(zone)
        if arguments.get("end"):
            end, day = _when(arguments.get("end"), "end", zone)
            if day:
                end += timedelta(days=1)                 # an end date means through that day
        else:
            end = start + timedelta(days=7)
        if end <= start:
            raise GraphError("end must be after start.")
        limit = _count(arguments.get("limit"), "limit", 25, 1, 100)
        calendar = arguments.get("calendar_id")
        path = f"/me/calendars/{_ident(calendar, 'calendar_id')}/calendarView" if calendar else "/me/calendarView"
        items, following = self.graph.page(path, {
            "startDateTime": _utc(start), "endDateTime": _utc(end), "$top": limit, "$orderby": "start/dateTime",
            "$select": "id,subject,start,end,isAllDay,location,organizer,attendees,showAs,isCancelled,onlineMeeting,"
                       "responseStatus"}, _text(arguments.get("next_page"), "next_page", 4000), what="calendar",
            cancelled=cancelled, headers={"Prefer": f'outlook.timezone="{zone_name}"'}, scope="calendar")
        answer = {"from": start.isoformat(timespec="minutes"), "to": end.isoformat(timespec="minutes"),
                  "time_zone": zone_name, "events": [_event(e) for e in items]}
        if following:
            answer["next_page"] = following
        if not items:
            answer["note"] = "No events in this range."
        return answer

    def read_event(self, arguments: dict, cancelled):
        zone_name, _zone_info = _zone(arguments.get("time_zone"))
        item = self.graph.json("GET", f"/me/events/{_ident(arguments.get('id'))}", what="event", cancelled=cancelled,
                               headers={"Prefer": f'outlook.timezone="{zone_name}", outlook.body-content-type="text"'})
        answer = _event(item)
        answer["body"] = _cut((item.get("body") or {}).get("content") if isinstance(item.get("body"), dict) else "")
        if isinstance(item.get("recurrence"), dict):
            answer["repeats"] = (item["recurrence"].get("pattern") or {}).get("type")
        answer["web_link"] = item.get("webLink")
        return {k: v for k, v in answer.items() if v not in (None, "")}

    def _event_body(self, arguments: dict, *, creating: bool) -> dict:
        zone_name, zone = _zone(arguments.get("time_zone"))
        body: dict = {}
        if arguments.get("subject") is not None:
            body["subject"] = _text(arguments.get("subject"), "subject", 255, required=creating)
        given = arguments.get("all_day")
        all_day = _flag(given, "all_day") if given is not None else None
        start = end = None
        start_day = end_day = False
        if arguments.get("start"):
            start, start_day = _when(arguments.get("start"), "start", zone)
        if arguments.get("end"):
            end, end_day = _when(arguments.get("end"), "end", zone)
        if all_day is None and creating:
            all_day = start_day                          # a date alone is a whole day
        if all_day:
            midnight = (lambda moment: moment.astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0))
            if start is not None:
                start = midnight(start)
            if end is not None:
                end = midnight(end)
                # Graph's all-day end is the day after the last one; people name the last day itself.
                if end_day or (start is not None and end <= start):
                    end += timedelta(days=1)
        if start is not None and end is not None and end <= start:
            raise GraphError("end must be after start.")
        if start is not None:
            body["start"] = _graph_time(start, zone_name, zone)
        if end is not None:
            body["end"] = _graph_time(end, zone_name, zone)
        if given is not None or (creating and all_day):
            body["isAllDay"] = bool(all_day)
        if arguments.get("location") is not None:
            body["location"] = {"displayName": _text(arguments.get("location"), "location", 500)}
        if arguments.get("body") is not None:
            body["body"] = {"contentType": "Text", "content": _text(arguments.get("body"), "body", 100_000)}
        if arguments.get("attendees") is not None:
            body["attendees"] = [{**a, "type": "required"} for a in _addresses(arguments.get("attendees"),
                                                                                "attendees")]
        if arguments.get("online_meeting") is not None:
            body["isOnlineMeeting"] = _flag(arguments.get("online_meeting"), "online_meeting")
        return body

    def create_event(self, arguments: dict, cancelled):
        body = self._event_body(arguments, creating=True)
        calendar = arguments.get("calendar_id")
        path = f"/me/calendars/{_ident(calendar, 'calendar_id')}/events" if calendar else "/me/events"
        made = self.graph.json("POST", path, body=body, what="calendar", cancelled=cancelled)
        answer = {"created": True, **_event(made)}
        if body.get("attendees"):
            answer["invitations"] = f"Microsoft sent an invitation to {len(body['attendees'])} attendee(s)."
        return answer

    def update_event(self, arguments: dict, cancelled):
        ident = _ident(arguments.get("id"))
        body = self._event_body(arguments, creating=False)
        if not body:
            raise GraphError("Say what to change: subject, start, end, location, body, attendees or online_meeting.")
        changed = self.graph.json("PATCH", f"/me/events/{ident}", body=body, what="event", cancelled=cancelled)
        return {"updated": True, "changed": sorted(body), **_event(changed)}

    def delete_event(self, arguments: dict, cancelled):
        ident = _ident(arguments.get("id"))
        self.graph.json("DELETE", f"/me/events/{ident}", what="event", cancelled=cancelled, expect=(200, 202, 204))
        return {"deleted": True, "id": arguments.get("id")}

    def respond_to_event(self, arguments: dict, cancelled):
        ident = _ident(arguments.get("id"))
        answer = _text(arguments.get("response"), "response", 20, required=True)
        verb = {"accept": "accept", "tentative": "tentativelyAccept", "decline": "decline"}.get(answer)
        if verb is None:
            raise GraphError("response must be accept, tentative or decline.")
        send = _flag(arguments.get("send_response"), "send_response", True)
        self.graph.json("POST", f"/me/events/{ident}/{verb}", what="event", cancelled=cancelled,
                        expect=(200, 202, 204), body={"comment": _text(arguments.get("comment"), "comment", 10_000),
                                                      "sendResponse": send})
        return {"answered": answer, "organiser_told": send}

    # OneDrive -------------------------------------------------------------------------------------------------------
    def _onedrive_tools(self):
        item = {"id": {"type": "string", "description": "The file's id, from search_files."},
                "path": {"type": "string", "description": "Or its path in OneDrive, such as Documents/plan.md."}}
        source = {"from_path": {"type": "string", "description": "A file in the project to upload."},
                  "content": {"type": "string", "description": "Or the text to save, when there's no file."}}
        return [
            ("search_files", "Search OneDrive",
             "Search the user's OneDrive for files and folders by name and content (query), or list what is in a "
             "folder (folder, such as Documents/Reports; the top of OneDrive when not given). Gives each item's id, "
             "name, path, size, when it changed and its web link.",
             _schema({"query": _S, "folder": {"type": "string", "description": "A folder path in OneDrive."},
                      "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "At most 50; 20 when "
                                                                                              "not given."},
                      "next_page": _NEXT}), _READ, self.search_files),
            ("read_file", "Read a OneDrive file's text",
             "Read a text file from OneDrive (notes, Markdown, CSV, JSON, code: up to 2 MB). For anything else, such "
             "as a Word or PDF file, download_file saves it into the project to open there.",
             _schema(item), _READ, self.read_file),
            ("download_file", "Download a OneDrive file into the project",
             "Save a copy of a OneDrive file into the project (save_to, a path in the project; the file's own name at "
             "the top of the project when not given). Never replaces a file that is already there. Up to 250 MB.",
             _schema({**item, "save_to": _S}), _ADD, self.download_file),
            ("upload_file", "Upload a file to OneDrive",
             "Upload a file from the project (from_path) or text (content) to OneDrive as a new file (folder, such as "
             "Documents/Reports, and name; the file's own name when not given). Never replaces a file: replace_file "
             "does that. Up to 250 MB.",
             _schema({**source, "folder": _S, "name": _S}), _ADD, self.upload_file),
            ("replace_file", "Replace a OneDrive file",
             "Replace the contents of a file already in OneDrive (id or path) with a file from the project "
             "(from_path) or text (content). OneDrive keeps the old contents in the file's version history.",
             _schema({**item, **source}), _CHANGE, self.replace_file),
        ]

    _ITEM = "id,name,size,lastModifiedDateTime,webUrl,file,folder,parentReference"

    def search_files(self, arguments: dict, cancelled):
        query = _text(arguments.get("query"), "query", 300).strip()
        folder = _drive_path(arguments.get("folder"), "folder")
        limit = _count(arguments.get("limit"), "limit", 20, 1, 50)
        base = f"/me/drive/root:/{folder}:" if folder else "/me/drive/root"
        if query:
            escaped = quote(query.replace("'", "''"), safe="")
            path, params = f"{base}/search(q='{escaped}')", {"$top": limit, "$select": self._ITEM}
        else:
            path, params = f"{base}/children", {"$top": limit, "$select": self._ITEM}
        items, following = self.graph.page(path, params, _text(arguments.get("next_page"), "next_page", 4000),
                                           what="folder" if folder else "file", cancelled=cancelled,
                                           scope="onedrive")
        answer = {"items": [_drive_item(i) for i in items]}
        if following:
            answer["next_page"] = following
        if not items:
            answer["note"] = "Nothing matched." if query else "This folder is empty."
        return answer

    def _file(self, arguments: dict, cancelled) -> dict:
        item = self.graph.json("GET", _item_path(arguments), what="file", cancelled=cancelled)
        if isinstance(item.get("folder"), dict):
            raise GraphError(f"{item.get('name') or 'That'} is a folder: search_files with folder lists what is in it.")
        return item

    def read_file(self, arguments: dict, cancelled):
        item = self._file(arguments, cancelled)
        name, size = str(item.get("name") or ""), int(item.get("size") or 0)
        kind = str((item.get("file") or {}).get("mimeType") or "") if isinstance(item.get("file"), dict) else ""
        texty = kind.startswith("text/") or kind in TEXT_TYPES or name.lower().endswith(TEXT_SUFFIXES)
        if not texty:
            raise GraphError(f"{name} isn't a text file ({kind or 'unknown type'}): download_file saves it into the "
                             "project, where DGC can open it.")
        if size > MAX_READ:
            raise GraphError(f"{name} is {size // 1024} KB, more than DGC reads as text: download_file saves it into "
                             "the project.")
        chunks: list = []
        self.graph.download(item.get("@microsoft.graph.downloadUrl"), chunks.append, MAX_READ, cancelled=cancelled)
        data = b"".join(chunks)
        if b"\x00" in data[:8192]:
            raise GraphError(f"{name} isn't text: download_file saves it into the project.")
        return {"id": item.get("id"), "name": name, "size": len(data),
                "text": _cut(data.decode("utf-8", errors="replace"))}

    def download_file(self, arguments: dict, cancelled):
        from .workspace import WorkspaceBoundaryError, create_regular_file_stream
        item = self._file(arguments, cancelled)
        name = str(item.get("name") or "download")
        if int(item.get("size") or 0) > MAX_TRANSFER:
            raise GraphError(f"{name} is larger than DGC downloads ({MAX_TRANSFER // (1024 * 1024)} MB).")
        target = _in_project(self.root, arguments.get("save_to") or name, "save_to")
        if target.exists() or target.is_symlink():
            raise GraphError(f"{target} already exists; choose another save_to.")
        try:
            with create_regular_file_stream(target) as handle:
                written = self.graph.download(item.get("@microsoft.graph.downloadUrl"), handle.write, MAX_TRANSFER,
                                              cancelled=cancelled)
        except FileExistsError:
            raise GraphError(f"{target} already exists; choose another save_to.") from None
        except (OSError, WorkspaceBoundaryError):
            raise GraphError("The download could not be saved safely inside the project.") from None
        return {"saved": str(target.relative_to(self.root.resolve(strict=False))), "bytes": written,
                "name": name, "id": item.get("id")}

    def _content(self, arguments: dict) -> tuple[bytes, str]:
        """What to upload: a project file's bytes, or text; and the file's own name, if any."""
        if arguments.get("from_path") and arguments.get("content") is not None:
            raise GraphError("Give from_path or content, not both.")
        if arguments.get("from_path"):
            from .workspace import read_regular_bytes
            source = _in_project(self.root, arguments.get("from_path"), "from_path")
            # Never a .env, a key, a credential file or anything in a dot folder, as a deck's picture never is
            # (artifacts._private_rel): a sentence in an email the model read must not be able to send one to the cloud.
            from .artifacts import _private_rel
            rel = source.relative_to(self.root.resolve(strict=False)).as_posix()
            if _private_rel(rel):
                raise GraphError(f"{rel} is private (a key, a credential, a .env or a dot folder) and never goes to "
                                 "OneDrive.")
            try:
                if not source.is_file():
                    raise GraphError(f"{arguments.get('from_path')} isn't a file in the project.")
                if source.stat().st_size > MAX_TRANSFER:
                    raise GraphError(f"{source.name} is larger than DGC uploads ({MAX_TRANSFER // (1024 * 1024)} MB).")
                raw, _version = read_regular_bytes(source, maximum=MAX_TRANSFER)
            except GraphError:
                raise
            except (OSError, ValueError):
                raise GraphError(f"{source.name} changed or could not be read safely inside the project.") from None
            return raw, source.name
        if arguments.get("content") is None:
            raise GraphError("Give from_path (a file in the project) or content (text).")
        text = _text(arguments.get("content"), "content", 10_000_000)
        return text.encode("utf-8"), ""

    def upload_file(self, arguments: dict, cancelled):
        content, own = self._content(arguments)
        name = _text(arguments.get("name"), "name", 255).strip() or own
        if not name:
            raise GraphError("Give the new file a name.")
        if "/" in name or name in (".", "..") or any(ord(c) < 32 for c in name):
            raise GraphError("name is the file's name alone; put the folder in folder.")
        folder = _drive_path(arguments.get("folder"), "folder")
        where = f"{folder}/{quote(name, safe='')}" if folder else quote(name, safe="")
        try:
            made = self.graph.upload(f"/me/drive/root:/{where}:", content, conflict="fail", what="folder",
                                     cancelled=cancelled)
        except GraphError as exc:
            if str(exc).startswith("That conflicts"):
                raise GraphError(f"OneDrive already has a file called {name} there. replace_file replaces it, or "
                                 "choose another name.") from None
            raise
        return {"uploaded": True, **_drive_item(made)} if made else {"uploaded": True, "name": name}

    def replace_file(self, arguments: dict, cancelled):
        item = self._file(arguments, cancelled)
        content, _own = self._content(arguments)
        changed = self.graph.upload(f"/me/drive/items/{quote(str(item.get('id')), safe='')}", content,
                                    conflict="replace", what="file", cancelled=cancelled)
        return {"replaced": True, **_drive_item(changed or item),
                "note": "OneDrive keeps the old contents in the file's version history."}


# ------------------------------------------------------------------------------------------------------ serving

class _Calls:
    """JSON-RPC requests answered on threads of their own, after initialize; a cancelled one stops waiting."""

    def __init__(self, server: GraphServer, deliver, *, initialize=None, closing: threading.Event):
        self.server, self.deliver, self.closing = server, deliver, closing
        self._initialize = initialize
        self.ready = threading.Event()
        self.cancels: dict = {}
        self.lock = threading.Lock()

    def feed(self, message) -> None:
        if not isinstance(message, dict):
            return
        if message.get("method") == "notifications/cancelled":
            target = (message.get("params") or {}).get("requestId") if isinstance(message.get("params"), dict) else None
            with self.lock:
                event = self.cancels.get(target) if isinstance(target, (int, str)) else None
            if event is not None:
                event.set()
            return
        if "id" not in message or not isinstance(message.get("method"), str):
            return
        if message["method"] == "initialize":
            with self.lock:
                if isinstance(message["id"], (int, str)):
                    self.cancels[message["id"]] = threading.Event()
            threading.Thread(target=self._start, args=(message,), daemon=True, name="dgc-microsoft-init").start()
            return
        with self.lock:
            if len(self.cancels) >= MAX_CALLS:
                self.deliver({"jsonrpc": "2.0", "id": message["id"],
                              "error": {"code": -32000, "message": "too many requests to this server at once"}})
                return
            event = threading.Event()
            if isinstance(message["id"], (int, str)):
                self.cancels[message["id"]] = event
        threading.Thread(target=self._answer, args=(message, event), daemon=True, name="dgc-microsoft-call").start()

    def drain(self, timeout: float) -> None:
        """Wait (up to TIMEOUT seconds) for the calls in flight to answer: stdin closing ends the stdio server, not
        what it was asked before."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if not self.cancels:
                    return
            time.sleep(0.05)

    def _start(self, message: dict) -> None:
        try:
            if self._initialize is not None:
                failure = self._initialize()
                if failure:
                    self.deliver({"jsonrpc": "2.0", "id": message["id"],
                                  "error": {"code": -32001, "message": failure[:600]}})
                    return
            self.deliver(self.server.handle(message))
        finally:
            self.ready.set()
            with self.lock:
                self.cancels.pop(message.get("id"), None)

    def _answer(self, message: dict, event: threading.Event) -> None:
        try:
            while not self.ready.wait(0.2):
                if self.closing.is_set() or event.is_set():
                    return
            answer = self.server.handle(message, lambda: event.is_set() or self.closing.is_set())
            if answer is not None and not event.is_set():
                self.deliver(answer)
        finally:
            with self.lock:
                self.cancels.pop(message.get("id"), None)


class GraphConnection:
    """The server inside DGC's process, process-like for MCPServer as RemoteConnection is: JSON-RPC lines in on
    ``stdin``, out on ``stdout``, notes on ``stderr``. It signs in at initialize (DGC's card asks), and keeps the
    sign-in in the system keychain under the plugin's name."""
    in_process = True
    pid = None

    def __init__(self, name: str, args, *, root, sign_in, cancelled, can_ask=None, session=None):
        import requests
        import requests.adapters
        from . import __version__
        apps, info = parse_args(args)
        if not apps:
            raise RemoteError("not one of DGC's Microsoft apps")
        if not info.get("client_id"):
            raise RemoteError("DGC's Microsoft app is missing; reinstall the plugin in Settings → Plugins")
        self.name = name
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = f"DGC/{__version__} (Microsoft Graph)"
        adapter = requests.adapters.HTTPAdapter(pool_maxsize=MAX_CALLS + 4)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self.returncode = None
        self.sign_in_failure = ""
        self._closing = threading.Event()
        self._write_lock = threading.Lock()
        in_read, in_write = os.pipe()
        out_read, out_write = os.pipe()
        err_read, err_write = os.pipe()
        self.stdin = os.fdopen(in_write, "w", encoding="utf-8", newline="\n")
        self.stdout = os.fdopen(out_read, "r", encoding="utf-8", newline="\n")
        self.stderr = os.fdopen(err_read, "r", encoding="utf-8", newline="\n")
        self._requests = os.fdopen(in_read, "r", encoding="utf-8", newline="\n")
        self._out = os.fdopen(out_write, "w", encoding="utf-8", newline="\n")
        self._err = os.fdopen(err_write, "w", encoding="utf-8", newline="\n")
        self.cancelled = lambda: self._closing.is_set() or bool(cancelled())
        options = RemoteOptions(url=GRAPH, static_client=info)
        self.auth = RemoteAuth(name, options, self.session, sign_in=sign_in, cancelled=self.cancelled, note=self._note,
                               can_ask=(lambda: can_ask(self.auth.signed_out)) if can_ask is not None else None)
        self.graph = Graph(self.auth, self.session, note=self._note)
        self.server = GraphServer(apps, self.graph, root=root, auth=self.auth)
        self._calls = _Calls(self.server, self._deliver, initialize=self._sign_in, closing=self._closing)
        self._pump = threading.Thread(target=self._read_requests, daemon=True, name=f"dgc-mcp-{name}-in")
        self._pump.start()

    # process-like ---------------------------------------------------------------------------------------------
    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self._pump.join(timeout)
        return self.returncode

    def terminate(self):
        if self._closing.is_set():
            return
        self._closing.set()
        for stream in (self.stdin, self._requests):
            with contextlib.suppress(Exception):
                stream.close()
        locked = self._write_lock.acquire(timeout=2)
        try:
            for stream in (self._out, self._err):
                with contextlib.suppress(Exception):
                    stream.close()
        finally:
            if locked:
                self._write_lock.release()
        with contextlib.suppress(Exception):
            self.session.close()
        self.returncode = 0 if self.returncode is None else self.returncode

    kill = terminate

    # pipes --------------------------------------------------------------------------------------------------
    def _note(self, text: str) -> None:
        with contextlib.suppress(Exception), self._write_lock:
            self._err.write(f"[{self.name}] {str(text)[:400]}\n")
            self._err.flush()

    def _deliver(self, message) -> None:
        if not isinstance(message, dict):
            return
        with contextlib.suppress(Exception), self._write_lock:
            self._out.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n")
            self._out.flush()

    def _read_requests(self) -> None:
        try:
            for line in self._requests:
                if self._closing.is_set():
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                self._calls.feed(message)
        except (OSError, ValueError):
            pass
        finally:
            self.returncode = 0 if self.returncode is None else self.returncode

    def _sign_in(self) -> str:
        """At initialize: sign in now if there's no usable sign-in (or it was made for other apps or another kind
        of account), while the person who clicked Connect can approve it. '' when signed in; else why not."""
        try:
            if self.auth.needs_sign_in():
                with self.auth.lock:
                    self.auth.authorize({}, self.auth.tokens())
            return ""
        except SignInDeclined as exc:
            return str(exc)
        except (RemoteError, credentials.CredentialError) as exc:
            said = " ".join(str(exc).split()) or "DGC couldn't sign in to Microsoft"
            said = said[:1].upper() + said[1:]
            # A sentence, as the plugin's page shows it; one that ends with the admin's link stays as it is.
            ends_with_link = said.split()[-1].startswith("https://")
            self.sign_in_failure = said if said.endswith((".", "!", "?")) or ends_with_link else said + "."
            self._note("sign-in didn't finish")
            return self.sign_in_failure


def _store_mode() -> None:
    """The stdio server keeps sign-ins where DGC does (``plugin_credentials_store`` in DGC's own config)."""
    try:
        from .config import USER_CONFIG
        value = json.loads(Path(USER_CONFIG).read_text(encoding="utf-8")).get("plugin_credentials_store")
    except (OSError, ValueError, AttributeError):
        value = None
    credentials.configure(value or "auto")


def _installed_info(apps: list[str]) -> dict:
    """DGC's Microsoft app for the installed Microsoft plugin, as DGC launches its servers with it; {} when the
    plugin isn't installed."""
    from . import plugins
    record = next((r for r in plugins._installed() if r.get("name") == PLUGIN), None)
    if record is None:
        return {}
    for server, spec in plugins.record_servers(record).items():
        launch = plugins.app_sign_in_launch(server, spec)
        _apps, info = parse_args(launch.get("args"))
        if info:
            return info
    return {}


def main(argv=None) -> int:
    """``python -m dgc.microsoft_graph APP...``: the server over stdin and stdout, with the Microsoft plugin's
    sign-in. It never signs in by itself."""
    import requests
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        apps, info = parse_args(["-m", MODULE, *argv])
    except ValueError as exc:
        print(f"usage: python -m {MODULE} {'|'.join(APPS)}... ({exc})", file=sys.stderr)
        return 2
    if not apps:
        print(f"usage: python -m {MODULE} {' '.join(APPS)}", file=sys.stderr)
        return 2
    _store_mode()
    info = info or _installed_info(apps)
    session = requests.Session()
    closing = threading.Event()
    note = (lambda text: print(f"[dgc-microsoft] {str(text)[:400]}", file=sys.stderr, flush=True))
    auth = RemoteAuth(PLUGIN, RemoteOptions(url=GRAPH, static_client=info or None), session,
                      sign_in=lambda *_a, **_k: False, cancelled=closing.is_set, note=note)
    graph = Graph(auth, session, sign_in_words=STANDALONE_SIGN_IN, note=note)
    server = GraphServer(apps, graph, root=Path.cwd(), auth=auth if info else None)
    writing = threading.Lock()

    def deliver(message):
        if isinstance(message, dict):
            with writing:
                sys.stdout.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n")
                sys.stdout.flush()

    calls = _Calls(server, deliver, closing=closing)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                calls.feed(json.loads(line))
            except ValueError:
                deliver({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
        calls.drain(300)
    except KeyboardInterrupt:
        pass
    finally:
        closing.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
