"""A ChatDGC model request on a signed-in, restricted subscription CLI.

The CLI sees only this request's DGC tools through the same private MCP relay used
by Personal Pips. A tool call ends this model request; ChatDGC executes the call
under its own rules and includes the result in the next request. This keeps all
plugin approvals, files, artifacts and conversation persistence in ChatDGC.

Work's turns use the same client when Dev Mode makes Claude Code or Codex their model
(dgc/work_cli.py): one CLI run per turn, held open across that turn's tool calls.
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
import time
from pathlib import Path

from ..llm import ChatResult, LLMError, ToolCall
from .. import pip_brain
from ..subscriptions import parse_stream_events

_DATA_IMAGE = re.compile(r"\Adata:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)\Z")
_TOOLS_NOTE = ("\n\nYour tools are supplied only by DGC's private MCP server. "
               "Use those tools when needed. You have no shell, browser, filesystem, "
               "plugin, approval, or other tool of your own. DGC handles each tool "
               "call and resumes you with its answer. Never claim a tool ran until "
               "its answer appears in the conversation.")
_PLUGIN = "mcp__"                    # a plugin's tool, mcp__<server>__<tool>: the CLI adds its own mcp__dgc__ before it


class SubscriptionError(LLMError, RuntimeError):
    """The CLI couldn't answer: a RuntimeError, as ChatDGC catches it, and an LLMError, so a Work turn takes its
    fallback as it does for any model that doesn't answer."""


def _flat(content) -> str:
    if isinstance(content, list):
        return "\n".join(str(part.get("text") or "") for part in content
                         if isinstance(part, dict) and part.get("type") == "text")
    return str(content or "")


def _pictures(content) -> list[tuple[str, bytes]]:
    found = []
    for part in content if isinstance(content, list) else ():
        if not isinstance(part, dict) or part.get("type") != "image_url":
            continue
        value = part.get("image_url")
        uri = value.get("url") if isinstance(value, dict) else value
        match = _DATA_IMAGE.fullmatch(uri) if isinstance(uri, str) else None
        if match:
            found.append((match.group(1), base64.b64decode(match.group(2), validate=True)))
    return found


def answer_for(messages: list[dict], call_id: str) -> dict | None:
    """The answer to the CLI's pending call in ``messages``: the tool's result, and what reached the conversation after
    it before the next request (a message the user sent while the turn ran, the pictures a tool showed), as the next
    request of a model DGC calls itself would read them. None when the conversation went another way."""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if message.get("role") == "tool" and message.get("tool_call_id") == call_id:
            later = messages[index + 1:]
            if any(m.get("role") not in ("user", "tool") for m in later):
                return None
            if any(m.get("role") == "tool" for m in later):
                return None
            text = _flat(message.get("content"))
            extra = [_flat(m.get("content")).strip() for m in later]
            text = "\n\n".join([text, *[words for words in extra if words]])
            images = [picture for m in [message, *later] for picture in _pictures(m.get("content"))]
            return {"text": text, "images": images,
                    "error": text.lower().startswith(("error", "permission denied"))}
        if message.get("role") == "assistant":
            return None
    return None


