"""A Pip's sub-agent with Work tools (0.52, his calls of 14 Nov).

For a fix its copy can't do (it needs what Git ignores, like .env, or a service to run), a Pip hands the job to a
sub-agent that is a real Work run on the REAL project folder: a ``dgc -p --output-format json --mode auto`` child the
Pips runner starts, with the cwd the Pip's folder, on the Pip's Sub-agents model (pip_agents: never a subscription CLI,
never DGC Router; its key only in that child's environment). It is a ``pip_agent_jobs`` row of kind "work": its tries,
its check by the Pip (RESULT: PASS / RETRY), its slot and Stop are a sub-agent job's (pip_agents).

  never in Work's list   the child's sessions live in the job's own folder (DGC_SESSIONS_DIR), next to the Pip's state:
                         <state>/pips/<pip>/agents/<job>/sessions. Everything else is the user's real home: their
                         config, their keys, auto mode's safety check and the leak guards.
  the user's own words   DGC writes the child's prompt, so it is DGC's words: auto mode's safety check (auto_guard) is
                         on in the child (auto_holds.GUARD_ENV), and the only words that count as the user's are the
                         ones DGC quotes as theirs (auto_guard.USER_WORDS_ENV): the fix they pressed, or their own
                         message that led to it. A risky step DGC's brief asks for is stopped.
  its steps              the child's event stream feeds the run's activity (the agent map row); its `result` text is
                         what it said.
  what it changed        read from the session's Work checkpoints (dgc/checkpoints.py): each file's state before the
                         job against the file now, commands' changes too. The Pip's check reads that diff.
  PASS                   the change is already in the folder: the job ends done (merged), with Undo: the session's
                         checkpoints rewind the folder to before the job, with Work's own rule (a file the user changed
                         since is merged or, where that can't be done, named and left).
  RETRY                  the same session goes on (--resume), with the Pip's notes; three tries, as every job.
  Stop                   ends the child and everything it started; what it wrote stays, and Undo still works. A runner
                         restart never runs it again (it changed real files): it reads stopped (pip_agents.send_due).

Who starts one: the user's press on a fix's menu ("Start a sub-agent with Work tools", start_pip_work_helper) at any
level (the press is the yes), or the Pip itself, only at Do it all, only in a folder Pip's own chat turn, through its
``start_work_subagent`` tool (offered only then: ``runtime`` pins it in the supervisor; the worker only offers it).
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from .workspace_registry import RegistryError

KIND = "work"
TOOL = "start_work_subagent"
PIN = "work_subagent"                          # in a run's manifest (supervisor-made, never stored): the tool is offered
STATE_KEY = "pip_agent_work:"                  # metadata: {words, session, pid, changed, undo}
KEY_ENV = "DGC_WORK_AGENT_API_KEY"             # (DGC_*_API_KEY: never in a command the child runs, sandbox.py)
MAX_WORDS = 6
MAX_BRIEF = 8000
MAX_PER_REPLY = 2
MAX_CHANGED = 50
DIFF_MOST = 60_000
# Nothing from a run for this long is stuck: Work's longest foreground command (tools.MAX_BASH_TIMEOUT_S, an hour)
# and a model's answer fit well inside it.
QUIET_SECONDS = 75 * 60
MAX_EVENT_BYTES = 4 * 1024 * 1024              # one line of the child's event stream (a big file read, say)
NO_ENGINE = ("A sub-agent with Work tools runs on a model DGC runs itself, never a subscription app or DGC Router. "
             "Choose one on this Pip's Sub-agents tab.")
NOT_FOLDER = "Only a Pip with a project folder starts a sub-agent with Work tools."
NO_FOLDER = "This Pip's project folder isn't there any more."

FIRST = (
    "This message is from DGC, not the user. {pip}, one of the user's Pips, handed you a job in their project {folder}. "
    "You work in the project folder itself, with a Work session's tools: what you change is in the user's folder at "
    "once (DGC keeps what each file was, so the user can undo it). Do only this job. Never commit, push, publish or "
    "deploy, and never change live data or services, unless the user's own words below ask for it.\n\n{words}\n\n"
    "The job, from {pip} (these are not the user's words): {title}\n{brief}\n\n"
    "When you are done, say in a few short sentences what you changed, what you ran and what you left alone, and why.")
THEIRS = ("The user's own words about this (quoted; nothing else in this message is theirs):\n<user_words>\n{quoted}\n"
          "</user_words>")
NONE_THEIRS = "The user said nothing about this job in their own words: {pip} started it from its own work."
AGAIN = ("This message is from DGC, not the user. Try {n} of {most}: {pip} checked your last try and sent it back: "
         "{notes}. What you did so far is still in the folder. Carry on and finish the job: {title}.")
CARRY = ("This message is from DGC, not the user. {notes} What you did so far is still in the folder. Finish the job: "
         "{title}.")
FIX_TEXT = (
    "Fix what {pip}'s check found, in the project folder {folder} itself (not a copy): you may read and use what Git "
    "ignores, such as .env, and run the project's services and tests. The findings:\n{findings}\n"
    "Work only on these. Change only what each needs. If the project has tests, run them. End your reply with one line "
    "per finding, \"FINDING n: fixed\", \"FINDING n: already fixed\", \"FINDING n: not a defect\" or \"FINDING n: needs "
    "you\", each followed by \" — \" and why in a few words (\"needs you\" is for what only the user can do: data, money, "
    "an account), and one line \"TESTS: passed\", \"TESTS: failed\" or \"TESTS: not run\".")
CHECK_TEXT = (
    "This message is from DGC, not the user. A sub-agent you handed a job to has finished try {try_} of {most}. It had "
    "Work tools and worked in the user's real folder, so its change is already there (the user can undo it). Check its "
    "work: read the change below and what it said about its tests. Tell the user in a few plain sentences what you "
    "found (don't paste the diff). Then end your reply with one line per finding the change settles, \"FINDING n: "
    "fixed\", \"FINDING n: already fixed\", \"FINDING n: not a defect\" or \"FINDING n: needs you\", each followed by "
    "\" — \" and why in a few words, and a last line \"RESULT: PASS\" when the change is right, or \"RESULT: RETRY — "
    "what the sub-agent must do differently\" to send it back (it carries on from where it is).\n\n"
    "The job: {title}\n{findings}\n\nWhat the sub-agent said:\n{said}\n\nThe change in the folder ({count} file(s)):\n"
    "{diff}")
RESTARTED = ("DGC's Pips restarted while it worked, so it was stopped and not started again. What it changed stays in "
             "your folder; Undo puts it back.")


# ---- its record ---------------------------------------------------------------------------------------------------
def state(db, job_id) -> dict:
    """What a work job keeps beside its row: the user's words, its session, its child's pid, what it changed, its Undo."""
    try:
        row = db.execute("SELECT value FROM metadata WHERE key=?", (STATE_KEY + str(job_id),)).fetchone()
        value = json.loads(row[0]) if row else {}
    except (TypeError, ValueError):
        value = {}
    return value if isinstance(value, dict) else {}


def save_state(registry, job_id, **changes) -> dict:
    import contextlib
    with contextlib.nullcontext() if registry.db.in_transaction else registry.transaction():
        value = {**state(registry.db, job_id), **changes}
        registry.db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)",
                            (STATE_KEY + job_id, json.dumps(value, ensure_ascii=False)))
    return value


def job_dir(registry, pip_id, job_id) -> Path:
    """The job's own folder, next to the Pip's state: <state>/pips/<pip>/agents/<job>."""
    from .pip_agents import short
    return Path(registry.directory) / "pips" / str(pip_id) / "agents" / short(job_id)


def sessions_dir(registry, pip_id, job_id) -> Path:
    return job_dir(registry, pip_id, job_id) / "sessions"


def _private_tree(registry, path: Path) -> None:
    from .workspace_registry import _private_directory
    base = Path(registry.directory)
    current = base
    for part in path.relative_to(base).parts:
        current = current / part
        _private_directory(current)


def words_of(value) -> list[str]:
    """The user's own words a job carries, bounded."""
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str) and item.strip():
            text = item.strip()[:4000]
            if text not in out:
                out.append(text)
    return out[:MAX_WORDS]


