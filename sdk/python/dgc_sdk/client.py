"""Public DGC / AsyncDGC facades."""

from __future__ import annotations

import asyncio
import hashlib
import math
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .wire.client import DGCClient, DGCClientError, DGCProtocolError as WireProtocolError

from ._mcp_bridge import ToolHub
from ._version import PROTOCOL, REQUIRES_CLI, __version__
from .errors import (
    DGCCommandRejectedError, DGCConfigError, DGCError, DGCProtocolError, DGCRuntimeError,
    public_error,
)
from .policy import inspect_bash_for_engine
from .runtime import (
    RuntimeSpec, bridge_python, discover_runtime, isolated_env, require_sandbox,
    runtime_for_argv, write_isolated_config,
)
from .session import RunHandle, Session, _new_id
from .types import (
    OnMcpInput, OnPermission, OnPlan, OnQuestion, PermissionMode, RunEvent, RunResult,
    SandboxRequirement, ToolSpec, UnhandledPolicy,
)


def _mcp_socket_path(slot: Path) -> str:
    """Unix-domain bind paths are short (104 bytes on macOS). Always use /tmp."""
    digest = hashlib.sha1(str(slot.resolve()).encode()).hexdigest()[:12]
    return f"/tmp/dgc-{digest}.sock"


def _seconds(value: Any, name: str, *, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DGCConfigError(f"{name} must be a number of seconds")
    number = float(value)
    if not math.isfinite(number) or number <= 0 or number > maximum:
        raise DGCConfigError(f"{name} must be more than 0 and at most {maximum:g} seconds")
    return number


def _runtime_argv(runtime: Any) -> list[str]:
    if isinstance(runtime, (str, bytes)) or not isinstance(runtime, Sequence):
        raise DGCConfigError("runtime must be an argv list such as ['dgc', 'serve'], not a string")
    argv = list(runtime)
    if not argv or any(not isinstance(item, str) or not item or "\0" in item for item in argv):
        raise DGCConfigError("runtime must be a non-empty list of non-empty strings")
    return argv


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
    """Own zero or more isolated DGC sessions. Does not talk to a provider on import.

    ``runtime`` is the ``dgc serve`` argv; by default it is discovered (see
    :mod:`dgc_sdk.runtime`). ``inherit_env`` chooses which host environment variables reach the
    runtime and the agent's tools: ``False`` passes only :data:`dgc_sdk.runtime.BASE_ENV`, a list
    of names adds those, ``True`` passes everything. ``extra_env`` sets values explicitly.
    ``start_timeout`` bounds the runtime's startup handshake and ``request_timeout`` each control
    request (list_sessions, set_goal, and so on); both are in seconds.
    """

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
        sandbox: dict[str, str] | None = None,
        instructions: str = "",
        pricing=None,
        department: str = "",
        policy=None,
        retry=None,
        inherit_env: bool | Sequence[str] = False,
        start_timeout: float = 30.0,
        request_timeout: float = 15.0,
    ):
        try:
            self._state_dir = Path(state_dir).expanduser().resolve()
            self._state_dir.mkdir(parents=True, exist_ok=True)
        except (OSError, RuntimeError, TypeError) as exc:
            raise DGCConfigError(f"state_dir is not a usable directory: {exc}") from exc
        self._inherit = bool(inherit_user_state)
        if not isinstance(inherit_env, bool):
            if isinstance(inherit_env, (str, bytes)) or not isinstance(inherit_env, Sequence):
                raise DGCConfigError("inherit_env must be True, False, or a list of variable names")
            inherit_env = tuple(inherit_env)
            for name in inherit_env:
                if not isinstance(name, str) or not name or "=" in name or "\0" in name:
                    raise DGCConfigError(f"inherit_env has an invalid variable name: {name!r}")
        self._inherit_env: bool | tuple[str, ...] = inherit_env
        self._start_timeout = _seconds(start_timeout, "start_timeout", maximum=3600.0)
        self._request_timeout = _seconds(request_timeout, "request_timeout", maximum=86400.0)
        self._runtime_spec: RuntimeSpec = (
            runtime_for_argv(_runtime_argv(runtime)) if runtime is not None else discover_runtime())
        self._runtime = list(self._runtime_spec.argv)
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
        perm_mode: PermissionMode = mode or policy.get("mode") or self._mode
        if perm_mode not in ("default", "acceptEdits", "plan", "auto"):
            raise DGCConfigError("invalid permission mode")
        sandbox_spec = sandbox or self._sandbox
        requirement: SandboxRequirement = sandbox_spec.get("requirement") or "off"  # type: ignore[assignment]
        backend = require_sandbox(requirement)
        key = api_key if api_key is not None else self._api_key
        extra = dict(self._extra_env or {})
        if key and not self._inherit:
            extra["DGC_API_KEY"] = str(key)
        inspect_bash = inspect_bash_for_engine(
            on_permission=on_permission, permission_mode=perm_mode)
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
        try:
            env = isolated_env(
                self._state_dir, extra=extra, inherit_user_state=self._inherit,
                project_root=None if self._inherit else workspace,
                pythonpath=self._runtime_spec.pythonpath, inherit_env=self._inherit_env,
            )
            transport = DGCClient(
                self._runtime, cwd=str(workspace), env=env, start_timeout=self._start_timeout,
                event_timeout=30.0)
        except OSError as exc:
            raise DGCConfigError(f"could not prepare the isolated runtime home: {exc}") from exc
        except ValueError as exc:
            if isinstance(exc, DGCError):
                raise
            raise DGCConfigError(f"invalid runtime settings: {exc}") from exc
        hub = None
        try:
            try:
                ready = transport.start()
            except WireProtocolError as exc:
                raise self._protocol_error(exc) from exc
            except DGCClientError as exc:
                raise DGCRuntimeError(self._start_failure(exc, transport, key)) from exc
            protocol = ready.get("protocol_version")
            if protocol is not None and int(protocol) != PROTOCOL:
                raise self._protocol_error(WireProtocolError(
                    "protocol mismatch", offered_protocol=protocol,
                    backend_version=str(ready.get("version") or "")))
            if tools:
                tool_dir = self._state_dir / f"tools-{_new_id('t')[-8:]}"
                tool_dir.mkdir(parents=True, exist_ok=True)
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
                permission_mode=perm_mode,
            )
            session._verify_command = verify_command or ""
            session._request_timeout = self._request_timeout
            if self._policy is not None:
                for rule in self._policy.engine_deny_rules(inspect_bash=inspect_bash):
                    try:
                        session.add_permission_rule("deny", rule)
                    except Exception:
                        pass
            try:
                session.bind_identity()
            except Exception:
                pass
        except BaseException as exc:
            # Nothing may outlive a failed setup: not the tool socket, not the dgc serve child.
            if hub is not None:
                hub.close()
            transport.close()
            if not isinstance(exc, Exception):
                raise
            if isinstance(exc, DGCError) and not isinstance(exc, DGCClientError):
                raise
            raise public_error(exc, context="session setup failed") from exc
        self._sessions.append(session)
        return session

    def _protocol_error(self, exc: WireProtocolError) -> DGCProtocolError:
        offered = getattr(exc, "offered_protocol", None)
        runtime = " ".join(self._runtime)
        if offered is None:
            return DGCProtocolError(f"the DGC runtime broke protocol v{PROTOCOL}: {exc} "
                                    f"(runtime: {runtime})")
        cli = getattr(exc, "backend_version", "") or "unknown"
        if isinstance(offered, int) and offered > PROTOCOL:
            advice = "Upgrade dgc-sdk (pip install -U dgc-sdk) to drive this CLI."
        else:
            advice = ("Update the CLI (dgc update), or point DGC_PYTHON or runtime= at a DGC "
                      f"that is {REQUIRES_CLI} or newer.")
        return DGCProtocolError(
            f"DGC SDK {__version__} speaks protocol v{PROTOCOL} and needs CLI {REQUIRES_CLI} or "
            f"newer; the runtime is CLI {cli} with protocol v{offered} ({runtime}). {advice}")

    def _start_failure(self, exc: BaseException, transport: DGCClient, key: Any) -> str:
        message = f"the DGC runtime did not start: {exc} (runtime: {' '.join(self._runtime)})"
        tail = transport.stderr_tail.strip()
        if tail:
            lines = "\n".join(tail.splitlines()[-12:])[-2000:]
            for secret in {str(key or ""), str(self._api_key or "")}:
                if len(secret) >= 4:
                    lines = lines.replace(secret, "[redacted]")
            message += "\nruntime stderr (last lines):\n" + lines
        return message

    def resume(self, session_id: str | None = None, *, latest: bool = False, **kwargs) -> Session:
        session = self.session(**kwargs)
        command: dict[str, Any] = {"type": "resume_session", "request_id": _new_id("resume")}
        path = session_id
        target = "the latest session" if latest or not session_id else repr(session_id)
        try:
            if latest or not session_id:
                command["latest"] = True
            else:
                looks_like_path = (session_id.endswith(".json") or "/" in session_id
                                   or "\\" in session_id)
                if not looks_like_path:
                    match = next((item for item in session.list_sessions()
                                  if item.id == session_id), None)
                    if match is None:
                        raise DGCConfigError(f"no persisted session {session_id!r}")
                    path = match.path
                command["path"] = path
            event = session.raw.request(command, "session", timeout=self._request_timeout)
        except BaseException as exc:
            session.close()
            if session in self._sessions:
                self._sessions.remove(session)
            if isinstance(exc, DGCCommandRejectedError):
                raise DGCConfigError(f"could not resume {target}: {exc}") from exc
            if not isinstance(exc, Exception) or (
                    isinstance(exc, DGCError) and not isinstance(exc, DGCClientError)):
                raise
            raise public_error(exc, context=f"could not resume {target}") from exc
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
        # The bridge is a stdlib-only script run by a Python, never by runtime[0] (that may be
        # the dgc launcher). -I keeps this package's directory off its sys.path.
        python = bridge_python(self._runtime_spec)
        bridge = str(Path(__file__).resolve().parent / "_mcp_bridge.py")
        argv = ["-I", bridge, socket_path]
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
                timeout=max(20.0, self._request_timeout),
            )
        except Exception:
            hub.close()
            raise
        if catalog.get("error"):
            hub.close()
            raise DGCRuntimeError(f"custom tools failed to connect: {catalog.get('error')}")
        return hub

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
