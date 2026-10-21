"""Always allow: a Pip's standing permission to run one kind of action without asking.

The user grants it while approving a real action (Always allow), never a model and never auto mode.
A grant is pinned to that action's kind, saved connection and its fingerprint, account, tool and
tool schema: if any of them changes, the grant no longer matches and the action waits for the user
as before. Grants live in registry metadata, outside the reviewed job; the user revokes them in the
Pip's Job tab or with `dgc pips allowed`.

After each finished run of a Personal Pip, the runner prepares and runs every action the run drafted
that a grant covers (`dispatch_for_run`), as that grant (actor `pip-grant:<id>`), and tells the user
after. An action no grant covers waits for Send once, Always allow or Reject, as it always has.
A payment plugin (pip_plugins: 1inch, Aave, Airwallex) is the one exception: its actions never get
Always allow, and ask every time.
"""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError, identifier

PREFIX = "pip_action_grant:"
MAX_PER_PIP = 20
ACTOR = re.compile(r"pip-grant:grant_[a-f0-9]{32}")
_FIXED_TOOL = {"gmail_send": "GMAIL_SEND_EMAIL", "calendar_create": "GOOGLECALENDAR_CREATE_EVENT"}
_DRAFT_KIND = {"gmail_send": "email", "calendar_create": "calendar", "connector_call": "connector"}
LABEL = {"gmail_send": "Send email", "calendar_create": "Create calendar events", "connector_call": "Run",
         "computer_submit": "Submit in its browser"}
KINDS = frozenset(LABEL)


def tool(payload) -> str:
    return payload["call"]["tool"] if payload["kind"] == "connector_call" else _FIXED_TOOL[payload["kind"]]


def _pins(payload) -> dict:
    return {"kind": payload["kind"], "server": payload["server"], "connection_digest": payload["connection_digest"],
            "account": payload["account"], "schema_digest": payload["schema_digest"], "tool": tool(payload)}


def _key(pip_id, grant_id):
    return f"{PREFIX}{pip_id}:{grant_id}"


def _local(actor):
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "Only you can allow a Pip to act without asking, on this computer.")


def require_can_always(payload) -> None:
    """Refuse Always allow for a payment plugin's action, before anything runs."""
    money = _asks_every_time(payload)
    if money:
        raise RegistryError("asks_every_time", f"{money} can move money, so a Pip asks you every time. Choose Allow for this one.")


def _asks_every_time(payload) -> str:
    """A payment plugin's name when this action is one of its: those ask every time."""
    if payload.get("kind") != "connector_call":
        return ""
    from .pip_plugins import owner
    found = owner(payload.get("server"))
    return found["display_name"] if found and found["money"] else ""


def list_grants(registry, pip_id) -> list:
    start = f"{PREFIX}{pip_id}:"
    grants = []
    for key, value in registry.db.execute("SELECT key,value FROM metadata WHERE key>=? AND key<?",
                                          (start, start + "\U0010ffff")).fetchall():
        try:
            item = json.loads(value)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get("kind") in KINDS:
            grants.append({"id": key[len(start):], **{k: item.get(k) for k in (
                "kind", "server", "connection_digest", "account", "schema_digest", "tool", "label", "created_at", "created_by")}})
    grants.sort(key=lambda g: (str(g["created_at"]), g["id"]))
    return grants