# ---- where and on what --------------------------------------------------------------------------------------------
def folder_of(store, pip_id) -> Path:
    """The Pip's real project folder (its workspace binding's canonical root), or refused in plain words."""
    pip = store._job(pip_id)
    if pip.get("source_policy") == {"mode": "personal"}:
        raise RegistryError("invalid_request", NOT_FOLDER)
    workspace = store.registry.get(pip["workspace_id"])
    if workspace.get("kind") == "personal":
        raise RegistryError("invalid_request", NOT_FOLDER)
    root = Path(store.registry.binding(pip["workspace_id"])["canonical_root"])
    if not root.is_dir():
        raise RegistryError("unavailable", NO_FOLDER)
    return root


def route_check(store, config, pip_id) -> None:
    """Its model is the Pip's Sub-agents model, else the Pip's own: never a subscription CLI or DGC Router."""
    from . import pip_agents
    from . import pips as pips_module
    pip = store._job(pip_id)
    choice = pip_agents.own_choice(pip_agents.agents_model(store.registry, pip_id)) or pip["model_choice"]
    if isinstance(choice, dict) and choice.get("mode") in ("subscription", "router"):
        raise RegistryError("unsupported_model", NO_ENGINE)
    settings = pips_module._model_settings(config.clone_for_root(folder_of(store, pip_id)), choice)
    if not isinstance(settings, dict) or settings.get("brain") is not None or settings.get("router") is not None:
        raise RegistryError("unsupported_model", NO_ENGINE)


