"""MCP stdio client with bounded process, request, content, and credential lifecycles."""
from __future__ import annotations

import atexit
import itertools
import json
import math
import os
import re
import signal
import subprocess
import threading
import time
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

from . import __version__

MCP_PROTOCOL_VERSION = "2026-07-28"
MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25"
_MAX_DIAGNOSTIC = 32_000
_MAX_CONTENT = 120_000
_MAX_FRAME = 4 * 1024 * 1024
_MAX_MRTR_ROUNDS = 4
_MAX_INPUT_REQUESTS = 8
_MAX_INPUT_BYTES = 64 * 1024
_MAX_FORM_BYTES = 32 * 1024
_MAX_SAMPLE_TEXT = 48 * 1024
_MAX_SAMPLE_TOKENS = 4096
_MAX_TOOL_PAGES = 100
_MAX_TOOLS = 512
_MAX_TOOL_SCHEMA_BYTES = 128 * 1024
_MAX_TOOL_CATALOG_BYTES = 8 * 1024 * 1024
_MAX_CURSOR_BYTES = 4096
_MAX_CACHE_TTL_MS = 60 * 60 * 1000
_MAX_SAFE_INTEGER = (1 << 53) - 1
_CATALOG_RETRY_SECONDS = 5.0
_SUBSCRIPTION_ACK_SECONDS = 5.0
_SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId"
_MAX_WRITE_SECONDS = 2.0
_CLIENT_INFO = {"name": "dgc", "version": __version__}
_LOG_LEVELS = ("debug", "info", "notice", "warning", "error", "critical", "alert", "emergency")
_INPUT_ORIGIN_METHODS = {"tools/call", "prompts/get", "resources/read"}
_CATALOG_SEARCH_STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "call", "do", "for", "from",
    "in", "is", "it", "mcp", "of", "on", "or", "please", "the", "this", "to", "tool",
    "tools", "use", "with", "array", "boolean", "default", "description", "enum", "integer",
    "number", "object", "properties", "property", "required", "schema", "string", "type",
}
_MAX_CATALOG_SEARCH_SCHEMA_CHARS = 8_192
_MAX_CATALOG_SEARCH_SCHEMA_NODES = 4_096
_MAX_CATALOG_SEARCH_RAW_TERMS = 256
_MAX_CATALOG_SEARCH_TERMS = 1_024
_SENSITIVE_FIELD_RE = re.compile(
    r"\b(?:password|passphrase|secret|client[ _-]?secret|api[ _-]?key|access[ _-]?token|"
    r"refresh[ _-]?token|bearer|private[ _-]?key|ssh[ _-]?key|seed[ _-]?phrase|mnemonic|"
    r"one[ _-]?time[ _-]?(?:password|code)|otp|authorization[ _-]?code|session[ _-]?cookie|"
    r"credit[ _-]?card|debit[ _-]?card|card[ _-]?(?:number|expiry|expiration)|cvv|cvc|"
    r"payment[ _-]?credential|bank[ _-]?account|routing[ _-]?number|pin)\b",
    re.I,
)


class MCPInputError(ValueError):
    """A bounded, user-safe rejection of an MCP server input request."""


class _AnyCancel:
    """The small Event surface consumers need, set when any constituent lifecycle ends."""

    def __init__(self, *events):
        self.events = tuple(event for event in events if event is not None)

    def is_set(self) -> bool:
        return any(event.is_set() for event in self.events)


def _json_bytes(value) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                              allow_nan=False).encode("utf-8"))
    except (RecursionError, TypeError, ValueError) as exc:
        raise MCPInputError("input request is not valid JSON") from exc


def _cache_hint(value: dict, operation: str) -> tuple[float, str]:
    """Validate a 2026 cache hint and return DGC's bounded in-process freshness window."""
    ttl = value.get("ttlMs")
    scope = value.get("cacheScope")
    if (isinstance(ttl, bool) or not isinstance(ttl, int)
            or not 0 <= ttl <= _MAX_SAFE_INTEGER):
        raise MCPInputError(f"{operation} returned an invalid ttlMs")
    if scope not in ("private", "public"):
        raise MCPInputError(f"{operation} returned an invalid cacheScope")
    return min(ttl, _MAX_CACHE_TTL_MS) / 1000.0, scope


def _sanitize_tool(value) -> dict:
    if not isinstance(value, dict):
        raise MCPInputError("tools/list contained a non-object tool")
    name = _short_text(value.get("name"), "tool name", 128)
    if not name:
        raise MCPInputError("tools/list contained an empty tool name")
    description = _short_text(value.get("description", ""), f"tool {name!r} description", 8000)
    schema = value.get("inputSchema")
    if not isinstance(schema, dict):
        raise MCPInputError(f"tool {name!r} inputSchema must be an object")
    if _json_bytes(schema) > _MAX_TOOL_SCHEMA_BYTES:
        raise MCPInputError(f"tool {name!r} inputSchema exceeded {_MAX_TOOL_SCHEMA_BYTES} bytes")
    return {"name": name, "description": description, "inputSchema": schema}


def _same_request_id(left, right) -> bool:
    """JSON-RPC booleans must never alias numeric request IDs in Python dictionaries."""
    return type(left) is type(right) and isinstance(left, (str, int)) and not isinstance(left, bool) \
        and left == right


def _short_text(value, field: str, limit: int) -> str:
    if not isinstance(value, str):
        raise MCPInputError(f"{field} must be a string")
    if len(value) > limit:
        raise MCPInputError(f"{field} exceeded {limit} characters")
    return value


def _bounded_number(value, field: str):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise MCPInputError(f"{field} must be a finite number")
    return value


