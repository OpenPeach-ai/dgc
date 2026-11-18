"""A model that can see, for every chat: Work, ChatDGC and a Pip's chat use this one module.

When a chat's model can't read a picture, DGC looks for a model that can on the connections the user added -- DGC's
own connection, every saved provider, and the Sub-agents model -- the chat's own connection first. What it finds is
offered with three choices (``question``): let that model look and keep the chat's model for the rest, switch the
chat to it, or not now. In Work's auto mode and at a Pip's Do it all nothing is asked: the best one looks, and the
chat says in one line which model looked (``looked_line``).

Which models see: the host's own word first (Ollama lists ``vision`` in a model's capabilities, asked once and
kept), else the model's family by name -- the same families the model picker marks "Takes images"
(media/shared/modelpicker.js, kept in step by a test). A model nothing says about is never picked. A connection
that runs its own tools (Claude Code, Codex) is never searched: a picture goes only to a model DGC sends requests
to itself, on a connection the user added.

The choice (``clean_choice``) is ``ask``, ``relay`` (a model looks: its name and connection, never a key) or
``off``, with the time it was made. A session, a chat and a Pip keep their own; Settings -> Models -> "A model that
can see" holds the one every chat starts from, and the newer of the two is the one that counts (``effective``).
"""
from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

CHOICES = ("ask", "relay", "off")
MAX_PROBES = 32               # models checked for sight in one search
MAX_LISTED = 512              # models read from one connection's list
MAX_EVERY = 12                # models that see, for the Settings list
PROBE_TTL = 3600.0
LIST_TTL = 300.0
FOUND_TTL = 300.0
NONE_TTL = 60.0               # a host that was down, or a model just pulled, is seen again soon
_SKIP = re.compile(r"embed|minilm|rerank", re.I)
_PROVIDER_ID = re.compile(r"provider_[0-9a-f]{32}\Z")
_MODEL = re.compile(r"[^\x00-\x1f\x7f]{1,256}\Z")

# The families whose models read images, by name: the model picker's "Takes images" families.
_FAMILIES = [re.compile(pattern, re.I) for pattern in (
    r"^(claude|fable|opus|sonnet|haiku)\b|claude-",
    r"^(gpt-5|gpt-4o|gpt-4\.1|o[134]\b|o[134]-)",
    r"^gemini",
    r"^gemma-?3n?\b",
    r"^qwen[\d.-]*-?vl|^qvq",
    r"llava|vision|(^|[-_/])vl([-_:]|$)|pixtral|minicpm-v|moondream",
)]

_lock = threading.Lock()
_probes: dict = {}            # (base_url, model) -> (expires, capabilities set or None)
_lists: dict = {}             # (base_url, api_mode, keyed) -> (expires, [models])
_found: dict = {}             # search signature -> (expires, Found | None)


def forget() -> None:
    """Drop what DGC remembers about which models see (a host refused a picture, or a test starts afresh)."""
    with _lock:
        _probes.clear()
        _lists.clear()
        _found.clear()


def named_sees(model: str) -> bool:
    """Whether the model's family reads images, by its name alone."""
    name = str(model or "").split("/")[-1]
    return any(rx.search(name) for rx in _FAMILIES)


def short(model: str) -> str:
    name = str(model or "")
    return name[:-len(":latest")] if name.endswith(":latest") else name


# --------------------------------------------------------------------------- connections

