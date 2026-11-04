"""Per-Pip model choices: the user's existing native model connection, or (API 55) their own subscription CLI.

Choices never contain a provider, endpoint, credential or permission change. Discovery
uses DGC's provider layer; these helpers bound accepted catalog data and public output.
The provider layer owns HTTP timeouts/body parsing (its compatible/Ollama catalog paths
do not currently impose a response-byte ceiling), so this is not an allocation limit.

A subscription choice names only the engine (``{"mode": "subscription", "engine": "codex"}``). Default follows the
Pips default model (config ``pips_model``) when one is set: a model on DGC's own connection, for every Pip on Default.
With none it is "Same as DGC": DGC's own model, or its subscription default when it has one. A subscription runs a
Personal Pip's turns on that CLI with DGC's tools alone (pip_brain).
"""
from __future__ import annotations

import json
import re
from urllib.parse import urlsplit

from .llm import LLMClient
from .redaction import redact_text, secret_values
from .workspace_registry import RegistryError

MAX_MODEL_ID = 256
MAX_CATALOG_MODELS = 4096
MAX_CATALOG_BYTES = 256 * 1024
MAX_LIST_MODELS = 256
MAX_LIST_BYTES = 64 * 1024
_MODEL_ID = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._:/@+\-]{0,255}\Z")
_API_MODES = frozenset({"auto", "ollama", "anthropic", "chat_completions", "responses"})
_ROUTER_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\Z")


def _model_id(value):
    if (not isinstance(value, str) or len(value) > MAX_MODEL_ID
            or not _MODEL_ID.fullmatch(value) or "://" in value):
        raise RegistryError("invalid_model", "Choose a valid model ID of at most 256 characters from the configured connection.")
    return value


def validate_model_choice(value) -> dict:
    """Validate an explicit choice; callers supply the default for absent legacy data."""
    if not isinstance(value, dict):
        raise RegistryError("invalid_model_choice", "Choose DGC default or one model from the configured connection.")
    if value.get("mode") == "default" and set(value) == {"mode"}:
        return {"mode": "default"}
    if value.get("mode") == "model" and set(value) == {"mode", "model"}:
        return {"mode": "model", "model": _model_id(value["model"])}
    if value.get("mode") == "subscription" and set(value) == {"mode", "engine"}:
        from .pip_brain import ENGINES, NOT_FOR_PIPS
        if value["engine"] not in ENGINES:
            raise RegistryError("invalid_model_choice", NOT_FOR_PIPS.get(value["engine"], "Choose Claude Code or Codex."))
        return {"mode": "subscription", "engine": value["engine"]}
    # API 70: DGC Router. {"mode": "router"} runs on any system with the Pips job; with system and model, on that one
    # (a pinned Pip waits for its own system).
    if value.get("mode") == "router" and set(value) == {"mode"}:
        return {"mode": "router"}
    if value.get("mode") == "router" and set(value) == {"mode", "system", "model"}:
        system = value["system"]
        if not isinstance(system, str) or not _ROUTER_ID.fullmatch(system):
            raise RegistryError("invalid_model_choice", "Choose a DGC Router system by its id.")
        return {"mode": "router", "system": system, "model": _model_id(value["model"])}
    raise RegistryError("invalid_model_choice", "A Pip model choice accepts only mode and, for an explicit choice, model, engine, or a DGC Router system and model.")


def pips_default(config) -> str:
    """The Pips default model as configured (``pips_model``), "" when Pips follow DGC. Not yet validated. A DGC Router
    default (``router`` or ``router:<system>/<model>``, pips_router_default) is not a model on DGC's connection: ""."""
    value = config.get("pips_model", "")
    value = value.strip() if isinstance(value, str) else ""
    return "" if router_choice_of(value) is not None else value


def router_choice_of(label) -> dict | None:
    """The DGC Router choice a run label or Pips default names ("router", "router:<system>/<model>"), else None."""
    if not isinstance(label, str):
        return None
    if label == "router":
        return {"mode": "router"}
    match = re.fullmatch(r"router:([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)/(.+)", label)
    if match and _MODEL_ID.fullmatch(match.group(2)) and "://" not in match.group(2):
        return {"mode": "router", "system": match.group(1), "model": match.group(2)}
    return None


