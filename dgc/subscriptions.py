"""Subscription engines — drive the user's own logged-in first-party coding CLI
(Claude Code, Codex, Qwen Code, Kimi for Coding) HEADLESS, from inside DGC.

Design contract — this is ORCHESTRATION, not a credential proxy:
  * DGC never reads, stores, refreshes, or replays the vendor's tokens, and never
    sends vendor-private fingerprint headers.
  * Each engine authenticates through the vendor's OWN login command (which opens
    the vendor's own browser / device flow) and keeps its token in its own store.
  * DGC only (a) checks whether that login already exists, and (b) when the user
    runs a turn, shells out to the official binary in the workspace and streams
    its output into DGC's UI.
The vendor's client owns auth, refresh, headers, rate limits, and ToS compliance.
Selecting one of these is equivalent to running that CLI directly — DGC just gives
it a shared interface (session, checkpoints, transcript).
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


MODES = ("default", "acceptEdits", "plan", "auto")
_MAX_STREAM_LINE_BYTES = 4 * 1024 * 1024
_MAX_DIAGNOSTIC_CHARS = 2_000


@dataclass(frozen=True)
class SubEngine:
    """One first-party subscription CLI DGC can delegate a turn to."""
    key: str
    label: str
    binary: str
    # Any one of these existing (under $HOME) marks an authenticated session.
    auth_markers: tuple[str, ...]
    # Command the user runs to authenticate — it opens the vendor's own flow.
    login_cmd: str
    # Docstring-style note shown in the picker so the ToS posture is never hidden.
    note: str
    # argv assembly (binary is prepended by build_argv):
    subcmd: tuple[str, ...]        # e.g. ("exec",) for codex; () otherwise
    resume: tuple[str, ...]        # tokens to continue the last session (replaces a fresh start)
    flags: tuple[str, ...]         # non-interactive + stream + auto-approve flags
    prompt_flag: str | None        # "-p" => prompt passed as [flag, prompt]; None => positional last
    stream: str                    # normalizer id: "claude" | "codex" | "qwen" | "kimi"
    # Optional pass-throughs — let DGC steer the vendor's own model + reasoning:
    model_flag: str = ""           # how to pass a model override: "--model" / "-m" ("" = unsupported)
    effort_style: str = ""         # "" none | "flag" (--effort LEVEL) | "codex" (-c model_reasoning_effort=)
    model_hints: tuple[str, ...] = ()   # quick-pick model aliases for the /model picker (else free-form)
    install_cmd: str = ""          # shell command to install the CLI (e.g. npm i -g …); "" = unknown
    login_run: str = ""            # runnable, non-interactive-safe login command; "" = must be done manually
    # Some CLIs keep OAuth in an OS keychain that DGC is deliberately forbidden to inspect.
    # For those engines, a missing plaintext marker means "verify on launch", not "signed out".
    auth_on_launch: bool = False

    @property
    def short_label(self) -> str:
        return self.label.split(" (")[0]

    def resolve(self) -> str | None:
        """Absolute path to the installed binary, or None."""
        return shutil.which(self.binary)

    def logged_in(self) -> bool:
        home = Path.home()
        # Existence is the full auth boundary: never open, parse, copy, or follow content from
        # these vendor-owned credential files. Directories do not count as credentials.
        return any((home / m).expanduser().is_file() for m in self.auth_markers)

    def supports_effort(self) -> bool:
        return bool(self.effort_style)

    def build_argv(self, binary: str, prompt: str, *, cont: bool,
                   session_id: str = "", mode: str = "default",
                   model: str = "", effort: str = "") -> list[str]:
        """Build an argv-only invocation of the vendor CLI.

        Permission modes are mapped explicitly instead of silently turning every delegated turn
        into full-auto. ``session_id`` is preferred over each CLI's ambient "last session" switch
        so one DGC conversation cannot attach to an unrelated terminal conversation.
        """
        validate_engine_mode(self.key, mode)
        for label, value in (("prompt", prompt), ("session id", session_id),
                             ("model", model), ("effort", effort)):
            if "\x00" in str(value):
                raise EngineError(f"{label} contains an invalid NUL character")
        argv = [binary, *self.subcmd]
        if cont:
            if self.key == "codex":
                argv += ["resume"]
                if not session_id:
                    argv += ["--last"]
            elif session_id:
                session_switch = {
                    "claude": ["--resume", session_id],
                    "qwen": ["--resume", session_id],
                    "kimi": ["--session", session_id],
                    "copilot": [f"--resume={session_id}"],
                }.get(self.key, list(self.resume))
                argv += session_switch
            else:
                argv += list(self.resume)
        argv += list(self.flags)
        if self.key == "claude":
            if mode == "auto":
                argv += ["--dangerously-skip-permissions"]
            elif mode == "plan":
                argv += ["--permission-mode", "plan"]
            elif mode == "acceptEdits":
                argv += ["--permission-mode", "acceptEdits"]
        elif self.key == "codex" and not cont:
            # ``codex exec resume`` retains the sandbox selected when its thread was created and
            # does not expose --sandbox. A mode mismatch therefore starts a new vendor thread.
            argv += (["--dangerously-bypass-approvals-and-sandbox"] if mode == "auto" else
                     ["--sandbox", "workspace-write"] if mode == "acceptEdits" else
                     ["--sandbox", "read-only"])
        elif self.key == "qwen":
            qwen_mode = {"default": "default", "acceptEdits": "auto-edit",
                         "plan": "plan", "auto": "yolo"}[mode]
            argv += ["--approval-mode", qwen_mode]
        elif self.key == "copilot":
            if mode == "auto":
                argv += ["--allow-all"]
            elif mode == "acceptEdits":
                # Copilot permissions are categories, not concrete editor tool names.  Prompt
                # mode cannot surface an interactive approval, so grant exactly DGC's read/edit
                # boundary and leave shell, URLs, MCP, and memory denied.
                argv += ["--allow-tool=read,write"]
            else:
                # Both default and plan remain useful for repository inspection while all
                # mutations fail closed. ``--plan`` also activates Copilot's plan workflow.
                argv += ["--allow-tool=read"]
                if mode == "plan":
                    argv += ["--plan"]
        if model and self.model_flag:                 # steer the vendor's own model
            argv += [self.model_flag, model]
        if effort and self.effort_style == "flag":    # claude: --effort LEVEL
            argv += ["--effort", effort]
        elif effort and self.effort_style == "codex":  # codex: -c model_reasoning_effort="LEVEL"
            argv += ["-c", f'model_reasoning_effort="{effort}"']
        if self.prompt_flag:
            argv += [self.prompt_flag, prompt]
        else:
            # Stop a prompt beginning with '-' from being interpreted as another CLI option.
            argv += ["--"]
            if self.key == "codex" and cont and session_id:
                argv += [session_id]
            argv += [prompt]        # positional, must be last
        return argv


# --- the registry -----------------------------------------------------------
# Every invocation is the vendor's own documented headless mode; DGC adds no auth.
ENGINES: dict[str, SubEngine] = {
    "claude": SubEngine(
        key="claude", label="Claude Code (Pro / Max subscription)", binary="claude",
        auth_markers=(".claude/.credentials.json",), login_cmd="claude  (then authenticate in the browser)",
        note="Runs your Anthropic subscription through the official Claude Code CLI.",
        subcmd=(), resume=("--continue",),
        flags=("-p", "--output-format", "stream-json", "--verbose"),
        prompt_flag=None, stream="claude", model_flag="--model", effort_style="flag",
        model_hints=("opus", "sonnet", "haiku"),
        install_cmd="npm install -g @anthropic-ai/claude-code", login_run="claude auth login"),
    "codex": SubEngine(
        key="codex", label="Codex (ChatGPT Plus / Pro subscription)", binary="codex",
        auth_markers=(".codex/auth.json",), login_cmd="codex login",
        note="Runs your ChatGPT subscription through the official Codex CLI.",
        subcmd=("exec",), resume=("resume", "--last"),
        flags=("--json", "--skip-git-repo-check"),
        prompt_flag=None, stream="codex", model_flag="-m", effort_style="codex",
        install_cmd="npm install -g @openai/codex", login_run="codex login"),
    "qwen": SubEngine(
        key="qwen", label="Qwen Code (Qwen OAuth)", binary="qwen",
        auth_markers=(".qwen/oauth_creds.json",), login_cmd="qwen  (then approve the device code)",
        note="Runs your Qwen OAuth plan through the official Qwen Code CLI.",
        subcmd=(), resume=("-c",),
        flags=("--output-format", "stream-json"),
        prompt_flag="-p", stream="qwen", model_flag="-m",
        install_cmd="npm install -g @qwen-code/qwen-code", login_run="qwen"),
    "kimi": SubEngine(
        key="kimi", label="Kimi for Coding (Moonshot subscription)", binary="kimi",
        auth_markers=(".kimi/credentials", ".kimi/kimi.json"), login_cmd="kimi login",
        note="Runs your Kimi for Coding subscription through the official Kimi CLI.",
        subcmd=(), resume=("--continue",),
        flags=("--output-format", "stream-json"),
        prompt_flag="-p", stream="kimi", model_flag="-m",
        install_cmd="npm install -g @moonshot-ai/kimi-code", login_run="kimi login"),
    "copilot": SubEngine(
        key="copilot", label="GitHub Copilot CLI (Copilot subscription)", binary="copilot",
        auth_markers=(".config/github-copilot/apps.json", ".config/github-copilot/hosts.json",
                      ".copilot/config.json"),
        login_cmd="copilot login  (or set GH_TOKEN)",
        note="Runs your GitHub Copilot subscription through the official Copilot CLI.",
        subcmd=(), resume=("--continue",),
        flags=("--output-format", "json"),
        prompt_flag="--prompt", stream="copilot", model_flag="--model", effort_style="flag",
        install_cmd="npm install -g @github/copilot", login_run="copilot login",
        auth_on_launch=True),
}

ENGINE_KEYS = tuple(ENGINES)


def get_engine(key: str) -> SubEngine | None:
    return ENGINES.get((key or "").strip().lower())


def status() -> list[dict]:
    """Installed / logged-in state for every engine — for the picker and `dgc doctor`."""
    out = []
    for e in ENGINES.values():
        installed = e.resolve() is not None
        marked = installed and e.logged_in()
        auth_state = ("not_installed" if not installed else "signed_in" if marked else
                      "check_on_launch" if e.auth_on_launch else "signed_out")
        out.append({"key": e.key, "label": e.label, "installed": installed,
                    "logged_in": marked, "auth_state": auth_state,
                    "login_cmd": e.login_cmd, "note": e.note,
                    "model_hints": list(e.model_hints),
                    "supports_effort": e.supports_effort()})
    return out


class EngineError(RuntimeError):
    """Base for delegation problems the caller should surface, not crash on."""


class EngineNotInstalled(EngineError):
    pass


class EngineNotAuthenticated(EngineError):
    pass


class EngineModeUnsupported(EngineError):
    pass


class EngineLaunchError(EngineError):
    pass


def validate_engine_mode(engine_key: str, mode: str) -> SubEngine | None:
    """Validate the one permission invariant shared by every subscription surface.

    Returning the resolved engine keeps callers from independently re-looking it up.  An empty
    or unknown engine has no subscription-specific restriction; command/schema validation owns
    whether that engine name is otherwise admissible.
    """
    if mode not in MODES:
        raise EngineModeUnsupported(f"unknown DGC permission mode: {mode}")
    engine = get_engine(engine_key)
    if engine is not None and engine.key == "kimi" and mode != "auto":
        raise EngineModeUnsupported(
            "Kimi prompt mode always grants automatic tool approval; select DGC auto mode "
            "to use Kimi, or choose another engine for plan/default/accept-edits mode.")
    return engine


# --- streaming normalizers --------------------------------------------------
# Each vendor emits its own JSONL schema. We normalize to a common, RICH set of
# DGC-neutral events so a delegated turn can render exactly like a native one:
#   {"kind":"text","text":..}  {"kind":"thinking","text":..}
#   {"kind":"tool_call","name":..,"args":dict,"id":..}
#   {"kind":"tool_result","output":..,"id":..}  {"kind":"result","text":..}
# One raw line may carry several events (a Claude assistant message = text +
# tool_use). Unrecognized lines yield [] — never a raw JSON dump on screen.
def _flatten(content) -> str:
    """A tool_result's content may be a string or a list of {type:text,text}."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content
                       if isinstance(p, dict) and p.get("type") == "text")
    return "" if content is None else str(content)


