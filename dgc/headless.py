"""Headless JSON backend — `dgc serve`.

A second AgentUI (see ui.py): it serializes the agent's callbacks to NDJSON on stdout and
drives the agent from JSON commands on stdin. stdout carries protocol lines ONLY; anything
human goes to stderr. This is the layer the VS Code / Cursor extension talks to, and the
substrate the ACP adapter will reframe (Phase 4).
"""
from __future__ import annotations

import copy
import io
import json
import math
import re
import sys
import signal
import threading
import os
import time
from pathlib import Path

from . import __version__
from . import sessions as sessions_mod
from .agent import Agent
from .attachments import MAX_EDITOR_IMAGE_TOTAL_BYTES, validate_image_data_uris
from .editor_context import _editor_context_json, _format_editor_context, _strip_editor_context
from .commands import (
    custom_command_names, discover_commands, editor_command_metadata, render_command,
)
from .config import Config, mcp_url_has_credentials
from .editor_protocol import (MAX_COMMAND_BYTES, MAX_EVENT_BYTES, MAX_SAFE_INTEGER, PROTOCOL_VERSION,
                              command_error, event_error)
from .permissions import Rule, rule_for
from .mcp_config import validate_mcp_spec as _mcp_spec, public_mcp_spec
from .protocol import Emitter, PendingRequests, strict_json_loads
from .redaction import redact_value, secret_values
from .hooks import hook_catalog
from .skills import discover_skills, normalize_skill_name, skill_catalog
from .tools import TOOL_SCHEMAS
from .ui import (activity_verb, arg_summary, edit_preview, split_diff,
                 tool_output_is_error)

_PLAN_MODES = ("auto", "acceptEdits", "default")
_MAX_QUEUED_TURNS = 32
_MAX_QUEUED_TURN_BYTES = 16 * 1024 * 1024
_MAX_PROMPT_CHARS = 1_000_000
_MAX_MCP_ARGUMENT_BYTES = 1024 * 1024
_MAX_MCP_LIST_BYTES = 1024 * 1024
_MAX_MCP_LIST_LIMIT = 100
_MAX_MCP_SERVERS = 64
# Settings that only shape the next request, so changing them mid-turn cannot disturb the one in
# flight. Anything that moves the execution route -- provider, model, sandbox, delegation -- is
# deliberately absent and still waits for the turn to end.
_LIVE_SAFE_CONFIG_KEYS = frozenset({
    "context_size", "show_reasoning", "preserve_thinking", "suggest", "plan_artifact",
    "artifact_autostart", "artifact_in_plan", "notes", "notes_max_rows", "compact_threshold",
    "capability_cache_ttl_s", "search_provider", "search_url",
    "monitor_wake", "monitor_wake_delay_s", "monitor_wake_cooldown_s",
    "monitor_max_consecutive_wakes",
})
# Commands that only read state. Every other command is the user doing something, so a monitor
# wake-up waits one wake delay after it -- and never starts while the command is being handled.
_WAKE_NEUTRAL_COMMANDS = frozenset({
    "get_chat_changes", "get_chat_change", "get_workspace_changes", "get_workspace_change",
    "list_models", "list_mcp_tools", "list_skills", "get_skill", "list_docs", "get_doc",
    "list_mcp_servers", "list_permissions", "get_memory", "list_hooks", "get_goal", "get_plan",
    "get_recall", "list_sessions", "list_checkpoints", "list_retained_tasks", "list_artifacts",
    "get_config", "status", "get_history", "list_monitors", "stop_monitor", "list_mcp_context",
    "list_agents", "get_image",
})
_WAKE_YIELD_TIMEOUT = 10.0
_NEW_SESSION_CANCEL_TIMEOUT = 20.0      # a cancelled turn unwinds in well under this
_MCP_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_BUSY_MUTATIONS = {
    # `new_session` is deliberately absent: asking for a new chat while a turn runs is a decision
    # to abandon that turn, so its handler cancels and waits rather than refusing the request.
    # `set_config` is not here: a setting that only shapes the NEXT request is safe to change while
    # a turn runs, and refusing all of them meant a user could not raise the context window without
    # abandoning the work that made them want to. The handler gates the unsafe keys itself.
    # `clear_todos` is not here either: Clear empties the list at once, even mid-turn, and the
    # worker that owns the session saves it as it retires.
    "set_model", "set_think", "clear_session", "resume_session",
    "delete_session", "rewind", "compact", "set_workspace_roots", "set_goal", "start_goal",
    "resolve_retained_task", "reload_skills", "set_skill_enabled", "create_skill", "install_skill", "generate_handoff", "name_session",
    "upsert_mcp_server", "remove_mcp_server", "reload_mcp_servers", "set_mcp_enabled", "reconnect_mcp_server", "mcp_command",
    "add_permission_rule", "remove_permission_rule", "add_memory",
    # Continuing an interrupted turn is offered on an idle chat; while a turn runs there is
    # nothing interrupted to continue.
    "resume_turn",
}
_OPTIONALLY_CORRELATED_COMMANDS = frozenset({
    "prompt", "start_goal", "resume_turn",
    "get_workspace_changes", "get_workspace_change", "get_chat_changes", "get_chat_change",
    "set_workspace_roots", "set_mode", "set_model", "set_think", "set_goal", "get_goal",
    "get_plan", "new_session", "clear_session", "resume_session", "list_sessions", "get_recall",
    "delete_session", "fork_session", "list_checkpoints", "rewind", "list_retained_tasks",
    "resolve_retained_task", "compact", "list_artifacts", "stop_artifact", "set_config", "clear_todos",
    "get_config", "status", "name_session", "reload_skills", "set_skill_enabled", "create_skill", "install_skill", "get_skill", "list_docs", "get_doc",
    "list_mcp_servers", "upsert_mcp_server", "remove_mcp_server", "reload_mcp_servers",
    "list_mcp_context", "get_mcp_context", "set_mcp_enabled", "reconnect_mcp_server", "mcp_command", "get_history",
    "list_permissions", "add_permission_rule", "remove_permission_rule",
    "get_memory", "add_memory", "list_monitors", "stop_monitor", "list_agents",
})
_EDITOR_CONTEXT_LIMIT = 64_000
_CONFIG_BOOLEAN_KEYS = frozenset({
    "prompt_cache", "sandbox", "sandbox_network", "show_reasoning", "preserve_thinking",
    "code_action", "suggest", "plan_artifact", "artifact_autostart", "artifact_in_plan",
    "ultra_mode", "monitor_wake",
})
_CONFIG_STRING_LIMITS = {
    "subagent_model": 512,
    "subagent_base_url": 4096,
    "subagent_api_key": 16_384,
    "prompt_cache_key": 64,
    "fallback_model": 512,
    "fallback_base_url": 4096,
    "fallback_api_key": 16_384,
    "autonomous_gate": 512,
    "subscription_model": 256,
}
_CONFIG_ENUMS = {
    "api_mode": frozenset({"auto", "ollama", "anthropic", "chat_completions", "responses"}),
    "subagent_api_mode": frozenset({"", "auto", "ollama", "anthropic",
                                     "chat_completions", "responses"}),
    "fallback_api_mode": frozenset({"", "auto", "ollama", "anthropic",
                                     "chat_completions", "responses"}),
    "provider_state": frozenset({"stateless", "server"}),
    "search_provider": frozenset({"duckduckgo", "brave", "tavily", "searxng"}),
    "tool_profile": frozenset({"adaptive", "full"}),
    "thinking": frozenset({"off", "low", "medium", "high", "xhigh"}),
    "subscription_effort": frozenset({"", "low", "medium", "high", "xhigh", "max"}),
}
_CONFIG_INTEGER_RANGES = {
    "capability_cache_ttl_s": (1, MAX_SAFE_INTEGER),
    "context_size": (2_048, MAX_SAFE_INTEGER),
    "max_parallel_tasks": (1, 8),
    "autonomous_max_turns": (1, 1_000),
    "monitor_wake_delay_s": (1, 300),
    "monitor_wake_cooldown_s": (1, 3600),
    "monitor_max_consecutive_wakes": (1, 100),
}


def _validated_config_values(raw_values, subscription_keys) -> tuple[dict | None, str | None]:
    """Validate the generic set_config object completely before any state is changed."""
    if not isinstance(raw_values, dict):
        return None, "settings values must be an object"
    allowed = {*_CONFIG_BOOLEAN_KEYS, *_CONFIG_STRING_LIMITS, *_CONFIG_ENUMS,
               *_CONFIG_INTEGER_RANGES, "provider_capabilities", "subscription_engine"}
    unknown = [key for key in raw_values if key not in allowed]
    if unknown:
        return None, f"unsupported settings key: {str(unknown[0])[:80]}"
    values = dict(raw_values)
    for key in _CONFIG_BOOLEAN_KEYS:
        if key in values and not isinstance(values[key], bool):
            return None, f"{key} must be true or false"
    for key, limit in _CONFIG_STRING_LIMITS.items():
        if key not in values:
            continue
        value = values[key]
        if (not isinstance(value, str) or len(value) > limit
                or any(ord(char) < 32 and not (key == "autonomous_gate" and char == "\t")
                       for char in value)):
            return None, f"{key} must be a bounded plain string"
    for key in ("subagent_base_url", "fallback_base_url"):
        value = values.get(key)
        if value and (any(char.isspace() for char in value) or mcp_url_has_credentials(value)):
            return None, f"{key} cannot contain whitespace or URL credentials"
    # Tabs are useful in a shell gate and were accepted by the prior contract; other controls are
    # neither executable text nor safe durable configuration.
    gate = values.get("autonomous_gate")
    if isinstance(gate, str) and any(ord(char) < 32 and char != "\t" for char in gate):
        return None, "autonomous_gate must be a single-line command string (\u2264512 chars)"
    for key, choices in _CONFIG_ENUMS.items():
        if key in values and (not isinstance(values[key], str) or values[key] not in choices):
            return None, f"{key} has an unsupported value"
    if "subscription_engine" in values:
        engine = values["subscription_engine"]
        if (not isinstance(engine, str) or (engine and engine not in subscription_keys)):
            return None, ("subscription_engine must be empty or one of: "
                          + ", ".join(subscription_keys))
    for key, (minimum, maximum) in _CONFIG_INTEGER_RANGES.items():
        if key not in values:
            continue
        value = values[key]
        if (isinstance(value, bool) or not isinstance(value, int)
                or not minimum <= value <= maximum):
            return None, f"{key} must be an integer from {minimum} to {maximum}"
    if "provider_capabilities" in values:
        capabilities = values["provider_capabilities"]
        from .llm import ProviderCapabilities
        known = frozenset(ProviderCapabilities.__dataclass_fields__)
        if (not isinstance(capabilities, dict) or len(capabilities) > len(known)
                or set(capabilities) - known
                or any(not isinstance(value, bool) for value in capabilities.values())):
            return None, "provider_capabilities must contain only known boolean feature overrides"
    return values, None


def _turn_payload_bytes(text, images, context, kind="prompt") -> int:
    """Approximate the retained decoded queue payload with exact UTF-8 JSON bytes."""
    try:
        return len(json.dumps([text, images, context], ensure_ascii=False,
                              separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError, UnicodeError):
        return _MAX_QUEUED_TURN_BYTES + 1


def _json_payload_bytes(value) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                              allow_nan=False).encode("utf-8"))
    except (RecursionError, TypeError, ValueError, UnicodeError):
        return _MAX_MCP_ARGUMENT_BYTES + 1


def _mcp_url_has_credentials(value: str) -> bool:
    return mcp_url_has_credentials(value)


def _request_fields(request_id: str | None) -> dict[str, str]:
    """Attach a correlation ID only when the optional command field was present and valid."""
    return {"request_id": request_id} if request_id else {}


def _prompt_thread_title(text: str) -> str:
    """Create an immediate, stable editor thread label without another model request."""
    clean = re.sub(r"\s+", " ", _strip_editor_context(str(text or ""))).strip()
    clean = re.sub(r"^[#>*`\-\s]+", "", clean).strip()
    if not clean:
        return ""
    if len(clean) <= 60:
        return clean
    return clean[:57].rstrip(" ,.;:-") + "…"


# The instruction behind the editor's Continue card, sent after DGC's backend stopped in the middle
# of an ordinary turn. The user clicked a button, they did not type this, so it travels as
# turn_start kind "continue" and history replays it as a marker, found by this first sentence.
TURN_CONTINUE_MARKER = "DGC's backend stopped during the previous turn, before it finished."
TURN_CONTINUE_PROMPT = (
    f"{TURN_CONTINUE_MARKER} Continue that turn from the current session state. Look at the most "
    "recent tool results (and the task list, if one is open) before acting; do not redo a step "
    "that already completed, and re-check anything the stop may have left half-done -- a partial "
    "install, an edit in progress, or a server or background command that is no longer running.")


class _Shutdown(Exception):
    pass


class _Terminated(BaseException):
    """SIGTERM/SIGHUP reached the serve loop. BaseException on purpose: the per-command
    `except Exception` must not swallow the one signal that means "stop now"."""

    def __init__(self, signum: int):
        super().__init__(signum)
        self.signum = int(signum)


def _claim_command_pipe(stream=None):
    """Take the editor's command pipe off fd 0 so no child process can touch it.

    `dgc serve` reads its commands from the pipe on fd 0, and every child it starts -- the bash
    tool's commands above all -- used to inherit that same pipe. A Node child (npm, npx, vite,
    next) switches an inherited stdin to O_NONBLOCK the moment it looks at `process.stdin`, and
    the flag lives on the pipe itself, so it changed OUR read too: `readline()` on a non-blocking
    pipe with nothing in it returns b'', which read as end of input, and the backend exited 0 with
    the editor still alive. A child that reads stdin (`head -n 1`) could also swallow the user's
    Stop or an approval.

    So: keep a private, non-inheritable duplicate of the pipe for ourselves, point fd 0 at
    /dev/null for everyone else, and make sure our copy blocks (a flip that happened before we
    started is undone here). Returns ``(reader, note)``; the reader is the original stream when
    the pipe could not be claimed (no file descriptor, a platform that refuses), and the note says
    which happened, for the crash log.
    """
    stream = sys.stdin if stream is None else stream
    try:
        fd = stream.fileno()
    except (AttributeError, OSError, ValueError):
        return stream, "command pipe not claimed: stdin has no file descriptor"
    try:
        private = os.dup(fd)                   # PEP 446: not inherited by any child
    except OSError as exc:
        return stream, f"command pipe not claimed: {exc}"
    try:
        reader = os.fdopen(private, "rb")
    except OSError as exc:
        try:
            os.close(private)
        except OSError:
            pass
        return stream, f"command pipe not claimed: {exc}"
    try:
        os.set_blocking(private, True)
    except (OSError, AttributeError):
        pass                                   # Windows pipes before 3.12; the guard still reads
    try:
        null = os.open(os.devnull, os.O_RDONLY)
        try:
            os.dup2(null, fd)
        finally:
            os.close(null)
    except OSError as exc:
        # We still read our own duplicate, so a flip is caught by the guard in _command_lines;
        # children simply keep sharing the pipe, as they did before.
        return reader, f"command pipe read privately, but fd 0 is still shared: {exc}"
    return reader, "command pipe claimed (fd 0 → /dev/null)"


def _restore_blocking(binary) -> bool:
    """True when the reader's descriptor was non-blocking and has just been made blocking again."""
    try:
        fd = binary.fileno()
        if os.get_blocking(fd):
            return False
        os.set_blocking(fd, True)
        return True
    except (AttributeError, OSError, ValueError):
        return False                           # no descriptor (BytesIO) or a platform without it


class _PipeWatch:
    """What the command pipe did while we read it, for the line that says why the loop ended."""

    LIMIT_PER_SECOND = 50                      # restores in one second before we stop reading
    NOTED = 10                                 # restores written to the log one by one

    def __init__(self, note=None):
        self.restores = 0
        self.gave_up = False
        self._note = note
        self._recent: list[float] = []

    def restored(self) -> bool:
        """Count one restore; False once something is flipping the flag faster than we can read."""
        now = time.monotonic()
        self.restores += 1
        self._recent = [at for at in self._recent if now - at < 1.0]
        self._recent.append(now)
        if self._note is not None and self.restores <= self.NOTED:
            try:
                self._note("command pipe was non-blocking (a process changed it); restored"
                           + (f" (×{self.restores})" if self.restores > 1 else ""))
            except Exception:
                pass
        if len(self._recent) > self.LIMIT_PER_SECOND:
            self.gave_up = True
            return False
        return True

    def describe(self) -> str:
        if self.gave_up:
            return f"non-blocking, gave up after {self.restores} restores"
        return f"non-blocking-restored×{self.restores}" if self.restores else "blocking"


def _command_lines(stream, watch: _PipeWatch | None = None):
    """Yield bounded UTF-8 command lines and recover after an oversized/malformed frame.

    An empty read ends the stream only when the pipe is blocking. On a non-blocking pipe b'' means
    "nothing yet" and a line without its newline means "the rest has not arrived", so the reader
    restores blocking mode and keeps reading instead of treating either as end of input.
    """
    binary = getattr(stream, "buffer", None)
    if binary is None and isinstance(stream, io.BufferedIOBase):
        binary = stream                        # the private reader _claim_command_pipe returns
    if binary is None:  # StringIO and other test/embedded text streams
        for line in stream:
            if len(line.encode("utf-8")) > MAX_COMMAND_BYTES:
                yield None, f"command frame exceeded {MAX_COMMAND_BYTES} bytes"
            else:
                yield line, None
        return
    watch = watch if watch is not None else _PipeWatch()

    def read_line(limit: int) -> bytes | None:
        raw = binary.readline(limit)
        while len(raw) < limit and not raw.endswith(b"\n") and _restore_blocking(binary):
            if not watch.restored():
                return None
            raw += binary.readline(limit - len(raw))
        return raw

    while True:
        raw = read_line(MAX_COMMAND_BYTES + 1)
        if not raw:
            return
        if len(raw) > MAX_COMMAND_BYTES:
            while raw and not raw.endswith(b"\n"):
                raw = read_line(MAX_COMMAND_BYTES + 1)
            yield None, f"command frame exceeded {MAX_COMMAND_BYTES} bytes"
            if watch.gave_up:
                return
            continue
        try:
            yield raw.decode("utf-8"), None
        except UnicodeDecodeError:
            yield None, "command frame was not valid UTF-8"


# A restored turn must be built by the same code that builds a live one, so history is not a
# second projection with its own rules -- it is the live event vocabulary, replayed. Anything in
# this set is a turn fragment: it is meaningless without the ``turn_start`` above it.
_MID_TURN_ITEMS = ("text_delta", "thinking_delta", "thinking_end", "stream_end",
                   "tool_call", "tool_result", "tool_denied", "tool_images", "options_resolved",
                   "model_retry", "monitor_event", "turn_end")


def _safe_busy(backend) -> bool:
    """Is a turn in flight? Never let a status read break the log line that reports it."""
    try:
        return bool(backend._busy())
    except Exception:
        return False


def _goal_scaffold(content: str) -> str:
    """The label for a goal-continuation prompt DGC wrote as the user, or "" if a person typed it.

    Matched by CONTENT, not equality: goal attachments and staged editor context are prepended to
    these prompts, so an exact comparison missed every one of them and the whole objective came
    back in the transcript as something the user had apparently just sent.
    """
    from .goals import AUTO_RESUME_MARKER, CYCLE_MARKER, RESUME_PROMPT
    text = str(content or "")
    if AUTO_RESUME_MARKER in text:
        return "Retried the standing goal after the last attempt stopped"
    if CYCLE_MARKER in text:
        return "Continued the standing goal"
    if RESUME_PROMPT[:60] in text:
        return "Resumed the standing goal"
    return ""


def _history_args(raw) -> dict:
    """The saved tool arguments as a bounded object, so a replayed card shows what a live one did."""
    value = raw
    if not isinstance(value, dict):
        try:
            value = json.loads(str(raw or "") or "{}")
        except (TypeError, ValueError):
            return {}
    if not isinstance(value, dict):
        return {}
    args: dict = {}
    for key, item in list(value.items())[:16]:
        name = str(key)[:64]
        if isinstance(item, str):
            args[name] = item[:1000] + ("…" if len(item) > 1000 else "")
        elif isinstance(item, bool) or item is None or isinstance(item, (int, float)):
            args[name] = item
        else:
            args[name] = json.dumps(item, ensure_ascii=False)[:1000]
    return args


