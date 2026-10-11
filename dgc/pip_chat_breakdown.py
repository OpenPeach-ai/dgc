"""A Personal Pip's context window, part by part (CONTEXT_BREAKDOWN_PLAN.md, part 3), as Claude's Usage sheet
shows it and as ChatDGC and main DGC show theirs (dgc/context_breakdown.py).

A Pip's reply is built by its worker from what was pinned when it was queued, so the parts that stay from one
reply to the next (its instructions, its tools, its job, its memory, its skills and apps, its references) are
measured there, as that reply sent them, and kept with the reply (its result's "context"). The meter adds what
changes with every message, the conversation brief and the recent messages, as the next reply will send them
(pip_chat_continuity.prepare). About four bytes a token, as the Pip meter has always counted.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

VERSION = 1
FIXED = {"system_prompt": "System prompt", "tools": "Tools", "instructions": "Its job", "memory": "Memory",
         "skills": "Skills", "plugins": "Connected apps", "data": "References"}
MAX_TOKENS = 1 << 24
MAX_ITEMS = 60
MAX_RESULT_BYTES = 262144


def tokens(value) -> int:
    """About four bytes a token, of text or of the JSON a value is sent as."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    return (len(text.encode()) + 3) // 4


def measure(system, tools, prompt, *, job, memory=(), skills=(), skills_text="", apps="", changing=()) -> dict:
    """The parts of one reply's request that stay for the next. `system`: its system prompt; `tools`: the schemas
    it was offered; `prompt`: its turn as sent; `job`: its job's reference; `memory`: [(name, what's sent)];
    `skills`: [(name, its line)], sent as `skills_text`; `apps`: the connected-apps note; `changing`: what in the
    turn changes with each message (the brief, the message, its files), left out. The rest of the turn is its
    references (its last report, its schedule, web and app reads, the user's other Pips)."""
    memory = [(name, tokens(value)) for name, value in memory if value]
    tool_items = [(str(t.get("function", {}).get("name") or "tool"), tokens(t)) for t in tools or []]
    known = tokens(job) + sum(n for _, n in memory) + (tokens(skills_text) if skills_text else 0) \
        + (tokens(apps) if apps else 0) + sum(tokens(value) for value in changing if value)
    parts = [("system_prompt", tokens(system or ""), None),
             ("tools", sum(n for _, n in tool_items), tool_items),
             ("instructions", tokens(job), None),
             ("memory", sum(n for _, n in memory), memory),
             ("skills", tokens(skills_text) if skills_text else 0, [(name, tokens(line)) for name, line in skills]),
             ("plugins", tokens(apps) if apps else 0, None),
             ("data", max(0, tokens(prompt) - known), None)]
    out = []
    for id, n, items in parts:
        if n <= 0:
            continue
        part = {"id": id, "label": FIXED[id], "tokens": min(n, MAX_TOKENS)}
        kept = sorted(((str(name)[:120], min(t, MAX_TOKENS)) for name, t in items or [] if t > 0), key=lambda i: -i[1])
        if kept:
            part["items"] = [{"name": name, "tokens": t} for name, t in kept[:MAX_ITEMS]]
        out.append(part)
    return validate({"version": VERSION, "parts": out})


def validate(value) -> dict:
    """A reply's measure as the worker returns it and as it is read back: anything else is refused."""
    def count(n):
        return type(n) is int and 0 <= n <= MAX_TOKENS
    bad = RegistryError("invalid_reply", "This reply's context measure is invalid.")
    if (not isinstance(value, dict) or set(value) != {"version", "parts"} or value["version"] != VERSION
            or not isinstance(value["parts"], list) or len(value["parts"]) > len(FIXED)):
        raise bad
    seen = set()
    for part in value["parts"]:
        if (not isinstance(part, dict) or not {"id", "label", "tokens"} <= set(part) <= {"id", "label", "tokens", "items"}
                or part["id"] not in FIXED or part["id"] in seen or part["label"] != FIXED[part["id"]]
                or not count(part["tokens"])):
            raise bad
        items = part.get("items", [])
        if (not isinstance(items, list) or len(items) > MAX_ITEMS
                or any(not isinstance(i, dict) or set(i) != {"name", "tokens"} or not isinstance(i["name"], str)
                       or len(i["name"]) > 120 or not count(i["tokens"]) for i in items)):
            raise bad
        seen.add(part["id"])
    return value


def last_parts(store, pip_id) -> list[dict]:
    """What its newest reply measured, or nothing: a Pip that hasn't replied yet, or replied on a DGC from before
    this, shows its brief and its messages only."""
    row = store.db.execute(
        "SELECT CASE WHEN length(CAST(r.result AS BLOB))<=? THEN r.result END AS result FROM pip_chat_messages m "
        "JOIN pip_runs r ON r.id=m.run_id WHERE m.pip_id=? AND m.role='assistant' AND r.status='succeeded' "
        "ORDER BY m.seq DESC LIMIT 1", (MAX_RESULT_BYTES, pip_id)).fetchone()
    try:
        saved = json.loads(row["result"]).get("context") if row and row["result"] else None
        return validate(saved)["parts"] if saved is not None else []
    except (ValueError, AttributeError, RegistryError):
        return []


def breakdown(parts, *, brief, recent, window, compact_at) -> dict:
    """The meter's breakdown: the parts its last reply measured, then its brief and the recent messages as the
    next reply sends them (`brief`, `recent`: their tokens)."""
    from . import context_breakdown as shape
    cats = [shape.category(p["id"], p["label"], p["tokens"], [(i["name"], i["tokens"]) for i in p.get("items", [])])
            for p in parts]
    cats += [shape.category("summary", "Conversation brief", brief), shape.category("messages", "Messages", recent)]
    return shape.build(window, cats, compact_at=compact_at)
