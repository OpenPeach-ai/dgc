"""Whether the Node.js that DGC's parts run on is up to date (dgc doctor; 0.52, the user's call, 9 Nov).

DGC itself never runs on Node. Claude Code and Codex installed with npm, MCP servers started with `npx`, and the
TypeScript SDK run on the user's own Node, so `dgc doctor` names each Node it finds and says plainly when one is behind
Node's latest security release for its line, or past end of life, with the one command that updates it.

Nothing here goes online: the table below is DGC's own, refreshed with every DGC release (docs/RELEASING.md).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

# The latest security release of each Node line that is still supported, and when it shipped. Refresh each release.
SECURITY_RELEASES = {22: "22.23.4", 24: "24.22.1", 26: "26.12.1"}
AS_OF = "21 Oct 2026"
# The oldest line Node still supports. An odd line is supported only until the next even one is out for a while, so
# an odd line older than the newest one in the table above is past end of life; a newer one is Node's current line.
OLDEST_SUPPORTED = 22

_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


@dataclass(frozen=True)
class NodeFinding:
    path: str
    version: str          # "22.22.2", or "" when it didn't answer
    state: str            # "ok", "behind", "end_of_life", "unknown"
    words: str            # what doctor says about it, after its version: "22.22.2 is behind ..."
    fix: str              # the one command that updates it, or ""


def _parts(version: str) -> tuple[int, int, int] | None:
    match = _VERSION.match(version.strip())
    return tuple(int(x) for x in match.groups()) if match else None


def assess(version: str, path: str = "") -> NodeFinding:
    """One Node, by its `node --version`."""
    parts = _parts(version)
    fix = update_command(path, parts[0] if parts else None)
    if parts is None:
        return NodeFinding(path, "", "unknown", "didn't say its version", "")
    shown = ".".join(str(x) for x in parts)
    line = parts[0]
    if line < OLDEST_SUPPORTED or (line % 2 and line < max(SECURITY_RELEASES)):
        return NodeFinding(path, shown, "end_of_life", f"is past end of life: Node {line} gets no security fixes", fix)
    latest = SECURITY_RELEASES.get(line)
    if latest is None:
        return NodeFinding(path, shown, "ok", "is newer than the security releases this DGC knows", "")
    if parts < _parts(latest):
        return NodeFinding(path, shown, "behind", f"is behind Node's security release of {AS_OF} ({latest})", fix)
    return NodeFinding(path, shown, "ok", f"is up to date with Node's security release of {AS_OF}", "")


_CELLAR = re.compile(r"/Cellar/(node(?:@\d+)?)/")


def update_command(path: str, line: int | None) -> str:
    """The one command that updates it, from whatever installed it (the path is resolved, so it names the installer):
    its own line's latest release, or the newest line when its own is past end of life."""
    target = line if line in SECURITY_RELEASES else max(SECURITY_RELEASES)
    where = path.replace("\\", "/")
    if "/.nvm/" in where:
        return f"nvm install {target}"
    if "/fnm/" in where:
        return f"fnm install {target}"
    if "/.volta/" in where:
        return f"volta install node@{target}"
    if "/mise/installs/" in where:
        return f"mise use -g node@{target}"
    cellar = _CELLAR.search(where)
    if cellar or "/opt/homebrew/" in where or "/linuxbrew/" in where:
        if target != line:
            return f"brew install node@{target}"
        return f"brew upgrade {cellar.group(1) if cellar else f'node@{target}'}"
    return f"install Node {target} from nodejs.org (or your package manager)"


def _version_of(node: str) -> str:
    try:
        done = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5,
                              stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def nodes() -> list[str]:
    """The Node binaries DGC's parts would run on: the one on PATH, and the one beside Claude Code or Codex when either
    was installed with npm (its `#!/usr/bin/env node` finds the node in its own bin folder first)."""
    found: list[str] = []

    def keep(path) -> None:
        if not path:
            return
        try:
            real = str(Path(path).resolve(strict=True))
        except (OSError, RuntimeError):
            return
        if real not in found and os.access(real, os.X_OK):
            found.append(real)

    keep(shutil.which("node"))
    for cli in ("codex", "claude"):
        where = shutil.which(cli)
        if where:
            beside = Path(where).parent / ("node.exe" if os.name == "nt" else "node")
            if beside.exists():
                keep(str(beside))
    return found


def report() -> list[NodeFinding]:
    return [assess(_version_of(node), node) for node in nodes()]


def shown(path: str) -> str:
    """A path as doctor prints it: the home folder as ~."""
    home = str(Path.home())
    return "~" + path[len(home):] if home and (path == home or path.startswith(home + os.sep)) else path