class HeadlessUI:
    """The AgentUI seam, realized as NDJSON events + blocking request round-trips."""

    # The editor routes a typed `/todo clear` to `clear_todos` (and has Clear on its Tasks row), so
    # text that tells the user how to drop a checklist may name the command here too.
    todo_clear_hint = "/todo clear"

    def __init__(self, emitter: Emitter, pending: PendingRequests,
                 approval_timeout_s: float = 300.0):
        self.em = emitter
        self.pending = pending
        self.approval_timeout_s = max(0.01, float(approval_timeout_s))
        self.question_forms = False  # opted in by the editor handshake; strict older v6 clients remain valid
        self.cancelled = None
        self._rule_hook = None          # set by Backend to persist an allow rule
        self._rule_override: dict = {}   # tool -> explicit rule string the IDE dictated
        self.plan_feedback = ""         # one-shot feedback consumed by Agent after rejection
        self.deny_reason = ""           # the editor's note on a denial, consumed by Agent
        self.preview_root = None        # project root for edit previews on approval cards
        # Per-turn prose identity. The panel must not have to guess which block was the answer,
        # so every prose block that actually streamed gets an id and the turn carries the id it
        # designates. Backend sets ``turn_id`` and calls ``reset_turn_messages()`` at turn_start.
        self.turn_id = ""
        self._message_n = 0
        self._stream_open = False       # text arrived since the last end_stream
        self._answer_message_id = None  # last stream_end whose phase was "answer"
        self._unphased_message_id = None  # last stream_end that stated no phase (compat path)
        self._activity_key = None       # (state, label, detail) of the last emitted turn_activity
        self._model_wait_saved = None   # the activity a "no response from the model" notice replaced
        self._model_wait_key = None     # the notice on screen, while it is still the latest word
        self._model_waits = {}          # origin (None = the main agent, else a sub-agent) -> notice key

    def reset_turn_messages(self) -> None:
        """Start a new turn's prose numbering and forget the previous turn's designation."""
        self._message_n = 0
        self._stream_open = False
        self._answer_message_id = None
        self._unphased_message_id = None
        self._activity_key = None
        self._model_wait_saved = None
        self._model_wait_key = None
        self._model_waits = {}

    @property
    def final_message_id(self):
        """Which prose block this turn designates as its answer -- Codex's rule, exactly.

        The last block the loop called an answer wins. Failing that, and only because ``turn_end``
        is by construction terminal, the last block that stated no phase at all wins, so a seam
        that never passes a phase keeps working. Failing both, the turn had no answer to point at.
        """
        return self._answer_message_id or self._unphased_message_id

    # streaming ----------------------------------------------------------------
    def on_text(self, chunk: str) -> None:
        self.turn_activity("responding", "Responding")
        self._stream_open = True
        self.em.emit("text_delta", text=chunk)

    def on_thinking(self, chunk: str) -> None:
        self.turn_activity("thinking", "Thinking")
        self.em.emit("thinking_delta", text=chunk)

    def end_stream(self, phase: str = "") -> None:
        """Close a prose block, naming it and saying what the loop already knows about it.

        An id is minted only when prose actually streamed, so ``final_message_id`` can never
        designate a block the panel has no node for. A round that produced only tool calls closes
        an empty stream and is simply not a message.
        """
        fields: dict = {}
        if self._stream_open and self.turn_id:
            self._message_n += 1
            message_id = f"{self.turn_id}:{self._message_n}"
            fields["message_id"] = message_id
            if phase == "answer":
                self._answer_message_id = message_id
            elif not phase:
                self._unphased_message_id = message_id
        if phase in ("commentary", "answer"):
            fields["phase"] = phase
        self._stream_open = False
        self.em.emit("stream_end", **fields)

    def turn_activity(self, state: str, label: str, detail: str = "") -> None:
        """State what the turn is doing, once per change.

        The guard is load-bearing: ``on_text`` runs per streamed chunk, so without it a long
        answer would spend thousands of frames saying the same word. A changed tool target is a
        new step and does emit; churn inside an unchanged step does not.
        """
        if not self.turn_id:
            # Activity is a fact ABOUT a turn. Outside one -- a `-p --output-format json` run, a
            # compaction on resume -- there is no turn to describe, and a frame saying so would be
            # noise on a surface that never shows a verb.
            return
        key = (str(state), str(label)[:80], str(detail or "")[:120])
        if key == self._activity_key:
            return
        self._activity_key = key
        fields = {"turn_id": self.turn_id, "state": key[0], "label": key[1]}
        if key[2]:
            fields["detail"] = key[2]
        self.em.emit("turn_activity", **fields)

    def model_wait(self, label, detail: str = "", *, since=None, restore: bool = True,
                   origin=None) -> None:
        """A model request is silent (or being retried). Rides the v12 ``turn_activity`` event.

        ``label=None`` means that request is producing again (or ended). Each ``origin`` -- the
        main agent (None) or one sub-agent -- holds its own notice, so parallel children that stall
        together do not clear each other: when one resumes, the newest notice still outstanding is
        shown again. When none is left, the activity the first notice replaced comes back, but only
        with ``restore`` and only if nothing newer (text, a tool) has already said what the turn
        is doing. ``restore=False`` is a call that ended in an error, a cancel or a stall.
        """
        waits = self.__dict__.setdefault("_model_waits", {})
        if label:
            key = ("waiting", str(label)[:80], str(detail or "")[:120])
            if not waits:
                self._model_wait_saved = self._activity_key
            waits.pop(origin, None)
            waits[origin] = key
            self.turn_activity(*key)
            self._model_wait_key = key
            return
        if origin not in waits:
            return
        waits.pop(origin, None)
        showing = self._model_wait_key is not None and self._activity_key == self._model_wait_key
        remaining = list(waits.values())
        if remaining:
            if showing:
                self.turn_activity(*remaining[-1])
                self._model_wait_key = remaining[-1]
            return
        saved, self._model_wait_saved, self._model_wait_key = self._model_wait_saved, None, None
        if restore and showing and saved:
            self.turn_activity(*saved)

    def steering_applied(self, request_id: str) -> None:
        hook = getattr(self, "_steering_hook", None)
        if hook:
            hook(request_id)

    # tools --------------------------------------------------------------------
    def tool_call(self, name: str, args: dict, call_id: str | None = None) -> None:
        summary = arg_summary(name, args)
        self.turn_activity("tool", activity_verb(name), summary)
        self.em.emit("tool_call", call_id=call_id, name=name, args=args,
                     summary=summary)

    def tool_progress(self, name: str, message: str, *, progress=None, total=None,
                      level: str = "", call_id: str | None = None) -> None:
        fields = {"call_id": call_id, "name": name, "message": str(message)[:500]}
        if isinstance(progress, (int, float)) and not isinstance(progress, bool):
            fields["progress"] = progress
        if isinstance(total, (int, float)) and not isinstance(total, bool):
            fields["total"] = total
        if level:
            fields["level"] = level
        self.em.emit("tool_progress", **fields)

    def tool_result(self, name: str, out: str, call_id: str | None = None) -> None:
        self.turn_activity("waiting", "Waiting for the model")
        is_diff, diff = split_diff(out)
        self.em.emit("tool_result", call_id=call_id, name=name, output=out,
                     is_error=tool_output_is_error(out), is_diff=is_diff, diff=diff)

    def tool_images(self, call_id: str | None, images: list, caption: str = "", *, items=None,
                    omitted: int = 0, meta=None) -> None:
        """Images a tool produced, for the panel to render inside the step that produced them.

        Sent in groups that fit one protocol frame, counting the metadata ``items`` too. A
        screenshot is capped at 4MB of PNG, which is about 5.6MB once base64 and JSON-escaped, and a
        step can return several -- so one event could exceed the frame ceiling. An image that alone
        does not fit becomes an empty slot: with its item (a stored image the panel can fetch by
        ref) it is ``""`` beside that item; without one it is its own ``images: []`` frame, which the
        panel shows as "Too large" instead of the event vanishing. ``meta`` is for Python front ends
        and never reaches the wire.
        """
        budget = int(MAX_EVENT_BYTES * 0.9)          # leave room for the envelope and escaping
        images = [str(image) for image in (images or [])]
        items = ([item if isinstance(item, dict) else {} for item in items]
                 if isinstance(items, list) and len(items) == len(images) else None)
        omitted = max(0, int(omitted or 0)) if isinstance(omitted, int) and not isinstance(omitted, bool) else 0
        overhead = len(json.dumps({"call_id": call_id, "caption": caption, "omitted": omitted,
                                   "items": [], "images": []}, ensure_ascii=False).encode("utf-8")) + 64
        frames: list = []
        batch: list = []
        batch_items: list = []
        used = overhead

        def flush() -> None:
            nonlocal batch, batch_items, used
            if batch:
                frames.append((batch, batch_items))
            batch, batch_items, used = [], [], overhead

        for index, image in enumerate(images):
            item = items[index] if items is not None else None
            item_cost = (len(json.dumps(item, ensure_ascii=False).encode("utf-8")) + 2
                         if item is not None else 0)
            cost = len(image.encode("utf-8")) + 8 + item_cost  # the quotes, comma and escaping slack
            if overhead + cost > budget:
                if item is None:
                    flush()
                    frames.append(([], []))                     # "Too large", never a vanished event
                    continue
                image, cost = "", item_cost + 8                 # fetched later through get_image
            if batch and used + cost > budget:
                flush()
            batch.append(image)
            batch_items.append(item)
            used += cost
        flush()
        if not frames and omitted:
            frames.append(([], []))
        for position, (frame_images, frame_items) in enumerate(frames):
            fields = {"call_id": call_id, "images": frame_images, "caption": caption}
            if items is not None:
                fields["items"] = frame_items
            if omitted and position == len(frames) - 1:
                fields["omitted"] = omitted
            self.em.emit("tool_images", **fields)

    def tool_denied(self, name: str, args: dict, reason: str,
                    call_id: str | None = None) -> None:
        self.turn_activity("waiting", "Waiting for the model")
        self.em.emit("tool_denied", call_id=call_id, name=name, args=args, reason=reason)

    def on_todo(self, todos: list) -> None:
        self.em.emit("todos", todos=todos)

    def hook_activity(self, event: str, status: str, *, configured: int = 0,
                      duration_ms: int = 0, message: str = "") -> None:
        if status == "started":
            self.turn_activity("hook", f"Running {event} hooks")
        self.em.emit("hook_activity", event=event, status=status,
                     configured=max(0, int(configured)),
                     duration_ms=max(0, int(duration_ms)), message=message or None)

    def artifact_ready(self, art) -> None:
        self.em.emit("artifact_ready", id=art.id, name=art.name, url=art.url, rel=art.rel)

    def goal_changed(self, goal: str, status: str) -> None:
        hook = getattr(self, "_goal_hook", None)
        if callable(hook):
            hook()
        else:
            self.em.emit("goal_changed", goal=goal, status=status)

    # notices ------------------------------------------------------------------
    def info(self, message: str) -> None:
        self.em.emit("info", message=message)

    def context_compacted(self, result: dict) -> None:
        """Carry the exact post-save compaction outcome instead of parsing a status sentence."""
        self.em.emit("compacted", **result)

    def error(self, message: str) -> None:
        self.em.emit("error", message=message)

    # blocking decisions -------------------------------------------------------
    def _await(self, rid: str, ev: threading.Event, cancel=None, recheck=None, *, human=False):
        # Reviewing a plan or deciding between options is not an abandoned network request.
        # Only an explicit reply, Stop, or disconnection ends a native human decision.
        deadline = None if human else time.monotonic() + self.approval_timeout_s
        cancel = cancel if cancel is not None else self.cancelled
        while not ev.wait(0.1 if deadline is None else min(0.1, max(0.0, deadline - time.monotonic()))):
            if cancel is not None and cancel.is_set():
                self.pending.value(rid)
                self.em.emit("request_expired", id=rid)
                return None
            if recheck is not None:
                decision = recheck()
                if decision in ("once", "no") and self.pending.resolve(rid, {"decision": decision}):
                    self.em.emit("permission_resolved", id=rid, decision=decision,
                                 message="Approved by the current permission mode" if decision == "once"
                                 else "Blocked by the current permission mode")
                    continue
            if deadline is not None and time.monotonic() >= deadline:
                self.pending.value(rid)  # discard it so a late response cannot affect another request
                self.em.emit("request_expired", id=rid)
                return None
        return self.pending.value(rid)

    def approve(self, name: str, args: dict, call_id: str | None = None) -> str:
        return self.approve_live(name, args, call_id)

    def approve_live(self, name: str, args: dict, call_id: str | None = None, *, recheck=None) -> str:
        rid, ev = self.pending.register()
        preview = edit_preview(name, args, self.preview_root) if self.preview_root else ""
        self.em.emit("permission_request", id=rid, call_id=call_id, name=name, args=args,
                     command=(args.get("command") if name in ("bash", "monitor") else None),
                     summary=arg_summary(name, args), diff=preview or None,
                     suggested_rule=str(rule_for(name, args)),
                     choices=["once", "always", "deny"])
        payload = self._await(rid, ev, recheck=recheck, human=True) or {}
        if payload.get("rule"):
            self._rule_override[name] = payload["rule"]
        decision = {"once": "once", "always": "always",
                    "deny": "no", "no": "no"}.get(payload.get("decision"), "no")
        # A denial can carry the user's note; the agent hands it to the model as the reason.
        self.deny_reason = str(payload.get("reason") or "")[:2000] if decision == "no" else ""
        return decision

    def add_permission_rule(self, name: str, args: dict) -> None:
        rule = self._rule_override.pop(name, None) or str(rule_for(name, args))
        if self._rule_hook:
            self._rule_hook(rule)
        self.em.emit("rule_added", rule=rule)

    def present_plan(self, plan: str):
        rid, ev = self.pending.register()
        self.em.emit("plan_proposal", id=rid, plan=plan,
                     choices=["auto", "acceptEdits", "default", "reject"])
        payload = self._await(rid, ev, human=True) or {}
        self.plan_feedback = str(payload.get("feedback") or "").strip()
        decision = payload.get("decision")
        if decision in _PLAN_MODES:
            self.plan_feedback = ""
        return decision if decision in _PLAN_MODES else None

    def propose_options(self, question: str, options: list) -> str:
        def valid(payload):
            choice = payload.get("choice") if isinstance(payload, dict) else None
            return ((type(choice) is int and 1 <= choice <= len(options))
                    or (isinstance(choice, str) and bool(choice.strip()) and len(choice) <= 4096))
        rid, ev = self.pending.register(validator=valid)
        self.em.emit("options_request", id=rid, question=question, options=options)
        payload = self._await(rid, ev, human=True) or {}
        choice = payload.get("choice")
        if type(choice) is int and 1 <= choice <= len(options):
            return options[choice - 1]
        if isinstance(choice, str) and choice.strip() and len(choice) <= 4096:
            return choice.strip()
        return ""

    def propose_questions(self, questions: list[dict]) -> dict | None:
        from .questions import valid_answers
        if not self.question_forms:
            answers = {}
            for q in questions:
                answer = self.propose_options(q["question"], q["options"])
                if not answer:
                    return None
                answers[q["id"]] = answer
            return answers
        rid, ev = self.pending.register(validator=lambda p: isinstance(p, dict)
                                         and valid_answers(questions, p.get("answers")))
        self.em.emit("options_request", id=rid, question=questions[0]["question"],
                     options=questions[0]["options"], questions=questions)
        payload = self._await(rid, ev, human=True) or {}
        answers = payload.get("answers")
        return answers if valid_answers(questions, answers) else None

    def mcp_capabilities(self) -> dict:
        return {"sampling": {}, "elicitation": {"form": {}, "url": {}}}

    def mcp_input(self, server: str, kind: str, payload: dict, *, cancel=None) -> dict:
        rid, ev = self.pending.register()
        self.em.emit("mcp_input_request", id=rid, server=str(server)[:120], kind=kind,
                     payload=payload)
        response = self._await(rid, ev, cancel=cancel)
        if not isinstance(response, dict):
            return {"action": "cancel"}
        return {"action": response.get("action", "cancel"),
                **({"content": response.get("content")}
                   if isinstance(response.get("content"), dict) else {})}


