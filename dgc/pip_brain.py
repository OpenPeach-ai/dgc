"""A Personal Pip's turns on the user's own Claude Code or Codex: their subscription, DGC's tools only.

The maintainers' ask (2026-10-20): a Pip that follows DGC's subscription default, or is given one, runs. The CLI is
the Pip's model and nothing more:

* Its own tools are off. Claude Code gets no built-in tool (``--tools ""``), restricted mode, no settings files,
  no skills, no CLAUDE.md, only DGC's MCP server (``--strict-mcp-config``), and ``dontAsk`` so anything else is
  refused, never asked. Codex runs ``exec`` without the user's config.toml, rules or AGENTS.md, with its shell,
  unified exec, view_image, web search, apps, plugins, sub-agents, image generation, browser and computer use
  switched off, a read-only sandbox and no approvals. Each flag was checked by trying (docs/PIPS.md).
* Its tools are the Pip's, served by DGC over MCP for this run alone: a socket in a private folder, opened only by
  a token minted for the run (``ToolServer``; the CLI's MCP server is ``pip_brain_relay.py``). A call is handled
  by the Pip's own handlers, so holds, payment asks, careful mode, the card rule, masking, Allow cards and
  routines are exactly as in a native run. Screenshots come back as MCP image content, so the CLI sees them.
* It runs in the run's own folder, never a project, with an environment that carries no DGC secrets, and as
  part of the worker's process group, so stopping the run stops it.
* DGC never reads, copies or refreshes the CLI's login; the CLI uses its own (the main chat's contract,
  subscriptions.py).

Kimi Code isn't offered (it always starts the user's own MCP servers); Qwen Code and Copilot CLI aren't either, as
neither could be checked by trying here.
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from .workspace_registry import RegistryError

SERVER = "dgc"                       # the tools reach the CLI as mcp__dgc__<name> (Claude Code) or dgc.<name> (Codex)
ENGINES = ("claude", "codex")
EFFORTS = {"claude": ("low", "medium", "high", "xhigh", "max"),
           "codex": ("minimal", "low", "medium", "high", "xhigh")}
NOT_FOR_PIPS = {
    # Kimi Code 0.29.1 always loads ~/.kimi-code/mcp.json and approves every tool in prompt mode; Qwen Code 0.22.3
    # (its sign-in removed) and Copilot CLI (not installed) couldn't be tried here, so neither is verified.
    "kimi": "Kimi Code always starts your own MCP servers, so it can't be held to DGC's tools alone. Pips don't use it.",
    "qwen": "Qwen Code isn't offered for Pips: DGC hasn't checked that it runs with only DGC's tools.",
    "copilot": "Copilot CLI isn't offered for Pips: DGC hasn't checked that it runs with only DGC's tools.",
}
PROJECT_PIPS = ("Project Pips need a local or API model: their source checks run only in DGC's own loop. "
                "Personal Pips can use your subscription.")
MAX_REQUEST = 4 * 1024 * 1024        # one MCP request line from the CLI
MAX_LINE = 4 * 1024 * 1024           # one line of the CLI's own output
MAX_TEXT = 4 * 1024 * 1024           # what one turn may say
TOOL_RESULT_IN_TRANSCRIPT = 2000     # a tool's answer, as an earlier turn's transcript shows it
ANNOUNCE_WAIT = 3.0                  # how long a tool call waits for the CLI's own line about it


def _engine(key):
    from .subscriptions import get_engine
    return get_engine(key)


def name(key: str) -> str:
    engine = _engine(key)
    return engine.short_label if engine is not None else str(key)


# Where each CLI keeps its login when the user moved it (the CLI's own variable). Existence only, as the main chat's
# check: DGC never opens these files.
_LOGIN_HOME = {"claude": ("CLAUDE_CONFIG_DIR", ".credentials.json"), "codex": ("CODEX_HOME", "auth.json")}


def _signed_in(engine) -> bool:
    variable, marker = _LOGIN_HOME.get(engine.key, ("", ""))
    moved = os.environ.get(variable, "") if variable else ""
    if moved:
        return (Path(moved).expanduser() / marker).is_file()
    return engine.logged_in()


def available(key: str) -> str:
    """Why this engine can't run a Pip here ('' when it can): installed, signed in, and one DGC locks down."""
    engine = _engine(key)
    if engine is None:
        return "Choose Claude Code or Codex."
    if key not in ENGINES:
        return NOT_FOR_PIPS.get(key, "Pips can use only Claude Code or Codex.")
    if engine.resolve() is None:
        return f"{engine.short_label} isn't installed on this computer."
    if not _signed_in(engine):
        return f"{engine.short_label} isn't signed in on this computer. Run `{engine.login_cmd}` once."
    return ""


