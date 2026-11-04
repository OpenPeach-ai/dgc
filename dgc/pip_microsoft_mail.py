"""Closed, read-only Outlook adapter for a Personal Pip's already connected DGC Microsoft plugin.

The account is pinned to Graph /me when the user connects it. Every read checks that account again;
changing Microsoft sign-in never silently gives a Pip another mailbox. No draft or send route is exposed.
"""
from __future__ import annotations

import hashlib
import json
import re
import time

from . import microsoft_graph
from .pip_app_access import DeadlineCancellation, digest, saved_servers
from .workspace_registry import RegistryError

SERVER = "microsoft--mail"
TOOLKIT = "outlook"
READS = {"MICROSOFT_SEARCH_MAIL": "search_mail", "MICROSOFT_READ_MAIL": "read_mail",
         "MICROSOFT_LIST_MAIL_FOLDERS": "list_mail_folders"}
MAX_RESULT = 32768          # bytes of the answer a Pip is given
# Bytes of the plugin's own answer read at all: a parse guard well above what it sends (a message body cut at
# microsoft_graph.MAX_TEXT characters, up to 3 bytes each, pretty-printed), never the limit of what can be read.
MAX_RAW = 1024 * 1024


def spec(config):
    # A Pip runner can predate the user's sign-in. Read the saved connection each time, as we
    # already do before reads, so a new Microsoft login works without restarting the runner.
    found = saved_servers(config).get(SERVER)
    if (not isinstance(found, dict) or found.get("enabled") is False
            or not microsoft_graph.is_builtin_spec(found)
            or "mail" not in microsoft_graph.parse_args(found.get("args"))[0]):
        raise RegistryError("connection_unavailable", "Connect Microsoft Mail in Settings → Plugins first.")
    return found


def ready(config) -> bool:
    """DGC's Microsoft Mail plugin is set up (added, turned on, with mail): only then may a Pip be told Outlook Mail goes
    through "the user's existing Microsoft plugin". Told that in a home with none, Core greeted a user with "the only
    app connected is Outlook Mail through a Microsoft plugin" (seen in testing)."""
    try:
        spec(config)
    except RegistryError:
        return False
    except Exception:                       # noqa: BLE001 - an unreadable plugin record is a plugin not set up
        return False
    return True


def _manager(config, cancel):
    from .mcp import MCPManager
    checked = spec(config)
    manager = MCPManager(config.project_root)
    try:
        manager.connect_all(config.mcp_runtime_servers({SERVER: checked}), cancel=cancel,
                            input_handler=lambda *a, **kw: {"action": "cancel"})
        if SERVER not in manager.servers:
            raise RegistryError("connection_unavailable", "Microsoft Mail needs sign-in in Settings → Plugins.")
        return manager
    except BaseException:
        manager.stop_all()
        raise


def _route(manager, tool):
    names = [fn.get("function", {}).get("name") for fn in manager.tool_schemas()
             if manager._routes.get(fn.get("function", {}).get("name")) == (SERVER, tool)]
    if len(names) != 1:
        raise RegistryError("app_schema_changed", f"Microsoft Mail no longer offers {tool}. Reconnect it in Settings.")
    return names[0]


def _call(manager, tool, arguments, cancel):
    raw = manager.call(_route(manager, tool), arguments, cancel=cancel,
                       input_handler=lambda *a, **kw: {"action": "cancel"})
    if not isinstance(raw, str) or raw.startswith("ERROR:") or len(raw.encode()) > MAX_RAW:
        raise RegistryError("app_read_failed", "Microsoft Mail did not complete the bounded read.")
    try:
        return json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise RegistryError("app_read_failed", "Microsoft Mail returned an invalid answer.") from exc


def _account(manager, cancel):
    profile = _call(manager, "mail_account", {}, cancel)
    ident = profile.get("id") if isinstance(profile, dict) else None
    if not isinstance(ident, str) or not 1 <= len(ident) <= 256:
        raise RegistryError("connection_unavailable", "Microsoft could not identify this mailbox. Reconnect it in Settings.")
    account = "ca_ms_" + hashlib.sha256(ident.encode()).hexdigest()[:32]
    email = profile.get("email")
    label = email[:160] if isinstance(email, str) and 1 <= len(email) <= 160 and email.isprintable() else "Microsoft Mail"
    return account, label


