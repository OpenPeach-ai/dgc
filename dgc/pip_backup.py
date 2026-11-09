"""A backup model for Pips (Pips package 6, 0.52; Pips API 76).

When a Pip's own model doesn't answer (a usage limit, a model or host that is unreachable, a subscription CLI that is
signed out), its turn carries on with the backup model, says so once, and the next run tries its own model again.

- **One backup for every Pip**, set in Pips settings (``get_pips_backup`` / ``set_pips_backup {model}``, registry
  metadata ``pips_backup_model``, so the editor, the CLI and the runner all read the same one): a model on DGC's own
  connection, or "" for none (the default: nothing changes until you set
  one). **Each Pip may override it** on its page (``get_pip_backup`` / ``set_pip_backup {pip_id, model}``, metadata
  ``pip_backup:<pip>``): ``null`` follows Pips settings, "" is no backup for this Pip, a model is that model.
- **Only a model DGC itself runs.** The backup is on DGC's own connection (its address and key, read when the run
  starts), never a subscription CLI: a Project Pip can't run on one, and a CLI that is out is what it stands in for.
- **The worker switches, the controller decides what is said.** The backup travels in the worker's start payload, not
  the run's manifest (the manifest pins the Pip's own model; the backup is read from today's settings). A model turn
  that fails retries on it (Agent's own fallback); a subscription turn that failed before it said or did anything runs
  again on it. The worker says which model it switched to; the controller believes it only if it is the backup it gave.
- **Said once.** The first reply that used the backup in an outage carries one line under it ("Its own model didn't
  answer; X did"), kept for that run; the next replies on the backup say nothing. When a run finishes on the Pip's own
  model again, the outage is over, and a later one says so again.
"""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError, utc_now

WIDE = "pips_backup_model"           # metadata: the backup for every Pip, JSON {model, at, by} ("" = none)
KEY = "pip_backup:"                  # metadata: a Pip's own choice, JSON {model: str} ("" = none)
OUTAGE = "pip_backup_on:"            # metadata: this Pip's own model is out and the backup answered; JSON {since, model}
RUN = "pip_backup_run:"              # metadata: a run the backup answered; JSON {model, line}
LOCAL = ("editor-user", "local-console")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}\Z")
LINE = "Its own model didn't answer; {model} did"


def _model(value, field="model") -> str:
    if not isinstance(value, str):
        raise RegistryError("invalid_request", "Choose a model by its name, or none.")
    value = value.strip()
    if value and (not _MODEL.fullmatch(value) or "://" in value):
        raise RegistryError("invalid_request", f"{field} must be empty or a model's name, like qwen3:8b.")
    return value


# --------------------------------------------------------------------------- the settings

def pips_wide(registry) -> str:
    """The backup every Pip follows unless it chose its own: a model on DGC's own connection, or ""."""
    try:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (WIDE,)).fetchone()
        return _model(json.loads(row["value"]).get("model") or "") if row else ""
    except Exception:                      # noqa: BLE001 - unreadable is none
        return ""


def set_pips_wide(registry, value, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "The backup model is set on this computer only.")
    model = _model(value)
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                            (WIDE, json.dumps({"model": model, "at": utc_now(), "by": actor})))
    return {"model": model}


def own_choice(registry, pip_id):
    """This Pip's own choice: None follows Pips settings, "" is none, else a model."""
    try:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (KEY + str(pip_id),)).fetchone()
        if row is None:
            return None
        value = json.loads(row["value"]).get("model")
        return _model(value) if isinstance(value, str) else None
    except Exception:                      # noqa: BLE001 - unreadable follows Pips settings
        return None


def listing(registry, pip_id) -> dict:
    """get_pip_backup: {pip_id, model (its own choice: null follows), follows (the Pips settings backup), backup (what
    its runs use now, "" none)}."""
    _pip(registry, pip_id)
    own = own_choice(registry, pip_id)
    wide = pips_wide(registry)
    return {"pip_id": pip_id, "model": own, "follows": wide, "backup": wide if own is None else own}


def set_own(registry, pip_id, value, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "A Pip's backup model is set on this computer only.")
    _pip(registry, pip_id)
    with registry.transaction():
        if value is None:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (KEY + pip_id,))
        else:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                (KEY + pip_id, json.dumps({"model": _model(value), "at": utc_now(), "by": actor})))
    return listing(registry, pip_id)


def _pip(registry, pip_id):
    row = registry.db.execute("SELECT id FROM pips WHERE id=?", (pip_id,)).fetchone() if isinstance(pip_id, str) else None
    if row is None:
        raise RegistryError("not_found", "That Pip doesn't exist.")


def chosen(registry, pip_id) -> str:
    """The backup this Pip's runs use now: its own choice, else Pips settings'. "" is none."""
    own = own_choice(registry, pip_id)
    return pips_wide(registry) if own is None else own


# --------------------------------------------------------------------------- a run

def for_run(registry, config, row, manifest) -> dict | None:
    """What the worker may switch to: {model, base_url, api_mode, api_key} on DGC's own connection, or None (no backup,
    the same model the run already has, a Router run, or a connection DGC can't use)."""
    model = chosen(registry, row["pip_id"])
    settings = manifest.get("model_settings") if isinstance(manifest.get("model_settings"), dict) else {}
    if not model or "router" in settings:
        return None                        # none set; DGC Router moves a run to another system itself
    base = str(config.get("base_url", "") or "").rstrip("/")
    if not base.startswith(("http://", "https://")):
        return None
    if "brain" not in settings and settings.get("model") == model and settings.get("base_url", "").rstrip("/") == base:
        return None                        # its own model is the backup: nothing to switch to
    return {"model": model, "base_url": base, "api_mode": str(config.get("api_mode", "auto") or "auto"),
            "api_key": str(config.get("api_key", "") or "")}


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
