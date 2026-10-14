"""Signing out of a remote plugin: revoke its token at the vendor, then forget its sign-in on this computer.

DGC's own remote MCP client (mcp_remote.py) keeps each server's sign-in (its OAuth client, tokens and where it
signs in) in the system keychain, or an owner-only file where there is none (plugin_credentials.py), under the
server's name. Removing the server first asks the vendor to revoke the token (RFC 7009), at the revocation address
saved at sign-in or, failing that, found the standard way: the server's protected-resource metadata (RFC 9728) names
its authorization server, whose metadata (RFC 8414, or OpenID's) names the address. Then the sign-in is deleted from
the keychain and the file, revoked or not, and the server's ``plugin-auth/<name>/`` folder with it; what happened is
said in one sentence the caller shows.

Sign-ins other apps keep (mcp-remote's shared ``~/.mcp-auth``, for one) are never read, copied or deleted here.
"""
from __future__ import annotations

import json
import shutil
import stat
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from . import plugin_credentials as credentials

MAX_JSON_BYTES = 256 * 1024
TIMEOUT = 10


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


def revoke(session, server_url: str, tokens: dict, client: dict, *, endpoint: str = "", methods=None) -> bool | None:
    """Ask the vendor to revoke the refresh token, then the access token. True when it said yes to each it was
    given, False when it refused, None when it offers no way to revoke."""
    from .mcp_remote import authenticated
    if not endpoint or not _allowed(endpoint):
        endpoint, methods = revocation_endpoint(session, server_url)
    if not endpoint:
        return None
    confirmed = True
    asked = False
    for hint in ("refresh_token", "access_token"):
        token = tokens.get(hint)
        if not isinstance(token, str) or not token:
            continue
        asked = True
        # RFC 7009: the client authenticates as it does at the token address (a public client names itself).
        data, auth = authenticated(client, methods or [], {"token": token, "token_type_hint": hint}) \
            if client.get("client_id") else ({"token": token, "token_type_hint": hint}, None)
        try:
            response = session.post(endpoint, data=data, auth=auth, timeout=TIMEOUT, allow_redirects=False)
            confirmed = confirmed and response.status_code == 200
        except Exception:                                 # noqa: BLE001 -- said in the result, never raised
            confirmed = False
    return confirmed if asked else None


def _read_json(path: Path):
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_JSON_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def forget(name: str, *, session=None) -> dict:
    """Revoke and delete one server's sign-in. {"had_signin", "revoked", "deleted", "message"}."""
    nothing = {"had_signin": False, "revoked": None, "deleted": False, "message": ""}
    try:
        target = credentials.folder(name)
    except credentials.CredentialError:
        return nothing
    try:
        saved = credentials.load(name) or {}
    except (credentials.CredentialError, OSError):
        saved = {}
    tokens = saved.get("tokens") if isinstance(saved.get("tokens"), dict) else {}
    url = str(saved.get("url") or "")
    client = dict(saved.get("client") or {}) if isinstance(saved.get("client"), dict) else {}
    if saved.get("static_client_file"):
        # Your own app's secret stays in the file the editor wrote; revoking as that app needs it.
        static = _read_json(Path(str(saved["static_client_file"]))) or {}
        client.update({k: v for k, v in static.items() if k in ("client_id", "client_secret") and isinstance(v, str)})
    server = saved.get("server") if isinstance(saved.get("server"), dict) else {}
    revoked = None
    if tokens and url:
        if session is None:
            import requests
            session = requests.Session()
        revoked = revoke(session, url, tokens, client, endpoint=str(server.get("revocation_endpoint") or ""),
                         methods=server.get("revocation_endpoint_auth_methods_supported"))
    try:
        removed = credentials.delete(name)
    except (credentials.CredentialError, OSError):
        removed = False
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(target, ignore_errors=True)
    try:
        left = credentials.load(name) is not None
    except (credentials.CredentialError, OSError):
        left = True
    deleted = not left and not target.exists()
    if not tokens and not removed:
        return {**nothing, "deleted": deleted}
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
        message = (f"DGC couldn't delete its sign-in ({credentials.where()}, {target}). "
                   "Delete it to finish signing out.")
    return {"had_signin": bool(tokens), "revoked": revoked, "deleted": deleted, "message": message}
