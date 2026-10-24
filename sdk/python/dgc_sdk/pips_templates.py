"""Pip templates in code (Pips API 64): your app declares its Personal Pips, and ``session.pips.ensure`` makes the real
Pips match on each deploy, safely.

A :class:`PipTemplate` is plain, checked data. DGC checks it again, and against your registered apps, when it is
ensured: what the SDK can't know here (which tools exist, which are changes, which move money, which models the
connection offers) is DGC's to refuse.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from .errors import DGCConfigError

PipLevel = Literal["ask", "approve", "full"]
KEY = re.compile(r"[a-z0-9-]{1,40}\Z")
APP_TOOL = re.compile(r"app:[a-z0-9-]{1,40}/[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
APP_NAME = re.compile(r"[a-z0-9-]{1,40}\Z")
EVENT_NAME = re.compile(r"[a-z0-9_.-]{1,64}\Z")
COMPUTER = "computer"
LEVELS = ("ask", "approve", "full")
MAX_TOOLS = 64
MAX_ROUTINES = 10


def _text(value: Any, limit: int, what: str, *, line: bool = False) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise DGCConfigError(f"a Pip template's {what} is text of 1 to {limit} characters")
    if line and any(ord(c) < 32 for c in value):
        raise DGCConfigError(f"a Pip template's {what} is one line")
    return value.strip()


def _when(value: Any) -> dict[str, Any]:
    """A routine's when: {"kind": "schedule", "schedule": {...}} or {"kind": "app", "app", "event"}, or the short
    forms {"schedule": {...}} and {"app", "event"}. DGC checks a schedule's fields."""
    if isinstance(value, Mapping) and "kind" not in value:
        if set(value) == {"schedule"}:
            value = {"kind": "schedule", **value}
        elif set(value) == {"app", "event"}:
            value = {"kind": "app", **value}
    if not isinstance(value, Mapping) or value.get("kind") not in ("schedule", "app"):
        raise DGCConfigError('a routine\'s when is {"kind": "schedule", "schedule": {...}} or {"kind": "app", "app": '
                             '"shop", "event": "order.created"}')
    if value["kind"] == "app":
        if (set(value) != {"kind", "app", "event"} or not isinstance(value["app"], str) or not APP_NAME.fullmatch(value["app"])
                or not isinstance(value["event"], str) or not EVENT_NAME.fullmatch(value["event"])):
            raise DGCConfigError("a routine on your app's event names the app (as registered) and the event (1 to 64 "
                                 "lowercase letters, digits, dots, hyphens or underscores, such as order.created)")
        return {"kind": "app", "app": value["app"], "event": value["event"]}
    if set(value) != {"kind", "schedule"} or not isinstance(value["schedule"], Mapping):
        raise DGCConfigError('a timed routine\'s when is {"kind": "schedule", "schedule": {"type": "cron", "cron": '
                             '"30 9 * * 1-5", "timezone": "Asia/Kolkata"}} (or daily, interval, once)')
    return {"kind": "schedule", "schedule": json.loads(json.dumps(dict(value["schedule"]), allow_nan=False))}


