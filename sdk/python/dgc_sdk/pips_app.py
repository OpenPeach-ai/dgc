"""Your app's tools for Personal Pips (Pips API 61): define them, register them, and serve DGC's calls.

Define each tool with :func:`define_pip_tool`, register the app once with ``session.pips.register_app(...)``
(an approved mutation: DGC answers with the app's signing secret, shown that once), then serve DGC's calls at the
address you registered with :class:`AppToolHandler`, mounted in your own web framework::

    from dgc_sdk.pips_app import AppToolHandler, define_pip_tool

    unpaid = define_pip_tool("find_unpaid_orders", "Orders unpaid after N days",
                             {"type": "object", "properties": {"days": {"type": "integer"}}, "required": ["days"]},
                             kind="read")
    handler = AppToolHandler(os.environ["DGC_PIPS_SECRET"], tools={unpaid: lambda args, ctx: db.unpaid(args["days"])})

    @app.post("/dgc/pips")                 # Flask
    def pips():
        return handler.flask(request)

The handler checks each call's signature (HMAC-SHA256, keyed by the secret's text, of ``"<timestamp>.<nonce>."``
followed by the body), refuses a timestamp more than five minutes off and a nonce it has seen (kept in memory,
bounded), checks the arguments against the tool's schema, and answers ``{"ok": true, "result": ...}`` or
``{"ok": false, "error": {"code", "message"}}``. A change tool runs only for a call that carries the action the
user accepted (``ctx.action_id``, ``ctx.action_digest``); DGC sends each accepted action once and never retries it.

Nothing here imports a web framework until its adapter is used: :meth:`AppToolHandler.handle` is framework-free,
:meth:`~AppToolHandler.flask` imports Flask, and :meth:`~AppToolHandler.wsgi` and :meth:`~AppToolHandler.asgi`
(Starlette and FastAPI: ``app.mount("/dgc/pips", handler.asgi)``) need nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import inspect
import json
import logging
import math
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from .errors import DGCConfigError
from .schema import _ALLOWED as SCHEMA_KEYWORDS, validate as schema_errors

__all__ = ["AppToolHandler", "PipCallContext", "PipTool", "PipToolError", "define_pip_tool", "sign"]

PipToolKind = Literal["read", "change"]
TOOL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
SECRET = re.compile(r"dgcapp_[0-9a-f]{64}\Z")
TYPES = frozenset({"object", "array", "string", "integer", "number", "boolean", "null"})
MAX_DESCRIPTION = 1000
MAX_SCHEMA_BYTES = 8192
MAX_SCHEMA_DEPTH = 6
MAX_BODY = 1_000_000
MAX_SKEW_SECONDS = 300
_log = logging.getLogger("dgc_sdk.pips_app")


@dataclass(frozen=True)
class PipTool:
    """One tool of your app, as DGC knows it: what it does, its inputs, and whether it reads or changes."""

    name: str
    description: str
    input_schema: Mapping[str, Any]
    kind: PipToolKind
    moves_money: bool = False

    def __hash__(self) -> int:                  # usable as a key of AppToolHandler's tools
        return hash((self.name, self.kind))

    def to_wire(self) -> dict[str, Any]:
        """The tool as register_app and update_app send it."""
        value: dict[str, Any] = {"name": self.name, "description": self.description,
                                 "input_schema": json.loads(json.dumps(dict(self.input_schema))), "kind": self.kind}
        if self.moves_money:
            value["moves_money"] = True
        return value


def _check_schema(schema: Any, where: str) -> None:
    if not isinstance(schema, Mapping) or schema.get("type") != "object":
        raise DGCConfigError(f"{where} must be a JSON schema object with type \"object\"")
    try:
        size = len(json.dumps(schema, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError, RecursionError) as exc:
        raise DGCConfigError(f"{where} must be plain JSON") from exc
    if size > MAX_SCHEMA_BYTES:
        raise DGCConfigError(f"{where} is over {MAX_SCHEMA_BYTES // 1024} KB")

    def walk(node: Any, depth: int) -> None:
        if depth > MAX_SCHEMA_DEPTH:
            raise DGCConfigError(f"{where} nests more than {MAX_SCHEMA_DEPTH} levels")
        if not isinstance(node, Mapping):
            raise DGCConfigError(f"{where} has a part that isn't a schema object")
        if "$ref" in node or "$id" in node or "$schema" in node:
            raise DGCConfigError(f"{where} must not use $ref, $id or $schema")
        unknown = sorted(set(node) - SCHEMA_KEYWORDS)
        if unknown:
            raise DGCConfigError(f"{where} uses {unknown[0]}, which the schema subset doesn't have")
        kind = node.get("type")
        if kind is not None:
            kinds = kind if isinstance(kind, list) else [kind]
            if not kinds or any(k not in TYPES for k in kinds):
                raise DGCConfigError(f"{where} has an unknown type")
        props = node.get("properties")
        if props is not None:
            if not isinstance(props, Mapping):
                raise DGCConfigError(f"{where}'s properties must be an object")
            for child in props.values():
                walk(child, depth + 1)
        required = node.get("required")
        if required is not None and (not isinstance(required, list) or any(not isinstance(r, str) for r in required)):
            raise DGCConfigError(f"{where}'s required must be a list of names")
        if "items" in node:
            walk(node["items"], depth + 1)
        extra = node.get("additionalProperties")
        if extra is not None and not isinstance(extra, bool):
            walk(extra, depth + 1)
        if "enum" in node and not isinstance(node["enum"], list):
            raise DGCConfigError(f"{where}'s enum must be a list")
        for key in ("minLength", "maxLength", "minItems", "maxItems"):
            if key in node and (type(node[key]) is not int or node[key] < 0):
                raise DGCConfigError(f"{where}'s {key} must be a whole number")
        for key in ("minimum", "maximum"):
            if key in node and (type(node[key]) not in (int, float) or not math.isfinite(node[key])):
                raise DGCConfigError(f"{where}'s {key} must be a number")

    walk(schema, 0)


def define_pip_tool(name: str, description: str, schema: Mapping[str, Any], kind: PipToolKind,
                    moves_money: bool = False) -> PipTool:
    """Describe one tool of your app for Personal Pips.

    ``kind`` is ``"read"`` (a Pip uses it freely, or as an exact approved read before its runs) or ``"change"`` (a
    proposal the user accepts once, or always allows for that Pip). ``moves_money=True`` marks a change that pays,
    refunds or transfers: it asks every time and never gets Always allow. ``schema`` is a JSON schema object in the
    SDK's schema subset (no ``$ref``)."""
    if not isinstance(name, str) or not TOOL_NAME.fullmatch(name):
        raise DGCConfigError("a Pip tool's name is a letter and up to 63 letters, digits, _ or -")
    if not isinstance(description, str) or not description.strip() or len(description) > MAX_DESCRIPTION:
        raise DGCConfigError(f"a Pip tool's description is 1 to {MAX_DESCRIPTION} characters")
    if kind not in ("read", "change"):
        raise DGCConfigError('a Pip tool\'s kind is "read" or "change"')
    if type(moves_money) is not bool:
        raise DGCConfigError("moves_money is True or False")
    if moves_money and kind != "change":
        raise DGCConfigError("only a change tool can move money")
    _check_schema(schema, f"{name}'s schema")
    return PipTool(name=name, description=description.strip(), input_schema=json.loads(json.dumps(dict(schema))),
                   kind=kind, moves_money=moves_money)