def grant_from_action(store, action_id, expected_digest, actor) -> dict:
    """Always allow this action's kind, connection, account and tool for its Pip."""
    from . import pip_app_actions as actions
    _local(actor)
    action = actions.get(store, action_id)
    if not isinstance(expected_digest, str) or expected_digest != action["digest"]:
        raise RegistryError("action_conflict", "Review this exact saved action before allowing it.")
    payload = action["payload"]
    pip_id = payload["source"]["pip_id"]
    require_can_always(payload)
    pins = _pins(payload)
    with store.registry.transaction():
        for existing in list_grants(store.registry, pip_id):
            if all(existing[k] == v for k, v in pins.items()):
                return existing
        if len(list_grants(store.registry, pip_id)) >= MAX_PER_PIP:
            raise RegistryError("limit", f"A Pip can always allow at most {MAX_PER_PIP} actions. Remove one in its Job tab first.")
        grant_id = identifier("grant")
        label = LABEL[payload["kind"]] + (f" {pins['tool']}" if payload["kind"] == "connector_call" else "") + f" with {payload['server']}"
        record = {**pins, "label": label[:200], "created_at": store.registry.clock(), "created_by": actor, "from_action": action_id}
        store.registry.db.execute("INSERT INTO metadata VALUES(?,?)", (_key(pip_id, grant_id), json.dumps(record, ensure_ascii=False)))
        store.registry.event(payload["source"]["workspace_id"], "pip_action_granted", pip_id=pip_id,
                             payload={"grant_id": grant_id, "kind": payload["kind"], "tool": pins["tool"], "actor": actor})
    return {"id": grant_id, **{k: record[k] for k in ("kind", "server", "connection_digest", "account", "schema_digest",
                                                    "tool", "label", "created_at", "created_by")}}


def revoke(registry, pip_id, grant_id, actor) -> list:
    _local(actor)
    if not isinstance(grant_id, str) or not re.fullmatch(r"grant_[a-f0-9]{32}", grant_id):
        raise RegistryError("invalid_request", "Choose one allowed action from this Pip.")
    with registry.transaction():
        if registry.db.execute("DELETE FROM metadata WHERE key=?", (_key(pip_id, grant_id),)).rowcount != 1:
            raise RegistryError("not_found", "That allowed action is not on this Pip.")
        workspace = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
        if workspace is not None:
            registry.event(workspace[0], "pip_action_grant_revoked", pip_id=pip_id, payload={"grant_id": grant_id, "actor": actor})
    return list_grants(registry, pip_id)


def check(store, actor, payload):
    """The grant an action runs as must exist on its Pip and cover exactly this action."""
    if not isinstance(actor, str) or not ACTOR.fullmatch(actor):
        raise RegistryError("local_only", "External action reviews are available only in the local CLI and extension.")
    grant_id = actor.split(":", 1)[1]
    pins = _pins(payload)
    grant = next((g for g in list_grants(store.registry, payload["source"]["pip_id"]) if g["id"] == grant_id), None)
    if grant is None or any(grant[k] != v for k, v in pins.items()) or _asks_every_time(payload):
        raise RegistryError("local_only", "This Pip is not allowed to run that action without asking.")


def covers(registry, pip_id, kind) -> bool:
    return any(g["kind"] == kind for g in list_grants(registry, pip_id))


def summary(registry, pip_id) -> list:
    """What a Pip's runs are told: which drafted actions run without asking."""
    return [{"kind": g["kind"], "tool": g["tool"], "server": g["server"]} for g in list_grants(registry, pip_id)][:MAX_PER_PIP]


def _matching(grants, kind, draft_content):
    for g in grants:
        if g["kind"] != kind:
            continue
        # A connector draft pins its own discovered connection and tool schema: all must agree.
        if kind == "connector_call" and any(draft_content.get(k) != g[k] for k in ("server", "connection_digest", "schema_digest")):
            continue
        if kind == "connector_call" and draft_content["call"]["tool"] != g["tool"]:
            continue
        return g
    return None


