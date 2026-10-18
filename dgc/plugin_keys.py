"""A plugin's own key or token, saved on its page in Settings → Plugins (or with ``dgc plugin key NAME``).

Some plugins connect with a key the user creates at the vendor, not a browser sign-in: GitHub's personal access
token, Brevo's MCP key, Arize's API key. The plugin's server names the variable it reads the key from
(``bearer_token_env_var`` in the package, ``auth_env`` in DGC's saved server), and until this module the only way to
supply it was to set that variable in the environment DGC started with -- the founder got "Configure
GITHUB_PAT_TOKEN in MCP server settings before connecting." for clicking Connect on GitHub.

A saved key is kept where DGC keeps a plugin's sign-in: the system keychain, or an owner-only file where there is
none (``plugin_credentials``, chosen by ``plugin_credentials_store``), in an entry of its own for the server. It is
bound to the server it was saved for (its address, or its command and arguments): a server that now points
somewhere else never receives it. ``plugin-auth/keys.json`` records only THAT a key is saved, never the key, so
listing plugins never reads the keychain.

When a server connects, a saved key fills its variable; the variable from the environment is the fallback for
anyone who already sets it. A key read for a connection is remembered in this process only so redaction can hide
it if a server ever echoes it back.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path

from . import plugin_credentials as credentials
from .plugin_sources import SourceError

VERSION = 1
MAX_KEY = 16_384
_ENV = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
_SERVER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
_SEEN: set[str] = set()                  # keys read in this process, for redaction only
_SEEN_LOCK = threading.Lock()


class PluginKeyError(SourceError):
    """A key that can't be saved, in words the plugin's page shows. A PluginError, so every plugin handler says it."""


# ------------------------------------------------------------------------------------------------- the server

def key_names(spec) -> list[str]:
    """The variables a saved key can fill for this server: a remote server's bearer, or a local one's variables."""
    if not isinstance(spec, dict):
        return []
    declared = [n for n in (spec.get("env_names") or []) if isinstance(n, str) and _ENV.fullmatch(n)]
    if spec.get("transport") == "remote":
        auth = spec.get("auth_env")
        return [auth] if isinstance(auth, str) and auth in declared else []
    return declared[:16]


def identity(spec) -> str:
    """What a key is bound to: a remote server's address, or a local server's command and arguments."""
    if not isinstance(spec, dict):
        return ""
    if spec.get("transport") == "remote":
        what = {"url": str(spec.get("url") or "")}
    else:
        what = {"command": str(spec.get("command") or ""), "args": [str(a) for a in spec.get("args") or []]}
    return hashlib.sha256(json.dumps(what, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _entry(server: str) -> str:
    """The keychain entry for one server's key. A leading '_' can't begin a server name, so it never collides."""
    name = "_key." + server
    if len(name) <= 64:
        return name
    return "_key." + server[:42] + "." + hashlib.sha256(server.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------------------- the index (no secrets)

def _index_path() -> Path:
    from .config import dgc_home
    return dgc_home() / "plugin-auth" / "keys.json"


def _read_index() -> dict:
    path = _index_path()
    try:
        if path.is_symlink() or path.stat().st_size > 256 * 1024:
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    servers = value.get("servers") if isinstance(value, dict) else None
    if not isinstance(servers, dict):
        return {}
    clean = {}
    for server, row in list(servers.items())[:128]:
        if not isinstance(server, str) or not _SERVER.fullmatch(server) or not isinstance(row, dict):
            continue
        names = [n for n in row.get("names") or [] if isinstance(n, str) and _ENV.fullmatch(n)]
        if names and isinstance(row.get("identity"), str):
            clean[server] = {"names": names[:16], "identity": row["identity"], "saved_at": row.get("saved_at") or 0,
                             "where": "file" if row.get("where") == "file" else "keychain"}
    return clean


def _write_index(servers: dict) -> None:
    path = _index_path()
    folder = path.parent
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with contextlib.suppress(OSError):
        folder.chmod(0o700)
    tmp = folder / f".keys.{os.getpid()}.{threading.get_ident()}.tmp"
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump({"version": VERSION, "servers": servers}, handle, indent=1, sort_keys=True)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()


@contextlib.contextmanager
def _index_lock():
    from .config import dgc_home
    from .scheduler import named_process_lock
    lock = named_process_lock("plugin-keys", str(dgc_home()))
    if not lock.acquire(timeout=10):
        raise PluginKeyError("Another DGC is saving a key. Try again in a moment.")
    try:
        yield
    finally:
        lock.release()


def saved_names(server: str, spec=None) -> list[str]:
    """The variables saved for this server, from the index alone (never the keychain). With ``spec``, only a key
    saved for this same server counts."""
    row = _read_index().get(str(server))
    if not row:
        return []
    if spec is not None and row["identity"] != identity(spec):
        return []
    return list(row["names"])


def stored_where(server: str) -> str:
    """'keychain' or 'file': where this server's key was saved (from the index), or '' when none is."""
    row = _read_index().get(str(server))
    return row["where"] if row else ""


# ------------------------------------------------------------------------------------------------ the keys

def _clean_value(value) -> str:
    text = str(value or "").strip()
    if not text:
        raise PluginKeyError("Paste the key first.")
    if len(text) > MAX_KEY or any(ord(c) <= 32 or ord(c) == 127 for c in text):
        raise PluginKeyError("That doesn't look like a key: it has spaces or line breaks in it. Copy the key itself.")
    return text


