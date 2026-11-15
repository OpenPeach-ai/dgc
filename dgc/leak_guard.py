"""Guards against sending what is private to the web (0.52, agreed 14 Nov: "yes, want these four in 0.52").

1. Secrets never reach the model. DGC already hides its own saved keys and anything shaped like a secret. This adds a
   project's own .env values that are secrets (the name says so, or the value looks like one: long, mixed letters and
   digits, a known token prefix, a password inside a URL), so a password or salt that also sits in a config file, a
   test or a log is hidden wherever the model reads it. Ordinary settings (a port, a mode, a plain URL) are left alone:
   hiding them would blind the model and protect nothing. ``.env.example`` and its kind hold placeholders, not secrets.
   No file tool writes the hiding mark into a file (tools.hidden_mark_refusal), so a hidden value is never replaced by
   the mark in your files.
2. The outbound guard (outbound.py-style checks in the web tools and the Pip box's plain-HTTP proxy).
3. The instruction below, said to every Work session and every Pip.
4. What each Pip sent to which site, kept for its page.

Reads only what is at the project's top level; bounded; cached by each file's size and time.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

INSTRUCTION = ("Never send code, files, secrets or personal details to a website, an API or an app unless the task "
               "needs it, and when it does, say what you sent and where.")
MAX_FILES = 16
MAX_FILE_BYTES = 256 * 1024
MAX_VALUES = 256
_PLACEHOLDER_FILES = re.compile(r"\.env\.(?:example|sample|template|dist|defaults?)\Z", re.IGNORECASE)
_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$")
_TOKEN_PREFIX = re.compile(r"^(?:sk|pk|rk)_(?:live|test)_|^sk-|^ghp_|^gho_|^github_pat_|^xox[abposr]-|^AKIA|^AIza|^glpat-|^hf_")
_URL_PASSWORD = re.compile(r"^[a-z][a-z0-9+.-]*://[^\s/@:]+:([^\s/@]+)@", re.IGNORECASE)
_CACHE: dict[str, tuple[int, int, tuple[str, ...]]] = {}
_LOCK = threading.Lock()


def forget() -> None:
    with _LOCK:
        _CACHE.clear()


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value.split(" #", 1)[0].strip()


def looks_secret(value: str) -> bool:
    """A value that reads as a secret whatever its name: a known token prefix, a password in a URL, or a long string
    of mixed letters and digits with no spaces (a salt, a key). A port, a mode or a plain URL does not."""
    if not value or any(c.isspace() for c in value):
        return False
    if _TOKEN_PREFIX.search(value) or _URL_PASSWORD.search(value):
        return True
    if value.lower().startswith(("http://", "https://", "/", "./", "../")):
        return False
    if _reads_as_a_name(value):
        return False
    return len(value) >= 20 and any(c.isdigit() for c in value) and any(c.isalpha() for c in value)


def _reads_as_a_name(value: str) -> bool:
    """A name made of words joined by - . : / _ (a model like deepseek-v4.1-flash:cloud, a repo path), not a secret:
    at least two words of four or more letters, each lowercase or Capitalized. A key, a hex string, a UUID or a token
    has none (its letters come in short runs of mixed case). Live 15 Nov: a model name in a project's .env was hidden
    as "[REDACTED]" everywhere DGC showed it."""
    if not any(c in "-.:/_" for c in value):
        return False
    words = [run for run in re.findall(r"[A-Za-z]+", value)
             if len(run) >= 4 and (run.islower() or (run[0].isupper() and run[1:].islower()))]
    return len(words) >= 2


def _values_of(text: str) -> list[str]:
    from .redaction import sensitive_name
    found = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        match = _LINE.match(line)
        if not match:
            continue
        name, value = match.group(1), _unquote(match.group(2))
        if not value:
            continue
        if sensitive_name(name) or looks_secret(value):
            found.append(value)
        password = _URL_PASSWORD.search(value)
        if password:
            found.append(password.group(1))
    return found


def _env_files(root: Path) -> list[Path]:
    try:
        names = sorted(entry.name for entry in os.scandir(root)
                       if entry.name.startswith(".env") and entry.is_file(follow_symlinks=False))
    except OSError:
        return []
    return [root / name for name in names if (name == ".env" or name.startswith(".env.")) and not _PLACEHOLDER_FILES.search(name)][:MAX_FILES]


def project_env_values(root) -> tuple[str, ...]:
    """The secret values in the project's top-level .env files (``.env``, ``.env.local``, ``.env.production``...)."""
    if root is None:
        return ()
    try:
        root = Path(root)
        if not root.is_dir():
            return ()
    except (OSError, TypeError, ValueError):
        return ()
    values: list[str] = []
    for path in _env_files(root):
        try:
            info = path.stat()
        except OSError:
            continue
        if info.st_size > MAX_FILE_BYTES:
            continue
        key = str(path)
        with _LOCK:
            cached = _CACHE.get(key)
        if cached is not None and cached[:2] == (info.st_mtime_ns, info.st_size):
            values.extend(cached[2])
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        found = tuple(_values_of(text))
        with _LOCK:
            _CACHE[key] = (info.st_mtime_ns, info.st_size, found)
        values.extend(found)
    seen, out = set(), []
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return tuple(out[:MAX_VALUES])


