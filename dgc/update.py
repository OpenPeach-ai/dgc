"""Update check for DGC — a non-blocking 'a newer version is out' nudge.

The check never blocks startup and never raises into the app: a detached child process
refreshes a small on-disk cache at most once a day, and the banner reads that cache on the
*next* launch. Both the classic REPL and the full-screen TUI surface `cached_update()`.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

from . import __version__
from .config import USER_HOME

VERSION_URL = "https://vibedgc.com/version.json"
UPDATE_CACHE = USER_HOME / "update-check.json"


def _ver_tuple(s: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", s or "")[:3]) or (0,)


def cached_update() -> str | None:
    """Latest version from the local cache if it's newer than us — non-blocking, never raises."""
    try:
        latest = str(json.loads(UPDATE_CACHE.read_text()).get("latest", ""))
        if latest and _ver_tuple(latest) > _ver_tuple(__version__):
            return latest
    except Exception:
        pass
    return None


def refresh_update_async() -> None:
    """Refresh the cached 'latest version' at most once a day, in a DETACHED subprocess.

    Not a daemon thread: a background thread doing TLS I/O can SIGSEGV the interpreter
    during shutdown (Python tears down the thread while it's inside a C ssl call), which
    made `dgc -p` exit with a signal ~1/3 of the time. A detached child process can never
    block startup, raise into us, or crash us on exit. The banner reads the cache this
    writes on the *next* launch, so there's nothing to wait for now.
    """
    try:  # daily gate in the parent — usually we don't spawn anything at all
        if time.time() - float(json.loads(UPDATE_CACHE.read_text()).get("checked", 0)) < 86400:
            return
    except Exception:
        pass
    snippet = (
        "import json,time,urllib.request\n"
        "try:\n"
        # a real User-Agent is required — Cloudflare 403s the default 'Python-urllib' UA,
        # which silently broke the update nudge (the fetch failed, the cache went stale).
        f"  req=urllib.request.Request({VERSION_URL!r},headers={{'User-Agent':'dgc-update-check'}})\n"
        f"  d=json.loads(urllib.request.urlopen(req,timeout=4).read().decode())\n"
        f"  open({str(UPDATE_CACHE)!r},'w').write("
        "json.dumps({'latest':str(d.get('version','')),'checked':time.time()}))\n"
        "except Exception: pass\n"
    )
    try:
        UPDATE_CACHE.parent.mkdir(parents=True, exist_ok=True)
        subprocess.Popen(
            [sys.executable, "-c", snippet],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            start_new_session=True)
    except Exception:
        pass


UPDATE_USAGE = "dgc update [--rollback | --version X | --list]"
#: Exit codes shared with install.sh: 0 installed or already current, 1 failed with the previous
#: version still active, 2 bad arguments, 3 another update holds the lock.
EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_LOCKED = 0, 1, 2, 3


def _base_url() -> str:
    return (os.environ.get("DGC_BASE_URL") or "https://vibedgc.com").rstrip("/")


def _parse_update_args(args: list[str]) -> tuple[str, str | None] | None:
    if not args:
        return ("install", None)
    if args == ["--rollback"]:
        return ("rollback", None)
    if args == ["--list"]:
        return ("list", None)
    if len(args) == 2 and args[0] == "--version":
        return ("version", args[1])
    if len(args) == 1 and args[0].startswith("--version="):
        return ("version", args[0].split("=", 1)[1])
    return None


def _download_installer(url: str, destination: str) -> None:
    """Fetch install.sh to a file. Piping curl into bash reported success when the download
    failed (bash read an empty script and exited 0); a file either arrives whole or not at all."""
    import urllib.request
    request = urllib.request.Request(url, headers={"User-Agent": "dgc-update"})
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise OSError("the installer is larger than 1 MiB")
    if not body.startswith(b"#!"):
        raise OSError("the downloaded file is not a shell script")
    with open(destination, "wb") as handle:
        handle.write(body)


