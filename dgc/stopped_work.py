"""Background work a restart stopped: commands and sub-agents are shown, never re-run on their own; Troupes resume.

When DGC stops while a chat has work running in the background -- a window reload with nothing kept alive, a lost
connection, the machine restarting, a killed backend -- that work stops with it. dgc.monitor_restart starts a chat's
monitors again when it is opened; this module is the rest of that fallback:

- **Background commands** (`bash` with background: true) and **sub-agents** that were running are shown in the chat as
  "stopped by a restart" (event `task_interrupted`), with Run again: the same command in the same folder, or the same
  task from scratch. Never run again on their own: a command or a task may not be safe to repeat, and only the user
  can say it is. A sub-agent's own conversation is not saved, so it cannot continue where it was; its Resume is a new
  sub-agent given the original task and what the stopped one left (the steps it had taken, and its unmerged work
  when DGC kept it as a retained task).
- **Troupes** pick up where they stopped: their journal (`~/.dgc/troupes/<id>/results.jsonl`) keeps every finished
  agent's result, so resuming re-runs only the unfinished ones. Under the permissions in force now; when those would
  not start it, it is shown stopped with Resume.

The model is told which ones stopped, in the same note that tells it about its monitors.

This is the fallback for when nothing could stay alive. It is keyed, like the monitors', on the process that ran the
work having actually ended: a DGC that kept the session running through a reload still owns its work, and nothing here
touches it.

The journal is ``<session>.tasks`` beside the transcript, written like ``<session>.monitors``: one record per command,
sub-agent or troupe this chat started, at most ``MAX_RECORDS``, and how each one ended. Only "dgc_stopped" (or still
"running" under an owner that is gone) is work a restart stopped.
"""
from __future__ import annotations

import copy
import re
import threading
import time
import uuid

from . import monitor_restart as journal

SUFFIX = ".tasks"
MAX_RECORDS = 16
MAX_PROMPT_CHARS = 16_000
KINDS = ("shell", "agent", "troupe")
# reported: shown once as stopped by a restart (Run again still works); rerun: the user ran it again.
ENDS = ("exited", "killed", "finished", "failed", "stopped", "done", "rewound", "dgc_stopped", "reported", "rerun")
WORDS = {"shell": "Background command", "agent": "Sub-agent", "troupe": "Troupe"}


def _clean(record) -> dict | None:
    if not isinstance(record, dict) or record.get("kind") not in KINDS:
        return None
    if not (isinstance(record.get("key"), str) and re.fullmatch(r"[0-9a-f]{12}", record["key"])):
        return None
    if not isinstance(record.get("id"), str) or not record["id"] or len(record["id"]) > 64:
        return None
    if record.get("state") not in ("running", "ended"):
        return None
    if record.get("state") == "ended" and record.get("end") not in ENDS:
        return None
    if not isinstance(record.get("started_at"), (int, float)) or isinstance(record.get("started_at"), bool):
        return None
    return record


def read(target) -> list:
    return journal.read(*target, suffix=SUFFIX, clean=_clean) if target else []


def update(target, mutate) -> bool:
    return journal.update(*target, mutate, suffix=SUFFIX, clean=_clean, limit=MAX_RECORDS) if target else False


def _target(agent):
    get = getattr(agent, "_monitor_journal_target", None)
    return get() if callable(get) else None


def _new(kind: str, identity: str, **fields) -> dict:
    now = time.time()
    return {"key": uuid.uuid4().hex[:12], "kind": kind, "id": str(identity)[:64], "state": "running",
            "owner": journal.owner(), "started_at": now, **fields}


def _end(target, key: str, end: str, *, only_running: bool = True, **extra) -> None:
    now = time.time()

    def mutate(records):
        for record in records:
            if record.get("key") == key and (record.get("state") == "running" or not only_running):
                record.update({"state": "ended", "end": end, "ended_at": record.get("ended_at") or now, **extra})
    update(target, mutate)


