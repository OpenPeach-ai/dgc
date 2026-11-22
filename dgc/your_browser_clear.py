"""Clear browsing data in Your Browser (0.52, Pips API 112): what each kind is in a Chrome profile
folder, and clearing it from DGC's OWN profile for Your Browser, with its Chrome stopped.

It only ever removes: it never opens, reads or copies a cookie, a password or a page visited, never touches the person's
own Chrome profile (only <Pips state>/your-browser/profile), and never follows a link. your_browser.YourBrowserHost.clear
stops Chrome first and opens it again; your_browser.clear is the command.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
from pathlib import Path

from .workspace_registry import RegistryError


CLEAR_KINDS = ("history", "sign_ins", "passwords")
# What each kind is in a Chrome profile folder (Default, Profile 1...), as Chrome's own Delete browsing data has it.
# History: the pages visited and the downloads list (both in History), the visited-link colours, the most visited, the
# address bar's shortcuts, its predictions, the sites' icons kept for them, and the recently closed tabs. Sign-ins:
# cookies and site data (each site's storage, databases and service workers): you are signed out of sites. Extensions'
# own storage, bookmarks, settings, autofill and sync's own state are never part of it.
CLEAR_PATHS = {
    "history": ("History", "History-journal", "Visited Links", "Top Sites", "Top Sites-journal", "Shortcuts",
                "Shortcuts-journal", "Network Action Predictor", "Network Action Predictor-journal", "Favicons",
                "Favicons-journal", "Sessions", "Sessions_Encrypted", "History Provider Cache", "Current Session",
                "Current Tabs", "Last Session", "Last Tabs"),
    "sign_ins": ("Cookies", "Cookies-journal", "Network/Cookies", "Network/Cookies-journal", "Local Storage",
                 "Session Storage", "IndexedDB", "Service Worker", "File System", "databases", "WebStorage",
                 "Shared Dictionary", "SharedStorage", "SharedStorage-wal", "Trust Tokens", "Trust Tokens-journal",
                 "Network/Trust Tokens", "Network/Trust Tokens-journal", "blob_storage"),
    "passwords": ("Login Data", "Login Data-journal", "Login Data For Account", "Login Data For Account-journal"),
}
_PROFILE_DIR = re.compile(r"Default|Profile \d{1,4}")


def _clear_one(base: Path, relative: str) -> None:
    """One file or folder inside a profile folder, removed; never through a link (a link itself is removed, never what
    it points at)."""
    *parents, name = relative.split("/")
    path = base
    for part in parents:
        path = path / part
        if path.is_symlink() or not path.is_dir():
            return
    path = path / name
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)                    # (never follows a link inside: each is removed as itself)


def clear_profile(directory, kinds) -> list[str]:
    """Clear ``kinds`` (of CLEAR_KINDS) from DGC's own profile for Your Browser, with its Chrome stopped. Never the
    person's own Chrome profile, never through a link. History also forgets Home's last visited links. Returns the kinds
    cleared, in CLEAR_KINDS' order."""
    from .your_browser import RECENT_FILE, folder
    chosen = [kind for kind in CLEAR_KINDS if kind in set(kinds)]
    root = folder(directory)
    profile = root / "profile"
    if any(part.is_symlink() for part in (Path(directory), root, profile)):
        raise RegistryError("unsafe_state", "Your Browser's profile folder is a link, so nothing was cleared.")
    try:
        if profile.is_dir():
            for entry in sorted(profile.iterdir()):
                if entry.is_symlink() or not entry.is_dir() or not _PROFILE_DIR.fullmatch(entry.name):
                    continue
                for kind in chosen:
                    for relative in CLEAR_PATHS[kind]:
                        _clear_one(entry, relative)
        if "history" in chosen:
            (root / RECENT_FILE).unlink(missing_ok=True)
    except OSError as error:
        raise RegistryError("clear_failed", f"DGC couldn't clear all of it: {error.strerror or error}.") from error
    return chosen


def chrome_account(directory) -> bool:
    """Whether Your Browser's Chrome is signed in to a Google account (its profile's own settings say so). Then, with
    Chrome sync on, the account keeps its own copy of what is cleared here."""
    from .your_browser import folder
    path = folder(directory) / "profile" / "Default" / "Preferences"
    try:
        if path.is_symlink():
            return False
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    accounts = data.get("account_info") if isinstance(data, dict) else None
    return isinstance(accounts, list) and any(isinstance(a, dict) and a.get("email") for a in accounts)


def _profile_in_use(directory) -> bool:
    """Whether a Chrome on this computer still holds DGC's profile (its own lock names a process that is alive)."""
    from .your_browser import folder
    lock = folder(directory) / "profile" / "SingletonLock"
    try:
        said = os.readlink(lock)
    except OSError:
        return False
    host, _, pid = said.rpartition("-")
    if host and host != socket.gethostname():
        return True                            # (another computer's lock on a shared folder: never cleared under it)
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except (PermissionError, ValueError):
        return True
    return True
