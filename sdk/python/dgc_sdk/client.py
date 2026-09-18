"""Public DGC / AsyncDGC facades."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .wire.client import DGCClient, DGCProtocolError as WireProtocolError, DGCStartError

from ._mcp_bridge import ToolHub, install_tools
from ._version import PROTOCOL, REQUIRES_CLI, __version__
from .errors import DGCConfigError, DGCProtocolError, DGCRuntimeError
from .policy import (
    RuntimePolicy, compile_session, permission_settings, sandbox_precheck, sandbox_requirement,
)
from .runtime import default_runtime_argv, isolated_env, write_isolated_config
from .session import RunHandle, Session, _new_id
from .types import (
    OnMcpInput, OnPermission, OnPlan, OnQuestion, PermissionMode, PermissionPolicy, RunEvent,
    RunResult, SandboxPolicy, SandboxStatus, ToolSpec,
)


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


class DGC:
    """Own zero or more isolated DGC sessions. Does not talk to a provider on import."""

    def __init__(
        self,
        *,
        runtime: Sequence[str] | None = None,
        state_dir: str | Path,
        inherit_user_state: bool = False,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        mode: PermissionMode = "default",
        thinking: str = "off",
        extra_env: dict[str, str] | None = None,
        sandbox: SandboxPolicy | Mapping[str, str] | None = None,
        instructions: str = "",
        pricing=None,
        department: str = "",
        policy: RuntimePolicy | None = None,
        retry=None,
    ):
        if policy is not None and not isinstance(policy, RuntimePolicy):
            raise DGCConfigError(f"policy must be a RuntimePolicy, not {type(policy).__name__}")
        self._state_dir = Path(state_dir).expanduser().resolve()
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._inherit = bool(inherit_user_state)
        self._runtime = list(runtime) if runtime is not None else default_runtime_argv()
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._mode = mode
        self._thinking = thinking
        self._extra_env = extra_env
        self._sandbox = sandbox_requirement(sandbox)
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
        sandbox_precheck(self._sandbox)

    @property
    def version(self) -> str:
        return __version__

    @property
    def raw_runtime(self) -> list[str]:
        return list(self._runtime)

    def session(
        self,
        *,
        cwd: str | Path,
        permissions: PermissionPolicy | Mapping[str, str] | None = None,
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
        sandbox: SandboxPolicy | Mapping[str, str] | None = None,
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
        perm_mode, unhandled = permission_settings(
            permissions, mode=mode, default_mode=self._mode, on_permission=on_permission)
        requirement = sandbox_requirement(sandbox) if sandbox is not None else self._sandbox
        sandbox_precheck(requirement)
        # The RuntimePolicy and sandbox reach this session's runtime only through its
        # environment (DGC_SESSION_POLICY); nothing is written to any config.json.
        plan = compile_session(
            self._policy, cwd=workspace, mode=perm_mode, on_permission=on_permission,
            sandbox=requirement, tools=[spec.name for spec in tools])
        key = api_key if api_key is not None else self._api_key
        extra = dict(self._extra_env or {})
        if key and not self._inherit:
            extra["DGC_API_KEY"] = str(key)
        extra.update(plan.env)
        if not self._inherit:
            isolated_values: dict[str, object] = {
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
                "sandbox": False,
                "sandbox_network": bool(self._policy and getattr(self._policy, "network", "deny") == "allow"),
            }
            isolated_values.update(self._retry.isolated_values())
            if max_turns is not None:
                isolated_values["max_turns"] = int(max_turns)
            if turn_budget_s is not None:
                isolated_values["turn_budget_s"] = int(turn_budget_s)
            if max_tokens is not None:
                isolated_values["max_tokens"] = int(max_tokens)
            if verify_command:
                isolated_values["verify_command"] = verify_command
                isolated_values["verify_before_done"] = True
            write_isolated_config(self._state_dir, isolated_values)
        env = isolated_env(
            self._state_dir, extra=extra, inherit_user_state=self._inherit,
            project_root=None if self._inherit else workspace,
        )
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
        try:
            sandbox_status = plan.confirm(ready)
        except Exception:
            transport.close()
            raise
        hub = None
        if tools:
            try:
                hub = self._install_tools(transport, list(tools))
            except Exception:
                transport.close()
                raise
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
            permission_mode=perm_mode,
        )
        session._verify_command = verify_command or ""
        session.sandbox = sandbox_status
        try:
            session.bind_identity()
        except Exception:
            pass
        self._sessions.append(session)
        return session

    def resume(self, session_id: str | None = None, *, latest: bool = False, **kwargs) -> Session:
        session = self.session(**kwargs)
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

    def _install_tools(self, transport: DGCClient, tools: list[ToolSpec]) -> ToolHub:
        """Serve ``tools`` from this process as MCP server ``app``; raise if DGC cannot reach them."""
        return install_tools(transport, tools, runtime=self._runtime, request_id=_new_id("mcp"))

    def usage_report(self, *, department: str | None = None) -> dict:
        """Queryable isolated usage (JSONL). Does not read host ~/.dgc."""
        return self._usage_log.query(department=department)

    def export_audit(self, session_id: str | None = None, *, redact: bool = True) -> list:
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
    """Async view of :class:`RunHandle`. Pipe waits stay on a worker thread."""

    def __init__(self, handle: RunHandle):
        self._handle = handle
        self._iter: Any = None

    def __aiter__(self) -> "AsyncRunHandle":
        if self._iter is None:
            self._iter = iter(self._handle)
        return self

    async def __anext__(self) -> RunEvent:
        if self._iter is None:
            self._iter = iter(self._handle)

        def _next() -> tuple[RunEvent | None, bool]:
            try:
                return next(self._iter), False
            except StopIteration:
                return None, True
        event, done = await asyncio.to_thread(_next)
        if done or event is None:
            raise StopAsyncIteration
        return event

    async def result(self) -> RunResult:
        return await asyncio.to_thread(self._handle.result)

    def cancel(self) -> None:
        self._handle.cancel()

    async def __aenter__(self) -> "AsyncRunHandle":
        return self

    async def __aexit__(self, *_exc) -> None:
        if not self._handle._consumed:
            try:
                self.cancel()
            except Exception:
                pass
            try:
                await self.result()
            except Exception:
                pass


class AsyncSession:
    """Async wrapper: pipe waits stay on a worker thread."""

    def __init__(self, sync: Session):
        self._sync = sync

    @property
    def session_id(self) -> str:
        return self._sync.session_id

    @property
    def session_path(self) -> str:
        return self._sync.session_path

    @property
    def raw(self):
        return self._sync.raw

    @property
    def sandbox(self) -> SandboxStatus:
        return self._sync.sandbox

    async def run(self, prompt: str, **kwargs) -> RunResult:
        return await asyncio.to_thread(self._sync.run, prompt, **kwargs)

    async def stream(self, prompt: str, **kwargs) -> AsyncRunHandle:
        handle = await asyncio.to_thread(self._sync.stream, prompt, **kwargs)
        return AsyncRunHandle(handle)

    async def cancel(self) -> None:
        await asyncio.to_thread(self._sync.cancel)

    async def list_sessions(self):
        return await asyncio.to_thread(self._sync.list_sessions)

    async def list_checkpoints(self):
        return await asyncio.to_thread(self._sync.list_checkpoints)

    async def rewind(self, index: int):
        return await asyncio.to_thread(self._sync.rewind, index)

    async def fork(self, name: str | None = None):
        return await asyncio.to_thread(self._sync.fork, name)

    async def history(self):
        return await asyncio.to_thread(self._sync.history)

    async def get_goal(self):
        return await asyncio.to_thread(self._sync.get_goal)

    async def set_goal(self, text: str, **kwargs):
        return await asyncio.to_thread(lambda: self._sync.set_goal(text, **kwargs))

    async def list_hooks(self):
        return await asyncio.to_thread(self._sync.list_hooks)

    async def get_memory(self):
        return await asyncio.to_thread(self._sync.get_memory)

    async def add_memory(self, text: str, **kwargs):
        return await asyncio.to_thread(lambda: self._sync.add_memory(text, **kwargs))

    async def list_permissions(self):
        return await asyncio.to_thread(self._sync.list_permissions)

    async def list_mcp_servers(self):
        return await asyncio.to_thread(self._sync.list_mcp_servers)

    async def close(self) -> None:
        await asyncio.to_thread(self._sync.close)

    async def __aenter__(self) -> "AsyncSession":
        return self

    async def __aexit__(self, *_exc) -> None:
        await self.close()


class AsyncDGC:
    """Async facade over :class:`DGC`. The child and pipe pump stay on a worker thread."""

    def __init__(self, **kwargs):
        self._sync = DGC(**kwargs)

    @property
    def version(self) -> str:
        return self._sync.version

    async def session(self, **kwargs) -> AsyncSession:
        session = await asyncio.to_thread(self._sync.session, **kwargs)
        return AsyncSession(session)

    async def resume(self, session_id: str | None = None, *, latest: bool = False,
                     **kwargs) -> AsyncSession:
        session = await asyncio.to_thread(
            lambda: self._sync.resume(session_id, latest=latest, **kwargs))
        return AsyncSession(session)

    async def close(self) -> None:
        await asyncio.to_thread(self._sync.close)

    async def __aenter__(self) -> "AsyncDGC":
        return self

    async def __aexit__(self, *_exc) -> None:
        await self.close()
