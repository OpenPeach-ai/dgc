"""The Agent's side of a troupe (dgc/troupe.py): starting each sub-agent, waking the chat when the run ends, stopping.

Every troupe agent is an ordinary sub-agent, started through the same core as `task`
(Agent._execute_prepared_subagent), with three differences:

- Read-only kinds (explorer, researcher, critic, verifier) run beside the user's files with read tools only (web
  included), so a hundred of them cost no checkouts. A writing kind (worker, or a named agent allowed to write) gets an
  isolated checkout of its own and its changes are merged back exactly as a task's are -- isolation stays mandatory.
- They are unattended, as the agents of a monitor turn are: nobody is answering a hundred approval cards, so a step
  that would ask is refused (auto mode still runs everything its role allows).
- They are not in the agents list: the troupe's row above the prompt shows the run instead of a row per agent.

Locally served models get one agent at a time (one GPU); remote ones as many as `task` may run in parallel.
"""
from __future__ import annotations

import threading
from pathlib import Path

from . import troupe

# A troupe agent's role, ahead of its task. Not the `.dgc/agents` built-ins: those write files and hand off with a
# FILES line, and a troupe agent reads and answers in JSON. The `task` roster has a verifier of its own (agents.py),
# which may run checks; a troupe's verifier is matched here first and stays read only.
# Each says exactly what the agent can do (troupe.ABILITIES): a verifier told only "read only" was asked to re-run
# SQL, couldn't, and voted the finding not real (ERP session review, 2026-10-18).
ROLE = {
    "explorer": "You are a read-only explorer: search and read the project's files (and the web). You have no shell: "
                "you can't run commands, tests or database queries. Never write or change anything. Cite path:line.",
    "researcher": "You are a researcher: read files and search the web. You have no shell and never write or change "
                  "anything. Name your sources.",
    "critic": "You are a critic: check the work given to you against its requirements and sources, by reading files "
              "and the web. You have no shell and never write or change anything.",
    "verifier": "You are a verifier: try to prove the claim given to you wrong by reading what it names, in the "
                "project's files and on the web. You have no shell: you can't run commands, tests or database "
                "queries, so a claim about live data or a running service is one you can only check by reading. Call "
                "it real only if the evidence shows it; when you can't check it with these tools, say you are unsure, "
                "never that it is not real. Never write or change anything.",
    "worker": "You are a worker: make the bounded change given to you, keep the diff small, and run its tests when "
              "there are any.",
}

# A verifier's role when it has its read-only shell (dgc/checker_box.py; the founder, 2026-10-18).
VERIFIER_SHELL = (
    "You are a verifier: try to prove the claim given to you wrong. You have a read-only shell (bash) in a sealed "
    "box: the project is at /mnt and read only, the only place you can write is a private /tmp, credential files "
    "(.env, keys) are hidden, and there is no network{database}. Run the commands, tests and queries that would show "
    "the claim is wrong, and read the project's files and the web. Call it real only if the evidence shows it; when "
    "you can't check it, say you are unsure, never that it is not real. Never try to write or change anything.")
VERIFIER_DATABASE = (
    " except this project's database, through a read-only account: it is in $DGC_READONLY_DATABASE_URL (for example "
    "psql \"$DGC_READONLY_DATABASE_URL\" -c 'select ...'), and it can't change data")
VERIFIER_NO_DATABASE = (
    ". No read-only database account is set for this project, so you can't query its live data: for a claim that "
    "needs one, answer unsure")
WORKER_DATABASE = (
    " A read-only account for this project's database is in $DGC_READONLY_DATABASE_URL: use it for every query that "
    "only reads, never an admin or owner account.")


def verifier_role(*, shell: bool, database: bool, note: str = "") -> str:
    """A verifier's role as things are for this run: with its boxed shell (and the database) or without one, and why."""
    if not shell:
        return ROLE["verifier"].replace("You have no shell:", "You have no shell" + (f" ({note})" if note else "") + ":")
    said = VERIFIER_SHELL.format(database=VERIFIER_DATABASE if database else VERIFIER_NO_DATABASE)
    return said + (f" ({note}.)" if note else "")


