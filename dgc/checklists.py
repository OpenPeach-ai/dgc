"""A project's checklist, for the chats that work in it.

A checklist (``dgc.artifact_checklist``, kept by ``dgc.artifact_service`` like every artifact) made in a project is
pinned to that project. This module is what every chat there goes by:

- ``turn_note``: a new chat is told the pinned checklist and where to carry on (the first item not done), once; and
  told again only when it changed since this chat last read it (the user ticked, reopened or changed what done means).
- ``since``: what changed after the version a chat last read, said with the model's next look at it.
- ``goal_from`` / ``goal_state`` / ``goal_note``: ``/goal checklist`` runs from it item by item; the goal ends when
  every item is Done, or when one needs the user (it says which and why).

Which version each chat last read is kept for this process only: a chat that comes back after a restart is told the
checklist whole again, which is what it needs.
"""
from __future__ import annotations

import re
import threading

from . import artifact_checklist as checklist
from . import artifact_service as service
from .artifact_store import ARTIFACT_ID, ArtifactError, Store

_SEEN: dict[tuple[str, str], int] = {}
_LOCK = threading.Lock()
_MAX_SEEN = 4000


def forget() -> None:
    """Nothing has been read (a test's clean start)."""
    with _LOCK:
        _SEEN.clear()


def reader_of(origin) -> str:
    """Who is reading: the Work session, the chat or the Pip an origin names."""
    o = origin if isinstance(origin, dict) else {}
    return str(o.get("session") or o.get("chat") or o.get("pip") or o.get("app") or "")


def seen(reader: str, aid: str) -> int | None:
    with _LOCK:
        return _SEEN.get((str(reader or ""), aid))


def mark(reader: str, aid: str, version: int) -> None:
    with _LOCK:
        if len(_SEEN) > _MAX_SEEN:
            _SEEN.clear()
        _SEEN[(str(reader or ""), aid)] = int(version)


def unsee(reader: str) -> None:
    """This reader's context lost what it read (its conversation was compacted): it is told again at its next turn."""
    with _LOCK:
        for key in [key for key in _SEEN if key[0] == str(reader or "")]:
            del _SEEN[key]


def _source(aid: str, n: int | None, store: Store | None):
    return service._store(store).source(aid, n)


def for_project(project, *, store: Store | None = None, pinned_only: bool = True) -> list[dict]:
    """The project's checklists as views (with ``progress``), the latest change first."""
    if not project:
        return []
    place = service.place_of({"project": str(project)})
    found = []
    for art in service._store(store).list(type="checklist"):
        if service.place_of(art.origin) != place:
            continue
        try:
            view = service.view(art.id, store=store, versions=False)
        except (ArtifactError, OSError, ValueError):
            continue
        if pinned_only and not (view.get("progress") or {}).get("pinned"):
            continue
        found.append(view)
    found.sort(key=lambda v: str(v.get("updated") or ""), reverse=True)
    return found


def current(project, *, store: Store | None = None) -> dict | None:
    """The pinned checklist a chat carries on from: the latest changed one with an item not done."""
    for view in for_project(project, store=store):
        if (view.get("progress") or {}).get("next"):
            return view
    return None


def since(aid: str, version: int, *, store: Store | None = None) -> tuple[list[str], set, bool]:
    """What changed after ``version``: the lines to say, the items the user changed, and whether only the user did."""
    st = service._store(store)
    now = st.get(aid).version
    if version >= now:
        return [], set(), True
    try:
        lines = checklist.describe(st.source(aid, version), st.source(aid, now))
    except (ArtifactError, OSError, ValueError, KeyError):
        return [], set(), True
    theirs, only_user = set(), True
    for ver in st.versions(aid):
        if ver.n <= version:
            continue
        if str(ver.author).casefold() != "you":
            only_user = False
            continue
        try:
            theirs |= checklist.changed_items(st.source(aid, ver.n - 1), st.source(aid, ver.n))
        except (ArtifactError, OSError, ValueError, KeyError):
            continue
    return lines, theirs, only_user


def changed_words(lines: list[str], only_user: bool) -> str:
    who = "The user changed it" if only_user else "It changed (the user's ticks and another chat's work)"
    return f"{who} since you last read it: " + "; ".join(lines[:12]) + ". Go by what it says now."


def turn_note(project, reader: str, *, store: Store | None = None) -> tuple[str, str] | None:
    """(key, text) for this turn's notes, or None: the pinned checklist for a chat that hasn't read it, or what changed
    since it did."""
    try:
        view = current(project, store=store)
        if view is None:
            return None
        aid, version = view["id"], view["version"]
        last = seen(reader, aid)
        if last is not None and last >= version:
            return None
        data = _source(aid, version, store)
        head = f"“{view['title']}” ({aid}, version {version})"
        nxt = view["progress"]["next"]
        carry = (f"Carry on from {nxt['id']} “{nxt['title']}” when the user asks you to continue, or to work on this "
                 "job; a request about something else comes first. As you work an item: mark it Building, do it, prove "
                 "what its “done when” says, then mark it Done with a note and its proof. The user ticks and reopens "
                 "items too: the checklist as it is now is what counts.")
        if last is None:
            text = (f"# This project's checklist\n{head} is pinned to this project: the job it tracks carries over "
                    f"from chat to chat.\n{checklist.outline(data)}\n{carry}")
            others = [v for v in for_project(project, store=store) if v["id"] != aid and (v.get("progress") or {}).get("next")]
            if others:
                text += "\nAlso pinned here: " + "; ".join(
                    f"“{v['title']}” ({v['id']}, {v['progress']['done']} of {v['progress']['total']} done)"
                    for v in others[:5]) + "."
        else:
            lines, _theirs, only_user = since(aid, last, store=store)
            text = (f"# This project's checklist changed\n{head}: "
                    + (changed_words(lines, only_user) if lines else "it has a new version.")
                    + f"\n{checklist.standing(data)}\n{carry}")
        mark(reader, aid, version)
        return f"checklist:{aid}:{version}", text
    except Exception:                                      # noqa: BLE001 -- a note is a courtesy, never a failed turn
        return None


