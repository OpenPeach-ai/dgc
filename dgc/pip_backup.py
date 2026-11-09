"""A fallback model for Pips (Pips package 6, 0.52; Pips API 76; chosen in a Pip's model picker since D14).

When a Pip's own model doesn't answer (a usage limit, a model or host that is unreachable, a subscription CLI that is
signed out), its turn carries on with its fallback model, says so once, and the next run tries its own model again.

- **Each Pip has its own**, chosen with the ⋯ beside a model in its model picker (``get_pip_backup`` /
  ``set_pip_backup {pip_id, model, provider?}``, registry metadata ``pip_backup:<pip>``): one model on DGC's own
  connection (``provider`` "") or on one of your saved providers (``provider_<32 hex>``), or none (``model`` "").
  Choosing one for a Pip never changes another Pip's.
- **New Pips start with the last one you chose** (``get_pips_backup`` / ``set_pips_backup``, metadata
  ``pips_backup_model``): copied into a Pip when it is made, never followed afterwards.
- **Only a model DGC itself runs.** Never a subscription CLI or the Router: a CLI that is out is what it stands in for.
- **The worker switches, the controller decides what is said.** The fallback travels in the worker's start payload,
  not the run's manifest. A model turn that fails retries on it (Agent's own fallback); a subscription turn that failed
  before it said or did anything runs again on it. The worker says which model it switched to; the controller
  believes it only if it is the fallback it gave, and from then the Pip's chat says the fallback is answering.
- **Said once.** The first reply that used the fallback in an outage carries one line under it ("Its own model didn't
  answer; X did"), kept for that run; the next replies on the fallback say nothing. When a run finishes on the Pip's own
  model again, the outage is over, and a later one says so again.
"""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError, utc_now

WIDE = "pips_backup_model"           # metadata: the fallback new Pips start with, JSON {provider, model, at, by}
KEY = "pip_backup:"                  # metadata: a Pip's fallback, JSON {provider, model} (model "" = none)
OUTAGE = "pip_backup_on:"            # metadata: this Pip's own model is out and the fallback answers; JSON {since, model}
RUN = "pip_backup_run:"              # metadata: a run the fallback answered; JSON {model, line}
LOCAL = ("editor-user", "local-console")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}\Z")
_PROVIDER = re.compile(r"provider_[a-f0-9]{32}\Z")
LINE = "Its own model didn't answer; {model} did"
NONE = {"provider": "", "model": ""}


def _model(value, field="model") -> str:
    if not isinstance(value, str):
        raise RegistryError("invalid_request", "Choose a model by its name, or none.")
    value = value.strip()
    if value and (not _MODEL.fullmatch(value) or "://" in value):
        raise RegistryError("invalid_request", f"{field} must be empty or a model's name, like qwen3:8b.")
    return value


def _choice(model, provider="") -> dict:
    """{provider, model}: a model on DGC's own connection (provider ""), or on a saved provider; model "" is none."""
    model = _model("" if model is None else model)
    if provider is None:
        provider = ""
    if not isinstance(provider, str) or (provider and not _PROVIDER.fullmatch(provider)):
        raise RegistryError("invalid_request", "provider must be empty (DGC's own connection) or a saved provider.")
    return {"provider": provider if model else "", "model": model}


def _read(registry, key) -> dict | None:
    try:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        if row is None:
            return None
        value = json.loads(row["value"])
        return _choice(value.get("model") or "", value.get("provider") or "")
    except Exception:                      # noqa: BLE001 - unreadable is none
        return None


# --------------------------------------------------------------------------- the choices

def pips_wide(registry) -> dict:
    """The fallback new Pips start with: {provider, model}, model "" for none."""
    return _read(registry, WIDE) or dict(NONE)


def set_pips_wide(registry, value, actor, provider="") -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "The fallback model is set on this computer only.")
    choice = _choice(value, provider)
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                            (WIDE, json.dumps({**choice, "at": utc_now(), "by": actor})))
    return choice


def start_new(db, pip_id) -> None:
    """A new Pip starts with the last fallback you chose (in the caller's transaction)."""
    row = db.execute("SELECT value FROM metadata WHERE key=?", (WIDE,)).fetchone()
    if row is None:
        return
    try:
        value = json.loads(row[0])
        choice = _choice(value.get("model") or "", value.get("provider") or "")
    except Exception:                      # noqa: BLE001 - unreadable starts with none
        return
    if choice["model"]:
        db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                   (KEY + str(pip_id), json.dumps({**choice, "at": utc_now(), "by": "new-pip"})))


