"""Ask DGC to fix: what a Pip reported, fixed in the background of the chat it reported to.

The founder's decisions (18-19 Oct): a Pip's report reaches its chat as a card, never a turn; its
**Ask DGC to fix** starts a BACKGROUND sub-agent in that chat's session, so there is no main turn
and the user keeps chatting. The card is the fix's live status (what it is doing, Watch, Stop); a
question or a permission it needs is asked on the card. When it finishes, its changes are APPLIED,
as any sub-agent's are, holding back a file the user changed on the same lines meanwhile; the card
says what changed, whether tests ran in the fix copy, and offers Review and Undo.

**The fix copy.** One kept copy per project (dgc/worktree.py KeptTaskWorkspace), the same copy,
delta and integration as a background helper's, synced to the project (HEAD and the uncommitted
changes) before each fix. What the project ignores stays in it: dependencies are installed once
with the project's own install command (``npm ci``, ``uv sync``...) and again only when a lock file
changes; a Git-ignored file a test needs (a ``.env``) is asked for when a test needs it -- never up
front -- COPIED, never linked, and copied again before each later fix of that project. Fixes run
one at a time per project; another click waits its turn. A copy unused for 14 days is removed; its
size is shown only by ``dgc doctor``.

**Undo.** Every file the fix writes is recorded first (its exact bytes, mode, or absence). Undo puts
a file back only while it still holds exactly what the fix left; a file changed since is kept, and
the card says which.

Everything lives under ``~/.dgc/fix-copies/<project>/``: the copy, ``project.json`` (when it was last
used, what was installed, the files the user allowed), ``fixes.json`` (this project's fixes, newest
kept) and ``undo/<fix id>/``.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

ACTIVE = ("queued", "preparing", "running", "applying")
# applied: everything landed. partial: some held back (the user changed the same lines). unchanged:
# nothing to change. not_applied: every change held back. failed / stopped / interrupted: nothing
# in the project was changed. undone: Undo put the files back.
ENDED = ("applied", "partial", "unchanged", "not_applied", "failed", "stopped", "interrupted", "undone")
STATES = ACTIVE + ENDED
TESTS = ("passed", "failed", "not_run")
FIX_ID = re.compile(r"fix_[0-9a-f]{32}\Z")
RUN_ID = re.compile(r"run_[0-9a-f]{32}\Z")
KEEP_UNUSED_S = 14 * 24 * 3600          # a copy nobody used for 14 days is removed
STALE_S = 12 * 3600                     # a fix another process has not touched for this long is gone (pid reuse)
MAX_RECORDS = 40                        # fixes kept per project, newest first
MAX_FILES_SHOWN = 50                    # files a record lists
MAX_REMEMBERED = 16                     # ignored files a project's copy gets
MAX_REMEMBERED_BYTES = 256 * 1024       # a .env, not a database
MAX_UNDO_BYTES = 64 * 1024 * 1024
INSTALL_TIMEOUT_S = 15 * 60
MAX_SUMMARY = 400
_TOKEN = uuid.uuid4().hex               # this process: a record it owns that it is not running died
_STORE_GUARD = threading.RLock()
_QUEUES: dict[str, list[str]] = {}      # project key -> fix ids, first in line first
_QUEUE_NAMES: dict[str, str] = {}       # fix id -> its Pip's name, to say what a queued fix waits for
_QUEUE_COND = threading.Condition()

# The project's own install command, by lock file, in this order. Each runs where its lock file is,
# once, and again only when that lock file changes. A tool that is not installed is skipped.
INSTALLERS = (
    ("pnpm-lock.yaml", ("pnpm", "install", "--frozen-lockfile")),
    ("yarn.lock", ("yarn", "install", "--frozen-lockfile")),
    ("bun.lock", ("bun", "install", "--frozen-lockfile")),
    ("bun.lockb", ("bun", "install", "--frozen-lockfile")),
    ("package-lock.json", ("npm", "ci", "--no-audit", "--no-fund")),
    ("uv.lock", ("uv", "sync", "--frozen")),
    ("poetry.lock", ("poetry", "install", "--no-interaction", "--no-root")),
    ("Pipfile.lock", ("pipenv", "sync")),
    ("composer.lock", ("composer", "install", "--no-interaction")),
    ("Cargo.lock", ("cargo", "fetch", "--locked")),
    ("go.sum", ("go", "mod", "download")),
)
_JS_LOCKS = {"pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"}


class FixRefused(Exception):
    """A fix that cannot start: ``reason`` is the command_rejected reason, ``str`` says it plainly."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def _now() -> float:
    return round(time.time(), 3)


def root() -> Path:
    """Where fix copies live: ``~/.dgc/fix-copies`` (``$DGC_HOME/.dgc`` for an isolated session), read now."""
    from .config import dgc_home
    return dgc_home() / "fix-copies"


def _canonical(project_root) -> str:
    from .scheduler import _canonical_key
    return _canonical_key(project_root)


def project_key(project_root) -> str:
    """``<folder name>-<12 hex of the canonical path>``: one folder per project, readable in a listing."""
    path = Path(project_root).resolve(strict=False)
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", path.name).strip(".-")[:40] or "project"
    return f"{name}-{hashlib.sha256(_canonical(path).encode('utf-8', 'surrogatepass')).hexdigest()[:12]}"


def _private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


def _read_json(path: Path, limit: int = 4 * 1024 * 1024) -> dict:
    try:
        if path.is_symlink() or path.stat().st_size > limit:
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json(path: Path, value: dict) -> None:
    _private_dir(path.parent)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=True, indent=1)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            Path(tmp).unlink()
        except FileNotFoundError:
            pass


def _clip(text, limit: int) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[:limit - 1].rstrip() + "…"