def abilities(project_root) -> dict:
    """What each kind can do in this project on this computer, in the words the troupe tool's schema and the start
    message use: the verifier's box depends on bubblewrap here, and its database on `dgc readonly-db`."""
    from . import checker_box, readonly_database
    found = dict(troupe.ABILITIES)
    database = readonly_database.configured(project_root)
    reason = checker_box.unavailable_reason()
    if reason:
        found["verifier"] = ("reads files and the web; no shell on this computer (" + reason.split(":")[0]
                             + "), so it answers unsure for what it would have to run")
    else:
        found["verifier"] = ("a read-only shell in a sealed box (the project read only, writes only to a private /tmp, "
                             "credential files hidden, no network" + (
                                 " but this project's database through a read-only account, "
                                 "$DGC_READONLY_DATABASE_URL)" if database else
                                 "; no read-only database account is set for this project, so no queries: "
                                 "`dgc readonly-db` sets one)") + ", plus files and the web")
    if database:
        found["worker"] += "; this project's read-only database account is in $DGC_READONLY_DATABASE_URL, for reads"
    return found


def with_abilities(tool: dict, project_root) -> dict:
    """The troupe tool's schema with each kind's abilities as they are here (a copy; the module's schema is kept)."""
    import copy
    try:
        found = abilities(project_root)
    except Exception:                            # noqa: BLE001 - a description, never the tool's availability
        return tool
    tool = copy.deepcopy(tool)
    properties = tool["function"]["parameters"]["properties"]
    agent = properties["stages"]["items"]["properties"]["agent"]
    agent["description"] = ("What each kind can do here. explorer: " + found["explorer"] + ". researcher: "
                            + found["researcher"] + ". critic: " + found["critic"] + ". verifier: " + found["verifier"]
                            + ". worker: " + found["worker"] + ". Or a named agent.")
    return tool


def width(agent) -> int:
    """How many troupe agents run at once: one on a model served on this machine, else what `task` may run."""
    from .model_watch import is_local_endpoint, is_ollama_cloud_model
    from .ultra import worker_limit
    client = getattr(agent, "client", None)
    base_url = str(getattr(client, "base_url", "") or agent.config.get("base_url", "") or "")
    model = str(getattr(client, "model", "") or getattr(agent.config, "model", "") or "")
    if is_local_endpoint(base_url) and not is_ollama_cloud_model(model):
        return 1
    return max(1, worker_limit(agent.config))


