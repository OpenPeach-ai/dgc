"""Side-effect-free discovery and validation for DGC's public editor protocol.

This command deliberately does not construct ``Config`` or start ``dgc serve``. Frontend and CI
authors can therefore inspect the exact installed contract without touching user state or a model
endpoint.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from importlib import resources
from pathlib import Path

from . import __version__
from .commands import command_specs
from .editor_protocol import (
    COMMAND_FIELDS,
    EVENT_FIELDS,
    MAX_COMMAND_BYTES,
    MAX_EVENT_BYTES,
    MAX_PENDING_BYTES,
    MAX_PENDING_COMMANDS,
    PROTOCOL_VERSION,
    command_error,
    event_error,
    schema_text,
)
from .protocol import strict_json_loads


def _bundled_schema_text() -> str:
    resource = (resources.files("dgc") / "schemas"
                / f"editor-protocol-v{PROTOCOL_VERSION}.schema.json")
    return resource.read_text(encoding="utf-8")


def _message_summary(specs: dict[str, dict[str, dict]]) -> list[dict]:
    return [
        {
            "type": name,
            "required": [key for key, field in fields.items() if field["required"]],
            "optional": [key for key, field in fields.items() if not field["required"]],
        }
        for name, fields in specs.items()
    ]


def _slash_summary(surface: str) -> list[dict]:
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "usage": spec.usage or spec.name,
            "aliases": list(spec.aliases),
            **({"action": spec.editor_action} if spec.editor_action else {}),
            **({"accepts_args": True} if spec.accepts_args else {}),
        }
        for spec in command_specs(surface)
    ]


def describe_document() -> dict:
    """Return a bounded, JSON-native description of the installed public surface."""
    bundled = _bundled_schema_text()
    generated = schema_text()
    if bundled != generated:
        raise RuntimeError("the bundled protocol schema does not match this DGC runtime")
    return {
        "schema_version": 1,
        "dgc_version": __version__,
        "protocol_version": PROTOCOL_VERSION,
        "schema_id": f"urn:vibedgc:editor-protocol:v{PROTOCOL_VERSION}",
        "schema_sha256": hashlib.sha256(bundled.encode("utf-8")).hexdigest(),
        "limits": {
            "event_bytes": MAX_EVENT_BYTES,
            "command_bytes": MAX_COMMAND_BYTES,
            "pending_bytes": MAX_PENDING_BYTES,
            "pending_commands": MAX_PENDING_COMMANDS,
        },
        "headless": {
            "transport": "ndjson-stdio",
            "command": "dgc serve",
            "commands": _message_summary(COMMAND_FIELDS),
            "events": _message_summary(EVENT_FIELDS),
        },
        "slash_commands": {
            surface: _slash_summary(surface) for surface in ("tui", "classic", "editor")
        },
    }


def _safe_problem(problem: str | None) -> str:
    """Keep validator diagnostics useful without reflecting untrusted frame values."""
    value = str(problem or "invalid frame")
    if value.startswith("unknown message type"):
        return "unknown message type"
    if " has undeclared field " in value:
        return value.split(" has undeclared field ", 1)[0] + " has an undeclared field"
    return value[:300]


def _bounded_lines(stream, maximum: int):
    line_number = 0
    while True:
        raw = stream.readline(maximum + 1)
        if not raw:
            return
        line_number += 1
        if isinstance(raw, str):
            try:
                raw = raw.encode("utf-8")
            except UnicodeError:
                yield line_number, None, "frame was not valid UTF-8"
                continue
        if len(raw) > maximum:
            while raw and not raw.endswith(b"\n"):
                raw = stream.readline(maximum + 1)
                if isinstance(raw, str):
                    raw = raw.encode("utf-8", errors="replace")
            yield line_number, None, f"frame exceeded {maximum} bytes"
            continue
        try:
            yield line_number, raw.decode("utf-8"), None
        except UnicodeDecodeError:
            yield line_number, None, "frame was not valid UTF-8"


def _validate(kind: str, path: str) -> int:
    maximum = MAX_COMMAND_BYTES if kind == "command" else MAX_EVENT_BYTES
    validate = command_error if kind == "command" else event_error
    handle = None
    stream = getattr(sys.stdin, "buffer", sys.stdin)
    try:
        if path != "-":
            handle = Path(path).open("rb")
            stream = handle
        valid = True
        seen = 0
        for line_number, text, framing_error in _bounded_lines(stream, maximum):
            if text is not None and not text.strip():
                continue
            seen += 1
            problem = framing_error
            value = None
            if problem is None:
                try:
                    value = strict_json_loads(text)
                except (json.JSONDecodeError, TypeError, ValueError):
                    problem = "frame was not valid JSON"
            if problem is None:
                problem = validate(value)
            row = {"line": line_number, "kind": kind, "valid": problem is None}
            if problem is None:
                row["type"] = value["type"]
            else:
                valid = False
                row["error"] = _safe_problem(problem)
            print(json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
        if not seen:
            print(json.dumps({"line": 0, "kind": kind, "valid": False,
                              "error": "no frames were provided"}, separators=(",", ":"),
                             sort_keys=True))
            return 1
        return 0 if valid else 1
    except OSError as exc:
        print(f"dgc protocol: could not read input ({type(exc).__name__})", file=sys.stderr)
        return 2
    finally:
        if handle is not None:
            handle.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dgc protocol",
        description="Inspect or validate DGC's installed editor/headless protocol contract.",
    )
    subparsers = parser.add_subparsers(dest="operation", required=True)
    describe = subparsers.add_parser("describe", help="print exact commands, events, and slash surfaces")
    describe.add_argument("--compact", action="store_true", help="emit compact JSON")
    subparsers.add_parser("schema", help="print the bundled draft-2020-12 JSON Schema")
    validate = subparsers.add_parser("validate", help="validate NDJSON frames without starting DGC")
    validate.add_argument("kind", choices=("command", "event"))
    validate.add_argument("path", nargs="?", default="-", help="NDJSON file, or - for stdin")
    args = parser.parse_args(argv)

    try:
        if args.operation == "describe":
            print(json.dumps(describe_document(), ensure_ascii=False,
                             separators=((",", ":") if args.compact else None),
                             indent=(None if args.compact else 2), sort_keys=True))
            return 0
        if args.operation == "schema":
            bundled = _bundled_schema_text()
            if bundled != schema_text():
                print("dgc protocol: bundled schema does not match this runtime", file=sys.stderr)
                return 1
            sys.stdout.write(bundled)
            return 0
        return _validate(args.kind, args.path)
    except (OSError, RuntimeError) as exc:
        print(f"dgc protocol: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