def _text_event(kind: str, value, **fields) -> list[dict]:
    text = value if isinstance(value, str) else "" if value is None else str(value)
    return [{"kind": kind, "text": text, **fields}] if text else []


def _session_event(value) -> list[dict]:
    value = str(value or "").strip()
    if not value or len(value) > 512 or any(ord(ch) < 32 for ch in value):
        return []
    return [{"kind": "session", "id": value}]


def _error_text(obj: dict) -> str:
    error = obj.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("error") or "")
    return str(error or obj.get("message") or "")


def _events_claude(obj: dict) -> list[dict]:
    t = obj.get("type")
    if t == "system":
        return _session_event(obj.get("session_id"))
    if t == "assistant":
        out = []
        message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
        content = message.get("content", [])
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and b.get("text"):
                out.append({"kind": "text", "text": b["text"]})
            elif bt == "thinking" and b.get("thinking"):
                out.append({"kind": "thinking", "text": b["thinking"]})
            elif bt == "tool_use":
                out.append({"kind": "tool_call", "name": str(b.get("name") or "tool"),
                            "args": b.get("input") if isinstance(b.get("input"), dict) else {},
                            "id": str(b.get("id") or "")})
        return out
    if t == "user":
        message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
        content = message.get("content", [])
        return [{"kind": "tool_result", "output": _flatten(b.get("content")),
                 "id": str(b.get("tool_use_id") or "")}
                for b in content if isinstance(content, list)
                if isinstance(b, dict) and b.get("type") == "tool_result"]
    if t == "result":
        out = _session_event(obj.get("session_id"))
        if obj.get("is_error") or str(obj.get("subtype") or "").startswith("error"):
            message = _error_text(obj) or str(obj.get("result") or "delegated turn failed")
            out += _text_event("error", message)
        else:
            out += _text_event("result", obj.get("result"))
        return out
    if t in ("error", "fatal"):
        return _text_event("error", _error_text(obj) or "delegated turn failed")
    return []