def listing(registry, pip_id) -> dict:
    """get_pip_backup: {pip_id, provider, model ("" none), on (while its own model is out: {since, model})}."""
    _pip(registry, pip_id)
    choice = chosen(registry, pip_id)
    return {"pip_id": pip_id, **choice, **({"on": out(registry, pip_id)} if out(registry, pip_id) else {})}


def set_own(registry, pip_id, value, actor, provider="") -> dict:
    """A Pip's fallback; null or "" is none. Also what new Pips start with from now on."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "A Pip's fallback model is set on this computer only.")
    _pip(registry, pip_id)
    choice = _choice(value, provider)
    with registry.transaction():
        if choice["model"]:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                (KEY + pip_id, json.dumps({**choice, "at": utc_now(), "by": actor})))
        else:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (KEY + pip_id,))
            registry.db.execute("DELETE FROM metadata WHERE key=?", (OUTAGE + pip_id,))
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                            (WIDE, json.dumps({**choice, "at": utc_now(), "by": actor})))
    return listing(registry, pip_id)


def _pip(registry, pip_id):
    row = registry.db.execute("SELECT id FROM pips WHERE id=?", (pip_id,)).fetchone() if isinstance(pip_id, str) else None
    if row is None:
        raise RegistryError("not_found", "That Pip doesn't exist.")


def chosen(registry, pip_id) -> dict:
    """The fallback this Pip's runs use now: {provider, model}, model "" for none."""
    return _read(registry, KEY + str(pip_id)) or dict(NONE)


def for_run(registry, config, row, manifest) -> dict | None:
    """What the worker may switch to: {model, provider, base_url, api_mode, api_key}, or None (no fallback, the same
    model the run already has, a Router run, a removed provider, or a connection DGC can't use)."""
    choice = chosen(registry, row["pip_id"])
    model = choice["model"]
    settings = manifest.get("model_settings") if isinstance(manifest.get("model_settings"), dict) else {}
    if not model or "router" in settings:
        return None                        # none set; DGC Router moves a run to another system itself
    if "brain" not in settings and settings.get("model") == model and str(settings.get("provider") or "") == choice["provider"]:
        return None                        # its own model is the fallback: nothing to switch to
    if choice["provider"]:
        from .pip_models import provider_view
        try:
            config = provider_view(config, choice)
        except RegistryError:
            return None                    # that provider was removed: no fallback, the run is as before
    base = str(config.get("base_url", "") or "").rstrip("/")
    if not base.startswith(("http://", "https://")):
        return None
    if not choice["provider"] and "brain" not in settings and "provider" not in settings \
            and settings.get("model") == model and str(settings.get("base_url", "") or "").rstrip("/") == base:
        return None
    return {"model": model, "provider": choice["provider"], "base_url": base,
            "api_mode": str(config.get("api_mode", "auto") or "auto"), "api_key": str(config.get("api_key", "") or "")}


def used(registry, row, backup, model) -> None:
    """The worker switched to `model` in this run. Believed only when it is the backup it was given. The first run of an
    outage keeps its line; the rest of the outage says nothing more."""
    if not backup or model != backup.get("model"):
        return
    pip_id = row["pip_id"]
    with registry.transaction():
        outage = registry.db.execute("SELECT value FROM metadata WHERE key=?", (OUTAGE + pip_id,)).fetchone()
        line = "" if outage is not None else LINE.format(model=model)[:80]
        if outage is None:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                (OUTAGE + pip_id, json.dumps({"since": utc_now(), "model": model})))
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                            (RUN + row["id"], json.dumps({"model": model, "line": line})))
        registry.event(row["workspace_id"], "pip_backup_used", pip_id=pip_id, run_id=row["id"],
                       payload={"model": model, "said": bool(line)})


def answered_itself(registry, row) -> None:
    """A run finished on the Pip's own model: an outage, if there was one, is over."""
    with registry.transaction():
        registry.db.execute("DELETE FROM metadata WHERE key=?", (OUTAGE + row["pip_id"],))


def line_for(db, run_id) -> str:
    """The one line under a reply the backup answered, the first of its outage only: "" otherwise."""
    try:
        row = db.execute("SELECT value FROM metadata WHERE key=?", (RUN + str(run_id),)).fetchone()
        return str(json.loads(row[0]).get("line") or "")[:80] if row else ""
    except Exception:                      # noqa: BLE001 - nothing to say
        return ""


def out(registry, pip_id) -> dict | None:
    """While this Pip's own model is out and the backup answers: {since, model}."""
    try:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (OUTAGE + str(pip_id),)).fetchone()
        return json.loads(row[0]) if row else None
    except Exception:                      # noqa: BLE001
        return None
