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
note whose pid now belongs to an unrelated process would otherwise read as a live DGC. The process
start time settles it exactly -- from /proc on Linux, from ``ps`` on macOS, which has no /proc and
where every verdict therefore used to degrade to ``unknown``. Where it cannot be read, the answer
is ``unknown`` and the caller says so, rather than claiming a peer is live or gone on a guess.
"""
from __future__ import annotations

import json
import os
import sys
import subprocess
import time
from pathlib import Path

# A note older than this is not trusted even if its pid still resolves: the process may have been
# stopped in a way that left the file behind. Heartbeats are written far more often than this.
STALE_AFTER_S = 15 * 60.0
MAX_PEERS = 64                       # a listing bound, not a limit on how many may run
# The note is a slow courtesy, but a takeover ask is someone waiting at a keyboard, so one thread
# serves both: it ticks fast and only re-announces every ANNOUNCE_EVERY ticks. Both frontends read
# these from here -- two copies of a number that must agree is how most of this file's bugs began.
TICK_S = 2.0
ANNOUNCE_EVERY = 30                  # 2.0s x 30 = a 60s note refresh


def peers_dir() -> Path:
    return Path.home() / ".dgc" / "peers"


def _procfs() -> bool:
    """Same rule dgc.monitors and dgc.install_layout use, including the override.

    DGC_NO_PROCFS=1 forces the ps path, so a Linux test runs exactly what macOS runs instead of
    trusting a mock of it.
    """
    return os.environ.get("DGC_NO_PROCFS") != "1" and os.path.isdir("/proc")


def _ps_field(pid: int, field: str) -> str:
    """One `ps -o <field>=` value for pid; "" when ps cannot answer.

    stdin=DEVNULL, never inherited: under `dgc serve` this process's stdin is the editor protocol
    pipe, and a child that inherits it can steal protocol frames.
    """
    try:
        out = subprocess.run(["ps", "-o", f"{field}=", "-p", str(int(pid))],
                             stdin=subprocess.DEVNULL, capture_output=True, text=True,
                             timeout=5, env=dict(os.environ, LC_ALL="C"))
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""
    return " ".join(out.stdout.split()) if out.returncode == 0 else ""


def _is_zombie(pid: int) -> bool:
    """A process that has exited but not been reaped still answers kill(pid, 0).

    Its parent has not collected it, so it is in the table and signallable while being, in every
    sense that matters here, gone. Without this a killed DGC reads as a live peer.
    """
    if not _procfs():
        # `ps -o stat=` reports Z for a zombie; anything else, including an empty answer for a pid
        # that has gone entirely, is not one.
        return _ps_field(pid, "stat").startswith("Z")
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

    Linux: field 22 of /proc/<pid>/stat, the start time in clock ticks. macOS has no /proc, so it
    asks ps for the start time instead -- without it, every verdict on a Mac degraded to
    ``unknown``, and a peer's note could never be told apart from a recycled pid's. Empty when it
    cannot be read on either, which is what makes the verdict ``unknown`` rather than a guess.
    """
    if not _procfs():
        return _ps_field(pid, "lstart")
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
             git_common_dir: str = "", status: str = "idle",
             takeover: bool = False) -> Path | None:
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
            # Whether this build answers a takeover ask at all. A note from an older DGC simply
            # lacks the key, so an asker skips it and says so, instead of waiting on a reply that
            # is never coming.
            "takeover": bool(takeover),
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


# ---------------------------------------------------------------- takeover ---
# A refusal with no way out is the whole reason this exists: a window whose editor closed mid-turn
# holds the session lease forever, because the watchdog that would end an abandoned backend counts
# "a turn is running" as work worth staying alive for. The registry already knows who is holding
# it, so the asker can name the holder instead of saying "some other window" -- and, when the
# holder is one of ours whose editor has plainly gone, ask it to stand down.
#
# The holder decides. Nothing here forces a lock away, signals a process, or deletes a lease: a
# wrong takeover costs a running turn's work, and the 15-minute self-heal is always the fallback.
RELEASE_ANSWER_WAIT_S = 6.0          # how long an asker waits for a holder to answer
RELEASE_REQUEST_FRESH_S = 30.0       # a request older than this is ignored, not answered


def _same_session(record: dict, session: str) -> bool:
    if not session or not record.get("session"):
        return False
    return os.path.normpath(str(record["session"])) == os.path.normpath(session)