@dataclass
class Connection:
    """One place models run that the user added: DGC's own (main), the Sub-agents route, or a saved provider.

    ``resolve`` fills the address and key the first time the connection is searched (a saved provider's key is the
    editor's, asked for only then). ``only``: just ``model`` on it (the Sub-agents model), no listing."""

    key: str                       # "main", "subagent", "provider:<id>"
    kind: str                      # "main" | "subagent" | "provider" | "cli"
    name: str                      # in the user's words
    base_url: str = ""
    api_mode: str = "auto"
    api_key: str = field(default="", repr=False)
    model: str = ""
    only: bool = False
    host: str = ""
    provider_capabilities: dict = field(default_factory=dict, repr=False)
    resolve: Callable | None = field(default=None, repr=False, compare=False)
    # A surface's own way to make a client for a model here (a test's stand-in): nothing it says is kept.
    make: Callable | None = field(default=None, repr=False, compare=False)
    # A surface's own list of this connection's models, and its own word on what one can do (a Pip's catalog).
    lister: Callable | None = field(default=None, repr=False, compare=False)
    caps: Callable | None = field(default=None, repr=False, compare=False)
    _ready: bool | None = field(default=None, repr=False, compare=False)

    def ready(self) -> bool:
        """Whether DGC can reach it: its route is known, or asked for once now."""
        if self.kind == "cli":
            return False
        if self._ready is None:
            if self.resolve is not None and not self.base_url:
                try:
                    route = self.resolve() or {}
                except Exception:                    # noqa: BLE001 -- unreachable: not searched
                    route = {"error": "unreachable"}
                if isinstance(route, dict) and not route.get("error") and route.get("base_url"):
                    self.base_url = str(route.get("base_url") or "").rstrip("/")
                    self.api_mode = str(route.get("api_mode") or "auto") or "auto"
                    self.api_key = str(route.get("api_key") or "")
                    self.model = self.model or str(route.get("model") or "")
            self._ready = bool(self.base_url)
        return self._ready

    @property
    def provider_id(self) -> str:
        return self.key.split(":", 1)[1] if self.key.startswith("provider:") else ""

    def record(self) -> dict:
        """The connection as a choice keeps it: its kind and name (a saved provider's id too), never an address."""
        out = {"kind": self.kind, "name": self.name[:80]}
        if self.kind == "provider":
            out["id"] = self.provider_id
        return out


def client_for(conn: Connection, model: str, *, read_timeout: int = 10):
    if conn.make is not None:
        return conn.make(model)
    from .llm import LLMClient
    return LLMClient(conn.base_url, conn.api_key, model, api_mode=conn.api_mode or "auto", read_timeout=read_timeout,
                     provider_capabilities=conn.provider_capabilities or {})


def _ollama(conn: Connection) -> bool:
    if conn.make is not None:
        return getattr(conn.make(conn.model or "x"), "api_mode", "") == "ollama"
    if (conn.api_mode or "auto") == "ollama":
        return True
    if (conn.api_mode or "auto") != "auto":
        return False
    try:
        return client_for(conn, conn.model or "x").api_mode == "ollama"
    except Exception:                                # noqa: BLE001
        return False


def capabilities(conn: Connection, model: str) -> set | None:
    """What the host says a model can do (Ollama's capabilities), or None when it doesn't say. Kept for an hour; a
    host that didn't answer is asked again after a minute."""
    if not conn.ready():
        return None
    if conn.caps is not None:
        try:
            found = conn.caps(model)
        except Exception:                            # noqa: BLE001
            return None
        return set(found) if found is not None else None
    key = (conn.base_url.rstrip("/").lower(), str(model))
    now = time.monotonic()
    with _lock:
        entry = _probes.get(key) if conn.make is None else None
        if entry and entry[0] > now:
            return entry[1]
    found = None
    if _ollama(conn):
        try:
            client = client_for(conn, model)
            client.prepare_model()
            _, metadata = client._cached_model_metadata()
            if metadata.get("capabilities_authoritative") is True:
                found = set(metadata.get("capabilities") or ())
        except Exception:                            # noqa: BLE001 -- a model DGC can't ask is one it doesn't pick
            found = None
    with _lock:
        if conn.make is None:
            _probes[key] = (now + (PROBE_TTL if found is not None else NONE_TTL), found)
        if len(_probes) > 1024:
            _probes.pop(min(_probes, key=lambda k: _probes[k][0]), None)
    return found


def sees(conn: Connection, model: str) -> bool | None:
    """Whether a model on this connection reads images: True, False, or None when nothing says."""
    told = (conn.provider_capabilities or {}).get("vision")
    if isinstance(told, bool):
        return told
    found = capabilities(conn, model)
    if found is not None:
        return "vision" in found and not _refused(conn, model)
    return (not _refused(conn, model)) if named_sees(model) else None