def _sanitize_form_schema(value) -> dict:
    if not isinstance(value, dict) or value.get("type") != "object":
        raise MCPInputError("requestedSchema must be a top-level object schema")
    allowed_top = {"$schema", "type", "properties", "required"}
    if any(key not in allowed_top for key in value):
        raise MCPInputError("requestedSchema contains unsupported top-level keywords")
    properties = value.get("properties")
    if not isinstance(properties, dict) or len(properties) > 16:
        raise MCPInputError("requestedSchema properties must be an object with at most 16 fields")
    required = value.get("required", [])
    if not isinstance(required, list) or any(not isinstance(key, str) for key in required):
        raise MCPInputError("requestedSchema.required must be a string array")
    if len(required) != len(set(required)) or any(key not in properties for key in required):
        raise MCPInputError("requestedSchema.required contains duplicate or unknown fields")

    clean_properties: dict[str, dict] = {}
    for raw_key, raw in properties.items():
        key = _short_text(raw_key, "form field name", 64)
        if not key or not isinstance(raw, dict):
            raise MCPInputError("each form field must have a non-empty name and schema")
        kind = raw.get("type")
        if kind not in ("string", "number", "integer", "boolean", "array"):
            raise MCPInputError(f"form field {key!r} has an unsupported type")
        title = _short_text(raw.get("title", ""), f"{key}.title", 160)
        description = _short_text(raw.get("description", ""), f"{key}.description", 1000)
        if _SENSITIVE_FIELD_RE.search(" ".join((key, title, description)).replace("_", " ")):
            raise MCPInputError(
                f"form field {key!r} appears to request a credential or payment secret; use URL mode")

        common = {"type", "title", "description", "default"}
        if kind == "string":
            enum_style = "enum" in raw or "oneOf" in raw or "enumNames" in raw
            allowed = common | ({"enum", "oneOf", "enumNames"} if enum_style else
                                {"minLength", "maxLength", "format"})
            if any(name not in allowed for name in raw):
                raise MCPInputError(f"form field {key!r} contains unsupported schema keywords")
            clean = {name: raw[name] for name in common if name in raw}
            if enum_style:
                if "oneOf" in raw:
                    choices = raw["oneOf"]
                    if (not isinstance(choices, list) or not 1 <= len(choices) <= 64
                            or any(not isinstance(item, dict)
                                   or set(item) != {"const", "title"}
                                   or not isinstance(item.get("const"), str)
                                   or not isinstance(item.get("title"), str) for item in choices)):
                        raise MCPInputError(f"form field {key!r} has malformed enum choices")
                    clean["oneOf"] = [{"const": _short_text(item["const"], "enum value", 500),
                                       "title": _short_text(item["title"], "enum title", 160)}
                                      for item in choices]
                    if len({item["const"] for item in clean["oneOf"]}) != len(clean["oneOf"]):
                        raise MCPInputError(f"form field {key!r} has duplicate enum choices")
                else:
                    choices = raw.get("enum")
                    if (not isinstance(choices, list) or not 1 <= len(choices) <= 64
                            or any(not isinstance(item, str) or len(item) > 500 for item in choices)
                            or len(choices) != len(set(choices))):
                        raise MCPInputError(f"form field {key!r} has malformed enum choices")
                    clean["enum"] = list(choices)
                    if "enumNames" in raw:
                        names = raw["enumNames"]
                        if (not isinstance(names, list) or len(names) != len(choices)
                                or any(not isinstance(item, str) or len(item) > 160 for item in names)):
                            raise MCPInputError(f"form field {key!r} has malformed enumNames")
                        clean["enumNames"] = list(names)
                default = clean.get("default")
                options = [item["const"] for item in clean.get("oneOf", [])] or clean.get("enum", [])
                if default is not None and default not in options:
                    raise MCPInputError(f"form field {key!r} has an invalid default")
            else:
                minimum = raw.get("minLength", 0)
                maximum = raw.get("maxLength", 4000)
                if (isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 0
                        or isinstance(maximum, bool) or not isinstance(maximum, int)
                        or maximum < minimum or maximum > 4000):
                    raise MCPInputError(f"form field {key!r} has invalid string bounds")
                if "minLength" in raw:
                    clean["minLength"] = minimum
                clean["maxLength"] = maximum
                fmt = raw.get("format")
                if fmt is not None and fmt not in ("email", "uri", "date", "date-time"):
                    raise MCPInputError(f"form field {key!r} has an unsupported format")
                if fmt:
                    clean["format"] = fmt
                if "default" in clean and not isinstance(clean["default"], str):
                    raise MCPInputError(f"form field {key!r} has an invalid default")
        elif kind in ("number", "integer"):
            if any(name not in common | {"minimum", "maximum"} for name in raw):
                raise MCPInputError(f"form field {key!r} contains unsupported schema keywords")
            clean = {name: raw[name] for name in common if name in raw}
            minimum = raw.get("minimum")
            maximum = raw.get("maximum")
            if minimum is not None:
                clean["minimum"] = _bounded_number(minimum, f"{key}.minimum")
            if maximum is not None:
                clean["maximum"] = _bounded_number(maximum, f"{key}.maximum")
            if minimum is not None and maximum is not None and minimum > maximum:
                raise MCPInputError(f"form field {key!r} has inverted numeric bounds")
            if "default" in clean:
                default = _bounded_number(clean["default"], f"{key}.default")
                if kind == "integer" and not isinstance(default, int):
                    raise MCPInputError(f"form field {key!r} has a non-integer default")
        elif kind == "boolean":
            if any(name not in common for name in raw):
                raise MCPInputError(f"form field {key!r} contains unsupported schema keywords")
            clean = {name: raw[name] for name in common if name in raw}
            if "default" in clean and not isinstance(clean["default"], bool):
                raise MCPInputError(f"form field {key!r} has an invalid default")
        else:  # MCP multi-select enum
            if any(name not in common | {"items", "minItems", "maxItems"} for name in raw):
                raise MCPInputError(f"form field {key!r} contains unsupported schema keywords")
            items = raw.get("items")
            if not isinstance(items, dict):
                raise MCPInputError(f"form field {key!r} has malformed multi-select choices")
            clean_items: dict
            if isinstance(items.get("enum"), list) and items.get("type") == "string":
                choices = items["enum"]
                if (not 1 <= len(choices) <= 64 or any(not isinstance(v, str) or len(v) > 500 for v in choices)
                        or len(choices) != len(set(choices)) or set(items) != {"type", "enum"}):
                    raise MCPInputError(f"form field {key!r} has malformed multi-select choices")
                clean_items = {"type": "string", "enum": list(choices)}
                options = list(choices)
            else:
                choices = items.get("anyOf")
                if (not isinstance(choices, list) or not 1 <= len(choices) <= 64
                        or set(items) != {"anyOf"}
                        or any(not isinstance(item, dict) or set(item) != {"const", "title"}
                               or not isinstance(item.get("const"), str)
                               or not isinstance(item.get("title"), str) for item in choices)):
                    raise MCPInputError(f"form field {key!r} has malformed multi-select choices")
                clean_items = {"anyOf": [
                    {"const": _short_text(item["const"], "enum value", 500),
                     "title": _short_text(item["title"], "enum title", 160)} for item in choices]}
                options = [item["const"] for item in clean_items["anyOf"]]
                if len(options) != len(set(options)):
                    raise MCPInputError(f"form field {key!r} has duplicate multi-select choices")
            minimum = raw.get("minItems", 0)
            maximum = raw.get("maxItems", len(options))
            if (isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 0
                    or isinstance(maximum, bool) or not isinstance(maximum, int)
                    or maximum < minimum or maximum > len(options)):
                raise MCPInputError(f"form field {key!r} has invalid selection bounds")
            clean = {name: raw[name] for name in common if name in raw}
            clean.update({"items": clean_items, "minItems": minimum, "maxItems": maximum})
            if "default" in clean:
                default = clean["default"]
                if (not isinstance(default, list) or any(v not in options for v in default)
                        or len(default) != len(set(default))
                        or not minimum <= len(default) <= maximum):
                    raise MCPInputError(f"form field {key!r} has an invalid default")
        clean_properties[key] = clean

    clean_schema = {"type": "object", "properties": clean_properties, "required": list(required)}
    if _json_bytes(clean_schema) > _MAX_FORM_BYTES:
        raise MCPInputError(f"requestedSchema exceeded {_MAX_FORM_BYTES} bytes")
    return clean_schema


def _form_options(schema: dict) -> list[str]:
    if "oneOf" in schema:
        return [item["const"] for item in schema["oneOf"]]
    if "enum" in schema:
        return list(schema["enum"])
    items = schema.get("items") or {}
    if "anyOf" in items:
        return [item["const"] for item in items["anyOf"]]
    return list(items.get("enum") or [])


def validate_elicitation_response(params: dict, response) -> dict:
    """Validate user-provided form data again at the MCP boundary before disclosure."""
    if not isinstance(response, dict):
        return {"action": "cancel"}
    action = response.get("action")
    if action not in ("accept", "decline", "cancel"):
        return {"action": "cancel"}
    if action != "accept":
        return {"action": action}
    if params.get("mode", "form") == "url":
        return {"action": "accept"}
    schema = params["requestedSchema"]
    content = response.get("content")
    if not isinstance(content, dict) or any(key not in schema["properties"] for key in content):
        raise MCPInputError("form response contains unknown fields")
    missing = [key for key in schema.get("required", []) if key not in content]
    if missing:
        raise MCPInputError("form response is missing required fields: " + ", ".join(missing[:8]))
    clean: dict = {}
    for key, value in content.items():
        field = schema["properties"][key]
        kind = field["type"]
        if kind == "string":
            if not isinstance(value, str):
                raise MCPInputError(f"form field {key!r} must be a string")
            if not field.get("minLength", 0) <= len(value) <= field.get("maxLength", 4000):
                raise MCPInputError(f"form field {key!r} violates its length bounds")
            options = _form_options(field)
            if options and value not in options:
                raise MCPInputError(f"form field {key!r} is not an allowed choice")
            fmt = field.get("format")
            try:
                if fmt == "email" and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
                    raise ValueError
                if fmt == "uri" and not urlsplit(value).scheme:
                    raise ValueError
                if fmt == "date":
                    date.fromisoformat(value)
                if fmt == "date-time":
                    datetime.fromisoformat(value.replace("Z", "+00:00"))
            except (TypeError, ValueError):
                raise MCPInputError(f"form field {key!r} does not match format {fmt!r}") from None
        elif kind in ("number", "integer"):
            _bounded_number(value, f"form field {key!r}")
            if kind == "integer" and not isinstance(value, int):
                raise MCPInputError(f"form field {key!r} must be an integer")
            if "minimum" in field and value < field["minimum"]:
                raise MCPInputError(f"form field {key!r} is below its minimum")
            if "maximum" in field and value > field["maximum"]:
                raise MCPInputError(f"form field {key!r} is above its maximum")
        elif kind == "boolean":
            if not isinstance(value, bool):
                raise MCPInputError(f"form field {key!r} must be a boolean")
        else:
            options = _form_options(field)
            if (not isinstance(value, list) or any(not isinstance(v, str) or v not in options for v in value)
                    or len(value) != len(set(value))
                    or not field.get("minItems", 0) <= len(value) <= field.get("maxItems", len(options))):
                raise MCPInputError(f"form field {key!r} has invalid selections")
        clean[key] = value
    result = {"action": "accept", "content": clean}
    if _json_bytes(result) > _MAX_FORM_BYTES:
        raise MCPInputError(f"form response exceeded {_MAX_FORM_BYTES} bytes")
    return result


