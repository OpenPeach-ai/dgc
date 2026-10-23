"""Approvals in your app (Pips API 62): Pips for SDK apps, part 2.

When a Pip's change on your own app (``app:<name>``, pip_sdk_apps) waits for a person, DGC tells the app at the
address it registered, signed exactly as its tool calls are (``X-DGC-Timestamp``, ``X-DGC-Nonce``,
``X-DGC-Signature``), so the app's own admin screen can show it and decide it. DGC's own Allow card shows it too;
whichever answers first wins, once, and the other side observes that answer.

**What DGC sends.**

- ``{type: "approval_requested", app, action_id, action_digest, tool, arguments, pip_id, pip_name, run_id, summary,
  expires_at, moves_money}`` when a review opens and waits: the Pip's change at the end of its run (after Always allow
  and its level had their say, so only what still asks), or a review a person proposed.
- ``{type: "approval_resolved", app, action_id, tool, decision, by, at}`` when it closes, wherever that happened:
  ``decision`` is ``accepted``, ``rejected`` or ``expired``; ``by`` is ``dgc`` (DGC's card, the CLI, or the expiry),
  ``app`` (your app, through ``decide``), ``always_allow`` (the Pip's Always allow) or ``level`` (the Pip's level,
  Approve for me or Full access). A change that moves money never gets Always allow or a level: it always asks.

**Delivery.** Kept in the Pips database in the same transaction that opens or closes the review, then sent by the Pips
runner (it looks every couple of seconds): a first try, then up to three more 5 s, 30 s and 2 min after a failure. The
app's own refusal (an HTTP 4xx other than 408 and 429, a redirect, a certificate DGC can't check) isn't retried. Every
try is recorded on the action (``app_deliveries``). A request for a review that closed before DGC could send it is
skipped: the app hears only how it closed. A failed delivery never blocks or rejects anything; DGC's card still shows
the change. The app should treat a repeat of the same ``(action_id, type)`` as one event.

**Deciding in the app.** ``decide_app_approval {action_id, decision: "accept" | "reject", expected_digest}`` (the SDKs'
``pips.decide``) is ``accept_pip_app_action`` / ``reject_pip_app_action`` decided by the app: its ``by`` is ``app``.
``list_app_approvals {app?}`` (``pips.pending``) lists the app actions that wait, with their digests. Deciding what is
already decided, from either side, answers what happened and never runs it again.

**DGC's card.** The review DGC opens for a Pip's change is tied to that change's Allow card (its connector draft): the
card's Allow takes the same review; Edit withdraws it (the app hears ``rejected``, by ``dgc``) and runs the edited one;
Don't rejects it. When the app decides first, the card settles with it.
"""
from __future__ import annotations

import contextlib
import json
import re
import ssl
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import pip_sdk_apps
from .workspace_registry import RegistryError, utc_now

