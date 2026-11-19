"""ChatGPT · your plan (17 Nov, 0.52): DGC's own agent on the person's ChatGPT Plus or Pro plan.

Sign in with ChatGPT lets an open-source app that runs on the person's computer spend their plan's allowance on model
requests, with no approval and no key: the person signs in on chatgpt.com and allows "use my plan". DGC then runs
Chat, Work and Pips on the plan's models with its own tools, instead of handing whole turns to the Codex CLI.

The sign-in, as OpenAI's own kit does it:

- The sign-in service's addresses come from its discovery document, each checked to be on the service's own origin.
- The first sign-in registers DGC: the placeholder client id ``dynamic_agent_client``, the app's name as a hint, and a
  host id (a stable ``urn:uuid:`` for this DGC home). The service hands back the client id it issued; DGC keeps it, and
  every later sign-in uses it. Signing out keeps the registration.
- PKCE (S256), a state, a nonce, and a one-time address on 127.0.0.1 (``localhost`` isn't accepted there; only the port
  may change), path ``/auth/callback``.
- The code becomes tokens. The identity token comes straight from the service's token endpoint over TLS, so it is read,
  not verified with a key (OpenID Connect Core 3.1.3.7): issuer, audience, nonce and expiry are checked.
- The plan permission (``chatgpt.tokens.use.direct``) can be unticked on the consent page: then the person is signed in
  but DGC can't use the plan, and says so.
- An access token lasts an hour; the refresh token rotates (each one works once) and lives 30 days from its last use.
  DGC's windows and Pips share one sign-in, so one process at a time refreshes it (a file lock), reading again first in
  case another just did, and the new token is saved before it is used. A refreshed identity must be the same account.

Where it is kept: the system keychain, or an owner-only file in DGC's home (dgc.plugin_credentials), never config.json,
an event or a log. The model list and requests go to the public API (``https://api.openai.com/v1``) with the access
token; the plan's request rules (store off, streaming on, ``instructions`` for system guidance, no sampling or output
cap, no server-kept state) belong to the client that sends them (dgc.llm).
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import uuid
import webbrowser
from typing import Callable
from urllib.parse import urlencode, urlsplit

import requests

from . import plugin_credentials as store
from .provider_connect import OneTimeCallback, ConnectError, challenge_of

ISSUER = "https://auth.openai.com"
API = "https://api.openai.com/v1"
RESOURCE = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
CALLBACK_PATH = "/auth/callback"
APP_NAME = "DGC"
# What a route carries where a key would be: not a secret, a pointer to this sign-in (dgc.llm asks access_token() per
# request). Routes, saved providers and a Pip's provider pass it like any key.
PLAN_KEY = "dgc-chatgpt-plan"
USAGE_PAGE = "https://chatgpt.com/settings/usage"
SIGN_IN_WAIT_S = 600
TIMEOUT_S = 20
REFRESH_EARLY_S = 120                      # refresh a little before the hour is up, not on the request that finds it gone
TOKENS = "chatgpt-plan"                    # the sign-in (tokens and who), forgotten at sign-out
REGISTRATION = "chatgpt-plan-registration" # the issued client id and the host id, kept across sign-outs
_REFRESH_REFUSED = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
                    "refresh_token_invalidated", "refresh_token_reused"}


class PlanError(Exception):
    """A plain sentence for the person, and a code for DGC (signed_out, plan_use_declined, account_mismatch, …)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def error_words(code: str, *, resets_at: int = 0) -> str:
    """What to tell the person about one of the plan's own errors (they come from the API as codes). ``resets_at``:
    when a used-up limit resets (epoch seconds), when the plan said."""
    code = str(code or "")
    if code.endswith("usage_limit_exceeded"):
        from .usage_limits import resets_words
        when = resets_words(resets_at)
        return ("Your ChatGPT plan's limit for DGC is used up for now." + (f" It resets {when}." if when else "")
                + f" See how much is left, or change DGC's share, at {USAGE_PAGE}.")
    if code.endswith("usage_unavailable"):
        return "ChatGPT can't count this request against your plan right now. Try again in a little while."
    if code.endswith("user_not_eligible"):
        return ("This ChatGPT account can't share its plan with DGC: plan use needs ChatGPT Plus or Pro, and a "
                "workspace's admin can turn it off.")
    if code.endswith("client_not_enabled"):
        return "ChatGPT hasn't enabled plan use for DGC on this account. Sign in again, or use another connection."
    if code.endswith("route_not_supported"):
        return "ChatGPT doesn't take this kind of request on a plan. Choose another model or connection for it."
    return "ChatGPT refused the request."