def first_prompt(store, job, words) -> str:
    pip = store._job(job["pip_id"])
    name = " ".join(str(pip.get("name") or "A Pip").split())[:80]
    folder = Path(job["folder"] or "").name or "folder"
    quoted = "\n".join(f"[{n}] {w}" for n, w in enumerate(words, 1))
    said = THEIRS.format(quoted=quoted) if words else NONE_THEIRS.format(pip=name)
    return FIRST.format(pip=name, folder=folder, words=said, title=job["title"], brief=job["brief"])


def retry_prompt(store, job, *, carry=False) -> str:
    pip = store._job(job["pip_id"])
    name = " ".join(str(pip.get("name") or "Its Pip").split())[:80]
    from .pip_agents import MAX_TRIES
    if carry:
        return CARRY.format(notes=job["notes"] or "", title=job["title"])
    return AGAIN.format(n=job["tries"] + 1, most=MAX_TRIES, pip=name, notes=job["notes"] or "it was not right yet",
                        title=job["title"])


def fix_brief(pip_name, folder, findings) -> str:
    lines = []
    for number, finding in enumerate(findings, 1):
        where = (f" — {finding['path']}" + (f":{finding['line']}" if finding.get("line") else "")) if finding.get("path") else ""
        lines.append(f"{number}. [{finding.get('severity', 'low')}] {finding.get('title', '')}{where}")
        if finding.get("evidence"):
            lines.append("   Evidence: " + " ".join(str(finding["evidence"]).split())[:400])
    return FIX_TEXT.format(pip=pip_name, folder=folder or "the project", findings="\n".join(lines))


def pressed_words(findings) -> list[str]:
    """The user's press on a fix's "Start a sub-agent with Work tools", as their words: fix these, on my real folder."""
    named = "; ".join(f"{f.get('title', '')}" + (f" ({f['path']}" + (f":{f['line']}" if f.get("line") else "") + ")"
                                                   if f.get("path") else "") for f in findings[:8])
    return [f"Start a sub-agent with Work tools on my real folder to fix: {named}"[:4000]]


# ---- the run: a real Work run, in the folder ---------------------------------------------------------------------
def _trusted(config, root) -> bool:
    try:
        from .trust import is_trusted
        return bool(is_trusted(config, root))
    except Exception:                        # noqa: BLE001 -- can't tell: say so on its command line
        return False


def _child_env(root, sessions, words, key, trusted=True) -> dict:
    from .auto_guard import USER_WORDS_ENV
    from .auto_holds import GUARD_ENV
    from .launch import HANDOFF
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("DGC_PIP_") and k not in ("DGC_SESSION_POLICY", "DGC_API_KEY", "DGC_API_KEY_FILE",
                                                         HANDOFF, KEY_ENV)}
    env.update({"DGC_SESSIONS_DIR": str(sessions), "DGC_PROJECT_ROOT": str(root), GUARD_ENV: "1",
                USER_WORDS_ENV: json.dumps(words, ensure_ascii=False), "PYTHONDONTWRITEBYTECODE": "1"})
    if key:
        env[KEY_ENV] = key                   # its key: this child's environment only, never a command line
    if not trusted:
        # The user's press, or Do it all, is their yes to this run in this folder: trusted for this run only, never
        # saved, so their own Work still asks about the folder as before.
        env["DGC_TRUST_THIS_RUN"] = "1"
    return env


def _argv(settings, session, trusted, keyed) -> list[str]:
    from .sandbox import _OWN_DGC_BOOTSTRAP
    package = str(Path(__file__).resolve().parents[1])
    argv = [sys.executable, "-c", _OWN_DGC_BOOTSTRAP, package, "-p", "-", "--output-format", "json", "--mode", "auto",
            "--engine", "native", "--model", str(settings["model"]), "--base-url", str(settings["base_url"]),
            "--api-mode", str(settings.get("api_mode") or "auto")]
    if keyed:
        argv += ["--api-key-env", KEY_ENV]   # the name only: its value is in the child's environment
    if settings.get("thinking") in ("off", "low", "medium", "high", "xhigh"):
        argv += ["--think", settings["thinking"]]
    if session:
        argv += ["--resume", session]
    return argv


def _tree(pid) -> list[int]:
    """pid and every process below it, from the process table (Linux and macOS), deepest last."""
    try:
        done = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=5, env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.SubprocessError):
        return [pid]
    children: dict[int, list[int]] = {}
    for line in done.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    out, queue = [], [pid]
    while queue and len(out) < 4096:
        current = queue.pop(0)
        out.append(current)
        queue.extend(children.get(current, []))
    return out


