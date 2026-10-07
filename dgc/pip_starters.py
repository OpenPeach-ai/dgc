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

_WATCH_GOAL = (
    "Read the reviewed page and tell me what changed since your previous result: items added or removed, "
    "prices, dates, availability or wording that matters. Quote the changed lines. If nothing changed, "
    "say so in one sentence. If the page could not be read, say that plainly instead of guessing.")
_MARKET_GOAL = (
    "Before the market opens on weekdays, brief me on the companies and markets in the reviewed reads: "
    "notable news, results, guidance and anything scheduled for today, each with its source. Facts from the "
    "reads only: no predictions, no price targets and no advice to buy, sell or hold. Leave out what your "
    "previous result already said. Under 200 words, most important first.")
_RESEARCH_GOAL = (
    "Once a week, from the reviewed searches, tell me what is new on these topics: the three to five most "
    "significant items, each with one line on why it matters and its source. Skip anything older than a "
    "week or already in your previous result. Say plainly when the searches found nothing new.")
_RELEASE_GOAL = (
    "Check the reviewed release or changelog pages and tell me about any release since your previous "
    "result: the version, its date and the changes that would affect me, breaking changes, security fixes "
    "and deprecations first. If there is no new release, say so in one sentence.")
_NEWS_GOAL = (
    "From the reviewed searches, give me today's most important news on these topics in at most five "
    "bullets, each with its source and one line on why it matters. Leave out anything already in your "
    "previous result. If nothing new happened, say so in one sentence.")

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
        "web_example": "https://example.com/status\nsearch: weather in your city today",
    },
    "page_watch": {
        "title": "Watch a page for changes",
        "summary": "A Personal Pip reads a page each day and tells you what changed since last time.",
        "pip_type": "scout", "scope": "personal", "work_kind": "personal_task",
        "name": "Page watch", "goal": _WATCH_GOAL, "when": "daily",
        "default_time": "09:00", "params": ("time", "timezone", "web_reads"), "requires_web_reads": True,
        "web_example": "https://example.com/pricing",
    },
    "market_brief": {
        "title": "Market brief",
        "summary": "Before the market opens on weekdays, the news on companies you name, with sources. It never trades or advises.",
        "pip_type": "lens", "scope": "personal", "work_kind": "personal_task",
        "name": "Market brief", "goal": _MARKET_GOAL, "when": "weekdays",
        "default_time": "08:30", "params": ("time", "timezone", "web_reads"), "requires_web_reads": True,
        "web_example": "search: Reliance Industries news today\nsearch: Infosys results",
    },
    "research_digest": {
        "title": "Weekly research digest",
        "summary": "Every Monday, what is new on the topics you follow, with sources and no repeats.",
        "pip_type": "lens", "scope": "personal", "work_kind": "personal_task",
        "name": "Research digest", "goal": _RESEARCH_GOAL, "when": "weekly",
        "default_time": "09:00", "params": ("time", "timezone", "web_reads"), "requires_web_reads": True,
        "web_example": "search: new open-weight language models\nsearch: local inference hardware",
    },
    "release_watch": {
        "title": "Release watch",
        "summary": "Each day, new releases of the tools you depend on, breaking changes first.",
        "pip_type": "scout", "scope": "personal", "work_kind": "personal_task",
        "name": "Release watch", "goal": _RELEASE_GOAL, "when": "daily",
        "default_time": "10:00", "params": ("time", "timezone", "web_reads"), "requires_web_reads": True,
        "web_example": "https://github.com/ollama/ollama/releases",
    },
    "daily_news": {
        "title": "News on a topic",
        "summary": "Each morning, the most important news on topics you choose, in five bullets at most.",
        "pip_type": "lens", "scope": "personal", "work_kind": "personal_task",
        "name": "Daily news", "goal": _NEWS_GOAL, "when": "daily",
        "default_time": "08:00", "params": ("time", "timezone", "web_reads"), "requires_web_reads": True,
        "web_example": "search: India monsoon forecast\nsearch: EV charging policy",
    },
}


def catalog() -> list[dict]:
    """What the Pips view and the CLI offer, in a fixed order."""
    return [{"id": key, **{k: spec[k] for k in ("title", "summary", "pip_type", "scope", "name", "when")},
             "default_time": spec.get("default_time"), "params": list(spec["params"]),
             "web_example": spec.get("web_example")}
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
    from .pip_schedules import canonical_zone
    try:
        value = canonical_zone(value)
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
        elif when == "weekly":
            hour, minute = (int(part) for part in time.split(":"))
            request["schedule"] = {"type": "cron", "cron": f"{minute} {hour} * * 1", "timezone": zone}
        else:
            hour, minute = (int(part) for part in time.split(":"))
            request["schedule"] = {"type": "cron", "cron": f"{minute} {hour} * * 1-5", "timezone": zone}
    if "web_reads" in spec["params"] and params.get("web_reads"):
        reads = params["web_reads"]
        if not isinstance(reads, list):
            _fail("List the pages and searches to read.")
        request["web_plan"] = {"schema_version": 1, "reads": reads}
    elif spec.get("requires_web_reads"):
        _fail("Add at least one page or search for this starter: it has nothing to read otherwise.")
    return request
