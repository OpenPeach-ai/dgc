"""Where a remote plugin's sign-in is kept: the system keychain, or an owner-only file where there is none.

One entry per remote MCP server, named by the server: its OAuth client registration, its tokens and where it signs
in. ``plugin_credentials_store`` chooses how (founder, 2026-10-15; Codex's ``mcp_oauth_credentials_store``):

- ``auto`` (the default): the system keychain when this computer has one DGC can use, else the file;
- ``keyring``: the keychain or nothing (a sign-in that can't be kept there fails, never falls back to a file);
- ``file``: always the file.

The keychain is the macOS Keychain (the Security framework, called directly: no secret ever on a command line, and
``security -i`` cuts lines near 8 KB) or, on Linux, the desktop keyring through ``secret-tool`` (libsecret) when it is
installed and answers. The file is ``~/.dgc/plugin-auth/<server>/credentials.json``, readable only by you, as Claude
Code keeps its own on Linux. A keychain that can't be used right now (a Mac reached over SSH keeps the login
keychain locked: "User interaction is not allowed") falls back to the file in ``auto``, for reads as well as writes.

Each keychain entry belongs to one DGC home (its account is the server's name and a digest of the home's path), as
the file does: a test or an isolated session with a home of its own never reads or deletes the user's sign-ins.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

SERVICE = "DGC plugin sign-in"
LINUX_SERVICE = "dgc-plugin-signin"
NAME = re.compile(r"[A-Za-z0-9._-]{1,64}")
MODES = ("auto", "keyring", "file")
MAX_BYTES = 256 * 1024
_MODE = "auto"
_KEYRING = None                    # the probed backend, once per process: a _Backend, or False for none
_KEYRING_LOCK = threading.Lock()


class CredentialError(RuntimeError):
    pass


def configure(mode) -> str:
    """Set the store mode from the config (``plugin_credentials_store``); anything unknown is ``auto``."""
    global _MODE
    _MODE = mode if mode in MODES else "auto"
    return _MODE


def mode() -> str:
    return _MODE


def folder(name: str) -> Path:
    if not NAME.fullmatch(str(name or "")) or name in (".", ".."):
        raise CredentialError("A plugin's sign-in needs a plain server name.")
    from .config import dgc_home
    return dgc_home() / "plugin-auth" / name


def _account(name: str) -> str:
    """The keychain account for one server in this DGC home."""
    from .config import dgc_home
    home = str(Path(dgc_home()).expanduser().resolve(strict=False))
    return f"{name}@{hashlib.sha256(home.encode('utf-8')).hexdigest()[:16]}"


def _private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise CredentialError(f"{path} is not a folder DGC owns")
    path.chmod(0o700)
    return path


# ---------------------------------------------------------------------------------------------------- the file

class _File:
    """Keyed by the server's name: the file already lives in this DGC home."""
    name = "file"

    @staticmethod
    def _path(account: str) -> Path:
        return folder(account) / "credentials.json"

    def load(self, account: str) -> str | None:
        path = self._path(account)
        try:
            info = path.lstat()
        except OSError:
            return None
        if not path.is_file() or path.is_symlink() or info.st_size > MAX_BYTES:
            return None
        return path.read_text(encoding="utf-8")

    def save(self, account: str, secret: str) -> None:
        target = _private_dir(folder(account)) / "credentials.json"
        tmp = target.with_name(f".credentials.{os.getpid()}.{threading.get_ident()}.tmp")
        descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(secret)
            os.chmod(tmp, 0o600)
            os.replace(tmp, target)
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()

    def delete(self, account: str) -> bool:
        try:
            self._path(account).unlink()
            return True
        except FileNotFoundError:
            return False


# ------------------------------------------------------------------------------------------- macOS: the Keychain

