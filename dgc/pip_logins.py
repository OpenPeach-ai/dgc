"""Saved logins for Personal Pips: a site's username, password and authenticator key, kept sealed on this computer.

A Pip never sees or types a password. The user saves a site's login once (from the card its chat shows when the
Pip meets a sign-in page, or on the Pip's page under Logins); when the Pip needs to sign in it asks its computer to
(``sign_in``), and DGC types the username, password and one-time code into the page itself (pip_login_fill). The Pip
is told only what was filled, never a value.

Where and how they are kept:

- ``<Pips state>/logins/logins.sealed``, sealed under a 256-bit key of its own in ``logins.key`` beside it (both
  0600, the folder 0700). Python's standard library has no AES, so the seal is built from what it has, as a
  textbook construction: HMAC-SHA256 in counter mode is the keystream, and HMAC-SHA256 over the nonce and the
  ciphertext authenticates it (encrypt-then-MAC), with the two keys derived from the one in ``logins.key``. A file
  that fails its check is never half-read.
- Not in the Pips database, so no registry export, Pip export, shared-Pip file or run record holds them. Nothing
  here is backed up, exported or moved, and neither file is ever logged.
- Each login says which Pips may use it: one Pip (the default) or all of them.

Every value this process saves or reads is remembered for redaction (``known_values``), and the sealed file of
this profile is read for it too, so a password that turns up anywhere (a page that echoes it, a message the user
typed) is redacted like any other credential.
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets as _secrets
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit

from .workspace_registry import RegistryError, utc_now

VERSION = 1
FOLDER = "logins"
SEALED = "logins.sealed"
KEY_FILE = "logins.key"
MAGIC = b"DGC-LOGINS-SEALED-1\n"
NONCE_BYTES = 16
TAG_BYTES = 32
MAX_LOGINS = 200
MAX_FIELD = 512
MAX_HOSTS = 20
MAX_PIPS = 64
MAX_FILE = 4 * 1024 * 1024
LOCAL = ("editor-user", "local-console")
_PIP_ID = re.compile(r"pip_[0-9a-f]{32}")
_LOGIN_ID = re.compile(r"login_[0-9a-f]{32}")
_SEEN: set[str] = set()                    # values this process saved or read, for redaction only
_SEEN_LOCK = threading.Lock()
_DEFAULT_CACHE: dict = {}                  # this profile's sealed file, by its stat, for redaction
_WARNED: set[str] = set()


class LoginError(RegistryError):
    """A login that can't be saved or used, in words the user sees. Never carries a value."""

    def __init__(self, message: str, code: str = "invalid_login"):
        super().__init__(code, message)


# --------------------------------------------------------------------------- the seal

def _derived(key: bytes, label: bytes) -> bytes:
    return hmac.new(key, b"dgc-logins/" + label, hashlib.sha256).digest()


