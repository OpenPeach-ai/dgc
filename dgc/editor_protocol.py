"""Authoritative DGC editor/headless protocol-v4 contract and code generation.

The Python backend imports this module directly.  The VS Code/Cursor client and the reviewable
JSON Schema are generated from the same data by ``scripts/generate-editor-protocol.py``; tests fail
when either checked-in artifact drifts from this source.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

PROTOCOL_VERSION = 4
MAX_EVENT_BYTES = 4 * 1024 * 1024
MAX_COMMAND_BYTES = 4 * 1024 * 1024
MAX_PENDING_BYTES = 4 * 1024 * 1024
MAX_PENDING_COMMANDS = 256
MAX_SAFE_INTEGER = (1 << 53) - 1


def _f(*kinds: str, required: bool = True, enum: tuple | None = None) -> dict:
    field = {"types": list(kinds), "required": required}
    if enum is not None:
        field["enum"] = list(enum)
    return field


_S = lambda required=True: _f("string", required=required)
_I = lambda required=True: _f("integer", required=required)
_B = lambda required=True: _f("boolean", required=required)
_O = lambda required=True: _f("object", required=required)
_A = lambda required=True: _f("array", required=required)
_N = lambda required=True: _f("number", required=required)
_NS = lambda required=True: _f("null", "string", required=required)
_NA = lambda required=True: _f("null", "array", required=required)


# ``required`` marks the minimum contract each consumer may rely on. Optional top-level fields are
# still declared and type-checked; undeclared fields fail closed so a mismatched or compromised
# backend cannot smuggle arbitrary data into the editor webview.
EVENT_FIELDS: dict[str, dict[str, dict]] = {
    "ready": {
        "version": _S(), "protocol_version": _I(), "capabilities": _O(),
        "model": _S(),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "think": _f("string", enum=("off", "low", "medium", "high")),
        "base_url": _S(), "subagent_base_url": _S(False), "fallback_base_url": _S(False),
        "project_root": _S(False),
        "workspace_trusted": _B(), "commands": _A(), "custom_commands": _A(),
        "session_id": _NS(False), "tools_supported": _B(False), "provider": _S(False),
        "provider_capabilities": _O(False), "tools": _A(False), "skills": _A(False),
        "goal": _O(), "context_size": _I(),
    },
    "turn_start": {"turn_id": _S(), "prompt": _S()},
    "turn_end": {
        "turn_id": _S(), "reason": _f("string", enum=("completed", "cancelled", "error")),
        "token_estimate": _I(),
    },
    "text_delta": {"text": _S()},
    "thinking_delta": {"text": _S()},
    "stream_end": {},
    "tool_call": {"call_id": _NS(False), "name": _S(), "args": _O(), "summary": _S()},
    "tool_progress": {
        "call_id": _NS(False), "name": _S(), "message": _S(),
        "progress": _N(False), "total": _N(False),
        "level": _f("string", required=False,
                    enum=("debug", "info", "notice", "warning", "error", "critical", "alert", "emergency")),
    },
    "tool_result": {
        "call_id": _NS(False), "name": _S(), "output": _S(), "is_error": _B(),
        "is_diff": _B(), "diff": _S(False),
    },
    "tool_denied": {
        "call_id": _NS(False), "name": _S(), "args": _O(), "reason": _S(),
    },
    "todos": {"todos": _A()},
    "artifact_ready": {"id": _S(), "name": _S(), "url": _S(), "rel": _S()},
    "goal_changed": {
        "goal": _S(),
        "status": _f("string", enum=("none", "active", "completed", "blocked")),
        "elapsed_seconds": _I(False),
        "request_id": _S(False),
    },
    "info": {"message": _S()},
    "error": {"message": _S(), "request_id": _S(False)},
    "request_expired": {"id": _S()},
    "permission_request": {
        "id": _S(), "call_id": _NS(False), "name": _S(), "args": _O(),
        "command": _NS(False), "suggested_rule": _S(), "choices": _A(),
    },
    "rule_added": {"rule": _S()},
    "plan_proposal": {"id": _S(), "plan": _S(), "choices": _A()},
    "options_request": {"id": _S(), "question": _S(), "options": _A()},
    "mcp_input_request": {
        "id": _S(), "server": _S(),
        "kind": _f("string", enum=("elicitation", "sampling_request", "sampling_response")),
        "payload": _O(),
    },
    "context": {
        "request_id": _S(False),
        "used": _I(), "size": _I(), "input_tokens": _I(False),
        "output_tokens": _I(False), "cached_input_tokens": _I(False),
        "reasoning_tokens": _I(False), "requests": _I(False),
    },
    "artifacts": {"items": _A(), "request_id": _S(False)},
    "config": {
        "request_id": _S(False),
        "model": _S(),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "think": _f("string", enum=("off", "low", "medium", "high")),
        "base_url": _S(), "api_mode": _S(False), "provider_state": _S(False),
        "prompt_cache": _B(False), "capability_cache_ttl_s": _I(False),
        "provider_capabilities": _O(False), "project_root": _S(), "search": _NS(False),
        "subagent_model": _S(False), "subagent_base_url": _S(False),
        "subagent_api_mode": _S(False), "subagent_api_key_set": _B(False),
        "fallback_model": _S(False), "fallback_base_url": _S(False),
        "fallback_api_mode": _S(False), "fallback_api_key_set": _B(False),
        "context_size": _I(False), "goal": _O(),
        "sandbox": _B(False), "sandbox_network": _B(False),
        "show_reasoning": _B(False), "suggest": _B(False),
        "plan_artifact": _B(False), "artifact_autostart": _B(False),
        "artifact_in_plan": _B(False), "tool_profile": _S(False),
        "max_parallel_tasks": _I(False),
        "subscription_engine": _S(False), "subscription_engines": _A(False),
        "subscription_model": _S(False), "subscription_effort": _S(False),
    },
    "status": {
        "request_id": _S(False),
        "model": _S(),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "think": _f("string", enum=("off", "low", "medium", "high")),
        "base_url": _S(),
        "goal": _O(), "context_used": _I(), "context_size": _I(),
    },
    "model_changed": {"model": _S(), "base_url": _S(), "request_id": _S(False)},
    "mode_changed": {
        "request_id": _S(False),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "workspace_trusted": _B(False),
    },
    "think_changed": {
        "think": _f("string", enum=("off", "low", "medium", "high")),
        "request_id": _S(False),
    },
    "models": {
        "request_id": _S(), "ids": _A(), "base_url": _S(),
        "api_mode": _S(False), "error": _S(False),
    },
    "mcp_tools": {
        "request_id": _S(), "servers": _A(), "tools": _A(), "total": _I(),
        "offset": _I(), "next_offset": _f("null", "integer"), "error": _S(False),
    },
    "mcp_call_complete": {
        "request_id": _S(), "call_id": _S(), "name": _S(),
        "status": _f("string", enum=("completed", "denied", "cancelled", "error")),
        "output": _S(),
    },
    "skill_catalog": {"request_id": _S(), "items": _A(), "total": _I()},
    "skill_detail": {
        "request_id": _S(), "found": _B(), "name": _S(), "description": _S(),
        "source": _S(), "markdown": _S(),
    },
    "docs_catalog": {"request_id": _S(), "items": _A(), "total": _I()},
    "doc": {
        "request_id": _S(), "found": _B(), "id": _S(), "title": _S(),
        "description": _S(), "markdown": _S(),
    },
    "mcp_servers": {
        "request_id": _S(), "items": _A(), "total": _I(), "error": _S(False),
    },
    "permissions": {"request_id": _S(), "items": _A(), "total": _I()},
    "memory": {
        "request_id": _S(), "project": _S(), "user": _S(), "message": _S(False),
    },
    "session_named": {"request_id": _S(False), "name": _S()},
    "hook_catalog": {
        "request_id": _S(), "items": _A(), "total": _I(), "invalid": _I(),
    },
    "hook_activity": {
        "event": _f("string", enum=("SessionStart", "UserPromptSubmit", "PreToolUse",
                                     "PostToolUse", "PreCompact", "Stop")),
        "status": _f("string", enum=("started", "completed", "blocked",
                                      "cancelled", "error")),
        "configured": _I(), "duration_ms": _I(), "message": _NS(False),
    },
    "handoff_started": {"request_id": _S()},
    "handoff": {
        "request_id": _S(),
        "status": _f("string", enum=("completed", "cancelled", "error")),
        "markdown": _S(), "path": _NS(False), "error": _NS(False),
    },
    "queued": {"count": _I(), "text": _S()},
    "command_rejected": {
        "message": _S(), "command": _S(False), "reason": _S(False), "count": _I(False),
        "request_id": _S(False),
    },
    "workspace_roots": {"roots": _A(), "request_id": _S(False)},
    "saved_plan": {"plan": _S(), "exists": _B(), "request_id": _S(False)},
    "session": {
        "kind": _f("string", enum=("new", "cleared", "resumed")),
        "message_count": _I(), "session_id": _S(False), "path": _S(False),
        "request_id": _S(False),
    },
    "history": {"items": _A()},
    "sessions": {"items": _A(), "deleted": _B(False), "request_id": _S(False)},
    "checkpoints": {"items": _A(), "request_id": _S(False)},
    "rewound": {"ok": _B(), "files_restored": _I(), "request_id": _S(False)},
    "retained_tasks": {
        "items": _A(), "errors": _A(False), "total": _I(False), "request_id": _S(False),
    },
}


COMMAND_FIELDS: dict[str, dict[str, dict]] = {
    "prompt": {"text": _S(), "images": _NA(False), "context": _NA(False)},
    "slash_command": {"text": _S()},
    "set_workspace_roots": {"roots": _A(), "request_id": _S(False)},
    "permission_response": {
        "id": _S(), "decision": _f("string", enum=("once", "always", "deny", "no")),
        "rule": _S(False),
    },
    "plan_response": {
        "id": _S(),
        "decision": _f("string", enum=("auto", "acceptEdits", "default", "reject")),
        "feedback": _S(False),
    },
    "options_response": {"id": _S(), "choice": _f("string", "integer")},
    "mcp_input_response": {
        "id": _S(), "action": _f("string", enum=("accept", "decline", "cancel")),
        "content": _O(False),
    },
    "cancel": {},
    "interrupt": {},
    "set_mode": {
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "acknowledge_workspace_trust": _B(False), "request_id": _S(False),
    },
    "set_model": {
        "model": _S(False), "base_url": _S(False), "api_key": _S(False),
        "clear_stored_api_key": _B(False), "request_id": _S(False),
    },
    "list_models": {"request_id": _S(False)},
    "list_mcp_tools": {
        "request_id": _S(), "offset": _I(False), "limit": _I(False),
    },
    "call_mcp_tool": {
        "request_id": _S(), "call_id": _S(False), "name": _S(), "arguments": _O(),
    },
    "list_skills": {"request_id": _S()},
    "reload_skills": {"request_id": _S()},
    "get_skill": {"request_id": _S(), "name": _S()},
    "list_docs": {"request_id": _S()},
    "get_doc": {"request_id": _S(), "id": _S()},
    "list_mcp_servers": {"request_id": _S()},
    "upsert_mcp_server": {
        "request_id": _S(), "name": _S(), "runtime": _O(), "persisted": _O(),
    },
    "remove_mcp_server": {"request_id": _S(), "name": _S()},
    "reload_mcp_servers": {"request_id": _S()},
    "list_permissions": {"request_id": _S()},
    "add_permission_rule": {
        "request_id": _S(),
        "action": _f("string", enum=("allow", "ask", "deny")), "rule": _S(),
    },
    "remove_permission_rule": {
        "request_id": _S(),
        "action": _f("string", enum=("allow", "ask", "deny")), "rule": _S(),
    },
    "get_memory": {"request_id": _S()},
    "add_memory": {
        "request_id": _S(), "scope": _f("string", enum=("project", "user")), "text": _S(),
    },
    "list_hooks": {"request_id": _S()},
    "generate_handoff": {"request_id": _S(), "save": _B(False)},
    "set_think": {
        "level": _f("string", enum=("off", "low", "medium", "high")),
        "request_id": _S(False),
    },
    "set_goal": {
        "text": _S(False),
        "status": _f("string", required=False,
                     enum=("none", "active", "completed", "blocked")),
        "request_id": _S(False),
    },
    "get_goal": {"request_id": _S(False)},
    "get_plan": {"request_id": _S(False)},
    "new_session": {"request_id": _S(False)},
    "name_session": {"name": _S(), "request_id": _S(False)},
    "clear_session": {"request_id": _S(False)},
    "resume_session": {"path": _NS(False), "latest": _B(False), "request_id": _S(False)},
    "list_sessions": {"request_id": _S(False)},
    "delete_session": {"path": _S(), "request_id": _S(False)},
    "list_checkpoints": {"request_id": _S(False)},
    "rewind": {"index": _I(), "request_id": _S(False)},
    "list_retained_tasks": {"request_id": _S(False)},
    "resolve_retained_task": {
        "id": _S(), "action": _f("string", enum=("apply", "drop")), "confirm": _B(False),
        "request_id": _S(False),
    },
    "compact": {"request_id": _S(False)},
    "list_artifacts": {"request_id": _S(False)},
    "stop_artifact": {"id": _S(), "request_id": _S(False)},
    "set_config": {"values": _O(), "request_id": _S(False)},
    "get_config": {"request_id": _S(False)},
    "status": {"request_id": _S(False)},
    "shutdown": {},
}


def _type_ok(value, kind: str) -> bool:
    if kind == "null":
        return value is None
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return (isinstance(value, int) and not isinstance(value, bool)
                and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER)
    if kind == "number":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        try:
            return math.isfinite(value) and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
        except OverflowError:
            return False
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    return False


def _shown(value) -> str:
    if isinstance(value, str):
        return repr(value[:128] + ("…" if len(value) > 128 else ""))
    if value is None or isinstance(value, (int, float, bool)):
        return repr(value)
    return f"<{type(value).__name__}>"


def _message_error(value, specs: dict[str, dict[str, dict]], *, sequence: bool) -> str | None:
    if not isinstance(value, dict):
        return "message must be an object"
    name = value.get("type")
    if not isinstance(name, str) or name not in specs:
        return f"unknown message type {_shown(name)}"
    if sequence and (not _type_ok(value.get("seq"), "integer") or value["seq"] < 0):
        return "event seq must be a non-negative integer"
    allowed = {"type", *specs[name]}
    if sequence:
        allowed.add("seq")
    extra = sorted(set(value) - allowed)
    if extra:
        return f"{name} has undeclared field {_shown(extra[0])}"
    for key, field in specs[name].items():
        if key not in value:
            if field["required"]:
                return f"{name}.{key} is required"
            continue
        if not any(_type_ok(value[key], kind) for kind in field["types"]):
            return f"{name}.{key} has the wrong type"
        if "enum" in field and value[key] not in field["enum"]:
            return f"{name}.{key} has an unsupported value"
    return None


def event_error(value) -> str | None:
    return _message_error(value, EVENT_FIELDS, sequence=True)


def command_error(value) -> str | None:
    return _message_error(value, COMMAND_FIELDS, sequence=False)


def _json_type(field: dict) -> dict:
    kinds = field["types"]
    def branch(kind: str) -> dict:
        value = {"type": kind}
        if kind in ("integer", "number"):
            value.update(minimum=-MAX_SAFE_INTEGER, maximum=MAX_SAFE_INTEGER)
        return value
    # JSON Schema permits ``type: [..]``, but strict AJV requires a consumer-specific
    # ``allowUnionTypes`` option for it.  Explicit branches keep the generated public contract
    # portable across default draft-2020 validators.
    schema: dict = (branch(kinds[0]) if len(kinds) == 1 else {
        "anyOf": [branch(kind) for kind in kinds]
    })
    if "enum" in field:
        schema["enum"] = field["enum"]
    return schema


def _message_schema(name: str, fields: dict[str, dict], *, sequence: bool) -> dict:
    properties = {"type": {"const": name}}
    required = ["type"]
    if sequence:
        properties["seq"] = {"type": "integer", "minimum": 0,
                             "maximum": MAX_SAFE_INTEGER}
        required.append("seq")
    for key, field in fields.items():
        properties[key] = _json_type(field)
        if field["required"]:
            required.append(key)
    return {"type": "object", "properties": properties,
            "required": required, "additionalProperties": False}


def schema_document() -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"urn:vibedgc:editor-protocol:v{PROTOCOL_VERSION}",
        "title": f"DGC editor protocol v{PROTOCOL_VERSION}",
        "description": "A DGC editor command or backend event frame.",
        "oneOf": [{"$ref": "#/$defs/event"}, {"$ref": "#/$defs/command"}],
        "$defs": {
            "event": {"oneOf": [_message_schema(k, v, sequence=True)
                                  for k, v in EVENT_FIELDS.items()]},
            "command": {"oneOf": [_message_schema(k, v, sequence=False)
                                    for k, v in COMMAND_FIELDS.items()]},
        },
    }


def schema_text() -> str:
    return json.dumps(schema_document(), indent=2, ensure_ascii=False) + "\n"


def typescript_source() -> str:
    event_specs = json.dumps(EVENT_FIELDS, indent=2, ensure_ascii=False)
    command_specs = json.dumps(COMMAND_FIELDS, indent=2, ensure_ascii=False)
    event_names = " | ".join(json.dumps(name) for name in EVENT_FIELDS)
    command_names = " | ".join(json.dumps(name) for name in COMMAND_FIELDS)
    return f'''// GENERATED by scripts/generate-editor-protocol.py from dgc/editor_protocol.py.
// Do not edit this file directly.

export const DGC_PROTOCOL_VERSION = {PROTOCOL_VERSION} as const;
export const MAX_EVENT_BYTES = {MAX_EVENT_BYTES};
export const MAX_COMMAND_BYTES = {MAX_COMMAND_BYTES};
export const MAX_PENDING_BYTES = {MAX_PENDING_BYTES};
export const MAX_PENDING_COMMANDS = {MAX_PENDING_COMMANDS};

export type DgcEventType = {event_names};
export type DgcCommandType = {command_names};
export interface DgcEvent {{ type: DgcEventType; seq: number; [key: string]: any; }}
export interface DgcCommand {{ type: DgcCommandType; [key: string]: any; }}

type FieldSpec = {{ types: string[]; required: boolean; enum?: unknown[] }};
const EVENT_FIELDS: Record<string, Record<string, FieldSpec>> = {event_specs};
const COMMAND_FIELDS: Record<string, Record<string, FieldSpec>> = {command_specs};

function isObject(value: unknown): value is Record<string, unknown> {{
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}}

function typeOk(value: unknown, kind: string): boolean {{
  if (kind === "null") return value === null;
  if (kind === "string") return typeof value === "string";
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "integer") return Number.isSafeInteger(value);
  if (kind === "number") return typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (kind === "array") return Array.isArray(value);
  if (kind === "object") return isObject(value);
  return false;
}}

function shown(value: unknown): string {{
  if (typeof value === "string") {{
    const short = value.slice(0, 128) + (value.length > 128 ? "…" : "");
    return JSON.stringify(short);
  }}
  if (value === null || ["number", "boolean", "undefined"].includes(typeof value)) {{
    return String(value);
  }}
  return `<${{Array.isArray(value) ? "array" : typeof value}}>`;
}}

function messageError(value: unknown, specs: Record<string, Record<string, FieldSpec>>,
                      sequence: boolean): string | undefined {{
  if (!isObject(value)) return "message must be an object";
  const name = value.type;
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(specs, name)) {{
    return `unknown message type ${{shown(name)}}`;
  }}
  if (sequence && (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0)) {{
    return "event seq must be a non-negative integer";
  }}
  const allowed = new Set(["type", ...(sequence ? ["seq"] : []), ...Object.keys(specs[name])]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) return `${{name}} has undeclared field ${{shown(extra)}}`;
  for (const [key, field] of Object.entries(specs[name])) {{
    if (!Object.prototype.hasOwnProperty.call(value, key)) {{
      if (field.required) return `${{name}}.${{key}} is required`;
      continue;
    }}
    if (!field.types.some((kind) => typeOk(value[key], kind))) {{
      return `${{name}}.${{key}} has the wrong type`;
    }}
    if (field.enum && !field.enum.includes(value[key])) {{
      return `${{name}}.${{key}} has an unsupported value`;
    }}
  }}
  return undefined;
}}

export function dgcEventError(value: unknown): string | undefined {{
  return messageError(value, EVENT_FIELDS, true);
}}

export function dgcCommandError(value: unknown): string | undefined {{
  return messageError(value, COMMAND_FIELDS, false);
}}
'''


def write_generated(root: Path) -> tuple[Path, Path, Path]:
    schema_path = root / "schemas" / f"editor-protocol-v{PROTOCOL_VERSION}.schema.json"
    package_schema_path = (root / "dgc" / "schemas"
                           / f"editor-protocol-v{PROTOCOL_VERSION}.schema.json")
    ts_path = root / "editors" / "vscode" / "src" / "protocol.generated.ts"
    schema_path.parent.mkdir(parents=True, exist_ok=True)
    package_schema_path.parent.mkdir(parents=True, exist_ok=True)
    ts_path.parent.mkdir(parents=True, exist_ok=True)
    generated_schema = schema_text()
    schema_path.write_text(generated_schema)
    package_schema_path.write_text(generated_schema)
    ts_path.write_text(typescript_source())
    return schema_path, package_schema_path, ts_path
