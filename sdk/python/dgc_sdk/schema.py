"""Harness-side JSON Schema subset used for ``output_schema``.

This is not a full JSON Schema implementation. Unsupported keywords are rejected rather than
ignored. Remote ``$ref`` is refused. Repair happens in the session after tools have finished.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from .errors import DGCConfigError

_ALLOWED = frozenset({
    "type", "properties", "required", "items", "enum", "additionalProperties",
    "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems",
    "description", "title", "default",
})
_JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)


def assert_supported(schema: Mapping[str, Any]) -> None:
    if not isinstance(schema, dict) or not schema:
        raise DGCConfigError("output_schema must be a non-empty object")
    _walk(schema)


def _walk(node: Any) -> None:
    if not isinstance(node, dict):
        return
    if "$ref" in node or "$id" in node or "$schema" in node:
        raise DGCConfigError("output_schema must not use $ref, $id, or $schema")
    unknown = set(node) - _ALLOWED
    if unknown:
        raise DGCConfigError(f"output_schema has unsupported keyword: {sorted(unknown)[0]}")
    props = node.get("properties")
    if isinstance(props, dict):
        for child in props.values():
            _walk(child)
    items = node.get("items")
    if isinstance(items, dict):
        _walk(items)


def extract_json(text: str) -> Any:
    raw = (text or "").strip()
    if not raw:
        raise ValueError("final text is empty")
    match = _JSON_FENCE.search(raw)
    if match:
        raw = match.group(1)
    else:
        start_obj, start_arr = raw.find("{"), raw.find("[")
        starts = [index for index in (start_obj, start_arr) if index >= 0]
        if starts:
            raw = raw[min(starts):]
    return json.loads(raw)


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