# ---- what is written down as it happens ----------------------------------------------------------------------------
def shell_started(entry: dict, bid: str, command: str, ctx, *, sandboxed: bool) -> None:
    """A top-level chat's background command started (dgc.tools._bash_background)."""
    hub = getattr(ctx, "monitors", None)
    target = hub._journal_target() if hub is not None and hasattr(hub, "_journal_target") else None
    if target is None:
        return
    from .redaction import contains_secret, secret_values
    secret = contains_secret(command, secret_values(getattr(ctx, "config", None)))
    record = _new("shell", bid, command="" if secret else command, secret=secret,
                  label=str(entry.get("command") or "")[:400], cwd=str(getattr(ctx, "project_root", "") or ""),
                  sandboxed=bool(sandboxed))
    entry["journal"] = (target, record["key"])
    update(target, lambda records: records.append(record))


def shell_ended(entry: dict, end: str) -> None:
    where = entry.get("journal")
    if where:
        entry["journal"] = None                      # once: the first word on how it ended stands
        _end(where[0], where[1], end)


def agent_started(parent, agent_id: str, description: str, prompt: str, agent_name: str, *,
                  background: bool, call_id, workspace=None) -> None:
    """A top-level chat's sub-agent started (Agent._run_subagent)."""
    target = _target(parent) if getattr(parent, "depth", 1) == 0 else None
    if target is None or not agent_id:
        return
    from .redaction import contains_secret
    secrets = parent._secret_values() if hasattr(parent, "_secret_values") else ()
    secret = contains_secret(prompt, secrets)
    record = _new("agent", agent_id, description=str(description or "")[:200],
                  prompt="" if secret or len(prompt) > MAX_PROMPT_CHARS else prompt,
                  secret=secret, agent=str(agent_name or "")[:80], background=bool(background),
                  call_id=str(call_id or "")[:128],
                  workspace=str(getattr(workspace, "project_root", "") or ""))
    update(target, lambda records: records.append(record))


def agent_backgrounded(parent, agent_id: str) -> None:
    """A foreground sub-agent the person moved to the background (dgc/background_now.py)."""
    target = _target(parent) if getattr(parent, "depth", 1) == 0 else None
    if target is None or not agent_id:
        return

    def mutate(records):
        for record in records:
            if record.get("kind") == "agent" and record.get("id") == agent_id and record.get("state") == "running":
                record["background"] = True
    update(target, mutate)


def agent_ended(parent, agent_id: str, state: str) -> None:
    target = _target(parent) if getattr(parent, "depth", 1) == 0 else None
    if target is None or not agent_id:
        return
    end = "dgc_stopped" if getattr(parent, "stopping", False) else (state if state in ENDS else "failed")
    now = time.time()

    def mutate(records):
        for record in records:
            if record.get("kind") == "agent" and record.get("id") == agent_id and record.get("state") == "running":
                record.update({"state": "ended", "end": end, "ended_at": now})
    update(target, mutate)


def troupe_started(agent, run) -> None:
    target = _target(agent)
    if target is None:
        return
    record = _new("troupe", run.id, title=str(getattr(run.plan, "title", "") or "")[:200],
                  template=str(getattr(run.plan, "template", "") or "")[:40],
                  permission={"mode": getattr(agent, "mode", "")})
    run.journal = (target, record["key"])
    update(target, lambda records: records.append(record))


def troupe_ended(agent, run) -> None:
    where = getattr(run, "journal", None)
    if not where:
        return
    run.journal = None
    state = getattr(run, "state", "")
    _end(where[0], where[1], "dgc_stopped" if getattr(agent, "stopping", False) else
         {"done": "done", "failed": "failed"}.get(state, "stopped"))


def chat_stopping(agent, *, end: str = "dgc_stopped") -> None:
    """The chat or DGC is going away (Agent.stop_detached with no id): its sub-agents and troupes did not end by
    request. Written before they are signalled, as a monitor's end is."""
    target = _target(agent)
    if target is None:
        return
    now = time.time()
    me = journal.owner()

    def mutate(records):
        for record in records:
            if (record.get("kind") in ("agent", "troupe") and record.get("state") == "running"
                    and (record.get("owner") or {}).get("pid") == me.get("pid")):
                record.update({"state": "ended", "end": end, "ended_at": now})
    update(target, mutate)