# ---- /goal from a checklist -----------------------------------------------------------------------------------
_GOAL_WORD = re.compile(r"(?:the\s+)?checklist(?:\s+(.+))?\Z", re.I | re.S)
_GOAL_OPENS = re.compile(r"Work through the checklist “[^\n]*” \((ar_[a-f0-9]{16})\)")
NO_CHECKLIST = ("This project has no checklist with items left. Ask DGC to make one first (\"make a checklist for … and "
                "work through it\"), then /goal checklist.")


def goal_objective(view: dict, data: dict) -> str:
    return (f"Work through the checklist “{view['title']}” ({view['id']}) item by item, in order, until every item "
            "is Done.\nFor each item: mark it Building, do the work, prove what its “done when” says, then mark it "
            "Done with a note of what you did and its proof (edit_artifact, one item per call). If only the user can "
            "unblock an item, mark it Needs you and say why in its note: the goal stops there and tells them. The "
            "user may tick, reopen or change items while you work: read it again and go by what it says.\n\n"
            "The checklist when the goal started:\n" + checklist.outline(data))


def goal_from(text: str, project, *, store: Store | None = None) -> tuple[str, str] | None:
    """``/goal checklist [NAME]``: (the checklist's id, the objective) to run from the project's pinned checklist (the
    one named, when the project has several). None when ``text`` is an ordinary objective. ValueError (in the user's
    words) when it asks for the checklist and there is none to run."""
    clean = str(text or "").strip()
    opened = _GOAL_OPENS.match(clean)
    if opened:
        # The objective this module wrote, handed back (a goal edited or resumed): still tied to its checklist.
        try:
            if service._store(store).get(opened[1]).type == "checklist":
                return opened[1], clean
        except ArtifactError:
            pass
        return None
    asked = _GOAL_WORD.fullmatch(clean)
    if not asked:
        return None
    name = service.same_name(asked[1] or "")
    open_ones = [v for v in for_project(project, store=store, pinned_only=False) if (v.get("progress") or {}).get("next")]
    if name:
        words = name.split()
        named = [v for v in open_ones if all(w in service.same_name(v["title"]) for w in words)]
        if not named:
            return None                     # an objective that happens to start with the word
        view = named[0]
    else:
        pinned = [v for v in open_ones if v["progress"].get("pinned")]
        if not (pinned or open_ones):
            raise ValueError(NO_CHECKLIST)
        view = (pinned or open_ones)[0]
    return view["id"], goal_objective(view, _source(view["id"], view["version"], store))


def valid_id(value) -> bool:
    return isinstance(value, str) and bool(ARTIFACT_ID.fullmatch(value))


def goal_state(aid: str, *, store: Store | None = None) -> dict:
    """Where a goal's checklist stands after a turn: ``{"state": "done" | "needs" | "open" | "gone", "line", …}``."""
    try:
        view = service.view(aid, store=store, versions=False)
        data = _source(aid, view["version"], store)
    except (ArtifactError, OSError, ValueError):
        return {"state": "gone", "line": "The goal's checklist was removed."}
    items = data.get("items") or []
    p = checklist.progress(data)
    if p["needs"]:
        item = next(i for i in items if i["id"] == p["needs"][0])
        why = " ".join(str(item.get("note") or "").split())[:600]
        return {"state": "needs", "version": view["version"],
                "line": (f"{item['id']} “{item['title']}” needs you" + (f": {why}" if why else ".")
                         + f" ({p['done']} of {p['total']} done on “{view['title']}”. Answer it, set the item back "
                         "to Not started or tick it, then resume the goal.)")}
    if p["next"] is None:
        evidence = [f"{i['id']} {i['title']}: {' '.join(str(i.get('note') or '').split())[:300]}"
                    + (f" [{checklist._proof_words(i)[:300]}]" if i.get("proof") else "") for i in items[:12]]
        return {"state": "done", "version": view["version"], "evidence": evidence,
                "line": f"Every item on the checklist “{view['title']}” is Done ({p['done']} of {p['total']})."}
    left = [f"{i['id']} “{i['title'][:60]}” ({i['status']})" for i in items if i["status"] != checklist.DONE]
    return {"state": "open", "version": view["version"], "open": left,
            "line": f"{p['done']} of {p['total']} done on “{view['title']}”."}


def goal_note(aid: str, reader: str = "", *, store: Store | None = None) -> str:
    """What each goal turn is told of its checklist: the list as it is now, and the one item to work."""
    try:
        view = service.view(aid, store=store, versions=False)
        data = _source(aid, view["version"], store)
    except (ArtifactError, OSError, ValueError):
        return ""
    mark(reader, aid, view["version"])
    nxt = checklist.progress(data)["next"]
    lead = (f"Work {nxt['id']} “{nxt['title']}” now, and only it: " if nxt else "Every item is Done. ")
    return (f"The goal's checklist “{view['title']}” ({aid}, version {view['version']}) as it is now (the user may have "
            f"changed it):\n{checklist.outline(data)}\n{lead}"
            + ("when it is proved, mark it Done with its note and proof, then go on to the next. The goal ends by "
               "itself when every item is Done; don't report it complete before." if nxt else ""))