REVIEWER = "pip-app-review"            # requested_by of the review DGC opens for a Pip's change on your app
OUTBOX = "pipapp_outbox:"              # metadata: an event waiting to be sent, <action_id>:<requested|resolved>
SENT = "pipapp_sent:"                  # metadata: one that was delivered, skipped or failed for good
RETRIES = (5, 30, 120)                 # seconds after a failed try: a first try and up to three more
CLAIM_SECONDS = 60
SEND_SECONDS = 10
MAX_LIST = 100
LOCAL = ("editor-user", "local-console")
ACTION = re.compile(r"appaction_[a-f0-9]{32}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
KINDS = ("requested", "resolved")


# --------------------------------------------------------------------------------------------- what it is

def is_app_action(payload) -> bool:
    return (isinstance(payload, dict) and payload.get("kind") == "connector_call"
            and pip_sdk_apps.is_app(payload.get("server")))


def decision_of(status: str) -> str | None:
    return {"dispatching": "accepted", "succeeded": "accepted", "unknown": "accepted", "rejected": "rejected",
            "expired": "expired"}.get(status)


def by_of(resolved_by, decision) -> str | None:
    """Who decided, in the app's words: dgc, app, always_allow or level."""
    if decision is None:
        return None
    if decision == "expired":
        return "dgc"
    who = str(resolved_by or "")
    if who.startswith("app:"):
        return "app"
    if who.startswith("pip-grant:"):
        return "always_allow"
    if who.startswith("pip-level:"):
        return "level"
    return "dgc"


def decider(by, payload, actor) -> str:
    """resolved_by for a decision: the user's actor, or ``app:<name>`` when the app decided its own action."""
    if by is None:
        return actor
    if not is_app_action(payload) or by != payload["server"]:
        raise RegistryError("not_an_app_action", "Only your own app decides its own actions.")
    return by


def closed_words(value) -> str:
    """Why an app action can't be decided now, in words, or '' for DGC's usual ones."""
    payload = value.get("payload") or {}
    if not is_app_action(payload):
        return ""
    app = pip_sdk_apps.display(pip_sdk_apps.name_of(payload["server"]))
    who = by_of(value.get("resolved_by"), decision_of(value.get("status")))
    if value.get("status") == "expired":
        return "This expired without an answer."
    if value.get("status") == "rejected":
        return f"{app} declined this." if who == "app" else "This was declined."
    if who == "app":
        return f"{app} already accepted this: it ran once."
    return ""


def _pip_name(store, pip_id) -> str:
    try:
        return str(store._job(pip_id).get("name") or "A Pip")[:80]
    except Exception:                                  # noqa: BLE001 - a name is only for the app's screen
        return "A Pip"


def _words(arguments) -> str:
    parts = []
    for key, value in list((arguments or {}).items())[:6]:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        parts.append(f"{key} {text}")
    said = ", ".join(parts)
    return said if len(said) <= 160 else said[:159] + "…"


def summary(pip_name, name, tool, arguments) -> str:
    """'Asha asks to run create_dispatch (order_id ORD-1041) in Shop app.'"""
    args = _words(arguments)
    return (f"{pip_name} asks to run {tool}" + (f" ({args})" if args else "") + f" in {pip_sdk_apps.display(name)}.")[:300]


def _money(server, tool) -> bool:
    try:
        return bool(pip_sdk_apps.moves_money(server, tool))
    except Exception:                                  # noqa: BLE001 - unknown asks, as a payment does
        return True


# --------------------------------------------------------------------------------------------- the record

def _key(prefix, action_id, kind) -> str:
    return f"{prefix}{action_id}:{kind}"


def _load(db, key):
    row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    try:
        value = json.loads(row[0])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _save(db, key, record) -> None:
    db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (key, json.dumps(record, ensure_ascii=False, separators=(",", ":"))))


def _enqueue(db, action_id, kind, name, body) -> None:
    """Once per action and kind: a second call (or one after it was sent) changes nothing."""
    if _load(db, _key(OUTBOX, action_id, kind)) is not None or _load(db, _key(SENT, action_id, kind)) is not None:
        return
    _save(db, _key(OUTBOX, action_id, kind), {
        "version": 1, "type": body["type"], "app": name, "action_id": action_id, "body": body, "status": "waiting",
        "created_at": utc_now(), "next_at": time.time(), "claim_until": 0, "tries": [], "delivered_at": None,
        "error": None})


def deliveries(db, action_id) -> list[dict]:
    """What DGC told the app about one action, and how each try went: the action's ``app_deliveries``."""
    out = []
    for kind in KINDS:
        record = _load(db, _key(OUTBOX, action_id, kind)) or _load(db, _key(SENT, action_id, kind))
        if record is not None:
            out.append({"type": record.get("type"), "status": record.get("status"), "tries": record.get("tries") or [],
                        "delivered_at": record.get("delivered_at"), "error": record.get("error"),
                        "created_at": record.get("created_at")})
    return out


# --------------------------------------------------------------------------------------------- opening and closing