def _alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class FixProject:
    """One project's kept fix copy, what it remembers, and its fixes, on disk."""

    def __init__(self, project_root):
        self.project_root = Path(project_root).resolve(strict=False)
        self.key = project_key(self.project_root)
        self.dir = root() / self.key
        self.copy = self.dir / "copy"

    # ---- project.json: last used, what was installed, the ignored files the user allowed --------
    def meta(self) -> dict:
        meta = _read_json(self.dir / "project.json")
        return meta if meta.get("project_root") in (None, str(self.project_root)) else {}

    def update_meta(self, change) -> dict:
        with _STORE_GUARD:
            meta = self.meta()
            change(meta)
            meta["project_root"] = str(self.project_root)
            _write_json(self.dir / "project.json", meta)
            return meta

    def touch(self) -> None:
        self.update_meta(lambda meta: meta.__setitem__("last_used", _now()))

    def remembered(self) -> list[str]:
        files = self.meta().get("files")
        return [str(f) for f in files if isinstance(f, str)][:MAX_REMEMBERED] if isinstance(files, list) else []

    def remember(self, rel: str) -> None:
        def change(meta):
            files = [f for f in (meta.get("files") or []) if isinstance(f, str) and f != rel]
            meta["files"] = [*files, rel][-MAX_REMEMBERED:]
        self.update_meta(change)

    # ---- fixes.json ------------------------------------------------------------------------------
    def _records(self) -> dict:
        records = _read_json(self.dir / "fixes.json").get("fixes")
        return {k: v for k, v in records.items() if FIX_ID.match(str(k)) and isinstance(v, dict)} \
            if isinstance(records, dict) else {}

    def records(self) -> list[dict]:
        """Every fix kept, newest first, an ACTIVE one whose process is gone shown as interrupted."""
        rows = sorted(self._records().values(), key=lambda r: r.get("created_at") or 0, reverse=True)
        return [_settled(row) for row in rows]

    def get(self, fix_id: str) -> dict | None:
        row = self._records().get(str(fix_id))
        return _settled(row) if row else None

    def put(self, record: dict) -> dict:
        record = {**record, "updated_at": _now()}
        with _STORE_GUARD:
            records = self._records()
            records[record["fix_id"]] = record
            keep = sorted(records.values(), key=lambda r: r.get("created_at") or 0, reverse=True)[:MAX_RECORDS]
            gone = set(records) - {r["fix_id"] for r in keep}
            _write_json(self.dir / "fixes.json", {"fixes": {r["fix_id"]: r for r in keep}})
        for fix_id in gone:
            shutil.rmtree(self.dir / "undo" / fix_id, ignore_errors=True)
        return record

    def undo_dir(self, fix_id: str) -> Path:
        return self.dir / "undo" / fix_id


def _settled(row: dict) -> dict:
    """A record whose process stopped before it ended reads as interrupted (nothing was applied)."""
    if row.get("state") not in ACTIVE:
        return dict(row)
    owner = row.get("owner") or {}
    if owner.get("token") == _TOKEN:
        return dict(row)
    fresh = time.time() - float(row.get("updated_at") or row.get("created_at") or 0) < STALE_S
    if owner.get("pid") != os.getpid() and _alive(owner.get("pid")) and fresh:
        return dict(row)
    out = dict(row)
    applying = out.get("state") == "applying"
    out["state"] = "interrupted"
    out["message"] = ("DGC stopped while it was applying the fix. Undo puts back what it had changed."
                      if applying else "DGC stopped before the fix finished. Nothing in your project was changed.")
    if applying and out.get("files"):
        out["undo"] = {"state": "available"}
    return out


def wire(record: dict) -> dict:
    """What the editor sees of a record: never its owner, session or folders."""
    keep = ("fix_id", "run_id", "pip_id", "name", "pip_type", "agent_id", "state", "step", "queued_behind",
            "created_at", "started_at", "ended_at", "files", "held", "merged", "tests", "summary", "message",
            "undo", "deps")
    return {key: record[key] for key in keep if key in record and record[key] not in (None, "")}


