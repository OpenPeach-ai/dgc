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
from typing import Callable, Iterator


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

    @property
    def short_label(self) -> str:
        return self.label.split(" (")[0]

    def resolve(self) -> str | None:
        """Absolute path to the installed binary, or None."""
        return shutil.which(self.binary)

    def logged_in(self) -> bool:
        home = Path.home()
        return any((home / m).expanduser().exists() for m in self.auth_markers)

    def supports_effort(self) -> bool:
        return bool(self.effort_style)

    def build_argv(self, binary: str, prompt: str, *, cont: bool,
                   model: str = "", effort: str = "") -> list[str]:
        argv = [binary, *self.subcmd]
        if cont:
            argv += list(self.resume)
        argv += list(self.flags)
        if model and self.model_flag:                 # steer the vendor's own model
            argv += [self.model_flag, model]
        if effort and self.effort_style == "flag":    # claude: --effort LEVEL
            argv += ["--effort", effort]
        elif effort and self.effort_style == "codex":  # codex: -c model_reasoning_effort="LEVEL"
            argv += ["-c", f'model_reasoning_effort="{effort}"']
        if self.prompt_flag:
            argv += [self.prompt_flag, prompt]
        else:
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
        flags=("-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"),
        prompt_flag=None, stream="claude", model_flag="--model", effort_style="flag",
        model_hints=("opus", "sonnet", "haiku"),
        install_cmd="npm install -g @anthropic-ai/claude-code", login_run="claude auth login"),
    "codex": SubEngine(
        key="codex", label="Codex (ChatGPT Plus / Pro subscription)", binary="codex",
        auth_markers=(".codex/auth.json",), login_cmd="codex login",
        note="Runs your ChatGPT subscription through the official Codex CLI.",
        subcmd=("exec",), resume=("resume", "--last"),
        flags=("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"),
        prompt_flag=None, stream="codex", model_flag="-m", effort_style="codex",
        install_cmd="npm install -g @openai/codex", login_run="codex login"),
    "qwen": SubEngine(
        key="qwen", label="Qwen Code (Qwen OAuth)", binary="qwen",
        auth_markers=(".qwen/oauth_creds.json",), login_cmd="qwen  (then approve the device code)",
        note="Runs your Qwen OAuth plan through the official Qwen Code CLI.",
        subcmd=(), resume=("-c",),
        flags=("--output-format", "stream-json", "--yolo"),
        prompt_flag="-p", stream="qwen", model_flag="-m",
        install_cmd="npm install -g @qwen-code/qwen-code"),
    "kimi": SubEngine(
        key="kimi", label="Kimi for Coding (Moonshot subscription)", binary="kimi",
        auth_markers=(".kimi/credentials", ".kimi/kimi.json"), login_cmd="kimi login",
        note="Runs your Kimi for Coding subscription through the official Kimi CLI.",
        subcmd=(), resume=("--continue",),
        flags=("--output-format", "stream-json", "--yolo"),
        prompt_flag="-p", stream="kimi", model_flag="-m",
        install_cmd="npm install -g @moonshot-ai/kimi-code", login_run="kimi login"),
    "copilot": SubEngine(
        key="copilot", label="GitHub Copilot CLI (Copilot subscription)", binary="copilot",
        auth_markers=(".config/github-copilot/apps.json", ".config/github-copilot/hosts.json",
                      ".copilot/config.json"),
        login_cmd="copilot  (then run /login), or set GH_TOKEN",
        note="Runs your GitHub Copilot subscription through the official Copilot CLI.",
        subcmd=(), resume=("--continue",),
        # The Copilot CLI has no JSON stream mode; --allow-all is its auto-approve.
        flags=("--allow-all",),
        prompt_flag="--prompt", stream="copilot", model_flag="--model",
        install_cmd="npm install -g @github/copilot"),
}

ENGINE_KEYS = tuple(ENGINES)


def get_engine(key: str) -> SubEngine | None:
    return ENGINES.get((key or "").strip().lower())


def status() -> list[dict]:
    """Installed / logged-in state for every engine — for the picker and `dgc doctor`."""
    out = []
    for e in ENGINES.values():
        installed = e.resolve() is not None
        out.append({"key": e.key, "label": e.label, "installed": installed,
                    "logged_in": installed and e.logged_in(),
                    "login_cmd": e.login_cmd, "note": e.note})
    return out


class EngineError(RuntimeError):
    """Base for delegation problems the caller should surface, not crash on."""


class EngineNotInstalled(EngineError):
    pass


