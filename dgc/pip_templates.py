"""Pip templates in code (Pips API 64): Pips for SDK apps, part 5.

Your app declares its Personal Pips in code, a template each, and on every deploy ``ensure_pip_template`` (the SDKs'
``pips.ensure``) makes the real Pip match it, safely. A template is plain data:

- ``key``: a stable id (1 to 40 of a-z 0-9 -), unique in the profile. It is kept on the Pip (``pip_templates``), so the
  same key always means the same Pip, whatever its name;
- ``name`` and ``instructions`` (the Pip's job, what DGC calls its goal);
- ``model``: a model id from ``list_pip_models``, or none for DGC's own default. Never a personal Claude Code or Codex
  plan; and on a server (a runner started with ``--server``) DGC's default must not be one either (part 4's guardrail);
- ``level``: how much it asks, ``ask`` (the default here), ``approve`` or ``full``;
- ``tools``: your apps' tools, ``app:<name>/<tool>``, and ``computer`` for its own computer;
- ``routines``: ``{title, prompt, when}``, ``when`` a schedule or one of your app's events (part 3);
- ``always_allow``: change tools in ``tools`` it may run without asking. Never a read, never a tool that moves money.

**What ``tools`` means.** Every Personal Pip may use every registered app (part 1). A Pip made from a template may use
only the app tools its template lists: its runs are given those, and a call to any other is refused. Every other Pip
keeps every registered app, as before. A tool the app doesn't have now (not registered, or its update still waits for
acceptance) is left out and said (``unavailable``); the next ensure after it exists adds it.

**Bringing a Pip to its template.** A field the template changes is classified against what the Pip may do now:

- *narrowing or neutral*, applied at once: its name, instructions and model; a tool, a routine or an Always allow
  removed; a lower level; a routine's prompt, or its time; a new routine on a schedule; a new read tool;
- *widening*, saved as one change that waits for a person (``pip_template_changes``): a new change tool, its own
  computer, a higher level, a new Always allow, and a routine that newly runs on an app event. The person accepts it on
  the Pip's page in DGC (``decide_pip_template_change``); ``accept_widening`` applies it in the same call, and the app
  takes responsibility. A tool that moves money is never Always allowed, either way.

A new Pip is made as its template says, except its Always allow, which only a person has given so far: it waits like
any widening unless ``accept_widening``. The same template twice is ``unchanged`` the second time. A widening the
person turned down is not asked again while the template asks for exactly it (``declined``).

**Your changes in DGC.** What ensure last applied is kept (``applied``). A field that differs from it now was changed
by a person in DGC: it is reported as a conflict and left as they set it, unless ``overwrite_user_changes``. A Pip
someone paused, or archived, stays so; ensure resumes only a Pip it paused itself (``prune_pip_templates``).

**Where it is kept.** Two tables of the Pips database, made the first time a template is ensured (the registry's schema
stays as it is, so an older DGC still opens it): ``pip_templates`` (the key, and what was last applied) and
``pip_template_changes`` (each widening that waited, and how it was decided).
"""
from __future__ import annotations

import hashlib
import json
import re

from .workspace_registry import RegistryError, identifier