# ---- the report the fix is about -----------------------------------------------------------------
def run_brief(run_id: str, *, session_id: str = "", project_root=None, secrets=()) -> dict | None:
    """The report card for a run of this chat's project, and what the fixer needs to read: every
    finding with its evidence, the checks that failed, or why the run failed. The project is the
    chat's (its session's workspace, else its folder's). None when the run is another project's, or
    not a report."""
    from .pip_report_delivery import _candidate, _pip
    from .redaction import redact_value
    from .workspace_registry import RegistryError, WorkspaceRegistry
    import sqlite3
    if not RUN_ID.match(str(run_id or "")):
        return None
    try:
        with WorkspaceRegistry() as registry:
            identity = registry.session_identity(session_id) if session_id else None
            if identity is None and project_root is not None:
                found = registry.lookup(project_root)
                identity = {"workspace_id": found["id"]} if found else None
            if identity is None:
                return None
            row = registry.db.execute("""SELECT id,pip_id,workspace_id,status,finished_at,
                    CASE WHEN length(CAST(requested_by AS BLOB))<=128 THEN requested_by END AS requested_by,
                    CASE WHEN length(CAST(manifest AS BLOB))<=131072 THEN manifest END AS manifest,
                    CASE WHEN length(CAST(result AS BLOB))<=1048576 THEN result END AS result,
                    CASE WHEN length(CAST(error AS BLOB))<=16384 THEN error END AS error
                FROM pip_runs WHERE id=? AND workspace_id=? AND status IN ('succeeded','failed')""",
                                      (run_id, identity["workspace_id"])).fetchone()
            if row is None:
                return None
            pip = _pip(registry.db, row["pip_id"])
            if pip is None:
                return None
            candidate = _candidate(registry, row, pip)
            if candidate is None:
                return None
            try:
                result = json.loads(row["result"]) if row["result"] else {}
            except (ValueError, RecursionError):
                result = {}
    except (RegistryError, OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        return None
    findings = []
    for finding in (result.get("findings") or [])[:16] if isinstance(result, dict) else []:
        if isinstance(finding, dict):
            findings.append({key: finding.get(key) for key in ("title", "severity", "path", "line", "evidence",
                                                              "verification") if finding.get(key) not in (None, "")})
    brief = {"report": candidate["report"], "findings": findings}
    return redact_value(brief, secrets)


def child_prompt(brief: dict) -> str:
    """The fixer's task: what the Pip found, and how to work in the fix copy."""
    report = brief.get("report") or {}
    name = _clip(report.get("name") or "the Pip", 120)
    run = report.get("run_id") or ""
    lines = [f"Fix what Pip “{name}” found (run {run}), in this copy of the project.", ""]
    outcome = report.get("outcome")
    if outcome == "failed":
        lines += ["The Pip's run itself failed. Find out what stopped it and fix that, so its next run works.",
                  f"Why it stopped: {_clip(report.get('reason'), 300)}"]
        if report.get("detail"):
            lines.append(f"The saved error: {_clip(report.get('detail'), 600)}")
    elif outcome == "checks_failed":
        checks = report.get("checks") or {}
        lines.append(f"{checks.get('failed', 0)} of its {checks.get('total', 0)} checks failed:")
        lines += [f"- {_clip(label, 300)}" for label in report.get("failed_checks") or []]
        lines.append("Find out why each fails, and fix the cause in the code.")
    else:
        lines.append("What it found:")
        for index, finding in enumerate(brief.get("findings") or report.get("findings") or [], 1):
            where = finding.get("path") or ""
            if where and isinstance(finding.get("line"), int) and finding["line"] > 0:
                where += f":{finding['line']}"
            lines.append(f"{index}. [{finding.get('severity') or 'low'}] {_clip(finding.get('title'), 200)}"
                         + (f" ({where})" if where else ""))
            if finding.get("evidence"):
                lines.append(f"   Evidence: {_clip(finding['evidence'], 800)}")
            if finding.get("verification"):
                lines.append(f"   How it was checked: {_clip(finding['verification'], 400)}")
        lines.append("Check each finding against the code first. Fix the real ones; leave one that is not real "
                     "alone and say why.")
    lines += [
        "",
        "How to work:",
        "- This is DGC's copy of the project kept for fixes: its HEAD plus the user's uncommitted changes. When you "
        "finish, DGC applies your changes to the user's project, and they can undo them in one click. Change only "
        "what the fix needs.",
        "- Never change live data or services: no deploys, no pushes, no commands against a production database or "
        "API. If something can only be fixed on a live system, stop and say what the user should do.",
        "- Run the project's tests (or the failed checks) here when you can. If a test needs a Git-ignored file this "
        "copy does not have (a .env, say), ask the user for it with request_project_file; never read the project's "
        "own copy of it.",
        "- End with what you changed, in a sentence or two, then one line saying whether the tests ran: "
        "\"TESTS: passed — <command>\", \"TESTS: failed — <command>: <what failed>\" or "
        "\"TESTS: not run — <why>\".",
    ]
    return "\n".join(lines)


_TESTS_LINE = re.compile(r"^\s*\**\s*TESTS\s*:\s*\**\s*(passed|failed|not[ _-]run)\b\**\s*(?:[—–:-]+\s*)?(.*)$",
                         re.IGNORECASE)


def tests_outcome(result: str, commands: list[str]) -> dict:
    """Whether the tests ran in the fix copy: the fixer's TESTS line, held to what it actually ran.

    A claim of passed or failed from a fixer that ran no command at all is not believed."""
    state, rest = "not_run", ""
    for line in str(result or "").splitlines():
        match = _TESTS_LINE.match(line)
        if match:
            word = match.group(1).lower()
            state = "passed" if word == "passed" else "failed" if word == "failed" else "not_run"
            rest = match.group(2).strip().strip("*").strip()
    ran = [c for c in commands if c]
    if state != "not_run" and not ran:
        return {"state": "not_run", "note": "It didn't run any command in the fix copy."}
    out = {"state": state}
    if state == "not_run":
        if rest:
            out["note"] = _clip(rest, 200)
        return out
    quoted = re.match(r"`([^`]+)`(.*)$", rest)
    if quoted:                                       # "`npm test` (12 passed)", "`pytest -q`: 2 failed"
        command, note = quoted.group(1), quoted.group(2).strip()
        note = note[1:-1] if note.startswith("(") and note.endswith(")") else note.lstrip(":,\u2014\u2013- ")
    else:
        command, _, note = rest.partition(":")
    command = command.strip().strip("`").strip()
    if command:
        out["command"] = _clip(command, 160)
    if note.strip():
        out["note"] = _clip(note, 200)
    return out


_MARKUP = re.compile(r"\*\*|__|`+|^#{1,6}\s+|^\s*(?:[-*+]|\d+[.)])\s+")


def summary_of(result: str) -> str:
    """The fixer's own account as one plain line: without its TESTS and FILES lines, or Markdown's marks."""
    kept = [_MARKUP.sub("", line.strip()).strip() for line in str(result or "").splitlines()
            if line.strip() and not _TESTS_LINE.match(line) and not line.strip().upper().startswith("FILES:")]
    return _clip(" ".join(line for line in kept if line), MAX_SUMMARY)


# ---- dependencies --------------------------------------------------------------------------------
def install_plan(project_dir: Path) -> list[dict]:
    """The project's own install commands: [{lock, argv, digest}], one JavaScript one at most."""
    plan, js = [], False
    for lock, argv in INSTALLERS:
        path = Path(project_dir) / lock
        try:
            if not path.is_file() or path.is_symlink() or path.stat().st_size > 64 * 1024 * 1024:
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            continue
        if lock in _JS_LOCKS:
            if js:
                continue
            js = True
        plan.append({"lock": lock, "argv": list(argv), "digest": digest})
    return plan


def run_install(argv: list[str], cwd: Path, cancel: threading.Event, log: Path,
                timeout: float = INSTALL_TIMEOUT_S) -> tuple[bool, str]:
    """Run one install command in the fix copy. (ok, the last lines it printed)."""
    exe = shutil.which(argv[0])
    if exe is None:
        return False, f"{argv[0]} is not installed on this computer"
    env = dict(os.environ)
    env.update(CI="1", npm_config_audit="false", npm_config_fund="false", NO_COLOR="1",
               PIP_DISABLE_PIP_VERSION_CHECK="1")
    _private_dir(log.parent)
    with open(log, "wb") as out:
        kwargs = {"cwd": str(cwd), "stdin": subprocess.DEVNULL, "stdout": out, "stderr": subprocess.STDOUT,
                  "env": env}
        if os.name == "posix":
            kwargs["start_new_session"] = True
        try:
            proc = subprocess.Popen([exe, *argv[1:]], **kwargs)
        except OSError as exc:
            return False, str(exc)
        deadline = time.monotonic() + timeout
        why = ""
        while proc.poll() is None:
            if cancel.is_set():
                why = "stopped"
            elif time.monotonic() > deadline:
                why = f"it took longer than {int(timeout // 60)} minutes"
            if why:
                try:
                    if os.name == "posix":
                        os.killpg(proc.pid, signal.SIGKILL)
                    else:
                        proc.kill()
                except OSError:
                    pass
                proc.wait(timeout=10)
                break
            time.sleep(0.2)
    try:
        tail = log.read_bytes()[-2000:].decode("utf-8", "replace").strip()
    except OSError:
        tail = ""
    if why:
        return False, why
    if proc.returncode != 0:
        last = [line for line in tail.splitlines() if line.strip()][-3:]
        return False, f"exit {proc.returncode}" + (": " + " / ".join(_clip(l, 160) for l in last) if last else "")
    return True, ""


# ---- remembered ignored files ----------------------------------------------------------------------
def _ignored(project_root: Path, rel: str) -> bool:
    """Is `rel` a file this repository ignores? (git ls-files: check-ignore can't take literal pathspecs)"""
    from .worktree import _git_bytes
    out = _git_bytes(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", rel],
                     project_root, timeout=10.0, max_stdout=64 * 1024)
    return out.returncode == 0 and rel.encode("utf-8", "surrogateescape") in out.stdout.split(b"\0")


def check_project_file(project_root: Path, rel: str) -> tuple[Path | None, str]:
    """(the project's file, "") when `rel` may be copied into the fix copy, else (None, why not)."""
    value = str(rel or "").strip().replace("\\", "/")
    parts = [p for p in value.split("/") if p not in ("", ".")]
    if not parts or value.startswith("/") or ".." in parts or ".git" in parts or ".dgc" in parts:
        return None, "give a path relative to the project, inside it"
    rel = "/".join(parts)
    source = project_root / rel
    try:
        resolved = source.resolve(strict=True)
        resolved.relative_to(project_root.resolve(strict=False))
    except (OSError, ValueError):
        return None, f"{rel} is not in the project"
    if source.is_symlink() or not source.is_file():
        return None, f"{rel} is not a plain file in the project"
    if source.stat().st_size > MAX_REMEMBERED_BYTES:
        return None, f"{rel} is larger than {MAX_REMEMBERED_BYTES // 1024} KB, too big to copy"
    if not _ignored(project_root, rel):
        return None, f"{rel} is not a Git-ignored file (a tracked file is already in the copy)"
    return source, ""


def copy_project_file(source: Path, copy_root: Path, rel: str) -> None:
    """Copy (never link) one ignored file into the fix copy, replacing whatever is there."""
    target = copy_root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() or target.exists():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    data = source.read_bytes()
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
    try:
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, target)
    finally:
        try:
            Path(tmp).unlink()
        except FileNotFoundError:
            pass


