"""Where mods come from: DGC's own (dgc/mods/builtin), the ones the user installed (~/.dgc/mods/installed/<name>,
copied from a folder, a git address or a plugin), and, for one session, a folder being written (``dgc mods dev``).
An installed copy is what runs, so a mod can't change under the user after it was allowed: an update is installed
again, and asks again if it wants more."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..config import dgc_home
from .manifest import MANIFEST, NAME, Manifest, ManifestError, load

BUILTIN = Path(__file__).resolve().parent / "builtin"
# An installed copy that came with a plugin holds this file, naming the plugin: uninstalling the plugin removes exactly
# the copies still marked as its own. Never copied from a source, so a folder can't claim to be another plugin's.
PLUGIN_MARK = ".dgc-plugin.json"
SKIP = {".git", "__pycache__", ".DS_Store", PLUGIN_MARK}
MAX_MOD_BYTES = 50 * 1024 * 1024
MAX_MOD_FILES = 10_000


def installed_root() -> Path:
    return dgc_home() / "mods" / "installed"


def builtins() -> list[Manifest]:
    out = []
    for folder in sorted(BUILTIN.iterdir()) if BUILTIN.is_dir() else []:
        if (folder / MANIFEST).is_file():
            try:
                out.append(load(folder, builtin=True))
            except ManifestError:
                continue
    return out


def installed() -> list[Manifest]:
    out = []
    root = installed_root()
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if (folder / MANIFEST).is_file():
            try:
                out.append(load(folder))
            except ManifestError:
                continue
    return out


def _folders(extra) -> list[Manifest]:
    """The dev folders' mods that load: one being written may be half-saved for a moment (its manifest names an entry
    not written yet), and it shows again as soon as it loads, rather than taking every other mod's list with it."""
    out = []
    for p in extra:
        try:
            out.append(load(Path(p)))
        except ManifestError:
            continue
    return out


def available(extra: tuple = ()) -> list[Manifest]:
    """Every mod this session may run, one per name: a dev folder first, then installed, then DGC's own."""
    seen, out = set(), []
    for m in [*_folders(extra), *installed(), *builtins()]:
        if m.name not in seen:
            seen.add(m.name)
            out.append(m)
    return out


def find(name: str, extra: tuple = ()) -> Manifest | None:
    return next((m for m in available(extra) if m.name == name), None)


def _size(folder: Path) -> int:
    total = 0
    for p in folder.rglob("*"):
        if set(p.relative_to(folder).parts) & SKIP:
            continue
        if p.is_symlink():
            raise ManifestError("A mod's installed files cannot be symbolic links.")
        if p.is_file():
            total += p.stat().st_size
            if total > MAX_MOD_BYTES:
                break
    return total


def _copy_files(source: Path, target: Path) -> None:
    """Copy a bounded snapshot without following a file or parent swapped to a symlink."""
    from ..workspace import read_regular_bytes
    target.mkdir(mode=0o700)
    total = count = 0
    try:
        for directory, dirs, files in os.walk(source, followlinks=False):
            dirs[:] = [name for name in dirs if name not in SKIP]
            for name in dirs:
                if (Path(directory) / name).is_symlink():
                    raise ManifestError("A mod's installed files cannot be symbolic links.")
            rel = Path(directory).relative_to(source)
            (target / rel).mkdir(parents=True, exist_ok=True, mode=0o700)
            for name in files:
                if name in SKIP:
                    continue
                count += 1
                if count > MAX_MOD_FILES:
                    raise ManifestError("A mod's folder holds at most 10,000 files.")
                original = Path(directory) / name
                mode = original.stat(follow_symlinks=False).st_mode
                raw, _version = read_regular_bytes(original, maximum=MAX_MOD_BYTES - total)
                total += len(raw)
                dest = target / rel / name
                dest.write_bytes(raw)
                os.chmod(dest, 0o700 if mode & 0o111 else 0o600)
    except (OSError, ValueError) as exc:
        raise ManifestError(f"The mod's files could not be safely copied: {exc}") from None


