"""Other DGC agents working in the same place, and how sure we are they are still there.

DGC is the outlier among coding agents: opencode, Codex and qwen-code each run ONE owner process
that every window talks to, so two of their windows never contend. DGC spawns a `dgc serve` per
window, so two DGCs really can be editing one checkout at the same time -- and neither knew the
other existed.

This is the smallest thing that fixes that: each agent leaves a note saying who and where it is,
and every agent can read the others. No daemon, no port, no protocol change.

The registry is ``~/.dgc/peers/<pid>.json``. NOT ``~/.dgc/agents/`` -- that directory already holds
named agent definitions (``<name>.md``) and must not be mixed with runtime state.

Liveness is deliberately three-valued. A pid alone is not identity: pids are recycled, so a stale
note whose pid now belongs to an unrelated process would otherwise read as a live DGC. On Linux the
process start time settles it exactly. Where it cannot be read, the answer is ``unknown`` and the
caller says so, rather than claiming a peer is live or gone on a guess.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

# A note older than this is not trusted even if its pid still resolves: the process may have been
# stopped in a way that left the file behind. Heartbeats are written far more often than this.
STALE_AFTER_S = 15 * 60.0
MAX_PEERS = 64                       # a listing bound, not a limit on how many may run


def peers_dir() -> Path:
    return Path.home() / ".dgc" / "peers"


def _is_zombie(pid: int) -> bool:
    """A process that has exited but not been reaped still answers kill(pid, 0).

    Its parent has not collected it, so it is in the table and signallable while being, in every
    sense that matters here, gone. Without this a killed DGC reads as a live peer.
    """
    try:
        with open(f"/proc/{int(pid)}/stat", "rb") as handle:
            raw = handle.read()
    except (OSError, ValueError):
        return False
    close = raw.rfind(b")")
    if close == -1:
        return False
    fields = raw[close + 2:].split()
    return bool(fields) and fields[0] == b"Z"


def _proc_start(pid: int) -> str:
    """A stable identity for a running process, so a recycled pid is not mistaken for it.

    Linux: field 22 of /proc/<pid>/stat, the start time in clock ticks. Empty when it cannot be
    read, which is what makes the verdict ``unknown`` rather than a guess.
    """
    try:
        with open(f"/proc/{int(pid)}/stat", "rb") as handle:
            raw = handle.read()
    except (OSError, ValueError):
        return ""
    # The comm field is parenthesised and may itself contain spaces or brackets; split after it.
    close = raw.rfind(b")")
    if close == -1:
        return ""
    fields = raw[close + 2:].split()
    return fields[19].decode("ascii", "replace") if len(fields) > 19 else ""


def _alive(pid: int) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True                  # it exists; it is simply not ours to signal
    except (OSError, ValueError, TypeError):
        return False


def liveness(record: dict, *, now: float | None = None) -> str:
    """``live``, ``gone`` or ``unknown`` for one peer note.

    ``unknown`` is a real answer: it means the note looks current but this platform cannot prove
    the process behind the pid is the one that wrote it.
    """
    if not isinstance(record, dict):
        return "gone"
    pid = record.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return "gone"
    seen = record.get("heartbeat")
    moment = time.time() if now is None else now
    if isinstance(seen, (int, float)) and moment - float(seen) > STALE_AFTER_S:
        return "gone"
    if not _alive(pid) or _is_zombie(pid):
        return "gone"
    recorded = str(record.get("proc_start") or "")
    actual = _proc_start(pid)
    if recorded and actual:
        return "live" if recorded == actual else "gone"   # the pid was recycled
    return "unknown"


def announce(*, kind: str, session: str = "", cwd: str = "", project_root: str = "",
             git_common_dir: str = "", status: str = "idle") -> Path | None:
    """Write (or refresh) this process's note. Returns the path, or None if it could not be left."""
    try:
        directory = peers_dir()
        directory.mkdir(parents=True, exist_ok=True)
        try:
            directory.chmod(0o700)
        except OSError:
            pass
        pid = os.getpid()
        record = {
            "pid": pid,
            "proc_start": _proc_start(pid),
            "kind": str(kind)[:32],
            "session": str(session)[:128],
            "cwd": str(cwd)[:4096],
            "project_root": str(project_root)[:4096],
            "git_common_dir": str(git_common_dir)[:4096],
            "status": str(status)[:32],
            "heartbeat": time.time(),
        }
        path = directory / f"{pid}.json"
        tmp = directory / f".{pid}.json.tmp"
        tmp.write_text(json.dumps(record, ensure_ascii=True), encoding="utf-8")
        try:
            tmp.chmod(0o600)
        except OSError:
            pass
        os.replace(tmp, path)
        return path
    except OSError:
        return None                  # a peer note is a courtesy; never fail a turn over one