def sanitize_input_request(method: str, params) -> dict:
    """Return the small MCP input subset DGC can safely show and fulfill."""
    if not isinstance(params, dict) or _json_bytes(params) > _MAX_INPUT_BYTES:
        raise MCPInputError(f"{method} parameters must be an object under {_MAX_INPUT_BYTES} bytes")
    if method == "elicitation/create":
        mode = params.get("mode", "form")
        message = _short_text(params.get("message"), "elicitation message", 4000)
        if mode == "form":
            return {"mode": "form", "message": message,
                    "requestedSchema": _sanitize_form_schema(params.get("requestedSchema"))}
        if mode != "url":
            raise MCPInputError("elicitation mode must be form or url")
        raw_url = _short_text(params.get("url"), "elicitation URL", 2048)
        parsed = urlsplit(raw_url)
        host = parsed.hostname or ""
        loopback = host in ("localhost", "127.0.0.1", "::1")
        if (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)):
            raise MCPInputError("URL elicitation requires HTTPS (HTTP is allowed only for loopback)")
        if not host or parsed.username or parsed.password or any(ord(ch) < 32 for ch in raw_url):
            raise MCPInputError("elicitation URL is malformed or embeds credentials")
        return {"mode": "url", "message": message, "url": raw_url, "host": host,
                "suspicious_host": host.lower().startswith("xn--") or ".xn--" in host.lower()}
    if method != "sampling/createMessage":
        raise MCPInputError(f"client method not supported: {method}")
    if params.get("tools") is not None or params.get("toolChoice") is not None:
        raise MCPInputError("sampling tools were not advertised and are not supported")
    if params.get("includeContext", "none") not in (None, "none"):
        raise MCPInputError("sampling context inclusion was not advertised and is not supported")
    messages = params.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 32:
        raise MCPInputError("sampling messages must contain 1 to 32 messages")
    clean_messages = []
    text_size = 0
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in ("user", "assistant"):
            raise MCPInputError("sampling messages contain an invalid role or shape")
        blocks = message.get("content")
        blocks = blocks if isinstance(blocks, list) else [blocks]
        if not 1 <= len(blocks) <= 32:
            raise MCPInputError("sampling message content must contain 1 to 32 blocks")
        clean_blocks = []
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "text":
                raise MCPInputError("DGC sampling supports text content only")
            text = _short_text(block.get("text"), "sampling text block", 8000)
            text_size += len(text)
            clean_blocks.append({"type": "text", "text": text})
        clean_messages.append({"role": message["role"], "content": clean_blocks})
    system_prompt = _short_text(params.get("systemPrompt", ""), "sampling systemPrompt", 8000)
    text_size += len(system_prompt)
    if text_size > _MAX_SAMPLE_TEXT:
        raise MCPInputError(f"sampling prompt exceeded {_MAX_SAMPLE_TEXT} characters")
    requested_tokens = params.get("maxTokens")
    if isinstance(requested_tokens, bool) or not isinstance(requested_tokens, int) or requested_tokens < 1:
        raise MCPInputError("sampling maxTokens must be a positive integer")
    clean = {"messages": clean_messages, "maxTokens": min(requested_tokens, _MAX_SAMPLE_TOKENS)}
    if system_prompt:
        clean["systemPrompt"] = system_prompt
    if "temperature" in params:
        temperature = _bounded_number(params["temperature"], "sampling temperature")
        if not 0 <= temperature <= 2:
            raise MCPInputError("sampling temperature must be between 0 and 2")
        clean["temperature"] = temperature
    if "stopSequences" in params:
        stops = params["stopSequences"]
        if (not isinstance(stops, list) or len(stops) > 16
                or any(not isinstance(stop, str) or len(stop) > 256 for stop in stops)):
            raise MCPInputError("sampling stopSequences are malformed or too large")
        clean["stopSequences"] = list(stops)
    return clean


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value)).strip("_") or "unnamed"


def _bounded_lines(stream, limit: int = _MAX_FRAME):
    """Yield `(line, oversized)` without ever buffering an unbounded stdio frame."""
    cap = max(1, int(limit))
    while True:
        line = stream.readline(cap + 1)
        if not line:
            return
        oversized = len(line) > cap
        if oversized and not line.endswith("\n"):
            while True:
                tail = stream.readline(cap + 1)
                if not tail or tail.endswith("\n"):
                    break
        yield ("" if oversized else line), oversized


