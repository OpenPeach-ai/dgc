"""The Agent's side of a troupe (dgc/troupe.py): starting each sub-agent, waking the chat when the run ends, stopping.

Every troupe agent is an ordinary sub-agent, started through the same core as `task`
(Agent._execute_prepared_subagent), with three differences:

- Read-only kinds (explorer, researcher, critic, verifier) run beside the user's files with read tools only (web
  included), so a hundred of them cost no checkouts. A writing kind (worker, or a named agent allowed to write) gets an
  isolated checkout of its own and its changes are merged back exactly as a task's are -- isolation stays mandatory.
- They are unattended, as the agents of a monitor turn are: nobody is answering a hundred approval cards, so a step
  that would ask is refused (auto mode still runs everything its role allows).
- They are not in the agents list: the troupe's card shows the run instead of a row per agent.

Locally served models get one agent at a time (one GPU); remote ones as many as `task` may run in parallel.
"""
from __future__ import annotations

import threading
from pathlib import Path

from . import troupe

# A troupe agent's role, ahead of its task. Not the `.dgc/agents` built-ins: those write files and hand off with a
# FILES line, and a troupe agent reads and answers in JSON. Not added to the `task` roster either (its prompt is
# measured: tests/run_tests.py, the prompt-surface probe).
ROLE = {
    "explorer": "You are a read-only explorer: search and read, never write or change anything. Cite path:line.",
    "researcher": "You are a researcher: read and search the web, never write or change anything. Name your sources.",
    "critic": "You are a critic: check the work given to you against its requirements and sources; read only, never "
              "write or change anything.",
    "verifier": "You are a verifier: try to prove the claim given to you wrong by reading what it names. Call it real "
                "only if the evidence shows it. Read only: never write or change anything.",
    "worker": "You are a worker: make the bounded change given to you, keep the diff small, and run its tests when "
              "there are any.",
}


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

    def run(self, stage, prompt, label, cancel, check):
        from .agent import _SubUI
        agent = self.agent
        name, tools, writes = self._kind(stage)
        role = ROLE.get(stage.agent, "")
        task_prompt = (role + "\n\n" + prompt) if role else prompt
        sub_ui = _SubUI(agent.ui, f"troupe · {label}", buffered=True, cancel=cancel)
        workspace = None
        if writes:
            workspace, refusal = self._checkout(label, cancel)
            if refusal:
                return "", refusal
        handle: dict = {}
        failure, text, start_error = agent._execute_prepared_subagent(
            f"troupe · {label}", task_prompt, name, workspace, sub_ui, None, cancel=cancel, handle=handle,
            tools=tools, unattended=True)
        problem = "" if (failure or start_error) else check(text)
        child = handle.get("agent")
        if problem and child is not None and not cancel.is_set():
            # Once, the same agent with everything it already read: just the JSON, this time.
            try:
                if child.run_turn(troupe.fix_prompt(problem, stage)) is not False:
                    text = sub_ui.result()
            except Exception:                    # noqa: BLE001 -- the unit fails on its own below
                pass
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
    planned = plan.agents_planned()
    shape = " → ".join(s.name for s in plan.stages)
    pace = "one at a time (a model on this machine)" if runner.width == 1 else f"up to {runner.width} at a time"
    if agent._non_interactive():
        # `dgc -p` ends with this turn and nothing would wake it: run here and answer with the results.
        run.run_here()
        return run.report()
    run.on_end = lambda finished: deliver(agent, finished, epoch)
    run.start()
    reused = f" {len(cached)} results from the earlier attempt are reused." if cached else ""
    return (f"Troupe {run.id} started: {plan.title}. {shape}; about {planned} agents, {pace}.{reused} It runs in the "
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


def describe_event(kind: str, fields: dict, seen: set, *, stop_hint: bool = True) -> str:
    """A terminal's line for a troupe event, or "" (only milestones: started, each stage done, ended). STOP_HINT
    names /troupes stop, for a terminal where it can be typed."""
    run_id, title = str(fields.get("run_id") or ""), str(fields.get("title") or "")
    stages = [s for s in fields.get("stages") or [] if isinstance(s, dict)]
    if kind == "started":
        planned = int(fields.get("agents_planned") or 0)
        shape = " → ".join(str(s.get("name")) for s in stages)
        return f"troupe {run_id} · {title}: {shape}, about {planned} agents" + (
            f" · /troupes stop {run_id}" if stop_hint else "")
    if kind == "progress":
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
