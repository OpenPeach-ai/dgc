"""A remote plugin's sign-in: where it lives, and forgetting it.

DGC reaches a remote MCP server through the pinned ``mcp-remote`` bridge, which keeps that server's OAuth tokens
and client registration in owner-only files under ``MCP_REMOTE_CONFIG_DIR``. DGC gives every remote server a folder
of its own (``plugin-auth/<name>/`` in DGC's home), so removing the server removes exactly its sign-in.

Removing it first asks the vendor to revoke the token (RFC 7009) when the vendor offers a revocation address,
found the standard way: the server's protected-resource metadata (RFC 9728) names its authorization server, whose
metadata (RFC 8414, or OpenID's) names the address. Then the folder is deleted, revoked or not; what happened is
said in one sentence the caller shows.

Sign-ins kept by the bridge's shared default folder (``~/.mcp-auth``) are never read, copied or deleted here: other
apps on the same machine use that folder for the same servers, and their sign-ins are theirs.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT_NAME = "plugin-auth"
STORE = "mcp-remote-v1"            # the bridge's own subfolder of MCP_REMOTE_CONFIG_DIR
NOTE = "dgc-server.json"           # what DGC needs to revoke later: the server's address and its client file
NAME = re.compile(r"[A-Za-z0-9._-]{1,64}")
MAX_JSON_BYTES = 256 * 1024
TIMEOUT = 10


def root() -> Path:
    from .config import dgc_home
    return dgc_home() / ROOT_NAME


def folder(name: str) -> Path:
    if not NAME.fullmatch(str(name or "")) or name in (".", ".."):
        raise ValueError("A plugin's sign-in folder needs a plain server name.")
    return root() / name


def _private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise OSError(f"{path} is not a folder DGC owns")
    path.chmod(0o700)


def bridge_url(args) -> str:
    """The server address in a bridge's arguments: the one after the mcp-remote package."""
    args = [str(a) for a in (args or [])]
    for index, arg in enumerate(args[:-1]):
        if arg == "mcp-remote" or arg.startswith("mcp-remote@"):
            return args[index + 1]
    return ""


def _static_client_file(args) -> str:
    args = [str(a) for a in (args or [])]
    for index, arg in enumerate(args[:-1]):
        if arg == "--static-oauth-client-info" and args[index + 1].startswith("@"):
            return args[index + 1][1:]
    return ""


def prepare(name: str, args, env: dict) -> dict:
    """The bridge's environment for this server: its own sign-in folder, and a note of where it signs in."""
    target = folder(name)
    _private_dir(target)
    note = {"url": bridge_url(args), "static_client": _static_client_file(args)}
    path = target / NOTE
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        current = None
    if current != note:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(note), encoding="utf-8")
        tmp.chmod(0o600)
        tmp.replace(path)
    return {**env, "MCP_REMOTE_CONFIG_DIR": str(target)}


def _read_json(path: Path):
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_JSON_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _hash(url: str) -> str:
    # mcp-remote names a server's files by the MD5 of its address (getServerUrlHash; DGC passes no header,
    # resource, authorize parameters or client metadata URL, which would join the address in that hash).
    return hashlib.md5(url.encode("utf-8"), usedforsecurity=False).hexdigest()


def _allowed(url: str) -> bool:
    """Revocation and discovery go to https only (plain http only to this computer, for tests)."""
    parts = urlsplit(str(url or ""))
    if parts.scheme == "https" and parts.hostname:
        return True
    return parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")


def _get_json(session, url: str):
    if not _allowed(url):
        return None
    try:
        response = session.get(url, timeout=TIMEOUT, allow_redirects=False, headers={"Accept": "application/json"})
        if response.status_code != 200 or len(response.content) > MAX_JSON_BYTES:
            return None
        value = response.json()
    except Exception:                                     # noqa: BLE001 -- discovery is best effort
        return None
    return value if isinstance(value, dict) else None


def _well_known(base: str, suffix: str) -> list[str]:
    """RFC 8414 / RFC 9728 well-known addresses for BASE: inserted before its path, then at its root."""
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    found = [f"{origin}/.well-known/{suffix}{path}"] if path else []
    return found + [f"{origin}/.well-known/{suffix}"]