# ---- undo ----------------------------------------------------------------------------------------
def _state_of(path: Path) -> tuple[str, bytes, int]:
    from .worktree import _read_state
    state = _read_state(path)
    return state.kind, state.data, state.mode


def _digest(kind: str, data: bytes) -> str:
    return "" if kind == "missing" else hashlib.sha256(kind.encode() + b"\0" + data).hexdigest()


class UndoRecorder:
    """What `integrate()` writes, recorded before each write so one Undo can put it all back.

    Passed to KeptTaskWorkspace.integrate as its checkpoint manager (record_file, note_written).
    Each file's prior state is on disk before the file is written, so even a DGC that stops in the
    middle of applying leaves an Undo for what it had applied."""

    def __init__(self, project: FixProject, fix_id: str):
        self.project, self.fix_id = project, fix_id
        self.dir = _private_dir(project.undo_dir(fix_id))
        self.entries: dict[str, dict] = {}
        self.total = 0
        self.last_record_error = ""

    def record_file(self, path: str) -> bool:
        try:
            rel = Path(path).absolute().relative_to(self.project.project_root).as_posix()
        except ValueError:
            self.last_record_error = "outside the project"
            return False
        if rel in self.entries:
            return True
        try:
            kind, data, mode = _state_of(Path(path))
        except Exception as exc:                       # noqa: BLE001 -- refuses the write
            self.last_record_error = str(exc)
            return False
        self.total += len(data)
        if self.total > MAX_UNDO_BYTES:
            self.last_record_error = "the fix is too big to undo"
            return False
        n = len(self.entries)
        try:
            (self.dir / f"{n}.before").write_bytes(data)
        except OSError as exc:
            self.last_record_error = str(exc)
            return False
        self.entries[rel] = {"path": rel, "n": n, "kind": kind, "mode": mode, "before": _digest(kind, data)}
        self.save()
        return True

    def note_written(self, path: str) -> None:
        try:
            rel = Path(path).absolute().relative_to(self.project.project_root).as_posix()
            kind, data, mode = _state_of(Path(path))
        except Exception:                               # noqa: BLE001
            return
        entry = self.entries.get(rel)
        if entry is None:
            return
        entry.update(after=_digest(kind, data), after_kind=kind)
        try:
            (self.dir / f"{entry['n']}.after").write_bytes(data)
        except OSError:
            pass
        self.save()

    def save(self) -> None:
        _write_json(self.dir / "manifest.json", {"files": list(self.entries.values())})


def _manifest(project: FixProject, fix_id: str) -> list[dict]:
    files = _read_json(project.undo_dir(fix_id) / "manifest.json").get("files")
    return [f for f in files if isinstance(f, dict) and isinstance(f.get("path"), str)] if isinstance(files, list) else []


def undo(project: FixProject, record: dict, cancel: threading.Event | None = None) -> dict:
    """Put back every file the fix wrote that still holds what it left. Returns the updated record."""
    from .scheduler import acquire_cancellable, workspace_mutation_lock
    from .worktree import _FileState, _checked_target, _replace_state
    entries = _manifest(project, record["fix_id"])
    if not entries:
        raise FixRefused("nothing_to_undo", "There is nothing of this fix left to undo.")
    stop = cancel or threading.Event()
    timer = None
    if cancel is None:
        timer = threading.Timer(10.0, stop.set)
        timer.daemon = True
        timer.start()
    lease = workspace_mutation_lock(project.project_root)
    try:
        if not acquire_cancellable(lease, stop):
            raise FixRefused("busy", "Another change to this project is being made. Try Undo again in a moment.")
    finally:
        if timer is not None:
            timer.cancel()
    restored, kept = [], []
    try:
        for entry in entries:
            rel = entry["path"]
            target = _checked_target(project.project_root, rel)
            try:
                kind, data, _mode = _state_of(target)
            except Exception as exc:                   # noqa: BLE001
                kept.append({"path": rel, "why": _clip(exc, 160)})
                continue
            now = _digest(kind, data)
            if now == entry.get("before"):
                restored.append(rel)                   # already as it was
                continue
            if "after" not in entry or now != entry["after"]:
                kept.append({"path": rel, "why": "changed since the fix"})
                continue
            try:
                before = (project.undo_dir(record["fix_id"]) / f"{entry['n']}.before").read_bytes()
                _replace_state(target, _FileState(entry["kind"], before if entry["kind"] != "missing" else b"",
                                                  int(entry.get("mode") or 0o644)))
                restored.append(rel)
            except Exception as exc:                   # noqa: BLE001
                kept.append({"path": rel, "why": _clip(exc, 160)})
    finally:
        lease.release()
    out = dict(record)
    out["undo"] = {"state": "partial" if kept else "done", "restored": restored[:MAX_FILES_SHOWN],
                   "kept": kept[:MAX_FILES_SHOWN], "at": _now()}
    if not kept:
        out["state"] = "undone"
    return out