def wire_tools(tools: Any) -> list[dict[str, Any]]:
    """register_app's and update_app's ``tools``: PipTool values, or the same shape as plain dicts."""
    if not isinstance(tools, (list, tuple)) or not tools:
        raise DGCConfigError("tools is a non-empty list of define_pip_tool values")
    out = []
    for tool in tools:
        if isinstance(tool, PipTool):
            out.append(tool.to_wire())
        elif isinstance(tool, Mapping):
            out.append(define_pip_tool(tool.get("name"), tool.get("description"), tool.get("input_schema"),
                                       tool.get("kind"), tool.get("moves_money", False)).to_wire()
                       if set(tool) <= {"name", "description", "input_schema", "kind", "moves_money"}
                       else _unknown_fields())
        else:
            raise DGCConfigError("tools is a list of define_pip_tool values")
    return out


def _unknown_fields():
    raise DGCConfigError("a Pip tool has name, description, input_schema, kind and moves_money: nothing else")


def sign(secret: str, timestamp: str, nonce: str, body: bytes) -> str:
    """X-DGC-Signature for one call: ``"v1="`` and the hex HMAC-SHA256 of ``"<timestamp>.<nonce>."`` + body."""
    return "v1=" + hmac.new(secret.encode("utf-8"), f"{timestamp}.{nonce}.".encode("ascii") + body,
                            hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class PipCallContext:
    """Who is calling: the app, the tool, the Pip and its run, and for a change the action the user accepted."""

    app: str
    tool: str
    kind: PipToolKind
    pip_id: str
    run_id: str
    call_id: str
    timestamp: int
    nonce: str
    action_id: str | None = None
    action_digest: str | None = None

    @property
    def approval_id(self) -> str | None:
        """The accepted action's id (a change's receipt): the same as ``action_id``."""
        return self.action_id


class PipToolError(Exception):
    """Raise it in a tool to refuse with a message DGC shows the Pip ("the shop app said: ..."). Any other exception
    is answered as "the tool failed", and logged here, so its details stay in your app."""

    def __init__(self, message: str, code: str = "tool_refused"):
        super().__init__(message)
        self.message, self.code = str(message), str(code)


ToolFunction = Callable[[dict, PipCallContext], Any]
_HEADERS = {"Content-Type": "application/json", "Cache-Control": "no-store"}


def _answer(status: int, value: Any) -> tuple[int, dict[str, str], bytes]:
    return status, dict(_HEADERS), json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _refuse(status: int, code: str, message: str) -> tuple[int, dict[str, str], bytes]:
    return _answer(status, {"ok": False, "error": {"code": code, "message": message}})


class AppToolHandler:
    """Serve DGC's signed calls to your app's tools.

    ``tools`` maps each tool to its function, ``fn(args, ctx)``: keyed by its :class:`PipTool` (from
    :func:`define_pip_tool`), or by its name with the same PipTool values in ``definitions``. A function returns
    what DGC gives the Pip (any JSON value), or raises :class:`PipToolError` to refuse in words.
    """

    def __init__(self, secret: str, tools: Mapping[Any, ToolFunction], *, definitions: list[PipTool] | None = None,
                 max_skew_seconds: int = MAX_SKEW_SECONDS, max_body: int = MAX_BODY, max_nonces: int = 50_000,
                 clock: Callable[[], float] = time.time):
        if not isinstance(secret, str) or not SECRET.fullmatch(secret.strip()):
            raise DGCConfigError("secret is the one register_app answered with: dgcapp_ and 64 hex digits")
        self._secret = secret.strip().encode("utf-8")
        known = {d.name: d for d in definitions or [] if isinstance(d, PipTool)}
        if definitions is not None and len(known) != len(definitions):
            raise DGCConfigError("definitions is a list of define_pip_tool values")
        self._tools: dict[str, tuple[PipTool, ToolFunction]] = {}
        if not isinstance(tools, Mapping) or not tools:
            raise DGCConfigError("tools maps each tool to its function")
        for key, fn in tools.items():
            definition = key if isinstance(key, PipTool) else known.get(key) if isinstance(key, str) else None
            if definition is None:
                raise DGCConfigError(f"{key!r} needs its definition to check its arguments: key it by its define_pip_tool "
                                     "value, or pass that value in definitions")
            if not callable(fn):
                raise DGCConfigError(f"{definition.name}'s function is not callable")
            self._tools[definition.name] = (definition, fn)
        self.max_skew = int(max_skew_seconds)
        self.max_body = int(max_body)
        self.max_nonces = int(max_nonces)
        self._clock = clock
        self._nonces: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    # -- checking a call -----------------------------------------------------------------------------------------

    def _seen(self, nonce: str, now: float) -> bool:
        with self._lock:
            keep = 2 * self.max_skew
            while self._nonces:
                oldest, at = next(iter(self._nonces.items()))
                if now - at <= keep and len(self._nonces) < self.max_nonces:
                    break
                self._nonces.popitem(last=False)
            if nonce in self._nonces:
                return True
            self._nonces[nonce] = now
            return False

    def _check(self, headers: Mapping[str, Any], body: bytes):
        """The tool, its arguments and the context, or the refusal to answer with."""
        lower = {str(k).lower(): (v.decode("latin-1") if isinstance(v, bytes) else str(v)) for k, v in dict(headers).items()}
        timestamp, nonce, given = (lower.get("x-dgc-timestamp", ""), lower.get("x-dgc-nonce", ""),
                                   lower.get("x-dgc-signature", ""))
        if not isinstance(body, (bytes, bytearray)):
            body = str(body or "").encode("utf-8")
        if len(body) > self.max_body:
            return _refuse(413, "too_large", "The call is too large.")
        if not re.fullmatch(r"\d{1,12}", timestamp) or not re.fullmatch(r"[0-9a-f]{32}", nonce) or not given.startswith("v1="):
            return _refuse(401, "unsigned", "The call isn't signed by DGC.")
        want = sign(self._secret.decode("utf-8"), timestamp, nonce, bytes(body))
        if not hmac.compare_digest(want.encode("ascii"), given.encode("ascii", "replace")):
            return _refuse(401, "bad_signature", "The signature didn't match.")
        now = self._clock()
        if abs(now - int(timestamp)) > self.max_skew:
            return _refuse(401, "stale", "The call's time is more than five minutes off.")
        if self._seen(nonce, now):
            return _refuse(401, "replayed", "This call was already received.")
        try:
            call = json.loads(bytes(body).decode("utf-8"))
        except (UnicodeError, ValueError):
            return _refuse(400, "invalid_request", "The call isn't JSON.")
        if (not isinstance(call, dict) or call.get("type") != "tool_call" or not isinstance(call.get("tool"), str)
                or not isinstance(call.get("arguments"), dict)
                or any(not isinstance(call.get(k), str) for k in ("app", "pip_id", "run_id", "call_id"))):
            return _refuse(400, "invalid_request", "The call isn't a DGC tool call.")
        found = self._tools.get(call["tool"])
        if found is None:
            return _refuse(404, "unknown_tool", f"This app has no tool named {call['tool'][:80]}.")
        definition, fn = found
        action_id, action_digest = call.get("action_id"), call.get("action_digest")
        if definition.kind == "change" and not (
                isinstance(action_id, str) and re.fullmatch(r"appaction_[a-f0-9]{32}", action_id)
                and isinstance(action_digest, str) and re.fullmatch(r"[a-f0-9]{64}", action_digest)):
            return _refuse(400, "not_accepted", f"{definition.name} is a change: it runs only for an action the user accepted.")
        wrong = schema_errors(call["arguments"], definition.input_schema)
        if wrong:
            return _refuse(400, "invalid_arguments", "; ".join(wrong[:5]))
        context = PipCallContext(app=call["app"], tool=definition.name, kind=definition.kind, pip_id=call["pip_id"],
                                 run_id=call["run_id"], call_id=call["call_id"], timestamp=int(timestamp), nonce=nonce,
                                 action_id=action_id if isinstance(action_id, str) else None,
                                 action_digest=action_digest if isinstance(action_digest, str) else None)
        return fn, call["arguments"], context

    @staticmethod
    def _result(value: Any) -> tuple[int, dict[str, str], bytes]:
        try:
            return _answer(200, {"ok": True, "result": value})
        except (TypeError, ValueError):
            return _refuse(500, "invalid_result", "The tool's result isn't JSON.")

    @staticmethod
    def _failed(exc: BaseException, context: PipCallContext) -> tuple[int, dict[str, str], bytes]:
        if isinstance(exc, PipToolError):
            return _refuse(422, exc.code[:64] or "tool_refused", exc.message[:1000])
        _log.exception("Pip tool %s failed", context.tool)
        return _refuse(500, "tool_failed", "The tool failed.")

    # -- the framework-free core ---------------------------------------------------------------------------------

    def handle(self, headers: Mapping[str, Any], body: bytes) -> tuple[int, dict[str, str], bytes]:
        """One call: ``(status, headers, body)``. ``headers`` may be any mapping (names in any case)."""
        checked = self._check(headers, body)
        if len(checked) == 3 and isinstance(checked[0], int):
            return checked
        fn, args, context = checked
        try:
            value = fn(args, context)
        except Exception as exc:  # noqa: BLE001 -- answered as words, never a stack trace to DGC
            return self._failed(exc, context)
        if inspect.isawaitable(value):
            if inspect.iscoroutine(value):
                value.close()
            return _refuse(500, "async_tool", "This tool is async: serve it with handler.asgi.")
        return self._result(value)

    async def handle_async(self, headers: Mapping[str, Any], body: bytes) -> tuple[int, dict[str, str], bytes]:
        """As :meth:`handle`, awaiting an async tool; a plain function runs in a worker thread."""
        checked = self._check(headers, body)
        if len(checked) == 3 and isinstance(checked[0], int):
            return checked
        fn, args, context = checked
        try:
            if inspect.iscoroutinefunction(fn):
                value = await fn(args, context)
            else:
                value = await asyncio.to_thread(fn, args, context)
                if inspect.isawaitable(value):
                    value = await value
        except Exception as exc:  # noqa: BLE001
            return self._failed(exc, context)
        return self._result(value)

    # -- adapters ------------------------------------------------------------------------------------------------

    def flask(self, request: Any) -> Any:
        """A Flask view's answer: ``return handler.flask(request)``. Imports Flask only here."""
        from flask import Response
        if request.method != "POST":
            status, headers, body = _refuse(405, "method", "DGC calls with POST.")
        else:
            length = request.content_length
            if length is not None and length > self.max_body:
                status, headers, body = _refuse(413, "too_large", "The call is too large.")
            else:
                status, headers, body = self.handle(dict(request.headers), request.get_data(cache=False))
        return Response(body, status=status, headers=headers)

    def wsgi(self, environ: dict, start_response: Callable) -> list[bytes]:
        """A WSGI app: mount ``handler.wsgi`` at the address you registered."""
        if environ.get("REQUEST_METHOD") != "POST":
            status, headers, body = _refuse(405, "method", "DGC calls with POST.")
        else:
            try:
                length = int(environ.get("CONTENT_LENGTH") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > self.max_body:
                status, headers, body = _refuse(413, "too_large", "The call is too large.")
            else:
                raw = environ["wsgi.input"].read(length) if length else b""
                given = {key[5:].replace("_", "-"): value for key, value in environ.items() if key.startswith("HTTP_")}
                status, headers, body = self.handle(given, raw)
        start_response(f"{status} {_REASONS.get(status, 'OK')}", list(headers.items()) + [("Content-Length", str(len(body)))])
        return [body]

    async def asgi(self, scope: dict, receive: Callable, send: Callable) -> None:
        """An ASGI app for Starlette and FastAPI: ``app.mount("/dgc/pips", handler.asgi)``."""
        if scope.get("type") == "lifespan":
            while True:
                message = await receive()
                if message.get("type") == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message.get("type") == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope.get("type") != "http":
            return
        if scope.get("method") != "POST":
            status, headers, body = _refuse(405, "method", "DGC calls with POST.")
        else:
            chunks, size, too_big = [], 0, False
            while True:
                message = await receive()
                if message.get("type") == "http.disconnect":
                    return
                part = message.get("body", b"") or b""
                size += len(part)
                if size > self.max_body:
                    too_big = True
                else:
                    chunks.append(part)
                if not message.get("more_body"):
                    break
            if too_big:
                status, headers, body = _refuse(413, "too_large", "The call is too large.")
            else:
                given = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope.get("headers") or []}
                status, headers, body = await self.handle_async(given, b"".join(chunks))
        await send({"type": "http.response.start", "status": status,
                    "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()]
                    + [(b"content-length", str(len(body)).encode("ascii"))]})
        await send({"type": "http.response.body", "body": body})


_REASONS = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed",
            413: "Payload Too Large", 422: "Unprocessable Entity", 500: "Internal Server Error"}
