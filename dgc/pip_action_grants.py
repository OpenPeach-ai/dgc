"""Always allow: a Pip's standing permission to run one kind of action without asking.

The user grants it while approving a real action (Always allow), never a model and never auto mode.
A grant is pinned to that action's kind, saved connection and its fingerprint, account, tool and
tool schema: if any of them changes, the grant no longer matches and the action waits for the user
as before, with one line on its card saying why it asked again. Grants live in registry metadata, outside the reviewed job; the user revokes them in the
Pip's Job tab or with `dgc pips allowed`.

After each finished run of a Personal Pip, the runner prepares and runs every action the run drafted
that a grant covers (`dispatch_for_run`), as that grant (actor `pip-grant:<id>`), and tells the user
after. An action no grant covers waits for Send once, Always allow or Reject, as it always has.
A payment plugin (pip_plugins: 1inch, Aave, Airwallex) is the one exception: its actions never get
Always allow, and ask every time. A Pip's computer has its own kind of grant, at the end of this file:
a site, a method and the shape of an address, so a submit with an ID in its address asks once.
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
    """Refuse Always allow for a payment plugin's action, or one of a plugin the user set to Always ask, before
    anything runs."""
    money = _asks_every_time(payload)
    if money:
        raise RegistryError("asks_every_time", f"{money} can move money, so a Pip asks you every time. Choose Allow for this one.")
    asks = _always_ask(payload)
    if asks:
        raise RegistryError("asks_every_time", f"You set {asks} to Always ask, so a Pip asks you every time. Choose Allow "
                            "for this one.")


def _always_ask(payload) -> str:
    """The plugin's name when the user set it to Always ask (Pips settings, Plugins): then no Always allow holds for
    its calls, as an allow rule never beats an ask rule of the user's own."""
    if payload.get("kind") != "connector_call":
        return ""
    from .pip_plugins import always_asks, owner
    if not always_asks(payload.get("server")):
        return ""
    found = owner(payload.get("server"))
    return found["display_name"] if found else str(payload.get("server") or "this plugin")


def _asks_every_time(payload) -> str:
    """A payment plugin's name when this action is one of its, or your own app's tool that moves money ("Shop app's
    refund_order", Pips API 61): those ask every time."""
    if payload.get("kind") != "connector_call":
        return ""
    from . import pip_sdk_apps
    if pip_sdk_apps.is_app(payload.get("server")):
        call = payload.get("call") if isinstance(payload.get("call"), dict) else {}
        return pip_sdk_apps.moves_money(payload["server"], call.get("tool"))
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
        existing_grants = list_grants(store.registry, pip_id)
        for existing in existing_grants:
            if all(existing[k] == v for k, v in pins.items()):
                return existing
        # An Always allow for this tool from before it changed can never match again: this one takes its place.
        for voided in [g for g in existing_grants if g["kind"] == pins["kind"] and g["server"] == pins["server"]
                       and g["tool"] == pins["tool"] and g["account"] == pins["account"]]:
            store.registry.db.execute("DELETE FROM metadata WHERE key=?", (_key(pip_id, voided["id"]),))
            store.registry.event(payload["source"]["workspace_id"], "pip_action_grant_revoked", pip_id=pip_id,
                                 payload={"grant_id": voided["id"], "actor": actor, "replaced": True})
            existing_grants.remove(voided)
        existing_grants = _reclaim_one_offs(store.registry, pip_id, payload["source"]["workspace_id"], existing_grants)
        if len(existing_grants) >= MAX_PER_PIP:
            raise RegistryError("limit", f"A Pip can always allow at most {MAX_PER_PIP} actions. Remove one in its Job tab first.")
        grant_id = identifier("grant")
        from . import pip_sdk_apps
        where = (pip_sdk_apps.display(pip_sdk_apps.name_of(payload["server"])) if pip_sdk_apps.is_app(payload["server"])
                 else payload["server"])
        label = LABEL[payload["kind"]] + (f" {pins['tool']}" if payload["kind"] == "connector_call" else "") + f" with {where}"
        record = {**pins, "label": label[:200], "created_at": store.registry.clock(), "created_by": actor, "from_action": action_id}
        store.registry.db.execute("INSERT INTO metadata VALUES(?,?)", (_key(pip_id, grant_id), json.dumps(record, ensure_ascii=False)))
        store.registry.event(payload["source"]["workspace_id"], "pip_action_granted", pip_id=pip_id,
                             payload={"grant_id": grant_id, "kind": payload["kind"], "tool": pins["tool"], "actor": actor})
    return {"id": grant_id, **{k: record[k] for k in ("kind", "server", "connection_digest", "account", "schema_digest",
                                                    "tool", "label", "created_at", "created_by")}}