class Backend:
    def __init__(self, config: Config):
        from .trust import is_trusted
        self.workspace_trusted = is_trusted(config, config.project_root)
        if not self.workspace_trusted and config.mode in ("acceptEdits", "auto"):
            config.data["mode"] = "default"  # do not persist a downgrade of the user's global preference
        self.config = config
        self.em = Emitter(
            sys.stdout, validator=event_error,
            sanitizer=lambda event: redact_value(event, secret_values(self.config)))
        self.pending = PendingRequests()
        self.ui = HeadlessUI(self.em, self.pending,
                             float(config.get("approval_timeout_s", 300) or 300))
        self.ui.preview_root = config.project_root   # edit previews on approval cards
        self.agent = Agent(config, self.ui)
        self.ui.cancelled = self.agent.cancelled
        self.ui._goal_hook = self._emit_goal
        self.ui._rule_hook = self._add_rule
        self.ui._steering_hook = self._steering_applied
        self.agent.session_file = sessions_mod.new_path(config.project_root)
        self._worker: threading.Thread | None = None
        self._foreground_worker: threading.Thread | None = None
        self._turn_lock = threading.RLock()
        self._turn_n = 0
        # ordered (prompt, images, typed context[, kind[, request_id]]). The request id is kept so a
        # prompt that never ran can be handed back to the editor that sent it (see close()).
        self._queue: list[tuple] = []
        self._goal_auto_resumes = 0   # consecutive automatic goal restarts after a failed turn
        self._steer_payloads: dict[str, tuple] = {}
        self._model_list_lock = threading.Lock()
        # Background monitors. The flag is what exposes the `monitor` tool: only this backend (and
        # the TUI) can deliver events and start a turn on one. `dgc -p --output-format json` shares
        # HeadlessUI but never runs this constructor, so it never offers the tool.
        self._running_turn_kind = ""
        self._wake_yield = False
        self._wake_suppressed = 0
        self._wake_timer: threading.Timer | None = None
        self._monitors_timer: threading.Timer | None = None
        self._monitors_timer_lock = threading.Lock()
        self.agent.monitors.listener = self._on_monitor
        self.ui.monitor_wake_enabled = True

    def _add_rule(self, rule_text: str) -> None:
        try:
            Rule.parse(rule_text, "allow")  # validate before persisting
            self.config.permissions.setdefault("allow", []).append(rule_text)
            self.config.save()
        except Exception:
            pass

    def start(self) -> None:
        self.em.emit(
            "ready", version=__version__, protocol_version=PROTOCOL_VERSION,
            capabilities={"typed_editor_context": True, "multi_root": True, "usage": True,
                          "goal_state": True, "goal_runner": True, "saved_plan": True, "command_registry": True,
                          "provider_model_discovery": True, "headless_mcp_catalog": True,
                          "headless_mcp_call": True, "headless_skill_catalog": True,
                          "headless_feature_management": True,
                          "headless_handoff": True, "headless_hook_catalog": True,
                          "hook_activity": True, "correlated_state_requests": True,
                          "ultra_profile": True, "composer_selections": True, "skill_management": True,
                          "mcp_context": True, "mcp_management": True, "history_snapshot": True,
                          "goal_inputs": True, "workflows": True, "workspace_inspection": True, "chat_inspection": True,
                          "live_steering": True, "live_modes": True, "question_forms": True,
                          "resume_turn": True, "monitors": True, "usage_ledger": True,
                          "agents": True, "image_views": True, "model_retry": True,
                          "steering_native": not bool(self.config.get("subscription_engine", ""))},
            model=self.config.model, mode=self.agent.mode,
            think=self.config.get("thinking", "off"), base_url=self.config.base_url,
            ultra_mode=bool(self.config.get("ultra_mode", False)),
            subagent_base_url=self.config.get("subagent_base_url", ""),
            fallback_base_url=self.config.get("fallback_base_url", ""),
            project_root=str(self.config.project_root),
            workspace_trusted=self.workspace_trusted,
            session_id=self.agent.session_file.stem if self.agent.session_file else None,
            tools_supported=self.agent.client.tools_supported,
            provider=self.agent.client.family,
            provider_capabilities=self.agent.client.capability_snapshot(),
            tools=[t["function"]["name"] for t in TOOL_SCHEMAS],
            skills=[s.name for s in self.agent.skills.values()],
            commands=editor_command_metadata(),
            custom_commands=custom_command_names(self.config.project_root),
            goal=self._goal_snapshot(),
            session_name=str(self.agent.session_name or ""),
            context_size=self._context_window_size())
        for warning in getattr(self.config, "credential_warnings", ()):
            self.em.emit("info", message=str(warning)[:1000])
        self._emit_context()
        # Publish the complete route state immediately after the ready handshake. ``config``
        # carries both native and delegated settings so editors render the route that will run.
        self._emit_config()

    def _context_window_size(self) -> int:
        effective = getattr(self.agent, "context_size", None)
        if callable(effective):
            return int(effective())
        config_get = getattr(self.config, "get", None)
        if callable(config_get):
            return int(config_get("context_size", 32768))
        return int(getattr(self.config, "data", {}).get("context_size", 32768))

    def _await_idle(self, timeout: float) -> bool:
        """Wait for the turn worker to clear itself. Polling is correct here: the worker drops its
        own reference under the state lock, which is the only signal that it is safely done."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self._busy():
                return True
            time.sleep(0.05)
        return not self._busy()

    def _config_unchanged(self, key: str, value) -> bool:
        """True when a submitted setting already holds this value, so applying it is a no-op."""
        get = getattr(self.config, "get", None)
        current = (get(key, None) if callable(get)
                   else getattr(self.config, "data", {}).get(key))
        if isinstance(current, bool) or isinstance(value, bool):
            return bool(current) is bool(value)
        if isinstance(current, (int, float)) and isinstance(value, (int, float)):
            return float(current) == float(value)
        if current is None:
            return value in ("", None)
        return str(current) == str(value)

    def _busy(self) -> bool:
        lock = self._turn_state_lock()
        with lock:
            # The queue worker clears this reference atomically only after it has observed an
            # empty FIFO.  Do not use Thread.is_alive(): a prompt can otherwise arrive after the
            # worker's final queue check but before the thread has technically exited and become
            # stranded forever.
            return (getattr(self, "_worker", None) is not None
                    or getattr(self, "_foreground_worker", None) is not None)

    def _turn_state_lock(self) -> threading.RLock:
        """Return the queue lock (lazy only for small object.__new__ protocol fixtures)."""
        lock = getattr(self, "_turn_lock", None)
        if lock is None:
            lock = self._turn_lock = threading.RLock()
        return lock

    def _start_turn(self, text: str, images=None, context=None, *, delivery="queue",
                    request_id="", kind: str = "prompt") -> tuple[str, int]:
        """Start or queue one turn atomically; return (started|queued|full, pending count)."""
        if kind in ("prompt", "continue"):
            self._goal_auto_resumes = 0    # a person took the wheel; the retry budget starts over
        if kind in ("prompt", "continue", "resume"):
            hub = getattr(getattr(self, "agent", None), "monitors", None)
            if hub is not None:
                hub.policy.note_user_prompt()   # a person is here: wake-ups start counting again
        lock = self._turn_state_lock()
        with lock:
            if getattr(self, "_foreground_worker", None) is not None:
                return "busy", 0
            if (getattr(self, "_worker", None) is not None
                    and getattr(self, "_running_turn_kind", "") == "monitor"
                    and len(self._queue) < _MAX_QUEUED_TURNS):
                # A turn DGC started on a monitor event yields to the person: their message is
                # queued first, and the wake turn stops at its next boundary so it runs promptly.
                self._queue.append((text, images, context, kind, request_id or ""))
                self._wake_yield = True
                self.agent.cancelled.set()
                return "queued", len(self._queue)
            if getattr(self, "_worker", None) is not None:
                steers = getattr(self, "_steer_payloads", {})
                pending_bytes = sum(_turn_payload_bytes(*item[:3])
                                    for item in [*self._queue, *steers.values()])
                if (len(self._queue) + len(steers) >= _MAX_QUEUED_TURNS
                        or pending_bytes + _turn_payload_bytes(text, images, context)
                        > _MAX_QUEUED_TURN_BYTES):
                    return "full", len(self._queue)
                config = getattr(self, "config", getattr(self.agent, "config", None))
                config_get = getattr(config, "get", None)
                engine = config_get("subscription_engine", "") if callable(config_get) else ""
                if delivery == "steer" and not engine and not self.agent.cancelled.is_set():
                    import uuid
                    identity = request_id or str(uuid.uuid4())
                    if identity in steers:
                        return "duplicate", len(self._queue)
                    model_text = _format_editor_context(redact_value(context, secret_values(config))) + text
                    steers[identity] = (text, images, context)
                    self._steer_payloads = steers
                    if self.agent.steer(model_text, images=images, request_id=identity):
                        # Publish acceptance before the worker can acknowledge consumption.
                        self.em.emit("prompt_accepted", request_id=identity, state="steered")
                        return "steered", len(self._queue)
                    steers.pop(identity, None)
                self._queue.append((text, images, context, kind, request_id or ""))
                return "queued", len(self._queue)
            self._queue.append((text, images, context, kind, request_id or ""))
            worker = threading.Thread(target=self._run_turn_queue, daemon=True,
                                      name="dgc-headless-turns")
            self._worker = worker
            worker.start()
            return "started", 0

    def _steering_applied(self, request_id: str) -> None:
        with self._turn_state_lock():
            if getattr(self, "_steer_payloads", {}).pop(request_id, None) is not None:
                self.em.emit("steering_update", request_id=request_id, state="applied")

    def _finish_steering(self, cancelled: bool, failed: bool) -> None:
        take = getattr(self.agent, "take_deferred_inputs", None)
        if callable(take):
            take()
        retained = []
        with self._turn_state_lock():
            # The consumption acknowledgement removes applied inputs synchronously. Everything
            # left here is owned but unconsumed, including a failed context/skill preparation.
            pending = getattr(self, "_steer_payloads", {})
            for identity, payload in list(pending.items()):
                pending.pop(identity, None)
                if cancelled or failed:
                    self.em.emit("steering_update", request_id=identity, state="returned",
                                 message="This follow-up was not applied. Your message has been preserved.")
                else:
                    retained.append((*payload[:3], "prompt", identity))
                    self.em.emit("steering_update", request_id=identity, state="queued")
            self._queue[:0] = retained
            if retained:
                self.em.emit("queued", count=len(self._queue), text="")

    def _run_subscription_turn(self, engine_key: str, prompt: str) -> bool:
        """Delegate one editor turn while preserving the native headless event contract."""
        from . import subscriptions as subs
        engine = subs.get_engine(engine_key)
        if engine is None:
            self.ui.error(f"unknown subscription engine '{engine_key}'")
            return False
        try:
            result = subs.delegate_turn(self.config, self.agent, self.ui, engine, prompt)
        except subs.EngineError as exc:
            self.ui.error(str(exc))
            return False
        if result.get("timeout"):
            self.ui.error("the delegated turn hit the time budget and was stopped")
        elif result.get("error") and result.get("persisted", True):
            self.ui.error(str(result["error"]))
        elif result.get("rc") not in (0, None):
            self.ui.error(f"{engine.short_label} exited with status {result['rc']}")
        return bool(result.get("ok"))

    def _run_turn_queue(self) -> None:
        """Drain the prompt FIFO in one worker so completion and enqueue cannot race."""
        current = threading.current_thread()
        try:
            while True:
                lock = self._turn_state_lock()
                with lock:
                    # A backend on its way down starts nothing new: whatever is still queued stays
                    # queued, so close() can hand it back to the editor instead of this worker
                    # consuming it as an instant "stopped" turn nobody saw run.
                    if not self._queue or getattr(self.agent, "stopping", False) is True:
                        self._worker = None
                        retired = True
                    else:
                        retired = False
                if retired:
                    self._maybe_wake()
                    return
                with lock:
                    if not self._queue or getattr(self.agent, "stopping", False) is True:
                        continue
                    item = self._queue.pop(0)
                    text, images, context = item[0], item[1], item[2]
                    turn_kind = item[3] if len(item) > 3 else "prompt"
                    turn_request = item[4] if len(item) > 4 and isinstance(item[4], str) else ""
                    notification = None
                    if turn_kind == "monitor":
                        hub = self.agent.monitors
                        notification = (None if self._wake_blocked_locked()
                                        else hub.take_pending())
                        if notification is None:
                            hub.policy.abandon_wake()   # a wake that never ran does not count
                            continue            # nothing left to deliver, or waking is not allowed
                    self._running_turn_kind = turn_kind
                    self._wake_yield = False
                    self._turn_n += 1
                    tid = f"t{self._turn_n}"
                    # Clear only stale cancellation while dequeue is serialized. A concurrent
                    # cancel that wins this lock either removes this item first, or sets the Event
                    # after this clear; Agent must not clear it again at entry.
                    self.agent.cancelled.clear()

                self.agent._pending_images = images
                active_config = getattr(
                    self, "config", getattr(getattr(self, "agent", None), "config", None))
                safe_context = redact_value(context, secret_values(active_config))
                model_text = _format_editor_context(safe_context) + text
                from .workflows import display_prompt
                shown_prompt = display_prompt(text)
                name_session = getattr(self.agent, "name_session", None)
                if (turn_kind not in ("continue", "monitor")
                        and not getattr(self.agent, "session_name", None)
                        and callable(name_session)):
                    title = _prompt_thread_title(shown_prompt)
                    if title and name_session(title):
                        self.em.emit("session_named", name=title)
                # The prose identity of a turn belongs to the turn, so hand the UI the id it is
                # numbering against before the first event of that turn can be emitted.
                self.ui.turn_id = tid
                reset_messages = getattr(self.ui, "reset_turn_messages", None)
                if callable(reset_messages):
                    reset_messages()
                # The request id names WHICH queued message this is, so the panel drops that entry
                # from its restorable queue rather than guessing by position (a queued custom slash
                # command has no id and must not consume a user's queued prompt).
                self.em.emit("turn_start", turn_id=tid,
                             prompt=notification.label if notification is not None else shown_prompt,
                             kind=turn_kind,
                             **({"request_id": turn_request} if turn_request else {}))
                if notification is not None:
                    self._emit_monitor_events(notification, "wake", tid)
                eta_stop = self._start_eta_ticker(tid)
                failed = False
                try:
                    config_get = getattr(active_config, "get", None)
                    engine_key = str(
                        config_get("subscription_engine", "") if callable(config_get)
                        else getattr(active_config, "data", {}).get("subscription_engine", "")
                    ).strip().lower()
                    if notification is not None:
                        outcome = self.agent.run_monitor_turn(notification, reset_cancel=False)
                    elif engine_key and images:
                        self.agent._pending_images = None
                        self.ui.error(
                            "subscription CLI delegation does not yet support DGC image attachments")
                        outcome = False
                    else:
                        outcome = (self._run_subscription_turn(engine_key, model_text)
                                   if engine_key else
                                   self.agent.run_turn(model_text, reset_cancel=False))
                    failed = outcome is False
                except Exception as e:             # a model/endpoint failure must NOT kill the turn silently
                    failed = True                  # (unreachable base_url, model not pulled, HTTP error, …)
                    import traceback
                    detail = str(e).strip() or e.__class__.__name__
                    self.em.emit("error", message=f"Turn failed — {detail}")
                    active_config = getattr(
                        self, "config", getattr(getattr(self, "agent", None), "config", None))
                    sys.stderr.write(redact_value(
                        {"traceback": traceback.format_exc()},
                        secret_values(active_config))["traceback"])
                cancelled = self.agent.cancelled.is_set()
                eta_stop.set()
                hub = getattr(self.agent, "monitors", None)
                if hub is not None:
                    if turn_kind == "monitor":
                        with lock:
                            yielded, self._wake_yield = self._wake_yield, False
                        hub.policy.finish_wake(self.config, ok=not failed,
                                               cancelled=cancelled and not yielded, yielded=yielded)
                    else:
                        hub.policy.note_turn_end()
                self._finish_steering(cancelled, failed)
                try:
                    est = self.agent.estimate_tokens()
                except Exception:
                    est = 0
                # Decided BEFORE the worker can retire: enqueueing here means the idle check below
                # keeps this worker alive, and turn_end is still published before the resume's
                # turn_start. Doing it after would strand the follow-up with no worker to run it.
                if turn_kind != "monitor":
                    # A wake turn is not goal work: its success must not reset the retry budget and
                    # its failure must not queue a goal resume.
                    self._maybe_auto_resume_goal(failed, cancelled)
                with self._turn_state_lock():
                    self._running_turn_kind = ""
                    idle = not self._queue
                    if idle and self._worker is current:
                        self._worker = None
                    # A Clear pressed while this turn ran emptied the list but could not save it
                    # (this worker held the session). Save it before turn_end says the turn is over.
                    self._flush_unsaved_todo_clear()
                    # Release an idle worker before publishing its terminal event. Goal pause,
                    # delete, model changes and workspace updates may arrive immediately on that
                    # acknowledgement. Serialize publication with enqueue so a newer turn_start
                    # cannot overtake this turn_end or be consumed by the retiring worker.
                    # Which block was the answer is a fact the UI accumulated while the loop
                    # ran; the panel should never have to re-derive it from node position.
                    final_message_id = getattr(self.ui, "final_message_id", None)
                    if not isinstance(final_message_id, str):
                        final_message_id = None
                    self.em.emit("turn_end", turn_id=tid,
                                 reason="cancelled" if cancelled else ("error" if failed else "completed"),
                                 token_estimate=est, final_message_id=final_message_id)
                    self.ui.turn_id = ""        # nothing after this belongs to the finished turn
                    self._emit_context()
                if idle:
                    self._maybe_wake()
                    return
        finally:
            # A broken output stream or unexpected fixture/runtime exception must not leave the
            # backend permanently busy.  Retain any unstarted FIFO entries for the next submission.
            with self._turn_state_lock():
                self._running_turn_kind = ""
                if self._worker is current:
                    self._worker = None
                    self._flush_unsaved_todo_clear()

    # ---- background monitors ---------------------------------------------------------------------
    # Lock order: the turn-state lock may be held while calling into the hub (take_pending,
    # pending_count); the hub never calls this listener while holding its own locks.
    def _on_monitor(self, kind: str, payload: dict) -> None:
        """Monitor callbacks, from reader threads and the turn worker."""
        try:
            turn_id = getattr(self.ui, "turn_id", "")
            if kind == "started":
                self.em.emit("monitor_started", id=payload["id"], description=payload["description"],
                             command=payload["command"], persistent=bool(payload["persistent"]),
                             timeout_ms=int(payload["timeout_ms"]),
                             sandboxed=bool(payload.get("sandboxed")),
                             **({"turn_id": turn_id} if turn_id else {}))
                self._schedule_monitors_snapshot()
            elif kind == "ended":
                exit_code = payload.get("exit_code")
                hub = self.agent.monitors
                # A monitor of a conversation that new chat, clear, resume or rewind has replaced
                # ends after that command's acknowledgement; the new chat must not hear about it.
                # Checking and publishing inside current_epoch keeps the two atomic.
                with hub.current_epoch(payload.get("epoch", hub.epoch)) as current:
                    if current:
                        self.em.emit("monitor_ended", id=payload["id"],
                                     description=payload["description"], reason=payload["reason"],
                                     exit_code=exit_code if isinstance(exit_code, int) else None,
                                     events=int(payload.get("events") or 0),
                                     message=str(payload.get("message") or ""))
                self._schedule_monitors_snapshot()
            elif kind == "delivered":
                self._emit_monitor_events(payload["notification"], payload.get("delivery", "inline"),
                                          turn_id)
                self._schedule_monitors_snapshot()
            elif kind == "pending":
                self._schedule_monitors_snapshot()
                self._maybe_wake()
        except Exception:
            pass                               # a monitor callback must never break a reader thread

    def _emit_monitor_events(self, notification, delivery: str, turn_id: str = "") -> None:
        for batch in notification.batches:
            self.em.emit("monitor_event", id=batch.monitor_id, description=batch.description,
                         event_index=int(batch.event_index), lines=list(batch.lines),
                         omitted_lines=int(batch.omitted_lines), kind=batch.kind,
                         delivery=delivery, **({"turn_id": turn_id} if turn_id else {}))

    def _emit_monitors(self, request_id: str | None = None) -> None:
        hub = getattr(getattr(self, "agent", None), "monitors", None)
        if hub is None:
            return
        self.em.emit("monitors", items=hub.snapshot(), wake_paused=bool(hub.policy.paused),
                     pending_events=hub.pending_events(), **_request_fields(request_id))

    def _schedule_monitors_snapshot(self) -> None:
        """Coalesce bursts of monitor changes into one `monitors` event."""
        lock = getattr(self, "_monitors_timer_lock", None)
        if lock is None:
            return
        with lock:
            if self._monitors_timer is not None:
                return

            def fire():
                with lock:
                    self._monitors_timer = None
                try:
                    self._emit_monitors()
                except Exception:
                    pass
            timer = threading.Timer(0.25, fire)
            timer.daemon = True
            self._monitors_timer = timer
            timer.start()

    def _cancel_wake_timer_locked(self) -> None:
        timer, self._wake_timer = getattr(self, "_wake_timer", None), None
        if timer is not None:
            timer.cancel()

    def _wake_blocked_locked(self) -> bool:
        """A state in which no wake may start at all. Caller holds the turn-state lock."""
        agent = getattr(self, "agent", None)
        if (getattr(agent, "monitors", None) is None or getattr(self, "_wake_suppressed", 0)
                or getattr(agent, "stopping", False)):
            return True
        config = getattr(self, "config", getattr(agent, "config", None))
        get = getattr(config, "get", None)
        engine = get("subscription_engine", "") if callable(get) else ""
        # Plan mode is read-only and a delegated CLI owns its own turns: events wait for a prompt.
        return bool(str(engine or "").strip() or getattr(agent, "mode", "default") == "plan")

    def _wake_allowed_locked(self) -> float | None:
        """Seconds until a wake may start (0 = now), or None. Caller holds the turn-state lock."""
        if self._wake_blocked_locked() or self._busy() or getattr(self, "_queue", None):
            return None
        hub = self.agent.monitors
        if not hub.pending_count():
            return None
        return hub.policy.ready_in(getattr(self, "config", getattr(self.agent, "config", None)))

    def _maybe_wake(self) -> None:
        """Start a monitor turn on an idle backend, or arm a timer for when one may start."""
        agent = getattr(self, "agent", None)
        hub = getattr(agent, "monitors", None)
        if hub is None or not hasattr(self, "_queue") or not hub.pending_count():
            return
        lock = self._turn_state_lock()
        paused_now = False
        with lock:
            self._cancel_wake_timer_locked()
            delay = self._wake_allowed_locked()
            if delay is None:
                paused_now = hub.policy.paused and bool(hub.pending_count())
            elif delay > 0:
                timer = threading.Timer(delay + 0.02, self._maybe_wake)
                timer.daemon = True
                self._wake_timer = timer
                timer.start()
            else:
                hub.policy.begin_wake()
                self._queue.append(("", None, None, "monitor", ""))
                worker = threading.Thread(target=self._run_turn_queue, daemon=True,
                                          name="dgc-headless-turns")
                self._worker = worker
                worker.start()
        if paused_now:
            self._schedule_monitors_snapshot()

    def _suppress_wakes(self, on: bool) -> None:
        agent = getattr(self, "agent", None)
        hub = getattr(agent, "monitors", None)
        if hub is None:
            return
        with self._turn_state_lock():
            if on:
                self._wake_suppressed = getattr(self, "_wake_suppressed", 0) + 1
                self._cancel_wake_timer_locked()
                return
            self._wake_suppressed = max(0, getattr(self, "_wake_suppressed", 0) - 1)
        hub.policy.note_command(getattr(self, "config", getattr(agent, "config", None)))
        self._maybe_wake()

    def _yield_wake_turn(self) -> bool:
        """If only monitor wake work holds the backend, stop it and wait for it to finish.

        That is a wake turn that is running, or a wake the timer queued that the worker has not
        started yet (or both). The queued wake items are dropped -- they carry no events; the
        events stay pending in the hub and wake the session again later -- and a running wake turn
        is cancelled. Anything else in the queue or running (a prompt, a goal step, a foreground
        operation) is real work and is not preempted.
        """
        with self._turn_state_lock():
            if getattr(self, "_foreground_worker", None) is not None:
                return False
            running = getattr(self, "_running_turn_kind", "")
            queue = getattr(self, "_queue", [])
            queued_wakes = [item for item in queue if len(item) > 3 and item[3] == "monitor"]
            if len(queued_wakes) != len(queue) or running not in ("", "monitor"):
                return False
            # running == "" with nothing queued is a worker that is retiring: waiting is enough.
            if queued_wakes:
                queue[:] = [item for item in queue if not (len(item) > 3 and item[3] == "monitor")]
                hub = getattr(getattr(self, "agent", None), "monitors", None)
                if hub is not None:
                    for _ in queued_wakes:
                        hub.policy.abandon_wake()
            if running == "monitor":
                self._wake_yield = True
                self.agent.cancelled.set()
        return self._await_idle(_WAKE_YIELD_TIMEOUT)

    def _maybe_auto_resume_goal(self, failed: bool, cancelled: bool) -> bool:
        """Keep a standing goal running after a turn stops on its own.

        A goal is the instruction to work unattended, so a recoverable stop -- the loop guard
        above all -- must not silently end it and wait for someone to press Resume. The resume
        carries the failure text so the next attempt changes approach instead of repeating the
        call that failed, and consecutive resumes are capped: if changing approach twice does not
        help, a person needs to look rather than DGC burning the window retrying.
        """
        from .goals import AUTO_RESUME_MAX, auto_resume_prompt
        if cancelled:                      # the user stopped this turn; that decision stands
            self._goal_auto_resumes = 0
            return False
        if not failed:
            self._goal_auto_resumes = 0    # progress resets the budget
            return False
        if not (getattr(self.agent, "goal", "")
                and getattr(self.agent, "goal_status", "none") == "active"):
            return False
        used = getattr(self, "_goal_auto_resumes", 0)
        reason = str(getattr(self.agent, "_last_turn_error", "") or "")
        if used >= AUTO_RESUME_MAX:
            self.ui.error(
                f"the standing goal stopped {used + 1} times in a row and DGC has stopped "
                "retrying. Look at the last error, then resume the goal when it is addressed.")
            # Leaving it "active" was a lie the clock told: the goal card kept counting while
            # nothing was running and nothing was going to run. Blocked is what this actually is,
            # it stops the clock, and it carries the reason a person needs in the goal review.
            update = getattr(self.agent, "update_goal", None)
            if callable(update):
                try:
                    update("blocked", reason=reason or "DGC stopped retrying after repeated failures")
                except Exception:
                    pass
                else:
                    self._emit_goal()
            return False
        with self._turn_state_lock():
            if self._queue:                # real work is already waiting; it supersedes a retry
                return False
            self._goal_auto_resumes = used + 1
            self._queue.append((auto_resume_prompt(reason, checklist_cleared=self._checklist_cleared()),
                                None, None, "resume"))
        self.ui.info(
            f"the goal stopped — continuing it automatically "
            f"({used + 1} of {AUTO_RESUME_MAX})")
        return True

    def _checklist_cleared(self) -> bool:
        """Did the user clear the checklist recently enough that a resume must not cite it?"""
        in_force = getattr(getattr(self, "agent", None), "todo_clear_in_force", None)
        return bool(callable(in_force) and in_force() is True)

    def _flush_unsaved_todo_clear(self) -> None:
        """Save a checklist clear that landed while a worker owned the session.

        Called with the turn-state lock held, as the worker retires: a clear that arrives after the
        turn's own final save is still written, and no new turn can start between the two. Lock
        order is the turn-state lock, then the agent's persist locks, the same order start_goal
        uses (lock, then set_goal, which saves).
        """
        agent = getattr(self, "agent", None)
        if getattr(agent, "todo_clear_unsaved", False) is not True:
            return
        persist = getattr(agent, "_persist", None)
        if not callable(persist):
            return
        try:
            saved = persist()
        except Exception as exc:                  # never let a save take the worker down with it
            saved, detail = False, f"{exc.__class__.__name__}: {exc}"
        else:
            detail = getattr(agent, "_last_persist_error", "") or ""
        if not saved:
            self.em.emit("error", message=detail
                         or "todo list cleared, but the session could not be saved")

    def _start_foreground_worker(self, operation, *, label: str = "operation") -> bool:
        """Reserve a non-prompt foreground slot while stdin decisions/cancellation stay live."""
        lock = self._turn_state_lock()
        with lock:
            if (getattr(self, "_worker", None) is not None
                    or getattr(self, "_foreground_worker", None) is not None):
                return False
            self.agent.cancelled.clear()

            def run():
                current = threading.current_thread()
                terminal = None
                try:
                    terminal = operation()
                finally:
                    with self._turn_state_lock():
                        if self._foreground_worker is current:
                            self._foreground_worker = None
                        self._flush_unsaved_todo_clear()
                # A terminal event means the next foreground command is admissible. Emit it only
                # after releasing the slot, otherwise a fast controller can receive completion and
                # have its immediately following prompt rejected against a worker that is unwinding.
                if callable(terminal):
                    terminal()

            worker = threading.Thread(target=run, daemon=True,
                                      name=f"dgc-headless-{label[:32]}")
            self._foreground_worker = worker
            worker.start()
            return True

    def _list_mcp_tools(self, request_id: str, offset: int, limit: int):
        try:
            schemas = self.agent.mcp.tool_schemas()
            rows = []
            used = 2
            for schema in schemas[offset:offset + limit]:
                fn = schema.get("function") if isinstance(schema, dict) else {}
                fn = fn if isinstance(fn, dict) else {}
                parameters = Agent._mcp_parameter_summary(fn.get("parameters"))
                row = {"name": str(fn.get("name") or "")[:512],
                       "description": str(fn.get("description") or "")[:1000],
                       "parameters": parameters}
                encoded = json.dumps(row, ensure_ascii=False, separators=(",", ":"),
                                     allow_nan=False).encode("utf-8")
                if len(encoded) > 16 * 1024:
                    row["parameters"] = {
                        "type": parameters.get("type", "object"),
                        "required": parameters.get("required", []),
                        "property_names": list(parameters.get("properties", {})),
                    }
                    encoded = json.dumps(row, ensure_ascii=False, separators=(",", ":"),
                                         allow_nan=False).encode("utf-8")
                if rows and used + len(encoded) + 1 > _MAX_MCP_LIST_BYTES:
                    break
                rows.append(row)
                used += len(encoded) + 1
            statuses = getattr(self.agent.mcp, "status", lambda: [])()
            next_offset = offset + len(rows)
            payload = dict(request_id=request_id, servers=list(statuses)[:100], tools=rows,
                           total=len(schemas), offset=offset,
                           next_offset=(next_offset if next_offset < len(schemas) else None))
        except Exception as exc:
            payload = dict(request_id=request_id, servers=[], tools=[], total=0,
                           offset=offset, next_offset=None,
                           error=f"MCP catalog listing failed ({type(exc).__name__})")
        return lambda: self.em.emit("mcp_tools", **payload)

    def _call_mcp_tool(self, request_id: str, call_id: str,
                       name: str, arguments: dict):
        status = "completed"
        try:
            output = self.agent.execute_mcp_tool(name, arguments, call_id)
            low = str(output or "").lstrip().lower()
            if self.agent.cancelled.is_set():
                status = "cancelled"
            elif low.startswith(("permission denied", "the user denied", "blocked by")):
                status = "denied"
            elif tool_output_is_error(output):
                status = "error"
        except Exception as exc:
            output = f"error: MCP tool call failed ({type(exc).__name__})"
            status = "error"
        return lambda: self.em.emit(
            "mcp_call_complete", request_id=request_id, call_id=call_id,
            name=name, status=status, output=str(output))

    def _mcp_context_operation(self, command: dict):
        from .mcp_context import list_catalog
        server_name, kind = command["server"], command["kind"]
        fields = {"request_id": command["request_id"], "server": server_name, "kind": kind}
        listing = command["type"] == "list_mcp_context"
        event = "mcp_context_catalog" if listing else "mcp_context"
        fields.update({"items": []} if listing else {"identifier": command["identifier"], "text": "", "omitted": []})
        try:
            server = self.agent.mcp.servers.get(server_name)
            if server is None:
                raise ValueError("This MCP server is disconnected. Reconnect it before selecting context.")
            if listing:
                fields["items"] = list_catalog(server, kind, cancel=self.agent.cancelled)
            else:
                fields.update(self.agent.execute_mcp_context(server_name, kind, command["identifier"],
                    command.get("arguments", {}), "context-" + command["request_id"]))
        except (OSError, ValueError) as exc:
            fields["error"] = str(exc)
        except Exception as exc:
            fields["error"] = f"MCP context operation failed ({type(exc).__name__})"
        return lambda: self.em.emit(event, **fields)

    def _emit_skill_catalog(self, request_id: str) -> None:
        rows = skill_catalog(dict(self.agent.skills), self.config.project_root)
        self.em.emit("skill_catalog", request_id=request_id, items=rows, total=len(rows))

    def _emit_skill_detail(self, request_id: str, name: str) -> None:
        normalized = normalize_skill_name(name)
        skills = dict(self.agent.skills)
        skill = skills.get(normalized)
        metadata = {row["name"]: row
                    for row in skill_catalog(skills, self.config.project_root)}
        row = metadata.get(normalized, {})
        self.em.emit(
            "skill_detail", request_id=request_id, found=skill is not None,
            name=normalized, description=str(row.get("description") or ""),
            source=str(row.get("source") or "unknown"),
            markdown=(skill.render("") if skill is not None else ""))

    def _emit_docs(self, request_id: str) -> None:
        from .docs import catalog
        items = catalog()
        self.em.emit("docs_catalog", request_id=request_id, items=items, total=len(items))

    def _emit_usage(self, request_id: str, range_name: str) -> None:
        """Answer get_usage from the local ledger on a short-lived thread.

        An all-time aggregate over a busy year is a few hundred milliseconds of sqlite; the command
        reader must stay free for a Stop meanwhile. The report never contains prompt or reply text.
        """
        def run() -> None:
            from . import usage_ledger
            try:
                report = usage_ledger.report(range_name)
            except Exception as exc:        # a report is informational; say why and carry on
                report = usage_ledger.empty_report(range_name, error=f"{type(exc).__name__}: {exc}")
            self.em.emit("usage_report", request_id=request_id, **report)
        threading.Thread(target=run, name="dgc-usage-report", daemon=True).start()

    def _emit_doc(self, request_id: str, identifier: str) -> None:
        from .docs import find_id, slug
        entry = find_id(identifier)
        self.em.emit(
            "doc", request_id=request_id, found=entry is not None,
            id=slug(entry[0]) if entry else str(identifier)[:80],
            title=entry[0] if entry else "", description=entry[1] if entry else "",
            markdown=entry[2][:120_000] if entry else "")

    @staticmethod
    def _public_mcp_spec(spec) -> dict:
        return public_mcp_spec(spec)

    def _emit_mcp_servers(self, request_id: str, error: str | None = None) -> None:
        configured = self.config.get("mcp_servers", {}) or {}
        configured = configured if isinstance(configured, dict) else {}
        statuses = {str(row.get("name")): row for row in self.agent.mcp.status()
                    if isinstance(row, dict)}
        items = []
        disabled = self.config.get("disabled_mcp_servers", [])
        disabled = disabled if isinstance(disabled, list) else []
        for index, (raw_name, raw_spec) in enumerate(configured.items()):
            if index >= _MAX_MCP_SERVERS:
                break
            name = str(raw_name)[:128]
            status = statuses.pop(name, {})
            items.append({"name": name, **self._public_mcp_spec(raw_spec),
                          "enabled": name not in disabled,
                          "state": "disabled" if name in disabled else str(status.get("state") or "configured")[:32],
                          "tool_count": int(status.get("tool_count") or 0),
                          "protocol_version": str(status.get("protocol_version") or "")[:64],
                          "protocol_era": str(status.get("protocol_era") or "")[:32],
                          "error": str(status.get("error") or "")[:500]})
        for name, status in list(statuses.items())[:_MAX_MCP_SERVERS - len(items)]:
            items.append({"name": name[:128], **self._public_mcp_spec({}),
                          "state": str(status.get("state") or "failed")[:32],
                          "tool_count": int(status.get("tool_count") or 0),
                          "protocol_version": str(status.get("protocol_version") or "")[:64],
                          "protocol_era": str(status.get("protocol_era") or "")[:32],
                          "error": str(status.get("error") or "")[:500]})
        fields = {"error": str(error)[:500]} if error else {}
        self.em.emit("mcp_servers", request_id=request_id, items=items,
                     total=len(items), **fields)

    def _mcp_control(self, command: dict):
        from .mcp_management import set_server_enabled
        error = None
        try:
            name = command["name"]
            if not _MCP_NAME_RE.fullmatch(name) or name not in self.config.get("mcp_servers", {}):
                raise ValueError("Choose an existing MCP server")
            if command["type"] == "set_mcp_enabled":
                set_server_enabled(self.config, self.agent.mcp, name, command["enabled"], cancel=self.agent.cancelled,
                                   input_handler=self.agent._handle_mcp_input)
            else:
                runtime = self.config.mcp_runtime_servers()
                self.agent.mcp.reconnect(name, runtime[name], cancel=self.agent.cancelled,
                                         input_handler=self.agent._handle_mcp_input)
        except (OSError, ValueError) as exc:
            error = str(exc)
        except Exception as exc:
            error = f"MCP connection operation failed ({type(exc).__name__})"
        return lambda: self._emit_mcp_servers(command["request_id"], error)

    def _mcp_command(self, command: dict):
        import shlex
        from .mcp_management import manage_mcp
        fields = {"request_id": command["request_id"], "output": ""}
        try:
            arguments = command["arguments"]
            if len(arguments) > 32_000:
                raise ValueError("MCP command exceeds 32,000 characters")
            parts = shlex.split(arguments)
            result = manage_mcp(self.config, self.agent.mcp, arguments, agent=self.agent)
            if isinstance(result, dict):
                fields["context"] = result
            elif parts and parts[0] in ("resources", "templates", "prompts"):
                fields["catalog"] = {"server": parts[1], "kind": parts[0], "items": json.loads(result)}
            else:
                fields["output"] = result
        except (OSError, ValueError) as exc:
            fields["error"] = str(exc)
        except Exception as exc:
            fields["error"] = f"MCP command failed ({type(exc).__name__})"
        def terminal():
            self._emit_mcp_servers(command["request_id"])
            self.em.emit("mcp_command_result", **fields)
        return terminal

    def _upsert_mcp_server(self, request_id: str, name: str,
                           runtime_value, persisted_value, *, interactive: bool = False):
        def finish(error=None):
            terminal = lambda: self._emit_mcp_servers(request_id, error)
            return terminal if interactive else terminal()

        if not _MCP_NAME_RE.fullmatch(name):
            return finish("server name must use 1-64 letters, digits, ., _, or -")
        runtime, runtime_error = _mcp_spec(runtime_value, persisted=False)
        persisted, persisted_error = _mcp_spec(persisted_value, persisted=True)
        problem = runtime_error or persisted_error
        if not problem and runtime and persisted:
            if (any(runtime.get(key) != persisted.get(key)
                    for key in ("transport", "command", "env_names", "auth_env", "url", "log_level"))
                    or bool(runtime.get("defer_until_setup"))
                    != bool(persisted.get("defer_until_setup"))):
                problem = "runtime and persisted server identity do not match"
            runtime_args, persisted_args = runtime.get("args", []), persisted.get("args", [])
            extra = runtime_args[len(persisted_args):] if runtime_args[:len(persisted_args)] == persisted_args else None
            if extra not in ([], None):
                header_env = (re.fullmatch(
                    r"Authorization:\s*Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}",
                    extra[1], re.IGNORECASE) if len(extra) == 2 else None)
                if (persisted.get("transport") != "remote" or len(extra) != 2
                        or extra[0] != "--header" or header_env is None
                        or header_env.group(1) not in runtime.get("env", {})
                        or header_env.group(1) not in persisted.get("env_names", [])
                        or header_env.group(1) != persisted.get("auth_env")):
                    problem = "runtime arguments may only add one bounded remote Authorization header"
            elif extra is None:
                problem = "runtime arguments must preserve the persisted argument prefix"
        if problem or runtime is None or persisted is None:
            return finish(problem or "invalid MCP server specification")
        servers = dict(self.config.get("mcp_servers", {}) or {})
        if name not in servers and len(servers) >= _MAX_MCP_SERVERS:
            return finish(f"at most {_MAX_MCP_SERVERS} MCP servers are supported")
        if hasattr(self.config, "drop_mcp_secrets"):
            # An editor upsert may replace a SecretStorage value without changing the public
            # server identity.  Never let an older CLI-migrated value win on the next launch.
            self.config.drop_mcp_secrets(name)
        servers[name] = persisted
        self.config.set("mcp_servers", servers)
        secret_candidates = list(runtime.get("env", {}).values())
        existing = list(getattr(self.config, "_session_secret_values", ()))
        self.config._session_secret_values = tuple((existing + secret_candidates)[-256:])
        try:
            self.agent.mcp.connect_all({name: runtime},
                                      cancel=self.agent.cancelled if interactive else None,
                                      input_handler=self.agent._handle_mcp_input if interactive else None)
        except Exception as exc:
            return finish(f"MCP connection failed ({type(exc).__name__})")
        return finish()

    def _emit_permissions(self, request_id: str) -> None:
        items = [{"action": action, "rule": str(rule)[:1000]}
                 for action in ("deny", "ask", "allow")
                 for rule in list(self.config.permissions.get(action, []))[:256]]
        self.em.emit("permissions", request_id=request_id, items=items, total=len(items))

    def _emit_memory(self, request_id: str, message: str | None = None) -> None:
        from .memory import load_memories
        project, user = load_memories(
            self.config.project_root,
            sanitizer=lambda value: redact_value(value, secret_values(self.config)))
        fields = {"message": str(message)[:500]} if message else {}
        self.em.emit("memory", request_id=request_id, project=project, user=user, **fields)

    def _emit_hook_catalog(self, request_id: str) -> None:
        catalog = hook_catalog(self.config)
        self.em.emit("hook_catalog", request_id=request_id, **catalog)

    def _generate_handoff(self, request_id: str, save: bool):
        self.em.emit("handoff_started", request_id=request_id)
        try:
            markdown = self.agent.generate_handoff(save=save)
            error = str(getattr(self.agent, "_last_handoff_error", "") or "")[:500]
        except Exception as exc:
            error = f"handoff generation failed ({type(exc).__name__})"
            markdown = f"# Handoff\n\n({error})"
        path = None
        if error:
            status = "cancelled" if self.agent.cancelled.is_set() else "error"
        else:
            status = "completed"
            if save:
                saved = getattr(self.agent, "_last_handoff_path", None)
                if saved is None:
                    status = "error"
                    error = str(getattr(self.agent, "_last_handoff_error", "")
                                or "could not save the handoff")[:500]
                else:
                    try:
                        path = str(saved.relative_to(self.config.project_root))
                    except ValueError:
                        status = "error"
                        error = "the saved handoff escaped the project boundary"
                        path = None
        def terminal():
            self.em.emit("handoff", request_id=request_id, status=status,
                         markdown=str(markdown)[:64_000], path=path, error=error or None)
            self._emit_context()
        return terminal

    def close(self, grace_s: float = 0.0) -> str:
        """Stop foreground work and release pending controller decisions on backend exit.

        A turn in flight is given `grace_s` to reach its next safe boundary before it is cancelled
        outright: the tool that is running finishes, its result is appended, the session is
        persisted, and the turn ends itself. Losing a pipe then costs seconds of work instead of
        the whole turn — which is what it cost when the only shutdown we had was an immediate
        cancel. The wait is bounded because the next backend is already starting and must not find
        this session held. Returns a short word for the log: idle, landed, or cancelled.
        """
        inspection = getattr(self, "_editor_inspection", None)
        if inspection is not None:
            inspection.close()
        self.agent.stopping = True              # the process is going down, nobody pressed stop
        # Read busy BEFORE the grace decision: with grace_s == 0 (the editor asked us to stop) a
        # turn in flight was still being cancelled, and the log called it "idle" one line under its
        # own "turn running: yes".
        # A decision nobody can answer is not work in flight: with the pipe closed no approval can
        # arrive, so release them first rather than spending the whole grace window waiting.
        self.pending.cancel_all({"decision": "no", "choice": None, "action": "cancel"})
        busy = self._busy()
        outcome = "cancelled" if busy else "idle"
        if grace_s > 0 and busy:
            deadline = time.monotonic() + grace_s
            while time.monotonic() < deadline:
                if not self._busy():
                    outcome = "landed"
                    break
                time.sleep(0.1)
        with self._turn_state_lock():
            self.agent.cancelled.set()
            # A queued prompt was acknowledged as "queued", so the editor stopped holding it as a
            # draft. Dropping it silently lost the user's words; hand each one back by its id so
            # the editor can put it in the composer again. Best effort: the pipe may be gone.
            for item in self._queue:
                request_id = item[4] if len(item) > 4 else ""
                if not request_id:
                    continue
                try:
                    self.em.emit("steering_update", request_id=request_id, state="returned",
                                 message="DGC's backend stopped before this queued message ran; "
                                         "it is back in the composer.")
                except Exception:
                    break
            self._queue.clear()
            workers = [getattr(self, "_worker", None),
                       getattr(self, "_foreground_worker", None)]
        self.pending.cancel_all({"decision": "no", "choice": None, "action": "cancel"})
        for worker in workers:
            if isinstance(worker, threading.Thread) and worker is not threading.current_thread():
                worker.join(timeout=2)
        hub = getattr(self.agent, "monitors", None)
        if hub is not None:
            with self._turn_state_lock():
                self._wake_suppressed = getattr(self, "_wake_suppressed", 0) + 1
                self._cancel_wake_timer_locked()
            hub.shutdown("shutdown", wait=2.0)
        manager = getattr(self.agent, "mcp", None)
        if manager is not None:
            manager.stop_all()
        return outcome

    def _start_eta_ticker(self, turn_id: str) -> threading.Event:
        """Publish `turn_eta` while the estimate changes; a stopped event ends it before turn_end."""
        stop = threading.Event()
        agent = self.agent

        def tick() -> None:
            last_label, last_emit = "", 0.0
            while not stop.wait(1.5):
                try:
                    snapshot = agent.eta_snapshot()
                except Exception:
                    snapshot = None
                if snapshot is None or not snapshot.visible:
                    continue
                now = time.monotonic()
                if snapshot.label == last_label and now - last_emit < 15.0:
                    continue
                last_label, last_emit = snapshot.label, now
                try:
                    self.em.emit("turn_eta", turn_id=turn_id,
                                 elapsed_seconds=round(float(snapshot.elapsed), 1),
                                 remaining_low_seconds=round(float(snapshot.low), 1),
                                 remaining_high_seconds=round(float(snapshot.high), 1),
                                 confidence=round(float(snapshot.confidence), 3),
                                 label=snapshot.label, tasks_done=int(snapshot.tasks_done),
                                 tasks_total=int(snapshot.tasks_total))
                except Exception:
                    return
        threading.Thread(target=tick, name="dgc-eta", daemon=True).start()
        return stop

    def _emit_context(self, request_id: str | None = None) -> None:
        try:
            used = self.agent.estimate_tokens()
        except Exception:
            used = 0
        totals = getattr(self.agent, "usage_totals", {})
        size = self._context_window_size()
        try:
            threshold = float(self.config.get("compact_threshold", 0.85))
        except (AttributeError, TypeError, ValueError):
            threshold = 0.85
        if not math.isfinite(threshold) or threshold <= 0:
            threshold = 0.85
        self.em.emit("context", used=used, size=size,
                     compact_threshold=threshold, compact_at=max(0, int(size * threshold)),
                     input_tokens=int(totals.get("input_tokens", 0)),
                     output_tokens=int(totals.get("output_tokens", 0)),
                     cached_input_tokens=int(totals.get("cached_input_tokens", 0)),
                     reasoning_tokens=int(totals.get("reasoning_tokens", 0)),
                     requests=int(totals.get("requests", 0)), **_request_fields(request_id))

    def _emit_artifacts(self, request_id: str | None = None) -> None:
        from . import artifacts
        self.em.emit("artifacts", items=[{"id": a.id, "name": a.name, "url": a.url,
                                          "rel": a.rel, "uptime": a.uptime}
                                         for a in artifacts.registry()],
                     **_request_fields(request_id))

    def _emit_retained_tasks(self, request_id: str | None = None) -> None:
        tasks, errors = self.agent.retained_tasks()
        self.em.emit("retained_tasks", items=[task.as_dict() for task in tasks[:100]],
                     errors=errors, total=len(tasks), **_request_fields(request_id))

    def _emit_config(self, request_id: str | None = None) -> None:
        c = self.config
        from . import subscriptions as _subs
        self.em.emit("config", model=c.model, mode=self.agent.mode,
                     subscription_engine=str(c.get("subscription_engine", "")),
                     subscription_model=str(c.get("subscription_model", "")),
                     subscription_effort=str(c.get("subscription_effort", "")),
                     subscription_engines=_subs.status(),
                     think=c.get("thinking", "off"), base_url=c.base_url,
                     api_mode=c.get("api_mode", "auto"),
                     provider_state=c.get("provider_state", "stateless"),
                     prompt_cache=bool(c.get("prompt_cache", True)),
                     capability_cache_ttl_s=int(c.get("capability_cache_ttl_s", 300)),
                     provider_capabilities=(self.agent.client.capability_snapshot()
                                            if hasattr(getattr(self.agent, "client", None),
                                                       "capability_snapshot") else {}),
                     project_root=str(c.project_root), search=c.get("search_provider"),
                     subagent_model=c.get("subagent_model", ""),
                     subagent_base_url=c.get("subagent_base_url", ""),
                     subagent_api_mode=c.get("subagent_api_mode", ""),
                     subagent_api_key_set=bool(c.get("subagent_api_key", "")),
                     fallback_model=c.get("fallback_model", ""),
                     fallback_base_url=c.get("fallback_base_url", ""),
                     fallback_api_key_set=bool(c.get("fallback_api_key", "")),
                     fallback_api_mode=c.get("fallback_api_mode", ""),
                     context_size=c.get("context_size", 32768),
                     sandbox=bool(c.get("sandbox", False)),
                     sandbox_network=bool(c.get("sandbox_network", False)),
                     show_reasoning=bool(c.get("show_reasoning", True)),
                     preserve_thinking=bool(c.get("preserve_thinking", False)),
                     ultra_mode=bool(c.get("ultra_mode", False)),
                     code_action=bool(c.get("code_action", False)),
                     suggest=bool(c.get("suggest", True)),
                     plan_artifact=bool(c.get("plan_artifact", True)),
                     artifact_autostart=bool(c.get("artifact_autostart", True)),
                     artifact_in_plan=bool(c.get("artifact_in_plan", False)),
                     tool_profile=str(c.get("tool_profile", "adaptive")),
                     max_parallel_tasks=int(c.get("max_parallel_tasks", 4)),
                     monitor_wake=bool(c.get("monitor_wake", True)),
                     goal=self._goal_snapshot(),
                     **_request_fields(request_id))

    def _goal_elapsed_seconds(self) -> int:
        clock = getattr(self.agent, "goal_elapsed_seconds", None)
        if not callable(clock):
            return 0
        try:
            return max(0, int(clock()))
        except (TypeError, ValueError, OverflowError):
            return 0

    def _emit_goal(self, request_id: str | None = None) -> None:
        self.em.emit("goal_changed", goal=getattr(self.agent, "goal", ""),
                     status=getattr(self.agent, "goal_status", "none"),
                     elapsed_seconds=self._goal_elapsed_seconds(),
                     details=self._goal_snapshot(),
                     **_request_fields(request_id))

    def _goal_snapshot(self) -> dict:
        snapshot = getattr(self.agent, "goal_snapshot", None)
        return snapshot() if callable(snapshot) else {
            "text": getattr(self.agent, "goal", ""), "status": getattr(self.agent, "goal_status", "none"),
            "elapsed_seconds": self._goal_elapsed_seconds()}

    def _emit_history(self, request_id: str | None = None) -> None:
        """Replay the transcript together with the checklist that belongs to it.

        Every path that repopulates a panel -- resume, reload, rewind -- comes through here, so
        the list the editor shows is the one the completion gate enforces. A snapshot without it
        left the panel blank while the backend still reminded the model about the items.
        """
        todos = getattr(self.agent, "todos", None) or []
        self.em.emit("history", items=self._history(),
                     todos=redact_value(list(todos), secret_values(self.config)),
                     **_request_fields(request_id))

    def _history(self) -> list:
        """A replayable event log of the current conversation (for resuming in a UI).

        Restored history used to be a flat message projection with its own idea of what an answer
        was (``commentary = bool(tool_calls)``), which disagreed with the live path and rendered
        tool work as prose. This emits the SAME events a live turn emits, so the panel drives the
        same builders and a restored turn is a turn: one block, real tool cards, real diffs, and
        one designated answer. Turns are derived, not persisted -- a turn opens at every message
        the user actually sent and at every resume marker, which is exactly what the scaffolding
        filter below already identifies, so no session file has to change.
        """
        # 0.40 lanes keep their per-call replay state behind these hooks (see the marked sections at
        # the end of this class); each one is a no-op until its lane lands.
        self._history_begin_images()
        self._history_begin_reasoning()
        items: list = []
        calls: dict = {}                # saved tool_call id -> the name its result belongs to
        turn_n = 0
        turn: dict | None = None
        # Compaction rewrites the transcript as a user message carrying the summary followed by an
        # assistant message accepting it. That is how the model is given its own history back, but
        # it is not something the user said or the agent answered, and showing it as two chat
        # bubbles made a resumed goal look like it had restarted the conversation. Collapse the
        # pair into one marker the panel can show quietly, with the summary behind it.
        from .agent import _COMPACT_ACK, _COMPACT_PREFIX
        from .goals import RESUME_PROMPT
        from .workflows import display_prompt

        def close_turn() -> None:
            nonlocal turn
            if turn is None:
                return
            if calls:                       # tool calls still waiting for a result when the turn ended
                turn["interrupted"] = True
            # The turn reason is not persisted, but two things the file does support are whether
            # the turn produced an answer and whether its work finished: a call with no result, or
            # a result that says the session was interrupted, is a turn that did not complete —
            # however confident the prose above it sounded. Reporting "Worked" over either is the
            # same class of lie as calling a shutdown the user's own stop.
            finished = bool(turn["final"]) and not turn["interrupted"]
            finished = self._history_turn_finished(turn, finished)
            items.append({"type": "turn_end", "turn_id": turn["id"],
                          "reason": "completed" if finished else "cancelled",
                          "token_estimate": 0,
                          "final_message_id": turn["final"] if finished else None})
            turn = None

        def open_turn(prompt: str, kind: str) -> None:
            nonlocal turn, turn_n
            close_turn()
            turn_n += 1
            turn = {"id": f"h{turn_n}", "n": 0, "r": 0, "final": None, "interrupted": False}
            items.append({"type": "turn_start", "turn_id": turn["id"],
                          "prompt": prompt, "kind": kind})

        def ensure_turn() -> dict:
            if turn is None:
                open_turn("", "prompt")     # saved work with no prompt above it still belongs to a turn
            return turn

        from .workflows import notice_kind
        skip_next_ack = False
        for index, m in enumerate(self.agent.messages):
            # Before any `continue`: images anchored at or before this message join the open turn.
            items.extend(self._history_before_message(index, turn))
            role = m.get("role")
            content = m.get("content")
            if role == "system":
                continue
            # First, before any content test: a notice's text is command output and may contain
            # anything, including the markers below. It is a monitor turn or an event in a turn.
            if notice_kind(m) == "monitor":
                notice = m.get("_dgc_notice") or {}
                if notice.get("delivery") == "wake":
                    open_turn(str(notice.get("label") or "monitor events")[:200], "monitor")
                current = ensure_turn()
                for row in list(notice.get("items") or [])[:32]:
                    if not isinstance(row, dict):
                        continue
                    kind = row.get("kind") if row.get("kind") in ("output", "ended",
                                                                   "background_exit") else "output"
                    items.append({
                        "type": "monitor_event", "id": str(row.get("id") or "")[:64],
                        "description": str(row.get("description") or "")[:200],
                        "event_index": int(row.get("event_index") or 0)
                        if isinstance(row.get("event_index"), int) else 0,
                        "lines": [str(line)[:2000] for line in list(row.get("lines") or [])[:40]],
                        "omitted_lines": max(0, int(row.get("omitted_lines") or 0))
                        if isinstance(row.get("omitted_lines"), int) else 0,
                        "kind": kind,
                        "delivery": "wake" if notice.get("delivery") == "wake" else "inline",
                        "turn_id": current["id"]})
                continue
            # A model-stream recovery notice continues the turn it interrupted: it opens no turn.
            notice_items = self._history_notice_items(m, turn)
            if notice_items is not None:
                ensure_turn()
                items.extend(notice_items)
                continue
            # The resume instruction is written to the transcript as a user turn so the model
            # receives it, but the user did not type it. Live turns already render it as a marker
            # via turn_start kind=resume; replaying history has to say the same thing, or
            # reopening a resumed session shows a prompt nobody sent. It is also a turn boundary:
            # without it an unattended goal's whole run collapses into one enormous turn.
            if role == "user" and isinstance(content, str) and TURN_CONTINUE_MARKER in content:
                open_turn("Continued the interrupted turn", "continue")
                continue
            if role == "user" and isinstance(content, str) and _goal_scaffold(content):
                open_turn(_goal_scaffold(content), "resume")
                continue
            if role == "user" and isinstance(content, str) and content.startswith(_COMPACT_PREFIX):
                items.append({"role": "compaction",
                              "text": content[len(_COMPACT_PREFIX):].strip()[:20_000]})
                skip_next_ack = True
                continue
            if skip_next_ack:
                skip_next_ack = False
                if role == "assistant" and content == _COMPACT_ACK and not m.get("tool_calls"):
                    continue
            if role == "user":
                if isinstance(content, list):
                    text = display_prompt(_strip_editor_context(" ".join(p.get("text", "") for p in content
                                    if isinstance(p, dict) and p.get("type") == "text"))) + " 📷"
                else:
                    text = display_prompt(_strip_editor_context(str(content)))
                # Scaffolding the AGENT wrote into the transcript so the model would read it --
                # the standing-goal reminder (which embeds the whole objective), the open-todo
                # nudge, the reasoning-budget note. The user typed none of it, and replaying a
                # restored session as chat bubbles pasted their entire goal spec back at them as
                # though they had just sent it. It is also not a turn boundary: every one of these
                # is a gate continuing the SAME turn.
                # The text tool protocol's results message carries the question outcomes of that
                # round. Only a message that recorded one can open a turn for them.
                if text.startswith("<tool_results>") and m.get("_dgc_decision"):
                    items.extend(self._history_decisions_for_text_results(m, ensure_turn()))
                if text.startswith("<tool_results>") or text.startswith("<system-reminder>"):
                    continue
                if isinstance(content, str) and content.lstrip().startswith("<system-reminder>"):
                    continue
                open_turn(text, "prompt")
            elif role == "assistant":
                current = ensure_turn()
                text = str(content or "")
                text = self._history_display_text(m, text)
                tool_calls = list(m.get("tool_calls") or [])[:16]
                items.extend(self._history_reasoning_items(m, current, after_text=False))
                if text.strip():
                    # One delta per saved message: the panel's text path is the same, and a saved
                    # message has no chunk boundaries left to reproduce.
                    current["n"] += 1
                    message_id = f'{current["id"]}:{current["n"]}'
                    phase = "commentary" if tool_calls else "answer"
                    items.append({"type": "text_delta", "text": text})
                    items.append({"type": "stream_end", "message_id": message_id, "phase": phase})
                    if phase == "answer":
                        current["final"] = message_id
                items.extend(self._history_reasoning_items(m, current, after_text=True))
                for tc in tool_calls:
                    function = tc.get("function") or {}
                    name = str(function.get("name") or "tool")[:128]
                    args = _history_args(function.get("arguments"))
                    call_id = str(tc.get("id") or "") or None
                    items.append({"type": "tool_call", "call_id": call_id, "name": name,
                                  "args": args, "summary": arg_summary(name, args)})
                    if call_id:
                        calls[call_id] = name
            elif role == "tool":
                call_id = str(m.get("tool_call_id") or "")
                name = calls.pop(call_id, None)
                if name is None:        # a result whose call is no longer in the transcript
                    continue
                ensure_turn()
                output = str(content or "")
                output = output[:4000] + ("\n[Earlier tool output truncated]" if len(output) > 4000 else "")
                # Both of these are pure functions of the saved output string, so a reviewed patch
                # comes back as a diff card and a failed command comes back red, with no migration.
                is_diff, diff = split_diff(output)
                if "tool result unavailable after session interruption" in output:
                    turn["interrupted"] = True
                items.extend(self._history_before_tool_result(m, call_id, turn))
                items.append({"type": "tool_result", "call_id": call_id or None, "name": name,
                              "output": output, "is_error": tool_output_is_error(output),
                              "is_diff": is_diff, "diff": diff})
                items.extend(self._history_after_tool_result(m, call_id, turn))
        close_turn()
        self._history_finish_reasoning(items)
        self._history_finish_images(items)
        # A display projection must not break the editor's bounded NDJSON transport. Session/model
        # history remains intact; this limit applies only to the restored webview payload.
        retained, size = [], 0
        for item in reversed(items):
            for key in ("text", "prompt"):
                value = item.get(key)
                if isinstance(value, str) and len(value) > 50000:
                    item[key] = value[:50000] + "\n[Long saved message truncated for display]"
            cost = len(json.dumps(item, ensure_ascii=True))
            if retained and size + cost > 1_000_000:
                break
            retained.append(item)
            size += cost
        retained.reverse()
        # Never hand the panel a turn that begins in the middle. Trimming from the front is the
        # honest cut: the dropped fragments are the oldest, and the notice below says so.
        while retained and retained[0].get("type") in _MID_TURN_ITEMS:
            retained.pop(0)
        if len(retained) < len(items):
            retained.insert(0, {"role": "notice", "text": "Showing the most recent saved context. Earlier messages remain in the session file."})
        return retained

    def dispatch(self, cmd: dict) -> None:
        """Handle one command. A command that is not a pure read holds monitor wake-ups off while
        it is handled and for one wake delay after, so a wake never starts under a user action
        (new chat, resume, rewind, compact, settings) or right on top of it."""
        kind = cmd.get("type") if isinstance(cmd, dict) else None
        # A shutdown ends the loop by raising; nothing after it may arm a wake.
        quiet = kind not in _WAKE_NEUTRAL_COMMANDS and kind != "shutdown"
        if quiet:
            self._suppress_wakes(True)
        try:
            self._dispatch(cmd)
        finally:
            if quiet:
                self._suppress_wakes(False)

    def _dispatch(self, cmd: dict) -> None:
        problem = command_error(cmd)
        if problem:
            safe_command = redact_value(
                str(cmd.get("type") or ""), secret_values(getattr(self, "config", None)))
            self.em.emit("command_rejected", command=safe_command[:128],
                         reason="invalid_command", message=f"invalid command: {problem}")
            return
        t = cmd.get("type")
        request_id = None
        if t in _OPTIONALLY_CORRELATED_COMMANDS and "request_id" in cmd:
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return

        if self._busy() and t in _BUSY_MUTATIONS and not self._yield_wake_turn():
            self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                         message=f"'{t}' is unavailable while a turn is running; cancel or wait",
                         **_request_fields(request_id))
            return

        if t == "start_goal":
            # Validate and persist the whole prepared request while no other foreground work can
            # take the turn slot. A rejected selection must not replace the standing goal.
            with self._turn_state_lock():
                if self._busy():
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message="Finish or stop the current turn before starting a goal.",
                                 **_request_fields(request_id))
                    return
                text = cmd["text"].strip()
                inputs = {key: cmd[key] for key in ("skills", "templates", "images", "context") if key in cmd}
                if not text or not self.agent.set_goal(text, replace=True, token_budget=cmd.get("token_budget"), inputs=inputs):
                    self.em.emit("command_rejected", command=t, reason="invalid_goal",
                                 message=self.agent._last_persist_error or "Enter a goal objective.",
                                 **_request_fields(request_id))
                    return
                state, _ = self._start_turn(text)
                if state != "started":
                    self.agent.update_goal("paused", reason="The first turn could not start")
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message="The goal was saved as paused because its first turn could not start.",
                                 **_request_fields(request_id))
                    return
                self.em.emit("prompt_accepted", request_id=request_id, state=state)

        elif t in ("get_workspace_changes", "get_workspace_change", "get_chat_changes", "get_chat_change"):
            from .editor_changes import EditorChanges
            if getattr(self, "_editor_inspection", None) is None:
                self._editor_inspection = EditorChanges(self.config.project_root, self.em.emit)
                if hasattr(self, "_editor_inspection_roots"):
                    self._editor_inspection.set_roots(self._editor_inspection_roots)
            if t in ("get_chat_changes", "get_chat_change"):
                self._editor_inspection.request(dict(cmd), journal=self.agent.chat_changes,
                    session_id=self.agent.session_file.stem if self.agent.session_file else "")
            else:
                self._editor_inspection.request(dict(cmd))

        elif t == "prompt":
            text = str(cmd.get("text", ""))
            if len(text) > _MAX_PROMPT_CHARS:
                self.em.emit("command_rejected", command=t, reason="prompt_too_large",
                             message=f"prompt exceeds the {_MAX_PROMPT_CHARS}-character limit",
                             **_request_fields(request_id))
                return
            workflow = None
            if "workflow" in cmd:
                from .workflows import prepare_workflow
                try:
                    workflow = prepare_workflow(cmd["workflow"], text, self.agent)
                    if not workflow.prompt:
                        raise ValueError("Enter a task to plan, or use /plan to enter plan mode without sending a prompt.")
                    text = workflow.prompt
                    if len(text) > _MAX_PROMPT_CHARS:
                        raise ValueError("The prepared workflow exceeds the prompt size limit; shorten the request.")
                except ValueError as exc:
                    self.em.emit("command_rejected", command=t, reason="invalid_workflow",
                                 message=str(exc), **_request_fields(request_id))
                    return
            if "skills" in cmd or "templates" in cmd:
                from .composer import compose_prompt
                from .skills import discover_skills, explicit_skill_instructions, format_skill_instructions
                try:
                    # Discovery is a separate snapshot: do not mutate the active turn's catalog
                    # while preflighting a queued prompt. A deleted/disabled selection must be
                    # rejected before acknowledging the draft or changing workflow permissions.
                    catalog = discover_skills(self.config.project_root,
                                              disabled_names=self.config.get("disabled_skills", []))
                    text = compose_prompt(text, skills=cmd.get("skills"),
                                          templates=cmd.get("templates"), catalog=catalog,
                                          project_root=self.config.project_root)
                    context_size = getattr(self.agent, "context_size", None)
                    allowance = min(96_000, max(4_000, context_size() * 2)) if callable(context_size) else 96_000
                    format_skill_instructions(explicit_skill_instructions(catalog, text), allowance)
                except ValueError as exc:
                    self.em.emit("command_rejected", command=t, reason="invalid_selection",
                                 message=str(exc), **_request_fields(request_id))
                    return
            try:
                images = validate_image_data_uris(
                    cmd.get("images"), maximum_file_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES,
                    maximum_total_bytes=MAX_EDITOR_IMAGE_TOTAL_BYTES)
            except ValueError as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_images",
                             message=f"prompt images rejected: {exc}", **_request_fields(request_id))
                return
            if images and self.config.get("subscription_engine", ""):
                self.em.emit("command_rejected", command=t, reason="unsupported_images",
                             message="Subscription CLI delegation does not support DGC image attachments. Use a native vision model.",
                             **_request_fields(request_id))
                return
            context = cmd.get("context")            # typed editor resources; bounded in _start_turn
            if isinstance(context, list) and any(isinstance(item, dict) and item.get("type") == "mcp_context" for item in context):
                safe = redact_value(context, secret_values(self.config))
                formatted = _format_editor_context(safe)
                retained = json.loads(formatted.split("\n", 2)[1]) if formatted else []
                if any(not any(row.get("type") == "mcp_context" and row.get("server") == item.get("server")
                               and row.get("uri") == item.get("uri") and row.get("text") == item.get("text")
                               for row in retained) for item in safe
                       if isinstance(item, dict) and item.get("type") == "mcp_context"):
                    self.em.emit("command_rejected", command=t, reason="invalid_selection",
                                 message="The selected MCP context exceeds the attachment limit. Remove an attachment or choose a smaller resource.",
                                 **_request_fields(request_id))
                    return
            if text.startswith("/"):               # render a custom slash-command template
                parts = text[1:].split(None, 1)
                custom = discover_commands(self.config.project_root)
                if parts and parts[0] in custom:
                    text = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "",
                                          self.config.project_root) or text
            if workflow:
                from .workflows import activate_workflow
                with self._turn_state_lock():
                    if getattr(self, "_worker", None) or getattr(self, "_foreground_worker", None):
                        self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                     message="Wait for the current turn to finish before starting a plan, review, or project guide.",
                                     **_request_fields(request_id))
                        return
                    activate_workflow(workflow, self.agent)
                    self.em.emit("mode_changed", mode=self.agent.mode,
                                 workspace_trusted=self.workspace_trusted)
                    state, count = self._start_turn(text, images, context)
            else:
                # The request id travels with a queued prompt so close() can hand it back if the
                # backend stops before it runs; the delivery mode only when the editor chose one.
                state, count = self._start_turn(text, images, context,
                    **({"request_id": request_id} if request_id else {}),
                    **({"delivery": cmd["delivery"]} if "delivery" in cmd else {}))
            if request_id and state in ("started", "queued"):
                self.em.emit("prompt_accepted", request_id=request_id, state=state,
                             **({"message": "Queued for the next turn; this operation cannot accept live steering."}
                                if state == "queued" and cmd.get("delivery") == "steer" else {}))
            if state == "queued":
                self.em.emit("queued", count=count, text=text)
            elif state == "full":
                self.em.emit("command_rejected", command=t, reason="queue_full", count=count,
                             message=("follow-up queue reached its count or aggregate byte limit "
                                      f"({count} queued); cancel it or wait for a turn to finish"),
                             **_request_fields(request_id))
            elif state == "busy":
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a foreground operation is running; cancel or wait for it to finish",
                             **_request_fields(request_id))
            elif state == "duplicate":
                self.em.emit("command_rejected", command=t, reason="duplicate_request",
                             message="This follow-up is already awaiting delivery.", **_request_fields(request_id))

        elif t == "slash_command":
            text = str(cmd.get("text") or "").strip()
            parts = text[1:].split(None, 1) if text.startswith("/") else []
            custom = discover_commands(self.config.project_root)
            if not parts or parts[0] not in custom:
                self.em.emit("error", message=f"unknown command: {text or '/'}")
                return
            rendered = render_command(custom[parts[0]], parts[1] if len(parts) > 1 else "",
                                      self.config.project_root)
            if not rendered:
                self.em.emit("error", message=f"custom command /{parts[0]} is empty")
            else:
                state, count = self._start_turn(rendered)
                if state == "queued":
                    self.em.emit("queued", count=count, text=text)
                elif state == "full":
                    self.em.emit("command_rejected", command=t, reason="queue_full", count=count,
                                 message=(f"follow-up queue is full ({_MAX_QUEUED_TURNS}); "
                                          "cancel it or wait for a turn to finish"))
                elif state == "busy":
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message="a foreground operation is running; cancel or wait for it to finish")

        elif t == "list_mcp_tools":
            request_id = str(cmd.get("request_id") or "")
            offset = cmd.get("offset", 0)
            limit = cmd.get("limit", 50)
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            if offset < 0 or offset > 1_000_000 or limit < 1 or limit > _MAX_MCP_LIST_LIMIT:
                self.em.emit("command_rejected", command=t, reason="invalid_page",
                             message=(f"offset must be 0-1000000 and limit 1-"
                                      f"{_MAX_MCP_LIST_LIMIT}"))
                return
            if not self._start_foreground_worker(
                    lambda: self._list_mcp_tools(request_id, offset, limit), label="mcp-list"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a prompt or MCP operation is already running; cancel or wait")

        elif t == "call_mcp_tool":
            request_id = str(cmd.get("request_id") or "")
            name = str(cmd.get("name") or "")
            call_id = str(cmd.get("call_id") or f"mcp:{request_id}")
            arguments = cmd.get("arguments")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            if not call_id or len(call_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_call_id",
                             message="call_id must contain 1-128 characters")
                return
            if not name.startswith("mcp__") or len(name) > 512:
                self.em.emit("command_rejected", command=t, reason="invalid_mcp_route",
                             message="name must be an exact bounded mcp__server__tool route")
                return
            route_check = getattr(self.agent.mcp, "has_route", None)
            if not callable(route_check) or not route_check(name):
                self.em.emit("mcp_call_complete", request_id=request_id, call_id=call_id,
                             name=name, status="error",
                             output="error: route is not in the connected MCP tool catalog")
                return
            if _json_payload_bytes(arguments) > _MAX_MCP_ARGUMENT_BYTES:
                self.em.emit("command_rejected", command=t, reason="arguments_too_large",
                             message=("MCP arguments must be valid JSON within the "
                                      f"{_MAX_MCP_ARGUMENT_BYTES}-byte limit"))
                return
            if not self._start_foreground_worker(
                    lambda: self._call_mcp_tool(request_id, call_id, name, arguments),
                    label="mcp-call"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a prompt or MCP operation is already running; cancel or wait")

        elif t in ("list_mcp_context", "get_mcp_context"):
            if (len(cmd["server"]) > 128 or len(cmd["kind"]) > 32
                    or len(str(cmd.get("identifier", ""))) > 4096
                    or len(json.dumps(cmd.get("arguments", {}))) > 32_000):
                self.em.emit("command_rejected", command=t, reason="invalid_mcp_context",
                             message="MCP context selection exceeds its input limit", request_id=cmd["request_id"])
                return
            if not self._start_foreground_worker(lambda: self._mcp_context_operation(cmd), label="mcp-context"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="A turn or MCP operation is already running; cancel or wait", request_id=cmd["request_id"])

        elif t == "list_skills":
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            self._emit_skill_catalog(request_id)

        elif t == "get_skill":
            request_id = str(cmd.get("request_id") or "")
            self._emit_skill_detail(request_id, str(cmd.get("name") or ""))

        elif t == "reload_skills":
            request_id = str(cmd.get("request_id") or "")
            self.agent.skills = discover_skills(self.config.project_root,
                                                disabled_names=self.config.get("disabled_skills", []))
            if hasattr(getattr(self.agent, "ctx", None), "skills"):
                self.agent.ctx.skills = self.agent.skills
            self._emit_skill_catalog(request_id)

        elif t in ("create_skill", "install_skill"):
            from .skill_packages import create_skill, install_skill
            request_id = str(cmd.get("request_id") or "")
            try:
                scope = cmd.get("scope", "project")
                if t == "create_skill":
                    result = create_skill(self.config, cmd["name"], cmd.get("description", ""), scope)
                else:
                    result = install_skill(self.config, cmd["source"], scope,
                                           allow_external=cmd.get("allow_external", False))
                self.agent.reload_skills()
                self._emit_skill_catalog(request_id)
                self.em.emit("skill_package", request_id=request_id, name=result["name"],
                             path=result["path"], operation=t, files=result["files"])
            except (OSError, ValueError) as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_skill", request_id=request_id,
                             message=str(exc))

        elif t == "set_skill_enabled":
            from .skills import set_skill_enabled
            request_id = str(cmd.get("request_id") or "")
            try:
                updated = set_skill_enabled(self.config, str(cmd.get("name") or ""), cmd.get("enabled"))
                self.agent.skills.clear()
                self.agent.skills.update(updated)
                self._emit_skill_catalog(request_id)
            except ValueError as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_skill", request_id=request_id,
                             message=str(exc))

        elif t == "list_docs":
            self._emit_docs(str(cmd.get("request_id") or ""))

        elif t == "get_doc":
            self._emit_doc(str(cmd.get("request_id") or ""), str(cmd.get("id") or ""))

        elif t == "get_image":
            image_request = cmd.get("request_id")
            if not isinstance(image_request, str) or not 1 <= len(image_request) <= 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
            else:
                self._request_image(image_request, cmd.get("ref"))

        elif t == "get_usage":
            usage_request = str(cmd.get("request_id") or "")
            if not usage_request or len(usage_request) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
            else:
                self._emit_usage(usage_request, str(cmd["range"]))

        elif t == "list_mcp_servers":
            self._emit_mcp_servers(str(cmd.get("request_id") or ""))

        elif t == "mcp_command":
            if not self._start_foreground_worker(lambda: self._mcp_command(cmd), label="mcp-command"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress", request_id=cmd["request_id"],
                             message="A turn or MCP operation is already running; cancel or wait")

        elif t in ("set_mcp_enabled", "reconnect_mcp_server"):
            if not self._start_foreground_worker(lambda: self._mcp_control(cmd), label="mcp-connection"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress", request_id=cmd["request_id"],
                             message="A turn or MCP operation is already running; cancel or wait")

        elif t == "upsert_mcp_server":
            if cmd.get("interactive"):
                if not self._start_foreground_worker(lambda: self._upsert_mcp_server(
                        cmd["request_id"], cmd["name"], cmd["runtime"], cmd["persisted"],
                        interactive=True), label="mcp-connection"):
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 request_id=cmd["request_id"], message="A turn or MCP operation is already running")
            else:
                self._upsert_mcp_server(
                    str(cmd.get("request_id") or ""), str(cmd.get("name") or ""),
                    cmd.get("runtime"), cmd.get("persisted"))

        elif t == "remove_mcp_server":
            request_id = str(cmd.get("request_id") or "")
            name = str(cmd.get("name") or "")
            if not _MCP_NAME_RE.fullmatch(name):
                self._emit_mcp_servers(
                    request_id, "server name must use 1-64 letters, digits, ., _, or -")
                return
            servers = dict(self.config.get("mcp_servers", {}) or {})
            servers.pop(name, None)
            self.config.set("mcp_servers", servers)
            if hasattr(self.config, "drop_mcp_secrets"):
                self.config.drop_mcp_secrets(name)
            live = self.agent.mcp.servers.pop(name, None)
            self.agent.mcp.failures.pop(name, None)
            if live is not None:
                live.stop()
            self.agent.mcp._rebuild_routes()
            getattr(self.agent.mcp, "_runtime_specs", {}).pop(name, None)
            disabled = self.config.get("disabled_mcp_servers", [])
            if isinstance(disabled, list) and name in disabled:
                self.config.set("disabled_mcp_servers", [value for value in disabled if value != name])
            getattr(self.agent.mcp, "disabled_names", set()).discard(name)
            self._emit_mcp_servers(request_id)

        elif t == "reload_mcp_servers":
            request_id = str(cmd.get("request_id") or "")
            self.agent.mcp.stop_all()
            servers = (self.config.mcp_runtime_servers()
                       if hasattr(self.config, "mcp_runtime_servers")
                       else self.config.get("mcp_servers", {}))
            self.agent.mcp.connect_all(servers, startup=True)
            self._emit_mcp_servers(request_id)

        elif t == "list_permissions":
            self._emit_permissions(str(cmd.get("request_id") or ""))

        elif t in ("add_permission_rule", "remove_permission_rule"):
            request_id = str(cmd.get("request_id") or "")
            action, rule = str(cmd.get("action") or ""), str(cmd.get("rule") or "").strip()
            try:
                rendered = Rule.parse(rule, action).render()
            except ValueError as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_rule",
                             message=str(exc)[:500], request_id=request_id)
                return
            rules = self.config.permissions.setdefault(action, [])
            if t == "add_permission_rule" and rendered not in rules:
                rules.append(rendered)
            elif t == "remove_permission_rule":
                self.config.permissions[action] = [item for item in rules if item != rendered]
            self.config.save()
            self._emit_permissions(request_id)

        elif t == "get_memory":
            self._emit_memory(str(cmd.get("request_id") or ""))

        elif t == "add_memory":
            from .memory import add_memory
            request_id = str(cmd.get("request_id") or "")
            try:
                add_memory(str(cmd.get("text") or ""), self.config.project_root,
                           str(cmd.get("scope") or "project"), cancelled=self.agent.cancelled)
            except Exception as exc:
                self.em.emit("command_rejected", command=t, reason="memory_save_failed",
                             message=f"memory save failed ({type(exc).__name__}): {str(exc)[:300]}",
                             request_id=request_id)
                return
            self._emit_memory(request_id, f"Saved {cmd.get('scope')} memory")

        elif t == "list_hooks":
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            self._emit_hook_catalog(request_id)

        elif t == "generate_handoff":
            request_id = str(cmd.get("request_id") or "")
            if not request_id or len(request_id) > 128:
                self.em.emit("command_rejected", command=t, reason="invalid_request_id",
                             message="request_id must contain 1-128 characters")
                return
            if not self._start_foreground_worker(
                    lambda: self._generate_handoff(request_id, bool(cmd.get("save", False))),
                    label="handoff"):
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a prompt or foreground operation is already running; cancel or wait")

        elif t == "set_workspace_roots":
            from .workspace import is_within
            if "question_forms" in cmd:
                self.ui.question_forms = cmd["question_forms"]
            roots, visible = [], []
            for raw in cmd.get("roots", []) if isinstance(cmd.get("roots"), list) else []:
                try:
                    path = Path(str(raw)).resolve(strict=True)
                except (OSError, RuntimeError):
                    continue
                if path.is_dir():
                    if path not in visible:
                        visible.append(path)
                    if not is_within(path, self.config.project_root) and path not in roots:
                        roots.append(path)
            self.config.session_permissions = {
                "allow": [f"ExternalDirectory({path})" for path in roots[:32]], "ask": [], "deny": []}
            self._editor_inspection_roots = visible[:16]
            if getattr(self, "_editor_inspection", None) is not None:
                self._editor_inspection.set_roots(self._editor_inspection_roots)
            self.em.emit("workspace_roots", roots=[str(self.config.project_root), *map(str, roots[:32])],
                         **_request_fields(request_id))

        elif t == "permission_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "rule": cmd.get("rule"),
                                                 "reason": cmd.get("reason")})
        elif t == "plan_response":
            self.pending.resolve(cmd.get("id"), {"decision": cmd.get("decision"), "feedback": cmd.get("feedback")})
        elif t == "options_response":
            self.pending.resolve(cmd.get("id"), {"choice": cmd.get("choice"), "answers": cmd.get("answers")})
        elif t == "mcp_input_response":
            self.pending.resolve(cmd.get("id"), {"action": cmd.get("action"),
                                                  "content": cmd.get("content")})

        elif t in ("cancel", "interrupt"):
            with self._turn_state_lock():
                self.agent.cancelled.set()
                self._queue.clear()
            hub = getattr(self.agent, "monitors", None)
            if hub is not None and hub.pending_count():
                # Stop means stop: events keep arriving but no turn starts on them until the next
                # prompt (or /monitors wake on).
                hub.policy.pause("stopped")
                self._schedule_monitors_snapshot()
            expired = self.pending.cancel_all(
                {"decision": "no", "choice": None, "action": "cancel"})
            for rid in expired:
                self.em.emit("request_expired", id=rid)

        elif t == "set_mode":
            if self._busy() and cmd.get("live") is not True:
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="Update the extension to change modes during a turn.",
                             **_request_fields(request_id))
                return
            mode = cmd.get("mode", "default")
            config_get = getattr(self.config, "get", None)
            active_engine = str(
                config_get("subscription_engine", "") if callable(config_get)
                else getattr(self.config, "data", {}).get("subscription_engine", "")
            ).strip().lower()
            from . import subscriptions as _subscriptions
            try:
                _subscriptions.validate_engine_mode(active_engine, mode)
            except _subscriptions.EngineModeUnsupported as exc:
                self.em.emit("command_rejected", command=t, reason="unsupported_subscription_mode",
                             message=str(exc),
                             **_request_fields(request_id))
                return
            if mode in ("acceptEdits", "auto") and not self.workspace_trusted:
                if cmd.get("acknowledge_workspace_trust") is not True:
                    self.em.emit("command_rejected", command=t, reason="workspace_untrusted",
                                 message="review this workspace and explicitly acknowledge trust before enabling mutations",
                                 **_request_fields(request_id))
                    return
                from .trust import mark_trusted
                mark_trusted(self.config, self.config.project_root)
                self.workspace_trusted = True
            self.agent.set_mode(mode)
            self.em.emit("mode_changed", mode=self.agent.mode,
                         workspace_trusted=self.workspace_trusted,
                         **({"message": "The new mode applies when the next subscription turn starts; the running external CLI keeps its launch permissions."}
                            if active_engine and self._busy() else {}),
                         **_request_fields(request_id))
        elif t == "set_model":
            config_get = getattr(self.config, "get", None)
            active_engine = str(
                config_get("subscription_engine", "") if callable(config_get)
                else getattr(self.config, "data", {}).get("subscription_engine", "")
            ).strip().lower()
            route = str(cmd.get("route") or "").strip().lower()
            if route not in ("", "native", "subscription"):
                self.em.emit("command_rejected", command=t, reason="invalid_route",
                             message="model route must be native or subscription",
                             **_request_fields(request_id))
                return
            # A model-only command means "the active chat route".  Meaningful connection fields
            # are an unambiguous native-provider operation (settings hydration and /connect).
            # Ignore old protocol clients' serialized no-op defaults (`base_url: ""` and
            # `clear_stored_api_key: false`) so they cannot silently retarget a delegated model.
            # Merely supplying api_key remains deliberate, including the empty string used to
            # clear a process-local editor credential.
            native_connection = (route == "native" or bool(cmd.get("base_url"))
                                 or "api_key" in cmd or cmd.get("clear_stored_api_key") is True)
            if route == "subscription" and not active_engine:
                self.em.emit("command_rejected", command=t, reason="route_unavailable",
                             message="no subscription engine is active",
                             **_request_fields(request_id))
                return
            if route == "subscription" and native_connection:
                self.em.emit("command_rejected", command=t, reason="route_conflict",
                             message="subscription model changes cannot include native connection fields",
                             **_request_fields(request_id))
                return
            if active_engine and "model" in cmd and not native_connection:
                model = str(cmd.get("model") or "").strip()
                if len(model) > 256 or any(ord(char) < 32 for char in model):
                    self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                                 message="subscription model must be a bounded plain string",
                                 **_request_fields(request_id))
                    return
                self.config.set("subscription_model", model)
                self.em.emit("model_changed", model=model, base_url=self.config.base_url,
                             **_request_fields(request_id))
                return
            if cmd.get("clear_stored_api_key"):
                # The editor owns its active credential in SecretStorage. When it explicitly
                # switches provider, erase any older CLI secret so a later CLI launch cannot
                # attach that credential to the newly persisted endpoint.
                self.config.data["api_key"] = ""
                if hasattr(self.config, "_stored_secrets"):
                    self.config._stored_secrets["api_key"] = ""
                if hasattr(self.config, "_stored_provider_identity"):
                    self.config._stored_provider_identity.pop("api_key", None)
                runtime_secret = getattr(self.config, "set_runtime_secret", None)
                if callable(runtime_secret):
                    runtime_secret("api_key", "")
                else:
                    self.config._env_secret_keys.add("api_key")
            if cmd.get("base_url"):
                self.config.set("base_url", cmd["base_url"])
            if "api_key" in cmd:
                # Editor credentials are owned by VS Code SecretStorage. Keep this process-local;
                # a later non-secret config save preserves any existing CLI secret instead of
                # duplicating the editor key into ~/.dgc/secrets.json.
                runtime_secret = getattr(self.config, "set_runtime_secret", None)
                if callable(runtime_secret):
                    runtime_secret("api_key", str(cmd.get("api_key") or ""))
                else:
                    self.config.data["api_key"] = str(cmd.get("api_key") or "")
                    self.config._env_secret_keys.add("api_key")
            if cmd.get("model"):
                self.config.set("model", cmd["model"])
            self.agent.refresh_client()
            recommend = getattr(self.agent, "recommended_context_size", None)
            ctx = (recommend() if cmd.get("model") and callable(recommend) else None)
            context_changed = False
            if ctx and ctx != int(self.config.get("context_size", 32768)):
                self.config.set("context_size", ctx)
                context_changed = True
            # While delegation is active, keep the public model control aligned with the route a
            # prompt will use even when a settings operation updates the native fallback.
            shown_model = (str(config_get("subscription_model", "")).strip()
                           if active_engine and callable(config_get) else self.config.model)
            self.em.emit("model_changed", model=shown_model, base_url=self.config.base_url,
                         **_request_fields(request_id))
            # A model refresh can change the provider-advertised effective limit even when the
            # configured recommendation happens to be identical. Never leave the editor meter on
            # the prior model's window.
            self._emit_context(request_id if context_changed else None)
        elif t == "list_models":
            request_id = redact_value(
                str(cmd.get("request_id") or ""), secret_values(self.config))[:128]
            lock = self._model_list_lock
            if not lock.acquire(blocking=False):
                self.em.emit("models", request_id=request_id, ids=[],
                             base_url=self.config.base_url,
                             error="model discovery is already in progress")
                return

            def discover_models():
                try:
                    # Use a separate adapter instance so discovery cannot mutate an active turn's
                    # transport state. It still shares bounded endpoint+model capability evidence.
                    client = self.agent._new_client(
                        self.config.base_url, self.config.api_key, self.config.model)
                    ids = [redact_value(item, secret_values(self.config))[:512]
                           for item in client.list_models()[:4096]
                           if isinstance(item, str)]
                    self.em.emit("models", request_id=request_id, ids=ids,
                                 base_url=self.config.base_url, api_mode=client.api_mode)
                except Exception as exc:
                    self.em.emit("models", request_id=request_id, ids=[],
                                 base_url=self.config.base_url,
                                 error=f"model discovery failed ({type(exc).__name__[:80]})")
                finally:
                    lock.release()
            threading.Thread(target=discover_models, daemon=True).start()
        elif t == "set_think":
            level = str(cmd.get("level", "off"))
            config_get = getattr(self.config, "get", None)
            active_engine = str(
                config_get("subscription_engine", "") if callable(config_get)
                else getattr(self.config, "data", {}).get("subscription_engine", "")
            ).strip().lower()
            if active_engine:
                from . import subscriptions as _subs
                engine = _subs.get_engine(active_engine)
                effort = "" if level == "off" else level
                if engine is None:
                    self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                                 message=f"unknown subscription engine '{active_engine}'",
                                 **_request_fields(request_id))
                    return
                if effort and not engine.supports_effort():
                    self.em.emit(
                        "command_rejected", command=t, reason="invalid_config_value",
                        message=f"{engine.short_label} does not expose a reasoning-effort flag; "
                                "choose its reasoning model with /model instead",
                        **_request_fields(request_id))
                    return
                self.config.set("subscription_effort", effort)
                self.em.emit("think_changed", think=effort or "off",
                             **_request_fields(request_id))
            else:
                if level == "max":
                    self.em.emit(
                        "command_rejected", command=t, reason="invalid_config_value",
                        message="max reasoning effort is available only on a supported subscription route",
                        **_request_fields(request_id))
                    return
                self.config.set("thinking", level)   # persisted native route
                self.em.emit("think_changed", think=self.config.get("thinking", "off"),
                             **_request_fields(request_id))
        elif t == "set_goal":
            status = str(cmd.get("status") or "active")
            text = str(cmd.get("text") or "")
            if status == "none":
                ok = self.agent.set_goal("")
            elif text:
                ok = self.agent.set_goal(
                    text, status, token_budget=cmd.get("token_budget"), replace=bool(cmd.get("replace")))
            else:
                ok = self.agent.update_goal(status)
            if not ok:
                message = getattr(self.agent, "_last_persist_error", "")
                self.em.emit("error", message=message or "no standing goal to update",
                             **_request_fields(request_id))
                return
            self._emit_goal(request_id)
        elif t == "get_goal":
            self._emit_goal(request_id)
        elif t == "get_plan":
            plan = (sessions_mod.load_plan(self.agent.session_file, self.config.project_root)
                    if self.agent.session_file else None)
            self.em.emit("saved_plan", plan=plan or "", exists=bool(plan),
                         **_request_fields(request_id))

        elif t == "resume_turn":
            # The editor's Continue card after a backend exit interrupted an ordinary turn.
            if not any(isinstance(m, dict) and m.get("role") == "user"
                       for m in (getattr(self.agent, "messages", None) or [])):
                self.em.emit("command_rejected", command=t, reason="nothing_to_continue",
                             message="this chat has no interrupted turn to continue",
                             **_request_fields(request_id))
                return
            state, count = self._start_turn(TURN_CONTINUE_PROMPT, delivery="queue",
                                            request_id=request_id or "", kind="continue")
            if request_id and state in ("started", "queued"):
                self.em.emit("prompt_accepted", request_id=request_id, state=state)
            if state == "queued":
                self.em.emit("queued", count=count, text="")
            elif state == "full":
                self.em.emit("command_rejected", command=t, reason="queue_full",
                             message="the turn queue is full", **_request_fields(request_id))
            elif state == "busy":
                self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                             message="a foreground operation is running; wait for it to finish",
                             **_request_fields(request_id))
        elif t == "resume_goal":
            if not self.agent.goal:
                self.em.emit("command_rejected", command=t, reason="no_goal",
                             message="no standing goal to resume", **_request_fields(request_id))
                return
            if not self.agent.update_goal("active"):
                self.em.emit("command_rejected", command=t, reason="rejected",
                             message=getattr(self.agent, "_last_persist_error", "")
                                     or "the standing goal could not be resumed",
                             **_request_fields(request_id))
                return
            self._emit_goal(request_id)
            from .goals import resume_prompt
            state, count = self._start_turn(resume_prompt(checklist_cleared=self._checklist_cleared()),
                                            delivery="queue", request_id=request_id, kind="resume")
            if state == "full":
                self.em.emit("command_rejected", command=t, reason="queue_full",
                             message="the turn queue is full", **_request_fields(request_id))
            elif state == "queued":
                self.em.emit("queued", count=count, text="")
        elif t == "new_session":
            if self._busy():
                # Stop the run and wait for the worker to observe it. Resetting under a live
                # worker would let the old turn write into the new session.
                with self._turn_state_lock():
                    self.agent.cancelled.set()
                    self._queue.clear()
                for rid in self.pending.cancel_all(
                        {"decision": "no", "choice": None, "action": "cancel"}):
                    self.em.emit("request_expired", id=rid)
                if not self._await_idle(_NEW_SESSION_CANCEL_TIMEOUT):
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message="the running turn did not stop in time; try again",
                                 **_request_fields(request_id))
                    return
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(self.config.project_root)
            self.em.emit("session", kind="new", message_count=0,
                         session_id=self.agent.session_file.stem, name="",
                         **_request_fields(request_id))
            self._emit_context(request_id)
            self._emit_goal()
            self._emit_monitors()
        elif t == "fork_session":
            # "Branch from here" keeps the conversation and hands it a new identity, so the
            # chat it came from stops where the branch began instead of being overwritten.
            if not self.agent.fork_session(str(cmd.get("name") or "")):
                self.em.emit("command_rejected", command=t, reason="session_fork_failed",
                             message=getattr(self.agent, "_last_persist_error", "")
                             or "the branch could not be saved",
                             **_request_fields(request_id))
                return
            self.em.emit("session", kind="forked",
                         message_count=max(0, len(self.agent.messages) - 1),
                         session_id=self.agent.session_file.stem,
                         name=str(self.agent.session_name or ""),
                         **_request_fields(request_id))
            self._emit_context(request_id)
            self._emit_goal()
        elif t == "name_session":
            name = str(cmd.get("name") or "").strip()[:200]
            if not name or not self.agent.name_session(name):
                self.em.emit("command_rejected", command=t, reason="session_name_failed",
                             message=getattr(self.agent, "_last_persist_error", "")
                             or "session name must not be empty",
                             **_request_fields(request_id))
                return
            self.em.emit("session_named", name=str(self.agent.session_name or ""),
                         **_request_fields(request_id))
        elif t == "clear_session":
            # Archive the prior persisted transcript and start an actually empty model context.
            # The old webview implementation only removed DOM nodes while the model retained every
            # prior turn, which made `/clear` misleading and potentially leaked stale context.
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(self.config.project_root)
            self.em.emit("session", kind="cleared", message_count=0,
                         session_id=self.agent.session_file.stem, name="",
                         **_request_fields(request_id))
            self.em.emit("history", items=[])
            self._emit_context()
            self._emit_goal()
            self._emit_monitors()
        elif t == "resume_session":
            path = cmd.get("path")
            if not path and cmd.get("latest"):
                p = sessions_mod.latest(self.config.project_root)
                path = str(p) if p else None
            if path:
                try:
                    n = self.agent.load_session(path)
                except (OSError, ValueError) as exc:
                    self.em.emit("command_rejected", command=t, reason="session_unavailable",
                                 message=redact_value(str(exc), secret_values(self.config)),
                                 **_request_fields(request_id))
                    return
                self.em.emit("session", kind="resumed", message_count=n, path=str(path),
                             session_id=Path(path).stem,
                             name=str(self.agent.session_name or ""),
                             **_request_fields(request_id))
                self._emit_history()
                self._emit_context()
                self._emit_goal()
                note = getattr(self.agent, "take_stale_monitor_note", lambda: "")()
                if note:
                    self.em.emit("info", message=note)
                self._emit_monitors()
            else:
                self.em.emit("error", message="no session to resume",
                             **_request_fields(request_id))
        elif t == "get_history":
            self._emit_history(cmd["request_id"])
        elif t == "clear_todos":
            # A list the model left behind, or a resumed session brought back, used to have no
            # exit short of a new chat: every later turn was reminded about it. Clear it through
            # the agent's own callback so the ETA estimator and every frontend see the same
            # empty list; the `todos` event is the acknowledgement. The clear is saved with the
            # session; when that save fails the list is still empty here, so say so rather than
            # reject a command that did take effect.
            with self._turn_state_lock():
                if self._busy():
                    # A running turn or foreground operation owns the session lease, so the save
                    # cannot happen here. Empty the list now (every frontend hears `todos []`) and
                    # let that worker save it as it retires (_flush_unsaved_todo_clear).
                    self.agent.clear_todos(persist=False)
                    return
                saved = self.agent.clear_todos()
            if not saved:
                self.em.emit("error", message=getattr(self.agent, "_last_persist_error", "")
                             or "todo list cleared, but the session could not be saved",
                             **_request_fields(request_id))

        elif t == "get_recall":
            # Compaction folds older turns into a summary and drops them from the live message
            # list, but DGC runs locally and keeps them beside the session. Page backwards through
            # that archive so the transcript can be scrolled past the summary marker.
            rows = sessions_mod.load_recall(self.agent.session_file, self.config.project_root) \
                if self.agent.session_file else []
            total = len(rows)
            try:
                limit = int(cmd.get("limit") or 50)
            except (TypeError, ValueError):
                limit = 50
            limit = max(1, min(limit, 200))
            try:
                before = int(cmd.get("before")) if cmd.get("before") is not None else total
            except (TypeError, ValueError):
                before = total
            before = max(0, min(before, total))
            start = max(0, before - limit)
            # The row clamp alone does not bound the FRAME: 200 rows x 20,000 characters is about
            # 4MB before JSON escaping, which is the protocol ceiling, and an over-ceiling frame is
            # shrunk to an empty page -- the user scrolls back and sees nothing. Fill the page
            # backwards from `before` until the next row would not fit, and report where it
            # actually stopped so the following page resumes exactly there.
            budget = int(MAX_EVENT_BYTES * 0.9)
            selected: list = []
            used = 0
            cursor = before
            while cursor > start:
                cursor -= 1
                row = rows[cursor]
                who = str(row.get("who") or "")
                body = str(row.get("body") or "")
                if not body.strip():
                    continue
                item = {
                    "role": "user" if who == "user" else "assistant",
                    "text": body[:20_000],
                    "tools": [t for t in str(row.get("tools") or "").split(",") if t][:16],
                    "archived": True,
                }
                cost = len(json.dumps(item, default=str, ensure_ascii=False).encode("utf-8")) + 2
                if selected and used + cost > budget:
                    cursor += 1          # this row belongs to the next page, not this one
                    break
                selected.append(item)
                used += cost
            items = list(reversed(selected))
            self.em.emit("recall", items=items, before=cursor, more=cursor > 0, total=total,
                         **_request_fields(request_id))

        elif t == "list_sessions":
            items = [{"path": str(p), "when": sessions_mod.when(ts), "preview": pv, "count": c,
                      "name": nm}
                     for (p, ts, pv, c, nm) in sessions_mod.listing(self.config.project_root)]
            self.em.emit("sessions", items=items, **_request_fields(request_id))
        elif t == "delete_session":
            path = cmd.get("path")
            ok = bool(path) and sessions_mod.delete(path, self.config.project_root)
            items = [{"path": str(p), "when": sessions_mod.when(ts), "preview": pv, "count": c,
                      "name": nm}
                     for (p, ts, pv, c, nm) in sessions_mod.listing(self.config.project_root)]
            self.em.emit("sessions", items=items, deleted=ok, **_request_fields(request_id))

        elif t == "list_checkpoints":
            items = [{"index": i, "preview": p, "files": nf}
                     for (i, p, nf) in self.agent.checkpoints.listing()]
            self.em.emit("checkpoints", items=items, **_request_fields(request_id))
        elif t == "rewind":
            msgs, nfiles = self.agent.rewind(int(cmd.get("index", -1)))
            ok = msgs >= 0
            self.em.emit("rewound", ok=ok, files_restored=nfiles,
                         **_request_fields(request_id))
            if ok:
                self._emit_history()
                self._emit_context()
        elif t == "list_retained_tasks":
            self._emit_retained_tasks(request_id)
        elif t == "resolve_retained_task":
            task_id = str(cmd.get("id", ""))
            action = str(cmd.get("action", ""))
            if action == "drop" and cmd.get("confirm") is not True:
                self.em.emit("error", message="dropping retained work requires explicit confirmation",
                             **_request_fields(request_id))
                self._emit_retained_tasks(request_id)
                return
            result = self.agent.resolve_retained_task(task_id, action)
            if result.status == "applied":
                warning = f" Cleanup warning: {result.cleanup_error}." if result.cleanup_error else ""
                self.em.emit("info", message=f"Applied retained task {task_id}: "
                             f"{len(result.paths)} path(s). Use rewind to undo.{warning}")
            elif result.status == "clean":
                warning = f" Cleanup warning: {result.cleanup_error}." if result.cleanup_error else ""
                self.em.emit("info", message=f"Retained task {task_id} had no remaining changes.{warning}")
            elif result.status == "dropped":
                self.em.emit("info", message=f"Dropped retained task {task_id}.")
            else:
                conflicts = (f" Conflicts: {', '.join(result.conflicts[:12])}."
                             if result.conflicts else "")
                self.em.emit("error", message=f"Could not {action} retained task {task_id}: "
                             f"{result.error or result.status}.{conflicts}")
            self._emit_retained_tasks(request_id)
        elif t == "compact":
            if not self.agent.maybe_compact(force=True, trigger="manual", notify=False):
                self.em.emit("command_rejected", command=t, reason="compaction_failed",
                             message=self.agent._last_persist_error
                             or "context compaction failed", **_request_fields(request_id))
                return
            self.em.emit("compacted", **self.agent.compaction_status(),
                         **_request_fields(request_id))
            self._emit_context(request_id)
        elif t == "list_monitors":
            self._emit_monitors(request_id)
        elif t == "stop_monitor":
            # Never blocks the command loop: the group is signalled here and reaped by its reader,
            # which reports monitor_ended when it is gone.
            hub = self.agent.monitors
            target = str(cmd.get("id") or "")
            if target == "all":
                hub.stop_all("stopped")
            elif not hub.stop(target, "stopped"):
                self.em.emit("info", message=f"no running monitor '{target[:64]}'")
            self._emit_monitors(request_id)
        elif t == "list_artifacts":
            self._emit_artifacts(request_id)
        elif t == "stop_artifact":
            from . import artifacts
            artifacts.stop(str(cmd.get("id", "")))
            self._emit_artifacts(request_id)
        elif t == "set_config":
            from .subscriptions import ENGINE_KEYS as _sub_keys
            if self._busy():
                # An editor saves the whole settings form, so ~25 keys ride along with the one the
                # user actually moved. Rejecting on key NAMES made every mid-turn save fail on an
                # untouched neighbour -- which is what made `context_size` unchangeable even after
                # it was declared live-safe. Only a value that would really move the route waits.
                unsafe = sorted(
                    key for key, value in dict(cmd.get("values") or {}).items()
                    if key not in _LIVE_SAFE_CONFIG_KEYS and not self._config_unchanged(key, value))
                if unsafe:
                    self.em.emit("command_rejected", command=t, reason="turn_in_progress",
                                 message=f"{unsafe[0]} cannot change while a turn is running; "
                                         "cancel or wait", **_request_fields(request_id))
                    return
            values, problem = _validated_config_values(cmd.get("values"), _sub_keys)
            if problem or values is None:
                self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                             message=problem or "invalid settings values",
                             **_request_fields(request_id))
                return
            config_get = getattr(self.config, "get", None)
            current_engine = (config_get("subscription_engine", "") if callable(config_get) else
                              getattr(self.config, "data", {}).get("subscription_engine", ""))
            selected_engine = str(values.get("subscription_engine", current_engine))
            from . import subscriptions as _subscriptions
            try:
                _subscriptions.validate_engine_mode(
                    selected_engine,
                    str(getattr(self.agent, "mode", None)
                        or (config_get("mode", "default") if callable(config_get) else "default")),
                )
            except _subscriptions.EngineModeUnsupported as exc:
                self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                             message=str(exc),
                             **_request_fields(request_id))
                return
            if selected_engine in ("qwen", "kimi") and values.get("subscription_effort"):
                self.em.emit("command_rejected", command=t, reason="invalid_config_value",
                             message=f"{selected_engine} does not expose a subscription effort flag",
                             **_request_fields(request_id))
                return
            previous_engine = str(current_engine)
            if "subscription_engine" in values and selected_engine != previous_engine:
                values.setdefault("subscription_model", "")
                values.setdefault("subscription_effort", "")
            if "subscription_engine" in values and not selected_engine:
                values["subscription_model"] = ""
                values["subscription_effort"] = ""
            if values.get("sandbox") is True:
                from . import sandbox
                if not sandbox.available():
                    self.em.emit(
                        "command_rejected", command=t, reason="sandbox_unavailable",
                        message="sandbox remains off because no supported confinement backend was found",
                        **_request_fields(request_id))
                    return
            secret_keys = ("subagent_api_key", "fallback_api_key")
            refresh = bool(set(values) & {
                "api_mode", "provider_state", "prompt_cache", "prompt_cache_key",
                "provider_capabilities", "capability_cache_ttl_s", "context_size",
            })
            # Config.set normally persists each key. Suspend that behavior while staging so another
            # process cannot observe half of a route change, then commit the complete validated
            # snapshot once. Endpoint invalidation still runs before process-local replacement keys.
            data_before = copy.deepcopy(self.config.data)
            attr_before = {
                attr: copy.deepcopy(getattr(self.config, attr))
                for attr in ("_stored_secrets", "_stored_provider_identity",
                             "_provider_secret_identity", "_env_secret_keys", "_explicit_keys")
                if hasattr(self.config, attr)
            }
            missing = object()
            client_before = getattr(self.agent, "client", missing)
            gate_before = getattr(self.agent, "autonomous_gate", missing)
            gate_max_before = getattr(self.agent, "autonomous_max_turns", missing)
            has_persist_flag = hasattr(self.config, "_persist")
            persist_before = getattr(self.config, "_persist", None)
            try:
                if has_persist_flag:
                    self.config._persist = False
                for key, value in values.items():
                    if key not in secret_keys:
                        self.config.set(key, value)
                if has_persist_flag:
                    self.config._persist = persist_before
                for key in secret_keys:
                    if key in values:
                        runtime_secret = getattr(self.config, "set_runtime_secret", None)
                        if callable(runtime_secret):
                            runtime_secret(key, values[key])
                        else:
                            self.config.data[key] = values[key]
                            self.config._env_secret_keys.add(key)
                save = getattr(self.config, "save", None)
                if callable(save):
                    save()
                if refresh:
                    self.agent.refresh_client()
                elif "ultra_mode" in values:
                    # Ultra changes the trusted system policy/tool exposure immediately without
                    # rebuilding the provider transport.
                    self.agent._refresh_system()
                # These settings are cached on the agent at construction; publish them only after
                # both the durable commit and any client rebuild have succeeded.
                if "autonomous_gate" in values:
                    self.agent.autonomous_gate = values["autonomous_gate"]
                if "autonomous_max_turns" in values:
                    self.agent.autonomous_max_turns = values["autonomous_max_turns"]
            except Exception as exc:
                if has_persist_flag:
                    self.config._persist = persist_before
                self.config.data = data_before
                for attr, snapshot in attr_before.items():
                    setattr(self.config, attr, snapshot)
                if client_before is not missing:
                    self.agent.client = client_before
                if gate_before is not missing:
                    self.agent.autonomous_gate = gate_before
                if gate_max_before is not missing:
                    self.agent.autonomous_max_turns = gate_max_before
                try:
                    save = getattr(self.config, "save", None)
                    if callable(save):
                        save()
                except Exception:
                    pass
                self.em.emit(
                    "command_rejected", command=t, reason="config_apply_failed",
                    message=f"settings were not applied ({type(exc).__name__})",
                    **_request_fields(request_id))
                return
            finally:
                if has_persist_flag:
                    self.config._persist = persist_before
            self._emit_config(request_id)
            if "context_size" in values:
                self._emit_context(request_id)
        elif t == "get_config":
            self._emit_config(request_id)
        elif t == "status":
            active_engine = str(self.config.get("subscription_engine", "") or "").strip()
            active_model = (str(self.config.get("subscription_model", "") or "").strip()
                            or f"{active_engine} default") if active_engine else self.config.model
            active_think = (str(self.config.get("subscription_effort", "") or "").strip()
                            or "off") if active_engine else self.config.get("thinking", "off")
            self.em.emit("status", model=active_model, mode=self.agent.mode,
                         think=active_think, base_url=self.config.base_url,
                         subscription_engine=active_engine,
                         ultra_mode=bool(self.config.get("ultra_mode", False)),
                         goal=self._goal_snapshot(),
                         context_used=self.agent.estimate_tokens(),
                         context_size=self._context_window_size(),
                         busy=self._busy() or bool(getattr(self, "_queue", None)),
                         **_request_fields(request_id))
        elif t == "shutdown":
            raise _Shutdown()
        else:
            self.em.emit("error", message=f"unknown command: {t!r}")

    # ================================================================================================
    # 0.40.0 lane sections. Each lane owns exactly one section below and fills in its own methods;
    # the foundation only placed the hooks `_history` calls, as no-ops that mutate nothing. Keep at
    # least one untouched line between sections so parallel lanes merge cleanly.
    # ================================================================================================

    # ---- 0.40 agents ------------------------------------------------------------------------------
    # (sub-agent registry listener, `agents` emission and the list_agents branch live here)
    # ---- end 0.40 agents --------------------------------------------------------------------------


    # ---- 0.40 images ------------------------------------------------------------------------------
    _IMAGE_WORKERS = 2          # get_image answers read, hash and base64 up to 8 MB off the reader
    _IMAGE_QUEUE = 16           # requests in flight or waiting; beyond this the answer is `busy`

    def _request_image(self, request_id: str, ref) -> None:
        """Answer one get_image with exactly one `image` event, served by a small pool so the command
        reader stays free for a Stop while bytes are read."""
        from .image_views import REF_RE
        if not isinstance(ref, str) or not REF_RE.match(ref):
            self.em.emit("image", request_id=request_id, ref=str(ref or "")[:64], image="",
                         reason="invalid_ref")
            return
        lock = self.__dict__.setdefault("_image_lock", threading.Lock())
        with lock:
            if self.__dict__.get("_image_requests", 0) >= self._IMAGE_QUEUE:
                busy = True
            else:
                busy = False
                self._image_requests = self.__dict__.get("_image_requests", 0) + 1
                pool = self.__dict__.get("_image_pool")
                if pool is None:
                    from concurrent.futures import ThreadPoolExecutor
                    pool = self._image_pool = ThreadPoolExecutor(
                        max_workers=self._IMAGE_WORKERS, thread_name_prefix="dgc-image")
        if busy:
            self.em.emit("image", request_id=request_id, ref=ref, image="", reason="busy")
            return
        try:
            pool.submit(self._serve_image, request_id, ref)
        except RuntimeError:                  # the pool is shutting down with the backend
            with lock:
                self._image_requests -= 1
            self.em.emit("image", request_id=request_id, ref=ref, image="", reason="busy")

    def _current_image_record(self, ref: str):
        return next((record for record in reversed(list(getattr(self.agent, "image_views", []) or []))
                     if getattr(record, "ref", None) == ref), None)

    def _serve_image(self, request_id: str, ref: str) -> None:
        from .image_views import resolve
        try:
            record = self._current_image_record(ref)
            session_file = getattr(self.agent, "session_file", None)
            if record is None or not session_file:
                self.em.emit("image", request_id=request_id, ref=ref, image="", reason="not_found")
                return
            data, reason, path = resolve(session_file, record)
            # The session may have changed while the file was read: never answer with bytes the
            # conversation now on screen did not view.
            if self._current_image_record(ref) is None or getattr(self.agent, "session_file", None) != session_file:
                self.em.emit("image", request_id=request_id, ref=ref, image="", reason="not_found")
                return
            shape = {"mime": record.mime, "width": record.width, "height": record.height}
            if data is None:
                extra = {**shape, "path": path} if reason == "too_large" and path else {}
                self.em.emit("image", request_id=request_id, ref=ref, image="", reason=reason, **extra)
                return
            import base64
            uri = f"data:{record.mime};base64,{base64.b64encode(data).decode('ascii')}"
            if len(uri) + 512 > int(MAX_EVENT_BYTES * 0.9):
                self.em.emit("image", request_id=request_id, ref=ref, image="", reason="too_large",
                             path=path, **shape)
                return
            self.em.emit("image", request_id=request_id, ref=ref, image=uri, path=path, **shape)
        except Exception:
            # Never exception text: it can carry a path or a provider's words. One reason, no detail.
            try:
                self.em.emit("image", request_id=request_id, ref=ref, image="", reason="unreadable")
            except Exception:
                pass
        finally:
            with self.__dict__.setdefault("_image_lock", threading.Lock()):
                self._image_requests = max(0, self.__dict__.get("_image_requests", 1) - 1)

    @staticmethod
    def _history_image_item(call_id, records: list) -> dict:
        return {"type": "tool_images", "call_id": call_id, "images": [""] * len(records),
                "caption": "", "items": [record.to_item() for record in records]}

    def _history_begin_images(self) -> None:
        """Reset per-call image replay state at the start of one `_history` projection. Everything a
        message loop needs is indexed once here, so replay stays linear in messages plus records."""
        from .agent import _COMPACT_PREFIX
        records = [record for record in list(getattr(getattr(self, "agent", None), "image_views", None) or [])
                   if hasattr(record, "to_item")]
        messages = list(getattr(getattr(self, "agent", None), "messages", None) or [])
        tool_calls: set = set()
        summary = None
        for position, message in enumerate(messages):
            if not isinstance(message, dict):
                continue
            if message.get("role") == "tool":
                tool_calls.add(str(message.get("tool_call_id") or ""))
            elif (summary is None and message.get("role") == "user"
                  and isinstance(message.get("content"), str)
                  and message["content"].startswith(_COMPACT_PREFIX)):
                summary = position
        folded, orphans, by_call = [], [], {}
        for position, record in enumerate(records):
            if getattr(record, "compacted", False):
                folded.append(position)
            elif str(record.call_id or "") in tool_calls:
                by_call.setdefault(str(record.call_id or ""), []).append(position)
            else:
                orphans.append(position)
        anchor = lambda position: records[position].anchor
        orphans.sort(key=anchor)                       # stable: equal anchors keep record order
        for positions in by_call.values():
            positions.sort(key=anchor)
        self._history_images = {
            "records": records, "done": set(), "index": -1, "summary": summary,
            "folded": folded, "orphans": orphans, "orphan_next": 0,
            "by_call": by_call, "call_next": {},
        }

    def _history_image_state(self) -> dict:
        state = getattr(self, "_history_images", None)
        if not isinstance(state, dict):
            self._history_begin_images()
            state = self._history_images
        return state

    def _history_before_message(self, index: int, turn: dict | None) -> list:
        """Image records anchored at or before message ``index`` whose call has no native tool
        message, as ``tool_images`` items with ``call_id: null``. ``turn`` is None when no turn is
        open; the records then wait for a later call or `_history_finish_images`. Images whose
        steps a compaction folded into its summary come back as one row just after the summary."""
        state = self._history_image_state()
        state["index"] = index
        items: list = []
        if state["folded"] and (state["summary"] is None or index > state["summary"]):
            folded, state["folded"] = state["folded"], []
            rows = self._history_orphans(state, folded)
            if turn is None:
                # The summary opens no turn: the row gets a quiet one of its own ("h0" never
                # collides, history turns count from h1).
                items.append({"type": "turn_start", "turn_id": "h0", "prompt": "", "kind": "prompt"})
                items.extend(rows)
                items.append({"type": "turn_end", "turn_id": "h0", "reason": "completed",
                              "token_estimate": 0, "final_message_id": None})
            else:
                items.extend(rows)
        if turn is None:
            return items
        orphans, start = state["orphans"], state["orphan_next"]
        end = start
        while end < len(orphans) and state["records"][orphans[end]].anchor <= index:
            end += 1
        state["orphan_next"] = end
        items.extend(self._history_orphans(state, orphans[start:end]))
        return items

    def _history_orphans(self, state: dict, positions: list) -> list:
        items = []
        positions = [position for position in positions if position not in state["done"]]
        for start in range(0, len(positions), 64):
            chunk = positions[start:start + 64]
            state["done"].update(chunk)
            items.append(self._history_image_item(None, [state["records"][p] for p in chunk]))
        return items

    def _history_after_tool_result(self, message: dict, call_id: str, turn: dict) -> list:
        """``tool_images`` items for the call whose ``tool_result`` was just replayed. A call id can
        repeat across turns: an image belongs to the first result at or after where it was recorded
        (compaction keeps anchors on the live numbering, so no leftover is guessed onto a result)."""
        state = self._history_image_state()
        call = str(call_id or "")
        positions = state["by_call"].get(call) if call else None
        if not positions:
            return []
        index = state["index"]
        start = state["call_next"].get(call, 0)
        end = start
        while end < len(positions) and state["records"][positions[end]].anchor <= index:
            end += 1
        state["call_next"][call] = end
        items = []
        due = [position for position in positions[start:end] if position not in state["done"]]
        for offset in range(0, len(due), 64):
            chunk = due[offset:offset + 64]
            state["done"].update(chunk)
            items.append(self._history_image_item(call, [state["records"][p] for p in chunk]))
        return items

    def _history_finish_images(self, items: list) -> None:
        """Place anchored image records still pending after the last turn closed."""
        state = self._history_image_state()
        left = [position for position in range(len(state["records"])) if position not in state["done"]]
        if not left:
            return
        orphans = self._history_orphans(state, left)
        last_end = next((i for i in range(len(items) - 1, -1, -1)
                         if isinstance(items[i], dict) and items[i].get("type") == "turn_end"), None)
        if last_end is not None:
            items[last_end:last_end] = orphans
            return
        turn_id = f"h{sum(1 for item in items if isinstance(item, dict) and item.get('type') == 'turn_start') + 1}"
        items.append({"type": "turn_start", "turn_id": turn_id, "prompt": "", "kind": "prompt"})
        items.extend(orphans)
        items.append({"type": "turn_end", "turn_id": turn_id, "reason": "completed",
                      "token_estimate": 0, "final_message_id": None})
    # ---- end 0.40 images --------------------------------------------------------------------------


    # ---- 0.40 reconnecting ------------------------------------------------------------------------
    def _history_notice_items(self, message: dict, turn: dict | None):
        """None when ``message`` is not a model-stream recovery notice; otherwise the
        ``model_retry`` items it replays as (possibly empty). A notice never opens a turn: the
        caller opens one only when none is open, then appends these items and moves on."""
        return None
    # ---- end 0.40 reconnecting --------------------------------------------------------------------


    # ---- 0.40 options -----------------------------------------------------------------------------
    def _history_decisions_for_text_results(self, message: dict, turn: dict) -> list:
        """``options_resolved`` items (``call_id: null``) for a text-protocol ``<tool_results>``
        message that recorded question outcomes in ``_dgc_decision``."""
        return []

    def _history_before_tool_result(self, message: dict, call_id: str, turn: dict) -> list:
        """The ``options_resolved`` item replayed just before a native tool result (may mark the
        turn, e.g. ``turn["options_dismissed"]``)."""
        return []

    def _history_turn_finished(self, turn: dict, finished: bool) -> bool:
        """Whether a replayed turn counts as finished; a dismissed question may end a turn."""
        return finished
    # ---- end 0.40 options -------------------------------------------------------------------------


    # ---- 0.40 thinking ----------------------------------------------------------------------------
    def _history_begin_reasoning(self) -> None:
        """Reset per-call reasoning replay state (budget, block counters)."""

    def _history_display_text(self, message: dict, text: str) -> str:
        """The assistant text as displayed (a thinking splice marker stripped)."""
        return text

    def _history_reasoning_items(self, message: dict, turn: dict, *, after_text: bool) -> list:
        """``thinking_delta``/``thinking_end`` items for the reasoning blocks saved on an assistant
        message, before (``after_text`` False) or after its text. Block ids use ``turn["r"]``."""
        return []

    def _history_finish_reasoning(self, items: list) -> None:
        """Apply the history reasoning budget across the whole payload, newest first."""
    # ---- end 0.40 thinking ------------------------------------------------------------------------


def _open_crash_log(config: Config):
    """A crash log the BACKEND owns, so a death is diagnosable without the editor's cooperation.

    An editor gets `dgc serve`'s stderr on a pipe and may do nothing with it -- DGC's own extension
    dropped every byte for months -- and an ACP or a third-party front-end owes us nothing at all.
    A backend that dies unattended has to leave its own evidence. faulthandler matters most here:
    a segfault or an abort inside a C extension produces NO Python traceback, which is exactly the
    shape of death that leaves nothing to go on.
    """
    import faulthandler
    try:
        root = Path(getattr(config, "user_root", "") or Path.home() / ".dgc") / "logs"
        root.mkdir(parents=True, exist_ok=True)
        path = root / "serve.log"
        try:                                   # bounded: never fill the user's disk
            if path.stat().st_size > 4 * 1024 * 1024:
                path.rename(root / "serve.log.1")
        except OSError:
            pass
        handle = path.open("a", encoding="utf-8", errors="replace")
        handle.write(f"\n=== dgc serve {__version__} pid {os.getpid()} started "
                     f"{time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        handle.flush()
        faulthandler.enable(file=handle, all_threads=True)
        _register_signal_dumps(handle)
        return handle
    except Exception:
        return None                            # logging must never stop the backend from serving


def _register_signal_dumps(handle) -> None:
    """Dump every thread's stack on SIGTERM/SIGHUP, then chain into whatever handler is installed.

    SIGTERM is how a parent asks us to stop, and it is also how a confused one kills us mid turn.
    Dumping every thread's stack at that moment says WHERE the backend was, which is the difference
    between "it exited" and a diagnosis. `chain=True` captures the handler installed RIGHT NOW as
    the one to run after the dump, and only on a signal faulthandler does not already own — so
    anything that claims the signal afterwards must call `_unregister_signal_dumps()` first and
    this again after, or the dump and the new handler silently replace each other.
    """
    import faulthandler
    for name in ("SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue                           # Windows has neither
        try:
            faulthandler.register(sig, file=handle, all_threads=True, chain=True)
        except Exception:
            pass                               # not every platform or thread context allows it


def _unregister_signal_dumps() -> None:
    """Release SIGTERM/SIGHUP so a new handler can be installed under a fresh dump registration."""
    import faulthandler
    for name in ("SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            faulthandler.unregister(sig)
        except Exception:
            pass


def _signal_name(signum: int) -> str:
    try:
        return signal.Signals(signum).name
    except ValueError:
        return f"signal {signum}"


def _parent_status(parent_pid: int) -> tuple[str, int]:
    """Say whether our original parent is really gone — confirmed, never inferred.

    Our stdin can hit EOF a beat before the kernel reparents us, so a getppid() read the instant
    the loop ends still returns the original pid for a parent that is already dead. Re-check for a
    quarter of a second and ask the OS directly with signal 0. Windows has neither a stable ppid to
    compare nor signal 0 to send, so there it answers "unknown" rather than guessing.
    """
    if os.name == "nt":
        return "unknown", parent_pid
    now_parent = parent_pid
    for _ in range(5):
        now_parent = os.getppid()
        if now_parent != parent_pid:
            return "gone", now_parent
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            return "gone", now_parent
        except OSError:
            break                              # it exists; it is simply not ours to signal
        time.sleep(0.05)
    return "alive", now_parent


def _log_crash(handle, label: str, exc: BaseException | None = None) -> None:
    if handle is None:
        return
    try:
        import traceback
        handle.write(f"[{time.strftime('%H:%M:%S')}] {label}\n")
        if exc is not None:
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=handle)
        handle.flush()
    except Exception:
        pass


# How long a turn gets to reach its next safe boundary when the editor's pipe closes under it.
# Long enough for a normal tool call to finish and the session to be written; short enough that
# the replacement backend, which the editor starts within a second or two, never waits on us.
SHUTDOWN_GRACE_S = 20.0


def _end_line(crash_log, line: str) -> None:
    """The loop's last word goes to serve.log AND stderr.

    The editor copies our stderr into its own backend.log, so the backend's account of why it
    stopped lands on the line next to the extension's "[dgc serve exited …]" instead of in a file
    nobody on that side reads.
    """
    _log_crash(crash_log, line)
    try:
        sys.stderr.write(f"[dgc serve] {line}\n")
        sys.stderr.flush()
    except Exception:
        pass


def serve(config: Config) -> None:
    """Run the headless backend: emit `ready`, then loop over stdin commands until EOF/shutdown."""
    # FIRST, before the crash log and before Backend(): MCP servers and code intelligence start
    # child processes during init, and none of them may inherit the command pipe.
    command_stream, pipe_note = _claim_command_pipe()
    crash_log = _open_crash_log(config)
    _log_crash(crash_log, pipe_note)
    pipe_watch = _PipeWatch(note=lambda text: _log_crash(crash_log, text))
    # A worker thread that dies takes its traceback with it unless someone is listening. The
    # turn worker is exactly such a thread, and a silent death there strands the turn.
    if crash_log is not None:
        def _thread_crash(args):
            _log_crash(crash_log, f"unhandled exception in thread {args.thread and args.thread.name}",
                       args.exc_value)
        threading.excepthook = _thread_crash
    backend = Backend(config)
    # Enough context to tell the three shutdowns apart in a log read days later: the editor asking
    # us to stop, the editor's host dying under us (our stdin closes and we are reparented), and a
    # live host closing the pipe anyway — which is a bug on that side, not ours.
    started_at = time.monotonic()
    parent_pid = os.getppid()
    _log_crash(crash_log, f"parent pid {parent_pid}")
    commands = 0
    last_command = ""
    shutdown_requested = False
    end_cause = "the serve loop raised"
    # A SIGTERM taken at its default disposition kills us between two bytecodes: the `finally`
    # below never runs, Backend.close() never runs, and a goal that was running is left claiming
    # it is still active. Handle the signal instead — tell the agent to stop, unwind the stdin
    # loop through the SAME finally as a closed pipe, and only then die of the signal we were
    # sent. (termbg owns the helper because restoring the terminal is the other half of this
    # problem; a headless backend has no terminal to restore, so it uses only the signal half.)
    from . import termbg
    stop_handlers: dict = {}
    stopped_by: dict = {}
    reading = {"stdin": True}

    def _on_stop(signum) -> None:
        termbg.restore_stop_handlers(stop_handlers)   # a second signal kills us outright
        stopped_by["signum"] = signum
        try:
            backend.agent.stopping = True             # the turn loop lands at its next boundary
        except Exception:
            pass
        if reading["stdin"]:
            # Blocked on the editor's pipe: only an exception gets us out of that read and into
            # the finally. Once the loop has ended we are already on our way there — let it run.
            raise _Terminated(signum)

    # faulthandler claimed these signals when the log opened, with SIG_DFL as its chain target.
    # Hand them back, install ours, then put the dump on top again: the stack dump still happens
    # first and now chains INTO us instead of into the kernel.
    _unregister_signal_dumps()
    stop_handlers.update(termbg.install_stop_handler(_on_stop))
    if crash_log is not None:
        _register_signal_dumps(crash_log)
    try:
        # Inside the try on purpose: start() is where the first model metadata and context
        # estimates happen, and a parent that gives up during it must still reach the finally.
        backend.start()
        for line, frame_problem in _command_lines(command_stream, pipe_watch):
            if frame_problem:
                backend.em.emit("error", message=frame_problem)
                continue
            line = line.strip()
            if not line:
                continue
            try:
                cmd = strict_json_loads(line)
            except (json.JSONDecodeError, ValueError):
                backend.em.emit("error", message="invalid JSON command line")
                continue
            if not isinstance(cmd, dict):
                backend.em.emit("error", message="command must be a JSON object")
                continue
            commands += 1
            last_command = str(cmd.get("type", "?"))[:64]   # a log line, not a payload channel
            try:
                backend.dispatch(cmd)
            except _Shutdown:
                shutdown_requested = True
                break
            except Exception as e:             # one bad command must NOT kill the whole backend
                import traceback
                detail = str(e).strip() or e.__class__.__name__
                backend.em.emit("error", message=f"Command '{cmd.get('type', '?')}' failed — {detail}")
                sys.stderr.write(traceback.format_exc())    # full trace → the extension's stderr channel
                _log_crash(crash_log, f"command {cmd.get('type', '?')!r} failed", e)
        reading["stdin"] = False               # past this point a signal has nothing to interrupt
    except (KeyboardInterrupt, BrokenPipeError) as interrupt:
        end_cause = type(interrupt).__name__
        _end_line(crash_log, f"serve loop ended: {end_cause}; pipe: {pipe_watch.describe()}")
    except _Terminated as terminated:
        end_cause = f"{_signal_name(terminated.signum)} — the parent asked us to stop"
        _end_line(crash_log,
                  f"serve loop ended: {end_cause}; up {time.monotonic() - started_at:.0f}s, "
                  f"{commands} commands, last {last_command or 'none'!r}, turn running: "
                  + ("yes" if _safe_busy(backend) else "no") + f", pipe: {pipe_watch.describe()}")
    except BaseException as fatal:             # never exit without saying why, in our own log
        _log_crash(crash_log, "serve loop raised", fatal)
        raise
    else:
        if shutdown_requested:
            cause = "the editor asked us to shut down"
        elif pipe_watch.gave_up:
            cause = (f"the command pipe kept turning non-blocking ({pipe_watch.restores} restores); "
                     "stopped reading")
        else:
            status, now_parent = _parent_status(parent_pid)
            if status == "gone":
                cause = (f"stdin closed: the parent ({parent_pid}) is gone — reparented to "
                         f"{now_parent}" if now_parent != parent_pid else
                         f"stdin closed: the parent ({parent_pid}) is gone")
            elif status == "alive":
                cause = f"stdin closed while the parent ({parent_pid}) is still alive"
            else:
                cause = f"stdin closed; this platform cannot confirm whether {parent_pid} is alive"
        try:
            busy = "yes" if backend._busy() else "no"
        except Exception:
            busy = "unknown"
        end_cause = cause
        _end_line(crash_log, f"serve loop ended: {cause}; up {time.monotonic() - started_at:.0f}s, "
                             f"{commands} commands, last {last_command or 'none'!r}, turn running: {busy}, "
                             f"pipe: {pipe_watch.describe()}")
    finally:
        # An editor asking us to stop is waiting on us; a pipe that closed under a running turn is
        # not, and neither is a signal. Only those get the grace period.
        grace = 0.0 if shutdown_requested else SHUTDOWN_GRACE_S
        if grace > 0 and _safe_busy(backend):
            # If the editor is still there it should hear this from us, not infer it from silence.
            try:
                backend.em.emit("info", message=(
                    f"DGC's backend is stopping ({end_cause}); it is finishing the current step "
                    f"(up to {SHUTDOWN_GRACE_S:.0f}s) and saving the session."))
            except Exception:
                pass
        outcome = backend.close(grace_s=grace)
        # Only now: for the whole grace window the process must keep the handler that makes a
        # second SIGTERM land cleanly instead of killing the turn we are busy saving.
        termbg.restore_stop_handlers(stop_handlers)
        _log_crash(crash_log, f"backend closed cleanly (work in flight: {outcome})")
        if crash_log is not None:
            try: crash_log.close()
            except Exception: pass
    if stopped_by:
        # The work is saved and the log is written; now finish dying of the signal we were sent,
        # so a supervisor reads "terminated by SIGTERM" and not a voluntary exit 0.
        termbg.resend(stopped_by["signum"], stop_handlers)
