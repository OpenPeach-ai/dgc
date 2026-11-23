"""Ask DGC on a comment thread: a quiet turn of its own that answers in the thread, or changes the artifact and says so
there, or offers wording as suggestions to accept or reject (dgc/artifact_comments keeps the threads).

The turn reads the artifact the way the model's edit_artifact reads it (artifact_service.outline), the part the comment
points at as it is in the current version, and the thread so far. It has three tools: ``reply`` (its words in the
thread), ``edit_artifact`` (the model's own edit tool, held to this one artifact: each change is a new version by DGC,
"From a comment", and every screen hears of it) and, for a doc or a page, ``suggest`` (wording changes the user
accepts or rejects one by one; nothing is written until Accept).

It runs on the user's own model (their default connection, as DGC's other background looks do), never in a chat's
history and never in a Pip: the answer belongs in the thread the user is looking at, a chat in the middle of a reply
isn't kept waiting, and an artifact made in Work, a chat, a Pip or an app is answered the same way.
"""
from __future__ import annotations

import copy
import json

from . import artifact_comments as comments
from . import artifact_service as service
from . import artifact_tools

STEPS = 8
TIMEOUT = 600

SYSTEM = (
    "You answer one comment thread on an artifact the user is looking at in DGC (a document, a page, a deck, a "
    "spreadsheet, a checklist or a dashboard). The user picked part of it and commented. Read the artifact, the part "
    "the comment points at and the thread, then do what the thread's last message asks.\n"
    "- A question: answer it with reply.\n"
    "- Words to change in a document or a page (shorter, clearer, friendlier, a fix): offer them with suggest, each as "
    "{old: the exact words in it now, new: the words instead}; the user accepts or rejects each one. Then reply in a "
    "sentence. If the comment says to make the change yourself, use edit_artifact instead.\n"
    "- Anything else to change (a cell, a slide, a checklist item's status or note, adding or removing something): "
    "use edit_artifact with edits (the smallest exact change), then reply saying what you changed.\n"
    "Change only what the comment is about; never rewrite the rest. Always finish with reply: one to three short, "
    "plain sentences, written to the user.")

REPLY = {"type": "function", "function": {
    "name": "reply",
    "description": "Your answer in the comment's thread, to the user. Call it once, last: after edit_artifact say what "
                   "you changed; after suggest say what you suggest.",
    "parameters": {"type": "object", "properties": {
        "text": {"type": "string", "description": "One to three short sentences."}},
        "required": ["text"]}}}

SUGGEST = {"type": "function", "function": {
    "name": "suggest",
    "description": "Offer wording changes the user accepts or rejects one by one (nothing changes until they accept). "
                   "Each change's old is the exact words in the artifact now, found once; new is the words instead.",
    "parameters": {"type": "object", "properties": {
        "changes": {"type": "array", "items": {"type": "object", "properties": {
            "old": {"type": "string"}, "new": {"type": "string"}}, "required": ["old", "new"]}}},
        "required": ["changes"]}}}


def _edit_tool(aid: str, kind: str) -> dict:
    """The model's edit_artifact, held to this artifact and, but for a page (whose change is its whole HTML), to exact
    edits: a comment changes what it is about, never the whole of it (a deck rewritten whole lost its theme)."""
    tool = copy.deepcopy(artifact_tools.EDIT_ARTIFACT)
    fn = tool["function"]
    props = fn["parameters"]["properties"]
    props.pop("title", None)
    props.pop("data", None)
    if kind == "page":
        fn["description"] = (f"Change this page ({aid}): its whole new HTML as content, the same page with only what the "
                             "comment asks changed. Each change is a new version the user can go back to.")
    else:
        props.pop("content", None)
        fn["description"] = (f"Change this artifact ({aid}) with exact edits: only what the comment is about. Each change "
                             "is a new version the user can go back to. Called with no edits, it reads the artifact as "
                             "it is now.")
    fn["parameters"]["required"] = []
    return tool


