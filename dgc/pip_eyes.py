"""A Pip's eyes: whether its model can see, and when it can't, how it sees (reported 2026-10-19).

A Personal Pip's computer is used two ways, and the model picks: by the page's text and refs (read,
click e12), and, when its model can see, by eyes and a cursor -- a screenshot of the browser (look) and
the mouse by position (click_at, drag, scroll_at...), which is what a canvas or drag-and-drop editor
needs. Only a Pip whose model can see gets the cursor; the evidence is the model's own capabilities
(Ollama's ``/api/show`` lists ``vision``), cached by ``LLMClient`` and here.

A Pip whose model reads text only, asked to look (or sent photos in its chat), says so in one line, and
its chat shows three choices: let a model that can see look for it (the vision relay, ``dgc/vision.py``:
a one-shot look that answers in words and names points), switch the Pip to that model, or not now. The
model that can see is found by dgc/seeing.py (one search for Work, ChatDGC and Pips) on every connection DGC can
use without a window: the Pip's own (DGC's, or the saved provider it runs on) first -- a ``:cloud`` model for a
``:cloud`` Pip -- then the Sub-agents model, then the other saved providers. The choice is kept per Pip, so it asks
once; the Pip's page changes it, and Settings -> Models -> "A model that can see" too (the newer word counts). At Do
it all nothing is asked: the best one looks, and the reply says in one line which model looked.

The three choices are an ordinary options card (``offer_choices``'s buttons): a tap sends its words as the
user's message, and ``answer`` recognises them as the answer to the card DGC itself made, so an editor
that knows nothing of eyes still shows and answers it.

Points: a model names a point in the screenshot it saw. Most answer in the image's pixels; Qwen3's vision
models answer on a 0-1000 scale across it (measured 2026-10-20: qwen3-vl:8b 4/4 and qwen3.8:27b 3/4 on that
scale when asked for pixels). The tool says each model's own scale plainly, and an answer that can only be
the other scale (a pixel past 1000, or a point past the image's edge) switches the run to it.
"""
from __future__ import annotations

import json
import re
import threading
import time

from .workspace_registry import RegistryError

SAVED = "pip_eyes:"              # + pip id, in registry metadata: {"choice", "vision_model", "at"}
ASKED = "pip_eyes_asked:"        # + pip id: the card DGC showed, until it is answered or another reply comes
DECIDED = "pip_eyes_decided:"    # + pip id: the answer, for the run that answers it
CHOICES = ("ask", "relay", "off")
PROBE_TTL = 3600.0
_probes: dict = {}               # (base_url, model) -> (expires, capabilities set or None)
_probe_lock = threading.Lock()


# --------------------------------------------------------------------------- points

def convention_for(model: str) -> str:
    """How a model names a point in an image: "thousandths" (0-1000 across it) or "pixels"."""
    name = str(model or "").rsplit("/", 1)[-1].lower()
    if re.match(r"qwen3(?:[.\-:]|vl|$)", name):
        return "thousandths"
    return "pixels"


def to_pixels(points, width: int, height: int, convention: str, seen: dict) -> list[tuple[float, float]]:
    """The model's points as pixels of the screenshot it saw. ``seen`` is the run's memory: an answer that
    can only be the other scale switches it there for the rest of the run."""
    use = seen.get("convention") or convention
    numbers = [value for point in points for value in point]
    if use == "pixels" and any(x > width or y > height for x, y in points) and all(0 <= v <= 1000 for v in numbers):
        use = seen["convention"] = "thousandths"
    elif use == "thousandths" and any(v > 1000 for v in numbers) and all(0 <= x <= width and 0 <= y <= height
                                                                          for x, y in points):
        use = seen["convention"] = "pixels"
    if use == "thousandths":
        return [(x * width / 1000.0, y * height / 1000.0) for x, y in points]
    return [(float(x), float(y)) for x, y in points]


# --------------------------------------------------------------------------- which models see

def _client(config, model: str):
    from .llm import LLMClient
    from .pip_models import _connection
    base, mode = _connection(config)
    return LLMClient(base, config.get("api_key", ""), model, api_mode=mode, read_timeout=10,
                     provider_capabilities=config.get("provider_capabilities", {}))