def offered() -> list[dict]:
    """The subscriptions a Pip can use here, for its model picker: installed, signed in, locked down."""
    return [{"engine": key, "name": name(key)} for key in ENGINES if not available(key)]


def route(config, choice) -> dict | None:
    """The CLI a Pip's run uses, or None for a native model. ``choice`` is a validated model choice.

    "Same as DGC" follows DGC's own subscription default, with its model and effort; a subscription chosen for the
    Pip uses that CLI's own default model."""
    if choice.get("mode") == "subscription":
        key, model, effort = choice["engine"], "", ""
    elif choice.get("mode") == "default" and str(config.get("subscription_engine", "") or "").strip():
        key = str(config.get("subscription_engine", "")).strip().lower()
        model = str(config.get("subscription_model", "") or "").strip()
        effort = str(config.get("subscription_effort", "") or "").strip().lower()
    else:
        return None
    reason = available(key)
    if reason:
        raise RegistryError("unsupported_model", reason)
    from .pip_models import _model_id
    if model:
        _model_id(model)
    if key == "codex" and effort == "max":
        effort = "xhigh"
    if effort not in EFFORTS[key]:
        effort = ""
    return {"engine": key, "model": model, "effort": effort}


def validate_route(value) -> dict:
    """A run's pinned ``brain`` as the worker and controller read it."""
    if (not isinstance(value, dict) or set(value) != {"engine", "model", "effort"} or value["engine"] not in ENGINES
            or not isinstance(value["model"], str) or value["effort"] not in ("",) + EFFORTS[value["engine"]]):
        raise RegistryError("invalid_manifest", "The run's subscription is malformed.")
    if value["model"]:
        from .pip_models import _model_id
        _model_id(value["model"])
    return value


def label(brain: dict) -> str:
    """The run's ``model``, as its records show it: the engine, and its model when DGC chose one."""
    return brain["engine"] + (":" + brain["model"] if brain["model"] else "")


# --------------------------------------------------------------------------- launching

# What the CLI's environment may carry from the runner's: where things are, never a key or a token.
_ENV_KEEP = ("PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "USER", "LOGNAME", "SHELL", "TMPDIR",
             "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
             "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy",
             "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA",
             "USERPROFILE", "NVM_DIR", "NVM_BIN")
_ENGINE_ENV = {"claude": ("CLAUDE_CONFIG_DIR",), "codex": ("CODEX_HOME",)}


def launch_pin(brain: dict, folder: Path, environ=None) -> dict:
    """At a run's start, in the controller: the CLI's absolute path, the user's home (where its login lives), a
    secret-free environment and the run's own folder, for the worker (as ``DGC_PIP_BRAIN``)."""
    brain = validate_route(brain)
    reason = available(brain["engine"])
    if reason:
        raise RegistryError("unsupported_model", reason)
    environ = os.environ if environ is None else environ
    env = {key: environ[key] for key in _ENV_KEEP + _ENGINE_ENV[brain["engine"]] if environ.get(key)}
    folder.mkdir(mode=0o700, exist_ok=False)
    return {"engine": brain["engine"], "binary": _engine(brain["engine"]).resolve(), "home": str(Path.home()),
            "env": env, "folder": str(folder)}