def _codex_tool_name(item: dict) -> str:
    kind = str(item.get("type") or "")
    if kind == "command_execution":
        return "shell"
    if kind == "file_change":
        return "edit"
    if kind == "mcp_tool_call":
        server, tool = str(item.get("server") or ""), str(item.get("tool") or "")
        return f"{server}.{tool}".strip(".") or "mcp"
    return kind or "tool"


def _events_codex(obj: dict) -> list[dict]:
    """Current ``codex exec --json`` schema plus a small legacy compatibility tail."""
    top_type = str(obj.get("type") or "")
    if top_type == "thread.started":
        return _session_event(obj.get("thread_id"))
    if top_type in ("turn.failed", "error"):
        return _text_event("error", _error_text(obj) or "Codex turn failed")
    if top_type in ("item.started", "item.completed", "item.updated"):
        item = obj.get("item") if isinstance(obj.get("item"), dict) else {}
        item_type = str(item.get("type") or "")
        item_id = str(item.get("id") or "")
        completed = top_type == "item.completed"
        if item_type == "agent_message" and completed:
            return _text_event("text", item.get("text"))
        if item_type == "reasoning" and completed:
            return _text_event("thinking", item.get("text"))
        if item_type == "command_execution":
            if top_type == "item.started":
                return [{"kind": "tool_call", "name": "shell",
                         "args": {"command": str(item.get("command") or "")}, "id": item_id}]
            if completed:
                return [{"kind": "tool_result",
                         "output": str(item.get("aggregated_output") or ""), "id": item_id,
                         "error": item.get("exit_code") not in (None, 0)}]
        if item_type == "file_change" and completed:
            changes = item.get("changes") if isinstance(item.get("changes"), list) else []
            paths = [str(change.get("path") or "") for change in changes
                     if isinstance(change, dict) and change.get("path")]
            summary = "changed " + ", ".join(paths) if paths else "file changes applied"
            return [{"kind": "tool_call", "name": "edit",
                     "args": {"path": paths[0]} if len(paths) == 1 else {"paths": paths},
                     "id": item_id},
                    {"kind": "tool_result", "output": summary, "id": item_id}]
        if item_type == "mcp_tool_call":
            if top_type == "item.started":
                arguments = item.get("arguments")
                return [{"kind": "tool_call", "name": _codex_tool_name(item),
                         "args": arguments if isinstance(arguments, dict) else {}, "id": item_id}]
            if completed:
                output = item.get("result") or item.get("error") or ""
                return [{"kind": "tool_result", "output": _flatten(output), "id": item_id,
                         "error": bool(item.get("error"))}]
        if item_type == "web_search" and top_type == "item.started":
            return [{"kind": "tool_call", "name": "web_search",
                     "args": {"query": str(item.get("query") or "")}, "id": item_id}]

    # Legacy Codex event compatibility (pre item.* JSONL).
    m = obj.get("msg", obj)
    if not isinstance(m, dict):
        return []
    mt = str(m.get("type") or top_type)
    if mt in ("agent_message", "assistant_message"):
        return _text_event("text", m.get("message") or m.get("text"))
    if mt.startswith("agent_reasoning") or mt in ("reasoning",):
        return _text_event("thinking", m.get("text") or m.get("reasoning"))
    if mt in ("exec_command_begin", "command_started") or mt.endswith("_call"):
        cmd = m.get("command")
        cmd = " ".join(cmd) if isinstance(cmd, list) else (cmd or m.get("name") or mt)
        return [{"kind": "tool_call", "name": "shell", "args": {"command": str(cmd)},
                 "id": str(m.get("call_id") or m.get("id") or "")}]
    if mt in ("exec_command_end", "command_output", "tool_result"):
        return [{"kind": "tool_result",
                 "output": str(m.get("stdout") or m.get("aggregated_output") or m.get("output") or ""),
                 "id": str(m.get("call_id") or m.get("id") or "")}]
    if mt in ("task_complete", "turn_complete"):
        return [{"kind": "result", "text": str(m.get("last_agent_message") or "")}]
    return []