class MCPServer:
    def __init__(self, name: str, command: str, args=None, env=None, root: Path | None = None,
                 log_level: str = "warning", client_capabilities: dict | None = None):
        self.name = str(name)
        self.command = str(command)
        self.args = [str(a) for a in (args or [])]
        self.root = Path(root).resolve(strict=False) if root else Path.cwd().resolve()
        from .guards import mcp_process_env
        self.env, self._env_dropped = mcp_process_env(env)
        self.proc: subprocess.Popen | None = None
        self.tools: list[dict] = []
        self.error: str | None = None
        self.protocol_version: str | None = None
        self.protocol_era: str | None = None
        self.server_capabilities: dict = {}
        self.server_info: dict = {}
        self.instructions = ""
        self.negotiation_note = ""
        level = str(log_level or "warning").lower()
        self.log_level = level if level in (*_LOG_LEVELS, "off") else "warning"
        self.diagnostics = ""
        self._id = itertools.count(1)
        self._pending: dict[int, tuple[threading.Event, dict, int]] = {}
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._catalog_lock = threading.Lock()
        self._process_threads: dict[int, tuple[threading.Thread, threading.Thread]] = {}
        self._generation = 0
        self._input_capabilities = (dict(client_capabilities)
                                    if isinstance(client_capabilities, dict) else {})
        self._tools_invalidated = threading.Event()
        self._tools_expires_at = 0.0
        self._tools_retry_at = 0.0
        self.tools_cache_scope = "private"
        self._subscription_id: int | None = None
        self._subscription_generation = 0
        self._subscription_honored = False

    # lifecycle ----------------------------------------------------------------
    def start(self, timeout: float = 10.0) -> bool:
        self.error = None
        if not self._launch():
            return False

        # 2026-07-28 removed initialize/initialized. Probe it on a disposable stdio process, as the
        # official SDKs do: a handshake-era server may reject or corrupt its state on an unknown
        # first request, so legacy fallback always receives a fresh process.
        probe_timeout = min(max(0.25, float(timeout)), 3.0)
        discovered, discover_error = self._request(
            "server/discover", {}, probe_timeout, modern=True)
        supported = (discovered or {}).get("supportedVersions")
        claims_modern = (isinstance(supported, list) and MCP_PROTOCOL_VERSION in supported)
        modern = (isinstance(discovered, dict)
                  and discovered.get("resultType") == "complete"
                  and claims_modern
                  and isinstance(discovered.get("capabilities"), dict))
        if claims_modern and not modern:
            self.error = "server/discover claimed MCP 2026-07-28 but returned a malformed result"
            self.stop()
            return False
        if modern:
            try:
                # Discovery is negotiated once for this pinned stdio process. Validate its
                # required cache contract even though there is no second discovery read to reuse.
                _cache_hint(discovered, "server/discover")
            except MCPInputError as exc:
                self.error = str(exc)
                self.stop()
                return False
            self.protocol_version = MCP_PROTOCOL_VERSION
            self.protocol_era = "modern"
            self.server_capabilities = dict(discovered.get("capabilities") or {})
            self.instructions = str(discovered.get("instructions") or "")[:8000]
            meta = discovered.get("_meta") if isinstance(discovered.get("_meta"), dict) else {}
            info = meta.get("io.modelcontextprotocol/serverInfo")
            self.server_info = dict(info) if isinstance(info, dict) else {}
        else:
            note = discover_error or "invalid server/discover response"
            self.negotiation_note = f"modern probe unavailable; used legacy handshake ({note[:240]})"
            self._stop_process(self.proc, self._generation)
            if not self._launch():
                return False
            init, err = self._request("initialize", {
                "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
                "capabilities": self._legacy_client_capabilities(),
                "clientInfo": _CLIENT_INFO,
            }, timeout, modern=False)
            if init is None:
                self.error = f"initialize failed: {err or self._diagnostic_tail() or 'no response'}"
                self.stop()
                return False
            selected = str(init.get("protocolVersion") or MCP_LEGACY_PROTOCOL_VERSION)
            if selected == MCP_PROTOCOL_VERSION:
                self.error = ("initialize returned MCP 2026-07-28, but that revision removed the "
                              "initialize handshake")
                self.stop()
                return False
            self.protocol_version = selected
            self.protocol_era = "legacy"
            self.server_capabilities = (dict(init.get("capabilities") or {})
                                        if isinstance(init.get("capabilities"), dict) else {})
            self.server_info = (dict(init.get("serverInfo") or {})
                                if isinstance(init.get("serverInfo"), dict) else {})
            self.instructions = str(init.get("instructions") or "")[:8000]
            self._notify("notifications/initialized", {})
            if self.log_level != "off" and "logging" in self.server_capabilities:
                _, log_error = self._request(
                    "logging/setLevel", {"level": self.log_level}, timeout, modern=False)
                if log_error:
                    self._append_diagnostic(f"logging/setLevel failed: {log_error}")

        if "tools" not in self.server_capabilities:
            self.tools = []
            return True

        if not self._load_tools(timeout):
            self.stop()
            return False
        if self.protocol_era == "modern" and self._tools_list_changed_capability():
            if not self._open_tool_subscription(min(float(timeout), _SUBSCRIPTION_ACK_SECONDS)):
                self._append_diagnostic(
                    "tools/list_changed subscription unavailable; using cache TTL refresh")
        return True

    def _launch(self) -> bool:
        try:
            proc = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=self.env, cwd=str(self.root), text=True, bufsize=1, start_new_session=True,
            )
        except Exception as e:
            self.error = f"could not launch: {e}"
            return False
        self._generation += 1
        generation = self._generation
        self.proc = proc
        stdout_thread = threading.Thread(
            target=self._reader, args=(proc, generation), daemon=True,
            name=f"dgc-mcp-{self.name}-stdout")
        stderr_thread = threading.Thread(
            target=self._stderr_reader, args=(proc,), daemon=True,
            name=f"dgc-mcp-{self.name}-stderr")
        with self._lock:
            self._process_threads[generation] = (stdout_thread, stderr_thread)
        stdout_thread.start()
        stderr_thread.start()
        return True

    def _load_tools(self, timeout: float) -> bool:
        self._tools_invalidated.clear()
        cursor = None
        tools: list[dict] = []
        names: set[str] = set()
        cursors: set[str] = set()
        ttl_windows: list[float] = []
        cache_scopes: list[str] = []
        catalog_bytes = 0

        def fail(message: str) -> bool:
            self.error = message
            self._tools_invalidated.set()
            self._tools_retry_at = time.monotonic() + _CATALOG_RETRY_SECONDS
            return False

        for _ in range(_MAX_TOOL_PAGES):
            params = {"cursor": cursor} if cursor else {}
            page, err = self._request("tools/list", params, timeout)
            if page is None:
                return fail(f"tools/list failed: {err or self._diagnostic_tail() or 'no response'}")
            if self.protocol_era == "modern" and page.get("resultType") != "complete":
                return fail("tools/list returned an invalid modern resultType")
            try:
                catalog_bytes += _json_bytes(page)
            except MCPInputError as exc:
                return fail(str(exc))
            if catalog_bytes > _MAX_TOOL_CATALOG_BYTES:
                return fail(f"tools/list exceeded {_MAX_TOOL_CATALOG_BYTES} catalog bytes")
            if self.protocol_era == "modern":
                try:
                    ttl, scope = _cache_hint(page, "tools/list")
                except MCPInputError as exc:
                    return fail(str(exc))
                ttl_windows.append(ttl)
                cache_scopes.append(scope)
            raw_tools = page.get("tools")
            if not isinstance(raw_tools, list):
                return fail("tools/list did not return a tools array")
            if len(tools) + len(raw_tools) > _MAX_TOOLS:
                return fail(f"tools/list exceeded {_MAX_TOOLS} tools")
            for raw_tool in raw_tools:
                try:
                    tool = _sanitize_tool(raw_tool)
                except MCPInputError as exc:
                    self._append_diagnostic(f"excluded malformed tool: {exc}")
                    continue
                if tool["name"] in names:
                    self._append_diagnostic(
                        f"excluded duplicate tool name: {tool['name'][:128]}")
                    continue
                names.add(tool["name"])
                tools.append(tool)
            next_cursor = page.get("nextCursor")
            if next_cursor in (None, ""):
                break
            if (not isinstance(next_cursor, str)
                    or len(next_cursor.encode("utf-8")) > _MAX_CURSOR_BYTES):
                return fail("tools/list returned an invalid or oversized nextCursor")
            if next_cursor in cursors:
                return fail("tools/list repeated a pagination cursor")
            cursors.add(next_cursor)
            cursor = next_cursor
        else:
            return fail(f"tools/list exceeded {_MAX_TOOL_PAGES} pagination pages")
        self.tools = sorted(tools, key=lambda tool: tool["name"])
        if self.protocol_era == "modern":
            self._tools_expires_at = time.monotonic() + min(ttl_windows or [0.0])
            self.tools_cache_scope = ("private" if "private" in cache_scopes else "public")
        else:
            self._tools_expires_at = math.inf
            self.tools_cache_scope = "private"
        self._tools_retry_at = 0.0
        self.error = None
        return True

    def _tools_list_changed_capability(self) -> bool:
        capability = self.server_capabilities.get("tools")
        return isinstance(capability, dict) and capability.get("listChanged") is True

    def _subscription_live(self) -> bool:
        with self._lock:
            return (self._subscription_id is not None and self._subscription_honored
                    and self._subscription_generation == self._generation
                    and self.proc is not None and self.proc.poll() is None)

    def refresh_tools_if_stale(self, timeout: float = 10.0) -> bool:
        """Refresh an invalidated/expired catalog; return whether its exposed tools changed."""
        if self.proc is None or self.proc.poll() is not None or "tools" not in self.server_capabilities:
            return False
        now = time.monotonic()
        subscribed = self.protocol_era == "modern" and self._subscription_live()
        stale = self._tools_invalidated.is_set()
        if self.protocol_era == "modern" and not subscribed:
            stale = stale or now >= self._tools_expires_at
        if not stale or now < self._tools_retry_at:
            return False
        with self._catalog_lock:
            now = time.monotonic()
            subscribed = self.protocol_era == "modern" and self._subscription_live()
            stale = self._tools_invalidated.is_set()
            if self.protocol_era == "modern" and not subscribed:
                stale = stale or now >= self._tools_expires_at
            if not stale or now < self._tools_retry_at:
                return False
            previous = self.tools
            if not self._load_tools(timeout):
                self._append_diagnostic(self.error or "tools/list refresh failed")
                return False
            changed = self.tools != previous
            if (self.protocol_era == "modern" and self._tools_list_changed_capability()
                    and not self._subscription_live()):
                if not self._open_tool_subscription(min(float(timeout), _SUBSCRIPTION_ACK_SECONDS)):
                    self._append_diagnostic(
                        "tools/list_changed subscription unavailable; using cache TTL refresh")
            return changed

    def _open_tool_subscription(self, timeout: float) -> bool:
        """Open and synchronously acknowledge one modern stdio tool-list subscription."""
        if self.protocol_era != "modern" or not self._tools_list_changed_capability():
            return False
        with self._lock:
            if (self._subscription_id is not None and self._subscription_generation == self._generation
                    and self._subscription_honored):
                return True
            mid = next(self._id)
            proc, generation = self.proc, self._generation
            if proc is None or proc.poll() is not None:
                return False
            final = threading.Event()
            ack = threading.Event()
            holder = {"method": "subscriptions/listen", "subscription_ack": ack,
                      "subscription_honored": False}
            self._pending[mid] = (final, holder, generation)
            self._subscription_id = mid
            self._subscription_generation = generation
            self._subscription_honored = False
        params = {"notifications": {"toolsListChanged": True},
                  "_meta": self._request_meta()}
        sent, send_error = self._write_to(
            proc, {"jsonrpc": "2.0", "id": mid, "method": "subscriptions/listen",
                   "params": params}, timeout=max(0.01, float(timeout)))
        if not sent:
            self._abandon_subscription(mid, generation, send_error or "subscription write failed")
            return False
        deadline = time.monotonic() + max(0.01, float(timeout))
        while not ack.wait(min(0.05, max(0.0, deadline - time.monotonic()))):
            if final.is_set():
                self._abandon_subscription(mid, generation,
                                           "subscription ended before acknowledgement")
                return False
            if time.monotonic() >= deadline:
                self._cancel_subscription(mid, generation, "subscription acknowledgement timed out")
                return False
        with self._lock:
            honored = (self._subscription_id == mid and self._subscription_generation == generation
                       and bool(holder.get("subscription_honored")))
        if not honored:
            self._cancel_subscription(mid, generation,
                                      "server did not honor toolsListChanged")
        return honored

    def _abandon_subscription(self, mid: int, generation: int, reason: str) -> None:
        slot = None
        with self._lock:
            slot = self._pending.pop(mid, None)
            if self._subscription_id == mid and self._subscription_generation == generation:
                self._subscription_id = None
                self._subscription_honored = False
        if slot is not None:
            final, holder, _ = slot
            holder["error"] = {"code": -32800, "message": reason}
            final.set()
        self._append_diagnostic(reason)

    def _cancel_subscription(self, mid: int, generation: int, reason: str) -> None:
        proc = self.proc if generation == self._generation else None
        self._abandon_subscription(mid, generation, reason)
        if proc is not None:
            self._send_to(proc, {"jsonrpc": "2.0", "method": "notifications/cancelled",
                                 "params": {"requestId": mid, "reason": reason}}, timeout=0.2)

    def stop(self) -> None:
        with self._lock:
            subscription = (self._subscription_id, self._subscription_generation)
        if subscription[0] is not None:
            self._cancel_subscription(subscription[0], subscription[1], "client shutdown")
        self._stop_process(self.proc, self._generation)

    def _stop_process(self, proc: subprocess.Popen | None, generation: int) -> None:
        if not proc:
            return
        subscription_slot = None
        with self._lock:
            reader_threads = self._process_threads.pop(generation, ())
            if self._subscription_generation == generation:
                if self._subscription_id is not None:
                    subscription_slot = self._pending.pop(self._subscription_id, None)
                self._subscription_id = None
                self._subscription_honored = False
        if subscription_slot is not None:
            event, holder, _ = subscription_slot
            holder["error"] = {"code": -32000, "message": "server stopped"}
            event.set()
        if self.proc is proc:
            self.proc = None
        # start_new_session makes the direct child's PID the stable POSIX process-group ID. Preserve
        # and sweep that group even if the leader has already exited: a server can otherwise leave a
        # descendant holding inherited stdio pipes, keeping both reader threads and arbitrary work
        # alive indefinitely.
        pgid = proc.pid if os.name == "posix" else None
        if proc.poll() is None:
            try:
                if pgid is not None:
                    os.killpg(pgid, signal.SIGTERM)
                else:
                    proc.terminate()
                proc.wait(timeout=2)
            except (OSError, ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
                pass
        try:
            if pgid is not None:
                os.killpg(pgid, signal.SIGKILL)
            elif proc.poll() is None:
                proc.kill()
        except (OSError, ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except (OSError, ValueError):
                pass
        for thread in reader_threads:
            if thread is not threading.current_thread():
                thread.join(timeout=1)
        if any(thread.is_alive() for thread in reader_threads):
            self._append_diagnostic("MCP stdio readers did not close after process-group cleanup")
        self._fail_pending("server stopped", generation)

    # JSON-RPC -----------------------------------------------------------------
    def _diagnostic_tail(self) -> str:
        return self.diagnostics[-2000:].strip()

    def _append_diagnostic(self, value: str) -> None:
        text = str(value or "").strip()
        if text:
            self.diagnostics = (self.diagnostics + "\n" + text)[-_MAX_DIAGNOSTIC:]

    def _stderr_reader(self, proc: subprocess.Popen) -> None:
        if not proc.stderr:
            return
        try:
            for line, oversized in _bounded_lines(proc.stderr, 8192):
                self._append_diagnostic(
                    "oversized stderr frame discarded" if oversized else line)
        except Exception:
            pass

    def _fail_pending(self, message: str, generation: int) -> None:
        with self._lock:
            pending = []
            for mid, slot in list(self._pending.items()):
                if slot[2] == generation:
                    pending.append(slot)
                    self._pending.pop(mid, None)
        for ev, holder, _ in pending:
            holder["error"] = {"code": -32000, "message": message}
            ev.set()

    def _reader(self, proc: subprocess.Popen, generation: int) -> None:
        if not proc.stdout:
            return
        try:
            for line, oversized in _bounded_lines(proc.stdout):
                if oversized:
                    self._append_diagnostic("oversized stdout frame discarded")
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(
                        ValueError(f"invalid JSON constant: {value}")))
                except (json.JSONDecodeError, RecursionError, ValueError):
                    self._append_diagnostic("invalid stdout: " + line[:2000])
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("jsonrpc") != "2.0":
                    self._append_diagnostic("invalid JSON-RPC version on server message")
                    continue
                mid = msg.get("id")
                if mid is not None and ("result" in msg or "error" in msg):
                    if not isinstance(mid, int) or isinstance(mid, bool):
                        self._append_diagnostic("invalid response id from MCP server")
                        continue
                    with self._lock:
                        slot = self._pending.get(mid)
                        if slot and slot[2] == generation:
                            self._pending.pop(mid, None)
                        else:
                            slot = None
                    if slot:
                        ev, holder, _ = slot
                        holder["result"] = msg.get("result")
                        holder["error"] = msg.get("error")
                        if holder.get("method") == "subscriptions/listen":
                            self._finish_subscription(
                                mid, generation, msg.get("result"), msg.get("error"))
                        ev.set()
                    continue
                if mid is not None and msg.get("method"):
                    if (not isinstance(mid, (str, int)) or isinstance(mid, bool)
                            or isinstance(mid, str) and len(mid) > 128):
                        self._send_to(proc, {"jsonrpc": "2.0", "id": None, "error": {
                            "code": -32600, "message": "invalid server request id"}})
                        continue
                    raw_params = msg.get("params")
                    self._handle_server_request(
                        proc, generation, mid, str(msg["method"]),
                        {} if raw_params is None else raw_params)
                elif msg.get("method") in (
                        "notifications/subscriptions/acknowledged",
                        "notifications/tools/list_changed"):
                    self._handle_catalog_notification(
                        str(msg.get("method")), msg.get("params"), generation)
                elif msg.get("method") == "notifications/progress":
                    self._handle_progress(msg.get("params") or {}, generation)
                elif msg.get("method") == "notifications/message":
                    self._handle_log(msg.get("params") or {}, generation)
        finally:
            self._fail_pending("server exited", generation)

    def _handle_catalog_notification(self, method: str, params, generation: int) -> None:
        if self.protocol_era == "legacy":
            if method == "notifications/tools/list_changed" and self._tools_list_changed_capability():
                self._tools_invalidated.set()
            return
        if self.protocol_era != "modern":
            return
        if not isinstance(params, dict) or not isinstance(params.get("_meta"), dict):
            self._append_diagnostic(f"ignored uncorrelated modern notification: {method}")
            return
        sid = params["_meta"].get(_SUBSCRIPTION_ID_META)
        with self._lock:
            current = self._subscription_id
            holder_slot = self._pending.get(current) if current is not None else None
            valid = (current is not None and _same_request_id(sid, current)
                     and self._subscription_generation == generation
                     and holder_slot is not None and holder_slot[2] == generation)
            holder = holder_slot[1] if valid else None
            acknowledged = bool(holder and holder.get("subscription_acknowledged"))
        if not valid or holder is None:
            self._append_diagnostic(f"ignored notification for an unknown subscription: {method}")
            return
        if method == "notifications/subscriptions/acknowledged":
            if acknowledged:
                self._append_diagnostic("ignored duplicate subscription acknowledgement")
                return
            notifications = params.get("notifications")
            honored = (isinstance(notifications, dict)
                       and notifications.get("toolsListChanged") is True)
            holder["subscription_acknowledged"] = True
            holder["subscription_honored"] = honored
            with self._lock:
                if self._subscription_id == current:
                    self._subscription_honored = honored
            ack = holder.get("subscription_ack")
            if isinstance(ack, threading.Event):
                ack.set()
            return
        if not acknowledged or not holder.get("subscription_honored"):
            self._append_diagnostic(
                "ignored tools/list_changed before an honored subscription acknowledgement")
            return
        self._tools_invalidated.set()

    def _finish_subscription(self, mid: int, generation: int, result, error) -> None:
        with self._lock:
            if self._subscription_id == mid and self._subscription_generation == generation:
                self._subscription_id = None
                self._subscription_honored = False
        valid_result = (isinstance(result, dict) and result.get("resultType") == "complete"
                        and isinstance(result.get("_meta"), dict)
                        and _same_request_id(result["_meta"].get(_SUBSCRIPTION_ID_META), mid))
        if error is not None:
            self._append_diagnostic(f"tools/list_changed subscription ended with error: {error}")
        elif not valid_result:
            self._append_diagnostic("tools/list_changed subscription ended with an invalid result")
        self._tools_invalidated.set()

    def _handle_server_request(self, proc: subprocess.Popen, generation: int, mid,
                               method: str, params) -> None:
        if self.protocol_era == "modern":
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32601,
                "message": "server-initiated requests are not valid in MCP 2026-07-28; use MRTR",
            }})
            return
        if not isinstance(params, dict):
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32602, "message": "server request params must be an object"}})
            return
        if method == "ping":
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "result": {}})
            return
        if method not in ("roots/list", "sampling/createMessage", "elicitation/create"):
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32601, "message": f"client method not supported: {method}"}})
            return
        if method == "roots/list":
            if self.protocol_era != "legacy":
                self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                    "code": -32600, "message": "roots/list arrived before MCP initialization"}})
            else:
                self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "result": {
                    "roots": [{"uri": self.root.as_uri(),
                               "name": self.root.name or str(self.root)}]}})
            return
        with self._lock:
            origins = [holder for _ev, holder, gen in self._pending.values()
                       if gen == generation and holder.get("method") in _INPUT_ORIGIN_METHODS]
            if len(origins) == 1:
                holder = origins[0]
                holder["input_count"] = int(holder.get("input_count", 0)) + 1
            else:
                holder = None
        if holder is None:
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32600,
                "message": "server input was not associated with exactly one active client request"}})
            return
        if holder["input_count"] > _MAX_INPUT_REQUESTS:
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32000, "message": "server exceeded the input request limit"}})
            return
        handler = holder.get("input_handler")
        try:
            clean = self._prepare_input(method, params)
            if not callable(handler):
                raise MCPInputError(f"client method not supported: {method}")
            result = handler(self.name, method, clean, holder.get("cancel"))
            if method == "elicitation/create":
                result = validate_elicitation_response(clean, result)
            if not isinstance(result, dict):
                raise MCPInputError("client input handler returned an invalid response")
            callback_cancel = holder.get("cancel")
            if callback_cancel is not None and callback_cancel.is_set():
                raise MCPInputError("server input cancelled with its originating request")
        except MCPInputError as exc:
            message = str(exc)[:500]
            if "not supported" in message or "not advertised" in message:
                code = -32601
            elif any(word in message for word in ("declined", "cancelled", "failed")):
                code = -32000
            else:
                code = -32602
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": code, "message": message}})
            return
        except Exception:
            self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32000, "message": "client input handler failed"}})
            return
        self._send_to(proc, {"jsonrpc": "2.0", "id": mid, "result": result})

    def _send(self, obj: dict) -> bool:
        proc = self.proc
        return self._send_to(proc, obj) if proc else False

    def _write_to(self, proc: subprocess.Popen | None, obj: dict, *,
                  timeout: float = _MAX_WRITE_SECONDS,
                  cancel: threading.Event | None = None) -> tuple[bool, str]:
        if not proc or not proc.stdin:
            return False, "server process is unavailable"
        if cancel is not None and cancel.is_set():
            return False, "cancelled by user"
        try:
            wire = json.dumps(obj, separators=(",", ":"), allow_nan=False) + "\n"
        except (RecursionError, TypeError, ValueError):
            return False, "request is not JSON serializable"
        if len(wire.encode("utf-8")) > _MAX_FRAME:
            return False, f"outbound frame exceeded {_MAX_FRAME} bytes"

        done = threading.Event()
        outcome = {"ok": False, "error": "server stdin failed"}

        def write() -> None:
            try:
                with self._send_lock:
                    proc.stdin.write(wire)
                    proc.stdin.flush()
                outcome["ok"] = True
                outcome["error"] = ""
            except (OSError, ValueError):
                pass
            finally:
                done.set()

        threading.Thread(target=write, daemon=True,
                         name=f"dgc-mcp-{self.name}-stdin").start()
        deadline = time.monotonic() + max(0.01, min(_MAX_WRITE_SECONDS, float(timeout)))
        while not done.wait(min(0.05, max(0.0, deadline - time.monotonic()))):
            if cancel is not None and cancel.is_set():
                return False, "cancelled while writing request"
            if time.monotonic() >= deadline:
                return False, "server stdin stalled"
        return bool(outcome["ok"]), str(outcome["error"])

    def _send_to(self, proc: subprocess.Popen | None, obj: dict, *,
                 timeout: float = _MAX_WRITE_SECONDS) -> bool:
        return self._write_to(proc, obj, timeout=timeout)[0]

    def _client_capabilities(self) -> dict:
        capabilities = {"roots": {}}
        sampling = self._input_capabilities.get("sampling")
        elicitation = self._input_capabilities.get("elicitation")
        if isinstance(sampling, dict):
            # DGC deliberately does not advertise sampling context or tool use.
            capabilities["sampling"] = {}
        if isinstance(elicitation, dict):
            modes = {mode: {} for mode in ("form", "url")
                     if isinstance(elicitation.get(mode), dict)}
            if modes:
                capabilities["elicitation"] = modes
        return capabilities

    def _legacy_client_capabilities(self) -> dict:
        capabilities = self._client_capabilities()
        capabilities["roots"] = {"listChanged": False}
        return capabilities

    def _prepare_input(self, method: str, params) -> dict:
        capabilities = self._client_capabilities()
        if method == "sampling/createMessage" and "sampling" not in capabilities:
            raise MCPInputError("sampling/createMessage was not advertised by this client")
        if method == "elicitation/create":
            modes = capabilities.get("elicitation") or {}
            mode = params.get("mode", "form") if isinstance(params, dict) else "form"
            if mode not in modes:
                raise MCPInputError(f"elicitation {mode} mode was not advertised by this client")
        return sanitize_input_request(method, params)

    def _request_meta(self, progress_token=None) -> dict:
        meta = {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": _CLIENT_INFO,
            "io.modelcontextprotocol/clientCapabilities": self._client_capabilities(),
        }
        if progress_token is not None:
            meta["progressToken"] = progress_token
        if (self.log_level != "off" and self.protocol_era == "modern"
                and "logging" in self.server_capabilities):
            meta["io.modelcontextprotocol/logLevel"] = self.log_level
        return meta

    def _request(self, method: str, params: dict, timeout: float,
                 cancel: threading.Event | None = None, *, modern: bool | None = None,
                 on_progress=None, on_log=None, input_handler=None) -> tuple[dict | None, str | None]:
        mid = next(self._id)
        proc, generation = self.proc, self._generation
        if proc is None:
            return None, "server process is unavailable"
        ev = threading.Event()
        use_modern = (self.protocol_era == "modern") if modern is None else bool(modern)
        wire_params = dict(params or {})
        progress_token = f"dgc:{self.name}:{mid}" if on_progress is not None else None
        input_lifecycle = threading.Event()
        input_cancel = _AnyCancel(cancel, input_lifecycle)
        if use_modern:
            existing = wire_params.get("_meta")
            meta = dict(existing) if isinstance(existing, dict) else {}
            meta.update(self._request_meta(progress_token))
            wire_params["_meta"] = meta
        elif progress_token is not None:
            existing = wire_params.get("_meta")
            meta = dict(existing) if isinstance(existing, dict) else {}
            meta["progressToken"] = progress_token
            wire_params["_meta"] = meta
        holder: dict = {
            "progress_token": progress_token, "on_progress": on_progress, "on_log": on_log,
            "last_progress": -math.inf, "last_progress_emit": 0.0, "last_log_emit": 0.0,
            "method": method, "cancel": input_cancel,
            "input_handler": input_handler, "input_count": 0,
        }
        deadline = time.monotonic() + max(0.01, float(timeout))
        with self._lock:
            self._pending[mid] = (ev, holder, generation)
        sent, send_error = self._write_to(
            proc, {"jsonrpc": "2.0", "id": mid, "method": method,
                   "params": wire_params},
            timeout=max(0.01, deadline - time.monotonic()), cancel=cancel)
        if not sent:
            input_lifecycle.set()
            with self._lock:
                self._pending.pop(mid, None)
            if send_error in {"server stdin failed", "server stdin stalled",
                              "cancelled while writing request",
                              "server process is unavailable"}:
                self.error = send_error
                self._append_diagnostic(send_error)
                self._stop_process(proc, generation)
            return None, send_error
        while not ev.wait(min(0.1, max(0.0, deadline - time.monotonic()))):
            reason = None
            if cancel is not None and cancel.is_set():
                reason = "cancelled by user"
            elif time.monotonic() >= deadline:
                reason = "request timed out"
            if reason:
                with self._lock:
                    self._pending.pop(mid, None)
                # Address the process that owns this request. A reconnect may already have
                # installed a replacement in ``self.proc``; cancellation must never leak across
                # generations and terminate an unrelated request with the same server name.
                cancelled, cancel_error = self._write_to(
                    proc, {"jsonrpc": "2.0", "method": "notifications/cancelled",
                           "params": {"requestId": mid, "reason": reason}}, timeout=0.1)
                if not cancelled and cancel_error in {
                        "server stdin failed", "server stdin stalled",
                        "cancelled while writing request", "server process is unavailable"}:
                    self.error = cancel_error
                    self._append_diagnostic(cancel_error)
                    self._stop_process(proc, generation)
                input_lifecycle.set()
                return None, reason
        input_lifecycle.set()
        err = holder.get("error")
        if err:
            return None, str(err.get("message", err) if isinstance(err, dict) else err)
        result = holder.get("result")
        return (result if isinstance(result, dict) else {}), None

    def _handle_progress(self, params: dict, generation: int) -> None:
        if not isinstance(params, dict):
            return
        token, progress = params.get("progressToken"), params.get("progress")
        if isinstance(progress, bool) or not isinstance(progress, (int, float)) or not math.isfinite(progress):
            return
        callback = None
        payload = None
        now = time.monotonic()
        with self._lock:
            for _mid, (_ev, holder, gen) in self._pending.items():
                if gen != generation or token != holder.get("progress_token"):
                    continue
                if progress <= holder.get("last_progress", -math.inf):
                    return
                holder["last_progress"] = progress
                total = params.get("total")
                total_ok = (not isinstance(total, bool) and isinstance(total, (int, float))
                            and math.isfinite(total))
                complete = total_ok and progress >= total
                if now - holder.get("last_progress_emit", 0.0) < 0.1 and not complete:
                    return
                holder["last_progress_emit"] = now
                callback = holder.get("on_progress")
                payload = {"progress": progress,
                           "total": total if total_ok else None,
                           "message": str(params.get("message") or "")[:500]}
                break
        if callback and payload:
            try:
                callback(payload)
            except Exception:
                pass

    def _handle_log(self, params: dict, generation: int) -> None:
        if not isinstance(params, dict):
            return
        level = str(params.get("level") or "info").lower()
        if level not in _LOG_LEVELS:
            return
        if self.log_level == "off" or _LOG_LEVELS.index(level) < _LOG_LEVELS.index(self.log_level):
            return
        logger = str(params.get("logger") or "")[:120]
        data = params.get("data")
        if isinstance(data, str):
            message = data
        else:
            try:
                message = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            except (TypeError, ValueError):
                message = str(data)
        message = message[:1000]
        self._append_diagnostic(f"{level}{f' [{logger}]' if logger else ''}: {message}")
        callbacks = []
        now = time.monotonic()
        with self._lock:
            for _mid, (_ev, holder, gen) in self._pending.items():
                if gen == generation and holder.get("on_log") is not None:
                    if now - holder.get("last_log_emit", 0.0) >= 0.1:
                        holder["last_log_emit"] = now
                        callbacks.append(holder["on_log"])
        for callback in callbacks[:1]:
            try:
                callback({"level": level, "logger": logger, "message": message})
            except Exception:
                pass

    def _notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    # tools --------------------------------------------------------------------
    @staticmethod
    def _render_content(block: dict) -> str:
        kind = block.get("type")
        if kind == "text":
            return str(block.get("text", ""))
        if kind in ("image", "audio"):
            data = str(block.get("data", ""))
            return f"[MCP {kind}: {block.get('mimeType', 'unknown')} · {len(data)} base64 chars]"
        if kind == "resource_link":
            return f"[MCP resource link: {block.get('name') or block.get('uri')} · {block.get('uri', '')}]"
        if kind == "resource":
            resource = block.get("resource") or {}
            uri = resource.get("uri", "")
            if "text" in resource:
                return f"[MCP resource: {uri}]\n{resource.get('text', '')}"
            blob = str(resource.get("blob", ""))
            return f"[MCP resource: {uri} · {len(blob)} base64 chars]"
        return json.dumps(block, ensure_ascii=False)

    def call_tool(self, tool: str, arguments: dict, timeout: float = 120.0,
                  cancel: threading.Event | None = None, *, on_progress=None, on_log=None,
                  input_handler=None) -> str:
        params = {"name": tool, "arguments": arguments}
        res = None
        input_total = 0
        for _round in range(_MAX_MRTR_ROUNDS):
            res, err = self._request("tools/call", params, timeout, cancel,
                                     on_progress=on_progress, on_log=on_log,
                                     input_handler=input_handler)
            if res is None:
                tail = self._diagnostic_tail()
                detail = f" · {tail}" if tail and tail != err else ""
                return f"ERROR: MCP tool '{tool}' failed: {err or 'no response'}{detail}"
            if self.protocol_era != "modern" or res.get("resultType") == "complete":
                break
            if res.get("resultType") != "input_required":
                return f"ERROR: MCP tool '{tool}' returned an invalid modern resultType"
            requests = res.get("inputRequests") or {}
            if not isinstance(requests, dict) or len(requests) > _MAX_INPUT_REQUESTS:
                return f"ERROR: MCP tool '{tool}' returned malformed inputRequests"
            input_total += len(requests)
            if input_total > _MAX_INPUT_REQUESTS:
                return f"ERROR: MCP tool '{tool}' exceeded {_MAX_INPUT_REQUESTS} input requests"
            responses = {}
            unsupported = []
            for key, request in requests.items():
                if len(str(key)) > 128:
                    unsupported.append("input request identifier exceeded 128 characters")
                    continue
                method = request.get("method") if isinstance(request, dict) else None
                if method == "roots/list":
                    responses[str(key)] = {"roots": [{
                        "uri": self.root.as_uri(), "name": self.root.name or str(self.root)}]}
                else:
                    try:
                        clean = self._prepare_input(str(method or ""),
                                                    request.get("params") if isinstance(request, dict) else None)
                        if not callable(input_handler):
                            raise MCPInputError(f"client method not supported: {method}")
                        response = input_handler(self.name, str(method), clean, cancel)
                        if method == "elicitation/create":
                            response = validate_elicitation_response(clean, response)
                        if not isinstance(response, dict):
                            raise MCPInputError("client input handler returned an invalid response")
                        responses[str(key)] = response
                    except MCPInputError as exc:
                        unsupported.append(str(exc))
                    except Exception:
                        unsupported.append("client input handler failed")
            if unsupported:
                return (f"ERROR: MCP tool '{tool}' requires unsupported client input: "
                        + ", ".join(unsupported[:8]))
            request_state = res.get("requestState")
            if isinstance(request_state, str) and len(request_state.encode("utf-8")) > _MAX_INPUT_BYTES:
                return f"ERROR: MCP tool '{tool}' returned oversized requestState"
            if not requests and not isinstance(request_state, str):
                return f"ERROR: MCP tool '{tool}' returned an empty input_required result"
            params = {"name": tool, "arguments": arguments}
            if responses:
                params["inputResponses"] = responses
            if isinstance(request_state, str):
                params["requestState"] = request_state
        else:
            return f"ERROR: MCP tool '{tool}' exceeded {_MAX_MRTR_ROUNDS} input rounds"
        if self.protocol_era == "modern" and res.get("resultType") != "complete":
            return f"ERROR: MCP tool '{tool}' did not complete"
        parts = [self._render_content(c) for c in (res.get("content") or []) if isinstance(c, dict)]
        if res.get("structuredContent") is not None:
            parts.append("[structured content]\n" + json.dumps(res["structuredContent"], ensure_ascii=False))
        out = "\n".join(p for p in parts if p) or "(MCP tool returned no content)"
        if len(out) > _MAX_CONTENT:
            out = out[:_MAX_CONTENT] + f"\n… MCP content truncated ({len(out) - _MAX_CONTENT} chars)"
        return ("ERROR: " + out) if res.get("isError") else out