def pips_router_default(config) -> dict | None:
    """Settings -> Models -> Pips with DGC Router on: every Pip on Default runs on any Pip system (``pips_model``
    "router") or on one system and model ("router:<system>/<model>"). None when the Pips default is not one, and when
    the Router is off: then Default follows DGC again, exactly as with no Pips default."""
    value = config.get("pips_model", "")
    choice = router_choice_of(value.strip() if isinstance(value, str) else "")
    if choice is None:
        return None
    try:
        from . import router as router_mod
        return choice if router_mod.enabled(config) else None
    except Exception:                                   # noqa: BLE001 -- a stub config: no Router
        return None


def default_model(config) -> str:
    """The model a Pip on Default runs on DGC's own connection: the Pips default, else DGC's own model. Raw."""
    return pips_default(config) or str(config.get("model", "") or "")


def is_subscription(config, choice) -> bool:
    """Whether this choice runs on a subscription CLI: chosen for the Pip, or Default following DGC's one (only when
    no Pips default model is set: that one is a model on DGC's own connection)."""
    return choice.get("mode") == "subscription" or (
        choice.get("mode") == "default" and not pips_default(config)
        and bool(str(config.get("subscription_engine", "") or "").strip()))


def _connection(config):
    base = config.get("base_url", "")
    mode = config.get("api_mode", "auto")
    if (not isinstance(base, str) or not 1 <= len(base) <= 2048
            or base != base.strip() or any(ord(c) < 33 or ord(c) == 127 for c in base)):
        raise RegistryError("unsupported_model", "Configure an HTTP(S) model endpoint without credentials or query data in DGC settings.")
    try:
        url = urlsplit(base)
        valid = (url.scheme in {"http", "https"} and bool(url.hostname)
                 and not url.username and not url.password and not url.query and not url.fragment)
        _ = url.port  # Reject malformed/out-of-range ports before contacting the endpoint.
    except ValueError:
        valid = False
    if not valid:
        raise RegistryError("unsupported_model", "Configure an HTTP(S) model endpoint without credentials or query data in DGC settings.")
    if not isinstance(mode, str) or mode not in _API_MODES:
        raise RegistryError("unsupported_model", "Choose a supported native API mode in DGC settings.")
    return base.rstrip("/"), mode


def _safe_model_id(value, secrets):
    model = _model_id(value)
    if redact_text(model, secrets) != model:
        raise RegistryError("invalid_model", "A configured model identifier contains sensitive data and cannot be used by Pips.")
    return model


def _catalog(config) -> list[str]:
    base, mode = _connection(config)
    secrets = secret_values(config)
    model = _safe_model_id(config.get("model", ""), secrets)
    try:
        client = LLMClient(base_url=base, api_key=config.get("api_key", ""), model=model,
                           api_mode=mode, read_timeout=10,
                           provider_capabilities=config.get("provider_capabilities", {}))
        values = client.list_models()
    except Exception:
        # Provider errors can contain request headers, credentials, or complete bodies.
        # Never return/log their text or attach their exception chain to a public error.
        raise RegistryError("model_catalog_unavailable", "Could not load models from the configured connection. Check DGC's connection and retry, or choose DGC default.") from None
    if not isinstance(values, list):
        raise RegistryError("invalid_model_catalog", "The configured connection returned an invalid model catalog.")
    if len(values) > MAX_CATALOG_MODELS:
        raise RegistryError("model_catalog_limit", "The configured connection returned too many models. Choose DGC default or use a smaller model catalog.")
    models, seen, byte_count = [], set(), 0
    families = getattr(client, "_listed_ollama_families", {}) if client.api_mode == "ollama" else {}
    for value in values:
        # Invalid entries fail the entire response, rather than implying that a partial
        # or redacted ID is an executable route offered by the configured connection.
        try:
            model = _safe_model_id(value, secrets)
        except RegistryError:
            raise RegistryError("invalid_model_catalog", "The configured connection returned an invalid or sensitive model identifier.") from None
        byte_count += len(model)  # IDs are ASCII, checked above, including duplicates.
        if byte_count > MAX_CATALOG_BYTES:
            raise RegistryError("model_catalog_limit", "The configured model catalog exceeds the discovery budget. Choose DGC default or use a smaller catalog.")
        family = families.get(model, "") if isinstance(families, dict) else ""
        # Ollama's /api/tags includes the architecture even when the display
        # name is an alias. Other compatible hosts expose no standard chat
        # capability field, so use only narrow, known embedding/rerank names.
        if _embedding_only(model, family):
            continue
        if model not in seen:
            seen.add(model)
            models.append(model)
    return sorted(models)


