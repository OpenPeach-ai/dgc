"""Resources and user-selected prompt templates from an exact connected MCP server.

No URI is fetched locally: file:// and other resource identifiers belong to the selected server.
Metadata and returned content remain untrusted data; only the owning Agent grants execution.
"""
from __future__ import annotations

import json
import re
import time

from .mcp import (MCPInputError, _MAX_INPUT_BYTES, _MAX_INPUT_REQUESTS, _MAX_MRTR_ROUNDS,
                  _cache_hint, _json_bytes, validate_elicitation_response)

MAX_CATALOG_ITEMS = 256
MAX_CATALOG_BYTES = 1024 * 1024
MAX_CONTEXT_CHARS = 64_000
_CATALOGS = {"resources": ("resources/list", "resources", "uri", "resources"),
             "templates": ("resources/templates/list", "resourceTemplates", "uriTemplate", "resources"),
             "prompts": ("prompts/list", "prompts", "name", "prompts")}


class _RequestCancel:
    def __init__(self, parent, deadline):
        self.parent, self.deadline = parent, deadline

    def is_set(self):
        return time.monotonic() >= self.deadline or (self.parent is not None and self.parent.is_set())

    def reason(self):
        return "cancelled by user" if self.parent is not None and self.parent.is_set() else "request timed out"


def request_complete(server, method: str, original: dict, *, timeout: float = 120.0,
                     cancel=None, on_progress=None, on_log=None, input_handler=None) -> dict:
    """Complete one modern/legacy operation within one deadline and input-request budget."""
    deadline = time.monotonic() + timeout
    cancel = _RequestCancel(cancel, deadline)
    params, input_total = dict(original), 0
    for _round in range(_MAX_MRTR_ROUNDS):
        if cancel.is_set():
            raise MCPInputError(cancel.reason())
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MCPInputError("request timed out")
        result, error = server._request(method, params, remaining, cancel,
                                        on_progress=on_progress, on_log=on_log, input_handler=input_handler)
        if cancel.is_set():
            raise MCPInputError(cancel.reason())
        if result is None:
            raise MCPInputError(error or "no response")
        if server.protocol_era != "modern" or result.get("resultType") == "complete":
            return result
        if result.get("resultType") != "input_required":
            raise MCPInputError("invalid modern resultType")
        requests = result.get("inputRequests") or {}
        if not isinstance(requests, dict) or len(requests) > _MAX_INPUT_REQUESTS:
            raise MCPInputError("malformed inputRequests")
        input_total += len(requests)
        if input_total > _MAX_INPUT_REQUESTS:
            raise MCPInputError(f"exceeded {_MAX_INPUT_REQUESTS} input requests")
        responses = {}
        for key, request in requests.items():
            if not isinstance(key, str) or len(key) > 128 or not isinstance(request, dict):
                raise MCPInputError("invalid input request identifier or payload")
            if cancel.is_set():
                raise MCPInputError(cancel.reason())
            requested_method = request.get("method")
            if requested_method == "roots/list":
                responses[key] = {"roots": [{"uri": server.root.as_uri(), "name": server.root.name}]}
                continue
            clean = server._prepare_input(str(requested_method or ""), request.get("params"))
            if not callable(input_handler):
                raise MCPInputError(f"unsupported client input: {requested_method}")
            try:
                response = input_handler(server.name, str(requested_method), clean, cancel)
                if cancel.is_set():
                    raise MCPInputError(cancel.reason())
                if requested_method == "elicitation/create":
                    response = validate_elicitation_response(clean, response)
                if not isinstance(response, dict):
                    raise MCPInputError("client input handler returned an invalid response")
                responses[key] = response
            except MCPInputError:
                raise
            except Exception:
                raise MCPInputError("client input handler failed") from None
        state = result.get("requestState")
        if state is not None and (not isinstance(state, str) or len(state.encode("utf-8")) > _MAX_INPUT_BYTES):
            raise MCPInputError("oversized or invalid requestState")
        if not requests and state is None:
            raise MCPInputError("empty input_required result")
        params = {**original, **({"inputResponses": responses} if responses else {}),
                  **({"requestState": state} if state is not None else {})}
    raise MCPInputError(f"exceeded {_MAX_MRTR_ROUNDS} input rounds")