class _MacKeychain:
    """Generic passwords in the login keychain, through Security.framework (SecItemAdd/CopyMatching/Delete)."""
    name = "macos-keychain"
    NOT_FOUND = -25300
    DUPLICATE = -25299
    INTERACTION_NOT_ALLOWED = -25308

    def __init__(self, keychain: str | None = None):
        import ctypes
        import ctypes.util
        self.ct = ctypes
        self.sec = ctypes.CDLL(ctypes.util.find_library("Security"))
        self.cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
        cf, sec = self.cf, self.sec
        cf.CFStringCreateWithCString.restype = ctypes.c_void_p
        cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
        cf.CFDataCreate.restype = ctypes.c_void_p
        cf.CFDataCreate.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long]
        cf.CFDictionaryCreate.restype = ctypes.c_void_p
        cf.CFDictionaryCreate.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long,
                                          ctypes.c_void_p, ctypes.c_void_p]
        cf.CFDataGetLength.restype = ctypes.c_long
        cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
        cf.CFDataGetBytePtr.restype = ctypes.c_void_p
        cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        cf.CFArrayCreate.restype = ctypes.c_void_p
        cf.CFArrayCreate.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p]
        for function in ("SecItemAdd", "SecItemCopyMatching"):
            getattr(sec, function).restype = ctypes.c_int32
            getattr(sec, function).argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        sec.SecItemDelete.restype = ctypes.c_int32
        sec.SecItemDelete.argtypes = [ctypes.c_void_p]
        sec.SecItemUpdate.restype = ctypes.c_int32
        sec.SecItemUpdate.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        constant = lambda library, symbol: ctypes.c_void_p.in_dll(library, symbol).value  # noqa: E731
        self.k = {name: constant(sec, name) for name in (
            "kSecClass", "kSecClassGenericPassword", "kSecAttrService", "kSecAttrAccount", "kSecValueData",
            "kSecReturnData", "kSecMatchLimit", "kSecMatchLimitOne", "kSecAttrLabel", "kSecUseKeychain",
            "kSecMatchSearchList")}
        self.k["true"] = constant(cf, "kCFBooleanTrue")
        self.key_callbacks = ctypes.addressof(ctypes.c_void_p.in_dll(cf, "kCFTypeDictionaryKeyCallBacks"))
        self.value_callbacks = ctypes.addressof(ctypes.c_void_p.in_dll(cf, "kCFTypeDictionaryValueCallBacks"))
        self.keychain = self.search = None
        if keychain:
            # One keychain file instead of the login keychain: only the tests use this, on a Mac reached over
            # SSH, where the login keychain stays locked. Everything else is the same calls.
            sec.SecKeychainOpen.restype = ctypes.c_int32
            sec.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
            ref = ctypes.c_void_p()
            if sec.SecKeychainOpen(keychain.encode("utf-8"), ctypes.byref(ref)) != 0:
                raise CredentialError("couldn't open that keychain")
            self.keychain = ref.value
            items = (ctypes.c_void_p * 1)(self.keychain)
            self.search = cf.CFArrayCreate(None, items, 1,
                                           ctypes.addressof(ctypes.c_void_p.in_dll(cf, "kCFTypeArrayCallBacks")))

    def _string(self, text: str):
        return self.cf.CFStringCreateWithCString(None, text.encode("utf-8"), 0x08000100)

    def _dictionary(self, pairs):
        ct = self.ct
        keys = (ct.c_void_p * len(pairs))(*[key for key, _ in pairs])
        values = (ct.c_void_p * len(pairs))(*[value for _, value in pairs])
        return self.cf.CFDictionaryCreate(None, keys, values, len(pairs), self.key_callbacks, self.value_callbacks)

    def _query(self, account: str, *extra, adding: bool = False):
        owned = [self._string(SERVICE), self._string(account)]
        pairs = [(self.k["kSecClass"], self.k["kSecClassGenericPassword"]),
                 (self.k["kSecAttrService"], owned[0]), (self.k["kSecAttrAccount"], owned[1]), *extra]
        if self.keychain:
            pairs.append((self.k["kSecUseKeychain"], self.keychain) if adding
                         else (self.k["kSecMatchSearchList"], self.search))
        return self._dictionary(pairs), owned

    def _release(self, *objects):
        for item in objects:
            if item:
                self.cf.CFRelease(item)

    def load(self, account: str) -> str | None:
        query, owned = self._query(account, (self.k["kSecReturnData"], self.k["true"]),
                                   (self.k["kSecMatchLimit"], self.k["kSecMatchLimitOne"]))
        result = self.ct.c_void_p()
        try:
            status = self.sec.SecItemCopyMatching(query, self.ct.byref(result))
            if status == self.NOT_FOUND:
                return None
            if status != 0:
                raise CredentialError(f"the macOS Keychain refused to read ({status})")
            size = self.cf.CFDataGetLength(result)
            if size > MAX_BYTES:
                raise CredentialError("the saved sign-in is too large")
            return self.ct.string_at(self.cf.CFDataGetBytePtr(result), size).decode("utf-8")
        finally:
            self._release(result.value, query, *owned)

    def save(self, account: str, secret: str) -> None:
        raw = secret.encode("utf-8")
        data = self.cf.CFDataCreate(None, raw, len(raw))
        label = self._string(f"{SERVICE}: {account.rsplit('@', 1)[0]}")
        add, owned = self._query(account, (self.k["kSecValueData"], data), (self.k["kSecAttrLabel"], label),
                                 adding=True)
        try:
            status = self.sec.SecItemAdd(add, None)
            if status == self.DUPLICATE:
                query, query_owned = self._query(account)
                update = self._dictionary([(self.k["kSecValueData"], data)])
                try:
                    status = self.sec.SecItemUpdate(query, update)
                finally:
                    self._release(update, query, *query_owned)
            if status != 0:
                raise CredentialError(f"the macOS Keychain refused to save ({status}"
                                      f"{': it is locked' if status == self.INTERACTION_NOT_ALLOWED else ''})")
        finally:
            self._release(add, data, label, *owned)

    def delete(self, account: str) -> bool:
        query, owned = self._query(account)
        try:
            status = self.sec.SecItemDelete(query)
        finally:
            self._release(query, *owned)
        if status not in (0, self.NOT_FOUND):
            raise CredentialError(f"the macOS Keychain refused to delete ({status})")
        return status == 0