def requested(store, action_id, payload, digest, expires_at) -> None:
    """In the transaction that opens a review on your app: the app will hear that it waits for a person."""
    if not is_app_action(payload):
        return
    with contextlib.suppress(Exception):           # telling the app never stops the review
        name = pip_sdk_apps.name_of(payload["server"])
        tool, arguments = payload["call"]["tool"], payload["call"]["arguments"]
        pip_id = payload["source"]["pip_id"]
        pip_name = _pip_name(store, pip_id)
        _enqueue(store.db, action_id, "requested", name, {
            "type": "approval_requested", "app": name, "action_id": action_id, "action_digest": digest, "tool": tool,
            "arguments": arguments, "pip_id": pip_id, "pip_name": pip_name, "run_id": payload["source"]["run_id"],
            "summary": summary(pip_name, name, tool, arguments), "expires_at": expires_at,
            "moves_money": _money(payload["server"], tool)})


def resolved(store, value, decision, resolved_by, at, *, link=True) -> None:
    """In the transaction that closes a review on your app: the app will hear how, and DGC's card settles with it."""
    payload = value.get("payload")
    if not is_app_action(payload):
        return
    with contextlib.suppress(Exception):
        name = pip_sdk_apps.name_of(payload["server"])
        _enqueue(store.db, value["id"], "resolved", name, {
            "type": "approval_resolved", "app": name, "action_id": value["id"], "tool": payload["call"]["tool"],
            "decision": decision, "by": by_of(resolved_by, decision), "at": at})
    if link:
        _link(store.db, value["id"])


def _link(db, action_id) -> None:
    """The Pip's Allow card (its connector draft) settles with the review DGC opened for it."""
    row = db.execute("SELECT requested_by,request_key FROM pip_app_actions WHERE id=?", (action_id,)).fetchone()
    if row is None or row[0] != REVIEWER or not str(row[1]).startswith("draft_"):
        return
    db.execute("UPDATE pip_connector_drafts SET status='prepared',action_id=? WHERE id=? AND status='pending'",
               (action_id, row[1][len("draft_"):]))


def review_for_draft(store, draft_id):
    """The review DGC opened for this Allow card, as saved (never expired here), or None."""
    row = store.db.execute("SELECT id FROM pip_app_actions WHERE requested_by=? AND request_key=?",
                           (REVIEWER, "draft_" + str(draft_id))).fetchone()
    if row is None:
        return None
    from .pip_app_actions import _row
    return _row(store, row[0])


def take_for_draft(store, draft_id, review) -> None:
    """The card's Allow on the same call: the card is prepared with the review DGC opened (in the caller's
    transaction)."""
    store.db.execute("UPDATE pip_connector_drafts SET status='prepared',action_id=? WHERE id=? AND status='pending'",
                     (review["id"], draft_id))


def withdraw(store, review, actor) -> bool:
    """In the caller's transaction: the user changed or declined the card, so the review DGC opened for the app closes
    as rejected by DGC (the app hears it). The card itself is the caller's to settle."""
    if actor not in LOCAL:
        raise RegistryError("action_conflict", "Only you change a change that waits for your app.")
    at = store.registry.clock()
    if review["status"] != "pending" or review["expires_at"] <= at:
        return False
    changed = store.db.execute("UPDATE pip_app_actions SET status='rejected',resolved_by=?,resolved_at=? "
                               "WHERE id=? AND status='pending'", (actor, at, review["id"])).rowcount
    if changed:
        resolved(store, review, "rejected", actor, at, link=False)
    return bool(changed)


