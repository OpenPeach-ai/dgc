"""What was said, in brief, in the chat that made an artifact: what Ask DGC on a comment reads besides the artifact and
its thread, so "use the hotel we picked" finds the hotel the chat picked.

The artifact's ``origin`` says where it was made (artifact_store.Artifact): a Work session, a ChatDGC chat or a Pip's
chat. Only the last few things said there, words only and each trimmed: never the whole transcript, never a tool's
output, never the system prompt. Nothing where that chat isn't there any more (deleted, never saved, incognito) or the
origin is one this can't read; any failure is nothing, never an error in the comment's answer.
"""
from __future__ import annotations

import re
from pathlib import Path

MAX_MESSAGES = 8          # the last few things said
MAX_EACH = 400            # characters of one of them
MAX_TOTAL = 2400          # of all of them together
_STEM = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\Z")
_TAGS = re.compile(r"</?[a-z][a-z0-9_-]*(?:\s[^>]*)?>", re.I)
_COMPACTED = "[Earlier conversation compacted"


def conversation(origin) -> str:
    """The chat that made it, in brief: its name and the last few things said, or "" when there is nothing to say."""
    if not isinstance(origin, dict):
        return ""
    try:
        surface = origin.get("surface")
        if surface == "chat":
            name, said = _chatdgc(origin)
        elif surface == "work":
            name, said = _work(origin)
        elif surface == "pip":
            name, said = _pip(origin)
        else:
            return ""
    except Exception:                    # noqa: BLE001 -- the comment's answer never fails for its context
        return ""
    lines, total = [], 0
    for role, text in reversed(said[-MAX_MESSAGES:]):
        text = " ".join(_TAGS.sub(" ", str(text or "")).split())
        if not text:
            continue
        if len(text) > MAX_EACH:
            text = text[:MAX_EACH - 1].rstrip() + "…"
        line = f"{'The user' if role == 'user' else 'DGC'}: {text}"
        if total + len(line) > MAX_TOTAL:
            break
        lines.append(line)
        total += len(line) + 1
    if not lines:
        return ""
    title = " ".join(str(name or "").split())[:120]
    return (f"{title}\n" if title else "") + "\n".join(reversed(lines))


def _chatdgc(origin) -> tuple[str, list]:
    from .chatdgc.store import ChatStore
    chat = ChatStore().get(str(origin.get("chat") or ""))
    said = [(m.get("role"), m.get("text")) for m in chat.get("messages") or []
            if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
    return f"ChatDGC chat “{chat.get('title') or 'Chat'}”", said


def _work(origin) -> tuple[str, list]:
    from . import sessions
    stem, project = str(origin.get("session") or ""), str(origin.get("project") or "")
    if not _STEM.fullmatch(stem) or not project or not Path(project).is_absolute():
        return "", []
    path = sessions.project_dir(project) / f"{stem}.json"
    if not path.is_file():
        return "", []
    record = sessions.load_record(path, project)
    said = []
    for m in record.get("messages") or []:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        content = m.get("content")
        if not isinstance(content, str) or not content.strip() or content.startswith(_COMPACTED):
            continue
        said.append((m["role"], content))
    return f"Work session “{record.get('name') or 'Work'}”", said


def _pip(origin) -> tuple[str, list]:
    from .workspace_registry import WorkspaceRegistry, state_directory
    pip_id = str(origin.get("pip") or "")
    if not re.fullmatch(r"pip_[A-Za-z0-9]{1,64}", pip_id):
        return "", []
    with WorkspaceRegistry(state_directory()) as registry:
        rows = registry.db.execute("SELECT role,text FROM pip_chat_messages WHERE pip_id=? ORDER BY seq DESC LIMIT ?",
                                   (pip_id, MAX_MESSAGES)).fetchall()
        from .dgc_browser import _pip_names
        name = _pip_names(registry, [pip_id]).get(pip_id, "")
    return (f"{name}'s chat" if name else "A Pip's chat"), [(r[0], r[1]) for r in reversed(rows)]