def client_for(config):
    """The user's own model on their default connection, bounded, its use counted as the comments'."""
    from . import usage_ledger
    from .llm import LLMClient, normalize_usage, usage_reported
    client = LLMClient(config.base_url, config.api_key, config.model,
                       read_timeout=min(int(config.get("request_timeout", TIMEOUT) or TIMEOUT), 1800),
                       think_budget_tokens=config.get("think_budget_tokens", "auto"),
                       ollama_keep_alive=str(config.get("ollama_keep_alive", "30m")),
                       api_mode=str(config.get("api_mode", "auto")),
                       provider_capabilities=config.get("provider_capabilities", {}),
                       capability_cache_ttl_s=int(config.get("capability_cache_ttl_s", 300)),
                       context_size=int(config.get("context_size", 0) or 0), local_waits=False)

    def ledger(finished, result):
        try:
            raw = getattr(result, "usage", None)
            usage = normalize_usage(raw)
            transport = str(getattr(finished, "api_mode", "") or "")
            provider = ({"ollama": "ollama", "anthropic": "anthropic"}.get(transport)
                        or getattr(finished, "family", "") or "unknown")
            from .usage_systems import system_for_url
            usage_ledger.record(provider=provider, base_url=getattr(finished, "base_url", ""),
                                model=getattr(finished, "model", ""), source="comments",
                                input_tokens=usage["input_tokens"], output_tokens=usage["output_tokens"],
                                cached_input_tokens=usage["cached_input_tokens"], metered=usage_reported(raw),
                                system_id=system_for_url(config, getattr(finished, "base_url", "")))
        except Exception:                                  # noqa: BLE001 -- the ledger never costs an answer
            pass
    client.usage_source = "comments"
    client.usage_sink = ledger
    return client


# How each kind is changed with exact edits, said in the turn (a small model guessed a deck's op fields five times over).
HOW = {
    "doc": ('Words to change: offer them with suggest, [{"old": "the exact words in it now", "new": "the new words"}]. '
            'Only when the comment says to make the change yourself: edit_artifact with edits like [{"find": "the exact '
            'words in it now", "replace": "the new words"}].'),
    "slides": ('Change it with edits; slides are numbered from 1. A slide\'s field, whole: [{"op": "set", "slide": 2, '
               '"field": "bullets", "value": ["first point", "second point", "a new point"]}] (field is one of title, '
               'subtitle, bullets, left, right, quote, table, notes, layout; value is the field\'s whole new value, so '
               'keep the points that stay). A new slide: {"op": "insert", "at": 3, "slide": {"layout": "bullets", '
               '"title": "…", "bullets": ["…"]}}. Also {"op": "delete", "slide": 3}, {"op": "move", "slide": 3, '
               '"to": 1}, {"op": "replace", "slide": 2, "with": {…a whole slide…}}.'),
    "sheet": ('Change it with edits; cells are A1 addresses (row 1 holds the column names, data starts at row 2): '
              '[{"op": "set", "sheet": "Budget", "cell": "B4", "value": 1200}] (a formula as "=SUM(B2:B9)"; "values": '
              '[[…]] writes a block from that cell). Rows: {"op": "insert_rows", "row": 5, "rows": [[…]]}, {"op": '
              '"delete_rows", "row": 5, "count": 1}. Columns: {"op": "insert_columns", "column": "C", "columns": '
              '[{"name": "Notes", "type": "text"}]}.'),
    "dashboard": ('Change it with edits like [{"op": "change_widget", "id": "revenue", "set": {"title": "…"}}], {"op": '
                  '"add_widget", "widget": {…}}, {"op": "remove_widget", "id": "…"}.'),
    "checklist": ('Change one item per edit_artifact call: [{"op": "set", "item": "c2", "status": "Building", "note": '
                  '"what you did, or what you need"}] (status: Not started, Building, Testing, Checked live, Needs you, '
                  'Done; Done needs a note and proof, Needs you a note). A new item: {"op": "add", "title": "…", '
                  '"done_when": "…"}.'),
    "page": ('Words to change: offer them with suggest, [{"old": "the exact words in its HTML now", "new": "the new '
             'words"}]. Anything else, or when the comment says to make the change yourself: edit_artifact with content, '
             'the whole page\'s HTML, the same page with only what the comment asks changed.'),
}