KEY = re.compile(r"[a-z0-9-]{1,40}\Z")
APP_TOOL = re.compile(r"app:([a-z0-9-]{1,40})/([A-Za-z][A-Za-z0-9_-]{0,63})\Z")
CHANGE = re.compile(r"tmplchange_[a-f0-9]{32}\Z")
COMPUTER = "computer"
LEVELS = ("ask", "approve", "full")
DEFAULT_LEVEL = "ask"
MAX_TOOLS = 64
MAX_ROUTINES = 10
MAX_KEEP = 100
MAX_MODEL = 200
PIP_TYPE = "rook"
LOCAL = ("editor-user", "local-console")
FIELDS = frozenset({"key", "name", "instructions", "model", "level", "tools", "routines", "always_allow"})

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_templates (
 pip_id TEXT PRIMARY KEY REFERENCES pips(id),
 key TEXT NOT NULL UNIQUE CHECK(length(key) BETWEEN 1 AND 40),
 applied TEXT NOT NULL CHECK(length(CAST(applied AS BLOB)) <= 131072),
 pruned INTEGER NOT NULL DEFAULT 0 CHECK(pruned IN (0,1)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pip_template_changes (
 id TEXT PRIMARY KEY,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 key TEXT NOT NULL,
 items TEXT NOT NULL CHECK(length(CAST(items AS BLOB)) <= 65536),
 digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting','accepted','declined','withdrawn')),
 created_at TEXT NOT NULL,
 decided_at TEXT,
 decided_by TEXT
);
CREATE INDEX IF NOT EXISTS pip_template_changes_pip ON pip_template_changes(pip_id, status, created_at);
"""


# --------------------------------------------------------------------------------------------- where it is kept

def has_tables(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_template_changes'").fetchone() is not None


def ensure_tables(db) -> None:
    """Made the first time a template is ensured, inside that call's transaction."""
    if not has_tables(db):
        from .workspace_registry import _execute_schema
        _execute_schema(db, SCHEMA)


def allowed_tools(db, pip_id) -> frozenset | None:
    """The app tools a Pip made from a template may use (``app:<name>/<tool>``), or None for every other Pip: every
    registered app, as before. Read by each run's tools (pip_sdk_apps). An unreadable record allows none."""
    try:
        if not has_tables(db):
            return None
        row = db.execute("SELECT applied FROM pip_templates WHERE pip_id=?", (pip_id,)).fetchone()
    except Exception:                   # noqa: BLE001 - a registry that can't say gives a template Pip nothing
        return frozenset()
    if row is None:
        return None
    try:
        tools = json.loads(row[0]).get("tools") or []
        return frozenset(t for t in tools if isinstance(t, str) and APP_TOOL.fullmatch(t))
    except (TypeError, ValueError, AttributeError):
        return frozenset()


def _local(actor) -> None:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only your code on this computer keeps Pips from a template.")


# --------------------------------------------------------------------------------------------- what a template is

def _bad(words: str):
    raise RegistryError("invalid_template", words)


def _line(value, limit: int, what: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value or len(value) > limit:
        _bad(f"A template's {what} is text of 1 to {limit} characters.")
    return value.strip()


def split_tool(name: str) -> tuple[str, str]:
    match = APP_TOOL.fullmatch(name)
    return match.group(1), match.group(2)


def validate(value) -> dict:
    """A template's one checked, normalized shape (what is kept and compared)."""
    from . import pip_routines
    if not isinstance(value, dict) or set(value) - FIELDS or not {"key", "name", "instructions"} <= set(value):
        _bad("A template has key, name and instructions, and may have model, level, tools, routines and always_allow.")
    key = value["key"]
    if not isinstance(key, str) or not KEY.fullmatch(key):
        _bad("A template's key is 1 to 40 lowercase letters, digits or hyphens, such as dunning.")
    name = _line(value["name"], 120, "name")
    if any(ord(c) < 32 for c in name):
        _bad("A template's name is one line.")
    instructions = _line(value["instructions"], 4000, "instructions")
    model = value.get("model")
    if model is not None and (not isinstance(model, str) or not model.strip() or len(model) > MAX_MODEL
                              or any(ord(c) <= 32 or ord(c) == 127 for c in model)):
        _bad("A template's model is a model id from list_pip_models, such as deepseek-v4.1-flash:cloud, or none for "
             "DGC's own default.")
    level = value.get("level", DEFAULT_LEVEL)
    if level not in LEVELS:
        _bad("A template's level is ask, approve or full.")
    tools = value.get("tools", [])
    if (not isinstance(tools, list) or len(tools) > MAX_TOOLS
            or any(not isinstance(t, str) or not (t == COMPUTER or APP_TOOL.fullmatch(t)) for t in tools)):
        _bad(f"A template's tools are up to {MAX_TOOLS} of your app's tools as app:<name>/<tool>, such as "
             "app:shop/find_unpaid_orders, and computer for its own computer. A Pip's other connections (Gmail, "
             "Calendar, plugins, connectors) are connected by a person in DGC, never by a template.")
    if len(set(tools)) != len(tools):
        _bad("A template names each tool once.")
    always = value.get("always_allow", [])
    if (not isinstance(always, list) or any(not isinstance(t, str) or not APP_TOOL.fullmatch(t) for t in always)
            or len(set(always)) != len(always)):
        _bad("A template's always_allow names change tools of your app once each, as app:<name>/<tool>.")
    missing = [t for t in always if t not in tools]
    if missing:
        _bad(f"{missing[0]} is in always_allow but not in tools: a Pip can only be allowed a tool it has.")
    routines = value.get("routines", [])
    if not isinstance(routines, list) or len(routines) > MAX_ROUTINES:
        _bad(f"A template has at most {MAX_ROUTINES} routines.")
    shaped = []
    for routine in routines:
        if not isinstance(routine, dict) or set(routine) != {"title", "prompt", "when"}:
            _bad("Each routine is {title, prompt, when}.")
        try:
            title = pip_routines._text(routine["title"], 160, "its name")
            prompt = pip_routines._text(routine["prompt"], 4000, "what to do")
            when = pip_routines.validate_trigger(routine["when"])
        except RegistryError as exc:
            _bad(f"A routine: {exc}")
        if when["kind"] not in ("schedule", "app"):
            _bad("A template's routine runs on a schedule or on one of your app's events. A Gmail or Calendar "
                 "routine needs that app connected to the Pip by a person: add it in DGC.")
        shaped.append({"title": title, "prompt": prompt, "when": when})
    titles = [r["title"] for r in shaped]
    if len(set(titles)) != len(titles):
        _bad("Each routine of a template has its own title: a routine is known by it.")
    return {"key": key, "name": name, "instructions": instructions, "model": model.strip() if model else None,
            "level": level, "tools": sorted(tools), "routines": sorted(shaped, key=lambda r: r["title"]),
            "always_allow": sorted(always)}


def model_choice(template: dict) -> dict:
    return {"mode": "default"} if template["model"] is None else {"mode": "model", "model": template["model"]}


def check_model(config, registry, choice) -> None:
    """The template's model, before anything is kept: one the model connection offers (it may ask it), and on a server
    never a personal Claude Code or Codex plan (pip_server's guardrail)."""
    from . import pip_models, pip_server
    if pip_server.is_server_runner(registry) and pip_models.is_subscription(config, choice):
        raise RegistryError(pip_server.SUBSCRIPTION_REFUSED, (
            "On a server, a Pip runs on an API key or a self-hosted model, and DGC's own model here is a personal "
            "Claude Code or Codex plan. Give the template a model (one from list_pip_models), or set DGC's own model "
            "to an API key or a self-hosted model."))
    pip_models.resolve_model_choice(config.clone_for_root(config.project_root), choice)


# --------------------------------------------------------------------------------------------- words

def _app_words(name: str) -> tuple[str, str]:
    """(the app, the tool) as a person reads them: ("Shop app", "create_dispatch")."""
    from .pip_sdk_apps import display
    app, tool = split_tool(name)
    return display(app), tool


def item_words(item: dict) -> str:
    from . import pip_levels, pip_routines
    kind = item["kind"]
    if kind == "tool":
        app, tool = _app_words(item["tool"])
        return f"Use {tool} in {app}, a change"
    if kind == "computer":
        return "Have its own computer: a browser, a Terminal and files"
    if kind == "level":
        return f"Ask less: {pip_levels.name(item['to'])} (now {pip_levels.name(item['from'])})"
    if kind == "always_allow":
        app, tool = _app_words(item["tool"])
        return f"Run {tool} in {app} without asking"
    return f"A routine, {item['title']}: {pip_routines.label(item['when'])}"


def _change_words(name: str, items: list) -> str:
    return f"Your code asks to let {name} do more: " + "; ".join(item_words(i) for i in items) + "."


# --------------------------------------------------------------------------------------------- the Pip now

def _template_row(db, *, key=None, pip_id=None):
    if key is not None:
        return db.execute("SELECT * FROM pip_templates WHERE key=?", (key,)).fetchone()
    return db.execute("SELECT * FROM pip_templates WHERE pip_id=?", (pip_id,)).fetchone()


def _app_tool(name: str):
    """(app, tool definition) as registered now, or (app or None, None)."""
    from . import pip_sdk_apps
    app_name, tool = split_tool(name)
    try:
        app = pip_sdk_apps.get(app_name)
    except RegistryError:
        return None, None
    return app, (pip_sdk_apps.tool_of(app, tool) if app is not None else None)


def _unavailable(name: str) -> dict:
    from . import pip_sdk_apps
    app_name, tool = split_tool(name)
    app, found = _app_tool(name)
    if app is None:
        words = f"{pip_sdk_apps.display(app_name)} isn't registered with DGC: register it (register_app), then ensure again."
    elif isinstance(app.get("pending"), dict) and any(t.get("name") == tool for t in app["pending"].get("tools") or []):
        words = (f"{pip_sdk_apps.display(app_name)}'s update that adds {tool} waits for a person in DGC (Pips settings, "
                 "Apps): once it is accepted, ensure again.")
    else:
        words = f"{pip_sdk_apps.display(app_name)} has no tool named {tool}: add it with update_app, then ensure again."
    return {"tool": name, "words": words}


def _digests(name: str) -> tuple[str, str]:
    from . import pip_sdk_apps
    app, found = _app_tool(name)
    return pip_sdk_apps.connection_digest(app), pip_sdk_apps.schema_digest(found)


def _live_grant(registry, pip_id, name: str) -> str | None:
    """The id of an Always allow that covers this app tool now (its app and tool as registered now), or None."""
    from . import pip_action_grants
    app, found = _app_tool(name)
    if found is None:
        return None
    connection, schema = _digests(name)
    for grant in pip_action_grants.list_grants(registry, pip_id):
        if (grant["kind"] == "connector_call" and grant["server"] == "app:" + app["name"] and grant["tool"] == found["name"]
                and grant["connection_digest"] == connection and grant["schema_digest"] == schema
                and grant["account"] == "connection_managed"):
            return grant["id"]
    return None


def _routine_rows(registry, pip_id) -> dict:
    return {r["id"]: r for r in registry.db.execute("SELECT * FROM pip_routines WHERE pip_id=?", (pip_id,)).fetchall()}


def _routine_now(row) -> dict | None:
    if row is None or row["status"] not in ("on", "off"):
        return None
    return {"title": row["title"], "prompt": row["prompt"], "when": json.loads(row["trigger"]), "status": row["status"]}


# --------------------------------------------------------------------------------------------- changing the Pip

def _redefine(store, pip, changes: dict, actor, key) -> None:
    """A new job version with these definition fields (name, goal, model_choice, computer_plan), in the caller's
    transaction, as accepting a reviewed change writes one."""
    from . import pip_approvals
    from .pip_event_triggers import reset_trigger
    from .pip_schedules import reset_schedule
    from .pips import _definition, _json
    registry, db = store.registry, store.db
    keys = ("name", "goal", "source_ref", "schedule", "model_choice", "adaptation_policy", "event_trigger",
            "source_policy", "verification_plan", "app_plan", "web_plan", "github_plan", "computer_plan", "live_plan")
    merged = {k: changes.get(k, pip.get(k)) for k in keys}
    merged["pip_type"] = pip["pip_type"]
    definition = _definition(**merged)
    version, now = pip["current_version"] + 1, registry.clock()
    db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)",
               (pip["id"], version, _json(definition), actor, f"From your code (template {key})", now))
    db.execute("UPDATE pips SET current_version=?,updated_at=? WHERE id=?", (version, now, pip["id"]))
    reset_schedule(registry, pip["id"], version, definition["schedule"], now)
    reset_trigger(registry, pip["id"], version, definition["event_trigger"], now)
    for other in db.execute("SELECT * FROM pip_approvals WHERE pip_id=? AND status='pending' AND expected_version<?",
                            (pip["id"], version)).fetchall():
        pip_approvals.resolve(registry, other, "superseded", actor, now)
    db.execute("UPDATE pip_proposals SET status='superseded' WHERE pip_id=? AND status='proposed' AND expected_version<?",
               (pip["id"], version))
    registry.event(pip["workspace_id"], "pip_job_updated", pip_id=pip["id"],
                   payload={"actor": actor, "version": version, "template": key})
    pip.update({k: definition.get(k) for k in ("name", "goal", "model_choice", "computer_plan")},
               current_version=version)


def _add_routine(store, pip_id, routine: dict) -> str:
    from . import pip_routines
    return pip_routines.add(store, pip_id, routine["title"], routine["prompt"], routine["when"])["id"]


def _apply_item(store, pip, item: dict, applied: dict, actor, key, definition: dict) -> None:
    """One widening, applied now (a person accepted it, or the app passed accept_widening)."""
    from . import pip_action_grants, pip_levels, pip_routines, pip_sdk_apps
    registry, kind = store.registry, item["kind"]
    if kind == "tool":
        app, found = _app_tool(item["tool"])
        if found is None or found["kind"] != "change" or pip_sdk_apps.schema_digest(found) != item["schema_digest"]:
            raise RegistryError("template_changed", f"{item['tool']} changed since this was asked: ensure the template "
                                                    "again, and look at what it asks then.")
        applied["tools"] = sorted(set(applied["tools"]) | {item["tool"]})
    elif kind == "computer":
        definition["computer_plan"] = {"schema_version": 1}
        applied["tools"] = sorted(set(applied["tools"]) | {COMPUTER})
    elif kind == "level":
        if LEVELS.index(pip_levels.level(registry, pip["id"])) < LEVELS.index(item["to"]):
            pip_levels.write_level(registry, pip["id"], item["to"], actor)
        applied["level"] = pip_levels.level(registry, pip["id"])
    elif kind == "always_allow":
        app, found = _app_tool(item["tool"])
        connection, schema = _digests(item["tool"]) if found is not None else ("", "")
        if found is None or (connection, schema) != (item["connection_digest"], item["schema_digest"]):
            raise RegistryError("template_changed", f"{item['tool']} changed since this was asked: ensure the template "
                                                    "again, and look at what it asks then.")
        old = applied["always_allow"].get(item["tool"])
        if old and old != _live_grant(registry, pip["id"], item["tool"]):
            pip_action_grants.delete_grant(registry, pip["id"], old)
        grant = _live_grant(registry, pip["id"], item["tool"]) or pip_action_grants.grant_app_tool(
            registry, pip["id"], pip["workspace_id"], "app:" + app["name"], found, connection, schema, actor,
            template=key)["id"]
        applied["always_allow"] = {**applied["always_allow"], item["tool"]: grant}
    elif kind == "routine":
        from .pip_sdk_app_events import require_app
        require_app(item["when"]["app"])
        row = _routine_rows(registry, pip["id"]).get(item.get("routine_id") or "")
        if row is not None and row["status"] in ("on", "off"):
            pip_routines.update(store, pip["id"], row["id"], {"title": item["title"], "prompt": item["prompt"],
                                                               "trigger": item["when"], "status": "on"})
            routine_id = row["id"]
        else:
            routine_id = _add_routine(store, pip["id"], item)
        applied["routines"] = {**applied["routines"], item["title"]: {
            "id": routine_id, "prompt": item["prompt"], "when": item["when"], "status": "on"}}


def _apply_items(store, pip, items, applied, actor, key) -> list:
    definition: dict = {}
    for item in items:
        _apply_item(store, pip, item, applied, actor, key, definition)
    if definition:
        _redefine(store, pip, definition, actor, key)
    return [{"field": _FIELD[i["kind"]], "item": i.get("tool") or i.get("title") or (COMPUTER if i["kind"] == "computer" else None),
             "words": item_words(i) + "."} for i in items]


_FIELD = {"tool": "tools", "computer": "tools", "level": "level", "always_allow": "always_allow", "routine": "routines"}


def _digest(pip_id, key, items) -> str:
    return hashlib.sha256(json.dumps({"pip_id": pip_id, "key": key, "items": items}, sort_keys=True,
                                     separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def _sorted_items(items) -> list:
    order = {"tool": 0, "computer": 1, "always_allow": 2, "level": 3, "routine": 4}
    return sorted(items, key=lambda i: (order[i["kind"]], i.get("tool") or i.get("title") or ""))


def _save(registry, row_pip_id, key, applied, *, created=False, pruned=0) -> None:
    now = registry.clock()
    text = json.dumps(applied, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    if created:
        registry.db.execute("INSERT INTO pip_templates(pip_id,key,applied,pruned,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                            (row_pip_id, key, text, pruned, now, now))
    else:
        registry.db.execute("UPDATE pip_templates SET applied=?,pruned=?,updated_at=? WHERE pip_id=?",
                            (text, pruned, now, row_pip_id))


# --------------------------------------------------------------------------------------------- the change that waits

def _change_view(row, pip_name: str) -> dict:
    items = json.loads(row["items"])
    return {"id": row["id"], "pip_id": row["pip_id"], "key": row["key"], "status": row["status"], "digest": row["digest"],
            "items": [{**i, "words": item_words(i)} for i in items], "words": _change_words(pip_name, items),
            "created_at": row["created_at"], "decided_at": row["decided_at"], "decided_by": row["decided_by"]}


def _waiting_row(db, pip_id):
    return db.execute("SELECT * FROM pip_template_changes WHERE pip_id=? AND status='waiting' ORDER BY created_at DESC "
                      "LIMIT 1", (pip_id,)).fetchone()


def _settle(registry, pip, key, items, actor) -> dict:
    """The one change that waits for this Pip: kept when the template asks for the same, replaced when it asks for
    more or other, withdrawn when it asks for nothing, and not asked again when a person turned exactly it down."""
    db, now = registry.db, registry.clock()
    existing = _waiting_row(db, pip["id"])
    out = {"waiting": [], "declined": [], "withdrew": False, "new": False}
    if not items:
        if existing is not None:
            db.execute("UPDATE pip_template_changes SET status='withdrawn',decided_at=?,decided_by=? WHERE id=?",
                       (now, actor, existing["id"]))
            out["withdrew"] = True
        return out
    digest = _digest(pip["id"], key, items)
    if existing is not None and existing["digest"] == digest:
        out["waiting"] = [existing["id"]]
        return out
    if existing is not None:
        db.execute("UPDATE pip_template_changes SET status='withdrawn',decided_at=?,decided_by=? WHERE id=?",
                   (now, actor, existing["id"]))
        out["withdrew"] = True
    declined = db.execute("SELECT id FROM pip_template_changes WHERE pip_id=? AND digest=? AND status='declined' "
                          "ORDER BY created_at DESC LIMIT 1", (pip["id"], digest)).fetchone()
    if declined is not None:
        out["declined"] = [declined["id"]]
        return out
    change_id = identifier("tmplchange")
    db.execute("INSERT INTO pip_template_changes(id,pip_id,key,items,digest,status,created_at) VALUES(?,?,?,?,?,?,?)",
               (change_id, pip["id"], key, json.dumps(items, sort_keys=True, ensure_ascii=False), digest, "waiting", now))
    registry.event(pip["workspace_id"], "pip_template_change_waiting", pip_id=pip["id"],
                   payload={"change_id": change_id, "key": key, "items": len(items), "actor": actor})
    out.update(waiting=[change_id], new=True)
    return out


# --------------------------------------------------------------------------------------------- ensure

def _state(store, pip, row_applied) -> dict:
    """The Pip as it is now, in the template's terms (what a person may have changed in DGC)."""
    from . import pip_levels
    registry = store.registry
    app_tools = [t for t in row_applied.get("tools", []) if t != COMPUTER]
    rows = _routine_rows(registry, pip["id"])
    return {"name": pip["name"], "instructions": pip["goal"], "model": pip["model_choice"],
            "level": pip_levels.level(registry, pip["id"]),
            "tools": sorted(set(app_tools) | ({COMPUTER} if pip.get("computer_plan") else set())),
            "routines": {title: _routine_now(rows.get(r.get("id"))) for title, r in row_applied.get("routines", {}).items()},
            "status": pip["status"]}


def _create(store, template, actor, accept_widening) -> dict:
    from . import pip_levels
    registry = store.registry
    personal = registry.personal()
    tools = [t for t in template["tools"] if t != COMPUTER]
    available, unavailable = [], []
    for name in tools:
        (available if _app_tool(name)[1] is not None else unavailable).append(name)
    unavailable = [_unavailable(n) for n in unavailable]
    pip = store.create(personal["id"], template["name"], template["instructions"], actor, "HEAD", PIP_TYPE,
                       model_choice(template), computer_plan={"schema_version": 1} if COMPUTER in template["tools"] else None)
    pip = store._job(pip["id"])
    pip_levels.write_level(registry, pip["id"], template["level"], actor)
    applied = {"name": pip["name"], "instructions": pip["goal"], "model": pip["model_choice"], "level": template["level"],
               "tools": sorted(available + ([COMPUTER] if COMPUTER in template["tools"] else [])),
               "always_allow": {}, "routines": {}, "status": "active"}
    from .pip_sdk_apps import display
    for routine in template["routines"]:
        if routine["when"]["kind"] == "app":
            from . import pip_sdk_apps
            if pip_sdk_apps.get(routine["when"]["app"]) is None:
                unavailable.append({"routine": routine["title"], "words": (
                    f"{display(routine['when']['app'])} isn't registered with DGC, so the routine {routine['title']} "
                    "wasn't added: register the app, then ensure again.")})
                continue
        routine_id = _add_routine(store, pip["id"], routine)
        applied["routines"][routine["title"]] = {"id": routine_id, "prompt": routine["prompt"], "when": routine["when"],
                                                 "status": "on"}
    items = []
    for name in template["always_allow"]:
        if name not in available:
            continue                                       # said once, as an unavailable tool
        items.append(_always_item(name))
    _save(registry, pip["id"], template["key"], applied, created=True)
    registry.event(pip["workspace_id"], "pip_template_created", pip_id=pip["id"],
                   payload={"key": template["key"], "actor": actor})
    done = [{"field": "pip", "words": f"Made {pip['name']} from its template."}]
    if items and accept_widening:
        done += _apply_items(store, pip, _sorted_items(items), applied, actor, template["key"])
        _save(registry, pip["id"], template["key"], applied)
        items = []
    settled = _settle(registry, pip, template["key"], _sorted_items(items), actor)
    return _answer(store, pip, template, created=True, applied=done, settled=settled, conflicts=[],
                   unavailable=unavailable)


def _always_item(name: str) -> dict:
    from . import pip_sdk_apps
    app, found = _app_tool(name)
    if found["kind"] != "change":
        _bad(f"{name} is a read: a read needs no Always allow. Take it out of always_allow.")
    if found.get("moves_money"):
        raise RegistryError("asks_every_time", f"{name} can move money, so a Pip asks every time: it is never Always "
                                               "allowed, by a template or by a person. Take it out of always_allow.")
    connection, schema = pip_sdk_apps.connection_digest(app), pip_sdk_apps.schema_digest(found)
    return {"kind": "always_allow", "tool": name, "connection_digest": connection, "schema_digest": schema}


def _conflict(field, pip_value, template_value, words, item=None) -> dict:
    out = {"field": field, "pip": pip_value, "template": template_value, "words": words}
    if item is not None:
        out["item"] = item
    return out


def _update(store, row, template, actor, accept_widening, overwrite) -> dict:
    from . import pip_action_grants, pip_levels, pip_routines, pip_sdk_apps
    registry, key = store.registry, template["key"]
    pip = store._job(row["pip_id"])
    last = json.loads(row["applied"])
    if pip["status"] == "archived":
        return _answer(store, pip, template, created=False, applied=[], conflicts=[_conflict(
            "status", "archived", "active", f"{pip['name']} is archived in DGC, so its template changed nothing. Restore "
            "it in DGC to keep it from its template again.")], unavailable=[],
            settled={"waiting": [], "declined": [], "withdrew": False, "new": False})
    now = _state(store, pip, last)
    applied = json.loads(json.dumps(last))
    done, items, conflicts, unavailable = [], [], [], []
    definition = {}
    # Its name, instructions and model: neutral, applied, unless a person changed them in DGC.
    for field, job_key, want, label in (("name", "name", template["name"], "its name"),
                                        ("instructions", "goal", template["instructions"], "its instructions"),
                                        ("model", "model_choice", model_choice(template), "its model")):
        if now[field] == want:
            applied[field] = want
        elif now[field] != last.get(field) and not overwrite:
            conflicts.append(_conflict(field, now[field], want, f"You changed {label} in DGC, so it stays as you set it."))
        else:
            definition[job_key] = want
            applied[field] = want
            done.append({"field": field, "words": f"Changed {label}."})
    # How much it asks: lower is applied, higher waits.
    want_level = template["level"]
    if now["level"] == want_level:
        applied["level"] = want_level
    elif now["level"] != last.get("level") and not overwrite:
        conflicts.append(_conflict("level", now["level"], want_level, (
            f"You set How much it asks to {pip_levels.name(now['level'])} in DGC, so it stays; the template says "
            f"{pip_levels.name(want_level)}.")))
    elif LEVELS.index(want_level) < LEVELS.index(now["level"]):
        pip_levels.write_level(registry, pip["id"], want_level, actor)
        applied["level"] = want_level
        done.append({"field": "level", "words": f"It asks more now: {pip_levels.name(want_level)}."})
    else:
        applied["level"] = now["level"]
        items.append({"kind": "level", "from": now["level"], "to": want_level})
    # Its computer: removing applies, giving one waits. A person may have changed it in DGC.
    want_computer, has_computer = COMPUTER in template["tools"], COMPUTER in now["tools"]
    had_computer = COMPUTER in last.get("tools", [])
    app_tools = [t for t in applied.get("tools", []) if t != COMPUTER]
    keep_computer = has_computer
    if has_computer == want_computer:
        pass
    elif has_computer != had_computer and not overwrite:
        conflicts.append(_conflict("tools", has_computer, want_computer, (
            "You gave it its own computer in DGC, so it keeps it." if has_computer else
            "You took its computer away in DGC, so it stays without one."), item=COMPUTER))
        keep_computer = had_computer
    elif want_computer:
        items.append({"kind": "computer"})
    else:
        definition["computer_plan"] = None
        keep_computer = False
        done.append({"field": "tools", "item": COMPUTER, "words": "It no longer has its own computer."})
    # Your app's tools: removing applies, a read is added, a change waits.
    wanted = [t for t in template["tools"] if t != COMPUTER]
    for name in sorted(set(app_tools) - set(wanted)):
        app, tool = _app_words(name)
        done.append({"field": "tools", "item": name, "words": f"It no longer uses {tool} in {app}."})
    kept = [t for t in app_tools if t in wanted]
    for name in wanted:
        if name in app_tools:
            continue
        app, found = _app_tool(name)
        if found is None:
            unavailable.append(_unavailable(name))
            continue
        if found["kind"] == "read":
            kept.append(name)
            words_app, tool = _app_words(name)
            done.append({"field": "tools", "item": name, "words": f"It uses {tool} in {words_app} now, a read."})
        else:
            items.append({"kind": "tool", "tool": name, "schema_digest": pip_sdk_apps.schema_digest(found)})
    for name in wanted:
        if name in app_tools and _app_tool(name)[1] is None:
            unavailable.append(_unavailable(name))
    applied["tools"] = sorted(set(kept) | ({COMPUTER} if keep_computer else set()))
    # Always allow: removing applies (the template's own grant is revoked), a new one waits.
    grants = {g["id"] for g in pip_action_grants.list_grants(registry, pip["id"])}
    allowed = dict(last.get("always_allow", {}))
    for name, grant in sorted(last.get("always_allow", {}).items()):
        if name not in template["always_allow"]:
            if grant in grants:
                pip_action_grants.delete_grant(registry, pip["id"], grant)
                app, tool = _app_words(name)
                done.append({"field": "always_allow", "item": name, "words": f"It asks again before {tool} in {app}."})
            allowed.pop(name, None)
        elif grant not in grants and not overwrite:
            app, tool = _app_words(name)
            conflicts.append(_conflict("always_allow", False, True, (
                f"You stopped it running {tool} in {app} without asking, in DGC, so it keeps asking."), item=name))
        elif grant not in grants:
            allowed.pop(name, None)
    for name in template["always_allow"]:
        if any(c.get("item") == name and c["field"] == "always_allow" for c in conflicts):
            continue
        if _app_tool(name)[1] is None:
            continue                                       # said once, as an unavailable tool
        live = _live_grant(registry, pip["id"], name)
        if live is not None:
            allowed[name] = live
            continue
        items.append(_always_item(name))
    applied["always_allow"] = allowed
    # Routines: by title. A removed one is deleted, a schedule or prompt changes, a new app event waits.
    routines = dict(last.get("routines", {}))
    wanted_routines = {r["title"]: r for r in template["routines"]}
    for title, kept_routine in sorted(last.get("routines", {}).items()):
        current = now["routines"].get(title)
        as_left = {"title": title, "prompt": kept_routine["prompt"], "when": kept_routine["when"],
                   "status": kept_routine["status"]}
        changed = current != as_left
        want = wanted_routines.get(title)
        if want is None:
            routines.pop(title, None)
            if current is None:
                continue
            if changed and not overwrite:
                conflicts.append(_conflict("routines", current, None, (
                    f"The template no longer has the routine {title}, but you changed it in DGC, so it stays, as your "
                    "own."), item=title))
                continue
            pip_routines.delete(store, pip["id"], kept_routine["id"])
            done.append({"field": "routines", "item": title, "words": f"Removed the routine {title}."})
            continue
        target = {"title": title, "prompt": want["prompt"], "when": want["when"], "status": "on"}
        if current == target:
            routines[title] = {"id": kept_routine["id"], "prompt": want["prompt"], "when": want["when"], "status": "on"}
            continue
        if changed and not overwrite:
            conflicts.append(_conflict("routines", current, target, (
                f"You changed the routine {title} in DGC, so it stays as you set it." if current is not None else
                f"You removed the routine {title} in DGC, so it stays removed."), item=title))
            continue
        widens = want["when"]["kind"] == "app" and not (current is not None and current["status"] == "on"
                                                        and current["when"] == want["when"])
        if current is None:
            routines.pop(title, None)
            if widens:
                items.append({"kind": "routine", "title": title, "prompt": want["prompt"], "when": want["when"],
                              "routine_id": None})
            else:
                routine_id = _add_routine(store, pip["id"], want)
                routines[title] = {"id": routine_id, "prompt": want["prompt"], "when": want["when"], "status": "on"}
                done.append({"field": "routines", "item": title, "words": f"Added the routine {title}: "
                                                                          f"{pip_routines.label(want['when'])}."})
            continue
        if widens:
            text = {k: v for k, v in (("title", title), ("prompt", want["prompt"])) if current[k] != v}
            if text:
                pip_routines.update(store, pip["id"], kept_routine["id"], text)
                done.append({"field": "routines", "item": title, "words": f"Changed what the routine {title} does."})
            routines[title] = {"id": kept_routine["id"], "prompt": want["prompt"], "when": current["when"],
                               "status": current["status"]}
            items.append({"kind": "routine", "title": title, "prompt": want["prompt"], "when": want["when"],
                          "routine_id": kept_routine["id"]})
            continue
        changes = {k: v for k, v in (("title", title), ("prompt", want["prompt"]), ("trigger", want["when"]),
                                     ("status", "on")) if (current["when"] if k == "trigger" else current[k]) != v}
        pip_routines.update(store, pip["id"], kept_routine["id"], changes)
        routines[title] = {"id": kept_routine["id"], "prompt": want["prompt"], "when": want["when"], "status": "on"}
        done.append({"field": "routines", "item": title, "words": (
            f"Changed the routine {title}: {pip_routines.label(want['when'])}." if "trigger" in changes else
            f"Changed what the routine {title} does." if "prompt" in changes else f"Turned the routine {title} back on.")})
    for title, want in wanted_routines.items():
        if title in last.get("routines", {}):
            continue
        if want["when"]["kind"] == "app":
            if pip_sdk_apps.get(want["when"]["app"]) is None:
                unavailable.append({"routine": title, "words": (
                    f"{pip_sdk_apps.display(want['when']['app'])} isn't registered with DGC, so the routine {title} "
                    "wasn't added: register the app, then ensure again.")})
                continue
            items.append({"kind": "routine", "title": title, "prompt": want["prompt"], "when": want["when"],
                          "routine_id": None})
        else:
            routine_id = _add_routine(store, pip["id"], want)
            routines[title] = {"id": routine_id, "prompt": want["prompt"], "when": want["when"], "status": "on"}
            done.append({"field": "routines", "item": title, "words": f"Added the routine {title}: "
                                                                      f"{pip_routines.label(want['when'])}."})
    applied["routines"] = routines
    if definition:
        _redefine(store, pip, definition, actor, key)
    # Paused: only a pause its template made (prune) is undone; a Pip a person paused stays paused.
    pruned = row["pruned"]
    if pip["status"] == "active":
        applied["status"], pruned = "active", 0
    elif pruned and last.get("status") == "paused":
        store.set_paused(pip["id"], False, actor, expected_lifecycle_revision=pip["lifecycle_revision"])
        applied["status"], pruned = "active", 0
        done.append({"field": "status", "words": f"Resumed {pip['name']}: its template is back."})
    else:
        conflicts.append(_conflict("status", "paused", "active", (
            f"{pip['name']} is paused in DGC, so it stays paused: resume it there when you want it to run.")))
    items = _sorted_items(items)
    if items and accept_widening:
        done += _apply_items(store, pip, items, applied, actor, key)
        items = []
    _save(registry, pip["id"], key, applied, pruned=pruned)
    settled = _settle(registry, pip, key, items, actor)
    if done:
        registry.event(pip["workspace_id"], "pip_template_applied", pip_id=pip["id"],
                       payload={"key": key, "changes": len(done), "actor": actor})
    return _answer(store, pip, template, created=False, applied=done, settled=settled, conflicts=conflicts,
                   unavailable=unavailable)


def _answer(store, pip, template, *, created, applied, settled, conflicts, unavailable) -> dict:
    name = store._job(pip["id"])["name"]
    if settled["withdrew"] and not settled["waiting"]:
        applied = applied + [{"field": "waiting", "words": "Withdrew the change that waited: the template no longer "
                                                           "asks for it."}]
    unchanged = not created and not applied and not settled["new"] and not settled["withdrew"]
    parts = []
    if created:
        parts.append(f"Made {name} from its template.")
    elif applied:
        parts.append(f"Brought {name} up to date with its template: " + " ".join(a["words"] for a in applied))
    else:
        parts.append(f"{name} already matches its template." if not conflicts else
                     f"{name} keeps what you changed in DGC.")
    if settled["waiting"]:
        parts.append(f"A change waits for a person on {name}'s page in DGC: " + "; ".join(
            item_words(i) for i in json.loads(store.db.execute("SELECT items FROM pip_template_changes WHERE id=?",
                                                               (settled["waiting"][0],)).fetchone()[0])) + ".")
    if settled["declined"]:
        parts.append("A person turned down what the template asks for more, so it isn't asked again.")
    if conflicts:
        parts.append(" ".join(c["words"] for c in conflicts))
    if unavailable:
        parts.append(" ".join(u["words"] for u in unavailable))
    return {"pip_id": pip["id"], "key": template["key"], "name": name, "created": created, "applied": applied,
            "waiting": settled["waiting"], "declined": settled["declined"], "unchanged": unchanged,
            "conflicts": conflicts, "unavailable": unavailable, "notice": " ".join(parts)[:4000]}


def ensure(store, template, actor, config, *, accept_widening=False, overwrite_user_changes=False) -> dict:
    """ensure_pip_template: make the template's Pip, or bring it to the template (see the module's words)."""
    _local(actor)
    for flag, what in ((accept_widening, "accept_widening"), (overwrite_user_changes, "overwrite_user_changes")):
        if type(flag) is not bool:
            raise RegistryError("invalid_request", f"{what} is true or false.")
    template = validate(template)
    registry = store.registry
    choice = model_choice(template)
    # The model may ask the model connection: before the transaction, and only when it would be kept.
    row = _template_row(registry.db, key=template["key"]) if has_tables(registry.db) else None
    current = last = None
    if row is not None:
        try:
            current, last = store._job(row["pip_id"])["model_choice"], json.loads(row["applied"]).get("model")
        except (RegistryError, ValueError):
            current = None
    if row is None or (current != choice and (overwrite_user_changes or current == last)):
        check_model(config, registry, choice)
    with registry.transaction():
        ensure_tables(registry.db)
        row = _template_row(registry.db, key=template["key"])
        if row is None:
            return _create(store, template, actor, accept_widening)
        return _update(store, row, template, actor, accept_widening, overwrite_user_changes)


# --------------------------------------------------------------------------------------------- prune

def prune(store, keep, actor) -> dict:
    """prune_pip_templates: pause, never delete, each Pip made from a template whose key isn't in ``keep``."""
    _local(actor)
    if (not isinstance(keep, list) or len(keep) > MAX_KEEP or any(not isinstance(k, str) or not KEY.fullmatch(k) for k in keep)
            or len(set(keep)) != len(keep)):
        raise RegistryError("invalid_request", f"keep is the keys of your templates, up to {MAX_KEEP}, each once.")
    registry = store.registry
    pruned, before = [], []
    if not has_tables(registry.db):
        return {"pruned": [], "already": [], "kept": 0, "notice": "No Pip was made from a template yet."}
    with registry.transaction():
        rows = registry.db.execute("SELECT * FROM pip_templates ORDER BY key").fetchall()
        for row in rows:
            if row["key"] in keep:
                continue
            pip = store._job(row["pip_id"])
            entry = {"pip_id": pip["id"], "key": row["key"], "name": pip["name"], "status": pip["status"]}
            if row["pruned"] or pip["status"] != "active":
                before.append(entry)
                continue
            store.set_paused(pip["id"], True, actor, expected_lifecycle_revision=pip["lifecycle_revision"])
            applied = json.loads(row["applied"])
            applied["status"] = "paused"
            _save(registry, pip["id"], row["key"], applied, pruned=1)
            registry.event(pip["workspace_id"], "pip_template_pruned", pip_id=pip["id"],
                           payload={"key": row["key"], "actor": actor})
            pruned.append({**entry, "status": "paused", "words": f"Paused {pip['name']}: no template has the key "
                                                                f"{row['key']} now. Nothing was deleted."})
    kept = sum(1 for r in rows if r["key"] in keep)
    notice = (" ".join(p["words"] for p in pruned) if pruned else "No Pip was paused: every Pip made from a template is "
              "still listed, or was paused before.")
    return {"pruned": pruned, "already": before, "kept": kept, "notice": notice}


# --------------------------------------------------------------------------------------------- reading and deciding

def listing(store, pip_id=None) -> dict:
    """list_pip_templates: each Pip made from a template, what it was last brought to, and the change that waits."""
    db = store.db
    if pip_id is not None and (not isinstance(pip_id, str) or not re.fullmatch(r"pip_[a-f0-9]{32}", pip_id)):
        raise RegistryError("invalid_request", "pip_id is a Pip's id.")
    if not has_tables(db):
        return {"templates": []}
    rows = (db.execute("SELECT * FROM pip_templates WHERE pip_id=?", (pip_id,)).fetchall() if pip_id is not None
            else db.execute("SELECT * FROM pip_templates ORDER BY key").fetchall())
    out = []
    for row in rows:
        try:
            pip = store._job(row["pip_id"])
        except RegistryError:
            continue
        applied = json.loads(row["applied"])
        waiting = _waiting_row(db, pip["id"])
        declined = db.execute("SELECT * FROM pip_template_changes WHERE pip_id=? AND status='declined' ORDER BY "
                              "decided_at DESC LIMIT 1", (pip["id"],)).fetchone()
        out.append({"key": row["key"], "pip_id": pip["id"], "name": pip["name"], "status": pip["status"],
                    "pruned": bool(row["pruned"]), "level": applied.get("level"), "tools": applied.get("tools", []),
                    "always_allow": sorted(applied.get("always_allow", {})),
                    "routines": sorted(applied.get("routines", {})),
                    "created_at": row["created_at"], "updated_at": row["updated_at"],
                    "waiting": _change_view(waiting, pip["name"]) if waiting is not None else None,
                    "declined": _change_view(declined, pip["name"]) if declined is not None else None})
    return {"templates": out}


def decide(store, change_id, decision, expected_digest, actor) -> dict:
    """decide_pip_template_change: a person's Accept or Not now on a change a template asks for, exactly once."""
    _local(actor)
    if not isinstance(change_id, str) or not CHANGE.fullmatch(change_id):
        raise RegistryError("invalid_request", "change_id is the change's id, tmplchange_ and 32 hex digits.")
    if decision not in ("accept", "reject"):
        raise RegistryError("invalid_request", "decision is accept or reject.")
    if not isinstance(expected_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise RegistryError("invalid_request", "expected_digest is the change's digest.")
    registry = store.registry
    if not has_tables(registry.db):
        raise RegistryError("not_found", "That change isn't on this computer.")
    with registry.transaction():
        change = registry.db.execute("SELECT * FROM pip_template_changes WHERE id=?", (change_id,)).fetchone()
        if change is None:
            raise RegistryError("not_found", "That change isn't on this computer.")
        pip = store._job(change["pip_id"])
        if change["status"] != "waiting":
            return {"change": _change_view(change, pip["name"]), "decided": False, "applied": [],
                    "notice": "This change was already answered, or the template no longer asks for it."}
        if change["digest"] != expected_digest:
            raise RegistryError("template_conflict", "This change is not the one shown. Refresh, and look at it again.")
        if pip["status"] == "archived":
            raise RegistryError("archived", f"{pip['name']} is archived. Restore it in DGC first.")
        row = _template_row(registry.db, pip_id=pip["id"])
        now = registry.clock()
        done = []
        if decision == "accept":
            applied = json.loads(row["applied"])
            done = _apply_items(store, pip, json.loads(change["items"]), applied, actor, change["key"])
            _save(registry, pip["id"], change["key"], applied, pruned=row["pruned"])
        registry.db.execute("UPDATE pip_template_changes SET status=?,decided_at=?,decided_by=? WHERE id=?",
                            ("accepted" if decision == "accept" else "declined", now, actor, change_id))
        registry.event(pip["workspace_id"], "pip_template_change_" + ("accepted" if decision == "accept" else "declined"),
                       pip_id=pip["id"], payload={"change_id": change_id, "key": change["key"], "actor": actor})
        change = registry.db.execute("SELECT * FROM pip_template_changes WHERE id=?", (change_id,)).fetchone()
    name = store._job(pip["id"])["name"]
    return {"change": _change_view(change, name), "decided": True, "applied": done,
            "notice": (f"{name} can do more now: " + " ".join(d["words"] for d in done)) if decision == "accept" else
                      f"{name} stays as it is. Its template won't ask for exactly this again."}