def _events_qwen(obj: dict) -> list[dict]:
    # Qwen's current stream-json contract deliberately mirrors Claude's assistant/user/result
    # envelopes. Keep a generic tail for older versions that emitted flat events.
    rich = _events_claude(obj)
    return rich if rich else _events_generic(obj)


def _events_kimi(obj: dict) -> list[dict]:
    role = str(obj.get("role") or "")
    if role == "assistant":
        out: list[dict] = []
        content = obj.get("content")
        if isinstance(content, str) and content:
            out.append({"kind": "text", "text": content})
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                    out.append({"kind": "text", "text": str(block["text"])})
        calls = obj.get("tool_calls") if isinstance(obj.get("tool_calls"), list) else []
        for call in calls:
            if not isinstance(call, dict):
                continue
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            raw_args = fn.get("arguments", {})
            if isinstance(raw_args, str):
                try:
                    parsed = json.loads(raw_args)
                    args = parsed if isinstance(parsed, dict) else {"args": raw_args}
                except (json.JSONDecodeError, ValueError):
                    args = {"args": raw_args}
            else:
                args = raw_args if isinstance(raw_args, dict) else {}
            out.append({"kind": "tool_call", "name": str(fn.get("name") or "tool"),
                        "args": args, "id": str(call.get("id") or "")})
        return out
    if role == "tool":
        return [{"kind": "tool_result", "output": _flatten(obj.get("content")),
                 "id": str(obj.get("tool_call_id") or "")}]
    if role == "meta":
        meta_type = str(obj.get("type") or "")
        if meta_type == "session.resume_hint":
            return _session_event(obj.get("session_id"))
        if meta_type == "turn.step.retrying":
            # Surface WHY it is retrying — the provider error and attempt count — instead of an
            # opaque ping, so a failing delegation says what is wrong while it is happening.
            nxt = obj.get("next_attempt") or obj.get("attempt")
            mx = obj.get("max_attempts")
            where = (f" (attempt {nxt}/{mx})" if nxt and mx
                     else f" (attempt {nxt})" if nxt else "")
            reason = str(obj.get("error_message") or obj.get("error_name") or "").strip()
            code = obj.get("status_code")
            detail = ""
            if code and str(code) not in reason:
                detail += f" [{code}]"
            if reason:
                detail += f": {reason}"
            return [{"kind": "status",
                     "text": f"Kimi is retrying the model request{where}{detail}"}]
        if "error" in meta_type:
            return _text_event("error", _error_text(obj) or meta_type)
    return _events_generic(obj)


