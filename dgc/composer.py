"""Prompt selections shared by terminal and editor composers.

Selections are names, never arbitrary paths or client-supplied instruction bodies. The backend
resolves them against its own project catalog before accepting the prompt.
"""
from __future__ import annotations

import re
from pathlib import Path

from .commands import command_pairs, discover_commands, render_command

MAX_SELECTIONS = 8
MAX_COMPOSED_CHARS = 128_000
_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
_TOKEN = re.compile(r"(?:^|\s)([/$@][^\s]*)\Z")


def composer_token(text: str, cursor: int) -> tuple[str, str, int, int] | None:
    """Return the trigger, query, and complete token range at a collapsed caret.

    URL/path slashes, email addresses, escaped sigils, and an ordinary word at the caret are not
    command triggers. Replacement includes the suffix of a token when editing its middle.
    """
    cursor = max(0, min(len(text), cursor))
    match = _TOKEN.search(text[:cursor])
    if not match:
        return None
    token = match[1]
    end = cursor
    while end < len(text) and not text[end].isspace():
        end += 1
    return token[0], token[1:], cursor - len(token), end


def completion_rows(surface: str, project_root: Path | None, *, skills: dict | None = None,
                    trigger: str = "/", query: str = "") -> list[dict]:
    rows = []
    if trigger == "/":
        rows.extend({"label": "/" + name, "desc": description, "kind": "command", "value": name}
                    for name, description in command_pairs(surface))
        if project_root is not None:
            rows.extend({"label": "/" + name, "desc": "custom prompt command", "kind": "template", "value": name}
                        for name in discover_commands(project_root))
    if trigger in ("/", "$"):
        if skills is None and project_root is not None:
            from .skills import discover_skills
            skills = discover_skills(project_root)
        rows.extend({"label": "$" + name, "desc": skill.description or "Reusable agent instructions",
                     "kind": "skill", "value": name}
                    for name, skill in (skills or {}).items() if getattr(skill, "enabled", True))
    query = query.casefold()
    return [row for row in rows if row["value"].casefold().startswith(query)]


def _names(value, kind: str) -> list[str]:
    if value is None:
        return []
    if (not isinstance(value, list) or len(value) > MAX_SELECTIONS
            or any(not isinstance(name, str) or not _NAME.fullmatch(name) for name in value)):
        raise ValueError(f"Select at most {MAX_SELECTIONS} valid {kind} names.")
    return list(dict.fromkeys(value))


def compose_prompt(text: str, *, skills=None, templates=None, catalog: dict,
                   project_root: Path) -> str:
    """Resolve explicit selections without losing the original request or expanding client paths."""
    selected = _names(skills, "skill")
    commands = _names(templates, "prompt template")
    if len(selected) + len(commands) > MAX_SELECTIONS:
        raise ValueError(f"Select at most {MAX_SELECTIONS} skills and prompt templates per message.")
    for name in selected:
        if name not in catalog or getattr(catalog[name], "enabled", True) is False:
            raise ValueError(f"Skill ${name} is missing or disabled. Reload Skills and select it again.")
    blocks = []
    available = discover_commands(project_root) if commands else {}
    for name in commands:
        if name not in available:
            raise ValueError(f"Prompt template /{name} is no longer available.")
        rendered = render_command(available[name], text, project_root)
        if not rendered:
            raise ValueError(f"Prompt template /{name} is empty or could not be read safely.")
        blocks.append(f"Prompt template /{name}:\n{rendered}")
    result = text
    if blocks:
        result += "\n\n" + "\n\n".join(blocks)
    if selected:
        result = " ".join("$" + name for name in selected) + "\n\n" + result
    if len(result) > MAX_COMPOSED_CHARS:
        raise ValueError("The selected prompt templates exceed the message size limit.")
    return result