def capabilities(config, model: str) -> set | None:
    """What a model on the user's connection says it can do (Ollama's capabilities), or None when the
    connection doesn't say. Cached for an hour; a failed look is not kept so long."""
    try:
        client = _client(config, model)
    except (RegistryError, ValueError, TypeError):
        return None
    key = (str(client.base_url).lower(), str(model))
    now = time.monotonic()
    with _probe_lock:
        entry = _probes.get(key)
        if entry and entry[0] > now:
            return entry[1]
    found = None
    try:
        client.prepare_model()
        _, metadata = client._cached_model_metadata()
        if metadata.get("capabilities_authoritative") is True:
            found = set(metadata.get("capabilities") or ())
    except Exception:                    # noqa: BLE001 - a model DGC can't ask is one it doesn't pick
        found = None
    with _probe_lock:
        _probes[key] = (now + (PROBE_TTL if found is not None else 60.0), found)
        if len(_probes) > 512:
            _probes.pop(min(_probes, key=lambda k: _probes[k][0]), None)
    return found


def connections(config, choice: dict | None = None) -> tuple[list, str]:
    """(every connection a Pip can see with, the key of its own): DGC's connection, the Sub-agents model, and the
    saved providers DGC keeps for Pips. A Pip runs with no window, so these are the ones it can reach."""
    from . import seeing
    from .pip_models import _catalog
    out = []
    main = seeing.main_connection(config)
    if main is not None:
        main.lister = lambda: _catalog(config)
        main.caps = lambda model: capabilities(config, model)
        out.append(main)
    sub = seeing.subagent_connection(config, main)
    if sub is not None:
        if main is not None and sub.base_url.lower() == main.base_url.lower():
            sub.caps = lambda model: capabilities(config, model)
        out.append(sub)
    reader = getattr(config, "saved_provider", None)
    try:
        named = config.saved_provider_names() if callable(getattr(config, "saved_provider_names", None)) else []
    except Exception:                    # noqa: BLE001 - no saved providers read: none searched
        named = []
    if callable(reader):
        out += seeing.provider_connections([{**n, "kind": "api"} for n in named], lambda ident: reader(ident) or {},
                                           skip_hosts=())
    own = "main"
    if isinstance(choice, dict) and choice.get("mode") == "provider" and choice.get("provider"):
        own = f"provider:{choice['provider']}"
    return out, own


def _choice_of(store, pip_id) -> dict:
    try:
        return store._job(pip_id).get("model_choice") or {"mode": "default"}
    except Exception:                    # noqa: BLE001
        return {"mode": "default"}


def find(config, model: str, choice: dict | None = None):
    """The model that sees for a Pip whose ``model`` can't, and its connection (seeing.Found), or None."""
    from . import seeing
    conns, own = connections(config, choice)
    return seeing.find(conns, own, model)


def sees(config, model: str, choice: dict | None = None) -> bool | None:
    """Whether a model can see images: True, False, or None when the connection doesn't say. A Pip on a saved provider
    is asked about on that provider."""
    from . import seeing
    if isinstance(choice, dict) and choice.get("mode") == "provider":
        conns, own = connections(config, choice)
        conn = next((c for c in conns if c.key == own), None)
        return seeing.sees(conn, model) if conn is not None and conn.ready() else None
    found = capabilities(config, model)
    return None if found is None else "vision" in found


def pick(config, model: str, choice: dict | None = None) -> str | None:
    """The model that sees for a Pip whose ``model`` can't: one the user already has, that can see (and use tools, so
    switching to it works too, when there is one). The Pip's own connection first (a ``:cloud`` model for a ``:cloud``
    Pip), then the Sub-agents model, then the other saved providers (dgc/seeing.py)."""
    found = find(config, model, choice)
    return found.model if found is not None else None


# --------------------------------------------------------------------------- the card and the choice

def short(model: str) -> str:
    name = str(model or "")
    return name[:-len(":latest")] if name.endswith(":latest") else name


def line(model: str) -> str:
    """The one line a Pip says when it can't see."""
    return f"**{short(model)} can't see images.**"


def labels(model: str, vision: str, switch: bool = True) -> dict:
    """The card's choices, in the user's words (each at most 80 characters, as every choice is). ``switch`` False: a
    model that only looks (it can't take tools, or the Pip can't run on its connection) offers two."""
    from .seeing import labels as words
    out = words(model, vision, whose="this Pip")
    return out if switch else {k: v for k, v in out.items() if k != "switch"}


