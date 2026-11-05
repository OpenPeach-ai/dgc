"""A ChatDGC model request on a signed-in, restricted subscription CLI.

The CLI sees only this request's DGC tools through the same private MCP relay used
by Personal Pips. A tool call ends this model request; ChatDGC executes the call
under its own rules and includes the result in the next request. This keeps all
plugin approvals, files, artifacts and conversation persistence in ChatDGC.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import re
import secrets
import signal
import subprocess
import tempfile
import threading
from pathlib import Path

from ..llm import ChatResult, ToolCall
from .. import pip_brain
from ..subscriptions import parse_stream_events

_DATA_IMAGE = re.compile(r"\Adata:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)\Z")
_TOOLS_NOTE = ("\n\nYour tools are supplied only by DGC's private MCP server. "
               "Use those tools when needed. You have no shell, browser, filesystem, "
               "plugin, approval, or other tool of your own. DGC handles each tool "
               "call and resumes you with its answer. Never claim a tool ran until "
               "its answer appears in the conversation.")


class SubscriptionChatClient:
    """The small LLMClient interface that ChatDGC uses for one model request."""

    tools_supported = True
    vision_supported = True
    reasoning_supported = True
    api_mode = "subscription"
    family = "subscription"
    base_url = ""
    context_size = 0

    def __init__(self, engine: str, model: str = ""):
        if engine not in pip_brain.ENGINES:
            raise ValueError("Choose Claude Code or Codex for this subscription.")
        reason = pip_brain.available(engine)
        if reason:
            raise RuntimeError(reason)
        if model:
            from ..pip_models import _model_id
            _model_id(model)
        self.engine = engine
        self.selected_model = model
        self.model = f"{pip_brain.name(engine)}" + (f" · {model}" if model else "")
        self._active = None

    def prepare_model(self, **_kwargs) -> dict:
        return {}

    def model_context_limit(self) -> int:
        # The chat's selected window is still enforced by ChatDGC's compactor.
        # CLI catalogs differ by version, so do not invent a larger limit here.
        return 0

    @staticmethod
    def _images(messages: list[dict]) -> list[tuple[str, bytes]]:
        last = next((m for m in reversed(messages) if m.get("role") == "user"), {})
        images = []
        for part in last.get("content") if isinstance(last.get("content"), list) else ():
            if not isinstance(part, dict) or part.get("type") != "image_url":
                continue
            value = part.get("image_url")
            uri = value.get("url") if isinstance(value, dict) else value
            match = _DATA_IMAGE.fullmatch(uri) if isinstance(uri, str) else None
            if match:
                images.append((match.group(1), base64.b64decode(match.group(2), validate=True)))
        return images

    @staticmethod
    def _stop(proc: subprocess.Popen | None) -> None:
        if proc is None or proc.poll() is not None:
            return
        try:
            if hasattr(os, "killpg"):
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except (OSError, ProcessLookupError):
            pass

    def close(self) -> None:
        """Stop an unfinished CLI and its private MCP relay when a reply ends."""
        state, self._active = self._active, None
        if state is None:
            return
        pending = state.get("pending")
        if pending is not None:
            try:
                pending[1].put_nowait({"text": "DGC stopped this tool call.", "error": True})
            except queue.Full:
                pass
        self._stop(state["proc"])
        state["server"].close()
        try:
            state["proc"].wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._stop(state["proc"])
        if state["proc"].stdout is not None:
            state["proc"].stdout.close()
        state["temporary"].cleanup()

    def _start(self, messages: list[dict], tools: list[dict] | None, effort: str) -> None:
        brain = {"engine": self.engine, "model": self.selected_model, "effort": ""}
        temporary = tempfile.TemporaryDirectory(prefix="dgc-chat-sub-")
        folder = Path(temporary.name) / "turn"
        server = None
        try:
            launch = pip_brain.launch_pin(brain, folder)
            calls: queue.Queue[tuple[ToolCall, queue.Queue]] = queue.Queue()
            lines: queue.Queue[bytes | None] = queue.Queue()

            def called(name: str, arguments: dict) -> dict:
                answer: queue.Queue[dict] = queue.Queue(maxsize=1)
                calls.put((ToolCall(id=f"sub_{secrets.token_hex(8)}", name=name,
                                    arguments=dict(arguments)), answer))
                return answer.get()

            server = pip_brain.ToolServer(tools or [], called)
            system = str(messages[0].get("content") or "") if messages and messages[0].get("role") == "system" else ""
            pip_brain._private_write(folder / "instructions.md", system + _TOOLS_NOTE)
            prompt = pip_brain.transcript(messages[1:] if system else messages)
            relay = pip_brain.relay_command()
            effort = effort if effort in pip_brain.EFFORTS[self.engine] else ""
            images = self._images(messages)
            if self.engine == "claude":
                config_file = folder / "mcp.json"
                pip_brain._private_write(config_file, json.dumps({"mcpServers": {pip_brain.SERVER: {
                    "type": "stdio", "command": relay[0], "args": relay[1:], "env": server.env(),
                    "alwaysLoad": True}}}))
                argv = pip_brain.claude_argv(launch["binary"], mcp_config=config_file,
                                             system_file=folder / "instructions.md",
                                             model=self.selected_model, effort=effort)
                parts = [{"type": "text", "text": prompt}] + [{"type": "image", "source": {
                    "type": "base64", "media_type": mime,
                    "data": base64.b64encode(raw).decode("ascii")}} for mime, raw in images]
                stdin = json.dumps({"type": "user", "message": {"role": "user", "content": parts}}) + "\n"
                env = pip_brain.child_env(launch)
            else:
                paths = []
                for index, (mime, raw) in enumerate(images):
                    image = folder / f"image-{index + 1}.{mime.split('/')[-1].replace('jpeg', 'jpg')}"
                    pip_brain._private_write(image, raw)
                    paths.append(image)
                catalog = pip_brain.codex_catalog(launch, folder)
                argv = pip_brain.codex_argv(launch["binary"], relay=relay,
                                            env_names=sorted(server.env()), system_file=folder / "instructions.md",
                                            folder=folder, catalog=catalog, model=self.selected_model,
                                            effort=effort, images=paths)
                stdin = prompt
                env = pip_brain.child_env(launch, server.env())
            proc = subprocess.Popen(argv, cwd=str(folder), env=env, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0,
                                    start_new_session=True)
            try:
                proc.stdin.write(stdin.encode("utf-8"))
                proc.stdin.close()
            except OSError:
                pass

            def read_lines() -> None:
                try:
                    while True:
                        raw = proc.stdout.readline(pip_brain.MAX_LINE + 1)
                        if not raw:
                            break
                        lines.put(raw)
                finally:
                    lines.put(None)

            threading.Thread(target=read_lines, daemon=True).start()
            self._active = {"temporary": temporary, "server": server, "proc": proc,
                            "calls": calls, "lines": lines, "pending": None}
        except BaseException:
            if server is not None:
                server.close()
            temporary.cleanup()
            raise

    def chat(self, messages: list[dict], tools: list[dict] | None = None, reasoning_effort: str | None = None,
             on_text=None, on_thinking=None, cancel=None) -> ChatResult:
        if cancel is not None and cancel.is_set():
            self.close()
            raise RuntimeError("Stopped before the model started.")
        state = self._active
        if state is not None:
            pending = state.get("pending")
            last = messages[-1] if messages else {}
            if pending is None or last.get("role") != "tool" or last.get("tool_call_id") != pending[0].id:
                self.close()
                state = None
            else:
                state["pending"] = None
                pending[1].put({"text": str(last.get("content") or ""), "error": False})
        if state is None:
            self._start(messages, tools, str(reasoning_effort or "").lower())
            state = self._active
        said: list[str] = []
        errors: list[str] = []
        usage: dict = {}
        try:
            while True:
                if cancel is not None and cancel.is_set():
                    raise RuntimeError("Stopped while the model was responding.")
                try:
                    pending = state["calls"].get_nowait()
                except queue.Empty:
                    pending = None
                if pending is not None:
                    state["pending"] = pending
                    return ChatResult(content="".join(said), tool_calls=[pending[0]],
                                      finish_reason="tool_calls", usage=usage)
                try:
                    raw = state["lines"].get(timeout=0.05)
                except queue.Empty:
                    continue
                if raw is None:
                    code = state["proc"].wait(timeout=5)
                    self.close()
                    if code != 0:
                        # Vendor CLIs report rate limits and account restrictions as structured
                        # events. Preserve that short reason without exposing raw stderr or the
                        # model's prompt to the editor.
                        reason = "Check its sign-in and model in Settings."
                        if errors:
                            if "429" in errors[-1] or "rate limit" in errors[-1].lower():
                                reason = "The subscription is rate limited. Try again later."
                            elif "disabled" in errors[-1].lower() and "subscription" in errors[-1].lower():
                                reason = "This organization has disabled subscription access."
                        raise RuntimeError(f"{pip_brain.name(self.engine)} stopped before completing this reply: {reason}")
                    if not said:
                        raise RuntimeError(f"{pip_brain.name(self.engine)} returned no reply.")
                    return ChatResult(content="".join(said), usage=usage)
                if len(raw) > pip_brain.MAX_LINE:
                    continue
                for event in parse_stream_events(pip_brain._engine(self.engine).stream,
                                                 raw.decode("utf-8", errors="replace")):
                    kind, value = event.get("kind"), event.get("text")
                    if kind == "text" and value:
                        said.append(str(value))
                        if on_text is not None:
                            on_text(str(value))
                    elif kind == "thinking" and value and on_thinking is not None:
                        on_thinking(str(value))
                    elif kind == "result" and value and not said:
                        said.append(str(value))
                        if on_text is not None:
                            on_text(str(value))
                    elif kind == "usage" and isinstance(event.get("usage"), dict):
                        usage = event["usage"]
                    elif kind == "error" and value:
                        errors.append(str(value)[:300])
        except BaseException:
            self.close()
            raise