def grant_app_tool(registry, pip_id, workspace_id, server, tool, connection_digest, schema_digest, actor, *,
                   template) -> dict:
    """Always allow one change tool of your own app for this Pip, pinned to the app and the tool as they are now: a
    Pip template's always_allow (pip_templates, Pips API 64), accepted by a person or by the app's accept_widening.
    Inside the caller's transaction. Never a read, never a tool that moves money."""
    _local(actor)
    if tool.get("kind") != "change":
        raise RegistryError("invalid_template", f"{tool['name']} is a read: a read needs no Always allow.")
    payload = {"kind": "connector_call", "server": server, "connection_digest": connection_digest,
               "account": "connection_managed", "schema_digest": schema_digest,
               "call": {"tool": tool["name"], "arguments": {}}}
    require_can_always(payload)
    pins = _pins(payload)
    existing_grants = list_grants(registry, pip_id)
    for existing in existing_grants:
        if all(existing[k] == v for k, v in pins.items()):
            return existing
    existing_grants = _reclaim_one_offs(registry, pip_id, workspace_id, existing_grants)
    if len(existing_grants) >= MAX_PER_PIP:
        raise RegistryError("limit", f"A Pip can always allow at most {MAX_PER_PIP} actions. Remove one in its Job tab first.")
    from . import pip_sdk_apps
    grant_id = identifier("grant")
    label = f"{LABEL['connector_call']} {tool['name']} with {pip_sdk_apps.display(pip_sdk_apps.name_of(server))}"
    record = {**pins, "label": label[:200], "created_at": registry.clock(), "created_by": actor, "from_template": template}
    registry.db.execute("INSERT INTO metadata VALUES(?,?)", (_key(pip_id, grant_id), json.dumps(record, ensure_ascii=False)))
    registry.event(workspace_id, "pip_action_granted", pip_id=pip_id,
                   payload={"grant_id": grant_id, "kind": "connector_call", "tool": pins["tool"], "actor": actor,
                            "template": template})
    return {"id": grant_id, **{k: record[k] for k in ("kind", "server", "connection_digest", "account", "schema_digest",
                                                    "tool", "label", "created_at", "created_by")}}


def delete_grant(registry, pip_id, grant_id) -> None:
    """Take one Always allow back, inside the caller's transaction (a template that no longer allows its tool)."""
    if registry.db.execute("DELETE FROM metadata WHERE key=?", (_key(pip_id, grant_id),)).rowcount:
        workspace = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
        if workspace is not None:
            registry.event(workspace[0], "pip_action_grant_revoked", pip_id=pip_id,
                           payload={"grant_id": grant_id, "actor": "pip-template"})


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


# Why a card asks again though the user chose Always allow (its pins keep it from running): the tool's definition or the
# connection changed since. The card says so in one line (asked_again, on the draft the editor reads).
_CHANGED = {"send_schema_changed": "tool", "connection_changed": "connection"}


def _voided(grants, kind, content) -> str:
    """A connector draft carries its own digests: "tool" or "connection" when a grant for this very tool no longer
    matches them, else ""."""
    if kind != "connector_call":
        return ""
    for g in grants:
        if g["kind"] == kind and g["server"] == content.get("server") and g["tool"] == content["call"]["tool"]:
            if g["connection_digest"] != content.get("connection_digest"):
                return "connection"
            if g["schema_digest"] != content.get("schema_digest"):
                return "tool"
    return ""


