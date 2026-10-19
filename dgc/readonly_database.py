"""A project's read-only database account, for the agents that check claims about its data.

The founder (2026-10-18): "Troupe checker agents get a sandboxed read-only shell, together with a read-only database
account, so a checker can't change data." A Troupe audit had run psql as the postgres superuser, read-only only by
request (ERP session review, 2026-10-18). This keeps one connection string per project, for a database role the user
made read-only; DGC never creates or changes a role.

- The connection string is a secret, kept as a plugin's sign-in is (dgc/plugin_credentials: the system keychain, or
  an owner-only file), under a name derived from the project's folder. What is not secret (host, port, database, user)
  sits beside it in ``~/.dgc/readonly-databases.json`` so a tool description can say whether one is set without
  opening the keychain on every request.
- Only a database on this computer (localhost, 127.0.0.1 or ::1, over TCP): a checker's box reaches it through one
  forwarded port and has no other network.
- A checker's boxed shell gets it as ``DGC_READONLY_DATABASE_URL`` (pointing at the forwarded port inside the box); a
  Troupe worker gets it under the same name, as the connection to prefer for reads.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

ENV = "DGC_READONLY_DATABASE_URL"
SCHEMES = ("postgresql", "postgres")
LOOPBACK = ("localhost", "127.0.0.1", "::1")
MAX_URL = 2048

GUIDE = """A read-only Postgres role for DGC's checkers. DGC never creates or changes a role: run this yourself, as
a database owner (for example `psql -U postgres -d <database>`), with your own password and database name:

    CREATE ROLE dgc_readonly LOGIN PASSWORD 'choose-a-password';
    GRANT CONNECT ON DATABASE <database> TO dgc_readonly;
    GRANT USAGE ON SCHEMA public TO dgc_readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO dgc_readonly;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO dgc_readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dgc_readonly;
    ALTER ROLE dgc_readonly SET default_transaction_read_only = on;