def _text(value, maximum: int, *, required: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum or any(ord(ch) < 32 for ch in value):
        raise MCPInputError("invalid or oversized MCP metadata string")
    if required and not value:
        raise MCPInputError("required MCP metadata string is empty")
    return value


def _description(value, maximum: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > maximum:
        raise MCPInputError("invalid or oversized MCP description")
    return value


def list_catalog(server, kind: str, *, cancel=None, timeout: float = 20.0) -> list[dict]:
    if kind not in _CATALOGS:
        raise MCPInputError("Choose resources, templates or prompts.")
    method, result_key, identity, capability = _CATALOGS[kind]
    if capability not in server.server_capabilities:
        return []
    deadline, rows, seen, cursors, size = time.monotonic() + timeout, [], set(), set(), 0
    cursor = None
    for _ in range(32):
        if cancel is not None and cancel.is_set():
            raise MCPInputError("cancelled by user")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MCPInputError("MCP catalog listing timed out")
        result, error = server._request(method, {"cursor": cursor} if cursor else {}, remaining, cancel)
        if result is None:
            raise MCPInputError(f"{method} failed: {error or 'no response'}")
        if server.protocol_era == "modern" and result.get("resultType") != "complete":
            raise MCPInputError(f"{method} returned an invalid modern resultType")
        if server.protocol_era == "modern":
            _cache_hint(result, method)
        size += _json_bytes(result)
        source = result.get(result_key)
        if not isinstance(source, list) or size > MAX_CATALOG_BYTES or len(rows) + len(source) > MAX_CATALOG_ITEMS:
            raise MCPInputError("MCP catalog is malformed or exceeds its bounded item/byte limit")
        for raw in source:
            if not isinstance(raw, dict):
                raise MCPInputError("MCP catalog item must be an object")
            key = _text(raw.get(identity), 4096 if identity != "name" else 256, required=True)
            if key in seen:
                raise MCPInputError("MCP catalog repeats an item identifier")
            seen.add(key)
            row = {identity: key, "name": _text(raw.get("name", key), 4096, required=True),
                   "description": _description(raw.get("description"), 8000),
                   "title": _description(raw.get("title"), 256), "kind": kind, "server": server.name}
            if kind == "prompts":
                arguments = raw.get("arguments", [])
                if not isinstance(arguments, list) or len(arguments) > 32:
                    raise MCPInputError("MCP prompt has invalid argument metadata")
                clean, names = [], set()
                for argument in arguments:
                    if not isinstance(argument, dict):
                        raise MCPInputError("MCP prompt argument must be an object")
                    name = _text(argument.get("name"), 128, required=True)
                    if name in names or not isinstance(argument.get("required", False), bool):
                        raise MCPInputError("MCP prompt has duplicate or invalid arguments")
                    names.add(name)
                    clean.append({"name": name, "description": _description(argument.get("description"), 2000),
                                  "required": argument.get("required", False)})
                row["arguments"] = clean
            rows.append(row)
        cursor = result.get("nextCursor")
        if cursor is None or cursor == "":
            return rows
        cursor = _text(cursor, 4096, required=True)
        if cursor in cursors:
            raise MCPInputError("MCP catalog repeats a pagination cursor")
        cursors.add(cursor)
    raise MCPInputError("MCP catalog exceeds 32 pages")


def render_context(result: dict, kind: str) -> dict:
    """Preserve roles and resource provenance in bounded inert text, without following links."""
    blocks, omitted, used = [], [], 0
    source = result.get("messages" if kind == "prompts" else "contents")
    if not isinstance(source, list) or len(source) > 128:
        raise MCPInputError("MCP context response requires at most 128 content blocks")
    for row in source:
        if not isinstance(row, dict):
            raise MCPInputError("MCP content block must be an object")
        if kind == "prompts":
            role, block = row.get("role"), row.get("content")
            if role not in ("user", "assistant") or not isinstance(block, dict):
                raise MCPInputError("MCP prompt returned an invalid role or content block")
            prefix = f"[{role}]\n"
            content_type = block.get("type")
            if content_type == "resource":
                block = block.get("resource")
                if not isinstance(block, dict):
                    raise MCPInputError("MCP embedded resource is invalid")
            elif content_type == "resource_link":
                omitted.append("Resource link (not fetched): " + _text(block.get("uri"), 4096, required=True))
                continue
            elif content_type != "text":
                omitted.append("Unsupported media content is not included in text context")
                continue
        else:
            block = row
            prefix = _text(block.get("uri"), 4096, required=True) + "\n"
        body = block.get("text")
        if not isinstance(body, str):
            if "blob" in block:
                omitted.append("Binary resource is not included in text context")
                continue
            raise MCPInputError("MCP text content is missing")
        text = prefix + body
        if used + len(text) + (2 if blocks else 0) > MAX_CONTEXT_CHARS:
            raise MCPInputError("MCP text context exceeds 64,000 characters; choose a smaller resource")
        blocks.append(text)
        used += len(text) + (2 if len(blocks) > 1 else 0)
    return {"text": "\n\n".join(blocks), "omitted": omitted}


def get_context(server, kind: str, identifier: str, arguments=None, *, cancel=None,
                input_handler=None, on_progress=None, on_log=None) -> dict:
    identifier = _text(identifier, 4096, required=True)
    if kind == "prompts":
        rows = list_catalog(server, "prompts", cancel=cancel)
        prompt = next((row for row in rows if row["name"] == identifier), None)
        if prompt is None:
            raise MCPInputError("Prompt no longer appears in this server's catalog. Refresh it.")
        arguments = arguments if arguments is not None else {}
        if (not isinstance(arguments, dict) or len(arguments) > 32 or _json_bytes(arguments) > 32_000
                or any(not isinstance(key, str) or not isinstance(value, str) for key, value in arguments.items())):
            raise MCPInputError("Prompt arguments must be a bounded object of strings")
        known = {argument["name"] for argument in prompt["arguments"]}
        if set(arguments) - known or any(argument["required"] and argument["name"] not in arguments for argument in prompt["arguments"]):
            raise MCPInputError("Prompt arguments are missing or unsupported; refresh its argument form.")
        method, params = "prompts/get", {"name": identifier, "arguments": arguments}
    elif kind == "resources":
        if "resources" not in server.server_capabilities:
            raise MCPInputError("This server does not offer resources")
        if not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", identifier) or "{" in identifier or "}" in identifier:
            raise MCPInputError("Enter a concrete resource URI from this server or one of its templates")
        method, params = "resources/read", {"uri": identifier}
    else:
        raise MCPInputError("Choose resources or prompts")
    result = request_complete(server, method, params, cancel=cancel, input_handler=input_handler,
                              on_progress=on_progress, on_log=on_log)
    return {"server": server.name, "kind": kind, "identifier": identifier,
            **render_context(result, kind)}


def stage_context(agent, result: dict) -> None:
    """Attach a fetched snapshot to this terminal session's next draft, with no model request."""
    if not isinstance(result.get("text"), str) or not result["text"]:
        raise ValueError("This result has no text to attach")
    row = {"type": "mcp_context", "server": result["server"], "uri": result["identifier"], "text": result["text"]}
    previous = getattr(agent, "_draft_mcp_context", [])
    rows = [item for item in previous if (item["server"], item["uri"]) != (row["server"], row["uri"])] + [row]
    if len(rows) > 8 or _json_bytes(rows) > 48_000:
        raise ValueError("Selected MCP context exceeds eight snapshots or 48,000 bytes. Clear an attachment first.")
    agent._draft_mcp_context = rows


def apply_staged_context(agent, text: str) -> str:
    rows = getattr(agent, "_draft_mcp_context", [])
    if not rows:
        return text
    payload = json.dumps(agent._safe_value(rows), ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")
    if len(payload.encode("utf-8")) > 64_000:
        raise ValueError("Selected MCP context exceeds the encoded context limit; clear an attachment first")
    agent._draft_mcp_context = []
    return '<editor-context-json trust="untrusted-reference-data">\n' + payload + '\n</editor-context-json>\n\n' + text
