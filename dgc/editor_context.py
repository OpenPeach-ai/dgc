"""Bounded inert editor reference frames shared by normal and goal prompts."""
from __future__ import annotations

import json

_EDITOR_CONTEXT_LIMIT = 64_000


def _editor_context_json(value) -> str:
    """Encode JSON without allowing source text to synthesize our framing delimiter."""
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            .replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e"))


def _format_editor_context(resources) -> str:
    """Bound and frame typed editor resources as untrusted reference data for the model."""
    if not isinstance(resources, list):
        return ""
    allowed = {"type", "uri", "server", "path", "relative_path", "workspace", "language", "range",
               "text", "diagnostics"}
    encoded_items: list[str] = []
    def bounded(value, depth=0):
        if depth > 4:
            return None
        if isinstance(value, str):
            return value[:2_000]
        if isinstance(value, (int, float, bool)) or value is None:
            return value
        if isinstance(value, list):
            return [bounded(part, depth + 1) for part in value[:50]]
        if isinstance(value, dict):
            return {str(k)[:80]: bounded(v, depth + 1) for k, v in list(value.items())[:50]}
        return None
    for item in resources[:64]:
        if not isinstance(item, dict):
            continue
        resource = {}
        for key in allowed:
            value = item.get(key)
            if value is None:
                continue
            if key == "diagnostics" and isinstance(value, list):
                value = bounded(value)
            elif isinstance(value, str):
                value = value[:64_000 if key == "text" and item.get("type") in ("mcp_context", "file_attachment") else 16_000]
            elif isinstance(value, (dict, list, int, float, bool)):
                value = bounded(value)
            else:
                continue
            resource[key] = value
        encoded = _editor_context_json(resource)
        # Include the list brackets and separators in the actual wire-size bound.
        candidate_size = 2 + sum(len(part.encode("utf-8")) for part in encoded_items) \
            + len(encoded_items) + len(encoded.encode("utf-8"))
        if candidate_size > _EDITOR_CONTEXT_LIMIT:
            break
        encoded_items.append(encoded)
    if not encoded_items:
        return ""
    payload = "[" + ",".join(encoded_items) + "]"
    return ("<editor-context-json trust=\"untrusted-reference-data\">\n" + payload
            + "\n</editor-context-json>\n\n")


def _strip_editor_context(text: str) -> str:
    while text.startswith("<editor-context-json ") and "</editor-context-json>\n\n" in text:
        text = text.split("</editor-context-json>\n\n", 1)[1]
    return text