# ---- the service's addresses ---------------------------------------------------------------------------------------

def _get_json(url: str, *, session=None, headers=None) -> dict:
    http = session or requests
    try:
        response = http.get(url, headers=headers or {}, timeout=TIMEOUT_S, allow_redirects=False)
    except requests.RequestException:
        raise PlanError("unreachable", "DGC couldn't reach ChatGPT. Check the connection and try again.") from None
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.status_code != 200 or not isinstance(body, dict):
        raise PlanError("unreachable", f"ChatGPT answered DGC with HTTP {response.status_code}. Try again in a little while.")
    return body


def discover(issuer: str = ISSUER, *, session=None) -> dict:
    """The sign-in service's endpoints, each on the issuer's own origin."""
    data = _get_json(f"{issuer}/.well-known/openid-configuration", session=session)
    origin = lambda url: "{0.scheme}://{0.netloc}".format(urlsplit(url))  # noqa: E731
    if data.get("issuer") != issuer:
        raise PlanError("discovery_failed", "ChatGPT's sign-in couldn't be checked. Try again later.")
    for key in ("authorization_endpoint", "token_endpoint", "revocation_endpoint"):
        value = data.get(key)
        if key == "revocation_endpoint" and value is None:
            continue
        if not isinstance(value, str) or origin(value) != origin(issuer):
            raise PlanError("discovery_failed", "ChatGPT's sign-in couldn't be checked. Try again later.")
    return data


def _form(url: str, fields: dict, *, session=None) -> tuple[int, dict]:
    http = session or requests
    try:
        response = http.post(url, data=fields, timeout=TIMEOUT_S, allow_redirects=False,
                             headers={"Accept": "application/json"})
    except requests.RequestException:
        raise PlanError("unreachable", "DGC couldn't reach ChatGPT. Check the connection and try again.") from None
    try:
        body = response.json()
    except ValueError:
        body = {}
    return response.status_code, body if isinstance(body, dict) else {}


# ---- who signed in ---------------------------------------------------------------------------------------------------

def identity(id_token: str, *, issuer: str, client_id: str, nonce: str | None = None) -> dict:
    """The identity token's claims, checked: from this issuer, for this app, this sign-in's nonce, not expired."""
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        raise PlanError("invalid_id_token", "ChatGPT didn't return an identity DGC could read. Sign in again.") from None
    audience = claims.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    if (not isinstance(claims, dict) or claims.get("iss") != issuer or client_id not in audiences
            or (nonce is not None and claims.get("nonce") != nonce)
            or not isinstance(claims.get("exp"), (int, float)) or claims["exp"] < time.time() - 60
            or not isinstance(claims.get("sub"), str) or not claims["sub"]):
        raise PlanError("invalid_id_token", "ChatGPT's answer wasn't for this sign-in. Sign in again.")
    return claims


def _registration() -> dict:
    kept = store.load(REGISTRATION) or {}
    if not isinstance(kept.get("host_id"), str) or not kept["host_id"].startswith("urn:uuid:"):
        kept = {**kept, "host_id": f"urn:uuid:{uuid.uuid4()}"}
        store.save(REGISTRATION, kept)
    return kept


def _tokens(body: dict, *, previous: dict | None = None) -> dict:
    scopes = str(body.get("scope") or (" ".join(previous.get("scopes", [])) if previous else "")).split()
    access, refresh = body.get("access_token"), body.get("refresh_token") or (previous or {}).get("refresh_token")
    if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
        raise PlanError("invalid_tokens", "ChatGPT's sign-in didn't hand DGC what it needs. Sign in again.")
    expires = body.get("expires_in")
    return {"access_token": access, "refresh_token": refresh, "scopes": scopes,
            "expires_at": time.time() + (float(expires) if isinstance(expires, (int, float)) else 3600.0)}