def _pointed(thread: dict, view: dict) -> str:
    anchor = thread["anchor"]
    lines = [f"The comment points at {thread['where']}"
             + {"here": ".", "moved": " (it moved there since the comment was made).",
                "changed": " (it is not in the artifact any more; the user saw it in an earlier version)."}.get(thread["found"], ".")]
    if thread["version"] != view["version"]:
        lines.append(f"The comment was made on version {thread['version']}; the artifact is at version {view['version']} now.")
    if anchor.get("quote"):
        lines.append(f"The words it picked: “{anchor['quote']}”")
    if anchor.get("kind") == "cells" and anchor.get("values") is not None:
        lines.append(f"What cells {anchor['range']} held then: {json.dumps(anchor['values'], ensure_ascii=False)}")
    if anchor.get("kind") == "item":
        lines.append(f"The checklist item: {anchor['item']}" + (f" “{anchor['title']}”" if anchor.get("title") else ""))
    if thread.get("part"):
        lines.append("What is there now:\n" + thread["part"])
    return "\n".join(lines)


def _said(thread: dict) -> str:
    lines = []
    for m in thread.get("messages") or []:
        who = "You" if str(m.get("by")).lower() == "you" else "DGC"
        if m.get("kind") == "error":
            continue
        lines.append(f"{'The user' if who == 'You' else 'DGC'}: {m.get('text')}")
    for s in thread.get("suggestions") or []:
        lines.append(f"(DGC suggested “{s['old']}” → “{s['new']}”: {s['state']})")
    return "\n".join(lines)


def prompt(aid: str, tid: str, *, store=None) -> list[dict]:
    view = service.view(aid, store=store)
    thread = next((t for t in comments.threads(aid, store=store) if t["id"] == tid), None)
    if thread is None:
        raise comments.CommentError("That comment isn't there any more.")
    body = (f"The artifact:\n{service.outline(aid, store=store)}\n\n{_pointed(thread, view)}\n\n"
            f"The thread so far:\n{_said(thread)}\n\n{HOW.get(view['type'], '')}\nAnswer the thread's last message.")
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": body}]


def answer(aid: str, tid: str, *, config=None, client=None, on_change=None, on_threads=None, store=None) -> dict:
    """Answer one thread now (the caller runs this on a thread of its own). ``on_change(view, op)`` tells every screen
    the artifact changed; ``on_threads()`` tells them the threads did (answering, a change said, the answer)."""
    def told():
        if callable(on_threads):
            try:
                on_threads()
            except Exception:                              # noqa: BLE001 -- a screen never stops the answer
                pass

    comments.answering(aid, tid, True, store=store)
    told()
    changed = {"version": 0}
    try:
        messages = prompt(aid, tid, store=store)
        kind = service.view(aid, versions=False, store=store)["type"]
        tools = [REPLY, _edit_tool(aid, kind)] + ([SUGGEST] if kind in comments.SUGGEST_TYPES else [])
        model = client if client is not None else client_for(config)
        replied = False
        for _step in range(STEPS):
            result = model.chat(messages, tools=tools)
            calls = list(getattr(result, "tool_calls", None) or [])
            if not calls:
                words = str(getattr(result, "content", "") or "").strip()
                if words:
                    comments.reply(aid, tid, words, by="DGC", kind="answer", store=store)
                    replied = True
                break
            messages.append({"role": "assistant", "content": str(getattr(result, "content", "") or ""),
                             "tool_calls": [{"id": c.id, "type": "function",
                                             "function": {"name": c.name, "arguments": json.dumps(c.arguments)}}
                                            for c in calls]})
            for c in calls:
                out = _run(aid, tid, c.name, c.arguments if isinstance(c.arguments, dict) else {}, changed,
                           on_change=on_change, store=store)
                messages.append({"role": "tool", "tool_call_id": c.id, "content": out})
                if c.name == "reply" and not out.startswith("error"):
                    replied = True
            told()
            if replied:
                break
        if not replied:
            comments.reply(aid, tid, "DGC didn't answer this one. Try Ask DGC again, or pick another model in "
                           "Settings.", by="DGC", kind="error", store=store)
    except comments.CommentError:
        raise
    except Exception as exc:                               # noqa: BLE001 -- said in the thread, never lost
        why = str(exc).strip() or type(exc).__name__
        try:
            from .llm import explain_llm_error
            plain = explain_llm_error(why, model=getattr(config, "model", "") or "", base_url=getattr(config, "base_url", "") or "")
        except Exception:                                  # noqa: BLE001
            plain = ""
        words = plain if plain and why in plain else f"{plain} ({why})" if plain else why
        try:
            comments.reply(aid, tid, f"DGC couldn't answer: {words}"[:comments.MAX_TEXT], by="DGC", kind="error", store=store)
        except comments.CommentError:
            pass
    finally:
        try:
            comments.answering(aid, tid, False, store=store)
        except comments.CommentError:
            pass                                           # deleted meanwhile
        told()
    return comments.get(aid, tid, store=store)