def open_reviews_for_run(registry, config, run_id) -> list:
    """After a finished run, its Always allow and its level: each change it proposed in your own app that still waits
    becomes a review the app can decide too (and hears about). Never raises; the card stays either way."""
    from . import pip_app_actions as actions, pip_message_drafts as drafts
    from .pips import PipStore
    opened = []
    try:
        rows = registry.db.execute("SELECT id FROM pip_connector_drafts WHERE source_run_id=? AND actor=? AND status='pending'",
                                   (run_id, "pip-connector:" + run_id)).fetchall()
    except Exception:                                  # noqa: BLE001 - a registry without connector drafts
        return opened
    store = PipStore(registry)
    for (draft_id,) in rows:
        try:
            draft = drafts.get(store, draft_id, kind="connector")
            action = draft["payload"]["action"]
            if draft["expired"] or not pip_sdk_apps.is_app(action["server"]):
                continue
            review = actions.propose(store, run_id, action["server"], action["connection_digest"], "connection_managed",
                                     action["schema_digest"], action["call"], "draft_" + draft_id, REVIEWER, config,
                                     kind="connector_call")
            opened.append(review["id"])
        except Exception as exc:                       # noqa: BLE001 - it stays DGC's card alone
            with contextlib.suppress(Exception):
                with registry.transaction():
                    registry.event(registry.personal()["id"], "pip_app_review_skipped", run_id=run_id,
                                   payload={"draft_id": draft_id, "reason": str(exc)[:300]})
    return opened


# --------------------------------------------------------------------------------------------- the SDK's commands

def view(store, value) -> dict:
    """An app action as list_app_approvals and decide_app_approval answer it."""
    payload = value["payload"]
    name = pip_sdk_apps.name_of(payload["server"])
    tool, arguments = payload["call"]["tool"], payload["call"]["arguments"]
    pip_id = payload["source"]["pip_id"]
    pip_name = _pip_name(store, pip_id)
    decision = decision_of(value["status"])
    return {"action_id": value["id"], "action_digest": value["digest"], "app": name, "tool": tool, "arguments": arguments,
            "pip_id": pip_id, "pip_name": pip_name, "run_id": payload["source"]["run_id"],
            "summary": summary(pip_name, name, tool, arguments), "created_at": value["created_at"],
            "expires_at": value["expires_at"], "moves_money": _money(payload["server"], tool), "status": value["status"],
            "decision": decision, "by": by_of(value.get("resolved_by"), decision),
            "decided_at": value.get("resolved_at") if decision else None, "receipt": value.get("receipt"),
            "deliveries": deliveries(store.db, value["id"])}


def _local(actor) -> None:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you and your own apps decide their changes, on this computer.")


def pending(store, app, actor) -> dict:
    """list_app_approvals: the app actions waiting for a person, oldest first, with their digests."""
    _local(actor)
    from . import pip_app_actions as actions
    if app is not None and (not isinstance(app, str) or not pip_sdk_apps.NAME.fullmatch(app)):
        raise RegistryError("invalid_app", "Name the app as it was registered, such as shop.")
    now = store.registry.clock()
    where = "json_extract(payload,'$.server')=?" if app is not None else "json_extract(payload,'$.server') LIKE 'app:%'"
    params = (now, "app:" + app) if app is not None else (now,)
    rows = store.db.execute("SELECT id FROM pip_app_actions WHERE status='pending' AND expires_at>? "
                            "AND json_extract(payload,'$.kind')='connector_call' AND " + where +
                            " ORDER BY created_at,id LIMIT ?", (*params, MAX_LIST)).fetchall()
    out = []
    for (action_id,) in rows:
        with contextlib.suppress(RegistryError):
            value = actions.get(store, action_id)
            if value["status"] == "pending":
                out.append(view(store, value))
    return {"approvals": out}


def decide(store, action_id, decision, expected_digest, actor, config) -> dict:
    """decide_app_approval: your app accepts or rejects one of its own actions. Exactly once: what is decided already,
    by either side, answers what happened (``decided: false``) and runs nothing."""
    _local(actor)
    from . import pip_app_actions as actions
    if not isinstance(action_id, str) or not ACTION.fullmatch(action_id):
        raise RegistryError("invalid_request", "action_id is the approval's, appaction_ and 32 hex digits.")
    if decision not in ("accept", "reject"):
        raise RegistryError("invalid_request", 'decision is "accept" or "reject".')
    value = actions.get(store, action_id)
    if not is_app_action(value["payload"]):
        raise RegistryError("not_an_app_action", "This isn't a change on one of your own apps.")
    if not isinstance(expected_digest, str) or expected_digest != value["digest"]:
        raise RegistryError("action_conflict", "Decide the exact action you were shown: its digest is different.")
    by = value["payload"]["server"]
    outcome: dict = {}
    if value["status"] == "pending":
        try:
            if decision == "accept":
                done = actions.accept(store, action_id, expected_digest, actor, config, by=by, outcome=outcome)
            else:
                done = actions.reject(store, action_id, expected_digest, actor, by=by, outcome=outcome)
        except RegistryError as exc:
            if exc.code != "action_resolved":
                raise
            done = actions.get(store, action_id)        # the other side was first: observe it
    else:
        done = value
    if outcome.get("decided") and decision == "accept":
        from .pip_plugins import after_action
        after_action(store, config, done)              # the Pip reads what the app answered and carries on
    return {"approval": view(store, done), "decided": bool(outcome.get("decided"))}


