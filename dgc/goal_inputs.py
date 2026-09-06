"""Bounded user-selected inputs retained with a goal, never exposed in its status events."""
from __future__ import annotations

import json

from .attachments import MAX_EDITOR_IMAGE_TOTAL_BYTES, validate_image_data_uris
from .composer import _names, compose_prompt, MAX_SELECTIONS
from .editor_context import _format_editor_context
from .skills import explicit_skill_instructions, format_skill_instructions


def normalize_inputs(value) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - {"skills", "templates", "context", "images"}:
        raise ValueError("Invalid goal attachments; select them again before starting the goal.")
    skills, templates = _names(value.get("skills"), "skill"), _names(value.get("templates"), "prompt template")
    if len(skills) + len(templates) > MAX_SELECTIONS:
        raise ValueError(f"Select at most {MAX_SELECTIONS} skills and prompt templates per goal.")
    images = list(validate_image_data_uris(value.get("images"), maximum_file_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES,
                                          maximum_total_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES))
    context = value.get("context") or []
    if not isinstance(context, list) or len(context) > 64 or any(not isinstance(item, dict) for item in context):
        raise ValueError("Select at most 64 valid context attachments per goal.")
    framed = _format_editor_context(context)
    retained = json.loads(framed.split("\n", 2)[1]) if framed else []
    for item in context:
        if item.get("type") in ("mcp_context", "file_attachment") and not any(
                all(row.get(key) == item.get(key) for key in ("type", "server", "uri", "text"))
                for row in retained):
            raise ValueError("The selected context exceeds the goal attachment limit. Remove an attachment or choose a smaller resource.")
    return {key: value for key, value in {"skills": skills, "templates": templates,
                                        "images": images, "context": retained}.items() if value}


def prepare_inputs(text: str, inputs: dict, agent, *, external: bool = False) -> tuple[str, str, list]:
    inputs = normalize_inputs(inputs)
    # Keep incoming reference frames ahead of the selected-skill markers. Inserting a marker
    # before such a frame would make its contents look like explicit user skill/tool intent.
    context = ""
    end = "</editor-context-json>\n\n"
    while text.startswith("<editor-context-json ") and end in text:
        prefix, text = text.split(end, 1)
        context += prefix + end
    images = inputs.get("images", [])
    if external and images:
        raise ValueError("Subscription CLI delegation does not support DGC image attachments. Use a native vision model for this goal.")
    if inputs.get("skills") or inputs.get("templates"):
        text = compose_prompt(text, skills=inputs.get("skills"), templates=inputs.get("templates"),
                              catalog=agent.skills, project_root=agent.config.project_root)
    format_skill_instructions(explicit_skill_instructions(agent.skills, text),
                              min(96_000, max(4_000, agent.context_size() * 2)))
    return text, _format_editor_context(inputs.get("context")) + context, images


def input_summary(inputs: dict) -> dict:
    return {"skills": list(inputs.get("skills", [])), "templates": list(inputs.get("templates", [])),
            "images": len(inputs.get("images", [])), "context": len(inputs.get("context", []))}


def start_terminal_goal(text: str, agent) -> list[str]:
    """Prepare terminal selections without expanding file contents into the goal objective."""
    from .attachments import expand_attachments
    from .commands import discover_commands
    from .composer import composer_token
    from .goals import parse_start
    objective, budget = parse_start(text)
    templates = []
    available = discover_commands(agent.config.project_root)
    for _ in range(MAX_SELECTIONS + 1):
        parts = objective.split(None, 1)
        leading = parts[0][1:] if parts and parts[0].startswith("/") else ""
        trailing = composer_token(objective, len(objective))
        if leading in available:
            templates.append(leading)
            objective = parts[1].strip() if len(parts) > 1 else ""
        elif trailing and trailing[0] == "/" and trailing[1] in available:
            templates.append(trailing[1])
            objective = objective[:trailing[2]].strip()
        else:
            break
    if not objective:
        raise ValueError("Enter a goal objective before selecting a prompt template.")
    expanded = expand_attachments(objective, agent.config.project_root,
                                  sanitizer=agent._safe_text)
    failures = [notice for notice in expanded.notices if not notice.startswith("attached ")]
    if failures:
        raise ValueError("Goal attachments were not ready: " + "; ".join(failures))
    context = list(getattr(agent, "_draft_mcp_context", []))
    if expanded.text != objective:
        context.append({"type": "file_attachment", "uri": "dgc-attachments:goal",
                        "text": expanded.text[len(objective):].lstrip()})
    if not agent.set_goal(objective, token_budget=budget, replace=True,
                          inputs={"templates": templates, "images": list(expanded.images), "context": context}):
        raise ValueError(agent._last_persist_error or "The goal could not be saved.")
    agent._draft_mcp_context = []
    agent._pending_images = None
    return list(expanded.notices)