def revocation_endpoint(session, server_url: str) -> tuple[str, list]:
    """(the vendor's revocation address, the client authentication methods it accepts), or ("", [])."""
    issuers = []
    for address in _well_known(server_url, "oauth-protected-resource"):
        metadata = _get_json(session, address)
        servers = metadata.get("authorization_servers") if metadata else None
        if isinstance(servers, list):
            issuers = [s for s in servers if isinstance(s, str)][:3]
            break
    if not issuers:                                       # older servers: the authorization server is the server's origin
        parts = urlsplit(server_url)
        issuers = [urlunsplit((parts.scheme, parts.netloc, "", "", ""))]
    for issuer in issuers:
        addresses = _well_known(issuer, "oauth-authorization-server") + _well_known(issuer, "openid-configuration")
        if urlsplit(issuer).path.strip("/"):
            addresses.append(issuer.rstrip("/") + "/.well-known/openid-configuration")
        for address in addresses:
            metadata = _get_json(session, address)
            if metadata and isinstance(metadata.get("revocation_endpoint"), str) and _allowed(metadata["revocation_endpoint"]):
                methods = metadata.get("revocation_endpoint_auth_methods_supported")
                return metadata["revocation_endpoint"], (methods if isinstance(methods, list) else [])
            if metadata:
                break                                     # this issuer answered and offers no revocation
    return "", []


def revoke(session, server_url: str, tokens: dict, client: dict) -> bool | None:
    """Ask the vendor to revoke the refresh token, then the access token. True when it said yes to each it was
    given, False when it refused, None when it offers no way to revoke."""
    endpoint, methods = revocation_endpoint(session, server_url)
    if not endpoint:
        return None
    client_id = str(client.get("client_id") or "")
    secret = str(client.get("client_secret") or "")
    confirmed = True
    asked = False
    for hint in ("refresh_token", "access_token"):
        token = tokens.get(hint)
        if not isinstance(token, str) or not token:
            continue
        asked = True
        data = {"token": token, "token_type_hint": hint}
        auth = None
        if secret and "client_secret_post" in methods and "client_secret_basic" not in methods:
            data.update(client_id=client_id, client_secret=secret)
        elif secret:
            auth = (client_id, secret)                    # RFC 7009 / RFC 6749: Basic is the default for a confidential client
        elif client_id:
            data["client_id"] = client_id                 # a public client names itself
        try:
            response = session.post(endpoint, data=data, auth=auth, timeout=TIMEOUT, allow_redirects=False)
            confirmed = confirmed and response.status_code == 200
        except Exception:                                 # noqa: BLE001 -- said in the result, never raised
            confirmed = False
    return confirmed if asked else None


def forget(name: str, *, session=None) -> dict:
    """Revoke and delete one server's sign-in. {"had_signin", "revoked", "deleted", "message"}."""
    try:
        target = folder(name)
    except ValueError:
        return {"had_signin": False, "revoked": None, "deleted": False, "message": ""}
    if not target.is_dir() or target.is_symlink():
        return {"had_signin": False, "revoked": None, "deleted": False, "message": ""}
    note = _read_json(target / NOTE) or {}
    url = str(note.get("url") or "")
    store = target / STORE
    tokens = _read_json(store / f"{_hash(url)}_tokens.json") if url else None
    client = _read_json(store / f"{_hash(url)}_client_info.json") if url else None
    static = _read_json(Path(str(note.get("static_client")))) if note.get("static_client") else None
    client = {**(client or {}), **({k: v for k, v in (static or {}).items() if k in ("client_id", "client_secret")})}
    revoked = None
    if tokens and url:
        if session is None:
            import requests
            session = requests.Session()
        revoked = revoke(session, url, tokens, client)
    shutil.rmtree(target, ignore_errors=True)
    deleted = not target.exists()
    host = urlsplit(url).hostname or "the service"
    if not tokens:
        message = ""
    elif revoked is True:
        message = f"Signed out: {host} revoked DGC's access, and its sign-in was deleted from this computer."
    elif revoked is False:
        message = (f"Its sign-in was deleted from this computer, but {host} didn't confirm the sign-out. "
                   "You can remove DGC's access in your account there.")
    else:
        message = (f"Its sign-in was deleted from this computer. {host} offers no way for an app to sign itself "
                   "out, so remove DGC's access in your account there if you want it gone there too.")
    if not deleted:
        message = f"DGC couldn't delete its sign-in folder ({target}). Delete it to finish signing out."
    return {"had_signin": bool(tokens), "revoked": revoked, "deleted": deleted, "message": message}
