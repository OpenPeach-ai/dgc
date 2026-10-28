"""A Pip's eyes: whether its model can see, and when it can't, how it sees (reported 2026-10-19).

A Personal Pip's computer is used two ways, and the model picks: by the page's text and refs (read,
click e12), and, when its model can see, by eyes and a cursor -- a screenshot of the browser (look) and
the mouse by position (click_at, drag, scroll_at...), which is what a canvas or drag-and-drop editor
needs. Only a Pip whose model can see gets the cursor; the evidence is the model's own capabilities
(Ollama's ``/api/show`` lists ``vision``), cached by ``LLMClient`` and here.

A Pip whose model reads text only, asked to look (or sent photos in its chat), says so in one line, and
its chat shows three choices: let a model that can see look for it (the vision relay, ``dgc/vision.py``:
a one-shot look that answers in words and names points), switch the Pip to that model, or not now. The
model that can see is picked from the user's own models, the same provider first (a ``:cloud`` one for a
``:cloud`` Pip). The choice is kept per Pip, so it asks once; the Pip's page changes it.

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
MAX_PROBES = 32                  # models checked for sight when picking one, per pick
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


def sees(config, model: str) -> bool | None:
    """Whether a model can see images: True, False, or None when the connection doesn't say."""
    found = capabilities(config, model)
    return None if found is None else "vision" in found


def _cloud(model: str) -> bool:
    return bool(re.search(r"[:\-]cloud$", str(model or "").lower()))


def pick(config, model: str) -> str | None:
    """The model that sees for a Pip whose ``model`` can't: one the user already has, that can see and use
    tools (so switching to it works too). The same provider first (a ``:cloud`` model for a ``:cloud``
    Pip), then the sub-agent model DGC already uses to look, then models already loaded, then small ones."""
    from .pip_models import _catalog
    try:
        catalog = _catalog(config)
    except RegistryError:
        return None
    same = [m for m in catalog if m != model and _cloud(m) == _cloud(model)]
    other = [m for m in catalog if m != model and _cloud(m) != _cloud(model)]
    helper = str(config.get("subagent_model", "") or "")
    loaded, sizes = _ollama_state(config)

    def rank(name):
        return (name != helper, name not in loaded, sizes.get(name, 1 << 62), name)
    probes = 0
    for group in (same, other):
        for name in sorted((m for m in group if not re.search(r"embed|minilm|rerank", m, re.I)), key=rank):
            if probes >= MAX_PROBES:
                return None
            probes += 1
            found = capabilities(config, name)
            if found and {"vision", "tools", "completion"} <= found:
                return name
    return None


def _ollama_state(config) -> tuple[set, dict]:
    """Ollama's loaded models and model sizes, when the connection is Ollama: a loaded model answers at once."""
    import requests
    try:
        client = _client(config, str(config.get("model", "") or "x"))
        if client.api_mode != "ollama":
            return set(), {}
        root = client._ollama_root
        tags = requests.get(f"{root}/api/tags", headers=client._headers(), timeout=5).json().get("models", [])
        loaded = requests.get(f"{root}/api/ps", headers=client._headers(), timeout=5).json().get("models", [])
    except Exception:                    # noqa: BLE001 - ranking only
        return set(), {}
    sizes = {str(m.get("name") or m.get("model")): int(m.get("size") or 0) for m in tags if isinstance(m, dict)}
    return {str(m.get("name") or m.get("model")) for m in loaded if isinstance(m, dict)}, sizes


# --------------------------------------------------------------------------- the card and the choice

def short(model: str) -> str:
    name = str(model or "")
    return name[:-len(":latest")] if name.endswith(":latest") else name


def line(model: str) -> str:
    """The one line a Pip says when it can't see."""
    return f"**{short(model)} can't see images.**"


def labels(model: str, vision: str) -> dict:
    """The card's three choices, in the user's words (each at most 80 characters, as every choice is)."""
    relay = f"Use {short(vision)} to see, keep {short(model)} for the rest"
    if len(relay) > 80:
        relay = f"Use {short(vision)} to see"
    if len(relay) > 80:
        relay = "Use a model that can see"
    switch = f"Switch this Pip to {short(vision)}"
    if len(switch) > 80:
        switch = "Switch this Pip to a model that can see"
    return {"relay": relay, "switch": switch, "off": "Not now"}


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
    return _model_id(choice["model"] if choice.get("mode") == "model" else default_model(config))


def status(store, pip_id: str, config) -> dict:
    """For the Pip's page: its model, whether it sees, and how it sees when it can't."""
    pip = store._job(pip_id)
    if pip["source_policy"] != {"mode": "personal"}:
        raise RegistryError("invalid_request", "Only Personal Pips use a computer and photos.")
    model = _pip_model(store, pip_id, config)
    own = saved(store.db, pip_id)
    can = sees(config, model)
    vision = None if can else (own["vision_model"] if own["choice"] == "relay" and own["vision_model"] else pick(config, model))
    return {"pip_id": pip_id, "model": model, "sees": can, "choice": own["choice"], "vision_model": vision}