def end_tree(pid, *, grace=3.0) -> None:
    """Stop the child and everything it started: each process group under it (a command DGC runs is a group of its own),
    SIGTERM, then SIGKILL for what is left. Never this process's own group."""
    if os.name != "posix" or not pid:
        return
    own = os.getpgid(0)
    groups = []
    for member in _tree(pid):
        try:
            group = os.getpgid(member)
        except OSError:
            continue
        if group != own and group not in groups:
            groups.append(group)
    if pid not in groups:
        groups.insert(0, pid)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for group in groups:
            try:
                os.killpg(group, sig)
            except OSError:
                pass
        if sig == signal.SIGTERM:
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                alive = False
                for group in groups:
                    try:
                        os.killpg(group, 0)
                        alive = True
                    except OSError:
                        pass
                if not alive:
                    return
                time.sleep(0.05)


def _progress(event) -> dict | None:
    """The child's event as the run's activity shows a step (the shapes a Pip's own run uses)."""
    kind = event.get("type")
    clip = lambda v, n: str(v or "")[:n]          # noqa: E731
    if kind == "tool_call":
        args = event.get("args") if isinstance(event.get("args"), dict) else {}
        return {"kind": "tool_call", "tool": clip(event.get("name"), 80), "call_id": clip(event.get("call_id"), 120),
                "path": clip(args.get("path"), 512)}
    if kind == "tool_result":
        out = str(event.get("output") or "")
        failed = out.lower().startswith(("error:", "permission denied:", "blocked by dgc's safety check"))
        return {"kind": "tool_result", "tool": clip(event.get("name"), 80), "call_id": clip(event.get("call_id"), 120),
                "status": "failed" if failed else "completed"}
    if kind == "tool_denied":
        return {"kind": "tool_denied", "tool": clip(event.get("name"), 80), "message": clip(event.get("reason"), 500)}
    if kind == "info" and str(event.get("message") or "").strip():
        return {"kind": "progress", "message": " ".join(str(event["message"]).split())[:200]}
    if kind == "error":
        return {"kind": "error", "message": clip(event.get("message"), 1000)}
    return None