def saved(db, pip_id: str) -> dict:
    row = db.execute("SELECT value FROM metadata WHERE key=?", (SAVED + pip_id,)).fetchone()
    try:
        value = json.loads(row[0]) if row else {}
    except ValueError:
        value = {}
    if not isinstance(value, dict) or value.get("choice") not in CHOICES:
        return {"choice": "ask", "vision_model": None}
    vision = value.get("vision_model")
    return {"choice": value["choice"], "vision_model": vision if isinstance(vision, str) and vision else None}


def saved_route(db, pip_id: str) -> dict | None:
    """The connection the model that looks for this Pip is on, as its choice keeps it (None: its own)."""
    from .seeing import _clean_connection
    value = _get(db, SAVED + pip_id)
    return _clean_connection(value.get("vision_route")) if isinstance(value, dict) else None


def _own_choice(db, pip_id: str) -> dict | None:
    """The Pip's own saved choice as a seeing choice (with its time), or None when it never chose."""
    from .seeing import clean_choice
    value = _get(db, SAVED + pip_id)
    if not isinstance(value, dict) or value.get("choice") not in CHOICES:
        return None
    if value["choice"] == "relay":
        route = saved_route(db, pip_id) or {"kind": "main", "name": "its own connection"}
        return clean_choice({"choice": "relay", "model": value.get("vision_model"), "connection": route,
                             "at": value.get("at")})
    return clean_choice({"choice": value["choice"], "at": value.get("at")})


def effective(db, pip_id: str, config) -> dict:
    """How this Pip sees now: its own choice or Settings' ("A model that can see"), the newer one; ask when neither."""
    from .seeing import effective as newest, settings_choice
    return newest(_own_choice(db, pip_id), settings_choice(config))


def _put(registry, key: str, value) -> None:
    import contextlib
    with contextlib.nullcontext() if registry.db.in_transaction else registry.transaction():
        if value is None:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (key,))
        else:
            registry.db.execute("INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                (key, json.dumps(value, sort_keys=True)))


def _pip_model(store, pip_id: str, config) -> str:
    from .pip_models import _model_id, default_model
    pip = store._job(pip_id)
    choice = pip.get("model_choice") or {"mode": "default"}
    return _model_id(choice["model"] if choice.get("mode") in ("model", "provider") else default_model(config))


def _vision_for(db, pip_id: str, config, model: str, choice: dict, chosen: dict):
    """(the model that looks for it, its connection's record) for a Pip whose model can't see: the one chosen, else
    the best DGC finds; (None, None) when none of the user's models can see."""
    if chosen["choice"] == "relay" and chosen.get("model"):
        return chosen["model"], chosen.get("connection")
    found = find(config, model, choice)
    return (found.model, found.connection.record()) if found is not None else (None, None)


def status(store, pip_id: str, config) -> dict:
    """For the Pip's page: its model, whether it sees, and how it sees when it can't."""
    pip = store._job(pip_id)                # any Pip: a folder Pip's box and photos too (one kind of Pip, 16 Nov)
    choice = pip.get("model_choice") or {"mode": "default"}
    model = _pip_model(store, pip_id, config)
    chosen = effective(store.db, pip_id, config)
    can = sees(config, model, choice)
    vision = None if can else _vision_for(store.db, pip_id, config, model, choice, chosen)[0]
    return {"pip_id": pip_id, "model": model, "sees": can, "choice": chosen["choice"], "vision_model": vision}


def set_choice(store, pip_id: str, choice, actor: str, config) -> dict:
    """The Pip's page: ask when it needs to see, let a model that can see look for it, or don't."""
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "Choose how a Pip sees on this computer.")
    if choice not in CHOICES:
        raise RegistryError("invalid_request", "Choose ask, relay or off.")
    store._job(pip_id)                      # any Pip (one kind of Pip, 16 Nov)
    vision = route = None
    if choice == "relay":
        found = find(config, _pip_model(store, pip_id, config), _choice_of(store, pip_id))
        if found is None:
            raise RegistryError("no_vision_model", "None of your models can see images, so none can look for it.")
        vision, route = found.model, found.connection.record()
    _put(store.registry, SAVED + pip_id, {"choice": choice, "vision_model": vision, "at": _now(),
                                          **({"vision_route": route} if route else {})})
    _put(store.registry, ASKED + pip_id, None)
    return status(store, pip_id, config)