def save(server: str, spec: dict, values: dict) -> str:
    """Keep this server's keys (``{variable: key}``); returns where they went ('macos-keychain', 'file', ...)."""
    if not isinstance(server, str) or not _SERVER.fullmatch(server):
        raise PluginKeyError("Choose one of the plugin's servers.")
    allowed = key_names(spec)
    if not allowed:
        raise PluginKeyError("This server doesn't take a key.")
    clean = {}
    for name, value in (values or {}).items():
        if name not in allowed:
            raise PluginKeyError(f"This server reads {', '.join(allowed)}, not {str(name)[:64]}.")
        clean[name] = _clean_value(value)
    if not clean:
        raise PluginKeyError("Paste the key first.")
    bound = identity(spec)
    with _index_lock():
        index = _read_index()
        kept = {}
        previous = index.get(server)
        if previous and previous["identity"] == bound:
            with contextlib.suppress(credentials.CredentialError, OSError):
                old = credentials.load(_entry(server)) or {}
                if old.get("version") == VERSION and old.get("identity") == bound and isinstance(old.get("env"), dict):
                    kept = {k: v for k, v in old["env"].items() if k in allowed and isinstance(v, str) and v}
        merged = {**kept, **clean}
        try:
            where = credentials.save(_entry(server), {"version": VERSION, "identity": bound, "server": server,
                                                     "env": merged})
        except credentials.CredentialError as exc:
            raise PluginKeyError(f"DGC couldn't save the key: {exc}.") from None
        index[server] = {"names": sorted(merged), "identity": bound, "saved_at": time.time(),
                         "where": "file" if where == "file" else "keychain"}
        _write_index(index)
    _remember(merged.values())
    return where


def remove(server: str, names=None) -> bool:
    """Forget this server's saved keys (or only the variables in ``names``). True when there were any."""
    if not isinstance(server, str) or not _SERVER.fullmatch(server):
        return False
    with _index_lock():
        index = _read_index()
        row = index.get(server)
        keep = [n for n in (row or {}).get("names", []) if names is not None and n not in names]
        if row and keep:
            # Another of its variables stays saved: rewrite the entry without these.
            try:
                kept = credentials.load(_entry(server)) or {}
                env = {k: v for k, v in (kept.get("env") or {}).items() if k in keep}
                credentials.save(_entry(server), {**kept, "env": env})
            except (credentials.CredentialError, OSError) as exc:
                raise PluginKeyError(f"DGC couldn't remove the key: {exc}.") from None
            index[server] = {**row, "names": sorted(env)}
            _write_index(index)
            return True
        had = index.pop(server, None) is not None
        try:
            removed = credentials.delete(_entry(server))
        except (credentials.CredentialError, OSError):
            removed = False
        folder = credentials.folder(_entry(server))
        if folder.is_dir() and not folder.is_symlink():
            import shutil
            shutil.rmtree(folder, ignore_errors=True)
        if had:
            _write_index(index)
    return had or removed


def runtime_env(server: str, spec) -> dict:
    """The saved keys this server's connection should use now, or {}. Reads the keychain only when one is saved."""
    names = key_names(spec)
    if not names or not saved_names(server, spec):
        return {}
    try:
        kept = credentials.load(_entry(server)) or {}
    except (credentials.CredentialError, OSError):
        return {}
    if kept.get("version") != VERSION or kept.get("identity") != identity(spec) or not isinstance(kept.get("env"), dict):
        return {}
    env = {k: v for k, v in kept["env"].items() if k in names and isinstance(v, str) and v}
    _remember(env.values())
    return env


def _remember(values) -> None:
    with _SEEN_LOCK:
        for value in values:
            if isinstance(value, str) and len(value) >= 8 and len(_SEEN) < 64:
                _SEEN.add(value)


def known_values() -> tuple[str, ...]:
    """Keys this process has saved or read, for redaction. Never reads the keychain."""
    with _SEEN_LOCK:
        return tuple(_SEEN)


# --------------------------------------------------------------------------------------------- what to say

def describe(entry: dict | None, name: str) -> dict:
    """How the plugin's page labels a key: from the catalog's ``keys`` for that variable, else plain defaults."""
    found = ((entry or {}).get("keys") or {}).get(name) if isinstance((entry or {}).get("keys"), dict) else None
    found = found if isinstance(found, dict) else {}
    text = lambda key, limit=600: str(found.get(key) or "")[:limit]  # noqa: E731
    url = lambda key: text(key, 300) if text(key, 300).startswith("https://") else ""  # noqa: E731
    return {"label": text("label", 120) or "API key", "create_url": url("create_url"),
            "create_label": text("create_label", 120), "manage_url": url("manage_url"),
            "help_url": url("help_url"), "permissions": text("permissions", 1200), "placeholder": text("placeholder", 80),
            "sign_in": found.get("sign_in") if isinstance(found.get("sign_in"), dict) else {}}


def missing_message(entry: dict | None, name: str, display: str = "") -> str:
    """What a plugin that has no key yet says, on its page, in the terminal and to the model."""
    keys = (entry or {}).get("keys")
    labelled = isinstance(keys, dict) and isinstance(keys.get(name), dict) and keys[name].get("label")
    label = describe(entry, name)["label"]
    plugin = display or (entry or {}).get("display_name") or (entry or {}).get("name") or "this plugin"
    article = "an" if label[:1].lower() in "aeiou" else "a"
    command = (entry or {}).get("name") or ""
    # A package DGC hasn't described names only its variable: say that one, for anyone who sets it themselves.
    what = f"{article} {label}" if labelled or not name else f"{article} {label} ({name})"
    return (f"Needs {what}. Save it on {plugin}'s page in Settings → Plugins"
            + (f", or with: dgc plugin key {command}" if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", command) else "")
            + ".")