def execute(registry, row, manifest, config, frozen_config) -> dict:
    """In the Pips runner (pips._execute_run): its try, a real Work run in the folder. Returns {text, usage}; raises
    RegistryError("cancelled") when it was stopped (Stop, Pips stopped), else in plain words why it ended badly."""
    from . import pip_agents
    from .pip_daemon import is_runtime_paused
    from .pips import PipStore
    from .redaction import redact_text, redact_value, secret_values
    db = registry.db
    agent = manifest.get("agent") if isinstance(manifest.get("agent"), dict) else {}
    job = pip_agents._row(db, str(agent.get("job_id") or ""))
    if job is None or job["kind"] != KIND or job["run_id"] != row["id"] or job["pip_id"] != row["pip_id"]:
        raise RegistryError("invalid_request", "This run isn't a sub-agent with Work tools.")
    settings = manifest.get("model_settings") if isinstance(manifest.get("model_settings"), dict) else {}
    if settings.get("brain") is not None or settings.get("router") is not None or not settings.get("base_url"):
        raise RegistryError("unsupported_model", NO_ENGINE)
    root = Path(registry.binding(row["workspace_id"])["canonical_root"])
    if not root.is_dir():
        raise RegistryError("unavailable", NO_FOLDER)
    key = str(frozen_config.get("api_key", "") or "")
    kept = state(db, job["id"])
    words = words_of(kept.get("words"))
    sessions = sessions_dir(registry, job["pip_id"], job["id"])
    _private_tree(registry, sessions)
    from .pip_run_inputs import turn_text
    text = turn_text(db, row["id"], manifest) or str((manifest.get("conversation") or {}).get("text") or "")
    secrets = tuple(set(secret_values(config)) | set(secret_values(frozen_config)) | ({key} if key else set()))
    trusted = _trusted(config, root)
    argv = _argv(settings, str(kept.get("session") or ""), trusted, bool(key))
    proc = subprocess.Popen(argv, cwd=str(root), env=_child_env(root, sessions, words, key, trusted), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=os.name == "posix")
    from .monitors import _watchdog                    # the runner dies unassisted: the child goes with it
    _watchdog.add(proc.pid)
    save_state(registry, job["id"], pid=proc.pid)
    stop, cancelled, lost, quiet = threading.Event(), threading.Event(), threading.Event(), threading.Event()
    tail: list[str] = []
    heard = [time.monotonic()]                         # when it last said anything (an event, a line of its errors)

    def watch():
        try:
            from .workspace_registry import WorkspaceRegistry
            with WorkspaceRegistry(registry.directory) as watcher:
                while not stop.wait(0.2):
                    if config.get("pips_enabled", False) is not True or is_runtime_paused(watcher):
                        PipStore(watcher).cancel(row["id"], "runner-stop")
                    status = watcher.db.execute("SELECT status FROM pip_runs WHERE id=?", (row["id"],)).fetchone()
                    if not status or status[0] == "cancelling":
                        cancelled.set()
                        end_tree(proc.pid)
                        return
                    if time.monotonic() - heard[0] > QUIET_SECONDS:
                        quiet.set()                    # longer than any one command may run: stuck
                        end_tree(proc.pid)
                        return
        except Exception:                              # noqa: BLE001 -- no state to watch: never run unwatched
            lost.set()
            end_tree(proc.pid)

    def errors():
        for line in proc.stderr:
            heard[0] = time.monotonic()
            tail.append(line.decode("utf-8", "replace"))
            del tail[:-40]

    watcher = threading.Thread(target=watch, name="dgc-work-agent-watch", daemon=True)
    reader = threading.Thread(target=errors, name="dgc-work-agent-stderr", daemon=True)
    result, failure = None, ""
    try:
        watcher.start()
        reader.start()
        try:
            proc.stdin.write(text.encode("utf-8", "replace"))
            proc.stdin.close()
        except OSError:
            pass
        skipping = False
        while True:
            line = proc.stdout.readline(MAX_EVENT_BYTES + 1)
            if not line:
                break
            heard[0] = time.monotonic()
            if skipping or len(line) > MAX_EVENT_BYTES:
                skipping = not line.endswith(b"\n")        # one oversized event is passed over, never held whole
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            event = redact_value(event, secrets)
            kind = event.get("type")
            if kind in ("turn_start", "result") and isinstance(event.get("session_id"), str) and \
                    re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", event["session_id"]) and event["session_id"] != kept.get("session"):
                kept["session"] = event["session_id"]
                save_state(registry, job["id"], session=event["session_id"])
            if kind == "result":
                result = event
            elif kind == "error" and not failure:
                failure = str(event.get("message") or "")[:1000]
            shown = _progress(event)
            if shown is not None:
                registry.event(row["workspace_id"], "pip_run_progress", pip_id=row["pip_id"], run_id=row["id"],
                               payload=shown)
        proc.wait()
    finally:
        stop.set()
        if proc.poll() is None:
            end_tree(proc.pid)
            proc.wait()
        _watchdog.remove(proc.pid)
        watcher.join(timeout=10)
        reader.join(timeout=5)
        for stream in (proc.stdout, proc.stderr):
            try:
                stream.close()
            except OSError:
                pass
        save_state(registry, job["id"], pid=None)
        try:
            remember_changes(registry, pip_agents._row(db, job["id"]))
        except Exception:                              # noqa: BLE001 -- its card says what it can
            pass
    if cancelled.is_set():
        raise RegistryError("cancelled", "The sub-agent with Work tools was stopped.")
    if quiet.is_set():
        raise RegistryError("worker_failed", f"The Work run went quiet for {int(QUIET_SECONDS // 60)} minutes (no step, no "
                            "words), longer than any one command may take, so DGC stopped it. What it changed stays, "
                            "with Undo.")
    if lost.is_set():
        raise RegistryError("runner_state_unavailable", "It stopped because its runner's state could not be checked.")
    if not isinstance(result, dict):
        said = redact_text("".join(tail).strip().splitlines()[-1] if "".join(tail).strip() else "", secrets)
        raise RegistryError("worker_failed", "The Work run stopped before it said what it did" + (f": {said[:300]}" if said else "."))
    words_said = str(result.get("text") or "")
    if result.get("ok") is not True:
        raise RegistryError("model_error", (failure or words_said or "The Work run ended with an error.")[:1500])
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    return {"text": words_said[:60_000] or "(It said nothing.)",
            "usage": {k: int(v) for k, v in usage.items() if k in ("input_tokens", "output_tokens") and type(v) is int and v >= 0}}


# ---- what it changed: the session's checkpoints ---------------------------------------------------------------------
def _session_file(registry, job) -> Path | None:
    kept = state(registry.db, job["id"])
    session = str(kept.get("session") or "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", session):
        return None
    folder = sessions_dir(registry, job["pip_id"], job["id"])
    if not folder.is_dir():
        return None
    found = [p for p in folder.glob(f"*/{session}.json") if p.is_file() and not p.is_symlink()]
    return found[0] if found else None


def _manager(registry, job):
    """Its session's Work checkpoints, loaded fail-closed (CheckpointManager.from_state), or None."""
    path = _session_file(registry, job)
    if path is None or not job["folder"]:
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    from .checkpoints import CheckpointManager
    value = record.get("checkpoints") if isinstance(record, dict) else None
    return CheckpointManager.from_state(value if isinstance(value, dict) else {}, Path(job["folder"]))