class EngineNotAuthenticated(EngineError):
    pass


# --- streaming normalizers --------------------------------------------------
# Each vendor emits its own JSONL schema. We normalize to DGC-neutral events:
#   {"kind": "text"|"tool"|"result"|"error"|"raw", "text": str, ...}
# Tolerant by design: an unrecognized line becomes a {"kind": "raw"} event so
# nothing is silently dropped and a schema change never breaks the run.
def _normalize(stream: str, obj: dict) -> dict | None:
    t = obj.get("type") or obj.get("event") or ""
    if stream == "claude":
        if t == "assistant":
            msg = obj.get("message", {})
            parts = msg.get("content", []) if isinstance(msg, dict) else []
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
            return {"kind": "text", "text": text} if text else {"kind": "raw", "text": ""}
        if t == "result":
            return {"kind": "result", "text": str(obj.get("result", "")),
                    "is_error": bool(obj.get("is_error"))}
    elif stream == "codex":
        msg = obj.get("msg", obj)
        mt = msg.get("type", t)
        if mt in ("agent_message", "assistant_message"):
            return {"kind": "text", "text": str(msg.get("message") or msg.get("text") or "")}
        if mt == "task_complete" or mt == "turn_complete":
            return {"kind": "result", "text": str(msg.get("last_agent_message") or "")}
        if "command" in mt or mt.endswith("_call"):
            return {"kind": "tool", "text": str(msg.get("command") or msg.get("name") or mt)}
    elif stream in ("qwen", "kimi"):
        if t in ("content", "assistant", "message"):
            return {"kind": "text", "text": str(obj.get("content") or obj.get("text") or "")}
        if t in ("result", "final", "done"):
            return {"kind": "result", "text": str(obj.get("content") or obj.get("result") or "")}
        if t in ("tool_call", "tool", "tool_use"):
            return {"kind": "tool", "text": str(obj.get("name") or obj.get("tool") or "tool")}
    return {"kind": "raw", "text": json.dumps(obj)[:2000]}


def parse_stream_line(stream: str, line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    if stream == "copilot":          # the Copilot CLI has no JSON stream mode — surface plain text
        return {"kind": "text", "text": line}
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return {"kind": "raw", "text": line[:2000]}
    if not isinstance(obj, dict):
        return {"kind": "raw", "text": str(obj)[:2000]}
    return _normalize(stream, obj)


def preflight(engine: SubEngine) -> str:
    """Resolve the binary or raise a caller-friendly error. Returns the abs path."""
    binary = engine.resolve()
    if not binary:
        raise EngineNotInstalled(
            f"{engine.label} is not installed — install its CLI (`{engine.binary}`) first.")
    if not engine.logged_in():
        raise EngineNotAuthenticated(
            f"{engine.label} is not signed in — run `{engine.login_cmd}` once, then retry.")
    return binary


def run_turn(engine: SubEngine, prompt: str, workdir, *, cont: bool = False,
             timeout: int = 1800, on_event: Callable[[dict], None] | None = None,
             env: dict | None = None, cancel: Callable[[], bool] | None = None,
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
    argv = engine.build_argv(binary, prompt, cont=cont, model=model, effort=effort)
    proc = subprocess.Popen(
        argv, cwd=str(workdir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, env={**os.environ, **(env or {})}, start_new_session=True)

    state = {"stopped": None}                # None | "timeout" | "cancelled"
    stop = threading.Event()

    def _kill():
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    def _poll():
        start = time.time()
        while not stop.wait(0.2):
            if proc.poll() is not None:
                return
            if timeout and time.time() - start > timeout:
                state["stopped"] = "timeout"; _kill(); return
            if cancel is not None and cancel():
                state["stopped"] = "cancelled"; _kill(); return

    poller = threading.Thread(target=_poll, daemon=True)
    poller.start()

    final, last_text, n, t0 = "", "", 0, time.time()
    try:
        for line in proc.stdout:                      # closes when the CLI (or the kill) ends it
            ev = parse_stream_line(engine.stream, line)
            if not ev:
                continue
            n += 1
            if ev.get("text"):
                if ev["kind"] == "result":
                    final = ev["text"]
                elif ev["kind"] == "text":
                    last_text = ev["text"]
            if on_event:
                on_event(ev)
    finally:
        stop.set()
        rc = proc.wait()
    return {"rc": None if state["stopped"] else rc, "text": final or last_text,
            "timeout": state["stopped"] == "timeout",
            "cancelled": state["stopped"] == "cancelled",
            "events": n, "seconds": round(time.time() - t0, 1)}
