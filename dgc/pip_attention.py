"""Everything your Personal Pips are waiting on you for, in one list (Grok's sidebar, Dots' activity view).

Each Pip shows its own cards in its chat: an email to Send, a Connect card, a plugin it asks to use, a
submit its computer held, a robot check, a routine it suggested. With many Pips you would open each to
find them. This reads all of them at once, newest first, for the Pips home and the Sessions strip.

It only reads, inside a snapshot that is rolled back, and decides "still waiting" in SQL (expires_at > now):
reading the list never expires, resolves or marks anything. Each item names its Pip and the card it
opens; what the card does is unchanged and stays where it was (the chat, the computer, the home).
"""
from __future__ import annotations

import json

KINDS = ("email", "event", "action", "app_action", "app_link", "plugin", "setup", "computer_action",
         "computer_check", "routine")
# Reviews of a Personal Pip's work: a workflow's handoff waiting for its review, a change waiting on its Changes page. They wait
# on you like any card, so the total counts them, but they come in `reviews`, not `items`: a client from before (its list knows
# KINDS only) would refuse the whole list over a row it doesn't know.
REVIEW_KINDS = ("handoff", "approval")
MAX_ITEMS = 100
MAX_SCAN = 2000                     # rows read per kind; the counts stay exact past it
TITLE, DETAIL = 160, 200
APP_KINDS = {"gmail_send": "email", "calendar_create": "event", "connector_call": "action"}


def _text(value, limit) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _json(value) -> dict:
    try:
        parsed = json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _what(kind, payload) -> tuple[str, str]:
    """A card's words: (title, detail), plain text."""
    if not isinstance(payload, dict):
        payload = {}
    if kind == "email":
        m = payload.get("message") or {}
        if not isinstance(m, dict):
            m = {}
        return f"Send this email to {m.get('recipient_email', 'someone')}?", m.get("subject", "")
    if kind == "event":
        e = payload.get("event") or {}
        if not isinstance(e, dict):
            e = {}
        return f"Add “{e.get('summary', 'an event')}” to your calendar?", _when(e)
    a = payload.get("action") or payload
    if not isinstance(a, dict):
        a = {}
    call = a.get("call") or {}
    if not isinstance(call, dict):
        call = {}
    from . import pip_sdk_apps
    if pip_sdk_apps.is_app(a.get("server")):
        # Your own app (Pips API 61): "Run create_dispatch in Shop app?"
        return f"Run {call.get('tool', 'an action')} in {pip_sdk_apps.display(pip_sdk_apps.name_of(a['server']))}?", ""
    from .pip_plugins import owner
    try:
        found = owner(a.get("server"))
    except Exception:          # noqa: BLE001 - a name is all this reads
        found = None
    return f"Run {call.get('tool', 'an action')} in {found['display_name'] if found else a.get('server', 'an app')}?", ""