def with_asked_again(registry, draft, kind) -> dict:
    """A pending draft as the editor reads it, with asked_again ("tool" or "connection") when a grant used to cover it."""
    if draft.get("status") != "pending":
        return draft
    why = ""
    try:
        if kind == "connector":
            why = _voided(list_grants(registry, draft["pip_id"]), "connector_call", draft["payload"]["action"])
        else:
            for row in registry.db.execute("SELECT payload FROM workspace_events WHERE run_id=? AND event_type='pip_action_grant_skipped' "
                                           "ORDER BY seq DESC LIMIT 20", (draft["source_run_id"],)):
                said = json.loads(row["payload"])
                if said.get("draft_id") == draft["id"] and said.get("changed"):
                    why = said["changed"]
                    break
    except Exception:                       # noqa: BLE001 - the card shows without its line
        return draft
    return {**draft, "asked_again": why} if why else draft


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
                if grant is None or (draft_kind == "connector" and _always_ask({"kind": action_kind, **content})):
                    continue                     # Always ask, set after this grant was given, wins: its card waits
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
                changed = _CHANGED.get(getattr(exc, "code", ""))
                try:
                    registry.event(row[1], "pip_action_grant_skipped", pip_id=row[0], run_id=run_id,
                                   payload={"draft_id": draft_id, "reason": str(exc)[:300], **({"changed": changed} if changed else {})})
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
        # A review DGC opened for your own app (pip_sdk_app_approvals) is counted as its draft.
        total += registry.db.execute("SELECT count(*) FROM pip_app_actions WHERE status='pending' AND expires_at>? "
                                     "AND requested_by<>'pip-app-review'", (now,)).fetchone()[0]
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
            from . import pip_sdk_apps
            server = str(p.get('server', ''))
            what = f"ran {p.get('call', {}).get('tool', '')} with " + (
                pip_sdk_apps.display(pip_sdk_apps.name_of(server)) if pip_sdk_apps.is_app(server) else server)
        how = (", as its level allows (" + {"approve": "Approve for me", "full": "Full access"}.get(resolved_by.split(":", 1)[1], "") + ")."
               if str(resolved_by).startswith("pip-level:") else ", as you always allow.")
        said.append((action_id, f"{name} {what}" + (" (not confirmed)" if status == "unknown" else "") + how))
    return said


# --------------------------------------------------------------------------- a Pip's computer
# A browser submit is the same kind of action when it goes to the same site with the same method, to the same address
# apart from what changes on each visit, from the same Pip's computer. Its pins reuse the fields above: server = the
# site, account = "browser", tool = "METHOD route", the digests bind the Pip's computer and the route.
#
# The route is the address's shape (route_of): IDs become *, plain words stay exactly as they are. So an address with an
# ID, token or session in it asks once, and /delete can never match /update.

def _hash(text):
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


_UUID = re.compile(r"(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])", re.I)
_HEX = re.compile(r"[0-9a-f]+", re.I)
_BETWEEN = re.compile(r"((?:%[0-9A-Fa-f]{2}|[^0-9A-Za-z*])+)")     # what separates the pieces of one path segment
_CLASS_RUN = re.compile(r"[a-z]+|[A-Z]+|[0-9]+")
_LETTER_RUN = re.compile(r"[A-Za-z]{5,}")
_LONG_NUMBER = re.compile(r"[0-9]{4,}")
_WILD_RUN = re.compile(r"\*(?:[^0-9A-Za-z*]+\*)+")
TOKEN_LENGTH = 20
# Query keys whose value says what a request does (?action=delete, ?route=checkout/confirm, ?wc-ajax=checkout). Their
# plain words stay in the route; every other query value generalises, because a session, a tracker or a redirect changes
# from visit to visit and doesn't change what the request does.
ACTION_KEYS = frozenset({"action", "_action", "op", "operation", "do", "cmd", "command", "method", "task", "mode", "type",
                         "route", "page", "step", "function", "func", "controller", "module", "fc", "wc-ajax"})


def _worded(piece: str) -> int:
    """How many of a piece's letters read as words: runs of five or more, a third of them vowels (random letters rarely
    are), so getUser2024 is mostly words and ZZKBKACTAV9WEVGEMMVRZ isn't."""
    runs = (run for run in _LETTER_RUN.findall(piece) if sum(c in "aeiouyAEIOUY" for c in run) * 3 >= len(run))
    return sum(len(run) for run in runs)


def _random_piece(piece: str) -> bool:
    """A number, long hex or random token: what changes between visits. A plain word, a short code like v2 or h2, and
    words joined up (getUserProfile, report2024) are not."""
    if piece.isdigit():
        return True
    if not piece.isascii() or not piece.isalnum():
        return False
    digits, letters = any(c.isdigit() for c in piece), any(c.isalpha() for c in piece)
    if _HEX.fullmatch(piece) and (len(piece) >= 12 or (digits and letters and len(piece) >= 7)):
        return True
    runs = len(_CLASS_RUN.findall(piece))
    if digits and letters:
        return len(piece) >= 8 and runs >= 4 and _worded(piece) * 2 < len(piece)
    return letters and len(piece) >= 10 and len(piece) / runs < 2.5


