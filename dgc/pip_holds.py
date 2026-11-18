"""A Pip at Do it all never shows an approval card: what still needs the user is held and asked in its chat (0.52).

His rule (17 Nov): "The whole point of do it all in pips and auto in work, is that it never shows any approval card or
anything, but it could still ask user things in chat", and "DGC itself should still hold the action until you answer —
yes, so it asks, rather than an allow card."

A held step:
- Nothing runs, no card is drawn and nothing is added to Needs you. The Pip is told to ask the user in one plain
  sentence in its reply, and to carry on with the rest.
- It is kept in the registry for a day, so it outlives the run: a Pip runs again and again, unlike a Work session.
- It runs once when the Pip makes the same step again with "confirm": true, in a later chat turn that the user's own
  message started.
- A routine's run, a turn DGC started, or the run that asked never answers it. Neither do a page, a file or a tool's
  words: they never start a turn of the user's own.
- While anything is held, the Pip's next turn the user starts carries one line naming it (still_waiting).

Work's auto mode does the same in memory (Agent._held_in_chat), since a Work session is one process.
"""
from __future__ import annotations

import hashlib
import json
import time

KEY = "pip_hold:"
KEEP_SECONDS = 24 * 3600
MAX_HELD = 20                   # per Pip: the oldest go first


def key_of(kind: str, payload) -> str:
    """The step's identity: what it does, exactly (a tool and its inputs, a site and its route and amount)."""
    blob = json.dumps({"kind": kind, "step": payload}, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                      default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


def _row_key(pip_id: str, key: str) -> str:
    return f"{KEY}{pip_id}:{key}"


def _rows(registry, pip_id: str) -> list[dict]:
    prefix = (KEY + str(pip_id) + ":").replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%")
    rows = registry.db.execute("SELECT key, value FROM metadata WHERE key LIKE ? ESCAPE '\\'", (prefix + "%",)).fetchall()
    out = []
    for row in rows:
        try:
            value = json.loads(row[1])
        except (TypeError, ValueError):
            continue
        if isinstance(value, dict) and value.get("pip_id") == pip_id:
            out.append(value)
    return out


def _fresh(value: dict, now: float) -> bool:
    return now - float(value.get("at") or 0) < KEEP_SECONDS


def hold(registry, pip_id: str, kind: str, payload, *, what: str, why: str, run_id) -> str:
    """Hold this step for the user's answer in the chat. Returns the line the Pip gets."""
    now = time.time()
    key = key_of(kind, payload)
    existing = registry.db.execute("SELECT value FROM metadata WHERE key=?", (_row_key(pip_id, key),)).fetchone()
    first = None
    if existing is not None:
        try:
            first = json.loads(existing[0])
        except (TypeError, ValueError):
            first = None
    if not (isinstance(first, dict) and _fresh(first, now)):
        value = {"pip_id": pip_id, "kind": kind, "key": key, "what": str(what)[:300], "why": str(why)[:300],
                 "run_id": run_id, "at": now}
        with registry.transaction():
            kept = sorted((v for v in _rows(registry, pip_id) if v.get("key") != key), key=lambda v: float(v.get("at") or 0))
            while len(kept) >= MAX_HELD:
                old = kept.pop(0)
                registry.db.execute("DELETE FROM metadata WHERE key=?", (_row_key(pip_id, str(old.get("key") or "")),))
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                (_row_key(pip_id, key), json.dumps(value, ensure_ascii=False, separators=(",", ":"))))
    return line(what, why)


def line(what: str, why: str) -> str:
    return (f"WAITING FOR THE USER: {what} needs the user's yes ({why}). Nothing ran, and no card shows: at Do it all you "
            "ask in the chat. Ask them in one plain sentence in your reply (what you want to do, and why), and carry on "
            "with everything that doesn't depend on it; don't do the same thing another way meanwhile. When their own next message says yes, make the same call again "
            "(add \"confirm\": true) and it runs once; if it says no, leave it.")


def release(registry, pip_id: str, kind: str, payload, *, run_id, user_turn: bool, unattended: bool,
            any_of_kind: bool = False) -> tuple[bool, str]:
    """(runs, why not) for a held step made again. It runs once: in a later run than the one that asked, which the user's
    own message started (as Work's holds: making it again then is the yes; "confirm" is the model saying so); the hold
    is then gone. any_of_kind: the user's yes was to the kind itself (emptying its Files), so another wording of the
    step, held earlier, counts (live check, 18 Nov: the model wrote the command again its own way)."""
    key = key_of(kind, payload)
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (_row_key(pip_id, key),)).fetchone()
    value = None
    if row is not None:
        try:
            value = json.loads(row[0])
        except (TypeError, ValueError):
            value = None
    if (value is None or value.get("run_id") == run_id) and any_of_kind:
        earlier = [v for v in waiting(registry, pip_id) if v.get("kind") == kind and v.get("run_id") != run_id]
        if earlier:
            value = earlier[0]
            key = str(value.get("key") or "")
    if not isinstance(value, dict) or not _fresh(value, time.time()):
        return False, "the user wasn't asked about this exact step"
    if unattended or not user_turn:
        return False, "only your reply to the user's own message can answer it"
    if value.get("run_id") == run_id:
        return False, "the user hasn't answered yet: ask in your reply and wait for their next message"
    with registry.transaction():
        registry.db.execute("DELETE FROM metadata WHERE key=?", (_row_key(pip_id, key),))
    return True, ""


def is_held(registry, pip_id: str, kind: str, payload) -> bool:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (_row_key(pip_id, key_of(kind, payload)),)).fetchone()
    if row is None:
        return False
    try:
        return _fresh(json.loads(row[0]), time.time())
    except (TypeError, ValueError):
        return False


def waiting(registry, pip_id: str) -> list[dict]:
    """What this Pip still holds for the user, oldest first."""
    now = time.time()
    return sorted((v for v in _rows(registry, pip_id) if _fresh(v, now)), key=lambda v: float(v.get("at") or 0))


def still_waiting(registry, pip_id: str) -> str:
    """The one line a chat turn the user started carries while something is held for them; "" when nothing is."""
    held = waiting(registry, pip_id)
    if not held:
        return ""
    listed = "; ".join(v["what"] for v in held[:5]) + (f"; and {len(held) - 5} more" if len(held) > 5 else "")
    return ("Still waiting on the user (you asked in the chat): " + listed + ". If their message answers it, make that "
            "call again with \"confirm\": true; if it doesn't, say in one short line that it still waits on them.")


def made_in(registry, pip_id: str, run_id) -> list[dict]:
    """What this run held for the user, oldest first."""
    return [v for v in waiting(registry, pip_id) if v.get("run_id") == run_id]


def reply_line(held: list[dict]) -> str:
    """DGC's own line under a Pip's reply that held something: the model may not have asked (live check, 18 Nov)."""
    listed = "; ".join(f"{v['what']} ({v['why']})" for v in held[:3]) + (f"; and {len(held) - 3} more" if len(held) > 3 else "")
    return f"Waiting for your yes: {listed}. Say yes in your next message and it runs once."


def runtime(registry, run, manifest: dict) -> dict:
    """In the supervisor, as a chat turn the user started begins: the still-waiting line, for the worker's prompt."""
    if not isinstance(manifest.get("conversation"), dict) or manifest.get("user_turn") is not True:
        return manifest
    note = still_waiting(registry, run["pip_id"])
    return {**manifest, "pip_holds_note": note} if note else manifest