def origin(m: Manifest) -> dict:
    """The plugin an installed mod came with ({plugin, title}), or {} when it came from anywhere else."""
    try:
        if m.builtin or m.folder.parent != installed_root().resolve():
            return {}
        data = json.loads((m.folder / PLUGIN_MARK).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or not isinstance(data.get("plugin"), str) or not data["plugin"]:
        return {}
    return {"plugin": data["plugin"][:64], "title": str(data.get("title") or data["plugin"])[:80]}


def install_folder(source, *, plugin: dict | None = None) -> Manifest:
    """Install (or update) a mod from a folder holding dgc-mod.json: checked, then copied in. ``plugin``
    ({plugin, title}) marks the copy as that plugin's."""
    source = Path(source).expanduser().resolve()
    m = load(source)
    if any(b.name == m.name for b in builtins()):
        raise ManifestError(f"{m.name} is one of DGC's own mods; give yours another name.")
    if _size(source) > MAX_MOD_BYTES:
        raise ManifestError("A mod's folder is at most 50 MB.")
    target = installed_root() / m.name
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = Path(tempfile.mkdtemp(prefix=f".{m.name}-", dir=target.parent))
    previous = staging / "previous"
    published = False
    try:
        _copy_files(source, staging / "mod")
        copied = load(staging / "mod")
        if copied.name != m.name:
            raise ManifestError("The mod's name changed while it was being installed. Try again.")
        if plugin:
            (staging / "mod" / PLUGIN_MARK).write_text(json.dumps({"plugin": plugin["plugin"],
                                                                   "title": plugin.get("title") or plugin["plugin"]}),
                                                       encoding="utf-8")
        from .consent import write_lock
        with write_lock():
            if target.is_symlink():
                raise ManifestError("The installed mod folder cannot be a symbolic link.")
            if target.exists():
                target.rename(previous)
            try:
                (staging / "mod").rename(target)
                published = True
            except BaseException:
                if previous.exists():
                    previous.rename(target)
                raise
    finally:
        # If both promotion and rollback fail, retain the previous copy for recovery.
        if published or not previous.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return load(target)


def install_git(url: str, subdir: str = "") -> Manifest:
    """Install from a git address (https:// or git@), optionally a folder inside it."""
    if not (url.startswith("https://") or url.startswith("git@")):
        raise ManifestError("Give an https:// or git@ address.")
    if (not isinstance(subdir, str) or Path(subdir).is_absolute() or "\\" in subdir
            or ":" in subdir.split("/", 1)[0] or ".." in Path(subdir).parts):
        raise ManifestError("The folder is inside the repository.")
    with tempfile.TemporaryDirectory(prefix="dgc-mod-") as tmp:
        # Never the caller's stdin (under `dgc serve` that is the editor's protocol pipe), and never a password
        # prompt: a private address fails at once rather than waiting on a terminal nobody is at.
        done = subprocess.run(["git", "clone", "--depth", "1", "--", url, tmp + "/repo"], capture_output=True,
                              stdin=subprocess.DEVNULL, text=True, timeout=180,
                              env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if done.returncode != 0:
            # Git's stderr can repeat credentials embedded in a URL. Keep the failure
            # actionable without echoing untrusted remote output into the UI/logs.
            raise ManifestError("The mod repository could not be fetched. Check its address and access.")
        folder = Path(tmp) / "repo" / subdir
        try:
            folder.resolve(strict=True).relative_to((Path(tmp) / "repo").resolve())
        except (OSError, ValueError, RuntimeError):
            raise ManifestError("The folder is inside the repository.") from None
        return install_folder(folder)


def remove(name: str) -> bool:
    """Uninstall an installed mod (DGC's own stay; they can be turned off)."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ManifestError("Give the installed mod's name.")
    from .consent import write_lock
    with write_lock():
        target = installed_root() / name
        if target.is_symlink():
            raise ManifestError("The installed mod folder cannot be a symbolic link.")
        if not (target / MANIFEST).is_file():
            return False
        shutil.rmtree(target)
        return True