def _keystream(key: bytes, nonce: bytes, size: int) -> bytes:
    blocks = []
    for counter in range((size + 31) // 32):
        blocks.append(hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
    return b"".join(blocks)[:size]


def _xor(data: bytes, stream: bytes) -> bytes:
    if not data:
        return b""
    return (int.from_bytes(data, "big") ^ int.from_bytes(stream, "big")).to_bytes(len(data), "big")


def seal(plain: bytes, key: bytes) -> bytes:
    """MAGIC | nonce | ciphertext | tag: a keystream of HMAC-SHA256 blocks, then HMAC-SHA256 over all before the tag."""
    if len(key) != 32:
        raise ValueError("a 256-bit key")
    nonce = os.urandom(NONCE_BYTES)
    body = _xor(plain, _keystream(_derived(key, b"encrypt"), nonce, len(plain)))
    tag = hmac.new(_derived(key, b"authenticate"), MAGIC + nonce + body, hashlib.sha256).digest()
    return MAGIC + nonce + body + tag


def unseal(blob: bytes, key: bytes) -> bytes:
    """The plaintext, or LoginError when the file isn't one this key sealed (or it was changed)."""
    if len(key) != 32 or len(blob) < len(MAGIC) + NONCE_BYTES + TAG_BYTES or not blob.startswith(MAGIC):
        raise LoginError("The saved logins file can't be opened.", "unreadable")
    nonce = blob[len(MAGIC):len(MAGIC) + NONCE_BYTES]
    body, tag = blob[len(MAGIC) + NONCE_BYTES:-TAG_BYTES], blob[-TAG_BYTES:]
    want = hmac.new(_derived(key, b"authenticate"), MAGIC + nonce + body, hashlib.sha256).digest()
    if not hmac.compare_digest(want, tag):
        raise LoginError("The saved logins file can't be opened.", "unreadable")
    return _xor(body, _keystream(_derived(key, b"encrypt"), nonce, len(body)))


# --------------------------------------------------------------------------- sites and pages

def site_of(host: str) -> str:
    from .pip_careful import site_of as careful_site
    return careful_site(host)


def _plain_host(host) -> str:
    return str(host or "").strip().rstrip(".").lower()


def loopback(host: str) -> bool:
    host = _plain_host(host).strip("[]")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_address(raw) -> tuple[str, str]:
    """(host, sign-in page or "") from what the user typed: an address or a bare domain. Raises LoginError."""
    text = str(raw or "").strip()
    if not text or len(text) > 2048 or any(ord(ch) < 33 or ch == "\\" for ch in text):
        raise LoginError("Type the site's address, such as example.com.")
    parts = urlsplit(text if re.match(r"^[a-z][a-z0-9+.-]*://", text, re.I) else "https://" + text)
    if parts.scheme not in ("https", "http") or not parts.hostname or parts.username or parts.password:
        raise LoginError("Type the site's address, such as example.com.")
    host = _plain_host(parts.hostname)
    if "." not in host and not loopback(host):
        raise LoginError("Type the site's whole address, such as example.com.")
    page = ""
    if parts.path not in ("", "/"):
        page = f"{parts.scheme}://{parts.netloc.lower()}{parts.path}"[:500]
    return host, page


def page_check(url: str) -> tuple[bool, str, str]:
    """Whether a saved login may ever be typed into this page: (ok, host, why not). https, or plain http on this
    computer only (a password sent over plain http to another computer can be read on the way)."""
    parts = urlsplit(str(url or ""))
    host = _plain_host(parts.hostname)
    if parts.scheme not in ("https", "http") or not host:
        return False, host, "address"
    if parts.scheme == "http" and not loopback(host):
        return False, host, "insecure"
    return True, host, ""


def matches(login: dict, host: str) -> bool:
    """A login fills on its sign-in hosts, and anywhere on its site unless it is kept to those hosts."""
    host = _plain_host(host)
    return host in login["hosts"] or (not login.get("exact") and site_of(host) == login["site"])


def usable_by(login: dict, pip_id: str) -> bool:
    return login["pips"] == "all" or pip_id in login["pips"]


# --------------------------------------------------------------------------- the store

def folder(state_directory) -> Path:
    from .workspace_registry import _private_directory
    path = Path(state_directory) / FOLDER
    _private_directory(path)
    return path


def _valid_login(item) -> bool:
    from .pip_totp import valid_key
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not _LOGIN_ID.fullmatch(item["id"]):
        return False
    text = lambda key, low=0: isinstance(item.get(key), str) and low <= len(item[key]) <= MAX_FIELD  # noqa: E731
    pips = item.get("pips")
    return (text("site", 1) and text("username") and text("password", 1)
            and isinstance(item.get("hosts"), list) and 1 <= len(item["hosts"]) <= MAX_HOSTS
            and all(isinstance(h, str) and 0 < len(h) <= 255 for h in item["hosts"])
            and isinstance(item.get("exact"), bool) and (item.get("totp") is None or valid_key(item["totp"]))
            and (pips == "all" or isinstance(pips, list) and len(pips) <= MAX_PIPS
                 and all(isinstance(p, str) and _PIP_ID.fullmatch(p) for p in pips))
            and isinstance(item.get("sign_in_page"), str) and len(item["sign_in_page"]) <= 500
            and item.get("source") in ("card", "page", "sdk")
            and all(isinstance(item.get(k), str) for k in ("created_at", "updated_at"))
            and (item.get("last_used_at") is None or isinstance(item["last_used_at"], str)))


def summary(login: dict, pip_id: str | None = None) -> dict:
    """A login as the user's page and the SDKs see it: never its password or its key."""
    out = {"id": login["id"], "site": login["site"], "hosts": list(login["hosts"]), "username": login["username"],
           "has_code": login.get("totp") is not None, "pips": "all" if login["pips"] == "all" else list(login["pips"]),
           "source": login["source"], "created_at": login["created_at"], "last_used_at": login.get("last_used_at")}
    if pip_id is not None:
        out["usable"] = usable_by(login, pip_id)
    return out


def _remember(values) -> None:
    with _SEEN_LOCK:
        for value in values:
            if isinstance(value, str) and len(value) >= 4 and len(_SEEN) < 512:
                _SEEN.add(value)


def _values(data: dict) -> list[str]:
    out = []
    for login in data.get("logins", []):
        out.append(login["password"])
        if login.get("totp"):
            out.append(login["totp"]["secret"])
    return out


class Store:
    """One profile's saved logins. Each call reads the sealed file afresh (several DGC processes share it)."""

    def __init__(self, state_directory):
        self.directory = Path(state_directory)

    @property
    def root(self) -> Path:
        return folder(self.directory)

    # -- the files ---------------------------------------------------------------------------

    def _key(self, create: bool) -> bytes | None:
        path = self.root / KEY_FILE
        try:
            if path.is_symlink():
                raise LoginError("The saved logins key is not a file DGC owns.", "unsafe_state")
            text = path.read_text(encoding="ascii").strip()
            if re.fullmatch(r"[0-9a-f]{64}", text):
                return bytes.fromhex(text)
        except (OSError, UnicodeError):
            pass
        if not create:
            return None
        key = _secrets.token_bytes(32)
        self._write_private(path, (key.hex() + "\n").encode("ascii"), replace=False)
        return bytes.fromhex(path.read_text(encoding="ascii").strip())

    def _write_private(self, path: Path, data: bytes, *, replace: bool = True) -> None:
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            if replace:
                os.replace(tmp, path)
            else:
                try:
                    os.link(tmp, path)             # never over a key another process just made
                except FileExistsError:
                    pass
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()

    def read(self) -> dict:
        """{"version", "logins"}: an empty store when there is no file, or none this key can open."""
        path = self.root / SEALED
        try:
            info = path.lstat()
        except OSError:
            return {"version": VERSION, "logins": []}
        if path.is_symlink() or not path.is_file() or info.st_size > MAX_FILE:
            raise LoginError("The saved logins file is not one DGC owns.", "unsafe_state")
        key = self._key(False)
        try:
            if key is None:
                raise LoginError("The saved logins key is missing.", "unreadable")
            value = json.loads(unseal(path.read_bytes(), key).decode("utf-8"))
            logins = [item for item in value.get("logins", [])[:MAX_LOGINS] if _valid_login(item)]
        except (LoginError, ValueError, AttributeError):
            # Said once, never with the file's contents; the next save replaces it.
            if str(path) not in _WARNED:
                _WARNED.add(str(path))
                sys.stderr.write("dgc: the saved logins file could not be opened; saving a login replaces it\n")
            return {"version": VERSION, "logins": []}
        data = {"version": VERSION, "logins": logins}
        _remember(_values(data))
        return data

    def _write(self, data: dict) -> None:
        plain = json.dumps({"version": VERSION, "logins": data["logins"]}, ensure_ascii=False,
                           separators=(",", ":")).encode("utf-8")
        self._write_private(self.root / SEALED, seal(plain, self._key(True)))
        _remember(_values(data))

    @contextlib.contextmanager
    def _locked(self):
        import fcntl
        descriptor = os.open(self.root / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    # -- what the user does ------------------------------------------------------------------

    def listing(self, pip_id: str | None = None) -> list[dict]:
        logins = sorted(self.read()["logins"], key=lambda l: (l["site"], l["username"].lower(), l["id"]))
        return [summary(login, pip_id) for login in logins]

    def save(self, *, address, username, password, totp=None, pips, source: str, hosts=None, page: str = "") -> dict:
        """Keep one login (the same account on the same site replaces its password and key). Returns its summary."""
        from .pip_totp import TotpError, parse_key
        if source not in ("card", "page", "sdk"):
            raise LoginError("Unknown place to save a login from.")
        host, typed_page = normalize_address(address)
        if not isinstance(username, str) or len(username) > MAX_FIELD or any(ord(c) < 32 for c in username):
            raise LoginError("The username is too long or has line breaks in it.")
        if not isinstance(password, str) or not password or len(password) > MAX_FIELD or "\n" in password:
            raise LoginError("Type the password (up to 512 characters, on one line).")
        key = None
        if totp not in (None, ""):
            try:
                key = parse_key(totp)
            except TotpError as error:
                raise LoginError(str(error)) from None
        if pips != "all" and (not isinstance(pips, list) or not 1 <= len(pips) <= MAX_PIPS
                              or not all(isinstance(p, str) and _PIP_ID.fullmatch(p) for p in pips)):
            raise LoginError("Choose which Pips may use this login.")
        sign_in_hosts = [h for h in (hosts or [host]) if isinstance(h, str) and h][:MAX_HOSTS] or [host]
        site = site_of(host)
        page = page or typed_page
        if page and site_of(urlsplit(page).hostname or "") != site:
            page = ""
        now = utc_now()
        with self._locked():
            data = self.read()
            logins = data["logins"]
            same = next((l for l in logins if l["site"] == site and l["username"].lower() == username.lower()), None)
            if same is not None:
                same.update(username=username, password=password, updated_at=now,
                            hosts=list(dict.fromkeys(same["hosts"] + sign_in_hosts))[:MAX_HOSTS],
                            pips="all" if "all" in (same["pips"], pips) else list(dict.fromkeys(same["pips"] + pips))[:MAX_PIPS],
                            sign_in_page=page or same["sign_in_page"])
                if key is not None:
                    same["totp"] = key
                login = same
            else:
                if len(logins) >= MAX_LOGINS:
                    raise LoginError(f"DGC keeps up to {MAX_LOGINS} logins. Remove one first.")
                login = {"id": "login_" + _secrets.token_hex(16), "site": site, "hosts": sign_in_hosts, "exact": False,
                         "username": username, "password": password, "totp": key,
                         "pips": "all" if pips == "all" else list(dict.fromkeys(pips)), "sign_in_page": page,
                         "source": source, "created_at": now, "updated_at": now, "last_used_at": None}
                logins.append(login)
            self._write(data)
        return summary(login)

    def remove(self, login_id) -> bool:
        if not isinstance(login_id, str) or not _LOGIN_ID.fullmatch(login_id):
            raise LoginError("Choose a saved login.")
        with self._locked():
            data = self.read()
            kept = [l for l in data["logins"] if l["id"] != login_id]
            if len(kept) == len(data["logins"]):
                return False
            self._write({**data, "logins": kept})
        return True

    def grant(self, login_id, pips) -> dict:
        """Which Pips may use this login: "all", or exactly these."""
        if not isinstance(login_id, str) or not _LOGIN_ID.fullmatch(login_id):
            raise LoginError("Choose a saved login.")
        if pips != "all" and (not isinstance(pips, list) or len(pips) > MAX_PIPS
                              or not all(isinstance(p, str) and _PIP_ID.fullmatch(p) for p in pips)):
            raise LoginError("Choose which Pips may use this login.")
        with self._locked():
            data = self.read()
            login = next((l for l in data["logins"] if l["id"] == login_id), None)
            if login is None:
                raise LoginError("That login is no longer saved.", "not_found")
            login["pips"] = "all" if pips == "all" else list(dict.fromkeys(pips))
            login["updated_at"] = utc_now()
            self._write(data)
        return summary(login)

    # -- what the computer does --------------------------------------------------------------

    def usable(self, pip_id: str, host: str) -> list[dict]:
        """The logins this Pip may type on a page of this host, most recently used first. Secrets included:
        for the fill only, in the supervisor."""
        found = [l for l in self.read()["logins"] if usable_by(l, pip_id) and matches(l, host)]
        return sorted(found, key=lambda l: (l.get("last_used_at") or "", l["updated_at"]), reverse=True)

    def for_site(self, pip_id: str, address: str) -> list[dict]:
        try:
            host, _ = normalize_address(address)
        except LoginError:
            return []
        return self.usable(pip_id, host)

    def mark_used(self, login_id: str) -> None:
        with contextlib.suppress(LoginError, OSError):
            with self._locked():
                data = self.read()
                for login in data["logins"]:
                    if login["id"] == login_id:
                        login["last_used_at"] = utc_now()
                        self._write(data)
                        return

    def secret_values(self) -> tuple[str, ...]:
        return tuple(_values(self.read()))


def store_for(registry) -> Store:
    return Store(registry.directory)


# --------------------------------------------------------------------------- redaction

def values_for(state_directory) -> tuple[str, ...]:
    """The passwords and keys saved in this state directory, read again only when the sealed file changes: what the
    computer scrubs from every answer it gives a Pip. Never fails."""
    path = Path(state_directory) / FOLDER / SEALED
    try:
        info = os.stat(path)
        stamp = (info.st_mtime_ns, info.st_size, info.st_ino)
        hit = _DEFAULT_CACHE.get(str(path))
        if hit is not None and hit[0] == stamp:
            return hit[1]
        values = Store(state_directory).secret_values()
        _DEFAULT_CACHE[str(path)] = (stamp, values)
        return values
    except Exception:  # noqa: BLE001 -- a store that can't be read has nothing to scrub
        return ()


def known_values() -> tuple[str, ...]:
    """Saved passwords and keys this process has seen, and those in this profile's sealed file: for redaction only.
    Read again only when the file changes; never fails."""
    try:
        from .workspace_registry import state_directory
        values_for(state_directory())
    except Exception:  # noqa: BLE001 -- redaction never fails because the store couldn't be read
        pass
    with _SEEN_LOCK:
        return tuple(_SEEN)


# --------------------------------------------------------------------------- the user's requests

COMMANDS = ("list_pip_logins", "save_pip_login", "remove_pip_login", "grant_pip_login")


def _personal_pip(registry, pip_id) -> dict:
    from .pips import PipStore
    if not isinstance(pip_id, str) or not _PIP_ID.fullmatch(pip_id):
        raise LoginError("Choose a Pip.", "invalid_request")
    job = PipStore(registry)._job(pip_id)
    workspace = registry.get(job["workspace_id"])
    if workspace.get("kind") != "personal":
        raise LoginError("Saved logins are for Personal Pips.", "invalid_request")
    return job


def _pips_list(registry, value, pip_id=None) -> "str | list":
    if value == "all":
        return "all"
    if value == "only":
        if pip_id is None:
            raise LoginError("Choose which Pips may use this login.")
        return [pip_id]
    if isinstance(value, list):
        for item in value:
            _personal_pip(registry, item)
        return list(dict.fromkeys(value))
    raise LoginError("Choose which Pips may use this login: only this Pip, or all your Pips.")


def handle(registry, command: str, request: dict, actor: str) -> dict:
    """The four requests (Pips API 56). Answers never carry a password or a key."""
    if actor not in LOCAL:
        raise LoginError("Saved logins are on this computer only.", "local_only")
    store = store_for(registry)
    if command == "list_pip_logins":
        pip_id = request.get("pip_id")
        if pip_id is not None:
            _personal_pip(registry, pip_id)
        return {"logins": store.listing(pip_id)}
    if command == "remove_pip_login":
        return {"removed": store.remove(request.get("login_id")), "login_id": str(request.get("login_id") or "")[:80]}
    if command == "grant_pip_login":
        return {"login": store.grant(request.get("login_id"), _pips_list(registry, request.get("pips")))}
    # save_pip_login: from the card in a Pip's chat (action_id, the offer it answers) or from its page.
    pip_id = request.get("pip_id")
    _personal_pip(registry, pip_id)
    pips = _pips_list(registry, request.get("pips", "only"), pip_id)
    action_id = request.get("action_id")
    hosts, page, source = None, "", "page" if actor == "editor-user" else "sdk"
    offer = None
    if action_id is not None:
        offer = _offer(registry, pip_id, action_id, request.get("expected_digest"))
        hosts, page, source = [offer["summary"]["host"]], offer["summary"].get("sign_in_page") or "", "card"
        address = offer["summary"]["host"]
    else:
        address = request.get("site")
    saved = store.save(address=address, username=request.get("username"), password=request.get("password"),
                       totp=request.get("totp"), pips=pips, source=source, hosts=hosts, page=page)
    out = {"login": saved}
    if offer is not None:
        # The card is answered in the same step: the Pip is told and signs in by itself (pip_computer.tick).
        from .pip_computer import _decide, projection, _row
        try:
            with registry.transaction():
                _decide(registry, action_id, request.get("expected_digest"), True, actor)
            out["action"] = projection(_row(registry, action_id))
        except RegistryError as error:
            out["continue_error"] = str(error)[:300]
    return out


def _offer(registry, pip_id, action_id, expected_digest) -> dict:
    from .pip_computer import projection, _row
    if not isinstance(action_id, str) or not re.fullmatch(r"compact_[a-f0-9]{32}", action_id):
        raise LoginError("That card is not a login to save.", "invalid_request")
    action = projection(_row(registry, action_id))
    if action["pip_id"] != pip_id or action["summary"].get("kind") != "login":
        raise LoginError("That card is not a login to save.", "invalid_request")
    if action["status"] != "pending":
        raise LoginError(f"That card was already answered ({action['status']}).", "conflict")
    if action["digest"] != expected_digest:
        raise LoginError("The card changed. Look at it again before saving.", "review_changed")
    return action