def validate_launch(value, brain: dict) -> dict:
    if (not isinstance(value, dict) or set(value) != {"engine", "binary", "home", "env", "folder"}
            or value["engine"] != brain["engine"] or not all(isinstance(value[k], str) and value[k] for k in ("binary", "home", "folder"))
            or not isinstance(value["env"], dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value["env"].items())
            or set(value["env"]) - set(_ENV_KEEP + _ENGINE_ENV[brain["engine"]])):
        raise RegistryError("invalid_manifest", "The run's subscription launch is malformed.")
    folder = Path(value["folder"])
    info = os.lstat(folder)
    if folder.is_symlink() or not folder.is_dir() or info.st_mode & 0o077 or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise RegistryError("unsafe_state", "The run's own folder is not private.")
    return value


def child_env(launch: dict, extra: dict | None = None) -> dict:
    env = dict(launch["env"])
    env["HOME"] = launch["home"]
    if launch["engine"] == "claude":
        env.update({
            # Nothing the user set up for their own Claude Code reaches a Pip: no CLAUDE.md, memory, skills,
            # background work, cron, update checks or attachments (an @path in the user's words is text).
            "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
            "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS": "1", "CLAUDE_CODE_DISABLE_POLICY_SKILLS": "1",
            "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1", "CLAUDE_CODE_DISABLE_CRON": "1",
            "CLAUDE_CODE_DISABLE_ATTACHMENTS": "1", "CLAUDE_CODE_DISABLE_WORKFLOWS": "1",
            "DISABLE_AUTOUPDATER": "1", "ENABLE_TOOL_SEARCH": "false",
            # A step on its computer can take a while (a page loading, an app starting).
            "MCP_TIMEOUT": "60000", "MCP_TOOL_TIMEOUT": "900000"})
    env.update(extra or {})
    return env


def claude_argv(binary: str, *, mcp_config: Path, system_file: Path, model: str = "", effort: str = "") -> list[str]:
    argv = [binary, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--tools", "",                              # none of Claude Code's own tools: no shell, files or web
            "--restricted",                              # and no user, project or local settings (their hooks)
            "--setting-sources", "project",              # (its folder has none)
            "--strict-mcp-config", "--mcp-config", str(mcp_config),   # only DGC's server, not the user's
            "--allowedTools", f"mcp__{SERVER}",          # whose tools need no prompt,
            "--permission-mode", "dontAsk",              # and anything else is refused, never asked
            "--disable-slash-commands", "--no-session-persistence", "--no-chrome",
            "--system-prompt-file", str(system_file)]
    if model:
        argv += ["--model", model]
    if effort:
        argv += ["--effort", effort]
    return argv


# Codex's own tools and context, all off for a Pip (`codex features list`; verified with codex-cli 0.153.4).
CODEX_OFF = ("shell_tool", "unified_exec", "shell_snapshot", "view_image", "apps", "plugins", "remote_plugin",
             "multi_agent", "image_generation", "browser_use", "browser_use_external", "computer_use",
             "in_app_browser", "goals", "memories", "hooks", "tool_suggest",
             "skill_mcp_dependency_install", "skill_search", "workspace_dependencies", "sleep_tool")


# What Codex's model catalog would give each model besides DGC's tools (`codex debug models`): its patch tool, a
# shell, tool search (which hides MCP tools until searched), sub-agents and code mode's JavaScript host. A Pip's
# run reads its own copy of the catalog with all of them off.
CATALOG_OFF = {"apply_patch_tool_type": None, "shell_type": "disabled", "supports_search_tool": False,
               "multi_agent_version": None, "experimental_supported_tools": [], "tool_mode": "direct_only",
               "include_apps_usage_instructions": False, "include_plugin_usage_instructions": False,
               "include_skills_usage_instructions": False}