class TroupeRunner(troupe.Runner):
    def __init__(self, agent):
        from .agent import _SubUI
        self.agent = agent
        self._database = ...                     # this project's read-only database, read once per run (keychain)
        self.width = width(agent)
        self.keeper = agent.checkpoints          # the chat this work belongs to, as it is now
        # Made on the turn's thread: its events reach the terminal session (or chat) that started it, whatever
        # thread sends them later.
        self._route = _SubUI(agent.ui, "troupe")

    def admit(self) -> str:
        if getattr(self.agent, "stopping", False):
            return "the chat was closed"
        if self.agent.turn_budget_exceeded():
            return "the turn's token cap was reached"
        return ""

    def _kind(self, stage) -> tuple[str, frozenset | None, bool]:
        """(agent definition to use, tool allow-list, writes)."""
        if stage.agent in troupe.READ_ONLY_KINDS:
            return "", troupe.READ_TOOLS, False
        if stage.agent in troupe.WRITING_KINDS:
            return "", None, True
        adef = self.agent.agent_defs.get(stage.agent)
        allowed = getattr(adef, "tool_allow", frozenset()) or frozenset()
        reads_only = bool(allowed) and allowed <= troupe.READ_TOOLS
        return stage.agent, (allowed if reads_only else None), not reads_only

    def database(self):
        """This project's read-only database (dgc/readonly_database.py), or None; read once per run."""
        if self._database is ...:
            from .readonly_database import load
            try:
                self._database = load(self.agent.config.project_root)
            except Exception:                    # noqa: BLE001 - none this run: checkers are told so
                self._database = None
        return self._database

    def run(self, stage, prompt, label, cancel, check):
        from .agent import _SubUI
        agent = self.agent
        name, tools, writes = self._kind(stage)
        role = ROLE.get(stage.agent, "")
        box, relay, tool_env, secrets = None, None, None, ()
        if stage.agent == "verifier":
            # The founder (2026-10-18): checkers get a sandboxed read-only shell and a read-only database account.
            from . import checker_box
            box, relay, note = checker_box.prepare(agent.config.project_root, self.database())
            if box is not None:
                tools = troupe.READ_TOOLS | {"bash"}
                secrets = tuple(box.get("secrets") or ())
            role = verifier_role(shell=box is not None, database=relay is not None, note=note)
        elif writes and self.database() is not None:
            from .readonly_database import ENV, url_for
            url = url_for(self.database())
            tool_env, secrets = {ENV: url}, tuple(value for value in (self.database().get("password"),) if value)
            role += WORKER_DATABASE
        task_prompt = (role + "\n\n" + prompt) if role else prompt
        sub_ui = _SubUI(agent.ui, f"troupe · {label}", buffered=True, cancel=cancel)
        workspace = None
        try:
            if writes:
                workspace, refusal = self._checkout(label, cancel)
                if refusal:
                    return "", refusal
            handle: dict = {}
            failure, text, start_error = agent._execute_prepared_subagent(
                f"troupe · {label}", task_prompt, name, workspace, sub_ui, None, cancel=cancel, handle=handle,
                tools=tools, unattended=True, checker_box=box, tool_env=tool_env, secrets=secrets)
            problem = "" if (failure or start_error) else check(text)
            child = handle.get("agent")
            if problem and child is not None and not cancel.is_set():
                # Once, the same agent with everything it already read: just the JSON, this time.
                try:
                    if child.run_turn(troupe.fix_prompt(problem, stage)) is not False:
                        text = sub_ui.result()
                except Exception:                    # noqa: BLE001 -- the unit fails on its own below
                    pass
        finally:
            if relay is not None:
                relay.close()
        if secrets:
            # The journal and the woken chat get the reply: never the account's password.
            from .redaction import redact_text
            text = redact_text(text, [value for value in secrets if value])
        if workspace is None:
            return text, failure or start_error
        return self._merge(label, workspace, failure, text, start_error, cancel)

    def _checkout(self, label, cancel):
        from .scheduler import acquire_cancellable, workspace_mutation_lock
        from .worktree import TaskWorkspace, repo_root
        agent = self.agent
        lease = workspace_mutation_lock(agent.config.project_root)
        if not acquire_cancellable(lease, cancel):
            return None, lease.last_error or "stopped while waiting to make its checkout"
        try:
            configured = str(agent.config.get("subagent_worktree_root", "") or "").strip()
            workspace, error = TaskWorkspace.prepare(agent.config.project_root, f"troupe-{label}",
                                                     Path(configured) if configured else None,
                                                     link_paths=agent._subagent_link_paths())
        except Exception as exc:                 # noqa: BLE001
            workspace, error = None, f"{type(exc).__name__}: {exc}"
        finally:
            lease.release()
        if workspace is None and repo_root(agent.config.project_root) is not None:
            return None, f"its isolated checkout could not be made: {error or 'unknown error'}"
        if workspace is None:
            # No Git HEAD: there is no checkout to give it, so a writer cannot be kept apart from the user's files.
            return None, "this project has no Git commit to give a writing agent its own checkout"
        return workspace, ""

    def _merge(self, label, workspace, failure, text, start_error, cancel):
        agent = self.agent
        agent._ensure_detached_state()
        key = f"troupe-{id(workspace):x}"
        with agent._finalizing_lock:
            agent._finalizing[key] = f"troupe · {label}"
        try:
            outcome = agent._as_session_owner(lambda: agent._finalize_subagent(
                f"troupe · {label}", workspace, failure, text, start_error, cancel=cancel, keeper=self.keeper))
        finally:
            with agent._finalizing_lock:
                agent._finalizing.pop(key, None)
        if failure or start_error:
            return text, failure or start_error
        if not outcome.integrated and "error" in outcome.output[:12].lower():
            return text, outcome.output[:300]
        if not outcome.integrated and "not integrated" in outcome.output:
            return text, outcome.output[:300]
        return text, ""

    def event(self, kind, fields):
        try:
            self._route._direct("troupe_event", kind, fields)
        except Exception:                        # noqa: BLE001 -- a view, never the work
            pass