_EMBEDDING_NAME = re.compile(r"(?:^|[/_.:-])(?:embed(?:ding|dings)?|rerank|bge|gte|minilm|e5)(?:$|[/_.:-])", re.I)


def _embedding_only(model: str, family: str = "") -> bool:
    return bool(_EMBEDDING_NAME.search(model) or _EMBEDDING_NAME.search(family)
                or family in {"bert", "nomic-bert"})


def model_window(config, model) -> int | None:
    """The context window DGC knows for ``model``, in the range a Pip takes, or None when it knows none.

    The window the user chose for this model before (``model_context_sizes``), else DGC's recommended window for
    its family (config.MODEL_CATALOG): what DGC itself would start the model with, never a provider's maximum, and
    found without contacting the endpoint, so listing many models costs nothing."""
    from .config import context_for_model, remembered_context_size
    from .pip_chat_options import CONTEXT_MAX, CONTEXT_MIN
    window = remembered_context_size(config, model) or context_for_model(model)
    if type(window) is not int or window <= 0:
        return None
    return min(CONTEXT_MAX, max(CONTEXT_MIN, window))


def list_pip_models(config) -> dict:
    """Return bounded genuine model IDs; discovery failure is never a fallback model.

    API 55: ``subscriptions`` lists the CLIs a Personal Pip can run on here (installed, signed in, held to DGC's
    tools), and ``default_engine`` says which one Default follows when DGC's default is a subscription.
    ``default_model`` is what Default runs: the Pips default model (``pips_model``) when one is set, else DGC's own.
    API 66: ``pips_model`` is the Pips default as set ("" when Pips follow DGC), and each model carries
    ``context_window`` when DGC knows one for it (model_window)."""
    from . import pip_brain
    result = {"default_model": "", "pips_model": "", "models": [], "connection": "configured",
              "subscriptions": pip_brain.offered()}
    try:
        router = router_systems(config)                 # API 70: "DGC Router (any Pip system)" or one of these
    except Exception:                                   # noqa: BLE001 -- the list never fails for the Router's sake
        router = {"enabled": False}
    if router.get("enabled"):                           # off, the list is exactly what it was
        routed = pips_router_default(config)
        if routed is not None:                          # every Pip on Default runs on the Router (Settings)
            router["pips_default"] = router_label(routed)
        result["router"] = router
    chosen = pips_default(config)
    if chosen:
        try:
            result["pips_model"] = _safe_model_id(chosen, secret_values(config))
        except RegistryError:
            pass                  # not a usable model id: `error` below says why when Default would run it
    engine = "" if chosen else str(config.get("subscription_engine", "") or "").strip().lower()
    if engine:
        reason = pip_brain.available(engine)
        result["default_engine"] = {"engine": engine, "name": pip_brain.name(engine), "available": not reason,
                                    **({"reason": reason} if reason else {})}
    try:
        _connection(config)
        if not engine:
            result["default_model"] = _safe_model_id(default_model(config), secret_values(config))
        catalog = _catalog(config)
        for model in catalog:
            row = {"id": model, "name": model}
            window = model_window(config, model)
            if window is not None:
                row["context_window"] = window
            if len(result["models"]) >= MAX_LIST_MODELS:
                result["truncated"] = True
                break
            candidate = {**result, "models": [*result["models"], row], "truncated": True}
            if len(json.dumps(candidate, ensure_ascii=True, separators=(",", ":")).encode()) > MAX_LIST_BYTES:
                result["truncated"] = True
                break
            result["models"].append(row)
    except RegistryError as exc:
        result["error"] = {"code": exc.code, "message": str(exc)}
    return result


# ---- DGC Router (API 70) ------------------------------------------------------------------------------------------
def router_label(choice) -> str:
    """The run's pinned ``model`` for a Router choice: "router", or "router:<system>/<model>"."""
    return "router" if not choice.get("system") else f"router:{choice['system']}/{choice['model']}"


def router_pin(config, choice) -> dict:
    """Check a Router choice against the settings now and return the run's pin ({"system", "model"}, "" for any).
    The worker itself is leased when the run leaves the Pip queue (pips._router_admit)."""
    from . import router as router_mod
    if not router_mod.enabled(config):
        raise RegistryError("router_off", "DGC Router is off. Turn it on in Settings, or choose another model for this Pip.")
    system, model = choice.get("system", ""), choice.get("model", "")
    try:
        rows = router_mod.ROUTER.candidates(config, "pips", system=system, model=model, include_offline=True)
    except router_mod.RouteRefused as exc:
        raise RegistryError("model_not_available", str(exc)) from None
    if not rows:
        where = f"{system} doesn't offer {model} for Pips" if system else "no DGC Router system has the Pips job"
        raise RegistryError("model_not_available", f"DGC Router: {where}. Give a system the Pips job in Settings, or "
                                                   "choose another model for this Pip.")
    return {"system": system, "model": model}