# --------------------------------------------------------------------------------------------- sending

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):          # noqa: D401 - urllib's hook
        return None


def _post(name, body, *, timeout=SEND_SECONDS, opener=None) -> tuple[str, str]:
    """One signed POST of an event: ("delivered", "") or ("retry" | "failed", the words for it)."""
    app = pip_sdk_apps.get(name)
    said = pip_sdk_apps.phrase(name)
    if app is None:
        return "failed", f"{pip_sdk_apps.display(name)} isn't registered with DGC now"
    try:
        secret = pip_sdk_apps._secret(name)
    except RegistryError as exc:
        return "failed", str(exc)[:300]
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    timestamp, nonce = str(int(time.time())), __import__("secrets").token_hex(16)
    request = urllib.request.Request(app["url"], data=data, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "DGC-Pips/62",
        "X-DGC-Timestamp": timestamp, "X-DGC-Nonce": nonce,
        "X-DGC-Signature": pip_sdk_apps.signature(secret, timestamp, nonce, data)})
    try:
        with (opener or pip_sdk_apps._opener(app["url"])).open(request, timeout=timeout) as response:
            response.read(65536)
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as exc:
        code = exc.code
        if 300 <= code < 400:
            return "failed", f"{said} answered with a redirect, which DGC doesn't follow"
        if code in (408, 429) or code >= 500:
            return "retry", f"{said} answered with an error (HTTP {code})"
        return "failed", f"{said} refused it (HTTP {code})"
    except (socket.timeout, TimeoutError):
        return "retry", f"{said} didn't answer in {timeout:g} seconds"
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        if isinstance(reason, ssl.SSLError):
            return "failed", f"{said}'s certificate couldn't be checked, so DGC didn't send it"
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return "retry", f"{said} didn't answer in {timeout:g} seconds"
        return "retry", f"{said} didn't answer"
    except (OSError, ValueError):
        return "retry", f"{said} didn't answer"
    if not 200 <= int(status) < 300:
        return "retry", f"{said} answered HTTP {status}"
    return "delivered", ""


def _outbox(db) -> list[tuple[str, dict]]:
    rows = db.execute("SELECT key,value FROM metadata WHERE key>=? AND key<?", (OUTBOX, OUTBOX[:-1] + ";")).fetchall()
    out = []
    for key, raw in rows:
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        if isinstance(record, dict):
            out.append((key, record))
    out.sort(key=lambda item: (item[1].get("next_at") or 0, item[1].get("created_at") or "",
                               0 if item[1].get("type") == "approval_requested" else 1))
    return out


def due(db, now=None) -> bool:
    now = time.time() if now is None else now
    return any(r.get("status") == "waiting" and (r.get("next_at") or 0) <= now and (r.get("claim_until") or 0) < now
               for _, r in _outbox(db))


def _claim(registry, now):
    with registry.transaction():
        for key, record in _outbox(registry.db):
            if record.get("status") == "waiting" and (record.get("next_at") or 0) <= now and (record.get("claim_until") or 0) < now:
                record["claim_until"] = now + CLAIM_SECONDS
                _save(registry.db, key, record)
                return key, record
    return None