Repeat the USAGE and SELECT lines for each other schema the checks read. The database must listen on this computer
(localhost): for one in Docker, publish its port to 127.0.0.1, e.g. "127.0.0.1:5432:5432". Then, in the project:

    dgc readonly-db set        (asks for postgresql://dgc_readonly:<password>@localhost:5432/<database>)
    dgc readonly-db show       (what is set, without the password)
    dgc readonly-db clear
"""


class ReadOnlyDatabaseError(ValueError):
    pass


def _root(project_root) -> str:
    try:
        return str(Path(project_root).expanduser().resolve(strict=False))
    except (OSError, RuntimeError, ValueError):
        return str(project_root)


def _name(project_root) -> str:
    return "readonly-db-" + hashlib.sha256(_root(project_root).encode("utf-8")).hexdigest()[:16]


def _index() -> Path:
    from .config import dgc_home
    return dgc_home() / "readonly-databases.json"


def parse(url) -> dict:
    """Check a connection string: {scheme, user, password, host, port, database, query}; ReadOnlyDatabaseError says
    what to change. Never echoes the string (it holds a password)."""
    if not isinstance(url, str) or not url.strip() or len(url) > MAX_URL or any(ord(c) < 32 for c in url):
        raise ReadOnlyDatabaseError("Give one postgresql://user:password@localhost:5432/database connection string.")
    parts = urlsplit(url.strip())
    if parts.scheme not in SCHEMES:
        raise ReadOnlyDatabaseError("Only a Postgres connection string (postgresql://...) is supported.")
    try:
        port = parts.port or 5432
    except ValueError:
        raise ReadOnlyDatabaseError("The port in the connection string isn't a number.") from None
    host = (parts.hostname or "").lower()
    if host not in LOOPBACK:
        raise ReadOnlyDatabaseError("The read-only database must be on this computer (host localhost or 127.0.0.1): "
                                    "a checker's box reaches it through one forwarded local port and no other "
                                    "network. For one in Docker, publish its port to 127.0.0.1.")
    if not parts.username:
        raise ReadOnlyDatabaseError("The connection string needs the read-only role's user name.")
    database = unquote(parts.path.lstrip("/"))
    if not database or "/" in database:
        raise ReadOnlyDatabaseError("The connection string needs the database name after the port (…:5432/name).")
    if parts.fragment:
        raise ReadOnlyDatabaseError("The connection string can't have a #fragment.")
    query = parts.query
    if re.search(r"(?:^|&)(?:host|hostaddr|port)=", query):
        raise ReadOnlyDatabaseError("Give the host and port in the address, not as query options.")
    return {"scheme": parts.scheme, "user": unquote(parts.username), "password": unquote(parts.password or ""),
            "host": host, "port": port, "database": database, "query": query}


def url_for(parsed: dict, *, host: str | None = None, port: int | None = None) -> str:
    """The connection string again, optionally pointing at another host and port (a checker's forwarded port)."""
    auth = quote(parsed["user"], safe="") + (":" + quote(parsed["password"], safe="") if parsed["password"] else "")
    where = host or parsed["host"]
    netloc = f"{auth}@{('[' + where + ']') if ':' in where else where}:{port or parsed['port']}"
    return urlunsplit((parsed["scheme"], netloc, "/" + quote(parsed["database"], safe=""), parsed["query"], ""))


def _read_index() -> dict:
    try:
        value = json.loads(_index().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_index(value: dict) -> None:
    path = _index()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=1, sort_keys=True)
    os.replace(temporary, path)


def set_url(project_root, url) -> dict:
    """Keep this project's read-only connection string. Returns what show() says."""
    from . import plugin_credentials
    parsed = parse(url)
    where = plugin_credentials.save(_name(project_root), {"url": url_for(parsed)})
    index = _read_index()
    index[_root(project_root)] = {key: parsed[key] for key in ("host", "port", "database", "user")} | {
        "kept_in": where, "set_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    _write_index(index)
    return show(project_root)


def clear(project_root) -> bool:
    from . import plugin_credentials
    removed = plugin_credentials.delete(_name(project_root))
    index = _read_index()
    removed = index.pop(_root(project_root), None) is not None or removed
    _write_index(index)
    return removed


def show(project_root) -> dict:
    """What is set for this project, without the password: {set, host, port, database, user, kept_in}."""
    entry = _read_index().get(_root(project_root))
    if not isinstance(entry, dict):
        return {"set": False}
    return {"set": True, **{key: entry.get(key) for key in ("host", "port", "database", "user", "kept_in")}}


def configured(project_root) -> bool:
    """Whether one is set, from the index only (no keychain): what a tool description says."""
    return show(project_root)["set"]


def load(project_root) -> dict | None:
    """The parsed connection string for this project, or None (none set, or its secret is gone)."""
    if not configured(project_root):
        return None
    from . import plugin_credentials
    try:
        kept = plugin_credentials.load(_name(project_root))
    except Exception:            # noqa: BLE001 - a locked keychain: no database this time, said by the caller
        return None
    url = kept.get("url") if isinstance(kept, dict) else None
    try:
        return parse(url)
    except ReadOnlyDatabaseError:
        return None


def command(project_root, argv, *, read=None, out=print) -> int:
    """`dgc readonly-db set|show|clear|guide`. set reads the connection string without echoing it (never argv)."""
    action = argv[0] if argv else "show"
    if action == "guide":
        out(GUIDE)
        return 0
    if action == "show":
        state = show(project_root)
        out(f"Read-only database for {_root(project_root)}: "
            + (f"{state['user']}@{state['host']}:{state['port']}/{state['database']} (kept in {state['kept_in']})"
               if state["set"] else "none set. `dgc readonly-db guide` shows how to make one."))
        return 0
    if action == "clear":
        out("Cleared." if clear(project_root) else "None was set.")
        return 0
    if action == "set":
        if len(argv) > 1:
            out("Don't put the connection string on the command line (other users can see it there): run "
                "`dgc readonly-db set` and paste it when asked, or pipe it in.")
            return 2
        if read is None:
            import getpass
            import sys
            read = (lambda: getpass.getpass("Read-only connection string (postgresql://...): ")) if sys.stdin.isatty() \
                else sys.stdin.readline
        try:
            state = set_url(project_root, read().strip())
        except ReadOnlyDatabaseError as error:
            out(str(error))
            return 2
        out(f"Set: {state['user']}@{state['host']}:{state['port']}/{state['database']} (kept in {state['kept_in']}). "
            "Troupe checkers get it in their boxed shell, and workers as the connection to prefer.")
        return 0
    out("usage: dgc readonly-db [show|set|clear|guide]")
    return 2