def router_window(config, pin) -> int | None:
    """The smallest fixed context a Router run with this pin ({"system", "model"}, "" for any) may be given: that
    system's and model's, or the least of every Pip system's. None when the Router has none for it now."""
    from . import router as router_mod
    try:
        rows = router_mod.ROUTER.candidates(config, "pips", system=str(pin.get("system") or ""),
                                            model=str(pin.get("model") or ""), include_offline=True)
    except router_mod.RouteRefused:
        return None
    sizes = [int(entry["context"]) for _system, entry, _facts in rows if isinstance(entry.get("context"), int)]
    return min(sizes) if sizes else None


def router_systems(config) -> dict:
    """What list_pip_models says about DGC Router (API 70): whether it is on, and the systems with the Pips job,
    their models and each one's context. No address, no key."""
    from . import router as router_mod
    block = router_mod.settings(config)
    systems = []
    for item in block.get("systems") or []:
        if not item.get("enabled", True) or "pips" not in item.get("jobs", []):
            continue
        models = [{"name": m["name"], "context_window": m["context"]} for m in item["models"] if m.get("use") is not False]
        if models:
            systems.append({"id": item["id"], "name": item["name"], "models": models,
                            "online": not router_mod.ROUTER.offline(item["id"])})
    return {"enabled": bool(block.get("enabled")), "systems": systems}


def resolve_model_choice(config, choice) -> str:
    """Pin the current default (the Pips default model, else DGC's own), or require an explicit ID in the current
    genuine catalog. A subscription (chosen, or DGC's default) must be one a Pip can run on here; it pins as its
    engine (pip_brain.label)."""
    choice = validate_model_choice(choice)
    if choice["mode"] == "default":
        choice = pips_router_default(config) or choice
    if choice["mode"] == "router":
        router_pin(config, choice)
        return router_label(choice)
    if is_subscription(config, choice):
        from .pip_brain import label, route
        return label(route(config, choice))
    _connection(config)
    if choice["mode"] == "default":
        return _safe_model_id(default_model(config), secret_values(config))
    model = _safe_model_id(choice["model"], secret_values(config))
    if model not in _catalog(config):
        raise RegistryError("model_not_available", "The selected model is not offered by the configured connection. Refresh models and choose an available model or DGC default.")
    return model


def validate_pinned_connection(config, settings) -> None:
    """Reject connection changes while preserving the run's already selected model.

    Credential rotation on the same endpoint is allowed. Do not check the current
    default model or rediscover models here: execution uses the immutable run pin.
    """
    if isinstance(settings, dict) and "router" in settings:
        # A DGC Router run: its system is chosen when it leaves the queue, so only the Router itself must still be on.
        pin = settings.get("router")
        if (not isinstance(pin, dict) or set(pin) != {"system", "model"}
                or not all(isinstance(pin[k], str) for k in ("system", "model"))):
            raise RegistryError("model_changed", "The run has no valid pinned model connection. Start a new run.")
        from . import router as router_mod
        if not router_mod.enabled(config):
            raise RegistryError("model_changed", "DGC Router was turned off after this run was queued. Turn it back on, "
                                                 "or start a new run on another model.")
        return
    if isinstance(settings, dict) and "brain" in settings:
        # A subscription run: its CLI must still be here and signed in; DGC's own connection doesn't matter.
        from .pip_brain import available, validate_route
        try:
            brain = validate_route(settings["brain"])
        except RegistryError:
            raise RegistryError("model_changed", "The run has no valid pinned model connection. Start a new run.") from None
        reason = available(brain["engine"])
        if reason:
            raise RegistryError("model_changed", reason)
        return
    current = _connection(config)
    if not isinstance(settings, dict):
        raise RegistryError("model_changed", "The run has no valid pinned model connection. Start a new run.")
    try:
        pinned = _connection(settings)
        _model_id(settings.get("model"))
    except RegistryError:
        raise RegistryError("model_changed", "The run has no valid pinned model connection. Start a new run.") from None
    if current != pinned:
        raise RegistryError("model_changed", "The configured endpoint or API mode changed after enqueue. Start a new run with the current connection.")
