"""Update check for DGC — a non-blocking 'a newer version is out' nudge.

The check never blocks startup and never raises into the app: a detached child process
refreshes a small on-disk cache at most once a day, and the banner reads that cache on the
*next* launch. Both the classic REPL and the full-screen TUI surface `cached_update()`.
"""
from __future__ import annotations

import json
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


def run_update() -> None:
    """`dgc update` — reinstall the latest DGC from vibedgc.com."""
    from rich.console import Console
    c = Console()
    c.print("[bold]DGC update[/bold] — fetching the latest…\n")
    try:
        subprocess.run("curl -fsSL https://vibedgc.com/install.sh | bash",
                       shell=True, check=True, executable="/bin/bash")
    except subprocess.CalledProcessError as e:
        c.print(f"\n[bold red]update failed[/bold red] (exit {e.returncode}). "
                "Run manually: curl -fsSL https://vibedgc.com/install.sh | bash")
        return
    c.print("\n[bold green]updated[/bold green] — start [bold]dgc[/bold] again.")
