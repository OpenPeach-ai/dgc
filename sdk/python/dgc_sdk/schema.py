"""Harness-side JSON Schema subset used for ``output_schema``.

This is not a full JSON Schema implementation. Unsupported keywords are rejected rather than
ignored. Remote ``$ref`` is refused. Repair happens in the session after tools have finished.
"""

from __future__ import annotations

import json
import math
from typing import Any, Mapping

from .errors import DGCConfigError

_ALLOWED = frozenset({
    "type", "properties", "required", "items", "enum", "additionalProperties",
    "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems",
    "description", "title", "default",
})
_TYPES = frozenset({"object", "array", "string", "integer", "number", "boolean", "null"})
_COUNTS = frozenset({"minLength", "maxLength", "minItems", "maxItems"})
_LIMITS = frozenset({"minimum", "maximum"})


def assert_supported(schema: Mapping[str, Any]) -> None:
    if not isinstance(schema, dict) or not schema:
        raise DGCConfigError("output_schema must be a non-empty object")
    _walk(schema, set(), 0)


def _walk(node: Any, ancestors: set[int], depth: int) -> None:
    if not isinstance(node, dict) or depth > 64 or id(node) in ancestors:
        raise DGCConfigError("output_schema must contain finite, acyclic schema objects")
    ancestors.add(id(node))
    try:
        _check_node(node, ancestors, depth)
    finally:
        ancestors.remove(id(node))


def _check_node(node: dict[str, Any], ancestors: set[int], depth: int) -> None:
    if "$ref" in node or "$id" in node or "$schema" in node:
        raise DGCConfigError("output_schema must not use $ref, $id, or $schema")
    if any(not isinstance(key, str) for key in node):
        raise DGCConfigError("output_schema keys must be strings")
    unknown = set(node) - _ALLOWED
    if unknown:
        raise DGCConfigError(f"output_schema has unsupported keyword: {sorted(unknown)[0]}")
    expected = node.get("type")
    if "type" in node:
        types = expected if isinstance(expected, list) else [expected]
        if not types or any(not isinstance(kind, str) or kind not in _TYPES for kind in types):
            raise DGCConfigError("output_schema type must name supported JSON types")
    required = node.get("required")
    if "required" in node and (not isinstance(required, list) or
                                 any(not isinstance(key, str) for key in required)):
        raise DGCConfigError("output_schema required must be an array of strings")
    enum = node.get("enum")
    if "enum" in node and (not isinstance(enum, list) or not enum):
        raise DGCConfigError("output_schema enum must be a non-empty array")
    for key in ("enum", "default"):
        if key in node:
            try:
                json.dumps(node[key], allow_nan=False)
            except (TypeError, ValueError, OverflowError, RecursionError) as exc:
                raise DGCConfigError(f"output_schema {key} must contain JSON values") from exc
    for key in _COUNTS & node.keys():
        count = node[key]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise DGCConfigError(f"output_schema {key} must be a non-negative integer")
    for key in _LIMITS & node.keys():
        limit = node[key]
        try:
            finite = isinstance(limit, (int, float)) and not isinstance(limit, bool) and math.isfinite(limit)
        except OverflowError:
            finite = False
        if not finite:
            raise DGCConfigError(f"output_schema {key} must be a finite number")
    for key in ("title", "description"):
        if key in node and not isinstance(node[key], str):
            raise DGCConfigError(f"output_schema {key} must be a string")
    props = node.get("properties")
    if "properties" in node:
        if not isinstance(props, dict) or any(not isinstance(key, str) for key in props):
            raise DGCConfigError("output_schema properties must be an object")
        for child in props.values():
            _walk(child, ancestors, depth + 1)
    items = node.get("items")
    if "items" in node:
        _walk(items, ancestors, depth + 1)
    additional = node.get("additionalProperties")
    if "additionalProperties" in node and not isinstance(additional, bool):
        _walk(additional, ancestors, depth + 1)


def _fenced(raw: str) -> str | None:
    """The first fenced block (```, or ```json) whose body is a JSON object or array: a reply may show another block
    (the commands it ran) first. The TypeScript SDK's extractJson reads the same way (tests/fixtures/sdk_extract_json.json)."""
    at = 0
    while True:
        opened = raw.find("```", at)
        if opened < 0:
            return None
        start = opened + 3
        if raw[start:start + 4].lower() == "json":
            start += 4
        closed = raw.find("```", start)
        if closed < 0:
            return None
        body = raw[start:closed].strip()
        if body[:1] in ("{", "["):
            return body
        at = closed + 3


def _not_json(name: str):
    raise ValueError(f"{name} is not JSON")       # as JSON.parse: NaN and Infinity are no JSON


def extract_json(text: str) -> Any:
    raw = (text or "").strip()
    if not raw:
        raise ValueError("final text is empty")
    body = _fenced(raw)
    if body is not None:
        raw = body
    else:
        start_obj, start_arr = raw.find("{"), raw.find("[")
        starts = [index for index in (start_obj, start_arr) if index >= 0]
        if starts:
            raw = raw[min(starts):]
    return json.loads(raw, parse_constant=_not_json)


def validate(value: Any, schema: Mapping[str, Any], path: str = "$") -> list[str]:
    errors: list[str] = []
    expected = schema.get("type")
    if expected:
        types = expected if isinstance(expected, list) else [expected]
        if not any(_is_type(value, kind) for kind in types):
            errors.append(f"{path} should be {expected}")
            return errors
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path} is not one of the allowed values")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < int(schema["minLength"]):
            errors.append(f"{path} is shorter than minLength")
        if "maxLength" in schema and len(value) > int(schema["maxLength"]):
            errors.append(f"{path} is longer than maxLength")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path} is below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path} is above maximum")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < int(schema["minItems"]):
            errors.append(f"{path} has too few items")
        if "maxItems" in schema and len(value) > int(schema["maxItems"]):
            errors.append(f"{path} has too many items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                errors.extend(validate(item, item_schema, f"{path}[{index}]"))
    if isinstance(value, dict):
        props_raw = schema.get("properties")
        props = props_raw if isinstance(props_raw, dict) else {}
        required_raw = schema.get("required")
        required = required_raw if isinstance(required_raw, list) else []
        for key in required:
            if key not in value:
                errors.append(f"{path}.{key} is required")
        additional = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in props:
                errors.extend(validate(item, props[key], f"{path}.{key}"))
            elif additional is False:
                errors.append(f"{path}.{key} is not allowed")
            elif isinstance(additional, dict):
                errors.extend(validate(item, additional, f"{path}.{key}"))
    return errors


def _is_type(value: Any, kind: str) -> bool:
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "null":
        return value is None
    return False
