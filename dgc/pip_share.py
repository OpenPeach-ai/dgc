"""Share a Pip: export its job as a small file, and import one as a setup card to review.

The file carries the job, not the Pip's life: name, goal, type, scope, schedule or trigger,
model choice, the reviewed web reads (Personal) or source branch (project), and a Pulse's
reviewed commands. It never carries what belongs to the person or the machine: connected-app
reads (they name your accounts), memory, history, findings, results or IDs. The file says what
was left out. Importing never creates a working Pip by itself: it becomes the same pending
setup card a chat or a starter makes, which the user reviews and approves.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

FORMAT = "dgc-pip"
VERSION = 1
MAX_BYTES = 24 * 1024          # fits a nested Pips request (32 KiB) with room to spare
_PIP_KEYS = {"name", "goal", "pip_type", "scope", "schedule", "event_trigger", "model_choice",
             "web_plan", "source_ref", "verification_plan", "live_plan"}
_TYPES = {"scout", "lens", "rook", "lock", "quill", "pulse"}
ALWAYS_LEFT_OUT = "Memory, history, findings and results stay with the original Pip."


def _fail(message, code="invalid_pip_file"):
    raise RegistryError(code, message)


def export(store, pip_id) -> dict:
    """The shareable document for one Pip's current job."""
    job = store._job(pip_id)
    personal = job.get("source_policy") == {"mode": "personal"}
    if job["pip_type"] not in _TYPES:
        _fail("Patch Pips cannot be shared yet: their reviewed edits belong to one project.", "unsupported_share")
    pip = {"name": job["name"], "goal": job["goal"], "pip_type": job["pip_type"],
           "scope": "personal" if personal else "project", "schedule": job.get("schedule")}
    if job.get("event_trigger") is not None:
        pip["event_trigger"] = job["event_trigger"]
    if job.get("model_choice") not in (None, {"mode": "default"}):
        pip["model_choice"] = job["model_choice"]   # a named model; the default stays the importer's own
    if personal and job.get("web_plan") is not None:
        pip["web_plan"] = job["web_plan"]
    if not personal:
        pip["source_ref"] = job.get("source_ref") or "HEAD"
    if job["pip_type"] == "pulse" and job.get("verification_plan") is not None:
        pip["verification_plan"] = job["verification_plan"]
    if job["pip_type"] == "pulse" and job.get("live_plan") is not None:
        pip["live_plan"] = job["live_plan"]          # a live-data Pip's read-only commands, reviewed again on import
    left_out = []
    if job.get("app_plan") is not None:
        left_out.append("Reads from connected apps: they name your accounts. Choose accounts again after importing.")
    if job.get("github_plan") is not None:
        left_out.append("GitHub reads: add them again in the imported Pip's Job tab.")
    left_out.append(ALWAYS_LEFT_OUT)
    return {"format": FORMAT, "version": VERSION, "pip": pip, "left_out": left_out}


def dumps(document) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def parse(text) -> dict:
    """A shared Pip file's text, checked for shape and size; never trusted as instructions."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_BYTES:
        _fail(f"A shared Pip file is at most {MAX_BYTES // 1024} KiB.")
    try:
        document = json.loads(text)
    except ValueError:
        _fail("This is not a shared Pip file (it is not JSON).")
    return check(document)


def check(document) -> dict:
    if (not isinstance(document, dict) or document.get("format") != FORMAT or document.get("version") != VERSION
            or set(document) - {"format", "version", "pip", "left_out"} or not isinstance(document.get("pip"), dict)):
        _fail("This is not a shared Pip file DGC can read (format dgc-pip, version 1).")
    pip = document["pip"]
    if set(pip) - _PIP_KEYS or not {"name", "goal", "pip_type", "scope", "schedule"} <= set(pip):
        _fail("The shared Pip file has missing or unknown fields.")
    if pip["pip_type"] not in _TYPES or pip["scope"] not in ("project", "personal"):
        _fail("The shared Pip file names a kind of Pip this DGC cannot create.")
    if pip["scope"] == "personal" and pip["pip_type"] == "pulse":
        _fail("A Pulse Pip belongs to a project.")
    left = document.get("left_out", [])
    if not isinstance(left, list) or len(left) > 8 or not all(isinstance(item, str) and len(item) <= 300 for item in left):
        _fail("The shared Pip file's notes are invalid.")
    return document


def setup_request(document, *, project_root, request_key) -> dict:
    """The setup card request for an imported Pip, checked by the same rules as any setup card."""
    from .pip_setup import validate_request
    pip = check(document)["pip"]
    personal = pip["scope"] == "personal"
    if personal:
        work_kind = "personal_task"
    elif pip["pip_type"] == "pulse" and "live_plan" in pip:
        work_kind = "live_data"
    elif pip["pip_type"] == "pulse":
        network = (pip.get("verification_plan") or {}).get("action", {}).get("network")
        work_kind = "app_smoke_test" if network == "loopback_http_v1" else "command_verification"
    elif pip["pip_type"] == "quill":
        work_kind = "documentation_draft"
    else:
        work_kind = "source_review"
    request = {"target_root": str(project_root), "name": pip["name"], "goal": pip["goal"], "pip_type": pip["pip_type"],
               "work_kind": work_kind, "scope": pip["scope"], "schedule": pip["schedule"], "run_now": False,
               "request_key": request_key, "reason": "Imported from a shared Pip file."}
    for key in ("event_trigger", "model_choice", "web_plan", "verification_plan", "live_plan"):
        if key in pip:
            request[key] = pip[key]
    if not personal:
        request["source_ref"] = pip.get("source_ref") or "HEAD"
    try:
        return validate_request(request)
    except RegistryError as exc:
        raise RegistryError("invalid_pip_file", "The shared Pip cannot become a setup card here: " + str(exc)) from None