def _events_copilot(obj: dict) -> list[dict]:
    t = str(obj.get("type") or obj.get("event") or "")
    data = obj.get("data") if isinstance(obj.get("data"), dict) else obj
    if t in ("assistant.message", "assistant_message", "message"):
        return _text_event("text", data.get("content") or data.get("text"))
    if t in ("assistant.reasoning", "reasoning", "thinking"):
        return _text_event("thinking", data.get("content") or data.get("text"))
    if t in ("tool.execution_start", "tool.started", "tool_call"):
        raw_args = data.get("arguments") or data.get("args") or {}
        return [{"kind": "tool_call", "name": str(data.get("tool") or data.get("name") or "tool"),
                 "args": raw_args if isinstance(raw_args, dict) else {"args": str(raw_args)},
                 "id": str(data.get("tool_call_id") or data.get("id") or "")}]
    if t in ("tool.execution_complete", "tool.completed", "tool_result"):
        return [{"kind": "tool_result",
                 "output": _flatten(data.get("result") or data.get("output") or data.get("content")),
                 "id": str(data.get("tool_call_id") or data.get("id") or ""),
                 "error": bool(data.get("error"))}]
    if t in ("session.started", "session.created"):
        return _session_event(data.get("session_id") or data.get("id"))
    if t in ("error", "turn.failed"):
        return _text_event("error", _error_text(data) or "Copilot turn failed")
    return _events_generic(obj)