def connect(config, *, manager_factory=_manager):
    saved = spec(config)
    cancel = DeadlineCancellation(time.monotonic() + 30)
    manager = manager_factory(config, cancel)
    try:
        account, label = _account(manager, cancel)
        return {"server": SERVER, "connection_digest": digest(saved), "account": account, "label": label}
    finally:
        manager.stop_all()


def _arguments(tool, arguments):
    if not isinstance(arguments, dict):
        raise RegistryError("invalid_app_arguments", "Give bounded Outlook read arguments.")
    if tool == "MICROSOFT_SEARCH_MAIL":
        if set(arguments) - {"query", "folder", "unread_only", "limit"}:
            raise RegistryError("invalid_app_arguments", "Outlook search only accepts query, folder, unread_only and limit.")
        result = {"limit": arguments.get("limit", 10)}
        if type(result["limit"]) is not int or not 1 <= result["limit"] <= 20:
            raise RegistryError("invalid_app_arguments", "Review a search limit from 1 to 20 messages.")
        for name, limit in (("query", 500), ("folder", 255)):
            if name in arguments:
                value = arguments[name]
                if not isinstance(value, str) or len(value) > limit:
                    raise RegistryError("invalid_app_arguments", f"Outlook {name} is too long.")
                result[name] = value
        if "unread_only" in arguments:
            if type(arguments["unread_only"]) is not bool:
                raise RegistryError("invalid_app_arguments", "unread_only must be true or false.")
            result["unread_only"] = arguments["unread_only"]
        return result
    if tool == "MICROSOFT_READ_MAIL":
        ident = arguments.get("id")
        if set(arguments) != {"id"} or not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9=_+/.!:-]{1,512}", ident):
            raise RegistryError("invalid_app_arguments", "Read one message id returned by Outlook search.")
        return {"id": ident}
    if tool == "MICROSOFT_LIST_MAIL_FOLDERS" and not arguments:
        return {}
    raise RegistryError("unsupported_app_action", "Only Outlook mail search, one-message read and folder listing are available to this Pip.")


def _text(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _fit(result) -> str:
    """The answer as the Pip's JSON within MAX_RESULT. A long message's body is cut to fit, and says so: a newsletter
    or a long thread is read, never refused."""
    text = _text(result)
    if len(text.encode()) <= MAX_RESULT or not isinstance(result, dict) or not isinstance(result.get("body"), str):
        return text
    body = result["body"]
    cut = lambda n: {**result, "body": body[:n] + f"\n[… {len(body) - n} more characters of this message not shown]"}
    low, high = 0, len(body)
    while low < high:                     # the longest start of the body that fits
        middle = (low + high + 1) // 2
        if len(_text(cut(middle)).encode()) <= MAX_RESULT:
            low = middle
        else:
            high = middle - 1
    return _text(cut(low))


def read(config, app, tool, arguments, *, authorize=lambda: None, manager_factory=_manager):
    route = READS.get(tool)
    if not route or app.get("server") != SERVER or app.get("toolkit") != TOOLKIT:
        raise RegistryError("unsupported_app_action", "This Pip can only use the reviewed Outlook mail reads.")
    args = _arguments(tool, arguments)
    current = spec(config)
    if digest(current) != app.get("connection_digest") or digest(saved_servers(config).get(SERVER)) != app.get("connection_digest"):
        raise RegistryError("connection_changed", "Microsoft Mail changed in Settings. Connect it to this Pip again.")
    authorize()
    cancel = DeadlineCancellation(time.monotonic() + 30)
    manager = manager_factory(config, cancel)
    try:
        account, _label = _account(manager, cancel)
        if account != app.get("account"):
            raise RegistryError("account_changed", "Microsoft is signed in to a different mailbox. Connect this Pip again.")
        authorize()
        result = _call(manager, route, args, cancel)
        authorize()
        # The result is untrusted mail content, projected to a bounded JSON string; no send or mutation route exists.
        text = _fit(result)
        if len(text.encode()) > MAX_RESULT:
            raise RegistryError("app_limit", "The Outlook answer is too large. Search more narrowly.")
        from .redaction import redact_text, secret_values
        return redact_text(text, secret_values(config))
    finally:
        manager.stop_all()