def change_texts(project: FixProject, record: dict, rel: str) -> tuple[str, str, str]:
    """(before, after, kind) for Review: what the fix found and what it left, or what it held back."""
    from .workspace_changes import MAX_DIFF_BYTES

    def text(data: bytes) -> str:
        if b"\0" in data[:8192]:
            return "(binary file)"
        if len(data) > MAX_DIFF_BYTES:
            return data[:MAX_DIFF_BYTES].decode("utf-8", "replace") + "\n… (cut: the file is larger than this review shows)"
        return data.decode("utf-8", "replace")

    fix_id = record["fix_id"]
    for entry in _manifest(project, fix_id):
        if entry["path"] == rel:
            folder = project.undo_dir(fix_id)
            before = (folder / f"{entry['n']}.before").read_bytes() if (folder / f"{entry['n']}.before").exists() else b""
            after_path = folder / f"{entry['n']}.after"
            after = after_path.read_bytes() if after_path.exists() else b""
            kind = "added" if entry.get("kind") == "missing" else "deleted" if entry.get("after_kind") == "missing" else "edited"
            return text(before), text(after), kind
    held = project.undo_dir(fix_id) / "held"
    for item in record.get("held") or []:
        if item.get("path") == rel and isinstance(item.get("n"), int):
            mine = held / f"{item['n']}.fix"
            try:
                current = (project.project_root / rel).read_bytes() if (project.project_root / rel).is_file() else b""
            except OSError:
                current = b""
            return text(current), text(mine.read_bytes() if mine.exists() else b""), "held"
    raise FixRefused("unknown_file", f"{rel} is not part of this fix.")


# ---- cleanup and doctor ----------------------------------------------------------------------------
def _size(path: Path, limit_s: float = 10.0) -> int:
    total, deadline = 0, time.monotonic() + limit_s
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        if time.monotonic() > deadline:
            break
        for name in filenames:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_size
            except OSError:
                pass
    return total


def sweep(now: float | None = None) -> list[str]:
    """Remove fix copies unused for 14 days (their records and undo data go with them). Never one in use."""
    from .scheduler import named_process_lock
    from .worktree import KeptTaskWorkspace
    base = root()
    if not base.is_dir():
        return []
    now = time.time() if now is None else now
    removed = []
    for folder in sorted(base.iterdir()):
        if not folder.is_dir() or folder.is_symlink():
            continue
        meta = _read_json(folder / "project.json")
        last = meta.get("last_used")
        if not isinstance(last, (int, float)):
            try:
                last = folder.stat().st_mtime
            except OSError:
                continue
        if now - last < KEEP_UNUSED_S:
            continue
        lock = named_process_lock("pip-fix", folder.name)
        if not lock.acquire(timeout=0):
            continue                                   # a fix is running there right now
        try:
            source = Path(str(meta.get("project_root") or folder))
            KeptTaskWorkspace.remove(source, folder / "copy")
            shutil.rmtree(folder, ignore_errors=True)
            removed.append(folder.name)
        finally:
            lock.release()
    return removed


_SWEPT = threading.Event()


def sweep_soon() -> None:
    """Sweep once per process, on a thread of its own: a backend's start never waits for it."""
    if _SWEPT.is_set():
        return
    _SWEPT.set()

    def go() -> None:
        try:
            sweep()
        except Exception:                               # noqa: BLE001 -- the next process tries again
            pass
    threading.Thread(target=go, name="dgc-fix-copy-sweep", daemon=True).start()


def doctor_rows() -> list[dict]:
    """Each project's fix copy and its size on disk, for `dgc doctor`."""
    base = root()
    rows = []
    if not base.is_dir():
        return rows
    for folder in sorted(base.iterdir()):
        if not folder.is_dir() or folder.is_symlink():
            continue
        meta = _read_json(folder / "project.json")
        rows.append({"project": str(meta.get("project_root") or folder.name), "bytes": _size(folder),
                     "last_used": meta.get("last_used")})
    return rows


# ---- one at a time per project ---------------------------------------------------------------------
def queue_join(key: str, fix_id: str, name: str) -> None:
    with _QUEUE_COND:
        _QUEUES.setdefault(key, []).append(fix_id)
        _QUEUE_NAMES[fix_id] = name


def queue_leave(key: str, fix_id: str) -> None:
    with _QUEUE_COND:
        line = _QUEUES.get(key) or []
        if fix_id in line:
            line.remove(fix_id)
        if not line:
            _QUEUES.pop(key, None)
        _QUEUE_NAMES.pop(fix_id, None)
        _QUEUE_COND.notify_all()


def queue_ahead(key: str, fix_id: str) -> str | None:
    """The Pip whose fix runs before this one here, or None when this one is first in line."""
    with _QUEUE_COND:
        line = _QUEUES.get(key) or []
        if not line or line[0] == fix_id:
            return None
        return _QUEUE_NAMES.get(line[0]) or ""


