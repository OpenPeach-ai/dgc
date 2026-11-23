"""A ChatDGC project's files a chat can search and read when they don't all fit its window (decided 12 Nov, after
Claude's Projects: "enhanced project knowledge" searches a project's files when they outgrow the context).

A chat in a project is given the project's files within a share of its window (engine._project_context); what doesn't
fit used to be only named. When something didn't fit, the chat is also offered two tools over all of the project's
files: search (the lines that hold some words, with their file and line number) and read (a file in parts, with line
numbers). Text only: a picture stays as it was. Read-only, and only this project's own files.
"""
from __future__ import annotations

MAX_CALLS = 12               # project file calls in one reply
MAX_MATCHES = 60
MAX_READ_CHARS = 60_000
LINE_CHARS = 300

SEARCH_TOOL = {"type": "function", "function": {
    "name": "project_files_search",
    "description": ("Search all of this project's files (including any that didn't fit in your context) for some words: "
                    "the lines that hold them, each with its file and line number. Then read around a match with "
                    "project_file_read."),
    "parameters": {"type": "object", "properties": {
        "text": {"type": "string", "description": "The words to find (not case-sensitive)."}}, "required": ["text"]}}}
READ_TOOL = {"type": "function", "function": {
    "name": "project_file_read",
    "description": ("Read one of this project's files by its name, with line numbers. Long files come in parts: ask for "
                    "the next with start_line."),
    "parameters": {"type": "object", "properties": {
        "name": {"type": "string", "description": "The file's name, as the project lists it."},
        "start_line": {"type": "integer", "description": "The first line to read (1 by default)."}},
        "required": ["name"]}}}
TOOLS = (SEARCH_TOOL, READ_TOOL)
NAMES = frozenset(tool["function"]["name"] for tool in TOOLS)


def _texts(store, project):
    """(name, text) for each of the project's files that has text, in the project's order."""
    from .store import ChatStoreError
    out = []
    for meta in project.get("files") or []:
        if meta.get("kind") == "image":
            continue
        try:
            _raw, text = store.get_project_file(project["id"], meta.get("id", ""))
        except ChatStoreError:
            continue
        if text:
            out.append((str(meta.get("name") or "file"), text))
    return out


def call(store, project, name, args) -> str:
    args = args if isinstance(args, dict) else {}
    files = _texts(store, project)
    if name == "project_files_search":
        words = " ".join(str(args.get("text") or "").split()).casefold()
        if not words:
            return "error: say which words to find."
        found = []
        for file_name, text in files:
            for number, line in enumerate(text.splitlines(), 1):
                if words in line.casefold():
                    found.append(f"{file_name}:{number}: {line.strip()[:LINE_CHARS]}")
                    if len(found) >= MAX_MATCHES:
                        break
            if len(found) >= MAX_MATCHES:
                break
        if not found:
            return f"No line in the project's files holds “{args.get('text')}”."
        more = " (the first matches; search for something narrower to see others)" if len(found) >= MAX_MATCHES else ""
        return f"{len(found)} lines{more}:\n" + "\n".join(found)
    if name == "project_file_read":
        wanted = str(args.get("name") or "").strip()
        match = next((t for n, t in files if n == wanted), None)
        if match is None:
            match = next((t for n, t in files if n.casefold() == wanted.casefold()), None)
        if match is None:
            names = ", ".join(n for n, _ in files[:40]) or "none with text"
            return f"error: the project has no file called “{wanted}”. Its files: {names}."
        start = args.get("start_line", 1)
        start = start if isinstance(start, int) and not isinstance(start, bool) and start >= 1 else 1
        lines = match.splitlines()
        if start > len(lines):
            return f"{wanted} has {len(lines)} lines."
        out, used, number = [], 0, start
        for number in range(start, len(lines) + 1):
            row = f"{number}\t{lines[number - 1]}"
            if used + len(row) > MAX_READ_CHARS and out:
                return "\n".join(out) + f"\n[More from line {number}: read on with start_line={number}.]"
            out.append(row)
            used += len(row) + 1
        return "\n".join(out)
    return "error: unknown project file tool."