def _refused(conn: Connection, model: str) -> bool:
    """The host already turned a picture away for this model (DGC's request layer remembers it a while)."""
    try:
        return not client_for(conn, model).vision_supported
    except Exception:                                # noqa: BLE001
        return False


def uses_tools(conn: Connection, model: str) -> bool | None:
    """Whether it can take over a chat (a chat's model calls tools): the host's word, else unknown."""
    found = capabilities(conn, model)
    return None if found is None else "tools" in found


def models_on(conn: Connection) -> list[str]:
    """The chat models a connection lists (embedding models left out), kept a few minutes."""
    if not conn.ready():
        return []
    if conn.only:
        return [conn.model] if conn.model else []
    if conn.lister is not None:
        try:
            values = conn.lister()
        except Exception:                            # noqa: BLE001 -- a list DGC can't read is no models
            values = []
        return [v for v in values if isinstance(v, str) and _MODEL.match(v) and not _SKIP.search(v)][:MAX_LISTED]
    key = (conn.base_url.rstrip("/").lower(), conn.api_mode, bool(conn.api_key))
    now = time.monotonic()
    with _lock:
        entry = _lists.get(key) if conn.make is None else None
        if entry and entry[0] > now:
            return list(entry[1])
    listed: list[str] = []
    ok = False
    try:
        from .model_discovery import embedding_only
        client = client_for(conn, conn.model or "")
        values = client.list_models()
        families = getattr(client, "_listed_ollama_families", {}) if getattr(client, "api_mode", "") == "ollama" else {}
        for value in values if isinstance(values, list) else []:
            if (isinstance(value, str) and _MODEL.match(value) and "://" not in value and not _SKIP.search(value)
                    and not embedding_only(value, families.get(value, "") if isinstance(families, dict) else "")):
                listed.append(value)
            if len(listed) >= MAX_LISTED:
                break
        ok = True
    except Exception:                                # noqa: BLE001 -- a list DGC can't read is no models
        listed = []
    if conn.model and conn.model not in listed:
        listed.insert(0, conn.model)
    with _lock:
        if conn.make is None:
            _lists[key] = (now + (LIST_TTL if ok else NONE_TTL), list(listed))
    return listed


@dataclass
class Found:
    """A model that can see, and the connection it is on."""

    model: str
    connection: Connection
    tools: bool | None = None

    @property
    def where(self) -> str:
        return self.connection.name

    def record(self) -> dict:
        return {"model": self.model, "connection": self.connection.record()}


def _order(connections: list, chat_key: str) -> list:
    own = [c for c in connections if c.key == chat_key]
    rest = [c for c in connections if c.key != chat_key]
    rank = {"subagent": 0, "provider": 1, "main": 2}
    return own + sorted(rest, key=lambda c: rank.get(c.kind, 3))


def candidates(connections: list, chat_key: str, chat_model: str):
    """(connection, model) to check, in order: the chat's own connection, then the Sub-agents model, then saved
    providers, then DGC's own connection. Within one, names that say they see come first. A connection is asked for
    its route and list only when the search reaches it."""
    seen = set()
    for conn in _order([c for c in connections if isinstance(c, Connection) and c.kind != "cli"], chat_key):
        if not conn.ready():
            continue
        models = models_on(conn)
        cloud = _cloud(chat_model)
        # On the chat's own connection a ":cloud" chat looks with a ":cloud" model first (no weights to load here).
        for model in sorted(models, key=lambda m: (conn.key == chat_key and _cloud(m) != cloud, not named_sees(m), m)):
            if conn.key == chat_key and model == chat_model:
                continue
            where = (conn.base_url.rstrip("/").lower(), model)
            if where in seen:
                continue
            seen.add(where)
            yield conn, model


def _cloud(model: str) -> bool:
    return bool(re.search(r"[:\-]cloud$", str(model or "").lower()))