def codex_catalog(launch: dict, folder: Path) -> Path:
    """The run's model catalog: Codex's own (its `debug models`, refreshed, else the one it ships), each model with
    CATALOG_OFF. Without it Codex gives the model apply_patch and hides DGC's tools behind tool search."""
    catalog = None
    for extra in ([], ["--bundled"]):
        try:
            done = subprocess.run([launch["binary"], "debug", "models", *extra], cwd=str(folder), env=child_env(launch),
                                  stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
            value = json.loads(done.stdout) if done.returncode == 0 else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            value = None
        if isinstance(value, dict) and isinstance(value.get("models"), list) and value["models"]:
            catalog = value
            break
    if catalog is None:
        raise RegistryError("model_failed", "Codex didn't list its models, so the Pip's run didn't start.")
    for model in catalog["models"]:
        if isinstance(model, dict):
            model.update(CATALOG_OFF)
    path = folder / "models.json"
    _private_write(path, json.dumps(catalog))
    return path


def codex_argv(binary: str, *, relay: list[str], env_names: list[str], system_file: Path, folder: Path,
               catalog: Path, model: str = "", effort: str = "", images=()) -> list[str]:
    toml = lambda value: json.dumps(value)               # a JSON string or array is TOML too
    argv = [binary, "exec", "--json", "--skip-git-repo-check", "--ephemeral",
            "--ignore-user-config", "--ignore-rules",    # no config.toml (its MCP servers, profiles), no exec rules
            "--sandbox", "read-only", "--cd", str(folder),
            "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
            "-c", "skills.include_instructions=false", "-c", "project_doc_max_bytes=0",
            "-c", "include_permissions_instructions=false", "-c", "include_environment_context=false",
            "-c", "model_instructions_file=" + toml(str(system_file)),
            "-c", "model_catalog_json=" + toml(str(catalog)),
            "-c", f"mcp_servers.{SERVER}.command=" + toml(relay[0]),
            "-c", f"mcp_servers.{SERVER}.args=" + toml(relay[1:]),
            "-c", f"mcp_servers.{SERVER}.env_vars=" + toml(env_names),
            "-c", f'mcp_servers.{SERVER}.default_tools_approval_mode="approve"',
            "-c", f"mcp_servers.{SERVER}.startup_timeout_sec=60",
            "-c", f"mcp_servers.{SERVER}.tool_timeout_sec=900"]
    for feature in CODEX_OFF:
        argv += ["-c", f"features.{feature}=false"]
    if model:
        argv += ["-m", model]
    if effort:
        argv += ["-c", f'model_reasoning_effort="{effort}"']
    for image in images:
        argv.append(f"--image={image}")                  # one value each: `-i` takes several, and would take "-"
    return argv + ["-"]                                   # the prompt comes on stdin


def relay_command() -> list[str]:
    return [sys.executable, "-I", str(Path(__file__).with_name("pip_brain_relay.py"))]


# --------------------------------------------------------------------------- DGC's tools, as MCP

def mcp_tool(schema: dict) -> dict:
    function = schema.get("function", schema)
    params = function.get("parameters") if isinstance(function.get("parameters"), dict) else None
    return {"name": str(function["name"]), "description": str(function.get("description") or ""),
            "inputSchema": params or {"type": "object", "properties": {}}}


_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")


class ToolServer:
    """This run's Pip tools as an MCP server on a private Unix socket. The CLI reaches it through the relay, which
    presents the run's token first; a connection without it is closed unanswered. ``call(name, arguments)``
    returns ``{"text", "images": [(mime, bytes)], "error"}``; calls run one at a time, as in a native turn."""

    def __init__(self, tools: list[dict], call):
        from .pip_computer import socket_dir
        self.tools = [mcp_tool(tool) for tool in tools]
        self.call = call
        self.token = secrets.token_hex(24)
        self.path = socket_dir() / f"brain-{secrets.token_hex(6)}.sock"
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(self.path))
        os.chmod(self.path, 0o600)
        self.server.listen(4)
        self.refused = 0
        self._calls = threading.Lock()
        self._stopped = threading.Event()
        threading.Thread(target=self._accept, name="dgc-pip-brain-tools", daemon=True).start()

    def env(self) -> dict:
        return {"DGC_PIP_MCP_SOCKET": str(self.path), "DGC_PIP_MCP_TOKEN": self.token}

    def close(self) -> None:
        self._stopped.set()
        for step in (lambda: self.server.shutdown(socket.SHUT_RDWR), self.server.close, self.path.unlink):
            try:
                step()
            except OSError:
                pass

    def _accept(self) -> None:
        while not self._stopped.is_set():
            try:
                link, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(link,), daemon=True).start()

    def _serve(self, link) -> None:
        with link, link.makefile("rb") as reader:
            try:
                hello = json.loads(reader.readline(4096) or b"null")
            except (OSError, ValueError):
                hello = None
            if not isinstance(hello, dict) or not secrets.compare_digest(str(hello.get("token", "")), self.token):
                self.refused += 1
                return
            writing = threading.Lock()

            def send(message):
                data = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
                with writing:
                    link.sendall(data)

            while not self._stopped.is_set():
                try:
                    line = reader.readline(MAX_REQUEST + 1)
                except OSError:
                    return
                if not line or len(line) > MAX_REQUEST:
                    return
                try:
                    message = json.loads(line)
                except ValueError:
                    send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                    continue
                if isinstance(message, dict) and isinstance(message.get("method"), str):
                    threading.Thread(target=self._answer, args=(message, send), daemon=True).start()

    def _answer(self, message, send) -> None:
        method, ident, params = message["method"], message.get("id"), message.get("params") or {}
        if "id" not in message:
            return                                   # a notification (initialized, cancelled): nothing to say
        try:
            if method == "initialize":
                asked = params.get("protocolVersion") if isinstance(params, dict) else None
                result = {"protocolVersion": asked if asked in _PROTOCOLS else _PROTOCOLS[1],
                          "capabilities": {"tools": {"listChanged": False}},
                          "serverInfo": {"name": "dgc-pip", "version": "1"},
                          "instructions": "The Pip's own tools, from DGC."}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": self.tools}
            elif method == "tools/call":
                tool = params.get("name") if isinstance(params, dict) else None
                arguments = params.get("arguments") if isinstance(params, dict) else None
                if not any(t["name"] == tool for t in self.tools):
                    result = {"content": [{"type": "text", "text": f"error: there is no tool named {tool}."}], "isError": True}
                else:
                    with self._calls:
                        out = self.call(tool, arguments if isinstance(arguments, dict) else {})
                    content = []
                    for mime, data in out.get("images") or ():
                        content.append({"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": mime})
                    content.append({"type": "text", "text": str(out.get("text", ""))})
                    result = {"content": content, "isError": bool(out.get("error"))}
            elif method in ("resources/list", "prompts/list"):
                result = {method.split("/")[0]: []}
            else:
                send({"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"Unknown method {method}"}})
                return
        except Exception as error:                   # noqa: BLE001 - one bad request never ends the run's tools
            send({"jsonrpc": "2.0", "id": ident, "error": {"code": -32603, "message": f"{type(error).__name__}: {error}"[:500]}})
            return
        try:
            send({"jsonrpc": "2.0", "id": ident, "result": result})
        except OSError:
            pass


# --------------------------------------------------------------------------- one turn

class BrainClient:
    """What the Agent sees as its model client in a subscription run: the CLI. It sees images and calls tools; DGC
    never sends it a request of its own (a chat brief falls back to its mechanical form)."""
    tools_supported = True
    vision_supported = True
    reasoning_supported = False
    base_url = ""
    api_mode = "subscription"
    family = "subscription"

    def __init__(self, brain: dict):
        self.model = label(brain)
        self.brain = brain

    def chat(self, *args, **kwargs):
        raise RuntimeError("A Pip on a subscription sends DGC no model requests of its own.")


def _short(text, limit) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + " …"


def transcript(messages) -> str:
    """The conversation before this turn, as text the CLI reads (it starts fresh every turn)."""
    lines = []
    for message in messages:
        role, content = message.get("role"), message.get("content")
        if isinstance(content, list):
            content = " ".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
        content = str(content or "").strip()
        if role == "user" and content:
            lines.append("User: " + content)
        elif role == "assistant":
            if content:
                lines.append("You: " + content)
            for call in message.get("tool_calls") or ():
                function = call.get("function") or {}
                lines.append(f"You used {function.get('name')} {_short(function.get('arguments'), 500)}")
        elif role == "tool" and content:
            lines.append("It answered: " + _short(content, TOOL_RESULT_IN_TRANSCRIPT))
    return "\n\n".join(lines)


def _bare(tool: str) -> str:
    """mcp__dgc__computer (Claude Code) and dgc.computer (Codex) are DGC's computer."""
    for prefix in (f"mcp__{SERVER}__", f"{SERVER}."):
        if tool.startswith(prefix):
            return tool[len(prefix):]
    return ""


TOOLS_NOTE = ("\n\nYour tools are DGC's and nothing else: they reach you as mcp__dgc__NAME (or dgc.NAME), where NAME is "
              "the tool these instructions name (computer, offer_choices, connect_app and the rest). You have no shell, "
              "no file tools and no web tools of your own; never say you ran a command or read a file yourself.")


class Turn:
    """One CLI run for one Pip turn. The CLI's lines (text, its calls) and the calls it makes on DGC's tools meet
    here in order, so the Agent's transcript reads as a native turn's: text, a call, its answer, more text."""

    def __init__(self, agent, launch: dict, brain: dict, *, stopping=None):
        self.agent, self.launch, self.brain = agent, launch, brain
        self.engine = _engine(brain["engine"])
        self.cond = threading.Condition()
        self.pending = ""                # text since the last call
        self.said = []                   # text of this turn, for the result
        self.announced = []              # the CLI's own lines about calls on DGC's tools, not yet made
        self.calls = 0
        self.stray = ""                  # a tool of the CLI's own it tried to use
        self.asked_for_words = False     # its choices came before any words, once
        self.end_at = None               # offer_choices and the eyes card end the turn
        self.errors = []
        self.usage = None
        self.proc = None
        self.stopping = stopping

    # The Agent's messages, as a native turn writes them.
    def _flush(self, call=None) -> None:
        text = self.pending.strip()
        self.pending = ""
        if text or call is not None:
            message = {"role": "assistant", "content": text}
            if call is not None:
                message["tool_calls"] = [{"id": call[0], "type": "function",
                                          "function": {"name": call[1], "arguments": json.dumps(call[2], ensure_ascii=False)}}]
            self.agent.messages.append(message)
        try:
            self.agent.ui.end_stream()
        except Exception:                          # noqa: BLE001
            pass

    def on_event(self, event: dict) -> None:
        kind = event.get("kind")
        with self.cond:
            if self.end_at is not None and kind in ("text", "thinking", "result"):
                return                       # its message ended at its choices: nothing after them is shown
            if kind == "text" and event.get("text"):
                text = str(event["text"])
                if self.pending and not self.pending.endswith(("\n", " ")) and not text.startswith(("\n", " ")):
                    text = "\n\n" + text
                if len("".join(self.said)) + len(text) > MAX_TEXT:
                    self.errors.append("it said more than one reply can hold")
                    self._kill()
                    return
                self.pending += text
                self.said.append(text)
                self.agent.ui.on_text(text)
            elif kind == "thinking" and event.get("text"):
                self.agent.ui.on_thinking(str(event["text"]))
            elif kind == "tool_call":
                tool = str(event.get("name") or "")
                if _bare(tool):
                    self.announced.append(_bare(tool))
                    self.cond.notify_all()
                elif not self.stray:
                    # Defence in depth: the flags leave it none of its own, so this never happens. If it does, the turn
                    # stops before the CLI goes on.
                    self.stray = tool or "a tool"
                    self._kill()
            elif kind == "result" and event.get("text") and not self.said:
                text = str(event["text"])
                self.pending += text
                self.said.append(text)
                self.agent.ui.on_text(text)
            elif kind == "error" and event.get("text"):
                self.errors = [*self.errors[-3:], str(event["text"])[:2000]]
            elif kind == "usage" and isinstance(event.get("usage"), dict):
                self.usage = event["usage"]
            elif kind == "status" and event.get("text"):
                self.agent.ui.info(str(event["text"]))

    def call(self, tool: str, arguments: dict) -> dict:
        """A call the CLI made on DGC's tools: the Pip's own handler answers it."""
        from .llm import ToolCall
        agent = self.agent
        with self.cond:
            # Its line about this call names what it said before it: wait for that line, so the transcript keeps order.
            self.cond.wait_for(lambda: tool in self.announced or self.proc is None or self.proc.poll() is not None,
                               timeout=ANNOUNCE_WAIT)
            if tool in self.announced:
                self.announced.remove(tool)
            if self.end_at is not None:
                return {"text": "Your message is complete.", "error": False}
            if tool == "offer_choices" and not "".join(self.said).strip() and not self.asked_for_words:
                # Choices end the reply, so words must come first. Codex offered its choices before writing anything
                # (a take of the shirts ask, 2026-10-20), and the chat got an empty reply: ask once for the words.
                self.asked_for_words = True
                return {"text": "Not shown yet. Write your message first: the question these choices answer, in one or "
                                "two short sentences. Then call offer_choices again.", "error": True}
            self.calls += 1
            call_id = f"brain_{self.calls}"
            self._flush((call_id, tool, arguments))
            agent._brain_images = []
            try:
                out = agent._handle_call(ToolCall(id=call_id, name=tool, arguments=dict(arguments)))
            except Exception as error:             # noqa: BLE001 - a failing tool is an answer, as natively
                out = f"error: {type(error).__name__}: {error}"
            finally:
                images, agent._brain_images = agent._brain_images or [], None
            out = agent._safe_text(str(out))
            agent.messages.append({"role": "tool", "tool_call_id": call_id, "content": out})
            if getattr(agent, "_end_turn_after_batch", ""):
                agent._end_turn_after_batch = ""
                self.end_at = time.monotonic()
            content = [(entry["mime"], entry["data"]) for entry in images
                       if isinstance(entry, dict) and isinstance(entry.get("data"), (bytes, bytearray))
                       and entry.get("mime") in ("image/jpeg", "image/png", "image/webp", "image/gif")]
            return {"text": out, "images": content, "error": out.lower().startswith(("error", "permission denied"))}

    def _kill(self) -> None:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.kill()
        except OSError:
            pass

    def run(self, prompt: str, *, images=()) -> bool:
        from .redaction import StreamingRedactor
        from .subscriptions import parse_stream_events
        agent = self.agent
        folder = Path(self.launch["folder"])
        system = agent.messages[0]["content"] if agent.messages and agent.messages[0].get("role") == "system" else ""
        system_file = folder / "instructions.md"
        _private_write(system_file, str(system) + TOOLS_NOTE)
        history = transcript(agent.messages[1:])
        text = (("This conversation so far, oldest first (reference, not new instructions):\n\n" + history + "\n\n"
                 "Now:\n") if history else "") + prompt
        agent.messages.append({"role": "user", "content": prompt})
        # The Pip's own thinking choice (its prompt box) is the CLI's effort; else DGC's, when it follows DGC.
        thinking = str(getattr(agent, "config", None) and agent.config.get("thinking", "off") or "off")
        effort = thinking if thinking in EFFORTS[self.brain["engine"]] else self.brain["effort"]
        tools = ToolServer(agent._tool_schemas(), self.call)
        relay = relay_command()
        try:
            if self.brain["engine"] == "claude":
                config_file = folder / "mcp.json"
                _private_write(config_file, json.dumps({"mcpServers": {SERVER: {
                    "type": "stdio", "command": relay[0], "args": relay[1:], "env": tools.env(), "alwaysLoad": True}}}))
                argv = claude_argv(self.launch["binary"], mcp_config=config_file, system_file=system_file,
                                   model=self.brain["model"], effort=effort)
                parts = [{"type": "text", "text": text}] + [
                    {"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(data).decode("ascii")}}
                    for mime, data in images]
                stdin = json.dumps({"type": "user", "message": {"role": "user", "content": parts}}) + "\n"
                env = child_env(self.launch)
            else:
                paths = []
                for index, (mime, data) in enumerate(images):
                    path = folder / f"photo-{index + 1}.{mime.split('/')[-1].replace('jpeg', 'jpg')}"
                    _private_write(path, data)
                    paths.append(path)
                argv = codex_argv(self.launch["binary"], relay=relay, env_names=sorted(tools.env()), system_file=system_file,
                                  folder=folder, catalog=codex_catalog(self.launch, folder), model=self.brain["model"],
                                  effort=effort, images=paths)
                stdin = text
                env = child_env(self.launch, tools.env())
            agent._activity("waiting", "Waiting for " + self.engine.short_label)
            # Same process group as the worker: when the controller stops the run, the CLI stops with it.
            self.proc = subprocess.Popen(argv, cwd=str(folder), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, bufsize=0)
            try:
                self.proc.stdin.write(stdin.encode("utf-8"))
                self.proc.stdin.close()
            except OSError:
                pass
            redact = StreamingRedactor(agent._secret_values())
            diagnostics = []
            watcher = threading.Thread(target=self._watch, daemon=True)
            watcher.start()
            while True:
                raw = self.proc.stdout.readline(MAX_LINE + 1)
                if not raw:
                    break
                if len(raw) > MAX_LINE:
                    while raw and not raw.endswith(b"\n"):
                        raw = self.proc.stdout.readline(MAX_LINE + 1)
                    continue
                line = raw.decode("utf-8", errors="replace")
                events = parse_stream_events(self.engine.stream, line)
                if not events and line.strip() and not line.lstrip().startswith(("{", "[")) and len(diagnostics) < 4:
                    diagnostics.append(redact.feed(line.strip())[:500] + redact.flush())
                for event in events:
                    self.on_event(event)
            code = self.proc.wait()
        finally:
            tools.close()
            self._kill()
            if self.proc is not None and self.proc.stdout is not None:
                self.proc.stdout.close()
            # Nothing of the turn stays in its folder: its instructions, the dead token, the catalog, the photos.
            for leftover in folder.iterdir():
                try:
                    leftover.unlink()
                except OSError:
                    pass
            with self.cond:
                self.cond.notify_all()
        with self.cond:
            self._flush()
        if isinstance(self.usage, dict):
            try:
                agent._record_usage(self.usage, "user_turn")
            except Exception:                      # noqa: BLE001
                pass
        said = "".join(self.said).strip()
        if self.stray:
            agent._last_turn_error = (f"{self.engine.short_label} tried to use its own {self.stray}, which a Pip can't. "
                                      "The turn was stopped.")
            return False
        if self.end_at is not None:
            return True                            # it ended at its choices: what it said is the reply
        if code == 0 and said:
            return True
        if code == 0 and self.calls:
            agent._last_turn_error = "The model ended without a user-facing response"
            return False
        problem = (self.errors[-1] if self.errors else "\n".join(diagnostics) if diagnostics
                   else f"it stopped (exit {code})")
        agent._last_turn_error = f"{self.engine.short_label} didn't finish this turn: {_short(problem, 600)}"
        return False

    def _watch(self) -> None:
        # offer_choices and the eyes card end a turn, as natively: the CLI would only ask its model again.
        while self.proc is not None and self.proc.poll() is None:
            if self.end_at is not None and time.monotonic() - self.end_at > 0.5:
                self._kill()
                return
            if self.stopping is not None and self.stopping():
                self._kill()
                return
            time.sleep(0.1)


def _private_write(path: Path, data) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data.encode("utf-8") if isinstance(data, str) else data)


def launch_from_env(brain: dict) -> dict:
    raw = os.environ.get("DGC_PIP_BRAIN", "")
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        value = None
    return validate_launch(value, brain)