def wait_turn(key: str, fix_id: str, cancel: threading.Event, on_wait) -> object | None:
    """Wait until this fix is first in this process's line and holds the project's lock (another
    DGC's fix of the same project holds it too). Returns the held lock, or None when stopped.
    `on_wait(name)` is told what it waits for: the Pip whose fix is ahead here, or None for a fix
    another DGC is running in this project."""
    from .scheduler import named_process_lock
    lock = named_process_lock("pip-fix", key)
    said = False
    while not cancel.is_set():
        ahead = queue_ahead(key, fix_id)
        if ahead is None and lock.acquire(timeout=0.25):
            if cancel.is_set():
                lock.release()
                return None
            return lock
        waiting = ahead or None
        if said is False or waiting != said:
            said = waiting
            on_wait(waiting)
        if ahead is not None:
            with _QUEUE_COND:
                _QUEUE_COND.wait(0.25)
    return None


# ---- the fix itself: a background child of the chat's agent ----------------------------------------
PROJECT_FILE_SCHEMA = {"type": "function", "function": {
    "name": "request_project_file",
    "description": (
        "Ask for one Git-ignored file from the user's project (a .env, a local config) that a test you are running "
        "needs and this fix copy does not have. DGC asks the user; if they allow it, the file is copied (never "
        "linked) into this copy, and later fixes of this project get it too. Use it only after a test actually "
        "failed for want of the file. Never read the project's own copy instead."),
    "parameters": {"type": "object", "properties": {
        "path": {"type": "string", "description": "The file, relative to the project root (e.g. \".env\")."},
        "why": {"type": "string", "description": "One sentence for the user: which test needs it and why."}},
        "required": ["path", "why"]}}}

_FIX_UI = None


def _fix_ui_class():
    """A sub-agent UI that also remembers the commands the fixer ran (to hold its TESTS line to them)."""
    global _FIX_UI
    if _FIX_UI is None:
        from .agent import _SubUI

        class _FixUI(_SubUI):
            def tool_call(self, name, args, call_id=None):
                if name in ("bash", "python") and isinstance(args, dict):
                    commands = self.__dict__.setdefault("_fix_commands", [])
                    if len(commands) < 200:
                        commands.append(str(args.get("command") or args.get("code") or "")[:400])
                return super().tool_call(name, args, call_id)

            @property
            def commands(self) -> list[str]:
                return list(self.__dict__.get("_fix_commands", ()))

        _FIX_UI = _FixUI
    return _FIX_UI


def project_file_tool(agent, args) -> str:
    """request_project_file, run once the user (or their mode) allowed it: copy, remember, say so."""
    fix = getattr(agent, "_fix_copy", None)
    if not isinstance(fix, dict):
        return "error: request_project_file is only for a Pip fix's copy of the project."
    args = args if isinstance(args, dict) else {}
    project_root = Path(fix["project_root"])
    source, why = check_project_file(project_root, args.get("path"))
    if source is None:
        return f"error: {why}."
    rel = source.relative_to(project_root).as_posix()
    try:
        copy_project_file(source, Path(fix["copy_root"]), rel)
        FixProject(project_root).remember(rel)
    except OSError as exc:
        return f"error: {rel} could not be copied: {exc}."
    return (f"Copied {rel} from the project into this copy (a copy, not a link). Later fixes of this project get "
            "it too. Run the test again.")


def _detached_maps(agent) -> dict:
    """The parent's background-job maps, made once as `_run_subagent` makes them."""
    jobs = getattr(agent, "_detached_jobs", None)
    if jobs is None:
        agent._detached_jobs = jobs = {}
        agent._finalizing = {}
        agent._finalizing_lock = threading.Lock()
        agent._finished_jobs = {}
    return jobs


def _permissions(agent):
    from .permissions import PermissionEngine
    cfg = agent.config
    with agent._mode_lock:
        rules = {action: [*(cfg.permissions.get(action, []) or []),
                          *(getattr(cfg, "session_permissions", {}).get(action, []) or [])]
                 for action in ("allow", "ask", "deny")}
        return PermissionEngine(agent.mode, rules, cfg.project_root)


def _install_allowed(agent, sub_ui, command: str, call_id: str) -> tuple[bool, str]:
    """May DGC run the project's install command in the fix copy? The chat's own rules decide, as
    they would for the fixer's own `bash` call; when they ask, the card asks."""
    from .permissions import ALLOW, DENY
    decision, _reason = _permissions(agent).decide("bash", {"command": command})
    if decision == ALLOW:
        return True, ""
    if decision == DENY:
        return False, "your permission rules don't allow it"
    registry = agent.subagents
    registry.waiting(sub_ui.agent_id, "permission")
    try:
        verdict = sub_ui.approve("bash", {"command": command}, call_id)
    finally:
        registry.waiting(sub_ui.agent_id, None)
    if verdict == "always":
        try:
            sub_ui.add_permission_rule("bash", {"command": command})
        except Exception:                               # noqa: BLE001 -- the run goes on either way
            pass
    return (True, "") if verdict in ("once", "always") else (False, "you said not now")


def _sync(project: FixProject, cancel: threading.Event):
    """The kept copy, synced, under the project's write lease (it reads the user's files)."""
    from .scheduler import acquire_cancellable, workspace_mutation_lock
    from .worktree import KeptTaskWorkspace
    lease = workspace_mutation_lock(project.project_root)
    if not acquire_cancellable(lease, cancel):
        return None, lease.last_error or "stopped"
    try:
        return KeptTaskWorkspace.sync(project.project_root, project.copy)
    finally:
        lease.release()


def _copy_remembered(project: FixProject, workspace) -> list[str]:
    copied = []
    for rel in project.remembered():
        source, _why = check_project_file(project.project_root, rel)
        if source is None:
            continue
        try:
            copy_project_file(source, workspace.project_root, rel)
            copied.append(rel)
        except OSError:
            continue
    return copied


def _counts_of(project: FixProject, recorder: UndoRecorder, rel: str) -> dict:
    from .workspace_changes import _counts
    entry = recorder.entries.get(rel) or {}
    folder = project.undo_dir(recorder.fix_id)
    row = {"path": rel, "kind": "added" if entry.get("kind") == "missing"
           else "deleted" if entry.get("after_kind") == "missing" else "edited"}
    try:
        before = (folder / f"{entry['n']}.before").read_bytes()
        after_path = folder / f"{entry['n']}.after"
        after = after_path.read_bytes() if after_path.exists() else b""
        counted = _counts(before, after)
        row.update(additions=counted["additions"], deletions=counted["deletions"],
                   counted=bool(counted["counted"]) and not counted.get("binary"))
    except (OSError, KeyError):
        row.update(additions=0, deletions=0, counted=False)
    return row