# ---- reopening -----------------------------------------------------------------------------------------------------
def _due(record: dict, me: dict) -> bool:
    """DGC's stopping ended it and the process that ran it has ended (see dgc.monitor_restart.due)."""
    return journal.due(record, me)


def awaited_keys(agent) -> set:
    me = journal.owner()
    return {r["key"] for r in read(_target(agent)) if journal.awaited(r, me)}


def _name(record: dict) -> str:
    text = record.get("description") or record.get("title") or record.get("label") or record.get("id")
    return " ".join(str(text).split()).replace('"', "'")[:80]


def _stopped_at(record: dict) -> float:
    at = record.get("ended_at") if record.get("state") == "ended" else None
    return float(at) if isinstance(at, (int, float)) else float(record["started_at"])


def _outcome(record, state, message, note, *, actions=(), by_user=False, new_id="") -> "journal.Outcome":
    return journal.Outcome(key=record["key"], id=new_id or record["id"], description=_name(record),
                           command=str(record.get("label") or "")[:400], state=state, message=message, note=note,
                           stopped_at=_stopped_at(record), at=time.time(), restart=bool(actions), by_user=by_user,
                           kind=record["kind"], actions=tuple(actions))


def _report(record) -> "journal.Outcome":
    name, since = _name(record), journal._clock(_stopped_at(record), time.time())
    if record["kind"] == "shell":
        what = f"`{record.get('label') or record['id']}`"
        return _outcome(record, "stopped",
                        f"Background command {what} was stopped by a restart at about {since}. It was not run again: "
                        "a command may not be safe to repeat.",
                        f"background command {record['id']} {what} was running and stopped when DGC stopped (about "
                        f"{since}); it was NOT run again, because a command may not be safe to repeat. It is not "
                        "running. The user can run it again from the chat; ask before you start it yourself.",
                        actions=("run_again",) if record.get("command") else ())
    return _outcome(record, "stopped",
                    f'Sub-agent "{name}" was stopped by a restart before it reported. It was not run again on its own.',
                    f'sub-agent {record["id"]} "{name}" was running and stopped when DGC stopped (about {since}), before '
                    "it reported; its result is lost and it was NOT run again. The user can resume it (a new sub-agent "
                    "told what this one had done) or run it again from the chat; ask before you delegate it again "
                    "yourself.",
                    actions=("resume", "run_again") if record.get("prompt") else ())


def _resume_troupe(agent, record, *, by_user: bool) -> "journal.Outcome":
    from . import troupe_agent
    from .permissions import ASK, DENY
    name, run_id = _name(record), record["id"]
    # As the troupe tool is decided: by its template (an Always allow on review troupes covers resuming one).
    asked = {"resume": run_id, **({"template": record["template"]} if record.get("template") else {})}
    decision, reason = agent._monitor_permission("troupe", asked)
    blocked = ""
    if decision == DENY:
        blocked = journal._why_blocked(DENY, reason)
    elif decision == ASK and not by_user and (record.get("permission") or {}).get("mode") == "auto":
        # Auto mode started it without asking; now it would ask. In the other modes the user approved it.
        blocked = journal._why_blocked(ASK, reason)
    if blocked:
        return _outcome(record, "stopped", f'Troupe "{name}" was stopped by a restart and not resumed: {blocked}.',
                        f'troupe {run_id} "{name}" stopped when DGC stopped and was NOT resumed: {blocked}. The user '
                        "can resume it from the chat.", actions=("resume",), by_user=by_user)
    result = troupe_agent.start(agent, {"resume": run_id}, None)
    if str(result).startswith("error:"):
        why = str(result).removeprefix("error:").strip().rstrip(".")
        _end(_target(agent), record["key"], "failed", only_running=False)
        return _outcome(record, "failed", f'Troupe "{name}" could not be resumed: {why}.',
                        f'troupe {run_id} "{name}" stopped when DGC stopped and could not be resumed ({why}).',
                        by_user=by_user)
    _end(_target(agent), record["key"], "rerun", only_running=False)   # the resumed run has a record of its own
    kept = re.search(r"(\d+) results from the earlier attempt are reused", str(result))
    reused = f"{kept.group(1)} finished results kept, " if kept else ""
    return _outcome(record, "resumed",
                    f'Troupe "{name}" picked up where DGC stopped: {reused}only the unfinished agents run again.',
                    f'troupe {run_id} "{name}" stopped when DGC stopped and was resumed from its journal: {reused}only '
                    "the unfinished agents run again; the chat wakes with its report when it ends.",
                    by_user=by_user)