def _now() -> str:
    from datetime import datetime, timezone
    from .pip_schedules import timestamp
    return timestamp(datetime.now(timezone.utc))


# --------------------------------------------------------------------------- a run, its card and its answer

def _switchable(route: dict | None, tools) -> bool:
    """A Pip can move onto the model that sees: one that uses tools, on DGC's connection or a saved provider."""
    return tools is not False and (route is None or route.get("kind") in ("main", "provider"))


def pin(registry, row, manifest: dict, config) -> dict:
    """At a Pip's chat or task start: how it sees, for its worker (``computer_eyes``). The worker checks its
    own model for sight; this carries the user's choice, the model that would look for it and its connection, and,
    for the run that answers the card, that answer and the photos it was about. At Do it all a Pip that hasn't chosen
    doesn't ask: the best model that can see looks (``auto``), and the reply says which."""
    if manifest.get("run_kind") not in ("conversation", "personal_task"):
        return manifest
    pip_id = row["pip_id"]
    chosen = effective(registry.db, pip_id, config)
    model = str(manifest.get("model") or "")
    eyes = {"choice": chosen["choice"], "vision_model": None, "convention": convention_for(model)}
    settings = manifest.get("model_settings")
    choice = {"mode": "provider", "provider": settings["provider"]} if isinstance(settings, dict) and settings.get(
        "provider") else {"mode": "model"}
    if isinstance(settings, dict) and "brain" in settings:
        # Its model is the user's Claude Code or Codex (pip_brain): it sees, in pixels; no endpoint to ask.
        eyes["convention"] = "pixels"
    elif model and sees(config, model, choice) is False:
        found = None
        if chosen["choice"] == "relay" and chosen.get("model"):
            vision, route, tools = chosen["model"], chosen.get("connection"), None
        else:
            found = find(config, model, choice)
            vision, route, tools = ((found.model, found.connection.record(), found.tools) if found is not None
                                    else (None, None, None))
        if vision:
            eyes.update(vision_model=vision, vision_convention=convention_for(vision))
            if route:
                eyes["vision_route"] = route
            if not _switchable(route, tools):
                eyes["switch"] = False
            if eyes["choice"] == "ask" and _does_it_all(registry, pip_id):
                eyes.update(choice="relay", auto=True)       # Do it all: no question; the reply says which model looked
    decided = _get(registry.db, DECIDED + pip_id)
    if isinstance(decided, dict) and decided.get("run_id") == row["id"]:
        eyes["decided"] = decided.get("choice") if decided.get("choice") in ("relay", "switch", "off") else None
        photos = decided.get("photos")
        if isinstance(photos, list) and photos:
            from .pip_chat import image_paths, validate_images
            try:
                items = validate_images(photos)
                eyes["photos"] = [{"item": item, "path": str(path)} for item, path in
                                  zip(items, image_paths(registry.directory, pip_id, items))]
            except RegistryError:
                pass
        _put(registry, DECIDED + pip_id, None)
    return {**manifest, "computer_eyes": eyes}


def _does_it_all(registry, pip_id: str) -> bool:
    try:
        from .pip_levels import FULL, effective as level_now
        return level_now(registry, pip_id) == FULL
    except Exception:                    # noqa: BLE001 - a level DGC can't read asks, as Ask me first does
        return False


def look_connection(config, route: dict | None, *, on_provider: bool):
    """The connection a run's look uses (seeing.Connection), from the route its pin names: a saved provider by its id
    (its key read now, as a Pip's own provider's is), DGC's connection or the Sub-agents model. A run on a saved
    provider holds only that provider's address and key, so DGC's own are read afresh. None when it was removed."""
    from . import seeing
    kind = (route or {}).get("kind")
    if kind == "provider":
        reader = getattr(config, "saved_provider", None)
        record = reader(route.get("id")) if callable(reader) else None
        if not record:
            return None
        return seeing.Connection(key=f"provider:{route['id']}", kind="provider", name=str(record.get("name") or "")[:80],
                                 base_url=str(record["base_url"]).rstrip("/"), api_mode=str(record.get("api_mode") or "auto"),
                                 api_key=str(record.get("api_key") or ""))
    base = config
    if on_provider:
        from .config import Config
        base = Config(project_root=config.project_root)
    main = seeing.main_connection(base)
    if kind == "subagent":
        return seeing.subagent_connection(base, main)
    return main