def _signature(connections: list, chat_key: str, chat_model: str) -> tuple:
    return (chat_key, chat_model, tuple((c.key, c.kind, c.name, c.base_url, c.model, c.only, c.host)
                                        for c in connections if isinstance(c, Connection)))


def find(connections: list, chat_key: str, chat_model: str, *, cancel=None) -> Found | None:
    """The best model that can see for a chat whose own model can't: one that also uses tools (so switching to it
    works), else one that only sees; None when none of the user's connections has one."""
    signature = _signature(connections, chat_key, chat_model)
    keep = not any(getattr(c, "make", None) is not None or getattr(c, "lister", None) is not None
                   or getattr(c, "caps", None) is not None for c in connections)
    now = time.monotonic()
    with _lock:
        entry = _found.get(signature) if keep else None
        if entry and entry[0] > now:
            return entry[1]
    best = only_sees = None
    checked = 0
    for conn, model in candidates(connections, chat_key, chat_model):
        if cancel is not None and cancel.is_set():
            return None
        if checked >= MAX_PROBES:
            break
        checked += 1
        if sees(conn, model) is not True:
            continue
        tools = uses_tools(conn, model)
        if tools is False:
            only_sees = only_sees or Found(model, conn, False)
            continue
        best = Found(model, conn, tools)
        break
    result = best or only_sees
    with _lock:
        if keep:
            _found[signature] = (time.monotonic() + (FOUND_TTL if result else NONE_TTL), result)
        if len(_found) > 256:
            _found.pop(min(_found, key=lambda k: _found[k][0]), None)
    return result


def every(connections: list, chat_key: str, chat_model: str, *, cancel=None, limit: int = MAX_EVERY) -> list[Found]:
    """Every model that can see on the user's connections, in the search's order (for Settings to offer)."""
    out: list[Found] = []
    checked = 0
    for conn, model in candidates(connections, chat_key, chat_model):
        if (cancel is not None and cancel.is_set()) or checked >= MAX_PROBES * 2 or len(out) >= limit:
            break
        checked += 1
        if sees(conn, model) is True:
            out.append(Found(model, conn, uses_tools(conn, model)))
    return out


def connection_of(record: dict | None, connections: list) -> Connection | None:
    """The live connection a remembered choice names (None when it was removed)."""
    conn = (record or {}).get("connection") if isinstance(record, dict) else None
    if not isinstance(conn, dict):
        return None
    kind = conn.get("kind")
    key = {"main": "main", "subagent": "subagent"}.get(kind) or (
        f"provider:{conn.get('id')}" if kind == "provider" and conn.get("id") else "")
    return next((c for c in connections if isinstance(c, Connection) and c.key == key), None)


def found_for(record: dict | None, connections: list) -> Found | None:
    """A remembered "use this model to see" as a Found on its live connection (None when it is gone)."""
    if not isinstance(record, dict) or record.get("choice") != "relay" or not record.get("model"):
        return None
    conn = connection_of(record, connections)
    return Found(str(record["model"]), conn) if conn is not None else None


# --------------------------------------------------------------------------- the choice

def _at(value) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value:
        from datetime import datetime
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _clean_connection(value) -> dict | None:
    if not isinstance(value, dict) or value.get("kind") not in ("main", "subagent", "provider"):
        return None
    name = " ".join(str(value.get("name") or "").split())[:80]
    out = {"kind": value["kind"], "name": name or {"main": "DGC's connection", "subagent": "Sub-agents model",
                                                   "provider": "a saved provider"}[value["kind"]]}
    if value["kind"] == "provider":
        ident = str(value.get("id") or "")
        if not _PROVIDER_ID.match(ident):
            return None
        out["id"] = ident
    return out


def clean_choice(value) -> dict | None:
    """A remembered choice as DGC keeps it, or None when it isn't one."""
    if not isinstance(value, dict) or value.get("choice") not in CHOICES:
        return None
    out: dict = {"choice": value["choice"]}
    if value["choice"] == "relay":
        model, conn = value.get("model"), _clean_connection(value.get("connection"))
        if not isinstance(model, str) or not _MODEL.match(model) or conn is None:
            return None
        out.update(model=model, connection=conn)
    out["at"] = _at(value.get("at"))
    return out