def after_reopen(agent, *, keys=None) -> list:
    """The reopen's part beyond monitors: report stopped commands and sub-agents, resume troupes. Once each."""
    target = _target(agent)
    if target is None:
        return []
    me = journal.owner()
    outcomes = []
    for record in [r for r in read(target) if _due(r, me) and (keys is None or r["key"] in keys)]:
        if record["kind"] == "troupe":
            outcomes.append(_resume_troupe(agent, record, by_user=False))
            continue
        outcomes.append(_report(record))
        _end(target, record["key"], "reported", only_running=False, reported_by=me)
    return outcomes


def stopped_shells(agent) -> list:
    """Background commands this opening of the chat reported stopped by a restart and not run again: for the agent
    map. An earlier opening's are history; their lines are in the chat."""
    me = journal.owner()
    return [r for r in read(_target(agent)) if r["kind"] == "shell" and r.get("end") == "reported"
            and (r.get("reported_by") or {}).get("pid") == me.get("pid")]


def run_again(agent, key: str, how: str = "again"):
    """The user's Run again or Resume on work a restart stopped. Their press is the approval; a deny still wins.
    None when this chat has no such stopped work."""
    from .permissions import DENY
    target = _target(agent)
    record = next((r for r in read(target) if r.get("key") == str(key or "")), None)
    if record is None or record.get("end") not in ("reported", "dgc_stopped", "failed") or (
            record.get("end") == "dgc_stopped" and not journal.due(record, journal.owner())):
        return None
    if record["kind"] == "troupe":
        outcome = _resume_troupe(agent, record, by_user=True)
        agent._monitor_restart_noted([outcome])
        return outcome
    name = _name(record)
    if record["kind"] == "shell":
        command = str(record.get("command") or "")
        decision, reason = agent._monitor_permission("bash", {"command": command})
    else:
        command = str(record.get("prompt") or "")
        decision, reason = agent._monitor_permission("task", {"description": record.get("description") or "",
                                                              "prompt": command, "agent": record.get("agent") or ""})
    if not command:
        return None
    if decision == DENY:
        why = journal._why_blocked(DENY, reason)
        outcome = _outcome(record, "stopped", f"{WORDS[record['kind']]} \"{name}\" was not run again: {why}.",
                           f"the user pressed Run again on {record['id']} \"{name}\", and it was not run: {why}.",
                           actions=_actions(record), by_user=True)
        agent._monitor_restart_noted([outcome])
        return outcome
    resume = how == "resume" and record["kind"] == "agent"
    if record["kind"] == "shell":
        result, new_id = _start_shell(agent, record)
    else:
        result, new_id = _start_agent(agent, record, resume=resume)
    if not new_id:
        why = str(result or "it did not start").removeprefix("error:").strip().rstrip(".")
        outcome = _outcome(record, "failed", f"{WORDS[record['kind']]} \"{name}\" could not be run again: {why}.",
                           f"the user pressed Run again on {record['id']} \"{name}\"; it could not start ({why}).",
                           actions=_actions(record), by_user=True)
    else:
        _end(target, record["key"], "rerun", only_running=False)
        if record["kind"] == "shell":
            message = f"Background command `{record.get('label') or command}` is running again as {new_id}."
            note = (f"the user ran background command {record['id']} `{record.get('label') or command}` again, in "
                    f"the same folder, as {new_id}. Read its output with bash_output(id=\"{new_id}\").")
        elif resume:
            message = f'Sub-agent "{name}" resumed: a new sub-agent picks up from what the stopped one had done.'
            note = (f'the user resumed sub-agent {record["id"]} "{name}": a new one, {new_id}, has the same task and '
                    "what the stopped one had done, in the background; this chat hears its result when it ends.")
        else:
            message = f'Sub-agent "{name}" is running again with the same prompt.'
            note = (f'the user ran sub-agent {record["id"]} "{name}" again with the same prompt, in the background, as '
                    f"{new_id}; this chat hears its result when it ends.")
        outcome = _outcome(record, "started", message, note, by_user=True, new_id=new_id)
    agent._monitor_restart_noted([outcome])
    return outcome