# ---- sign in, stay signed in, sign out -------------------------------------------------------------------------------

def sign_in(*, open_browser: Callable[[str], bool] = webbrowser.open, say: Callable[[str], None] = print,
            timeout: float = SIGN_IN_WAIT_S, issuer: str = ISSUER, api: str = API, session=None,
            redirect_host: Callable[[int], int] | None = None) -> dict:
    """Sign in with ChatGPT and allow plan use; returns the account (name, email), never a token.

    ``redirect_host(port)``: where the browser reaches this computer's port (an editor forwarding it over Remote-SSH
    gives another local port); the address stays on 127.0.0.1, as the service requires."""
    endpoints = discover(issuer, session=session)
    with store.locked(TOKENS, timeout=timeout):
        registration = _registration()
        client_id = registration.get("client_id") or ""
        verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
        state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        callback = OneTimeCallback(state, path=CALLBACK_PATH, hosts=("127.0.0.1",), service="ChatGPT")
        port = callback.start()
        try:
            shown_port = redirect_host(port) if redirect_host else port
            redirect_uri = f"http://127.0.0.1:{shown_port}{CALLBACK_PATH}"
            params = {"response_type": "code", "client_id": client_id or "dynamic_agent_client", "redirect_uri": redirect_uri,
                      "scope": SCOPES, "resource": RESOURCE, "code_challenge": challenge_of(verifier),
                      "code_challenge_method": "S256", "state": state, "nonce": nonce,
                      "ext_agent_host_id": registration["host_id"]}
            if not client_id:
                params["agent_name_hint"] = APP_NAME
            url = f"{endpoints['authorization_endpoint']}?{urlencode(params)}"
            try:
                opened = bool(open_browser(url))
            except Exception:
                opened = False
            if not opened:
                raise PlanError("no_browser", "DGC couldn't open a browser here. Sign in with ChatGPT needs one on this "
                                              "computer (it comes back to 127.0.0.1).")
            say("Sign in on the ChatGPT page that opened in your browser, and allow DGC to use your plan. Waiting…")
            try:
                code = callback.wait(timeout)
            except ConnectError as exc:
                raise PlanError("not_connected", str(exc)) from None
            issued = str(callback.fields.get("client_id") or client_id)
            if not issued or issued == "dynamic_agent_client" or len(issued) > 200:
                raise PlanError("registration_failed", "ChatGPT didn't register DGC. Try signing in again.")
        finally:
            callback.close()
        if issued != client_id:                   # kept before the exchange, as the service asks
            store.save(REGISTRATION, {**registration, "client_id": issued})
        status, body = _form(endpoints["token_endpoint"], {
            "grant_type": "authorization_code", "client_id": issued, "code": code, "code_verifier": verifier,
            "redirect_uri": redirect_uri, "resource": RESOURCE}, session=session)
        if status != 200:
            raise PlanError("not_connected", "ChatGPT didn't accept that sign-in. Try again.")
        who = identity(str(body.get("id_token") or ""), issuer=issuer, client_id=issued, nonce=nonce)
        tokens = _tokens(body)
        if PLAN_SCOPE not in tokens["scopes"]:
            raise PlanError("plan_use_declined", "You're signed in, but plan use wasn't allowed, so DGC can't use your "
                                                 "ChatGPT plan. Connect again and leave “use my plan” ticked.")
        record = {**tokens, "sub": who["sub"], "email": str(who.get("email") or ""), "name": str(who.get("name") or ""),
                  "client_id": issued, "issuer": issuer}
        store.save(TOKENS, record)
    return {"name": record["name"], "email": record["email"]}


# A Pip run's worker runs in a home of its own, with no sign-in in it: DGC's Pips runner hands it a live token for the
# run in its private input (for_run), and the worker holds it here, in memory only (hold).
_HELD: dict = {}