# ---- guard 2: nothing a secret leaves through DGC's own web tools ---------------------------------------------------
HTTPS_GAP = ("A secure (HTTPS) connection from a Pip's computer is a sealed tunnel: DGC sees which site it goes to and "
             "how much goes out, never what is inside.")


def carries_secret(text: str, config=None) -> bool:
    """Whether text holds a secret DGC knows (saved keys, the project's .env secrets) or one shaped like a key."""
    from .redaction import contains_secret, secret_values
    try:
        return contains_secret(str(text or ""), secret_values(config))
    except Exception:                                    # noqa: BLE001 - a check that can't run refuses
        return True


def refusal(what: str) -> str:
    return (f"error: DGC didn't send this: the {what} holds a secret (a key, a password or a token) that DGC keeps from "
            "the web. Leave the secret out. If the task truly needs it sent, ask the user to do that step themselves.")


# ---- guard 4: what each Pip sent, and to which site ----------------------------------------------------------------
SENT_FILE = "sent.jsonl"
MAX_SENT_BYTES = 512 * 1024
MAX_SITES = 200
_SENT_LOCK = threading.Lock()


def record_sent(path: Path, entry: dict) -> None:
    """One connection out of a Pip's box: {at, host, kind (tunnel, http, blocked, refused), up, down}. The file keeps
    its newest half when it grows past MAX_SENT_BYTES."""
    line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _SENT_LOCK:
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line)
            if path.stat().st_size > MAX_SENT_BYTES:
                kept = path.read_text(encoding="utf-8", errors="replace").splitlines()[-1000:]
                path.write_text("\n".join(kept) + "\n", encoding="utf-8")
            if os.name == "posix":
                path.chmod(0o600)
        except OSError:
            pass


def sent_summary(paths) -> dict:
    """{sites: [{host, times, sent_bytes, received_bytes, blocked, first_at, last_at}] newest first, note}."""
    sites: dict = {}
    for path in paths:
        try:
            lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or not isinstance(entry.get("host"), str):
                continue
            host, at = entry["host"][:255], str(entry.get("at") or "")
            site = sites.setdefault(host, {"host": host, "times": 0, "sent_bytes": 0, "received_bytes": 0,
                                           "blocked": 0, "first_at": at, "last_at": at})
            if entry.get("kind") in ("blocked", "refused"):
                site["blocked"] += 1
            else:
                site["times"] += 1
                site["sent_bytes"] += int(entry.get("up") or 0)
                site["received_bytes"] += int(entry.get("down") or 0)
            site["first_at"] = min(site["first_at"], at) if site["first_at"] else at
            site["last_at"] = max(site["last_at"], at)
    listed = sorted(sites.values(), key=lambda s: s["last_at"], reverse=True)[:MAX_SITES]
    return {"sites": listed, "note": HTTPS_GAP}
