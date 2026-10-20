"""Per-Pip model choices: the user's existing native model connection, or (API 55) their own subscription CLI.

Choices never contain a provider, endpoint, credential or permission change. Discovery
uses DGC's provider layer; these helpers bound accepted catalog data and public output.
The provider layer owns HTTP timeouts/body parsing (its compatible/Ollama catalog paths
do not currently impose a response-byte ceiling), so this is not an allocation limit.

A subscription choice names only the engine (``{"mode": "subscription", "engine": "codex"}``); "Same as DGC"
follows DGC's own subscription default when it has one. Either runs a Personal Pip's turns on that CLI with DGC's
tools alone (pip_brain).
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
    raise RegistryError("invalid_model_choice", "A Pip model choice accepts only mode and, for an explicit choice, model or engine.")


def is_subscription(config, choice) -> bool:
    """Whether this choice runs on a subscription CLI: chosen for the Pip, or "Same as DGC" following one."""
    return choice.get("mode") == "subscription" or (
        choice.get("mode") == "default" and bool(str(config.get("subscription_engine", "") or "").strip()))


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
        if model not in seen:
            seen.add(model)
            models.append(model)
    return sorted(models)


def list_pip_models(config) -> dict:
    """Return bounded genuine model IDs; discovery failure is never a fallback model.

    API 55: ``subscriptions`` lists the CLIs a Personal Pip can run on here (installed, signed in, held to DGC's
    tools), and ``default_engine`` says which one "Same as DGC" follows when DGC's default is a subscription."""
    from . import pip_brain
    result = {"default_model": "", "models": [], "connection": "configured", "subscriptions": pip_brain.offered()}
    engine = str(config.get("subscription_engine", "") or "").strip().lower()
    if engine:
        reason = pip_brain.available(engine)
        result["default_engine"] = {"engine": engine, "name": pip_brain.name(engine), "available": not reason,
                                    **({"reason": reason} if reason else {})}
    try:
        _connection(config)
        if not engine:
            result["default_model"] = _safe_model_id(config.get("model", ""), secret_values(config))
        catalog = _catalog(config)
        for model in catalog:
            row = {"id": model, "name": model}
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


def resolve_model_choice(config, choice) -> str:
    """Pin the current default, or require an explicit ID in the current genuine catalog. A subscription (chosen,
    or DGC's default) must be one a Pip can run on here; it pins as its engine (pip_brain.label)."""
    choice = validate_model_choice(choice)
    if is_subscription(config, choice):
        from .pip_brain import label, route
        return label(route(config, choice))
    _connection(config)
    if choice["mode"] == "default":
        return _safe_model_id(config.get("model", ""), secret_values(config))
    model = _safe_model_id(choice["model"], secret_values(config))
    if model not in _catalog(config):
        raise RegistryError("model_not_available", "The selected model is not offered by the configured connection. Refresh models and choose an available model or DGC default.")
    return model


def validate_pinned_connection(config, settings) -> None:
    """Reject connection changes while preserving the run's already selected model.

    Credential rotation on the same endpoint is allowed. Do not check the current
    default model or rediscover models here: execution uses the immutable run pin.
    """
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
