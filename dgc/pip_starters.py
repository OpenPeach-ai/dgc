"""Starter Pips: common jobs as ready-made setup cards that the user reviews and approves.

A starter never creates or runs a Pip. It fills the same setup request the main chat's
`pips_setup` tool would, from a fixed template plus a few checked choices (time, time zone,
branch, web reads), and saves it as a pending setup card. Approving the card is the user's
decision, in the Pips view or with `dgc pips setup accept`.
"""
from __future__ import annotations

import re
import subprocess
from zoneinfo import ZoneInfo

from .workspace_registry import RegistryError

_COMMIT_REVIEW_GOAL = (
    "After each new commit, review the changed committed source for bugs that matter: logic errors, "
    "broken edge cases, unsafe error handling, resource leaks and regressions. Report only concrete "
    "issues with exact source evidence and why they matter. Do not report style, naming or anything "
    "already reported and unchanged. If nothing new needs attention, say so in one sentence.")
_SECURITY_GOAL = (
    "Review the committed source for potential security issues: trust boundaries, input validation, "
    "authentication and authorization, secrets handling, injection, path traversal and unsafe "
    "deserialization. Report only issues with exact source evidence and a concrete impact. If "
    "nothing new needs attention, say so in one sentence.")
_BRIEF_GOAL = (
    "Each weekday morning, write me a short brief from the reviewed reads: what changed, what needs "
    "my attention today and anything unusual. Keep it under 150 words, lead with what matters most, "
    "and say plainly when a read failed or nothing notable happened.")

STARTERS = {
    "commit_review": {
        "title": "Review each commit",
        "summary": "Rook reviews the committed source after each new commit to your branch.",
        "pip_type": "rook", "scope": "project", "work_kind": "source_review",
        "name": "Commit reviewer", "goal": _COMMIT_REVIEW_GOAL, "when": "commit",
        "params": ("branch",),
    },
    "nightly_security": {
        "title": "Nightly security review",
        "summary": "Lock reviews the committed source for security issues every night.",
        "pip_type": "lock", "scope": "project", "work_kind": "source_review",
        "name": "Nightly security review", "goal": _SECURITY_GOAL, "when": "daily",
        "default_time": "02:00", "params": ("branch", "time", "timezone"),
    },
    "morning_brief": {
        "title": "Morning brief",
        "summary": "A Personal Pip writes a short brief each weekday morning from pages and searches you choose.",
        "pip_type": "lens", "scope": "personal", "work_kind": "personal_task",
        "name": "Morning brief", "goal": _BRIEF_GOAL, "when": "weekdays",
        "default_time": "07:30", "params": ("time", "timezone", "web_reads"),
    },
}


def catalog() -> list[dict]:
    """What the Pips view and the CLI offer, in a fixed order."""
    return [{"id": key, **{k: spec[k] for k in ("title", "summary", "pip_type", "scope", "name", "when")},
             "default_time": spec.get("default_time"), "params": list(spec["params"])}
            for key, spec in STARTERS.items()]


def _fail(message, code="invalid_starter"):
    raise RegistryError(code, message)


def _time(value, default):
    value = default if value in (None, "") else value
    if not isinstance(value, str) or not re.fullmatch(r"([01][0-9]|2[0-3]):[0-5][0-9]", value):
        _fail("Choose a time as HH:MM on a 24-hour clock.")
    return value


def _timezone(value):
    if not isinstance(value, str) or not value or len(value) > 64:
        _fail("Choose a time zone such as Asia/Kolkata or Europe/London.")
    try:
        ZoneInfo(value)
    except (ValueError, KeyError, OSError):
        _fail(f"{value} is not a time zone this computer knows.")
    return value


def local_timezone() -> str | None:
    """This computer's IANA zone from /etc/localtime (Linux and macOS), or None when unknown."""
    import os
    try:
        target = os.path.realpath("/etc/localtime")
    except OSError:
        return None
    marker = "zoneinfo/"
    name = target.split(marker, 1)[1] if marker in target else ""
    try:
        if name:
            ZoneInfo(name)
            return name
    except (ValueError, KeyError, OSError):
        pass
    return None


def current_branch(root) -> str:
    """The checked-out branch, or HEAD when detached or unknown."""
    try:
        out = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "symbolic-ref", "--quiet", "--short", "HEAD"],
                             cwd=str(root), capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return "HEAD"
    name = out.stdout.strip()
    return name if out.returncode == 0 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", name) and ".." not in name else "HEAD"


def build(starter_id, params, *, project_root, request_key) -> dict:
    """The setup request for `starter_id`, ready for pip_setup.propose. Refuses unknown choices."""
    spec = STARTERS.get(starter_id) if isinstance(starter_id, str) else None
    if spec is None:
        _fail("Choose one of the starter Pips.", "unknown_starter")
    params = dict(params or {})
    unknown = set(params) - set(spec["params"])
    if unknown:
        _fail("That starter does not take " + ", ".join(sorted(unknown)) + ".")
    request = {"target_root": str(project_root), "name": spec["name"], "goal": spec["goal"],
               "pip_type": spec["pip_type"], "work_kind": spec["work_kind"], "scope": spec["scope"],
               "run_now": False, "request_key": request_key,
               "reason": f"Created from the {spec['title']} starter."}
    if spec["scope"] == "project":
        request["source_ref"] = params.get("branch") or current_branch(project_root)
    when = spec["when"]
    if when == "commit":
        request["schedule"] = None
        request["event_trigger"] = {"events": ["commit_changed"], "minimum_minutes": 5}
    else:
        time = _time(params.get("time"), spec["default_time"])
        zone = _timezone(params.get("timezone"))
        if when == "daily":
            request["schedule"] = {"type": "daily", "time": time, "timezone": zone}
        else:
            hour, minute = (int(part) for part in time.split(":"))
            request["schedule"] = {"type": "cron", "cron": f"{minute} {hour} * * 1-5", "timezone": zone}
    if "web_reads" in spec["params"] and params.get("web_reads"):
        reads = params["web_reads"]
        if not isinstance(reads, list):
            _fail("List the pages and searches to read.")
        request["web_plan"] = {"schema_version": 1, "reads": reads}
    return request