def withdraw() -> None:
    """Remove this process's note on a clean exit. A crash leaves it for liveness to judge."""
    try:
        (peers_dir() / f"{os.getpid()}.json").unlink()
    except OSError:
        pass


def _same_place(record: dict, project_root: str, git_common_dir: str) -> bool:
    """Whether a peer is working on the same checkout.

    The git common directory is the reliable test, because it is shared by every worktree of one
    repository -- two worktrees of the same repo genuinely do share history and branches. The
    project root is the fallback when git is not involved.
    """
    if git_common_dir and record.get("git_common_dir"):
        return os.path.normpath(str(record["git_common_dir"])) == os.path.normpath(git_common_dir)
    if project_root and record.get("project_root"):
        return os.path.normpath(str(record["project_root"])) == os.path.normpath(project_root)
    return False


def others(*, project_root: str = "", git_common_dir: str = "", here: bool = True,
           now: float | None = None) -> list[dict]:
    """Every other DGC that left a note, newest first, each with a ``liveness`` verdict.

    ``here`` restricts the answer to peers working on the same checkout, which is the only case
    where two agents can tread on each other.
    """
    mine = os.getpid()
    found: list[dict] = []
    try:
        entries = sorted(peers_dir().glob("*.json"))
    except OSError:
        return []
    for entry in entries[:MAX_PEERS * 4]:
        try:
            record = json.loads(entry.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or record.get("pid") == mine:
            continue
        verdict = liveness(record, now=now)
        if verdict == "gone":
            try:
                entry.unlink()       # tidy as we go; a gone peer's note helps nobody
            except OSError:
                pass
            continue
        if here and not _same_place(record, project_root, git_common_dir):
            continue
        record["liveness"] = verdict
        found.append(record)
    found.sort(key=lambda r: float(r.get("heartbeat") or 0), reverse=True)
    return found[:MAX_PEERS]


def model_line(peers: list[dict]) -> str:
    """One line for the model. Empty when nothing is worth saying.

    Deliberately terse and factual. The model is told what is true and what to do about it; it is
    not asked to speculate about what another agent might be doing.
    """
    if not peers:
        return ""
    live = [p for p in peers if p.get("liveness") == "live"]
    unsure = [p for p in peers if p.get("liveness") == "unknown"]
    if not live and not unsure:
        return ""
    parts = []
    if live:
        parts.append(f"{len(live)} other DGC agent{'s' if len(live) != 1 else ''}")
    if unsure:
        parts.append(f"{len(unsure)} that may still be running")
    return ("<dgc-peers>" + " and ".join(parts) + " are working in this same checkout right now. "
            "Do not revert or 'fix' a change you did not make -- it is probably theirs and probably "
            "deliberate. If their work conflicts with yours, stop and tell the user instead of "
            "choosing for them.</dgc-peers>")


def user_line(peers: list[dict]) -> str:
    """One line for the person. Empty when nothing is worth saying."""
    live = [p for p in peers if p.get("liveness") == "live"]
    unsure = [p for p in peers if p.get("liveness") == "unknown"]
    if not live and not unsure:
        return ""
    def count(n: int) -> str:
        return "1 other DGC" if n == 1 else f"{n} other DGCs"

    if live and not unsure:
        return f"{count(len(live))} {'is' if len(live) == 1 else 'are'} working in this folder."
    if unsure and not live:
        return f"{count(len(unsure))} may still be working in this folder."
    return (f"{count(len(live))} {'is' if len(live) == 1 else 'are'} working in this folder, "
            f"and {len(unsure)} more may be.")