# --------------------------------------------------------------------------------- Linux: the desktop keyring

class _SecretTool:
    """The Secret Service (GNOME Keyring, KWallet) through libsecret's ``secret-tool``; the secret goes on stdin."""
    name = "secret-service"

    def __init__(self, program: str):
        self.program = program

    def _run(self, *args, secret: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([self.program, *args], input=secret, capture_output=True, text=True, timeout=15,
                              stdin=None if secret is not None else subprocess.DEVNULL)

    def load(self, account: str) -> str | None:
        result = self._run("lookup", "service", LINUX_SERVICE, "account", account)
        if result.returncode != 0:
            if result.stderr.strip():
                raise CredentialError("the desktop keyring refused to read: " + result.stderr.strip()[:200])
            return None
        return result.stdout if len(result.stdout) <= MAX_BYTES else None

    def save(self, account: str, secret: str) -> None:
        result = self._run("store", f"--label={SERVICE}: {account.rsplit('@', 1)[0]}", "service", LINUX_SERVICE,
                           "account", account,
                           secret=secret)
        if result.returncode != 0:
            raise CredentialError("the desktop keyring refused to save: " + result.stderr.strip()[:200])

    def delete(self, account: str) -> bool:
        existed = self.load(account) is not None
        result = self._run("clear", "service", LINUX_SERVICE, "account", account)
        if result.returncode != 0 and result.stderr.strip():
            raise CredentialError("the desktop keyring refused to delete: " + result.stderr.strip()[:200])
        return existed


def _probe_keyring():
    """The keychain this computer offers DGC, or None. A read that answers (even 'not found') counts."""
    try:
        if sys.platform == "darwin":
            backend = _MacKeychain()
        elif sys.platform.startswith("linux") and shutil.which("secret-tool"):
            backend = _SecretTool(shutil.which("secret-tool"))
        else:
            return None
        backend.load("dgc-probe")
        return backend
    except Exception:                                    # noqa: BLE001 -- no usable keychain is an answer, not an error
        return None


def keyring():
    global _KEYRING
    with _KEYRING_LOCK:
        if _KEYRING is None:
            _KEYRING = _probe_keyring() or False
        return _KEYRING or None


def where() -> str:
    """Where a new sign-in would be kept now: 'macos-keychain', 'secret-service', 'file', or 'none'."""
    if _MODE == "file":
        return "file"
    found = keyring()
    if found is not None:
        return found.name
    return "none" if _MODE == "keyring" else "file"


# ----------------------------------------------------------------------------------------------- the interface

def _decode(text: str | None) -> dict | None:
    if not text:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _newer(first: dict | None, second: dict | None) -> dict | None:
    if first is None or second is None:
        return first or second
    return first if float(first.get("saved_at") or 0) >= float(second.get("saved_at") or 0) else second


def load(name: str) -> dict | None:
    folder(name)
    if _MODE == "file" or (found := keyring()) is None:
        return None if _MODE == "keyring" else _decode(_File().load(name))
    try:
        kept = _decode(found.load(_account(name)))
    except CredentialError:
        if _MODE == "keyring":
            raise
        kept = None                                      # locked or refused right now: the file is the answer
    if _MODE == "keyring":
        return kept
    stray = _decode(_File().load(name))
    if stray is not None and _newer(kept, stray) is stray:
        # A sign-in kept in the file (no keychain then, or a locked one) moves into the keychain once it can.
        with contextlib.suppress(CredentialError, OSError):
            found.save(_account(name), json.dumps(stray, separators=(",", ":")))
            _File().delete(name)
        return stray
    return kept


def save(name: str, value: dict) -> str:
    """Keep one server's sign-in; returns where it went."""
    folder(name)
    secret = json.dumps({**value, "saved_at": time.time()}, separators=(",", ":"))
    if len(secret.encode("utf-8")) > MAX_BYTES:
        raise CredentialError("this sign-in is too large to keep")
    if _MODE != "file":
        found = keyring()
        if found is not None:
            try:
                found.save(_account(name), secret)
                with contextlib.suppress(OSError):
                    _File().delete(name)
                return found.name
            except CredentialError:
                if _MODE == "keyring":
                    raise
        elif _MODE == "keyring":
            raise CredentialError("this computer has no system keychain DGC can use "
                                  "(set plugin_credentials_store to auto or file)")
    _File().save(name, secret)
    return "file"


def delete(name: str) -> bool:
    """Forget one server's sign-in everywhere it might be. True when there was one."""
    folder(name)
    removed = False
    if (found := keyring()) is not None:
        with contextlib.suppress(CredentialError, OSError):
            removed = found.delete(_account(name)) or removed
    with contextlib.suppress(OSError):
        removed = _File().delete(name) or removed
    return removed


@contextlib.contextmanager
def locked(name: str, *, cancelled=None, timeout: float = 300.0):
    """One process at a time refreshes or signs in to a server (several DGC windows and Pips share a sign-in).

    Waits for another process that holds it (it may be waiting on a browser), checking ``cancelled`` as it does."""
    import time
    path = _private_dir(folder(name)) / ".lock"
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            import fcntl
        except ImportError:                              # Windows: DGC runs in WSL there; nothing else shares it
            fcntl = None
        deadline = time.monotonic() + max(0.0, timeout)
        while fcntl is not None:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if (cancelled is not None and cancelled()) or time.monotonic() >= deadline:
                    raise CredentialError("another DGC is still signing in to this server") from None
                time.sleep(0.1)
        yield
    finally:
        os.close(descriptor)