def deliver(agent, run, epoch) -> None:
    """The run ended: wake the chat that started it with its report, as a background task's result does."""
    hub = getattr(agent, "monitors", None)
    if getattr(agent, "stopping", False) or (hub is not None and epoch is not None and hub.epoch != epoch):
        return                                   # the chat that asked is gone: never start a turn in another one
    from .agent import _TaskOutcome
    description = f"Troupe: {run.plan.title}"
    report = run.report()
    outcome = _TaskOutcome(report)
    try:
        agent._record_detached_result(run.id, description, outcome, epoch)
    except Exception:                            # noqa: BLE001
        pass
    run.delivered = True                         # its report is readable by id now (wait_tasks)
    notify = getattr(agent, "on_detached_ended", None)
    if callable(notify):
        try:
            notify({"id": run.id, "description": description, "message": report, "integrated": False})
        except Exception:                        # noqa: BLE001
            pass
    elif hub is not None and epoch is not None:
        try:
            hub.queue_subtask_ended(run.id, description, report, False, epoch)
        except Exception:                        # noqa: BLE001
            pass


def start(agent, args: dict, call_id) -> str:
    """The `troupe` tool: check the work order, start it, and say what will happen."""
    from .config import USER_HOME
    if args.get("routine") is not None:
        # Not now: on a schedule, as a Pip routine (dgc/troupe_routines.py).
        from .troupe_routines import schedule
        return schedule(agent, args)
    root = Path(USER_HOME) / "troupes"
    resume = str(args.get("resume") or "").strip()
    cached: dict = {}
    run_id = ""
    try:
        if resume:
            if not troupe.RUN_ID.fullmatch(resume):
                raise troupe.PlanError("resume takes a troupe id like tr-0123456789")
            saved = troupe.load_plan(root / resume)
            plan = troupe.plan_from_args(saved, agent_names=agent.agent_defs.keys())
            cached = troupe.Run.load_cached(root / resume)
            run_id = resume
            if run_id in getattr(agent, "_troupes", {}) and agent._troupes[run_id].state == "running":
                raise troupe.PlanError(f"troupe {run_id} is still running")
        else:
            plan = troupe.plan_from_args(args, agent_names=agent.agent_defs.keys())
    except troupe.PlanError as error:
        return f"error: this troupe was not started: {error}."
    refused = agent.turn_budget_exceeded()
    if refused:
        return agent.turn_budget_refusal()
    runner = TroupeRunner(agent)
    run = troupe.Run(plan, runner, root, run_id=run_id, cached=cached)
    runs = agent.__dict__.setdefault("_troupes", {})
    runs[run.id] = run
    hub = getattr(agent, "monitors", None)
    epoch = getattr(hub, "epoch", None)
    run.epoch = epoch                            # whose run it is: a /new chat doesn't list or wait on it
    planned = plan.estimate()
    shape = " → ".join(s.name for s in plan.stages)
    pace = "one at a time (a model on this machine)" if runner.width == 1 else f"up to {runner.width} at a time"
    if agent._non_interactive():
        # `dgc -p` ends with this turn and nothing would wake it: run here and answer with the results.
        run.run_here()
        return run.report()
    # Before the run starts: what each kind can do here may probe the box once (dgc/checker_box.py), and a Stop the
    # moment this returns must find the run still at its first agents.
    found = abilities(agent.config.project_root)
    kinds = "; ".join(f"{stage.name} ({stage.agent}) {found[stage.agent]}"
                      for stage in plan.stages if stage.agent in found)
    kinds = f" What its agents can do: {kinds}." if kinds else ""
    from . import stopped_work                   # its session knows it ran: a reopen resumes it once
    stopped_work.troupe_started(agent, run)

    def ended(finished):
        stopped_work.troupe_ended(agent, finished)
        deliver(agent, finished, epoch)
    run.on_end = ended
    run.start()
    reused = f" {len(cached)} results from the earlier attempt are reused." if cached else ""
    return (f"Troupe {run.id} started: {plan.title}. {shape}; {planned}, {pace}.{kinds}{reused} It runs in the "
            "background and this chat wakes with its results when it ends; until then, carry on or tell the user it "
            "is running. Don't start the same work again.")


def stop(agent, run_id: str = "") -> list[str]:
    """Stop one running troupe (or all of them): its agents are stopped and it reports what it finished."""
    stopped = []
    for identity, run in list(getattr(agent, "_troupes", {}).items()):
        if run.state == "running" and (not run_id or identity == run_id):
            run.stop("stopped by the user")
            stopped.append(identity)
    return stopped


def running(agent) -> list:
    return [run for run in getattr(agent, "_troupes", {}).values() if run.state == "running"]