def set_choice(store, pip_id: str, choice, actor: str, config) -> dict:
    """The Pip's page: ask when it needs to see, let a model that can see look for it, or don't."""
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "Choose how a Pip sees on this computer.")
    if choice not in CHOICES:
        raise RegistryError("invalid_request", "Choose ask, relay or off.")
    pip = store._job(pip_id)
    if pip["source_policy"] != {"mode": "personal"}:
        raise RegistryError("invalid_request", "Only Personal Pips use a computer and photos.")
    vision = None
    if choice == "relay":
        vision = pick(config, _pip_model(store, pip_id, config))
        if vision is None:
            raise RegistryError("no_vision_model", "None of your models can see images, so none can look for it.")
    _put(store.registry, SAVED + pip_id, {"choice": choice, "vision_model": vision, "at": _now()})
    _put(store.registry, ASKED + pip_id, None)
    return status(store, pip_id, config)


def _now() -> str:
    from datetime import datetime, timezone
    from .pip_schedules import timestamp
    return timestamp(datetime.now(timezone.utc))


# --------------------------------------------------------------------------- a run, its card and its answer

def pin(registry, row, manifest: dict, config) -> dict:
    """At a Personal Pip's run start: how it sees, for its worker (``computer_eyes``). The worker checks its
    own model for sight; this carries the user's choice, the model that would look for it, and, for the
    run that answers the card, that answer and the photos it was about."""
    if manifest.get("run_kind") not in ("conversation", "personal_task"):
        return manifest
    own = saved(registry.db, row["pip_id"])
    model = str(manifest.get("model") or "")
    eyes = {"choice": own["choice"], "vision_model": None, "convention": convention_for(model)}
    settings = manifest.get("model_settings")
    if isinstance(settings, dict) and "brain" in settings:
        # Its model is the user's Claude Code or Codex (pip_brain): it sees, in pixels; no endpoint to ask.
        eyes["convention"] = "pixels"
    elif model and sees(config, model) is False:
        vision = own["vision_model"] if own["choice"] == "relay" and own["vision_model"] else pick(config, model)
        if vision:
            eyes.update(vision_model=vision, vision_convention=convention_for(vision))
    decided = _get(registry.db, DECIDED + row["pip_id"])
    if isinstance(decided, dict) and decided.get("run_id") == row["id"]:
        eyes["decided"] = decided.get("choice") if decided.get("choice") in ("relay", "switch", "off") else None
        photos = decided.get("photos")
        if isinstance(photos, list) and photos:
            from .pip_chat import image_paths, validate_images
            try:
                items = validate_images(photos)
                eyes["photos"] = [{"item": item, "path": str(path)} for item, path in
                                  zip(items, image_paths(registry.directory, row["pip_id"], items))]
            except RegistryError:
                pass
        _put(registry, DECIDED + row["pip_id"], None)
    return {**manifest, "computer_eyes": eyes}


def _get(db, key: str):
    row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    try:
        return json.loads(row[0]) if row else None
    except ValueError:
        return None


def validate_pin(value) -> dict:
    """A run's ``computer_eyes`` as its worker reads it."""
    keys = {"choice", "vision_model", "convention", "vision_convention", "decided", "photos"}
    if (not isinstance(value, dict) or set(value) - keys or value.get("choice") not in CHOICES
            or value.get("convention") not in ("pixels", "thousandths")
            or value.get("vision_convention", "pixels") not in ("pixels", "thousandths")
            or not (value.get("vision_model") is None or isinstance(value["vision_model"], str) and value["vision_model"])
            or value.get("decided") not in (None, "relay", "switch", "off")):
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
    if (not isinstance(value, dict) or set(value) - {"model", "vision_model", "photos"}
            or not isinstance(value.get("model"), str) or not value["model"]
            or not isinstance(value.get("vision_model"), str) or not value["vision_model"]):
        raise RegistryError("invalid_reply", "This reply's eyes card is invalid.")
    if "photos" in value:
        from .pip_chat import validate_images
        validate_images(value["photos"])
    return value


def record_card(store, run, card: dict, reply_id: str) -> None:
    """The reply showed the card: remember it, so the user's tap is recognised as its answer."""
    card = validate_card(card)
    _put(store.registry, ASKED + run["pip_id"], {
        "message_id": reply_id, "run_id": run["id"], "model": card["model"], "vision_model": card["vision_model"],
        "labels": labels(card["model"], card["vision_model"]), **({"photos": card["photos"]} if "photos" in card else {})})


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
    if which not in ("relay", "switch", "off"):
        return None
    latest = store.db.execute("SELECT id FROM pip_chat_messages WHERE pip_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
                              (pip_id,)).fetchone()
    if latest is None or latest[0] != asked.get("message_id"):
        return None                          # an older card: the words are just words
    vision = str(asked.get("vision_model") or "")
    if which == "switch":
        from .pip_models import resolve_model_choice
        choice = {"mode": "model", "model": vision}
        resolve_model_choice(config, choice)
        pip = store._job(pip_id)
        proposal = store.propose(pip_id, pip["current_version"], {"model_choice": choice}, actor,
                                 "Switched to a model that can see, from the Pip's chat.")
        store.accept(pip_id, proposal["id"], pip["current_version"], actor)
    else:
        _put(store.registry, SAVED + pip_id, {"choice": which, "vision_model": vision if which == "relay" else None,
                                              "at": _now()})
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