def _plain_word(piece: str) -> bool:
    """A piece that reads as a word: its letters are one case, or Capitalised, or camelCase, and it has a vowel."""
    if len(piece) < 3 or not piece.isalpha() or not re.search(r"[aeiouyAEIOUY]", piece):
        return False
    return piece.islower() or piece.isupper() or bool(re.fullmatch(r"[A-Za-z]?[a-z]+(?:[A-Z][a-z]+)*", piece))


def _whole_token(segment: str) -> bool:
    """One long token however it is punctuated (a JWT; "0.881:1730000000:abcDEF-_123XYz"), in the middle of which a few
    short pieces may read as words by chance. A word first or last, or a long word anywhere, is a real word: not a token."""
    if len(segment) < TOKEN_LENGTH or not any(c.isdigit() for c in segment):
        return False
    pieces = [p for p in _BETWEEN.split(segment) if p and not _BETWEEN.fullmatch(p)]
    if len(pieces) < 2 or _plain_word(pieces[0]) or _plain_word(pieces[-1]):
        return False
    words = [p for p in pieces if _plain_word(p)]
    return not any(len(w) >= 5 for w in words) and sum(len(w) for w in words) * 3 < sum(len(p) for p in pieces)


def _shape_segment(segment: str) -> str:
    """One path segment with its IDs as *, and every plain word kept: delete-12345 is delete-*, never just *."""
    segment = _UUID.sub("*", segment)
    if _random_piece(segment) or _whole_token(segment):
        return "*"
    # A long number inside a word goes too: report2024 and report2025 are one address, delete2024 and update2024 aren't.
    return _WILD_RUN.sub("*", "".join(
        part if not part or _BETWEEN.fullmatch(part) else "*" if _random_piece(part) else _LONG_NUMBER.sub("*", part)
        for part in _BETWEEN.split(segment)))


def route_of(path, query: str = "", fields=()) -> str:
    """What an Always allow pins of an address: its shape. Same plain words in the same order, any IDs (a run of them
    counts as one); a query's values only when they say what the request does (ACTION_KEYS); and for GraphQL, whose one
    address does everything, whether it reads or which change it makes."""
    from urllib.parse import parse_qsl
    segments = []
    for segment in str(path or "/").split("/"):
        shaped = _shape_segment(segment) if segment else segment
        if shaped == "*" and segments and segments[-1] == "*":
            continue
        segments.append(shaped)
    route = "/".join(segments) or "/"
    kept = []
    for key, value in parse_qsl(str(query or ""), keep_blank_values=True):
        if key.lower() in ACTION_KEYS:
            shaped = "/".join(_shape_segment(part) for part in value.split("/"))
            if shaped and shaped != "*":
                kept.append(f"{key.lower()}={shaped}"[:80])
    if kept:
        route += "?" + "&".join(sorted(set(kept)))
    return route + _graphql_scope(route, fields)


def _graphql_scope(route: str, fields) -> str:
    named = {str(name).lower(): str(value) for name, value in fields or ()}
    if "graphql" not in route.lower() and "operationname" not in named:
        return ""
    text, operation = named.get("query", "").lstrip(), named.get("operationname", "")
    if text.startswith(("query", "{")) and "mutation" not in text[:200]:
        return " (reads)"
    if not operation and text.startswith("mutation"):
        found = re.match(r"mutation\s+([A-Za-z0-9_]+)", text)
        operation = found.group(1) if found else ""
    return f" ({re.sub(r'[^A-Za-z0-9_]', '', operation)[:60]})" if operation else ""


# A route grant the 0.51 test builds gave for Cloudflare's browser check covered everything under its address. The rule
# above makes the same route from its tokens, and this keeps that grant whole for one that doesn't read as a token.
_OLD_ROUTE_GRANT = ("POST", "dash.cloudflare.com", "/cdn-cgi/challenge-platform/h/b/precursor/")


def computer_pins(pip_id, summary, *, exact=False) -> dict:
    method, host = str(summary["method"]).upper(), str(summary["host"]).lower()
    route = str(summary["path"]) if exact else str(summary.get("route") or route_of(summary["path"]))
    return {"kind": "computer_submit", "server": host, "connection_digest": _hash("dgc.pip.computer\0" + pip_id),
            "account": "browser", "schema_digest": _hash(f"{method} {host}{route}"), "tool": f"{method} {route}"[:160]}