def this_chats(agent, *, running_only: bool = False) -> list:
    """The troupes the chat now open started (newest first): a troupe a replaced chat started is not its business."""
    hub = getattr(agent, "monitors", None)
    epoch = getattr(hub, "epoch", None)
    runs = [run for run in (getattr(agent, "_troupes", None) or {}).values()
            if getattr(run, "epoch", None) in (None, epoch) and (run.state == "running" or not running_only)]
    return sorted(runs, key=lambda run: run.started_at, reverse=True)


def waiting_ids(agent) -> set:
    """Troupes of this chat whose report isn't recorded yet: still working, or just ended and being delivered."""
    return {run.id for run in this_chats(agent)
            if run.state == "running" or (run.on_end is not None and not getattr(run, "delivered", False))}


def status_text(agent) -> str:
    """The `list_tasks` section for this chat's troupes, or "" when it has none."""
    runs = this_chats(agent)[:10]
    if not runs:
        return ""
    running_now = sum(1 for run in runs if run.state == "running")
    head = (f"Troupes in this conversation: {len(runs)} ({running_now} running). A running troupe's id is one "
            "wait_tasks takes; it wakes this chat with its report when it ends.")
    return "\n".join([head, *(run.status() for run in runs)])


def describe_event(kind: str, fields: dict, seen: set, *, stop_hint: bool = True) -> str:
    """A terminal's line for a troupe event, or "" (only milestones: started, each stage done, ended). STOP_HINT
    names /troupes stop, for a terminal where it can be typed."""
    run_id, title = str(fields.get("run_id") or ""), str(fields.get("title") or "")
    stages = [s for s in fields.get("stages") or [] if isinstance(s, dict)]
    if kind == "started":
        planned = str(fields.get("estimate") or f"about {int(fields.get('agents_planned') or 0)} agents")
        shape = " → ".join(str(s.get("name")) for s in stages)
        if " then " in planned and seen is not None:
            seen.add((run_id, "split"))     # its size is known once every stage has started: said then
        return f"troupe {run_id} · {title}: {shape}, {planned}" + (
            f" · /troupes stop {run_id}" if stop_hint else "")
    if kind == "progress":
        estimate = str(fields.get("estimate") or "")
        if (seen is not None and (run_id, "split") in seen and estimate and " then " not in estimate
                and (run_id, "sized") not in seen):
            seen.add((run_id, "sized"))
            return f"troupe {run_id} · {title}: {estimate} in all, now that each split is known"
        for stage in stages:
            total = int(stage.get("total") or 0)
            if total and int(stage.get("done") or 0) + int(stage.get("failed") or 0) >= total:
                key = (run_id, stage.get("name"))
                if key not in seen:
                    seen.add(key)
                    failed = int(stage.get("failed") or 0)
                    return (f"troupe {run_id} · {stage.get('name')}: {stage.get('done')} of {total} agents"
                            + (f", {failed} failed" if failed else ""))
        return ""
    if kind == "finished":
        state = str(fields.get("state") or "")
        reason = str(fields.get("reason") or "")
        kept = int(stages[-1].get("kept") or 0) if stages else 0
        return (f"troupe {run_id} · {title}: {state}" + (f" ({reason})" if reason else "")
                + f" · {kept} kept · {fields.get('journal')}")
    return ""


def command_text(agent, rest: str) -> str:
    """/troupes [stop ID|all]: what this session's troupes are doing, or stop one."""
    parts = str(rest or "").split()
    if parts and parts[0].lower() == "stop":
        target = parts[1] if len(parts) > 1 else ""
        stopped = stop(agent, "" if target == "all" else target)
        return ("stopping " + ", ".join(stopped)) if stopped else "no running troupe" + (f" {target}" if target else "")
    runs = sorted(getattr(agent, "_troupes", {}).values(), key=lambda run: run.started_at, reverse=True)
    if not runs:
        return "no troupes in this session"
    lines = ["troupes"]
    for run in runs[:20]:
        snap = run.snapshot()
        progress = ", ".join(f"{s['name']} {s['done'] + s['failed']}/{s['total']}" for s in snap["stages"])
        lines.append(f"  {run.id}  {run.plan.title}  {snap['state']}" + (f" ({snap['reason']})" if snap["reason"] else "")
                     + f" · {progress}")
    lines.append("/troupes stop ID|all")
    return "\n".join(lines)