def _events_generic(obj: dict) -> list[dict]:
    t = str(obj.get("type") or obj.get("event") or "")
    if t in ("thinking", "reasoning", "thought"):
        return [{"kind": "thinking", "text": str(obj.get("content") or obj.get("text") or "")}]
    if t in ("content", "assistant", "message", "text", "assistant_message"):
        return [{"kind": "text", "text": str(obj.get("content") or obj.get("text") or obj.get("delta") or "")}]
    if t in ("tool_call", "tool", "tool_use", "function_call"):
        args = obj.get("input") or obj.get("arguments") or {}
        return [{"kind": "tool_call", "name": str(obj.get("name") or obj.get("tool") or "tool"),
                 "args": args if isinstance(args, dict) else {"args": str(args)},
                 "id": str(obj.get("id") or "")}]
    if t in ("tool_result", "tool_output", "function_result"):
        return [{"kind": "tool_result", "output": str(obj.get("output") or obj.get("content") or obj.get("result") or ""),
                 "id": str(obj.get("id") or "")}]
    if t in ("result", "final", "done", "completed"):
        if obj.get("is_error") or str(obj.get("subtype") or "").startswith("error"):
            return _text_event("error", _error_text(obj) or obj.get("result") or "delegated turn failed")
        return _text_event("result", obj.get("content") or obj.get("result"))
    if t in ("error", "fatal"):
        return _text_event("error", _error_text(obj) or "delegated turn failed")
    return []