def _routine(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {"title", "prompt", "when"}:
        raise DGCConfigError("each routine of a Pip template is {title, prompt, when}")
    return {"title": " ".join(_text(value["title"], 160, "routine's title", line=True).split()),
            "prompt": _text(value["prompt"], 4000, "routine's prompt"), "when": _when(value["when"])}


@dataclass(frozen=True)
class PipTemplate:
    """One Personal Pip as your app declares it (Pips API 64).

    ``key`` is its stable id (1 to 40 lowercase letters, digits or hyphens), unique in the profile: the same key is
    always the same Pip. ``tools`` are your apps' tools as ``"app:<name>/<tool>"`` (a Pip made from a template uses
    only these of your apps' tools) and ``"computer"`` for its own computer. ``routines`` are ``{title, prompt,
    when}``, on a schedule or on your app's event, known by their title. ``always_allow`` lists change tools in
    ``tools`` it may run without asking: never a read, never one that moves money. ``model`` is a model id from
    ``list_pip_models``, or None for DGC's own default; on a server it must be an API-key or self-hosted model.
    ``level`` is how much it asks: ``"ask"`` (the default), ``"approve"`` or ``"full"``."""

    key: str
    name: str
    instructions: str
    model: str | None = None
    level: PipLevel = "ask"
    tools: Sequence[str] = ()
    routines: Sequence[Mapping[str, Any]] = ()
    always_allow: Sequence[str] = field(default=())

    def __post_init__(self) -> None:
        wire = template_wire(self, _checking=True)
        for name in ("tools", "always_allow"):
            object.__setattr__(self, name, tuple(wire[name]))
        object.__setattr__(self, "routines", tuple(wire["routines"]))
        object.__setattr__(self, "name", wire["name"])
        object.__setattr__(self, "instructions", wire["instructions"])

    def to_wire(self) -> dict[str, Any]:
        """The template as ensure_pip_template sends it."""
        return template_wire(self)


def template_wire(value: Any, *, _checking: bool = False) -> dict[str, Any]:
    """ensure_pip_template's ``template``: a PipTemplate, or the same shape as a plain dict."""
    if isinstance(value, PipTemplate) and not _checking:
        return json.loads(json.dumps({"key": value.key, "name": value.name, "instructions": value.instructions,
                                      **({"model": value.model} if value.model is not None else {}),
                                      "level": value.level, "tools": list(value.tools),
                                      "routines": [dict(r) for r in value.routines],
                                      "always_allow": list(value.always_allow)}))
    if isinstance(value, PipTemplate):
        fields = {"key": value.key, "name": value.name, "instructions": value.instructions, "model": value.model,
                  "level": value.level, "tools": value.tools, "routines": value.routines, "always_allow": value.always_allow}
    elif isinstance(value, Mapping):
        unknown = set(value) - {"key", "name", "instructions", "model", "level", "tools", "routines", "always_allow"}
        if unknown:
            raise DGCConfigError(f"a Pip template has no field {sorted(unknown)[0]}")
        fields = dict(value)
    else:
        raise DGCConfigError("a Pip template is a PipTemplate, or a dict of the same fields")
    key = fields.get("key")
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise DGCConfigError("a Pip template's key is 1 to 40 lowercase letters, digits or hyphens, such as dunning")
    name = _text(fields.get("name"), 120, "name", line=True)
    instructions = _text(fields.get("instructions"), 4000, "instructions")
    model = fields.get("model")
    if model is not None and (not isinstance(model, str) or not model.strip() or len(model) > 200
                              or any(ord(c) <= 32 or ord(c) == 127 for c in model)):
        raise DGCConfigError("a Pip template's model is a model id from list_pip_models, or None for DGC's default")
    level = fields.get("level", "ask")
    if level not in LEVELS:
        raise DGCConfigError('a Pip template\'s level is "ask", "approve" or "full"')
    tools = fields.get("tools", ())
    if isinstance(tools, (str, bytes)) or not isinstance(tools, Sequence) or len(tools) > MAX_TOOLS or any(
            not isinstance(t, str) or not (t == COMPUTER or APP_TOOL.fullmatch(t)) for t in tools):
        raise DGCConfigError(f"a Pip template's tools are up to {MAX_TOOLS} of \"app:<name>/<tool>\" (your app's "
                             "tools, such as app:shop/find_unpaid_orders) and \"computer\". Gmail, Calendar, plugins "
                             "and connectors are connected by a person in DGC, never by a template")
    if len(set(tools)) != len(tools):
        raise DGCConfigError("a Pip template names each tool once")
    always = fields.get("always_allow", ())
    if (isinstance(always, (str, bytes)) or not isinstance(always, Sequence)
            or any(not isinstance(t, str) or not APP_TOOL.fullmatch(t) for t in always) or len(set(always)) != len(always)):
        raise DGCConfigError("a Pip template's always_allow names change tools of your app once each, as "
                             "\"app:<name>/<tool>\"")
    missing = [t for t in always if t not in tools]
    if missing:
        raise DGCConfigError(f"{missing[0]} is in always_allow but not in tools: a Pip is only allowed a tool it has")
    routines = fields.get("routines", ())
    if isinstance(routines, (str, bytes)) or not isinstance(routines, Sequence) or len(routines) > MAX_ROUTINES:
        raise DGCConfigError(f"a Pip template has at most {MAX_ROUTINES} routines")
    shaped = [_routine(r) for r in routines]
    titles = [r["title"] for r in shaped]
    if len(set(titles)) != len(titles):
        raise DGCConfigError("each routine of a Pip template has its own title: a routine is known by it")
    out: dict[str, Any] = {"key": key, "name": name, "instructions": instructions, "level": level,
                           "tools": list(tools), "routines": shaped, "always_allow": list(always)}
    if model is not None:
        out["model"] = model.strip()
    return out


def templates_wire(templates: Any) -> list[dict[str, Any]]:
    """ensure_all's templates, checked together before anything is sent: each key once."""
    if isinstance(templates, (str, bytes, Mapping, PipTemplate)) or not isinstance(templates, Sequence):
        raise DGCConfigError("ensure_all takes a list of PipTemplate values")
    if len(templates) > 100:
        raise DGCConfigError("ensure_all takes at most 100 templates")
    wires = [template_wire(t) for t in templates]
    keys = [w["key"] for w in wires]
    if len(set(keys)) != len(keys):
        raise DGCConfigError(f"two templates share the key {next(k for k in keys if keys.count(k) > 1)}: a key is one Pip")
    return wires