def _list_versions(c, location) -> int:
    from rich.markup import escape
    from . import install_layout as L
    versions = L.installed_versions(location.data_dir)
    launcher = L.inspect_launcher(location.bin_dir / "dgc")
    active = (launcher.tree.name if launcher.kind == "managed" and launcher.tree is not None
              and launcher.tree.parent == L.versions_dir(location.data_dir) else None)
    if not versions:
        c.print(f"no versioned DGC installs in {L.versions_dir(location.data_dir)}", highlight=False, markup=False,
                soft_wrap=True)
        return EXIT_OK
    c.print(f"DGC versions in {L.versions_dir(location.data_dir)}:", highlight=False, markup=False,
            soft_wrap=True)
    for name in versions:
        notes = []
        if name == active:
            notes.append(f"active → {launcher.path}")
        if name == location.version:
            notes.append("this process")
        others = [pid for pid in L.live_pids(location.data_dir, name) if pid != os.getpid()]
        if others:
            notes.append("running (pid " + ", ".join(map(str, others)) + ")")
        mark = "*" if name == active else " "
        c.print(f"  {mark} {name}" + (f"   {'; '.join(notes)}" if notes else ""), highlight=False,
                markup=False, soft_wrap=True)
    return EXIT_OK


def _switch_to(c, location, version: str | None) -> int:
    """--rollback (version None) or --version X for a version already built here. Offline: no
    download is needed to switch between complete versions."""
    from rich.markup import escape
    from . import install_layout as L
    fd = L.acquire_update_lock(location.data_dir)
    if fd is None:
        holder = L.update_lock_holder(location.data_dir)
        c.print("[bold red]another DGC update is running[/bold red]"
                + (f" (pid {holder})" if holder else "") + " — try again when it finishes.",
                highlight=False)
        return EXIT_LOCKED
    try:
        launcher = L.inspect_launcher(location.bin_dir / "dgc")
        current = (launcher.tree.name if launcher.kind == "managed" and launcher.tree is not None
                   else None)
        if version is None:
            if current is None:
                c.print(f"[bold red]nothing to roll back:[/bold red] {escape(str(launcher.path))} does not run a "
                        f"versioned install in {escape(str(L.versions_dir(location.data_dir)))}", highlight=False)
                return EXIT_FAILED
            kept = L.installed_versions(location.data_dir)
            record = L.read_record()
            previous = record.get("previous_version")
            if (record.get("version") == current and previous and previous != current
                    and previous in kept):
                # The version that was active before the last switch, older or newer: after
                # `--version 0.38.7` from 0.39.1, rollback returns to 0.39.1.
                version = previous
            else:
                older = [name for name in kept if L.version_key(name) < L.version_key(current)]
                if not older:
                    c.print(f"[bold red]nothing to roll back to:[/bold red] no previous version is "
                            f"recorded and none older than {current} is kept in "
                            f"{escape(str(L.versions_dir(location.data_dir)))}", highlight=False,
                            soft_wrap=True)
                    return EXIT_FAILED
                version = older[0]
        elif current == version:
            c.print(f"DGC {version} is already active → {launcher.path}", highlight=False, markup=False)
            return EXIT_OK
        lines: list[str] = []
        code = L.activate(location.data_dir, location.bin_dir, version,
                          force=os.environ.get("DGC_FORCE_OVERWRITE") == "1",
                          retention=False, out=lines.append)
        for line in lines:
            c.print(line, highlight=False, markup=False)
        if code != 0:
            return EXIT_FAILED
        c.print(f"[bold green]switched[/bold green] {escape(str(launcher.path))} → DGC {version}"
                + (f" (was {current})" if current else "") + " — start [bold]dgc[/bold] again.",
                highlight=False)
        return EXIT_OK
    finally:
        L.release_update_lock(fd)