def effective(*records) -> dict:
    """The newest of the choices given (a session's own and Settings'): the user's latest word. None: ask."""
    kept = [c for c in (clean_choice(r) for r in records) if c is not None]
    if not kept:
        return {"choice": "ask"}
    return max(enumerate(kept), key=lambda item: (item[1].get("at", 0.0), -item[0]))[1]


def choice_for(found: Found | None, which: str) -> dict:
    """The record a choice keeps: "relay" with the model and its connection, or "off" / "ask"."""
    if which == "relay" and found is not None:
        return {"choice": "relay", **found.record(), "at": time.time()}
    return {"choice": "off" if which == "off" else "ask", "at": time.time()}


def labels(model: str, vision: str, *, whose: str = "") -> dict:
    """The three choices in the user's words, each at most 80 characters."""
    relay = f"Use {short(vision)} to see, keep {short(model)} for the rest"
    if len(relay) > 80:
        relay = f"Use {short(vision)} to see"
    if len(relay) > 80:
        relay = "Use a model that can see"
    switch = f"Switch {whose + ' ' if whose else ''}to {short(vision)}"
    if len(switch) > 80:
        switch = f"Switch {whose + ' ' if whose else ''}to a model that can see"
    return {"relay": relay, "switch": switch, "off": "Not now"}


def line(model: str) -> str:
    """The one line a chat says when its model can't see."""
    return f"**{short(model)} can't see images.**"


def looked_line(model: str, *, count: int = 1) -> str:
    """The one line that says which model looked (auto mode, Do it all, or a choice already made)."""
    what = "the picture" if count == 1 else f"the {count} pictures"
    return f"{short(model)} looked at {what}."


def question(model: str, found: Found, *, whose: str = "this session", label_whose: str = "", lead: bool = True) -> dict:
    """The card, as Work's propose_options asks it: one question, the three choices, "Use it to see" first. ``lead``
    False: the chat already said in its own line that its model can't see (ChatDGC, a Pip), so the card doesn't."""
    words = labels(model, found.model, whose=label_whose)
    where = f" on {found.where}" if found.where else ""
    options = [{"label": words["relay"], "recommended": True,
                "description": f"{short(found.model)}{where} looks at pictures for {whose} and says what it sees; "
                               f"{short(model)} does the rest."[:400]}]
    if found.tools is not False:
        options.append({"label": words["switch"],
                        "description": f"{whose[:1].upper() + whose[1:]} runs on {short(found.model)} from now on."[:400]})
    options.append({"label": words["off"], "description": "Go on without seeing the picture."})
    return {"id": "seeing", "header": "Seeing",
            "question": (f"{short(model)} can't see images. {short(found.model)}{where} can: how should DGC look?" if lead
                         else f"{short(found.model)}{where} can see it. How should DGC look at the picture?"),
            "options": options}


def answer_of(questions_asked: list, decision: dict) -> str | None:
    """"relay", "switch" or "off" from the card's answer (Work's decision shape); None when it wasn't answered."""
    if not isinstance(decision, dict) or decision.get("outcome") != "answered" or not questions_asked:
        return None
    first = questions_asked[0]
    entry = (decision.get("answers") or {}).get(first.get("id")) or {}
    picked = [i for i in entry.get("selected", []) if isinstance(i, int) and 0 <= i < len(first.get("options") or [])]
    if not picked:
        return None
    return which_label(first["options"][picked[0]].get("label", ""))


def which_label(label: str) -> str | None:
    label = " ".join(str(label or "").split())
    if label == "Not now":
        return "off"
    if label.startswith("Switch "):
        return "switch"
    if label.startswith("Use "):
        return "relay"
    return None


# --------------------------------------------------------------------------- Settings' choice

KEY = "seeing"