def _get(db, key: str):
    row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    try:
        return json.loads(row[0]) if row else None
    except ValueError:
        return None


def worker_route(config, manifest: dict) -> dict | None:
    """The look's route for a run's worker, read here where the user's settings are (a worker has an empty private home:
    its keys come with its payload, as its own model's key does). None when its pin names no connection to look on."""
    eyes = manifest.get("computer_eyes") if isinstance(manifest, dict) else None
    route = eyes.get("vision_route") if isinstance(eyes, dict) else None
    if not isinstance(route, dict) or not eyes.get("vision_model"):
        return None
    try:
        conn = look_connection(config, route, on_provider=False)
    except Exception:                    # noqa: BLE001 - no route: it can't look, as a removed provider can't
        return None
    if conn is None or not conn.ready():
        return None
    return {"base_url": conn.base_url, "api_mode": conn.api_mode or "auto", "api_key": conn.api_key,
            "name": conn.name, "kind": conn.kind}


def worker_connection(value):
    """The worker's side of worker_route: a seeing.Connection, or None when the payload carried none."""
    from . import seeing
    if (not isinstance(value, dict) or not all(isinstance(value.get(k), str) for k in ("base_url", "api_mode", "api_key",
                                                                                        "name", "kind"))
            or not value["base_url"].startswith(("http://", "https://"))):
        return None
    return seeing.Connection(key="eyes", kind=value["kind"], name=value["name"][:80], base_url=value["base_url"].rstrip("/"),
                             api_mode=value["api_mode"] or "auto", api_key=value["api_key"])


def validate_pin(value) -> dict:
    """A run's ``computer_eyes`` as its worker reads it."""
    from .seeing import _clean_connection
    keys = {"choice", "vision_model", "convention", "vision_convention", "decided", "photos", "vision_route", "auto",
            "switch"}
    if (not isinstance(value, dict) or set(value) - keys or value.get("choice") not in CHOICES
            or value.get("convention") not in ("pixels", "thousandths")
            or value.get("vision_convention", "pixels") not in ("pixels", "thousandths")
            or not (value.get("vision_model") is None or isinstance(value["vision_model"], str) and value["vision_model"])
            or value.get("decided") not in (None, "relay", "switch", "off")
            or value.get("auto", False) not in (True, False) or value.get("switch", True) not in (True, False)
            or ("vision_route" in value and _clean_connection(value["vision_route"]) != value["vision_route"])):
        raise RegistryError("invalid_manifest", "How this Pip sees is malformed.")
    photos = value.get("photos")
    if photos is not None and (not isinstance(photos, list) or not all(
            isinstance(p, dict) and set(p) == {"item", "path"} and isinstance(p["path"], str) for p in photos)):
        raise RegistryError("invalid_manifest", "How this Pip sees is malformed.")
    if photos:
        from .pip_chat import validate_images
        validate_images([p["item"] for p in photos])
    return value


def validate_card(value) -> dict:
    """A reply's eyes card: what its worker asked (``eyes`` in its result)."""
    from .seeing import _clean_connection
    if (not isinstance(value, dict) or set(value) - {"model", "vision_model", "photos", "vision_route", "switch", "asked"}
            or not isinstance(value.get("model"), str) or not value["model"]
            or not isinstance(value.get("vision_model"), str) or not value["vision_model"]
            or value.get("switch", True) not in (True, False) or value.get("asked", False) not in (True, False)
            or ("vision_route" in value and _clean_connection(value["vision_route"]) != value["vision_route"])):
        raise RegistryError("invalid_reply", "This reply's eyes card is invalid.")
    if "photos" in value:
        from .pip_chat import validate_images
        validate_images(value["photos"])
    return value


def card_labels(card: dict) -> dict:
    return labels(card["model"], card["vision_model"], card.get("switch", True) is not False)


def card_question(card: dict) -> list:
    """The eyes card as a question card (Pips API 106's, Work's own shape): one question, its choices."""
    from . import seeing
    from .questions import normalize_questions
    conn = card.get("vision_route") or {}
    found = seeing.Found(model=card["vision_model"],
                         connection=seeing.Connection(key="x", kind=conn.get("kind", "main"), name=conn.get("name", "")),
                         tools=None if card.get("switch", True) is not False else False)
    return normalize_questions({"questions": [seeing.question(card["model"], found, whose="this Pip",
                                                              label_whose="this Pip", lead=False)]})