def run_update(args: list[str] | None = None) -> int:
    """`dgc update` — install the latest release beside the current one, or switch versions.

    Returns a process exit code; every failure is non-zero (0 updated/already current, 1 failed
    with the previous version still active, 2 usage, 3 another update is running)."""
    import tempfile
    from rich.console import Console
    from rich.markup import escape
    from . import install_layout as L
    # Soft wrap for every message: they name launchers and version directories, and Rich's hard
    # wrap at the terminal width split those paths across lines where nobody can copy them.
    c = Console(soft_wrap=True)
    parsed = _parse_update_args(list(args or []))
    if parsed is None:
        c.print("usage: " + UPDATE_USAGE, highlight=False)
        return EXIT_USAGE
    action, requested = parsed
    location = L.locate()
    force = os.environ.get("DGC_FORCE_OVERWRITE") == "1"
    if action == "list":                 # read-only: listing changes nothing, even from a checkout
        return _list_versions(c, location)
    if location.kind == "checkout" and not force:
        c.print(f"[bold red]this dgc runs from {escape(str(location.tree))}, a git checkout[/bold red] — "
                "`dgc update` will not repoint it at a release.\n"
                "  Update the checkout with git, or install a release elsewhere:\n"
                f"    curl -fsSL {escape(_base_url())}/install.sh | DGC_DATA_DIR=$HOME/.local/share/dgc "
                "DGC_BIN=$HOME/.dgc-release/bin bash\n"
                "  Or repoint the launcher anyway: DGC_FORCE_OVERWRITE=1 dgc update",
                highlight=False, markup=True, soft_wrap=True)
        return EXIT_FAILED
    if action == "rollback":
        return _switch_to(c, location, None)
    if action == "version":
        if not L.valid_version(requested or ""):
            c.print(f"{requested!r} is not a DGC version number", highlight=False, markup=False)
            return EXIT_USAGE
        if requested in L.installed_versions(location.data_dir):
            return _switch_to(c, location, requested)

    url = _base_url() + "/install.sh"
    c.print(f"[bold]DGC update[/bold] — installing into {escape(str(location.data_dir))}/versions, "
            f"launcher {escape(str(location.bin_dir))}/dgc\n", highlight=False, soft_wrap=True)
    env = dict(os.environ)
    # Say exactly where: the installer's defaults are not necessarily where THIS dgc lives.
    env["DGC_DATA_DIR"] = str(location.data_dir)
    env["DGC_BIN"] = str(location.bin_dir)
    env.pop("DGC_DIR", None)
    if action == "version":
        env["DGC_INSTALL_VERSION"] = str(requested)
    launcher = location.bin_dir / "dgc"
    before = os.path.realpath(launcher) if os.path.lexists(launcher) else None
    with tempfile.TemporaryDirectory(prefix="dgc-update-") as scratch:
        script = os.path.join(scratch, "install.sh")
        try:
            _download_installer(url, script)
        except Exception as exc:  # urllib raises several unrelated types; all mean "no installer"
            c.print(f"[bold red]update failed[/bold red] — could not download {escape(url)}: {escape(str(exc))}\n"
                    "Nothing was changed.", highlight=False)
            return EXIT_FAILED
        try:
            code = subprocess.run(["bash", script], env=env).returncode
        except KeyboardInterrupt:
            # The installer removes its unfinished build on the way out; the launcher only ever
            # switches to a complete one.
            c.print("\n[bold red]update interrupted[/bold red] — the previous version is still active.")
            return 130
        except OSError as exc:
            c.print(f"[bold red]update failed[/bold red] — could not run bash: {escape(str(exc))}", highlight=False)
            return EXIT_FAILED
    after = os.path.realpath(launcher) if os.path.lexists(launcher) else None
    if code == 0:
        if after == before:
            c.print("\n[bold green]DGC is up to date[/bold green] — nothing to restart.")
        else:
            c.print("\n[bold green]updated[/bold green] — start [bold]dgc[/bold] again.")
        return EXIT_OK
    if code == EXIT_LOCKED:
        c.print("\n[bold red]another DGC update is running[/bold red] — try again when it finishes.")
        return EXIT_LOCKED
    if after != before:
        # The switch happened and a later step (the editor extension) failed.
        c.print(f"\n[bold red]update incomplete[/bold red] (installer exit {code}): the new DGC is "
                "installed, but a step after the switch failed — see above.")
    else:
        c.print(f"\n[bold red]update failed[/bold red] (installer exit {code}). "
                "The previous version is still active.")
    return EXIT_FAILED
