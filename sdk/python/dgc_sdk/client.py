"""Public DGC / AsyncDGC facades."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import sys
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .wire.client import DGCClient, DGCProtocolError as WireProtocolError, DGCStartError

from ._mcp_bridge import ToolHub
from ._state import config_drift, prepare_state_dir, state_lock, write_session_config
from ._version import PROTOCOL, REQUIRES_CLI, __version__
from .audit import remember_secret
from .errors import DGCConfigError, DGCProtocolError, DGCRuntimeError
from .policy import inspect_bash_for_engine
from .runtime import default_runtime_argv, isolated_env, require_sandbox
from .session import RunHandle, Session, _Completed, _new_id
from .types import (
    AgentInfo, Artifact, Checkpoint, Goal, HookInfo, McpServerInfo, Monitor, OnMcpInput,
    OnPermission, OnPlan, OnQuestion, PermissionMode, PermissionRule, RunEvent, RunResult,
    SandboxRequirement, SessionInfo, SkillInfo, TaskItem, ToolSpec, UnhandledPolicy,
)

log = logging.getLogger("dgc_sdk")
_CONFIG_ATTEMPTS = 3


def _mcp_socket_path(slot: Path) -> str:
    """Unix-domain bind paths are short (104 bytes on macOS). Always use /tmp."""
    digest = hashlib.sha1(str(slot.resolve()).encode()).hexdigest()[:12]
    return f"/tmp/dgc-{digest}.sock"


def _existing_dirs(items) -> list[str]:
    found: list[str] = []
    for item in items:
        try:
            path = Path(item).expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        if path.is_dir():
            found.append(str(path))
    return found


def _reject_inherited(**options: Any) -> None:
    """With inherit_user_state=True these would have to be saved into your own ~/.dgc."""
    given = sorted(name for name, value in options.items()
                   if value is not None and value != {} and not (name == "thinking" and value == "off"))
    if given:
        raise DGCConfigError(
            "inherit_user_state=True runs with your own DGC settings, and DGC would save "
            f"{', '.join(given)} into ~/.dgc/config.json; set them with the dgc CLI, or use an "
            "isolated state_dir (inherit_user_state=False)")


def _check_inherited(ready: Mapping[str, Any], **requested: str | None) -> None:
    """Refuse an inherited session whose settings differ from what the caller asked for."""
    actual = {
        "model": str(ready.get("model") or ""),
        "base_url": str(ready.get("base_url") or "").rstrip("/"),
        "mode": str(ready.get("mode") or ""),
        "thinking": str(ready.get("think") or ""),
    }
    wrong = []
    for name, value in requested.items():
        if value is None:
            continue
        want = str(value).rstrip("/") if name == "base_url" else str(value)
        if want != actual[name]:
            wrong.append(f"{name}={value!r} (your DGC uses {actual[name]!r})")
    if wrong:
        raise DGCConfigError(
            "inherit_user_state=True uses your own DGC settings and cannot change them without "
            f"saving into ~/.dgc: {'; '.join(wrong)}. Change them with the dgc CLI, or use an "
            "isolated state_dir")


class DGC:
    """Own zero or more isolated DGC sessions. Does not talk to a provider on import."""

    def __init__(
        self,
        *,
        runtime: Sequence[str] | None = None,
        state_dir: str | Path | None = None,
        inherit_user_state: bool = False,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        mode: PermissionMode = "default",
        thinking: str = "off",
        extra_env: dict[str, str] | None = None,
        sandbox: dict[str, str] | None = None,
        instructions: str = "",
        pricing: Any = None,
        department: str = "",
        policy: Any = None,
        retry: Any = None,
        extra_config: Mapping[str, Any] | None = None,
    ):
        """``state_dir`` holds this client's isolated HOME, audit and usage logs. It must be
        private (owned by you, not group/world-writable); left unset, a fresh private temporary
        directory is used (see :attr:`state_dir`). ``extra_config`` adds DGC settings to every
        isolated session; a config.json already in ``state_dir`` is never merged."""
        if inherit_user_state:
            _reject_inherited(model=model, base_url=base_url, thinking=thinking, retry=retry,
                              extra_config=extra_config)
        self._state_dir = prepare_state_dir(state_dir)
        self._inherit = bool(inherit_user_state)
        self._extra_config = dict(extra_config or {})
        if api_key:
            remember_secret(api_key)
        self._runtime = list(runtime) if runtime is not None else default_runtime_argv()
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._mode = mode
        self._thinking = thinking
        self._extra_env = extra_env
        self._sandbox = sandbox or {"requirement": "off"}
        self._instructions = instructions
        self._pricing = pricing
        self._department = str(department or "")
        self._policy = policy
        from .retry import RetryPolicy
        self._retry = retry if retry is not None else RetryPolicy()
        from .usage import UsageLog
        from .audit import AuditLog
        self._usage_log = UsageLog(self._state_dir / "usage")
        self._audit_log = AuditLog(self._state_dir / "audit")
        self._closed = False
        self._sessions: list[Session] = []
        require_sandbox(str(self._sandbox.get("requirement") or "off"))

    @property
    def version(self) -> str:
        return __version__

    @property
    def state_dir(self) -> Path:
        return self._state_dir

    @property
    def raw_runtime(self) -> list[str]:
        return list(self._runtime)

    def session(
        self,
        *,
        cwd: str | Path,
        permissions: dict | None = None,
        on_permission: OnPermission | None = None,
        on_plan: OnPlan | None = None,
        on_question: OnQuestion | None = None,
        on_mcp_input: OnMcpInput | None = None,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        mode: PermissionMode | None = None,
        thinking: str | None = None,
        tools: Sequence[ToolSpec] = (),
        instructions: str | None = None,
        max_turns: int | None = None,
        sandbox: dict[str, str] | None = None,
        verify_command: str | None = None,
        decision_timeout: float | None = 30.0,
        turn_budget_s: int | None = None,
        max_tokens: int | None = None,
    ) -> Session:
        if self._closed:
            raise DGCRuntimeError("this DGC client is closed")
        workspace = Path(cwd).expanduser().resolve()
        if not workspace.is_dir():
            raise DGCConfigError("cwd must be an existing directory")
        policy = dict(permissions or {})
        unhandled: UnhandledPolicy = policy.get("unhandled") or "deny"
        if unhandled not in ("deny", "callback"):
            raise DGCConfigError("permissions.unhandled must be 'deny' or 'callback'")
        if unhandled == "callback" and on_permission is None:
            raise DGCConfigError("permissions.unhandled='callback' needs an on_permission callback")
        requested_mode = mode or policy.get("mode") or (
            self._mode if self._mode != "default" else None)
        perm_mode: PermissionMode = mode or policy.get("mode") or self._mode
        if perm_mode not in ("default", "acceptEdits", "plan", "auto"):
            raise DGCConfigError("invalid permission mode")
        if self._inherit:
            _reject_inherited(max_turns=max_turns, verify_command=verify_command,
                              turn_budget_s=turn_budget_s, max_tokens=max_tokens)
        sandbox_spec = sandbox or self._sandbox
        requirement: SandboxRequirement = sandbox_spec.get("requirement") or "off"  # type: ignore[assignment]
        backend = require_sandbox(requirement)
        key = api_key if api_key is not None else self._api_key
        extra = dict(self._extra_env or {})
        if key:
            # An environment key is process-local: DGC never saves it, including into your own
            # ~/.dgc when inherit_user_state=True.
            extra["DGC_API_KEY"] = str(key)
            remember_secret(key)
        inspect_bash = inspect_bash_for_engine(
            on_permission=on_permission, permission_mode=perm_mode)
        isolated_values: dict[str, object] | None = None
        if not self._inherit:
            isolated_values = {
                "model": model or self._model,
                "base_url": base_url or self._base_url,
                "mode": perm_mode,
                "thinking": thinking or self._thinking,
                "artifact_autostart": False,
                "artifact_in_plan": False,
                "suggest": False,
                "eta": False,
                "notify": "off",
                "monitor_wake": False,
                "mcp_servers": {},
                "hooks": {},
                "trusted_dirs": [str(workspace)] + _existing_dirs(
                    getattr(self._policy, "extra_read_dirs", ()) or ()
                ),
                "sandbox": requirement != "off" and bool(backend),
                "sandbox_network": bool(self._policy and getattr(self._policy, "network", "deny") == "allow"),
                "permissions": {
                    "allow": [],
                    "ask": [],
                    "deny": list(self._policy.engine_deny_rules(
                        inspect_bash=inspect_bash,
                    )) if self._policy is not None else [],
                },
            }
            isolated_values.update(self._retry.isolated_values())
            isolated_values.update(self._extra_config)
            if max_turns is not None:
                isolated_values["max_turns"] = int(max_turns)
            if turn_budget_s is not None:
                isolated_values["turn_budget_s"] = int(turn_budget_s)
            if max_tokens is not None:
                isolated_values["max_tokens"] = int(max_tokens)
            if verify_command:
                isolated_values["verify_command"] = verify_command
                isolated_values["verify_before_done"] = True
        env = isolated_env(
            self._state_dir, extra=extra, inherit_user_state=self._inherit,
            project_root=None if self._inherit else workspace,
        )
        lock = state_lock(self._state_dir)
        # Config write, child startup and every save the SDK itself triggers happen under one
        # lock, so concurrent sessions never read each other's options.
        with lock.hold():
            transport, ready = self._start(workspace, env, isolated_values)
            hub = None
            try:
                if self._inherit:
                    _check_inherited(ready, model=model or self._model,
                                     base_url=base_url or self._base_url, mode=requested_mode,
                                     thinking=thinking or (
                                         self._thinking if self._thinking != "off" else None))
                if tools:
                    tool_dir = self._state_dir / f"tools-{_new_id('t')[-8:]}"
                    tool_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                    hub = self._install_tools(transport, tool_dir, list(tools))
                if perm_mode in ("acceptEdits", "auto") and not ready.get("workspace_trusted"):
                    try:
                        transport.send({
                            "type": "set_mode", "mode": perm_mode,
                            "acknowledge_workspace_trust": True, "request_id": _new_id("trust"),
                        })
                    except Exception:
                        pass
                session = Session(
                    transport, ready, unhandled=unhandled, on_permission=on_permission,
                    on_plan=on_plan, on_question=on_question, on_mcp_input=on_mcp_input,
                    tools=list(tools), tool_hub=hub,
                    instructions=instructions if instructions is not None else self._instructions,
                    decision_timeout=decision_timeout,
                    cwd=workspace,
                    policy=self._policy,
                    pricing=self._pricing,
                    department=self._department,
                    usage_log=self._usage_log,
                    audit_log=self._audit_log,
                    model=str(model or self._model or ""),
                    permission_mode=(str(ready.get("mode") or perm_mode) if self._inherit
                                     else perm_mode),
                    state_dir=self._state_dir,
                    isolated=not self._inherit,
                    max_turns=max_turns,
                    verify_command=verify_command or "",
                    state_lock=lock,
                    exclude_paths=[Path.home() / ".dgc"] if self._inherit else (),
                )
                if self._policy is not None:
                    for rule in self._policy.engine_deny_rules(inspect_bash=inspect_bash):
                        try:
                            session.add_permission_rule("deny", rule)
                        except Exception:
                            pass
            except BaseException:
                if hub is not None:
                    hub.close()
                transport.close()
                raise
        try:
            session.bind_identity()
        except Exception:
            pass
        self._sessions.append(session)
        return session

    def _start(self, workspace: Path, env: dict[str, str],
               values: Mapping[str, object] | None) -> tuple[DGCClient, dict[str, Any]]:
        """Write this session's config from scratch, then start ``dgc serve`` on it.

        A DGC child saves its whole config when it persists anything; if another session's
        child did that between our write and our child's startup, start again.
        """
        drifts: list[list[str]] = []
        for attempt in range(_CONFIG_ATTEMPTS if values is not None else 1):
            written = write_session_config(self._state_dir, values) if values is not None else None
            transport = DGCClient(
                self._runtime, cwd=str(workspace), env=env, start_timeout=30.0, event_timeout=30.0)
            try:
                ready = transport.start()
            except (DGCStartError, WireProtocolError) as exc:
                transport.close()
                raise DGCRuntimeError(str(exc)) from exc
            protocol = ready.get("protocol_version")
            if protocol is not None and int(protocol) != PROTOCOL:
                transport.close()
                raise DGCProtocolError(
                    f"DGC SDK {__version__} requires protocol v{PROTOCOL} (CLI {REQUIRES_CLI}); "
                    f"child reported {protocol}")
            drift = config_drift(self._state_dir, written) if written is not None else []
            if not drift or (drifts and drift == drifts[-1] and attempt == _CONFIG_ATTEMPTS - 1):
                # The same difference every time is DGC normalizing its own file, not a race.
                return transport, ready
            drifts.append(drift)
            log.warning("dgc_sdk: isolated config changed while the session started (%s); "
                        "starting again", ", ".join(drift[:5]))
            transport.close()
        raise DGCRuntimeError(
            "another DGC process kept rewriting this state_dir's config while the session "
            "started; use a separate state_dir per process")

    def resume(
        self,
        session_id: str | None = None,
        *,
        latest: bool = False,
        cwd: str | Path,
        permissions: dict | None = None,
        on_permission: OnPermission | None = None,
        on_plan: OnPlan | None = None,
        on_question: OnQuestion | None = None,
        on_mcp_input: OnMcpInput | None = None,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        mode: PermissionMode | None = None,
        thinking: str | None = None,
        tools: Sequence[ToolSpec] = (),
        instructions: str | None = None,
        max_turns: int | None = None,
        sandbox: dict[str, str] | None = None,
        verify_command: str | None = None,
        decision_timeout: float | None = 30.0,
        turn_budget_s: int | None = None,
        max_tokens: int | None = None,
    ) -> Session:
        """Open a session on a persisted transcript (``session_id`` or ``latest=True``).

        Takes the same options as :meth:`session`.
        """
        session = self.session(
            cwd=cwd, permissions=permissions, on_permission=on_permission, on_plan=on_plan,
            on_question=on_question, on_mcp_input=on_mcp_input, model=model, base_url=base_url,
            api_key=api_key, mode=mode, thinking=thinking, tools=tools, instructions=instructions,
            max_turns=max_turns, sandbox=sandbox, verify_command=verify_command,
            decision_timeout=decision_timeout, turn_budget_s=turn_budget_s, max_tokens=max_tokens,
        )
        command: dict[str, Any] = {"type": "resume_session", "request_id": _new_id("resume")}
        path = session_id
        if latest or not session_id:
            command["latest"] = True
        else:
            looks_like_path = session_id.endswith(".json") or "/" in session_id or "\\" in session_id
            if not looks_like_path:
                match = next((item for item in session.list_sessions() if item.id == session_id), None)
                if match is None:
                    session.close()
                    raise DGCConfigError(f"no persisted session {session_id!r}")
                path = match.path
            command["path"] = path
        try:
            event = session.raw.request(command, "session", timeout=15.0)
        except Exception:
            session.close()
            raise
        session.session_id = str(event.get("session_id") or session_id or session.session_id)
        session.session_path = str(event.get("path") or path or session.session_path)
        session._discard_idle_events()
        try:
            session.bind_identity()
        except Exception:
            pass
        return session

    def _install_tools(self, transport: DGCClient, slot: Path,
                       tools: list[ToolSpec]) -> ToolHub:
        socket_path = _mcp_socket_path(slot)
        hub = ToolHub(socket_path, tools)
        hub.start()
        python = self._runtime[0] if self._runtime else sys.executable
        bridge = str(Path(__file__).resolve().parent / "_mcp_bridge.py")
        argv = [bridge, socket_path]
        runtime_spec = {
            "transport": "stdio",
            "command": python,
            "args": argv,
            "env": {},
            "env_names": [],
            "log_level": "warning",
        }
        persisted = {
            "transport": "stdio",
            "command": python,
            "args": argv,
            "env_names": [],
            "log_level": "warning",
        }
        try:
            catalog = transport.request(
                {
                    "type": "upsert_mcp_server",
                    "request_id": _new_id("mcp"),
                    "name": "app",
                    "runtime": runtime_spec,
                    "persisted": persisted,
                },
                "mcp_servers",
                timeout=20.0,
            )
        except Exception:
            hub.close()
            raise
        if catalog.get("error"):
            hub.close()
            raise DGCRuntimeError(f"custom tools failed to connect: {catalog.get('error')}")
        return hub

    def usage_report(self, *, department: str | None = None) -> dict[str, Any]:
        """Queryable isolated usage (JSONL). Does not read host ~/.dgc."""
        return self._usage_log.query(department=department)

    def export_audit(self, session_id: str | None = None, *,
                     redact: bool = True) -> list[dict[str, Any]]:
        return self._audit_log.export(session_id, redact_output=redact)

    def close(self) -> None:
        self._closed = True
        while self._sessions:
            session = self._sessions.pop()
            session.close()

    def __enter__(self) -> "DGC":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


class AsyncRunHandle:
    """Async view of :class:`RunHandle`. Pipe waits stay on a worker thread.

    If the awaiting task is cancelled (a client disconnected), the run is cancelled too and
    drained in the background, so the session is free for the next run.
    """

    def __init__(self, handle: RunHandle):
        self._handle = handle

    @property
    def run_id(self) -> str:
        return self._handle.run_id

    def __aiter__(self) -> "AsyncRunHandle":
        return self

    async def __anext__(self) -> RunEvent:
        future = asyncio.ensure_future(asyncio.to_thread(self._next))
        try:
            event = await asyncio.shield(future)
        except asyncio.CancelledError:
            self._abandon_in_background(future)
            raise
        if event is None:
            raise StopAsyncIteration
        return event

    def _next(self) -> RunEvent | None:
        try:
            return self._handle._step()
        except StopIteration:
            return None

    async def result(self, timeout: float | None = None) -> RunResult:
        future = asyncio.ensure_future(asyncio.to_thread(self._handle.result, timeout))
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            self._abandon_in_background(future)
            raise

    def cancel(self) -> _Completed:
        """Cancel the run now. Awaiting the return value is optional."""
        self._handle.cancel()
        return _Completed()

    def _abandon_in_background(self, pending: "asyncio.Future[Any] | None" = None) -> None:
        handle = self._handle

        def drain() -> None:
            handle._abandon()

        if pending is not None and not pending.done():
            # The worker still holds the run; cancel now, drain once it lets go.
            try:
                handle.cancel()
            except Exception as exc:
                log.debug("cancel after task cancellation failed: %s", exc)
        threading.Thread(target=drain, daemon=True, name="dgc-sdk-abandon").start()

    async def __aenter__(self) -> "AsyncRunHandle":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        if not self._handle._done:
            future = asyncio.ensure_future(asyncio.to_thread(self._handle._abandon))
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:
                raise


class AsyncSession:
    """Async wrapper with the same methods as :class:`Session`. Pipe waits stay on a worker
    thread; async decision callbacks run on the event loop that created the session."""

    def __init__(self, sync: Session):
        self._sync = sync

    @property
    def session_id(self) -> str:
        return self._sync.session_id

    @property
    def session_path(self) -> str:
        return self._sync.session_path

    @property
    def protocol_version(self) -> Any:
        return self._sync.protocol_version

    @property
    def capabilities(self) -> dict[str, Any]:
        return self._sync.capabilities

    @property
    def raw(self) -> DGCClient:
        return self._sync.raw

    @property
    def sync(self) -> Session:
        """The underlying :class:`Session`."""
        return self._sync

    async def run(
        self,
        prompt: str,
        *,
        timeout: float | None = 180.0,
        max_turns: int | None = None,
        output_schema: Mapping[str, Any] | None = None,
        skills: Sequence[str] | None = None,
        workflow: str | None = None,
        repair_attempts: int = 1,
    ) -> RunResult:
        handle = await self.stream(
            prompt, timeout=timeout, max_turns=max_turns, output_schema=output_schema,
            skills=skills, workflow=workflow, repair_attempts=repair_attempts)
        return await handle.result()

    async def stream(
        self,
        prompt: str,
        *,
        timeout: float | None = 180.0,
        max_turns: int | None = None,
        output_schema: Mapping[str, Any] | None = None,
        skills: Sequence[str] | None = None,
        workflow: str | None = None,
        repair_attempts: int = 1,
    ) -> AsyncRunHandle:
        return await self._start(lambda: self._sync.stream(
            prompt, timeout=timeout, max_turns=max_turns, output_schema=output_schema,
            skills=skills, workflow=workflow, repair_attempts=repair_attempts))

    async def followup(
        self,
        text: str,
        *,
        timeout: float | None = 180.0,
        output_schema: Mapping[str, Any] | None = None,
        skills: Sequence[str] | None = None,
        repair_attempts: int = 1,
    ) -> AsyncRunHandle:
        return await self._start(lambda: self._sync.followup(
            text, timeout=timeout, output_schema=output_schema, skills=skills,
            repair_attempts=repair_attempts))

    async def _start(self, starter: Any) -> AsyncRunHandle:
        future = asyncio.ensure_future(asyncio.to_thread(starter))
        try:
            handle = await asyncio.shield(future)
        except asyncio.CancelledError:
            def settle(done: "asyncio.Future[Any]") -> None:
                if not done.cancelled() and done.exception() is None:
                    AsyncRunHandle(done.result())._abandon_in_background()
            future.add_done_callback(settle)
            raise
        return AsyncRunHandle(handle)

    async def cancel(self) -> None:
        await asyncio.to_thread(self._sync.cancel)

    async def steer(self, text: str) -> None:
        await asyncio.to_thread(self._sync.steer, text)

    async def bind_identity(self) -> None:
        await asyncio.to_thread(self._sync.bind_identity)

    async def list_sessions(self) -> list[SessionInfo]:
        return await asyncio.to_thread(self._sync.list_sessions)

    async def delete_session(self, path: str) -> list[SessionInfo]:
        return await asyncio.to_thread(self._sync.delete_session, path)

    async def list_checkpoints(self) -> list[Checkpoint]:
        return await asyncio.to_thread(self._sync.list_checkpoints)

    async def rewind(self, index: int) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.rewind, index)

    async def fork(self, name: str | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.fork, name)

    async def new_session(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.new_session)

    async def name_session(self, name: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.name_session, name)

    async def history(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.history)

    async def get_usage(self, range: str = "today") -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_usage, range)

    async def list_skills(self) -> list[SkillInfo]:
        return await asyncio.to_thread(self._sync.list_skills)

    async def get_skill(self, name: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_skill, name)

    async def set_skill_enabled(self, name: str, enabled: bool) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.set_skill_enabled, name, enabled)

    async def get_goal(self) -> Goal:
        return await asyncio.to_thread(self._sync.get_goal)

    async def set_goal(self, text: str, *, status: str = "active",
                       token_budget: int | None = None, replace: bool = False) -> Goal:
        return await asyncio.to_thread(
            lambda: self._sync.set_goal(text, status=status, token_budget=token_budget,
                                        replace=replace))

    async def list_monitors(self) -> list[Monitor]:
        return await asyncio.to_thread(self._sync.list_monitors)

    async def stop_monitor(self, monitor_id: str = "all") -> list[Monitor]:
        return await asyncio.to_thread(self._sync.stop_monitor, monitor_id)

    async def list_hooks(self) -> list[HookInfo]:
        return await asyncio.to_thread(self._sync.list_hooks)

    async def get_memory(self) -> dict[str, str]:
        return await asyncio.to_thread(self._sync.get_memory)

    async def add_memory(self, text: str, *, scope: str = "project") -> dict[str, str]:
        return await asyncio.to_thread(lambda: self._sync.add_memory(text, scope=scope))

    async def list_permissions(self) -> list[PermissionRule]:
        return await asyncio.to_thread(self._sync.list_permissions)

    async def add_permission_rule(self, action: str, rule: str) -> list[PermissionRule]:
        return await asyncio.to_thread(self._sync.add_permission_rule, action, rule)

    async def remove_permission_rule(self, action: str, rule: str) -> list[PermissionRule]:
        return await asyncio.to_thread(self._sync.remove_permission_rule, action, rule)

    async def add_mcp_server(self, name: str, command: str,
                             args: Sequence[str] | None = None) -> list[McpServerInfo]:
        return await asyncio.to_thread(self._sync.add_mcp_server, name, command, args)

    async def list_mcp_servers(self) -> list[McpServerInfo]:
        return await asyncio.to_thread(self._sync.list_mcp_servers)

    async def generate_handoff(self, *, save: bool = False) -> dict[str, Any]:
        return await asyncio.to_thread(lambda: self._sync.generate_handoff(save=save))

    async def list_artifacts(self) -> list[Artifact]:
        return await asyncio.to_thread(self._sync.list_artifacts)

    async def list_agents(self) -> list[AgentInfo]:
        return await asyncio.to_thread(self._sync.list_agents)

    async def clear_todos(self) -> list[TaskItem]:
        return await asyncio.to_thread(self._sync.clear_todos)

    async def get_config(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_config)

    async def get_plan(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_plan)

    async def close(self) -> None:
        await asyncio.to_thread(self._sync.close)

    async def __aenter__(self) -> "AsyncSession":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()


class AsyncDGC:
    """Async facade over :class:`DGC` with the same options and methods. The child and pipe
    pump stay on a worker thread; ``on_permission`` and the other callbacks may be ``async``."""

    def __init__(
        self,
        *,
        runtime: Sequence[str] | None = None,
        state_dir: str | Path | None = None,
        inherit_user_state: bool = False,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        mode: PermissionMode = "default",
        thinking: str = "off",
        extra_env: dict[str, str] | None = None,
        sandbox: dict[str, str] | None = None,
        instructions: str = "",
        pricing: Any = None,
        department: str = "",
        policy: Any = None,
        retry: Any = None,
        extra_config: Mapping[str, Any] | None = None,
    ):
        self._sync = DGC(
            runtime=runtime, state_dir=state_dir, inherit_user_state=inherit_user_state,
            model=model, base_url=base_url, api_key=api_key, mode=mode, thinking=thinking,
            extra_env=extra_env, sandbox=sandbox, instructions=instructions, pricing=pricing,
            department=department, policy=policy, retry=retry, extra_config=extra_config,
        )

    @property
    def version(self) -> str:
        return self._sync.version

    @property
    def state_dir(self) -> Path:
        return self._sync.state_dir

    @property
    def raw_runtime(self) -> list[str]:
        return self._sync.raw_runtime

    @property
    def sync(self) -> DGC:
        """The underlying :class:`DGC`."""
        return self._sync

    async def session(
        self,
        *,
        cwd: str | Path,
        permissions: dict | None = None,
        on_permission: OnPermission | None = None,
        on_plan: OnPlan | None = None,
        on_question: OnQuestion | None = None,
        on_mcp_input: OnMcpInput | None = None,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        mode: PermissionMode | None = None,
        thinking: str | None = None,
        tools: Sequence[ToolSpec] = (),
        instructions: str | None = None,
        max_turns: int | None = None,
        sandbox: dict[str, str] | None = None,
        verify_command: str | None = None,
        decision_timeout: float | None = 30.0,
        turn_budget_s: int | None = None,
        max_tokens: int | None = None,
    ) -> AsyncSession:
        return await self._open(lambda: self._sync.session(
            cwd=cwd, permissions=permissions, on_permission=on_permission, on_plan=on_plan,
            on_question=on_question, on_mcp_input=on_mcp_input, model=model, base_url=base_url,
            api_key=api_key, mode=mode, thinking=thinking, tools=tools, instructions=instructions,
            max_turns=max_turns, sandbox=sandbox, verify_command=verify_command,
            decision_timeout=decision_timeout, turn_budget_s=turn_budget_s, max_tokens=max_tokens,
        ))

    async def resume(
        self,
        session_id: str | None = None,
        *,
        latest: bool = False,
        cwd: str | Path,
        permissions: dict | None = None,
        on_permission: OnPermission | None = None,
        on_plan: OnPlan | None = None,
        on_question: OnQuestion | None = None,
        on_mcp_input: OnMcpInput | None = None,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        mode: PermissionMode | None = None,
        thinking: str | None = None,
        tools: Sequence[ToolSpec] = (),
        instructions: str | None = None,
        max_turns: int | None = None,
        sandbox: dict[str, str] | None = None,
        verify_command: str | None = None,
        decision_timeout: float | None = 30.0,
        turn_budget_s: int | None = None,
        max_tokens: int | None = None,
    ) -> AsyncSession:
        return await self._open(lambda: self._sync.resume(
            session_id, latest=latest,
            cwd=cwd, permissions=permissions, on_permission=on_permission, on_plan=on_plan,
            on_question=on_question, on_mcp_input=on_mcp_input, model=model, base_url=base_url,
            api_key=api_key, mode=mode, thinking=thinking, tools=tools, instructions=instructions,
            max_turns=max_turns, sandbox=sandbox, verify_command=verify_command,
            decision_timeout=decision_timeout, turn_budget_s=turn_budget_s, max_tokens=max_tokens,
        ))

    async def _open(self, opener: Any) -> AsyncSession:
        loop = asyncio.get_running_loop()
        future = asyncio.ensure_future(asyncio.to_thread(opener))
        try:
            session = await asyncio.shield(future)
        except asyncio.CancelledError:
            def close(done: "asyncio.Future[Any]") -> None:
                if not done.cancelled() and done.exception() is None:
                    done.result().close()
            future.add_done_callback(close)
            raise
        session._set_callback_loop(loop)
        return AsyncSession(session)

    def usage_report(self, *, department: str | None = None) -> dict[str, Any]:
        return self._sync.usage_report(department=department)

    def export_audit(self, session_id: str | None = None, *,
                     redact: bool = True) -> list[dict[str, Any]]:
        return self._sync.export_audit(session_id, redact=redact)

    async def close(self) -> None:
        await asyncio.to_thread(self._sync.close)

    async def __aenter__(self) -> "AsyncDGC":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()