def _rel(manager, path) -> str:
    return manager._lexical_project_path(path) or str(path)


def _earliest(manager) -> dict:
    out = {}
    for point in list(manager.points):
        for path, prior in list(point["files"].items()):
            out.setdefault(path, prior)
    return out


def changes(registry, job) -> list[dict]:
    """What the job changed in the folder since it began: {path (in the folder), status new | modified | deleted,
    additions, deletions, counted, command (a command changed it)}; what running code leaves behind is left out."""
    manager = _manager(registry, job)
    if manager is None or not manager.points:
        return []
    from .pip_project_copies import leftover
    rows, _total = manager.changes(0, commands=True)
    out = []
    for row in rows:
        rel = _rel(manager, row["path"])
        if leftover(rel):
            continue
        out.append({"path": rel, "status": row["status"], "additions": int(row.get("additions") or 0),
                    "deletions": int(row.get("deletions") or 0), "counted": bool(row.get("counted")),
                    **({"command": True} if row.get("command") or row.get("by_command") else {})})
    return out


def remember_changes(registry, job) -> list[dict]:
    if job is None or job["kind"] != KIND:
        return []
    files = changes(registry, job)
    save_state(registry, job["id"], changed=files[:MAX_CHANGED], changed_more=max(0, len(files) - MAX_CHANGED))
    return files


def diff_text(registry, job, files) -> str:
    """The change as a unified diff of each file before the job against the file now, clipped for the Pip's check."""
    import difflib
    manager = _manager(registry, job)
    if manager is None:
        return ""
    from .checkpoints import _Snapshot
    earliest = {_rel(manager, path): prior for path, prior in _earliest(manager).items()}
    root = Path(job["folder"])
    parts, used = [], 0

    def lines(data):
        if data is None:
            return []
        if b"\x00" in data[:8192]:
            return "binary"
        if len(data) > 2_000_000:
            return None
        return data.decode("utf-8", errors="replace").splitlines(keepends=True)
    for f in files:
        rel = f["path"]
        prior = earliest.get(rel)
        if f.get("command") and prior is None:
            chunk = f"--- {rel} ({f['status']} by a command it ran, not shown)\n"
        else:
            before = (prior.data if isinstance(prior, _Snapshot) and prior.kind == "file" else
                      None if prior is None or (isinstance(prior, _Snapshot) and prior.kind == "missing") else
                      str(prior).encode() if not isinstance(prior, _Snapshot) else b"")
            try:
                target = root / rel
                now = target.read_bytes() if target.is_file() and not target.is_symlink() else None
            except OSError:
                now = None
            old, new = lines(before), lines(now)
            if old == "binary" or new == "binary":
                chunk = f"--- {rel} (binary, {f['status']}, not shown)\n"
            elif old is None and before is not None or new is None and now is not None:
                chunk = f"--- {rel} (too big to show)\n"
            else:
                chunk = "".join(difflib.unified_diff(old or [], new or [], f"a/{rel}", f"b/{rel}"))
        if used + len(chunk) > DIFF_MOST:
            parts.append(f"… and {len(files) - len(parts)} more file(s) not shown.\n")
            break
        parts.append(chunk)
        used += len(chunk)
    return "".join(parts)