def parse_stream_events(stream: str, line: str) -> list[dict]:
    """Normalize one raw JSONL line into a list of rich DGC-neutral events."""
    line = line.strip()
    if not line:
        return []
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(obj, dict):
        return []
    if stream == "claude":
        return _events_claude(obj)
    if stream == "codex":
        return _events_codex(obj)
    if stream == "qwen":
        return _events_qwen(obj)
    if stream == "kimi":
        return _events_kimi(obj)
    if stream == "copilot":
        return _events_copilot(obj)
    return []


def edit_diff(name: str, args: dict) -> str | None:
    """Build a unified diff for an edit-shaped tool call so a delegated edit renders
    as a real diff (DGC's tool_result renders any `--- `/`+++ ` output as one)."""
    import difflib

    def diff_lines(value: object) -> list[str]:
        # ``difflib.unified_diff`` does not add a terminator to content lines.
        # Vendor Edit calls commonly send fragments without a trailing newline;
        # passing those through verbatim glues ``-old`` and ``+new`` together and
        # makes the TUI render one struck-through line.  Normalize only the
        # synthetic comparison input (never the actual vendor payload).
        return [line + "\n" for line in str(value).splitlines()]

    path = str(args.get("file_path") or args.get("path") or "file")
    if "old_string" in args and "new_string" in args:
        old = diff_lines(args["old_string"])
        new = diff_lines(args["new_string"])
    elif "content" in args and name.lower() in ("write", "writefile", "create_file", "create"):
        old, new = [], diff_lines(args["content"])
    else:
        return None
    text = "".join(difflib.unified_diff(old, new, fromfile=f"a/{path}", tofile=f"b/{path}"))
    return text or None


def preflight(engine: SubEngine) -> str:
    """Resolve the binary or raise a caller-friendly error. Returns the abs path."""
    binary = engine.resolve()
    if not binary:
        raise EngineNotInstalled(
            f"{engine.label} is not installed — install its CLI (`{engine.binary}`) first.")
    if not engine.logged_in() and not engine.auth_on_launch:
        raise EngineNotAuthenticated(
            f"{engine.label} is not signed in — run `{engine.login_cmd}` once, then retry.")
    return binary