def hold(token: str, expires_at: float) -> None:
    """This process (a Pip run's worker) uses the token its runner handed it, until it runs out."""
    if isinstance(token, str) and token and isinstance(expires_at, (int, float)):
        _HELD.clear()
        _HELD.update(token=token, expires_at=float(expires_at))


def for_run(min_valid_s: float = 1800.0) -> dict:
    """{token, expires_at}: a token for a Pip run's worker, good for at least ``min_valid_s`` (refreshed first when less
    is left: a run can't renew it itself)."""
    token = access_token(fresh_for=min_valid_s)
    record = store.load(TOKENS) or {}
    return {"token": token, "expires_at": float(record.get("expires_at") or time.time() + min_valid_s)}


def access_token(*, issuer: str = ISSUER, api: str = API, session=None, now: Callable[[], float] | None = None,
                 fresh_for: float = REFRESH_EARLY_S) -> str:
    """A working access token: the kept one, or a refreshed one (one process at a time; the rotated token is saved first).
    ``fresh_for``: refresh when less than this many seconds are left."""
    clock = now or time.time
    if _HELD:
        if _HELD["expires_at"] - 30 > clock():
            return _HELD["token"]
        raise PlanError("signed_out", "This run's sign-in to your ChatGPT plan ran out. Send it again.")
    record = store.load(TOKENS)
    if not record or record.get("signed_out"):
        raise PlanError("signed_out" if record else "not_connected",
                        "DGC isn't signed in to your ChatGPT plan. Connect again: Settings › Models, or dgc chatgpt-plan connect.")
    early = max(REFRESH_EARLY_S, float(fresh_for or 0))
    if record.get("expires_at", 0) - early > clock():
        return record["access_token"]
    with store.locked(TOKENS):
        record = store.load(TOKENS) or record     # another window may have just refreshed it
        if record.get("expires_at", 0) - early > clock():
            return record["access_token"]
        endpoints = discover(record.get("issuer") or issuer, session=session)
        status, body = _form(endpoints["token_endpoint"], {
            "grant_type": "refresh_token", "client_id": record["client_id"], "refresh_token": record["refresh_token"],
            "resource": RESOURCE}, session=session)
        if status != 200:
            code = str(body.get("error") or body.get("code") or "")
            if status in (400, 401) and (code in _REFRESH_REFUSED or not code):
                store.save(TOKENS, {**record, "signed_out": True, "access_token": "", "refresh_token": ""})
                raise PlanError("signed_out", "Your ChatGPT plan's sign-in has ended. Connect again: Settings › Models, or dgc chatgpt-plan connect.")
            raise PlanError("unreachable", f"ChatGPT couldn't renew DGC's sign-in (HTTP {status}). Try again in a little while.")
        if body.get("id_token"):
            who = identity(str(body["id_token"]), issuer=record.get("issuer") or issuer, client_id=record["client_id"])
            if who["sub"] != record["sub"]:
                raise PlanError("account_mismatch", "ChatGPT signed DGC in as another account. Connect again with the "
                                                    "account you chose before.")
        tokens = _tokens(body, previous=record)
        store.save(TOKENS, {**record, **tokens})
        return tokens["access_token"]


def status(*, issuer: str = ISSUER, api: str = API, **_ignored) -> dict:
    """{state: none|connected|signed_out, name, email} for Settings and the model picker; no token, no network."""
    record = store.load(TOKENS)
    if not record:
        return {"state": "none"}
    return {"state": "signed_out" if record.get("signed_out") else "connected",
            "name": str(record.get("name") or ""), "email": str(record.get("email") or "")}


def sign_out(*, issuer: str = ISSUER, api: str = API, session=None) -> None:
    """Revoke the refresh token at the service (best effort) and forget the sign-in; the registration stays."""
    with store.locked(TOKENS):
        record = store.load(TOKENS)
        if record and record.get("refresh_token"):
            try:
                endpoints = discover(record.get("issuer") or issuer, session=session)
                if endpoints.get("revocation_endpoint"):
                    _form(endpoints["revocation_endpoint"], {"token": record["refresh_token"],
                                                             "token_type_hint": "refresh_token",
                                                             "client_id": record["client_id"]}, session=session)
            except PlanError:
                pass
        store.delete(TOKENS)