def _when(event) -> str:
    """'Sun 11 Oct, 1:00 PM' in the event's own time zone; the exact text when it won't read."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    try:
        at = datetime.fromisoformat(str(event.get("start_datetime"))).astimezone(ZoneInfo(str(event.get("timezone"))))
        return at.strftime("%a %d %b, %I:%M %p").replace(" 0", " ").lstrip("0")
    except Exception:          # noqa: BLE001 - a label only
        return str(event.get("start_datetime") or "")




def collect(registry, now, *, limit=MAX_ITEMS) -> dict:
    """{as_of, total, counts, by_pip, items, reviews, truncated, in_projects} over every Personal Pip that isn't archived.
    `total` is the one number the Pips home, its rows and the editor's notice all say; `in_projects` is what waits in
    project folders, which this list doesn't show (each project's own Pips do)."""
    limit = max(1, min(int(limit or MAX_ITEMS), MAX_ITEMS))
    db = registry.db
    db.execute("SAVEPOINT pip_attention")
    try:
        pips = {row["id"]: {"name": _text(row["name"], 120) or "Pip", "pip_type": row["pip_type"] or "scout",
                            "workspace_id": row["workspace_id"]}
                for row in db.execute(
                    "SELECT p.id,p.workspace_id,json_extract(v.definition,'$.name') AS name,json_extract(v.definition,'$.pip_type') AS pip_type "
                    "FROM pips p JOIN workspaces w ON w.id=p.workspace_id JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
                    "WHERE w.kind='personal' AND p.status<>'archived'")}
        ids = json.dumps(sorted(pips))
        personal = [row["id"] for row in db.execute("SELECT id FROM workspaces WHERE kind='personal'")]
        found = []

        def add(kind, origin, pip_id, created, expires, title, detail=""):
            found.append({"id": f"{kind}:{origin}", "kind": kind, "card": origin, "pip_id": pip_id, "created_at": created,
                          "expires_at": expires, "title": _text(title, TITLE), "detail": _text(detail, DETAIL)})

        def rows(sql, *params):
            try:
                return db.execute(sql + " LIMIT ?", (*params, MAX_SCAN)).fetchall()
            except Exception:       # a table an older registry never made
                return []

        mine = "pip_id IN (SELECT value FROM json_each(?))"
        for table, kind in (("pip_message_drafts", "email"), ("pip_calendar_drafts", "event"), ("pip_connector_drafts", "action")):
            for row in rows(f"SELECT id,pip_id,payload,created_at,expires_at FROM {table} WHERE status='pending' AND expires_at>? "
                            f"AND actor LIKE 'pip-%' AND {mine} ORDER BY created_at DESC", now, ids):
                add(kind, row["id"], row["pip_id"], row["created_at"], row["expires_at"], *_what(kind, _json(row["payload"])))
        # A review DGC opened for your own app (pip_sdk_app_approvals) is the same change as its draft's card above.
        for row in rows(f"SELECT id,pip_id,payload,created_at,expires_at FROM pip_app_actions WHERE status='pending' AND expires_at>? "
                        f"AND requested_by<>'pip-app-review' AND {mine} ORDER BY created_at DESC", now, ids):
            payload = _json(row["payload"])
            add("app_action", row["id"], row["pip_id"], row["created_at"], row["expires_at"],
                *_what(APP_KINDS.get(payload.get("kind"), "action"), payload))
        # The newest card per Pip and app (or plugin) decides, as the Pip's chat shows it.
        from .pip_app_links import app_name
        for row in rows("SELECT id,pip_id,toolkit,reason,status,error,created_at FROM (SELECT *,ROW_NUMBER() OVER "
                        "(PARTITION BY pip_id,toolkit ORDER BY updated_at DESC, id DESC) AS n FROM pip_app_links WHERE " + mine + ") "
                        "WHERE n=1 AND status IN ('requested','failed') ORDER BY updated_at DESC", ids):
            app = app_name(row["toolkit"])
            add("app_link", row["id"], row["pip_id"], row["created_at"], None,
                f"Couldn’t connect {app}" if row["status"] == "failed" else f"Connect {app}?",
                row["error"] if row["status"] == "failed" else row["reason"])
        # No "Use Aave?" rows since 2026-10-09: a plugin turned on in Settings is every Pip's, so a card a Pip
        # asked for before then is no longer waiting on anyone.
        for row in rows("SELECT id,pip_id,summary,created_at,expires_at FROM pip_computer_actions WHERE status='pending' "
                        f"AND expires_at>? AND {mine} ORDER BY created_at DESC", now, ids):
            from .pip_computer import is_payment, sends_words
            summary = _json(row["summary"])
            # Careful mode's holds say what they are: a new site, or something read from your apps.
            title = (f"Visit {summary.get('site') or summary.get('host', 'a new site')}?" if summary.get("kind") == "site"
                     else f"Save a login for {summary.get('site') or summary.get('host', 'a site')}?" if summary.get("kind") == "login"
                     else f"Put what it read from your apps on {summary.get('host') or 'a page'}?" if summary.get("kind") == "text"
                     else f"Pay on {summary.get('host', 'a site')}?" if is_payment(summary)
                     else f"Send this on {summary.get('host', 'a site')}?")
            # What it sends, when it is a form: a payment's bill number and amount, an order's sizes.
            said = sends_words(summary) if summary.get("kind") not in ("site", "text", "login") else ""
            add("computer_action", row["id"], row["pip_id"], row["created_at"], row["expires_at"], title, said or summary.get("page", ""))
        for row in rows("SELECT key,value FROM metadata WHERE key LIKE 'computer\\_needs\\_you:%' ESCAPE '\\'"):
            pip_id, value = row["key"].split(":", 1)[1], _json(row["value"])
            if pip_id in pips:
                add("computer_check", pip_id, pip_id, value.get("at") or now, None,
                    f"Prove you’re human on {value.get('host', 'a site')}", "It stopped at a robot check and waits for you.")
        for row in rows(f"SELECT id,pip_id,title,prompt,created_at FROM pip_routines WHERE status='suggested' AND created_by='pip' "
                        f"AND {mine} ORDER BY created_at DESC", ids):
            add("routine", row["id"], row["pip_id"], row["created_at"], None, f"Add the routine “{row['title']}”?", row["prompt"])
        for row in rows(f"SELECT id,target_pip_id,payload,created_at,expires_at FROM pip_handoffs WHERE status='pending' AND expires_at>? "
                        f"AND target_pip_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC", now, ids):
            add("handoff", row["id"], row["target_pip_id"], row["created_at"], row["expires_at"],
                f"Hand this to {pips[row['target_pip_id']]['name']}?", _json(row["payload"]).get("task", ""))
        for row in rows(f"SELECT proposal_id,pip_id,action_type,action_summary,created_at,expires_at FROM pip_approvals "
                        f"WHERE status='pending' AND expires_at>? AND {mine} ORDER BY created_at DESC", now, ids):
            add("approval", row["proposal_id"], row["pip_id"], row["created_at"], row["expires_at"],
                f"Change {pips[row['pip_id']]['name']}?", row["action_summary"])
            found[-1]["review"] = row["action_type"]
        for workspace_id in personal:
            for row in rows("SELECT id,body,created_at,expires_at FROM pip_setup_proposals WHERE workspace_id=? AND status='pending' "
                            "AND expires_at>? ORDER BY created_at DESC", workspace_id, now):
                request = _json(row["body"]).get("request") or {}
                if not isinstance(request, dict):
                    request = {}
                target = request.get("pip_id") if request.get("pip_id") in pips else None
                add("setup", row["id"], target, row["created_at"], row["expires_at"],
                    f"Change {pips[target]['name']}?" if target else f"Create the Pip “{request.get('name', 'New Pip')}”?",
                    request.get("goal", ""))
    finally:
        db.execute("ROLLBACK TO pip_attention")
        db.execute("RELEASE pip_attention")
    found.sort(key=lambda item: (item["created_at"] or "", item["id"]), reverse=True)
    counts, by_pip = {kind: 0 for kind in (*KINDS, *REVIEW_KINDS)}, {}
    for item in found:
        counts[item["kind"]] += 1
        if item["pip_id"]:
            by_pip[item["pip_id"]] = by_pip.get(item["pip_id"], 0) + 1
            pip = pips[item["pip_id"]]
            item.update(pip_name=pip["name"], pip_type=pip["pip_type"], workspace_id=pip["workspace_id"])
        else:
            item.update(pip_name="", pip_type="", workspace_id=personal[0] if personal else "")
    cards = [item for item in found if item["kind"] in KINDS]
    reviews = [item for item in found if item["kind"] in REVIEW_KINDS][:limit]
    items = cards[:limit]
    return {"as_of": now, "total": len(found), "counts": counts,
            "by_pip": dict(sorted(by_pip.items(), key=lambda kv: -kv[1])[:500]), "items": items, "reviews": reviews,
            "truncated": len(found) > len(items) + len(reviews), "in_projects": _in_projects(registry, now, personal)}


def _in_projects(registry, now, personal) -> int:
    """Reviews and setup cards waiting in project folders on this computer. 0 when they can't be read: this only adds a
    sentence to the editor's notice."""
    from .pip_overview import pending_reviews
    try:
        total = pending_reviews(registry, limit=1)["total_pending"]
        marks = ",".join("?" for _ in personal)
        for table, column in (("pip_approvals", "workspace_id"), ("pip_handoffs", "workspace_id")):
            total -= registry.db.execute(f"SELECT count(*) FROM {table} WHERE status='pending' AND expires_at>? "
                                         f"AND {column} IN ({marks})", (now, *personal)).fetchone()[0]
        total += registry.db.execute(f"SELECT count(*) FROM pip_setup_proposals WHERE status='pending' AND expires_at>? "
                                     f"AND workspace_id NOT IN ({marks})", (now, *personal)).fetchone()[0]
    except Exception:          # noqa: BLE001 - a count for one sentence
        return 0
    return max(0, total)