def record_card(store, run, card: dict, reply_id: str) -> None:
    """The reply showed the card: remember it, so the user's tap is recognised as its answer."""
    card = validate_card(card)
    words = card_labels(card)
    said = {}
    if card.get("asked"):
        # Shown as a question card: its answer comes as "<question> <choice>" (questions.answer_words).
        from .questions import answer_words
        kept = card_question(card)
        for index, option in enumerate(kept[0]["options"]):
            which = next((k for k, v in words.items() if v == option["label"]), None)
            if which:
                said[which] = answer_words(kept, {"answers": {kept[0]["id"]: {"selected": [index], "other": ""}}})
    _put(store.registry, ASKED + run["pip_id"], {
        "message_id": reply_id, "run_id": run["id"], "model": card["model"], "vision_model": card["vision_model"],
        "labels": words, **({"said": said} if said else {}),
        **({"vision_route": card["vision_route"]} if card.get("vision_route") else {}),
        **({"photos": card["photos"]} if "photos" in card else {})})


def answer(store, pip_id: str, text, actor: str, config) -> dict | None:
    """The user's message answers the card under the Pip's latest reply: apply the choice before its run is
    queued (a switch changes the Pip's model first, so that run already sees). None when it doesn't."""
    if actor not in ("editor-user", "local-console") or not isinstance(text, str):
        return None
    asked = _get(store.db, ASKED + pip_id)
    if not isinstance(asked, dict) or not isinstance(asked.get("labels"), dict):
        return None
    said = " ".join(text.split()).casefold()
    which = next((key for key, label in asked["labels"].items() if str(label).casefold() == said), None)
    if which is None and isinstance(asked.get("said"), dict):
        which = next((key for key, words in asked["said"].items() if " ".join(str(words).split()).casefold() == said), None)
    if which not in ("relay", "switch", "off"):
        return None
    latest = store.db.execute("SELECT id FROM pip_chat_messages WHERE pip_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
                              (pip_id,)).fetchone()
    if latest is None or latest[0] != asked.get("message_id"):
        return None                          # an older card: the words are just words
    vision = str(asked.get("vision_model") or "")
    route = asked.get("vision_route") if isinstance(asked.get("vision_route"), dict) else None
    if which == "switch":
        from .pip_models import resolve_model_choice
        pip = store._job(pip_id)
        held = pip.get("model_choice") or {}
        # The model that can see is on a saved provider: the Pip moves onto it. One found on the Pip's own provider
        # keeps it there; one on DGC's own connection runs there.
        if route and route.get("kind") == "provider":
            choice = {"mode": "provider", "provider": route["id"], "model": vision}
        elif route is None and held.get("mode") == "provider":
            choice = {"mode": "provider", "provider": held["provider"], "model": vision}
        else:
            choice = {"mode": "model", "model": vision}
        resolve_model_choice(config, choice)
        proposal = store.propose(pip_id, pip["current_version"], {"model_choice": choice}, actor,
                                 "Switched to a model that can see, from the Pip's chat.")
        store.accept(pip_id, proposal["id"], pip["current_version"], actor)
    else:
        _put(store.registry, SAVED + pip_id, {"choice": which, "vision_model": vision if which == "relay" else None,
                                              "at": _now(), **({"vision_route": route} if which == "relay" and route else {})})
    _put(store.registry, ASKED + pip_id, None)
    return {"choice": which, "vision_model": vision, **({"photos": asked["photos"]} if asked.get("photos") else {})}


def bind(store, pip_id: str, run_id: str, decided: dict) -> None:
    """The run that answers the card is told the answer (and gets the photos it was about) when it starts."""
    _put(store.registry, DECIDED + pip_id, {**decided, "run_id": run_id})


DECIDED_NOTE = {
    "relay": ("This message is from DGC, not the user: the user chose that {vision} sees for you. look sends it your "
              "screen with your question and it answers in words, naming points you can click; photos they sent are "
              "described to you the same way. Carry on with what they asked before."),
    "switch": ("This message is from DGC, not the user: the user switched you to {vision}, which can see. look shows you "
               "your screen; photos they sent are yours to see. Carry on with what they asked before."),
    "off": ("This message is from DGC, not the user: the user chose that you work without seeing for now. Use the "
            "page's text (read) where you can, and say in one sentence what you could not do without seeing."),
}
