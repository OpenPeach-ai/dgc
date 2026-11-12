"""Core keeps an eye on your day (pips-19).

Once, after the user's first reply from Core, Core offers a daily routine as an ordinary routine card (Add or Not now):
one short message a day about what needs the user today: what waits for their answer or approval in DGC, important
email, today's meetings, what their Pips did. Read only, in its words; on a day with nothing worth saying it stays quiet
(the routine turn's NOTHING_NEW: one faint line, never unread). Offered once: Not now, a routine of that name already
there, or a full routine list means it never comes back. Added, its time and words are the user's to change on Core's
page, like any routine.
"""
from __future__ import annotations

from .workspace_registry import RegistryError, utc_now

KEY = "core_daily_offered:"          # metadata: when Core's day routine was offered
TITLE = "Your day"
TIME = "08:30"
# In the user's own voice, as a routine they wrote reads: the card shows these words, and they are theirs to change.
PROMPT = ("Tell me in one short message what needs me today: anything waiting for my answer or approval in DGC, "
          "important new email, today's meetings, and what my Pips did since yesterday. Read only: never send, change, "
          "book or buy anything, and use only the apps you can already read. If there is nothing worth telling me, "
          "stay quiet.")


def offer(store, run) -> None:
    """After a reply from Core that answers the user (inside the transaction that saves it): the card, once."""
    from .pip_own_changes import user_started
    from . import pip_routines
    registry = store.registry
    pip_id = run["pip_id"]
    if store._job(pip_id).get("pip_type") != "core" or not user_started(store, run):
        return
    if registry.db.execute("SELECT 1 FROM metadata WHERE key=?", (KEY + pip_id,)).fetchone() is not None:
        return
    registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (KEY + pip_id, utc_now()))
    if registry.db.execute("SELECT 1 FROM pip_routines WHERE pip_id=? AND lower(title)=lower(?) LIMIT 1",
                           (pip_id, TITLE)).fetchone() is not None:
        return                                          # one of that name is there already: nothing to offer
    from .pip_starters import local_timezone
    trigger = {"kind": "schedule", "schedule": {"type": "daily", "time": TIME, "timezone": local_timezone() or "UTC"}}
    try:
        pip_routines._insert(store, pip_id, TITLE, PROMPT, trigger, status="suggested", created_by="pip", run_id=run["id"])
    except RegistryError as exc:
        if exc.code != "routine_limit":
            raise