class SubscriptionChatClient:
    """The small LLMClient interface that ChatDGC uses for one model request."""

    tools_supported = True
    vision_supported = True
    reasoning_supported = True
    api_mode = "subscription"
    family = "subscription"
    base_url = ""
    context_size = 0
    tools_note = _TOOLS_NOTE
    stop_raises = True                # ChatDGC: a stop is an error; Work's client answers "cancelled", as natively
    keep_limits = False               # Work's client keeps the usage meter's numbers the CLI reports
    empty_raises = True               # a run that ends without words is an error; Work's turn has its own recovery
    tool_timeout_s = 900              # how long the CLI waits on one of DGC's tools

    def __init__(self, engine: str, model: str = "", *, effort: str = "", check: bool = True):
        if engine not in pip_brain.ENGINES:
            raise ValueError("Choose Claude Code or Codex for this subscription.")
        if check:
            reason = pip_brain.available(engine)
            if reason:
                raise RuntimeError(reason)
        if model:
            from ..pip_models import _model_id
            _model_id(model)
        self.engine = engine
        self.selected_model = model
        # The CLI's effort when it is set with the client (Work's: the session's subscription effort), else each
        # request's own.
        self.fixed_effort = effort if effort in pip_brain.EFFORTS[engine] else ""
        self.model = f"{pip_brain.name(engine)}" + (f" · {model}" if model else "")
        self._active = None
        self._names: dict[str, str] = {}

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
        waiting = [state["pending"]] if state.get("pending") is not None else []
        while True:                         # a call that came in as the reply ended: answered too, never left waiting
            try:
                waiting.append(state["calls"].get_nowait())
            except queue.Empty:
                break
        for pending in waiting:
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

    def _served(self, tools: list[dict] | None) -> list[dict]:
        """The tools as the CLI is offered them: a plugin's without DGC's own mcp__ (the CLI adds its own prefix), each
        name once. Its calls come back under DGC's own names (``_names``)."""
        served, self._names = [], {}
        for tool in tools or []:
            function = tool.get("function", tool) if isinstance(tool, dict) else {}
            name = str(function.get("name") or "")
            shown = name[len(_PLUGIN):] if name.startswith(_PLUGIN) and len(name) > len(_PLUGIN) else name
            if not shown or shown in self._names:
                continue
            self._names[shown] = name
            served.append({**tool, "function": {**function, "name": shown}} if "function" in tool else {**tool, "name": shown})
        return served

    def _start(self, messages: list[dict], tools: list[dict] | None, effort: str) -> None:
        brain = {"engine": self.engine, "model": self.selected_model, "effort": ""}
        temporary = tempfile.TemporaryDirectory(prefix="dgc-chat-sub-")
        folder = Path(temporary.name) / "turn"
        server = None
        try:
            try:
                launch = pip_brain.launch_pin(brain, folder)
            except Exception as error:            # not installed, signed out: said in the CLI's own plain words
                raise SubscriptionError(str(getattr(error, "message", "") or error)) from None
            calls: queue.Queue[tuple[ToolCall, queue.Queue]] = queue.Queue()
            lines: queue.Queue[bytes | None] = queue.Queue()
            names = self._names

            def called(name: str, arguments: dict) -> dict:
                answer: queue.Queue[dict] = queue.Queue(maxsize=1)
                calls.put((ToolCall(id=f"sub_{secrets.token_hex(8)}", name=names.get(name, name),
                                    arguments=dict(arguments)), answer))
                return answer.get()

            server = pip_brain.ToolServer(self._served(tools), called)
            system = str(messages[0].get("content") or "") if messages and messages[0].get("role") == "system" else ""
            pip_brain._private_write(folder / "instructions.md", system + self.tools_note)
            prompt = pip_brain.transcript(messages[1:] if system else messages)
            relay = pip_brain.relay_command()
            effort = self.fixed_effort or (effort if effort in pip_brain.EFFORTS[self.engine] else "")
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
                env = pip_brain.child_env(launch, {"MCP_TOOL_TIMEOUT": str(int(self.tool_timeout_s) * 1000)})
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
                                            effort=effort, images=paths, tool_timeout_s=self.tool_timeout_s)
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
                            "calls": calls, "lines": lines, "pending": None, "announced": []}
        except BaseException:
            if server is not None:
                server.close()
            temporary.cleanup()
            raise

    def chat(self, messages: list[dict], tools: list[dict] | None = None, reasoning_effort: str | None = None,
             on_text=None, on_thinking=None, cancel=None) -> ChatResult:
        if cancel is not None and cancel.is_set():
            self.close()
            if self.stop_raises:
                raise RuntimeError("Stopped before the model started.")
            return ChatResult(finish_reason="cancelled")
        state = self._active
        if state is not None:
            pending = state.get("pending")
            answer = answer_for(messages, pending[0].id) if pending is not None else None
            if answer is None:
                self.close()
                state = None
            else:
                state["pending"] = None
                pending[1].put(answer)
        if state is None:
            self._start(messages, tools, str(reasoning_effort or "").lower())
            state = self._active
        said: list[str] = []
        errors: list[str] = []
        usage: dict = {}
        refused = False
        stray = ""
        # Which of its messages came in pieces: kept with its process, since one reply's calls share it.
        pieces = state.setdefault("pieces", {})
        announced = state["announced"]       # its own lines about calls on DGC's tools, not yet made
        if self.engine == "claude":
            pieces["asked_model"] = self.selected_model   # its session start records what that name ran as

        def take(raw: bytes) -> None:
            nonlocal refused, stray
            if len(raw) > pip_brain.MAX_LINE:
                return
            line = raw.decode("utf-8", errors="replace")
            if not line.lstrip().startswith(("{", "[")) and pip_brain.refused_option(line):
                refused = True
            for event in parse_stream_events(pip_brain._engine(self.engine).stream, line, pieces):
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
                    usage.update(event["usage"])
                elif kind == "error" and value:
                    errors.append(str(value)[:300])
                elif kind == "tool_call":
                    bare = pip_brain._bare(str(event.get("name") or ""))
                    if bare:
                        announced.append(bare)
                    elif not stray:
                        # The flags leave it none of its own, so this never happens; if it does, it stops here.
                        stray = str(event.get("name") or "a tool")[:80]
                elif kind == "limits" and self.keep_limits:
                    from ..subscriptions import _keep_limits
                    _keep_limits(event)

        try:
            while True:
                if cancel is not None and cancel.is_set():
                    if not self.stop_raises:
                        self.close()
                        return ChatResult(content="".join(said), finish_reason="cancelled", usage=usage)
                    raise RuntimeError("Stopped while the model was responding.")
                if stray:
                    raise SubscriptionError(f"{pip_brain.name(self.engine)} tried to use its own {stray}, which it "
                                            "can't here. DGC stopped it.")
                try:
                    pending = state["calls"].get_nowait()
                except queue.Empty:
                    pending = None
                if pending is not None:
                    # Its own line about this call says what it wrote before it: read up to that line, so its words
                    # come before the call, as a model DGC calls itself gives them.
                    shown = next((key for key, value in self._names.items() if value == pending[0].name),
                                 pending[0].name)
                    until = time.monotonic() + pip_brain.ANNOUNCE_WAIT
                    while shown not in announced and time.monotonic() < until:
                        try:
                            raw = state["lines"].get(timeout=0.05)
                        except queue.Empty:
                            continue
                        if raw is None:
                            state["lines"].put(None)
                            break
                        take(raw)
                    if shown in announced:
                        announced.remove(shown)
                    if stray:
                        continue
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
                        if refused:
                            raise SubscriptionError(pip_brain.too_old(self.engine))
                        if errors:
                            if "usage limit" in errors[-1].lower():
                                raise SubscriptionError(errors[-1])       # the vendor's own words say when it's back
                            if "429" in errors[-1] or "rate limit" in errors[-1].lower():
                                reason = "The subscription is rate limited. Try again later."
                            elif "disabled" in errors[-1].lower() and "subscription" in errors[-1].lower():
                                reason = "This organization has disabled subscription access."
                        raise SubscriptionError(f"{pip_brain.name(self.engine)} stopped before completing this reply: {reason}")
                    if not said and self.empty_raises:
                        raise SubscriptionError(f"{pip_brain.name(self.engine)} returned no reply.")
                    return ChatResult(content="".join(said), usage=usage)
                take(raw)
        except BaseException:
            self.close()
            raise