def run_turn(engine: SubEngine, prompt: str, workdir, *, cont: bool = False,
             timeout: int = 1800, on_event: Callable[[dict], None] | None = None,
             env: dict | None = None, cancel: Callable[[], bool] | None = None,
             session_id: str = "", mode: str = "default",
             model: str = "", effort: str = "") -> dict:
    """Delegate one turn to the engine's official CLI in ``workdir``, streaming
    normalized events to ``on_event``. Returns {rc, text, timeout, cancelled, events}.
    Raises only for a missing binary / not-authenticated engine (via preflight); a
    nonzero exit is reported in ``rc``, never raised. A poller kills the whole process
    group on timeout OR when ``cancel()`` becomes true (Esc/Ctrl-C), so no orphan
    survives a hung or interrupted CLI."""
    import os
    import signal
    import subprocess
    import threading
    import time

    binary = preflight(engine)
    argv = engine.build_argv(binary, prompt, cont=cont, session_id=session_id,
                             mode=mode, model=model, effort=effort)
    started = time.monotonic()
    if cancel is not None and cancel():
        return {"rc": None, "text": "", "timeout": False, "cancelled": True,
                "events": 0, "seconds": 0.0, "session_id": "", "error": "", "ok": False}
    try:
        proc = subprocess.Popen(
            argv, cwd=str(workdir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=False, bufsize=0, env={**os.environ, **(env or {})}, start_new_session=True)
    except (OSError, ValueError) as exc:
        raise EngineLaunchError(
            f"could not start {engine.short_label}: {type(exc).__name__}: {exc}") from exc

    state = {"stopped": None}  # None | timeout | cancelled | callback
    stop = threading.Event()
    kill_lock = threading.Lock()
    process_group = proc.pid

    def _group_alive() -> bool:
        try:
            os.killpg(process_group, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def _kill() -> None:
        """Terminate the complete vendor process tree, then escalate after a short grace."""
        if not kill_lock.acquire(blocking=False):
            return
        try:
            try:
                os.killpg(process_group, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                return
            grace = time.monotonic() + 0.75
            while time.monotonic() < grace and _group_alive():
                time.sleep(0.05)
            if _group_alive():
                try:
                    os.killpg(process_group, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        finally:
            kill_lock.release()

    def _poll() -> None:
        while not stop.wait(0.1):
            # A descendant can retain stdout after the group leader exits. Keep polling until the
            # reader closes so timeout/cancel can still reap the complete process group.
            if timeout and time.monotonic() - started > timeout:
                state["stopped"] = "timeout"
                _kill()
                return
            if cancel is not None and cancel():
                state["stopped"] = "cancelled"
                _kill()
                return

    poller = threading.Thread(target=_poll, daemon=True)
    poller.start()

    final, text_parts, n, vendor_session = "", [], 0, ""
    errors: list[str] = []
    diagnostics: list[str] = []
    callback_error: Exception | None = None

    def _diagnostic(line: str) -> None:
        clean = "".join(ch for ch in line.strip() if ch == "\t" or ord(ch) >= 32)
        if clean and len(diagnostics) < 4:
            diagnostics.append(clean[:500])

    try:
        assert proc.stdout is not None
        while True:
            raw = proc.stdout.readline(_MAX_STREAM_LINE_BYTES + 1)
            if not raw:
                break
            if len(raw) > _MAX_STREAM_LINE_BYTES:
                while raw and not raw.endswith(b"\n"):
                    raw = proc.stdout.readline(_MAX_STREAM_LINE_BYTES + 1)
                _diagnostic("vendor emitted an oversized output line; it was discarded")
                continue
            line = raw.decode("utf-8", errors="replace")
            events = parse_stream_events(engine.stream, line)
            if not events:
                try:
                    is_json = isinstance(json.loads(line), (dict, list))
                except (json.JSONDecodeError, ValueError):
                    is_json = False
                if not is_json:
                    _diagnostic(line)
            for ev in events:
                n += 1
                if ev["kind"] == "result" and ev.get("text"):
                    final = ev["text"]
                elif ev["kind"] == "text" and ev.get("text"):
                    if (text_parts and not str(text_parts[-1]).endswith(("\n", " "))
                            and not str(ev["text"]).startswith(("\n", " "))):
                        text_parts.append("\n\n")
                    text_parts.append(ev["text"])
                elif ev["kind"] == "session" and ev.get("id"):
                    vendor_session = ev["id"]
                elif ev["kind"] == "error" and ev.get("text"):
                    errors.append(str(ev["text"])[:_MAX_DIAGNOSTIC_CHARS])
                if on_event:
                    try:
                        on_event(ev)
                    except Exception as exc:  # UI failure must not orphan the vendor process
                        callback_error = exc
                        state["stopped"] = "callback"
                        _kill()
                        break
            if callback_error is not None:
                break
    finally:
        stop.set()
        if callback_error is not None:
            try:
                proc.stdout.close()
            except OSError:
                pass
        try:
            rc = proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _kill()
            try:
                rc = proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                rc = -signal.SIGKILL
        poller.join(timeout=2)
    if callback_error is not None:
        raise EngineError(
            f"delegated output renderer failed: {type(callback_error).__name__}: {callback_error}")

    answer = "".join(str(part) for part in text_parts) or final
    error = errors[-1] if errors else ""
    if not error and rc != 0 and diagnostics:
        error = "\n".join(diagnostics)[:_MAX_DIAGNOSTIC_CHARS]
    if not error and not state["stopped"] and rc == 0 and not answer.strip():
        error = (f"{engine.short_label} exited successfully but produced no recognized assistant "
                 "message; its output schema may have changed")
    stopped = state["stopped"]
    ok = stopped is None and rc == 0 and not error and bool(answer.strip())
    return {"rc": None if stopped in ("timeout", "cancelled") else rc, "text": answer,
            "timeout": stopped == "timeout", "cancelled": stopped == "cancelled",
            "events": n, "seconds": round(time.monotonic() - started, 1),
            "session_id": vendor_session, "error": error, "ok": ok}