# ---- Undo ---------------------------------------------------------------------------------------------------------
def undo(store, pip_id, job_id, actor) -> dict:
    """undo_pip_agent_job: the folder back to before the job, through its session's checkpoints, with Work's own rule:
    a file the user changed since keeps their edits (merged) or, where that can't be told apart, is named and left."""
    from . import pip_agents
    from .pip_fixes import LOCAL
    if actor not in LOCAL:
        raise RegistryError("forbidden", "Only you undo what a sub-agent changed, on this computer.")
    registry, db = store.registry, store.db
    if not isinstance(job_id, str) or not re.fullmatch(r"pipagent_[0-9a-f]{32}", job_id):
        raise RegistryError("invalid_request", "Choose one of this Pip's sub-agents.")
    job = pip_agents._row(db, job_id)
    if job is None or job["pip_id"] != pip_id:
        raise RegistryError("not_found", "That sub-agent isn't this Pip's.")
    if job["kind"] != KIND:
        raise RegistryError("invalid_request", "Only a sub-agent with Work tools changed your folder itself.")
    if job["state"] in pip_agents.LIVE:
        raise RegistryError("invalid_state", "It is still working. Stop it first, then undo.")
    kept = state(db, job_id)
    if kept.get("undo"):
        raise RegistryError("invalid_state", "What it changed was undone already.")
    manager = _manager(registry, job)
    if manager is None or not manager.points:
        raise RegistryError("invalid_state", "There is nothing of it to undo.")
    before = {_rel(manager, row["path"]) for row in manager.changes(0)[0]}
    plan = manager.undo_plan(0)
    held = [h["path"] for h in plan["held"]]
    count, _restored, _ = manager.rewind_state(0, keep=held)
    if count == -1:
        raise RegistryError("conflict", "Undo couldn't put it back: " + (manager.last_rewind_error or ", ".join(
            _rel(manager, p) for p in manager.last_rewind_conflicts[:8]) or "a file changed meanwhile") + ".")
    reasons = {h["path"]: h["reason"] for h in plan["held"]}
    left = [{"path": _rel(manager, p), "why": "you changed it since"
             if reasons.get(p) in ("overlap", "changed", "deleted", "mode") else "it couldn't be put back safely"}
            for p in held]
    left += [{"path": _rel(manager, p), "why": "a command it ran changed it"} for p in manager.last_rewind_left]
    kept_by_you = {item["path"] for item in left}
    merged = sorted(_rel(manager, p) for p in manager.last_rewind_merged)
    restored = sorted(p for p in before if p not in kept_by_you)
    outcome = {"restored": restored, "merged": merged, "left": left[:50], "at": registry.clock(), "by": actor}
    save_state(registry, job_id, undo=outcome)
    said = (f"Undone: {len(restored)} file{'s' if len(restored) != 1 else ''} put back."
            + (f" Left as {'they are' if len(left) != 1 else 'it is'}: " + ", ".join(i["path"] for i in left[:5])
               + (" and more" if len(left) > 5 else "") + "." if left else ""))
    with registry.transaction():
        registry.event(job["workspace_id"], "pip_agent_undone", pip_id=pip_id, run_id=job["run_id"],
                       payload={"job_id": job_id, "restored": len(restored), "left": len(left)})
        if job["fix_id"] and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_fixes'").fetchone():
            db.execute("UPDATE pip_fixes SET message=?,revision=revision+1,updated_at=? WHERE id=?",
                       (said[:600], registry.clock(), job["fix_id"]))
    remember_changes(registry, pip_agents._row(db, job_id))
    return {"agent": pip_agents.view(db, pip_agents._row(db, job_id)), "undo": outcome}


def view_fields(db, job) -> dict:
    """What a work job's view adds (pip_agents.view): what it changed, and its Undo."""
    kept = state(db, job["id"])
    from . import pip_agents
    changed = [f for f in kept.get("changed") or [] if isinstance(f, dict)][:MAX_CHANGED]
    undone = kept.get("undo") if isinstance(kept.get("undo"), dict) else None
    return {"changed": changed, "changed_more": int(kept.get("changed_more") or 0),
            **({"from_run_id": kept["from_run_id"]} if isinstance(kept.get("from_run_id"), str) else {}),
            "can_undo": bool(changed) and undone is None and job["state"] not in pip_agents.LIVE,
            **({"undo": {k: undone.get(k) for k in ("restored", "merged", "left", "at")}} if undone else {})}


# ---- the Pip's own tool, at Do it all -----------------------------------------------------------------------------
def runtime(registry, row, manifest) -> dict:
    """In the supervisor, as a run starts: a folder Pip's own chat turn (or its routine's) at Do it all is offered
    start_work_subagent (the pin). Never in a sub-agent's run, the Pip's check of one, or a fix's turn."""
    if manifest.get("run_kind") != "conversation" or not isinstance(manifest.get("conversation"), dict):
        return manifest
    if manifest.get("agent") or PIN in manifest:
        return {k: v for k, v in manifest.items() if k != PIN} if PIN in manifest else manifest
    try:
        from . import pip_levels
        from .pip_agents import CHECK_KEY
        from .pip_fixes import FIX_KEY
        from .pips import PipStore
        if pip_levels.effective(registry, row["pip_id"]) != pip_levels.FULL:
            return manifest
        message = registry.db.execute("SELECT request_key FROM pip_chat_messages WHERE run_id=? AND role='user' "
                                      "ORDER BY seq LIMIT 1", (row["id"],)).fetchone()
        if message is not None and str(message[0] or "").startswith((CHECK_KEY, FIX_KEY)):
            return manifest
        root = folder_of(PipStore(registry), row["pip_id"])
    except (RegistryError, OSError, KeyError, TypeError):
        return manifest
    return {**manifest, PIN: {"folder": root.name[:120]}}


def schema() -> dict:
    return {"type": "function", "function": {"name": TOOL, "description": (
        "Start a sub-agent with Work tools on the user's REAL project folder, for a fix your own copy can't do: it needs "
        "a file Git ignores (like .env) or a service to run. It has a Work session's full tools there, and what it "
        "changes is in the user's folder at once (they can undo it). You check its work when it ends, as with your "
        "other sub-agents. Use it only when your copy truly can't do the job, and say so in your reply."),
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string", "description": "the job in a few words, like \"Load settings from .env\""},
            "brief": {"type": "string", "description": "what it must do and why your copy can't: the files, the "
                                                         "commands, what done looks like"},
            "fix_id": {"type": "string", "description": "the fix it is for (pipfix_...), when it is one; else \"\""}},
            "required": ["title", "brief"], "additionalProperties": False}}}