def settings_choice(config) -> dict | None:
    """Settings -> Models -> "A model that can see", as config.json has it now (a long-running process reads it each
    time, so a change there counts at once)."""
    raw = None
    try:
        raw = config.get(KEY) if hasattr(config, "get") else None
    except Exception:                                # noqa: BLE001
        raw = None
    if getattr(config, "_persist", False):
        try:
            from .config import USER_CONFIG
            disk = json.loads(USER_CONFIG.read_text(encoding="utf-8"))
            if isinstance(disk, dict) and KEY in disk:
                raw = disk[KEY]
        except (OSError, ValueError, ImportError):
            pass
    return clean_choice(raw)


def host_name(base_url: str) -> str:
    """A connection's name for the user, from its address."""
    from urllib.parse import urlsplit
    try:
        host = (urlsplit(str(base_url or "")).hostname or "").lower()
    except ValueError:
        host = ""
    if host in ("127.0.0.1", "localhost", "::1"):
        return "this computer"
    return host or "DGC's connection"


def main_connection(config, *, base_url: str | None = None, api_key: str | None = None, api_mode: str | None = None,
                    model: str | None = None) -> Connection | None:
    """DGC's own connection (or a session's), as a Connection; None without an address."""
    get = config.get if hasattr(config, "get") else (lambda k, d=None: d)
    base = str(base_url if base_url is not None else (getattr(config, "base_url", "") or get("base_url", "") or ""))
    if not base:
        return None
    return Connection(key="main", kind="main", name=host_name(base), base_url=base.rstrip("/"),
                      api_mode=str(api_mode if api_mode is not None else (get("api_mode", "auto") or "auto")),
                      api_key=str(api_key if api_key is not None else (getattr(config, "api_key", "") or get("api_key", "") or "")),
                      model=str(model if model is not None else (getattr(config, "model", "") or get("model", "") or "")),
                      provider_capabilities=dict(get("provider_capabilities", {}) or {}))


def subagent_connection(config, main: Connection | None) -> Connection | None:
    """The Sub-agents model, on its own host or the main one (its key goes only to its own host)."""
    get = config.get if hasattr(config, "get") else (lambda k, d=None: d)
    model = str(get("subagent_model", "") or "")
    if not model:
        return None
    base = str(get("subagent_base_url", "") or "") or (main.base_url if main else "")
    if not base:
        return None
    same = main is not None and base.rstrip("/").lower() == main.base_url.rstrip("/").lower()
    key = str(get("subagent_api_key", "") or "") or (main.api_key if same and main else "")
    mode = str(get("subagent_api_mode", "") or "") or ((main.api_mode if same and main else "auto") or "auto")
    return Connection(key="subagent", kind="subagent", name="Sub-agents model", base_url=base.rstrip("/"),
                      api_mode=mode, api_key=key, model=model, only=True,
                      provider_capabilities=dict(get("provider_capabilities", {}) or {}) if same else {})


def provider_connections(named: list, route_of: Callable, *, skip_hosts: tuple = ()) -> list[Connection]:
    """The user's saved providers by id, name and host ([{id, name, host, kind}]), each asked for its route only when
    the search reaches it. A subscription CLI is kept as "cli": never searched."""
    out = []
    skip = {h.lower() for h in skip_hosts if h}
    for item in named if isinstance(named, list) else []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        host = str(item.get("host") or "")
        if item.get("kind") == "cli":
            out.append(Connection(key=f"provider:{item['id']}", kind="cli", name=str(item.get("name") or "")[:80]))
            continue
        if host and host.lower() in skip:
            continue                             # the chat's own connection under another name: searched already
        ident = str(item["id"])
        out.append(Connection(key=f"provider:{ident}", kind="provider", name=str(item.get("name") or ident)[:80],
                              host=host, resolve=(lambda ident=ident: route_of(ident))))
    return out


def host_of(base_url: str) -> str:
    from urllib.parse import urlsplit
    try:
        parsed = urlsplit(str(base_url or ""))
        return (parsed.netloc or "").lower()
    except ValueError:
        return ""