def _start_shell(agent, record) -> tuple[str, str]:
    from . import tools
    from pathlib import Path
    ctx = copy.copy(agent.ctx)
    cwd = Path(str(record.get("cwd") or agent.config.project_root))
    if not cwd.is_dir():
        return f"error: its folder {cwd} is no longer there", ""
    ctx.project_root = cwd
    cancel = threading.Event()
    timer = threading.Timer(journal.LEASE_WAIT_S, cancel.set)
    timer.daemon = True
    timer.start()
    try:
        ctx.cancelled = cancel
        result = tools._bash_background(str(record["command"]), ctx, notify_exit=agent._monitor_delivery())
    finally:
        timer.cancel()
    found = re.match(r"started background task (bg\d+)", str(result))
    return result, found.group(1) if found else ""


def _actions(record) -> tuple:
    if record["kind"] == "agent":
        return ("resume", "run_again") if record.get("prompt") else ()
    if record["kind"] == "troupe":
        return ("resume",)
    return ("run_again",) if record.get("command") else ()


def left_behind(agent, record) -> str:
    """What a stopped sub-agent left, for its Resume: the steps it had taken (the agents list keeps a bounded log of
    them) and, when DGC kept its unmerged checkout, where that is and which files it changed."""
    parts = []
    log = []
    try:
        log = agent.subagents.log_of(record["id"])
    except Exception:                             # noqa: BLE001 -- what it left is a help, never a requirement
        log = []
    steps = [f"- {e.get('name')}: {e.get('summary') or ''}".rstrip(": ") for e in log if e.get("type") == "tool_call"]
    if steps:
        parts.append("The steps it had taken before it stopped:\n" + "\n".join(steps[-20:]))
    results = [e for e in log if e.get("type") == "tool_result" and e.get("output")]
    if results:
        parts.append("The last thing it saw:\n" + str(results[-1]["output"])[-1500:])
    try:
        retained, _errors = agent.retained_tasks()
    except Exception:                             # noqa: BLE001
        retained = []
    path = str(record.get("workspace") or "")
    kept = [task for task in retained if path and str(task.project_root) == path]
    for task in kept[:1]:
        files = ", ".join(task.display_paths[:20]) or "none listed"
        parts.append(f"Its unmerged work was kept by DGC as retained task {task.id} ({task.project_root}); the files it "
                     f"had changed there: {files}. It was not merged into this checkout: look at those files before "
                     "redoing them, and do not assume its changes are here.")
    return "\n\n".join(parts)


def _start_agent(agent, record, *, resume: bool = False) -> tuple[str, str]:
    from .ultra import worker_limit
    jobs = getattr(agent, "_detached_jobs", None) or {}
    if len(jobs) >= worker_limit(agent.config):
        return f"error: {len(jobs)} background agents are already running; wait for one to finish", ""
    if getattr(agent, "stopping", False):
        return "error: the chat is closing", ""
    prompt = str(record["prompt"])
    if resume:
        left = left_behind(agent, record)
        prompt += ("\n\nAn earlier attempt at this task was stopped when DGC stopped, before it reported. "
                   + (left if left else "Nothing it did was kept.")
                   + "\nPick up from there: do not redo what is already done, and check anything it may have left "
                     "half-done.")
    agent.cancelled.clear()                  # idle only (the caller checks): no turn is listening to it
    before = set((getattr(agent, "_detached_jobs", None) or {}).keys())
    result = agent._run_subagent(str(record.get("description") or "delegated work"), prompt,
                                 str(record.get("agent") or ""), None, background=True)
    started = set((getattr(agent, "_detached_jobs", None) or {}).keys()) - before
    return result, next(iter(started), "")