def _apply(agent, project: FixProject, workspace, fix_id: str, cancel: threading.Event) -> dict:
    """Integrate the fixer's changes into the project, recording each file first for Undo."""
    from .scheduler import acquire_cancellable, workspace_mutation_lock
    lease = workspace_mutation_lock(project.project_root)
    if not acquire_cancellable(lease, cancel):
        return {"state": "stopped", "message": "Stopped before the fix was applied. Nothing in your project was changed."}
    recorder = UndoRecorder(project, fix_id)
    try:
        integration = workspace.integrate(recorder)
    finally:
        lease.release()
    fields: dict = {}
    if integration.status in ("applied", "partial"):
        fields["files"] = [_counts_of(project, recorder, rel) for rel in integration.paths[:MAX_FILES_SHOWN]]
        fields["undo"] = {"state": "available"}
        if integration.merged:
            fields["merged"] = list(integration.merged[:MAX_FILES_SHOWN])
    if integration.status in ("partial", "conflict"):
        held, folder = [], _private_dir(project.undo_dir(fix_id) / "held")
        for n, repo_path in enumerate(list(workspace.held_paths)[:MAX_FILES_SHOWN]):
            try:
                kind, data, _mode = workspace.held_state(repo_path)
                (folder / f"{n}.fix").write_bytes(data if kind != "missing" else b"")
            except Exception:                           # noqa: BLE001 -- named, without its bytes
                pass
            held.append({"path": workspace.display_path(repo_path), "n": n,
                         "why": "you changed the same lines while it worked"})
        fields["held"] = held
    if integration.status == "applied":
        fields["state"] = "applied"
    elif integration.status == "partial":
        fields["state"] = "partial"
    elif integration.status == "clean":
        fields["state"] = "unchanged"
    elif integration.status == "conflict":
        fields.update(state="not_applied", message=(
            "You changed the same lines while it worked, so nothing was applied. Review shows what it would change."))
    else:
        # integrate() puts back what it had written when applying fails; only a put-back that failed leaves any.
        left = bool(recorder.entries) and "rollback incomplete" in str(integration.error or "")
        fields.update(state="failed", message=_clip(
            f"DGC couldn't apply the fix: {integration.error or integration.status}. "
            + ("Undo puts back what it had changed." if left else "Nothing in your project was changed."), 400))
        if left:
            fields["undo"] = {"state": "available"}
            fields["files"] = [_counts_of(project, recorder, rel) for rel in list(recorder.entries)[:MAX_FILES_SHOWN]]
    return fields


def _deps_notes(deps: list[dict], copied: list[str]) -> list[str]:
    notes = []
    for item in deps:
        command = item.get("command")
        if item.get("state") in ("installed", "ready"):
            notes.append(f"- This is DGC's kept fix copy: dependencies are installed in it (`{command}`, from "
                         f"{item.get('lock')}). Don't install them again unless a test says one is missing.")
        elif item.get("state") == "failed":
            notes.append(f"- Installing dependencies with `{command}` failed in this copy ({item.get('note')}). "
                         "Install what a test needs yourself, in THIS copy.")
        elif item.get("state") == "skipped":
            notes.append(f"- Dependencies were not installed in this copy (`{command}`: {item.get('note')}).")
    if copied:
        notes.append(f"- Copied from the project because the user allowed it (Git-ignored there): {', '.join(copied)}.")
    return notes