def session_holder(session: str, *, now: float | None = None) -> dict | None:
    """The peer note claiming this saved session, or None.

    Checkout-blind on purpose: a session path identifies a session wherever it is opened from, and
    the holder we need to name may be a terminal in a different directory.
    """
    if not session:
        return None
    for record in others(here=False, now=now):
        if _same_session(record, session):
            return record
    return None


def describe_holder(record: dict) -> str:
    """Name the holder for a person: who, where, and what it appears to be doing."""
    pid = record.get("pid")
    kind = str(record.get("kind") or "")
    where = str(record.get("cwd") or record.get("project_root") or "")
    what = {"serve": "a DGC editor window", "tui": "a DGC running in a terminal"}.get(
        kind, "another DGC")
    line = f"{what} (pid {pid}"
    if where:
        line += f", {where}"
    line += ")"
    if record.get("liveness") == "unknown":
        return line + ", which may or may not still be running"
    if str(record.get("status") or "") == "working":
        return line + ", which is running a turn"
    return line


def takeover_dir() -> Path:
    """A SUBDIRECTORY, not a sibling of the notes.

    ``others`` treats every ``*.json`` in the peers directory as a peer note and unlinks the ones
    it judges gone -- a takeover file left beside them has no ``pid`` field and would be deleted
    out from under the exchange by any peer that happened to list at that moment.
    """
    return peers_dir() / "takeover"


def _release_path(pid: int, suffix: str) -> Path:
    return takeover_dir() / f"{int(pid)}.{suffix}.json"


def request_release(record: dict, session: str) -> bool:
    """Ask the peer in ``record`` to give this session up. True when the ask was left."""
    pid = record.get("pid")
    if not isinstance(pid, int) or pid <= 0 or not _same_session(record, session):
        return False
    try:
        directory = takeover_dir()
        directory.mkdir(parents=True, exist_ok=True)
        payload = {"session": str(session)[:4096], "asker": os.getpid(),
                   "holder": pid, "at": time.time()}
        path = _release_path(pid, "ask")
        tmp = directory / f".{pid}.ask.tmp"
        tmp.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
        try:
            tmp.chmod(0o600)
        except OSError:
            pass
        _forget_release(pid, "ans")      # never read the previous round's answer as this one's
        os.replace(tmp, path)
        return True
    except OSError:
        return False


def pending_release(session: str, *, now: float | None = None) -> dict | None:
    """For a holder: a fresh, well-formed ask naming THIS process and THIS session.

    Stale asks are ignored rather than answered: the asker has long since given up, and answering
    would mean standing down for a window that is no longer waiting.
    """
    try:
        raw = _release_path(os.getpid(), "ask").read_text(encoding="utf-8")
        ask = json.loads(raw)
    except (OSError, ValueError):
        return None
    if not isinstance(ask, dict) or ask.get("holder") != os.getpid():
        return None
    if not _same_session({"session": ask.get("session")}, session):
        return None
    moment = time.time() if now is None else now
    at = ask.get("at")
    if not isinstance(at, (int, float)) or moment - float(at) > RELEASE_REQUEST_FRESH_S:
        _forget_release(os.getpid(), "ask")
        return None
    return ask


def answer_release(*, granted: bool, reason: str = "") -> None:
    """For a holder: say yes or no to the ask, and consume it either way."""
    pid = os.getpid()
    try:
        payload = {"holder": pid, "granted": bool(granted),
                   "reason": str(reason)[:400], "at": time.time()}
        directory = takeover_dir()
        directory.mkdir(parents=True, exist_ok=True)
        tmp = directory / f".{pid}.ans.tmp"
        tmp.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
        try:
            tmp.chmod(0o600)
        except OSError:
            pass
        os.replace(tmp, _release_path(pid, "ans"))
    except OSError:
        pass
    _forget_release(pid, "ask")


def release_answer(pid: int) -> dict | None:
    """For an asker: the holder's reply, or None while it has not answered."""
    try:
        answer = json.loads(_release_path(pid, "ans").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return answer if isinstance(answer, dict) and answer.get("holder") == pid else None


def _forget_release(pid: int, suffix: str) -> None:
    try:
        _release_path(pid, suffix).unlink()
    except OSError:
        pass


def forget_release(pid: int) -> None:
    """Tidy both sides of one exchange. Safe to call when neither file exists."""
    _forget_release(pid, "ask")
    _forget_release(pid, "ans")