def tool_result(arguments, already: int) -> tuple[dict | None, str]:
    """In the worker: (the job to start as the reply is kept, what the tool says)."""
    args = arguments if isinstance(arguments, dict) else {}
    title = " ".join(str(args.get("title") or "").split())[:200]
    brief = str(args.get("brief") or "").strip()[:MAX_BRIEF]
    fix = str(args.get("fix_id") or "").strip()
    if already >= MAX_PER_REPLY:
        return None, "Not started: one reply starts at most two sub-agents with Work tools."
    if not title or not brief:
        return None, "Not started: give it a title and a brief."
    if fix and not re.fullmatch(r"pipfix_[0-9a-f]{32}", fix):
        return None, "Not started: fix_id is one of your fixes (pipfix_...), or \"\"."
    return ({"title": title, "brief": brief, **({"fix_id": fix} if fix else {})},
            "It starts as your reply is kept, in a slot of your sub-agents; you check its work when it ends. Tell the "
            "user in one short sentence that a sub-agent with Work tools is working on their real folder.")


def valid_candidates(value) -> list[dict] | None:
    if not isinstance(value, list) or len(value) > MAX_PER_REPLY:
        return None
    out = []
    for item in value:
        if (not isinstance(item, dict) or set(item) - {"title", "brief", "fix_id"} or not isinstance(item.get("title"), str)
                or not isinstance(item.get("brief"), str) or not item["title"].strip() or not item["brief"].strip()
                or len(item["title"]) > 200 or len(item["brief"]) > MAX_BRIEF
                or ("fix_id" in item and not (isinstance(item["fix_id"], str)
                                              and re.fullmatch(r"pipfix_[0-9a-f]{32}", item["fix_id"])))):
            return None
        out.append(item)
    return out


def commit(store, run, result) -> None:
    """In the supervisor, as a chat reply is kept (pip_chat.insert_reply): what its start_work_subagent asked for,
    checked again here (never the worker's word): Do it all now, a folder Pip's own chat turn. Each is a queued job;
    the next tick starts it (pip_agents.send_due), in a slot of its sub-agents."""
    asked = result.get("work_subagents") if isinstance(result, dict) else None
    if asked is None:
        return
    asked = valid_candidates(asked)
    if asked is None:
        raise RegistryError("invalid_reply", "This reply's sub-agents with Work tools are invalid.")
    from . import pip_agents, pip_levels
    from .pip_notes import user_turn
    registry, db = store.registry, store.db
    manifest = run.get("manifest") if isinstance(run.get("manifest"), dict) else {}
    if manifest.get("agent") or manifest.get("run_kind") != "conversation":
        return
    if pip_levels.effective(registry, run["pip_id"]) != pip_levels.FULL:
        return                                        # below Do it all the Pip never starts one: the fix card does
    try:
        root = folder_of(store, run["pip_id"])
    except RegistryError:
        return
    message = db.execute("SELECT request_key FROM pip_chat_messages WHERE run_id=? AND role='user' ORDER BY seq LIMIT 1",
                         (run["id"],)).fetchone()
    from .pip_fixes import FIX_KEY
    if message is not None and str(message[0] or "").startswith((pip_agents.CHECK_KEY, FIX_KEY)):
        return
    said = user_turn(registry, run)
    if not said:
        # A routine's turn: the words the user gave that routine are theirs (pip_routines.split_turn); what started it
        # (an email, an app's event) never is.
        try:
            from .pip_routines import split_turn
            from .pip_run_inputs import turn_text
            said = split_turn(registry, run["id"], turn_text(db, run["id"], manifest))[0]
        except Exception:                                # noqa: BLE001 -- none of theirs: none
            said = ""
    words = words_of([said] if said else [])
    pip_agents.ensure(db)
    for item in asked:
        fix_id = item.get("fix_id")
        if fix_id and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_fixes'").fetchone():
            if db.execute("SELECT 1 FROM pip_fixes WHERE id=? AND pip_id=?", (fix_id, run["pip_id"])).fetchone() is None:
                fix_id = None
        else:
            fix_id = None
        job_id = pip_agents.insert_queued(store, run["pip_id"], kind=KIND, title=item["title"], brief=item["brief"],
                                          fix_id=fix_id, folder=str(root), words=words)
        save_state(registry, job_id, from_run_id=run["id"])     # the reply that started it, where the chat shows it