def dispatch_for_run(registry, config, run_id) -> list:
    """Run every action this finished run drafted that a grant covers. Never raises: an action that
    cannot run on its own stays a draft for the user, and the reason is recorded."""
    from . import pip_app_actions as actions, pip_message_drafts as drafts
    from .pips import PipStore
    store = PipStore(registry)
    outcomes = []
    try:
        row = registry.db.execute("SELECT pip_id,workspace_id FROM pip_runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            return outcomes
        grants = list_grants(registry, row[0])
        if not grants:
            return outcomes
    except Exception:
        return outcomes
    for draft_kind, action_kind, table in (("email", "gmail_send", "pip_message_drafts"),
                                           ("calendar", "calendar_create", "pip_calendar_drafts"),
                                           ("connector", "connector_call", "pip_connector_drafts")):
        try:
            ids = [r[0] for r in registry.db.execute(
                f"SELECT id FROM {table} WHERE source_run_id=? AND actor=? AND status='pending'",
                (run_id, f"pip-{draft_kind}:{run_id}")).fetchall()]
        except Exception:
            continue
        for draft_id in ids:
            try:
                draft = drafts.get(store, draft_id, kind=draft_kind)
                content = draft["payload"]["action" if draft_kind == "connector" else "event" if draft_kind == "calendar" else "message"]
                grant = _matching(grants, action_kind, content)
                if grant is None:
                    continue
                actor = "pip-grant:" + grant["id"]
                message = content["call"] if draft_kind == "connector" else content
                prepared = drafts.prepare(store, draft_id, draft["digest"], grant["server"], grant["connection_digest"],
                                          grant["account"], grant["schema_digest"], message, actor, config, kind=draft_kind)
                done = actions.accept(store, prepared["id"], prepared["digest"], actor, config)
                outcomes.append({"action_id": done["id"], "status": done["status"], "grant_id": grant["id"]})
                from .pip_plugins import after_action
                after_action(store, config, done)   # a plugin action: the Pip reads its answer and carries on
            except Exception as exc:
                outcomes.append({"draft_id": draft_id, "status": "waiting", "reason": str(exc)[:300]})
                try:
                    registry.event(row[1], "pip_action_grant_skipped", pip_id=row[0], run_id=run_id,
                                   payload={"draft_id": draft_id, "reason": str(exc)[:300]})
                except Exception:
                    pass
    return outcomes


def pending_count(registry, now) -> int:
    """Actions waiting for the user: Pip-drafted drafts and prepared actions not yet sent or run."""
    total = 0
    for table in ("pip_message_drafts", "pip_calendar_drafts", "pip_connector_drafts"):
        try:
            total += registry.db.execute(f"SELECT count(*) FROM {table} WHERE status='pending' AND expires_at>? "
                                         "AND actor LIKE 'pip-%'", (now,)).fetchone()[0]
        except Exception:
            pass
    try:
        total += registry.db.execute("SELECT count(*) FROM pip_app_actions WHERE status='pending' AND expires_at>?",
                                     (now,)).fetchone()[0]
    except Exception:
        pass
    return total


def ran_on_their_own(registry, limit=20) -> list:
    """The newest actions Pips ran on an Always-allow grant, or sent as their level allows (pip_levels: an app send at
    any level, a submit at Full access): [(action_id, sentence)], newest first."""
    rows = registry.db.execute(
        "SELECT a.id,a.status,a.payload,v.definition,a.resolved_by FROM pip_app_actions a JOIN pips p ON p.id=a.pip_id "
        "JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
        "WHERE (a.resolved_by LIKE 'pip-grant:%' OR a.resolved_by LIKE 'pip-level:%') AND a.status IN ('succeeded','unknown') "
        "ORDER BY a.resolved_at DESC LIMIT ?", (limit,)).fetchall()
    said = []
    try:
        rows = list(rows) + [(r[0], "succeeded", json.dumps({"kind": "computer_submit", "summary": json.loads(r[1])}), r[2], r[3])
            for r in registry.db.execute(
                "SELECT a.id,a.summary,v.definition,a.resolved_by FROM pip_computer_actions a JOIN pips p ON p.id=a.pip_id "
                "JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
                "WHERE (a.resolved_by LIKE 'pip-grant:%' OR (a.resolved_by='pip-level:full' "
                "AND COALESCE(json_extract(a.summary,'$.kind'),'')<>'site')) AND a.status='sent' "
                "ORDER BY a.resolved_at DESC LIMIT ?", (limit,)).fetchall()]
    except Exception:
        pass                                  # a registry without computers
    for action_id, status, payload, definition, resolved_by in rows:
        try:
            p, name = json.loads(payload), json.loads(definition).get("name") or "A Pip"
        except ValueError:
            continue
        if p.get("kind") == "gmail_send":
            what = f"sent an email to {p['message'].get('recipient_email', '')}"
        elif p.get("kind") == "computer_submit":
            what = f"submitted to {p['summary'].get('host', '')}{p['summary'].get('path', '')} in its browser"
        elif p.get("kind") == "calendar_create":
            what = f"added \u201c{p['event'].get('summary', '')}\u201d to your calendar"
        else:
            what = f"ran {p.get('call', {}).get('tool', '')} with {p.get('server', '')}"
        how = (", as its level allows (" + {"approve": "Approve for me", "full": "Full access"}.get(resolved_by.split(":", 1)[1], "") + ")."
               if str(resolved_by).startswith("pip-level:") else ", as you always allow.")
        said.append((action_id, f"{name} {what}" + (" (not confirmed)" if status == "unknown" else "") + how))
    return said


# --------------------------------------------------------------------------- a Pip's computer
# A browser submit is the same kind of action when it goes to the same site, method and path, from
# the same Pip's computer: Gmail's send, a broker's order form, a booking page. Its pins reuse the
# fields above: server = the site, account = "browser", tool = "METHOD /path", the digests bind the
# Pip's computer and the exact endpoint.

def _hash(text):
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def computer_pins(pip_id, summary) -> dict:
    method, host, path = str(summary["method"]).upper(), str(summary["host"]), str(summary["path"])
    return {"kind": "computer_submit", "server": host, "connection_digest": _hash("dgc.pip.computer\0" + pip_id),
            "account": "browser", "schema_digest": _hash(f"{method} {host}{path}"), "tool": f"{method} {path}"[:160]}


def computer_grant_for(registry, pip_id, summary):
    pins = computer_pins(pip_id, summary)
    return next((g for g in list_grants(registry, pip_id) if all(g[k] == v for k, v in pins.items())), None)


def add_computer_grant(registry, action_id, actor) -> dict:
    """Always allow this submit's site, method and path for the Pip whose computer held it. Runs
    inside the caller's transaction (`pip_computer.approve_always`), which checked the digest."""
    _local(actor)
    row = registry.db.execute("SELECT pip_id,workspace_id,summary FROM pip_computer_actions WHERE id=?", (action_id,)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That computer action does not exist.")
    summary = json.loads(row["summary"])
    pins = computer_pins(row["pip_id"], summary)
    for existing in list_grants(registry, row["pip_id"]):
        if all(existing[k] == v for k, v in pins.items()):
            return existing
    if len(list_grants(registry, row["pip_id"])) >= MAX_PER_PIP:
        raise RegistryError("limit", f"A Pip can always allow at most {MAX_PER_PIP} actions. Remove one in its Job tab first.")
    grant_id = identifier("grant")
    label = f"Submit in its browser to {summary['host']}{summary['path']}"[:200]
    record = {**pins, "label": label, "created_at": registry.clock(), "created_by": actor, "from_action": action_id}
    registry.db.execute("INSERT INTO metadata VALUES(?,?)", (_key(row["pip_id"], grant_id), json.dumps(record, ensure_ascii=False)))
    registry.event(row["workspace_id"], "pip_action_granted", pip_id=row["pip_id"],
                   payload={"grant_id": grant_id, "kind": "computer_submit", "tool": pins["tool"], "actor": actor})
    return {"id": grant_id, **{k: record[k] for k in ("kind", "server", "connection_digest", "account", "schema_digest",
                                                    "tool", "label", "created_at", "created_by")}}