def _run(aid: str, tid: str, name: str, args: dict, changed: dict, *, on_change=None, store=None) -> str:
    """One of the turn's tools; what the model reads back."""
    try:
        if name == "reply":
            text = str(args.get("text") or "").strip()
            if not text:
                return "error: give your answer's words in text."
            # (The thread stays open: the person resolves it once they have seen the answer, or the change.)
            comments.reply(aid, tid, text, by="DGC", kind="answer", store=store)
            return "Said in the thread."
        if name == "suggest":
            made = comments.suggest(aid, tid, args.get("changes"), store=store)
            return (f"Suggested {len(made)} change{'s' if len(made) != 1 else ''}; the user accepts or rejects each. "
                    "Now reply in a sentence.")
        if name == "edit_artifact":
            asked = str(args.get("id") or aid)
            if asked != aid:
                return f"error: from this comment you can change only {aid}, the artifact it is on."
            reading = args.get("edits") is None and args.get("content") is None and args.get("data") is None
            kind = service.view(aid, versions=False, store=store)["type"]
            if args.get("data") is not None or (args.get("content") is not None and kind != "page"):
                return ("error: nothing changed. From a comment, change only what it is about: give edits (the "
                        "smallest exact change), not the whole artifact.")
            before = service.view(aid, versions=False, store=store)["version"]
            note = " ".join(str(args.get("note") or "").split())[:120]
            call = {**{k: v for k, v in args.items() if k != "title"}, "id": aid,
                    **({} if reading else {"note": f"From a comment: {note or 'a change'}"})}
            out = artifact_tools.run("edit_artifact", call, origin={"surface": "editor", "app": "comments"},
                                     author="DGC", on_change=on_change)
            if out.startswith("error") or reading:
                return out
            view = service.view(aid, store=store)
            if view["version"] == before:
                return out + " (Those edits left it as it was: nothing changed.)"
            changed["version"] = view["version"]
            pairs = [(e.get("find"), e.get("replace") or "") for e in (args.get("edits") or [])
                     if isinstance(e, dict) and isinstance(e.get("find"), str)]
            comments.reanchor(aid, tid, replaced=pairs, store=store)   # (the thread points at its place as it is now)
            summary = str((view.get("versions") or [{}])[-1].get("summary") or "").replace("From a comment: ", "", 1)
            comments.reply(aid, tid, f"Changed it: {summary or 'a change'} (version {view['version']}).", by="DGC",
                           kind="change", store=store, version=view["version"])
            return out + " Now reply in the thread saying what you changed."
        return f"error: {name} isn't a tool here. Use reply, edit_artifact or suggest."
    except service.ArtifactUseError as exc:
        return f"error: {exc}"