def computer_grant_for(registry, pip_id, summary):
    pins = computer_pins(pip_id, summary)
    found = list_grants(registry, pip_id)
    matching = lambda p: next((g for g in found if all(g[k] == v for k, v in p.items())), None)
    grant = matching(pins)
    if grant:
        return grant
    # An approval from before routes stays exactly what it was: good for the address the person approved, never wider.
    exact = computer_pins(pip_id, summary, exact=True)
    grant = matching(exact) if exact != pins else None
    if grant:
        return grant
    method, host, prefix = _OLD_ROUTE_GRANT
    if (exact["tool"].startswith(f"{method} {prefix}") and exact["server"] == host):
        return matching(computer_pins(pip_id, {"method": method, "host": host, "path": prefix + "*"}, exact=True))
    return None


def _one_off_address(grant) -> str | None:
    """The address of an approval from before routes that named one exact ID: it can only ever match that one visit."""
    if grant["kind"] != "computer_submit":
        return None
    path = str(grant["tool"]).partition(" ")[2]
    if str(grant["server"]) == _OLD_ROUTE_GRANT[1] and path.startswith(_OLD_ROUTE_GRANT[2]) and path != _OLD_ROUTE_GRANT[2] + "*":
        return path                  # one token of that check, however it reads
    return path if path and route_of(path) != path else None


def _reclaim_one_offs(registry, pip_id, workspace_id, grants):
    """At the limit: discard approvals that named one exact ID, so they can't block the next Always allow. This only
    removes authority, and an address that has moved on no longer needed it; nothing old ever becomes a route."""
    if len(grants) < MAX_PER_PIP:
        return grants
    return _drop_grants(registry, pip_id, workspace_id, grants, [g for g in grants if _one_off_address(g)])


def _drop_grants(registry, pip_id, workspace_id, grants, old):
    for grant in old:
        registry.db.execute("DELETE FROM metadata WHERE key=?", (_key(pip_id, grant["id"]),))
    if old:
        registry.event(workspace_id, "pip_action_grants_reclaimed", pip_id=pip_id,
                       payload={"kind": "computer_submit", "count": len(old)})
    return [g for g in grants if g not in old]


def route_label(host, route) -> str:
    return f"Submit in its browser to {host}{route}" + (", whatever the ID" if "*" in str(route) else "")


def add_computer_grant(registry, action_id, actor) -> dict:
    """Always allow this submit's route (site, method, the address's shape) for the Pip whose computer held it. Runs
    inside the caller's transaction (`pip_computer.approve_always`), which checked the digest."""
    _local(actor)
    row = registry.db.execute("SELECT pip_id,workspace_id,summary FROM pip_computer_actions WHERE id=?", (action_id,)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That computer action does not exist.")
    summary = json.loads(row["summary"])
    pins = computer_pins(row["pip_id"], summary)
    existing_grants = list_grants(registry, row["pip_id"])
    for existing in existing_grants:
        if all(existing[k] == v for k, v in pins.items()):
            return existing
    # This route covers every one-address approval of it from before routes: each is one grant of 20 this no longer needs.
    method, route = pins["tool"].split(" ", 1)
    existing_grants = _drop_grants(registry, row["pip_id"], row["workspace_id"], existing_grants, [
        g for g in existing_grants if _one_off_address(g) and g["server"] == pins["server"]
        and str(g["tool"]).startswith(method + " ") and route_of(_one_off_address(g)) == route])
    existing_grants = _reclaim_one_offs(registry, row["pip_id"], row["workspace_id"], existing_grants)
    if len(existing_grants) >= MAX_PER_PIP:
        raise RegistryError("limit", f"A Pip can always allow at most {MAX_PER_PIP} actions. Remove one in its Job tab first.")
    grant_id = identifier("grant")
    label = route_label(pins["server"], route)[:200]
    record = {**pins, "label": label, "created_at": registry.clock(), "created_by": actor, "from_action": action_id}
    registry.db.execute("INSERT INTO metadata VALUES(?,?)", (_key(row["pip_id"], grant_id), json.dumps(record, ensure_ascii=False)))
    registry.event(row["workspace_id"], "pip_action_granted", pip_id=row["pip_id"],
                   payload={"grant_id": grant_id, "kind": "computer_submit", "tool": pins["tool"], "actor": actor})
    return {"id": grant_id, **{k: record[k] for k in ("kind", "server", "connection_digest", "account", "schema_digest",
                                                    "tool", "label", "created_at", "created_by")}}