def start(agent, brief: dict, *, session_id: str, emit) -> dict:
    """Start fixing one report in the background of `agent`'s chat. Returns the fix record at once.

    `emit(record)` is called (on any thread) with the record each time it changes. Raises FixRefused."""
    from .worktree import repo_root
    report = brief.get("report") or {}
    if getattr(agent, "depth", 0) != 0 or getattr(agent, "stopping", False):
        raise FixRefused("unavailable", "DGC can't start a fix from here.")
    if getattr(agent, "mode", "default") == "plan":
        raise FixRefused("plan_mode", "This chat is in Plan mode, where DGC changes nothing. Switch to another mode "
                                      "to let DGC fix it.")
    project = FixProject(agent.config.project_root)
    if repo_root(project.project_root) is None:
        raise FixRefused("not_git", "Ask DGC to fix needs a Git project, to make a copy to fix it in. This folder "
                                    "isn't one.")
    for row in project.records():
        if row.get("session_id") == session_id and row.get("run_id") == report.get("run_id") \
                and row.get("state") in ACTIVE:
            return row                                 # one fix of a report at a time
    fix_id = "fix_" + uuid.uuid4().hex
    name = _clip(report.get("name") or "a Pip", 120)
    description = f"Fix what {name} found"
    cancel = threading.Event()
    sub_ui = _fix_ui_class()(agent.ui, description, cancel=cancel)
    registry = agent.subagents
    sub_ui._registry = registry
    agent_id = sub_ui.agent_id
    record = {"fix_id": fix_id, "session_id": session_id, "run_id": report.get("run_id"),
              "pip_id": report.get("pip_id"), "name": name, "pip_type": report.get("pip_type"),
              "agent_id": agent_id, "state": "queued", "created_at": _now(),
              "owner": {"pid": os.getpid(), "token": _TOKEN}}
    lock = threading.Lock()

    def update(**fields) -> dict:
        with lock:
            for key, value in fields.items():
                if value is None:
                    record.pop(key, None)
                else:
                    record[key] = value
            snapshot = dict(record)
        try:
            project.put(snapshot)
        except OSError:
            pass
        try:
            emit(snapshot)
        except Exception:                              # noqa: BLE001 -- a view, not the work
            pass
        return snapshot

    jobs = _detached_maps(agent)
    # The fix's record first, then its agent: a client that hears of the agent already knows it is this
    # fix's (its card is its line, never a second one in the chat).
    first = update()
    registry.start(id=agent_id, description=description, depth=1, isolated=True, queued=True,
                   background=True, turn_hint="")
    handle = {"cancel": cancel, "description": description, "agent": None, "parent_id": None,
              "worktree": str(project.copy), "branch": "", "base_commit": "", "keeper": None,
              "started_at": time.time(), "queued": False, "queue_seq": 0, "pip_fix": fix_id}
    jobs[agent_id] = handle
    queue_join(project.key, fix_id, name)

    def end_record(state: str, message: str = "") -> None:
        if registry.state(agent_id) in ("queued", "running", "waiting"):
            registry.end(agent_id, "stopped" if state == "stopped" else "failed" if state == "failed" else "finished",
                         message)

    def work() -> None:
        held_lock = None
        outcome_text = ""
        try:
            held_lock = wait_turn(project.key, fix_id, cancel, lambda ahead: update(
                state="queued", queued_behind=ahead,
                step=None if ahead else "Waiting for another fix of this project to finish"))
            if held_lock is None:
                end_record("stopped")
                update(state="stopped", queued_behind=None, ended_at=_now(),
                       message="Stopped before it started. Nothing in your project was changed.")
                return
            registry.running(agent_id)
            update(state="preparing", queued_behind=None, step="Getting the fix copy ready", started_at=_now())
            project.touch()
            workspace, error = _sync(project, cancel)
            if workspace is None:
                stopped = cancel.is_set()
                end_record("stopped" if stopped else "failed", error or "")
                update(state="stopped" if stopped else "failed", step=None, ended_at=_now(), message=(
                    "Stopped. Nothing in your project was changed." if stopped else
                    _clip(f"DGC couldn't make the fix copy: {error}. Nothing in your project was changed.", 400)))
                return
            copied = _copy_remembered(project, workspace)
            deps = []
            installed = (project.meta().get("installed") or {})
            ran = False
            for n, item in enumerate(install_plan(workspace.project_root), 1):
                command = " ".join(item["argv"])
                previous = installed.get(item["lock"]) if isinstance(installed.get(item["lock"]), dict) else {}
                if previous.get("ok") and previous.get("digest") == item["digest"]:
                    deps.append({"lock": item["lock"], "command": command, "state": "ready"})
                    continue
                if shutil.which(item["argv"][0]) is None:
                    deps.append({"lock": item["lock"], "command": command, "state": "skipped",
                                 "note": f"{item['argv'][0]} is not installed on this computer"})
                    continue
                allowed, why = _install_allowed(agent, sub_ui, command, f"install-{n}")
                if cancel.is_set():
                    break
                if not allowed:
                    deps.append({"lock": item["lock"], "command": command, "state": "skipped", "note": why})
                    continue
                update(step=f"Installing dependencies: {command}")
                ok, note = run_install(item["argv"], workspace.project_root, cancel, project.dir / "install.log")
                ran = True
                entry = {"digest": item["digest"] if ok else "", "ok": ok, "command": command, "at": _now(),
                         "note": note}
                project.update_meta(lambda meta, lock_name=item["lock"], entry=entry:
                                    meta.setdefault("installed", {}).__setitem__(lock_name, entry))
                deps.append({"lock": item["lock"], "command": command, "state": "installed" if ok else "failed",
                             "note": note})
                if cancel.is_set():
                    break
            if cancel.is_set():
                end_record("stopped")
                update(state="stopped", step=None, ended_at=_now(), message="Stopped. Nothing in your project was changed.")
                return
            if ran:
                # An install may touch tracked files; the fixer starts from the project's state exactly.
                update(step="Getting the fix copy ready")
                workspace, error = _sync(project, cancel)
                if workspace is None:
                    end_record("failed", error or "")
                    update(state="failed", step=None, ended_at=_now(), message=_clip(
                        f"DGC couldn't make the fix copy: {error}. Nothing in your project was changed.", 400))
                    return
                copied = _copy_remembered(project, workspace)
            update(state="running", step=None,
                   deps=[{k: d[k] for k in ("command", "state", "note") if d.get(k)} for d in deps] or None)
            notes = _deps_notes(deps, copied)

            def prepare_child(sub) -> None:
                sub._fix_copy = {"project_root": str(project.project_root), "copy_root": str(workspace.project_root),
                                 "fix_id": fix_id}
                # Its own ledger: no turn asked for it, so no turn's token cap pays for it.
                sub._budget_turn = -1 - int(fix_id[4:16], 16)
                sub._fix_notes = notes
                sub._refresh_system()

            failure, result, start_error = agent._execute_prepared_subagent(
                description, child_prompt(brief), "", workspace, sub_ui, None, cancel=cancel, handle=handle,
                prepare_child=prepare_child)
            outcome_text = result or failure or start_error
            if start_error or failure:
                stopped = cancel.is_set()
                update(state="stopped" if stopped else "failed", ended_at=_now(), summary=summary_of(result) or None,
                       message=("Stopped. Nothing in your project was changed." if stopped else _clip(
                           f"The fix didn't finish: {start_error or failure}. Nothing in your project was changed.", 400)))
                return
            update(state="applying", step="Applying the fix")
            with agent._finalizing_lock:
                agent._finalizing[agent_id] = description
            try:
                fields = _apply(agent, project, workspace, fix_id, cancel)
            finally:
                with agent._finalizing_lock:
                    agent._finalizing.pop(agent_id, None)
            fields.update(tests=tests_outcome(result, sub_ui.commands), summary=summary_of(result) or None,
                          step=None, ended_at=_now())
            update(**fields)
        except Exception as exc:                       # noqa: BLE001 -- said on the card
            end_record("failed", str(exc))
            applying = record.get("state") == "applying"
            update(state="failed", step=None, ended_at=_now(), message=_clip(
                f"The fix stopped with an error: {type(exc).__name__}: {exc}. "
                + ("Undo puts back what it had changed." if applying else "Nothing in your project was changed."), 400))
        finally:
            queue_leave(project.key, fix_id)
            if held_lock is not None:
                held_lock.release()
            try:
                project.touch()
            except OSError:
                pass
            from .agent import _TaskOutcome
            agent._remember_finished(agent_id, description, _TaskOutcome(
                _clip(outcome_text or record.get("message") or record.get("state"), 2000),
                record.get("state") in ("applied", "partial"),
                tuple(f.get("path") for f in record.get("files") or ())))
            jobs.pop(agent_id, None)
            slots = agent._detached_slots()
            with slots:
                slots.notify_all()

    threading.Thread(target=work, daemon=True, name=f"dgc-pip-fix-{fix_id[-8:]}").start()
    return first


def for_session(project_root, session_id: str) -> list[dict]:
    """This chat's fixes, newest first."""
    return [row for row in FixProject(project_root).records() if row.get("session_id") == session_id]