class MCPManager:
    def __init__(self, root: Path | None = None, *, client_capabilities: dict | None = None):
        self.root = Path(root).resolve(strict=False) if root else Path.cwd().resolve()
        self.servers: dict[str, MCPServer] = {}
        self.failures: dict[str, str] = {}
        self._routes: dict[str, tuple[str, str]] = {}
        self._tool_schema_cache: tuple[dict, ...] = ()
        self._tool_search_cache: tuple[tuple, ...] = ()
        self._catalog_state_lock = threading.RLock()
        self._client_capabilities = (dict(client_capabilities)
                                     if isinstance(client_capabilities, dict) else {})
        atexit.register(self.stop_all)

    def connect_all(self, config_servers: dict | None) -> None:
        if not isinstance(config_servers, dict):
            return
        for raw_name, raw_spec in config_servers.items():
            if not isinstance(raw_spec, dict):
                continue
            cmd = raw_spec.get("command")
            if not isinstance(cmd, str) or not cmd.strip():
                continue
            name = str(raw_name)
            self.failures.pop(name, None)
            old = self.servers.pop(name, None)
            if old is not None:
                old.stop()
            server = MCPServer(name, cmd, raw_spec.get("args"), raw_spec.get("env"), self.root,
                               str(raw_spec.get("log_level") or "warning"), self._client_capabilities)
            if server.start():
                self.servers[name] = server
            else:
                self.failures[name] = server.error or "connection failed"
        self._rebuild_routes()

    def _rebuild_routes(self) -> None:
        routes: dict[str, tuple[str, str]] = {}
        schemas: list[dict] = []
        for server_name, server in list(self.servers.items()):
            for tool in server.tools:
                original = str(tool.get("name", ""))
                base = f"mcp__{_safe_name(server_name)}__{_safe_name(original)}"
                exposed = base
                n = 2
                while exposed in routes:
                    exposed, n = f"{base}_{n}", n + 1
                routes[exposed] = (server_name, original)
                parameters = tool.get("inputSchema")
                if not isinstance(parameters, dict):
                    parameters = {"type": "object", "properties": {}}
                schemas.append({"type": "function", "function": {
                    "name": exposed,
                    "description": (f"[MCP:{server_name}] {tool.get('description', '')}")[:1000],
                    "parameters": parameters,
                }})
        schema_cache = tuple(schemas)
        search_cache = tuple(self._schema_search_entry(schema) for schema in schemas)
        lock = getattr(self, "_catalog_state_lock", None)
        if lock is None:  # compatibility for deliberately minimal injected manager shims
            lock = self._catalog_state_lock = threading.RLock()
        with lock:
            self._routes = routes
            self._tool_schema_cache = schema_cache
            self._tool_search_cache = search_cache

    def tool_schemas(self) -> list[dict]:
        changed = False
        for server in list(self.servers.values()):
            if server.refresh_tools_if_stale():
                changed = True
        if changed:
            self._rebuild_routes()
        with self._catalog_state_lock:
            return list(self._tool_schema_cache)

    @staticmethod
    def _term_forms(term: str) -> set[str]:
        """Small deterministic inflection normalizer, deliberately not a language-model retriever."""
        term = str(term or "").lower()
        forms = {term}
        if len(term) > 4 and term.endswith("ies"):
            forms.add(term[:-3] + "y")
        if len(term) > 4 and term.endswith("s"):
            forms.add(term[:-1])
        if len(term) > 5 and term.endswith("ing"):
            root = term[:-3]
            forms.update((root, root + "e"))
            if len(root) > 2 and root[-1] == root[-2]:
                forms.add(root[:-1])
        if len(term) > 4 and term.endswith("ed"):
            root = term[:-2]
            forms.update((root, root + "e"))
            if len(root) > 2 and root[-1] == root[-2]:
                forms.add(root[:-1])
        return {form for form in forms if len(form) >= 2}

    @classmethod
    def _catalog_terms(cls, query: str) -> set[str]:
        raw_terms = re.findall(r"[a-z0-9]{2,}", str(query or "").lower())
        if len(raw_terms) > _MAX_CATALOG_SEARCH_RAW_TERMS:
            half = _MAX_CATALOG_SEARCH_RAW_TERMS // 2
            raw_terms = raw_terms[:half] + raw_terms[-half:]
        terms: set[str] = set()
        for term in raw_terms:
            if term not in _CATALOG_SEARCH_STOP_WORDS:
                terms.update(form for form in cls._term_forms(term)
                             if form not in _CATALOG_SEARCH_STOP_WORDS)
                if len(terms) >= _MAX_CATALOG_SEARCH_TERMS:
                    break
        return terms

    @staticmethod
    def _parameter_search_text(parameters) -> str:
        """Extract bounded schema vocabulary without serializing a whole 128 KiB schema per query."""
        output: list[str] = []
        used = nodes = 0
        stack = [parameters]
        seen: set[int] = set()
        while stack and used < _MAX_CATALOG_SEARCH_SCHEMA_CHARS \
                and nodes < _MAX_CATALOG_SEARCH_SCHEMA_NODES:
            value = stack.pop()
            nodes += 1
            if isinstance(value, (dict, list, tuple)):
                identity = id(value)
                if identity in seen:
                    continue
                seen.add(identity)
            if isinstance(value, dict):
                items = list(value.items())
                for key, _ in items:
                    text = str(key).lower()
                    remaining = _MAX_CATALOG_SEARCH_SCHEMA_CHARS - used
                    if remaining <= 0:
                        break
                    output.append(text[:remaining]); used += min(len(text), remaining) + 1
                stack.extend(item for _, item in reversed(items))
            elif isinstance(value, (list, tuple)):
                stack.extend(reversed(value))
            elif isinstance(value, str):
                remaining = _MAX_CATALOG_SEARCH_SCHEMA_CHARS - used
                if remaining > 0:
                    text = value.lower()[:remaining]
                    output.append(text); used += len(text) + 1
        return " ".join(output)

    @classmethod
    def _schema_search_entry(cls, schema: dict) -> tuple:
        fn = schema.get("function") or {}
        name = str(fn.get("name") or "").lower()
        description = str(fn.get("description") or "").lower()
        parameters = cls._parameter_search_text(fn.get("parameters") or {})
        try:
            size = len(json.dumps(schema, default=str))
        except (RecursionError, TypeError, ValueError):
            size = 1 << 60
        return (schema, size, name, cls._catalog_terms(name), description,
                cls._catalog_terms(description), parameters, cls._catalog_terms(parameters))

    def _catalog_search_entries(self, schemas: list[dict]) -> tuple[tuple, ...]:
        lock = getattr(self, "_catalog_state_lock", None)
        if lock is None:
            lock = self._catalog_state_lock = threading.RLock()
        with lock:
            cached_schemas = getattr(self, "_tool_schema_cache", ())
            cached_entries = getattr(self, "_tool_search_cache", ())
        if (len(schemas) == len(cached_schemas) == len(cached_entries)
                and all(schema is cached for schema, cached in zip(schemas, cached_schemas))):
            return cached_entries
        return tuple(self._schema_search_entry(schema) for schema in schemas)

    @classmethod
    def _entry_relevance(cls, entry: tuple, query: str,
                         terms: set[str] | None = None) -> int:
        _, _, name, name_terms, description, description_terms, parameters, parameter_terms = entry
        if terms is None:
            terms = cls._catalog_terms(query)
        if not terms:
            return 0
        score = 100 if str(query or "").strip().lower() == name else 0
        for term in terms:
            if term in name_terms:
                score += 24
            elif term in name:
                score += 12
            if term in description_terms or term in description:
                score += 4
            if term in parameter_terms or term in parameters:
                score += 1
        return score

    @classmethod
    def _schema_relevance(cls, schema: dict, query: str) -> int:
        return cls._entry_relevance(cls._schema_search_entry(schema), query)

    def search_tool_schemas(self, query: str, limit: int = 8) -> list[dict]:
        """Return deterministic relevant schemas from the current catalog, never arbitrary filler."""
        limit = max(1, min(20, int(limit)))
        schemas = self.tool_schemas()
        terms = self._catalog_terms(query)
        ranked = []
        for index, entry in enumerate(self._catalog_search_entries(schemas)):
            score = self._entry_relevance(entry, query, terms)
            if score > 0:
                ranked.append((-score, index, entry[0]))
        ranked.sort(key=lambda row: (row[0], row[1]))
        return [schema for _, _, schema in ranked[:limit]]

    def select_tool_schemas(self, query: str, budget_chars: int,
                            active: set[str] | None = None, *,
                            reserve_chars: int = 0) -> tuple[list[dict], bool]:
        """Fit relevant direct schemas in a prompt budget; report whether brokers are required."""
        schemas = self.tool_schemas()
        budget = max(0, int(budget_chars))
        # Match LLMClient.estimate_input_tokens: escaped non-ASCII schema text must consume budget
        # exactly as it does in the provider request estimate.
        entries = self._catalog_search_entries(schemas)
        sizes = [entry[1] for entry in entries]
        if sum(sizes) <= budget:
            return schemas, False
        budget = max(0, budget - max(0, int(reserve_chars)))
        active = set(active or ())
        terms = self._catalog_terms(query)
        ranked = []
        for index, entry in enumerate(entries):
            schema = entry[0]
            name = str((schema.get("function") or {}).get("name") or "")
            score = self._entry_relevance(entry, query, terms)
            if name in active or score > 0:
                ranked.append((0 if name in active else 1, -score, index, schema, sizes[index]))
        ranked.sort(key=lambda row: (row[0], row[1], row[2]))
        selected, used = [], 0
        for _, _, _, schema, size in ranked:
            if size <= budget - used:
                selected.append(schema)
                used += size
        return selected, True

    def call(self, full_name: str, arguments: dict,
             cancel: threading.Event | None = None, *, on_progress=None, on_log=None,
             input_handler=None) -> str:
        with self._catalog_state_lock:
            route = self._routes.get(full_name)
            server = self.servers.get(route[0]) if route else None
        if not route:
            return f"ERROR: unknown MCP tool route: {full_name}"
        server_name, tool = route
        if not server:
            return f"ERROR: MCP server '{server_name}' is not connected"
        return server.call_tool(tool, arguments, cancel=cancel,
                                on_progress=on_progress, on_log=on_log,
                                input_handler=input_handler)

    def has_route(self, full_name: str) -> bool:
        """Check one exposed route without broadening it or refreshing the catalog."""
        with self._catalog_state_lock:
            return str(full_name) in self._routes

    def status(self) -> list[dict]:
        """Return bounded structured connection state for non-interactive frontends."""
        rows = []
        for name, server in sorted(list(self.servers.items()), key=lambda item: item[0]):
            live = server.proc is not None and server.proc.poll() is None
            row = {
                "name": str(name)[:128],
                "state": "connected" if live else "disconnected",
                "tool_count": len(server.tools),
                "protocol_version": str(server.protocol_version or "")[:64],
                "protocol_era": str(server.protocol_era or "")[:32],
                "catalog": ("subscribed" if server._subscription_live()
                            else str(server.tools_cache_scope or "cached"))[:32],
                "dropped_env": [str(value)[:128] for value in server._env_dropped[:64]],
            }
            if not live:
                row["error"] = str(
                    server.error or server._diagnostic_tail() or "process exited")[:500]
            rows.append(row)
        connected = set(self.servers)
        for name, error in sorted(list(self.failures.items()), key=lambda item: item[0]):
            if name not in connected:
                rows.append({"name": str(name)[:128], "state": "failed", "tool_count": 0,
                             "protocol_version": "", "protocol_era": "", "catalog": "",
                             "dropped_env": [], "error": str(error)[:500]})
        return rows

    def summary(self) -> str:
        if not self.servers and not self.failures:
            return "no MCP servers connected"
        rows = []
        for name, server in self.servers.items():
            dropped = f" · dropped env: {', '.join(server._env_dropped)}" if server._env_dropped else ""
            live = server.proc is not None and server.proc.poll() is None
            if live:
                catalog = (" · catalog subscribed" if server._subscription_live()
                           else f" · catalog cache {server.tools_cache_scope}")
                rows.append(f"  {name}: {len(server.tools)} tool(s) · MCP {server.protocol_version or '?'} "
                            f"({server.protocol_era or '?'}){catalog}{dropped}")
            else:
                detail = server.error or server._diagnostic_tail() or "process exited"
                rows.append(f"  {name}: disconnected · {detail[:500]}{dropped}")
        for name, error in self.failures.items():
            rows.append(f"  {name}: failed · {error[:500]}")
        return "\n".join(rows)

    def stop_all(self) -> None:
        for server in list(self.servers.values()):
            server.stop()
        with self._catalog_state_lock:
            self.servers.clear()
            self._routes.clear()
            self._tool_schema_cache = ()
            self._tool_search_cache = ()
        self.failures.clear()