def _still_waiting(registry, action_id) -> bool:
    row = registry.db.execute("SELECT status,expires_at FROM pip_app_actions WHERE id=?", (action_id,)).fetchone()
    return row is not None and row[0] == "pending" and row[1] > registry.clock()


def _finish(registry, key, record, outcome, words, now) -> dict:
    record = dict(record)
    if outcome != "skipped":
        record["tries"] = (record.get("tries") or []) + [{"at": utc_now(), "outcome": "delivered" if outcome == "delivered" else words}]
    record["claim_until"] = 0
    if outcome == "retry":
        if len(record["tries"]) <= len(RETRIES):
            record["next_at"] = now + RETRIES[len(record["tries"]) - 1]
            with registry.transaction():
                _save(registry.db, key, record)
            return record
        outcome, words = "failed", words + f" ({len(record['tries'])} tries)"
    record["status"] = outcome
    if outcome == "delivered":
        record["delivered_at"] = record["tries"][-1]["at"]
    elif outcome == "skipped":
        record["error"] = "It was decided before DGC could tell the app; the app hears how it was decided."
    else:
        record["error"] = words
    with registry.transaction():
        registry.db.execute("DELETE FROM metadata WHERE key=?", (key,))
        _save(registry.db, SENT + key[len(OUTBOX):], record)
    return record


def deliver_due(registry, config=None, *, now=None, opener=None, limit=20) -> list[dict]:
    """Send every event that is due now, one by one: each claimed first, so two senders never send one twice."""
    sent = []
    for _ in range(limit):
        at = time.time() if now is None else now
        claimed = _claim(registry, at)
        if claimed is None:
            break
        key, record = claimed
        if record.get("type") == "approval_requested" and not _still_waiting(registry, record.get("action_id")):
            outcome, words = "skipped", ""
        else:
            try:
                outcome, words = _post(record["app"], record["body"], opener=opener)
            except Exception as exc:                   # noqa: BLE001 - recorded, retried
                outcome, words = "retry", f"{pip_sdk_apps.phrase(record.get('app', ''))} couldn't be reached ({type(exc).__name__})"
        done = _finish(registry, key, record, outcome, words, time.time() if now is None else now)
        sent.append({"action_id": record.get("action_id"), "type": record.get("type"), "status": done["status"],
                     "tries": len(done.get("tries") or [])})
    return sent


def expire_due(registry, limit=50) -> int:
    """Close each app action whose time ran out (the app hears ``expired``)."""
    from . import pip_app_actions as actions
    from .pips import PipStore
    rows = registry.db.execute("SELECT id FROM pip_app_actions WHERE status='pending' AND expires_at<=? "
                               "AND json_extract(payload,'$.server') LIKE 'app:%' ORDER BY expires_at LIMIT ?",
                               (registry.clock(), limit)).fetchall()
    if not rows:
        return 0
    store = PipStore(registry)
    for (action_id,) in rows:
        with contextlib.suppress(RegistryError):
            actions.get(store, action_id)
    return len(rows)


_SENDER: dict[str, threading.Thread] = {}
_SENDER_LOCK = threading.Lock()


def tick(registry, config) -> None:
    """The runner's heartbeat: expire what ran out, and send what is due on a thread of its own (a slow app never
    holds the runner up). Never raises."""
    try:
        expire_due(registry)
    except Exception:                                  # noqa: BLE001
        pass
    try:
        if not due(registry.db):
            return
    except Exception:                                  # noqa: BLE001
        return
    directory = Path(registry.directory)
    key = str(directory)
    with _SENDER_LOCK:
        running = _SENDER.get(key)
        if running is not None and running.is_alive():
            return

        def send():
            from .workspace_registry import WorkspaceRegistry
            try:
                with WorkspaceRegistry(directory) as own:
                    deliver_due(own, config, limit=50)
            except Exception:                          # noqa: BLE001 - the next heartbeat tries again
                pass
        thread = threading.Thread(target=send, name="dgc-pips-app-approvals", daemon=True)
        _SENDER[key] = thread
        thread.start()