def models(*, issuer: str = ISSUER, api: str = API, session=None) -> list[dict]:
    """The plan's models for this account, in the service's order: [{slug, name}]."""
    token = access_token(issuer=issuer, api=api, session=session)
    body = _get_json(f"{api}/models", session=session, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    rows = body.get("models")
    if not isinstance(rows, list):
        raise PlanError("invalid_models", "ChatGPT returned a model list DGC couldn't read. Try again.")
    out = []
    for row in rows:
        if not isinstance(row, dict) or row.get("visibility") != "list":
            continue
        slug, name = row.get("slug"), row.get("display_name")
        if isinstance(slug, str) and slug.strip() and len(slug) <= 200:
            out.append({"slug": slug, "name": name if isinstance(name, str) and name.strip() else slug})
    return out


# ---- dgc chatgpt-plan connect|status|sign-out ---------------------------------------------------------------------

USAGE = ("dgc chatgpt-plan connect|status|sign-out [--json]  ChatGPT · your plan: sign in with ChatGPT so DGC runs on "
         "your Plus or Pro plan")


def cli(argv: list[str], *, out=None, read_line: Callable[[], str] | None = None,
        open_browser: Callable[[str], bool] | None = None, issuer: str = ISSUER, api: str = API, session=None,
        timeout: float = SIGN_IN_WAIT_S) -> int:
    """The command. With --json (the editor's way): one JSON object per line. connect says
    {"event": "listening", "port"} and reads one line back ({"redirect_port": N} when the editor forwards the port, or
    {}), then {"event": "open", "url"} (the editor opens it), then {"event": "connected", "name", "email"} or
    {"event": "error", "code", "message"}. Never a token."""
    import sys
    stream = out or sys.stdout
    words = [w for w in argv if w != "--json"]
    as_json = "--json" in argv
    command = words[0] if words else "status"

    def emit(value: dict) -> None:
        stream.write(json.dumps(value) + "\n")
        stream.flush()

    def said(text: str) -> None:
        if not as_json:
            stream.write(text + "\n")

    try:
        if command == "status":
            state = status(issuer=issuer, api=api)
            emit(state) if as_json else said(
                {"none": "Not connected. Run: dgc chatgpt-plan connect",
                 "signed_out": "Signed out. Run: dgc chatgpt-plan connect",
                 "connected": f"Connected as {state.get('name') or state.get('email')}"}[state["state"]])
            return 0
        if command in ("sign-out", "signout", "logout"):
            sign_out(issuer=issuer, api=api, session=session)
            emit({"state": "none"}) if as_json else said("Signed out of your ChatGPT plan.")
            return 0
        if command != "connect":
            stream.write(USAGE + "\n")
            return 2

        def forwarded(port: int) -> int:
            if not as_json:
                return port
            emit({"event": "listening", "port": port})
            line = (read_line or sys.stdin.readline)() or "{}"
            try:
                value = json.loads(line)
                chosen = int(value.get("redirect_port") or port) if isinstance(value, dict) else port
            except (ValueError, TypeError):
                chosen = port
            return chosen if 1 <= chosen <= 65535 else port

        def opener(url: str) -> bool:
            if as_json and open_browser is None:
                emit({"event": "open", "url": url})
                return True
            if as_json:
                emit({"event": "open", "url": url})
            return (open_browser or webbrowser.open)(url)

        account = sign_in(open_browser=opener, say=said, issuer=issuer, api=api, session=session, redirect_host=forwarded,
                          timeout=timeout)
        emit({"event": "connected", **account}) if as_json else said(
            f"Connected as {account.get('name') or account.get('email')}. DGC can now run on your ChatGPT plan.")
        return 0
    except PlanError as exc:
        emit({"event": "error", "code": exc.code, "message": str(exc)}) if as_json else said(str(exc))
        return 1
