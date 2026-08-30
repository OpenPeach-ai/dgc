"""The full-screen DGC app — a full-screen alt-screen TUI.

An `prompt_toolkit` Application with: a continuously-animated wordmark header, a
scrollable transcript, a live status line (spinner + activity + tokens), and a
pinned bordered composer (`❯` + `model · mode`). The agent turn runs on a worker
thread; its AgentUI callbacks append rendered (rich→ANSI) blocks to the transcript
and invalidate the app. Blocking prompts (approve / plan / options) hand control to
the composer via a cross-thread request + event.

`dgc` launches this; `dgc --classic` keeps the inline REPL.
"""
from __future__ import annotations

import io
import json
import math
import re
import shlex
import threading
import time
import webbrowser
from pathlib import Path

from prompt_toolkit.application import Application
from prompt_toolkit.auto_suggest import AutoSuggest, Suggestion
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import ConditionalContainer, Float, FloatContainer, HSplit, Layout, VSplit, Window
from prompt_toolkit.layout import ScrollOffsets
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.layout.processors import ConditionalProcessor, PasswordProcessor
from rich.console import Console
from rich.text import Text

from . import (__version__, attachments as attachments_mod, glyphs, logo as logo_mod,
               render as render_mod, style as style_mod)
from .update import cached_update
from .agent import Agent
from .commands import canonical_command_name, command_pairs, command_pairs_with_custom
from .redaction import redact_text, secret_values

# The slash-command palette — name → one-line description. Drives both the `/` menu
# (a live dropdown above the composer) and the /help listing. Order = most-reached first.
SLASH_COMMANDS: list[tuple[str, str]] = command_pairs("tui")
_MAX_QUEUED_FOLLOWUPS = 8
_MAX_QUEUED_FOLLOWUP_CHARS = 64_000
_MAX_TRANSITIONAL_FOLLOWUP_CHARS = 128_000  # queued + one older accepted steer batch


def _cell_len(value: str) -> int:
    """Terminal cells occupied by plain Unicode text (wide/combining/emoji aware)."""
    return Text(style_mod.terminal_safe_text(value)).cell_len


def _ansi_cell_len(value: str) -> int:
    """Terminal cells occupied by Rich-rendered ANSI text."""
    return Text.from_ansi(str(value)).cell_len


def _session_generation_guard(agent) -> dict:
    """CAS fields for sidecar changes; test doubles and legacy agents stay unguarded."""
    if hasattr(agent, "_session_revision") and hasattr(agent, "_session_exists"):
        return {"expected_revision": agent._session_revision,
                "expected_exists": agent._session_exists}
    return {}


class SlashCompleter(Completer):
    """A live command palette: while the composer holds just `/word`, offer matching commands
    (name + description) as a dropdown. Filters as you type; picks with ↑/↓ + Enter."""

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/") or " " in text:     # only while typing the command word
            return
        word = text[1:].lower()
        for name, desc in SLASH_COMMANDS:
            if name.startswith(word):
                yield Completion("/" + name, start_position=-len(text),
                                 display="/" + name, display_meta=desc)


class _NextSuggest(AutoSuggest):
    """Ghost-text: show the predicted next prompt (dim) after the cursor. Full text on an empty
    composer; the remaining suffix once the user types a matching prefix; nothing if they diverge."""

    def __init__(self, tui):
        self._tui = tui

    def get_suggestion(self, buffer, document):
        if self._tui._input is not None and self._tui._input.get("secret"):
            return None
        sug = self._tui._suggestion
        if not sug:
            return None
        t = document.text
        if not t:
            return Suggestion(sug)
        if sug.startswith(t) and len(sug) > len(t):
            return Suggestion(sug[len(t):])
        return None


class AgentSession:
    """One conversation running concurrently with the others: its own agent, transcript,
    streaming + turn state, worker, and any pending blocking request. The TUI holds a list of
    these and renders the ACTIVE one; background sessions keep running on their own threads and
    flag when they finish or need input."""
    _counter = 0

    def __init__(self, config, ui, agent=None):
        AgentSession._counter += 1
        self.id = f"s{AgentSession._counter}"
        self.config = agent.config if agent is not None else config
        self.agent = agent or Agent(config, ui)
        self.blocks: list = []             # rendered ANSI blocks (this session's transcript)
        self._buf = ""                     # streaming assistant text
        self._think = ""                   # streaming reasoning
        self._streaming = False
        self._thinking = False
        self._cur_tool: str | None = None
        self._think_t0: float | None = None
        self._tool_count = 0
        self._turn = threading.Event()     # set while this session's turn runs
        self._cancel = self.agent.cancelled
        self._queue: list[tuple[str, bool]] = []  # (prompt, user band was already rendered)
        self._queue_lock = threading.Lock()
        self._turn_t0 = 0.0
        self._phase_act: str | None = None
        self._phase_t0 = 0.0
        self._autotitled = False
        self._autotitle_pending = False
        self._aux_cancel = threading.Event()
        self._aux_generation = 0
        self._aux_thread: threading.Thread | None = None
        self._worker_thread: threading.Thread | None = None
        self._closing = False
        self._workspace_lock = threading.Lock()
        self._workspace_finalized = False
        self.workspace = None              # managed FleetWorkspace; manual/shared sessions keep None
        self.workspace_kind = "shared"     # shared | managed | manual
        self.workspace_path = Path(self.config.project_root).resolve(strict=False)
        self.workspace_branch = ""
        self._turn_marks: list[tuple[int, str]] = []
        self._suggestion: str | None = None
        self._todos: list = []
        self._scroll_off = 0
        self._follow = True                # True = pin to the live bottom; a manual scroll-up drops it
        # a per-session cross-thread blocking request (approve / plan / options)
        self._req: dict | None = None
        self._req_answer = None
        self._req_event = threading.Event()
        self._req_pick = None              # the on-pick callback bound to THIS session's request
        self.pinned = False
        self.draft = ""                    # unsent composer text, restored when you switch back
        self.created = time.monotonic()
        self.last_activity = time.monotonic()

    @property
    def name(self) -> str | None:
        return self.agent.session_name

    @property
    def state(self) -> str:
        if self._req is not None:
            return "needs_input"
        if self._turn.is_set():
            return "running"
        return "idle"


def _active_prop(field: str):
    """A THREAD-AWARE TUI property so the ~150 existing `self.<field>` references keep working
    while the state lives per-session. On a worker thread it targets THAT thread's session (a
    background agent writes to its own transcript); on the main/UI thread it targets the ACTIVE
    session (what's on screen). A bare `object.__new__(TUI)` (unit tests) falls back to instance
    storage."""
    def get(self):
        s = getattr(self, "_sessions", None)
        if not s:
            return self.__dict__.get("_fb_" + field)
        tls = getattr(self, "_tls", None)
        cur = getattr(tls, "session", None) if tls else None
        return getattr(cur or s[self._active_idx], field)

    def set(self, v):
        s = getattr(self, "_sessions", None)
        if not s:
            self.__dict__["_fb_" + field] = v
            return
        tls = getattr(self, "_tls", None)
        cur = getattr(tls, "session", None) if tls else None
        setattr(cur or s[self._active_idx], field, v)
    return property(get, set)


class TUI:
    """A full-screen app that also *is* the AgentUI the agent calls back into."""

    # At/below this terminal HEIGHT the user band auto-compacts (drops its tinted vpad + arrow) so a
    # short window isn't dominated by prompt padding. Derived per-frame from the live height, never
    # persisted — growing the window restores the full band. (Copied from a polished CLI's model.)
    _AUTO_COMPACT_ROWS = 20

    # per-session state → delegated to the active AgentSession (multi-agent fleet)
    config = _active_prop("config")
    agent = _active_prop("agent")
    blocks = _active_prop("blocks")
    _buf = _active_prop("_buf")
    _think = _active_prop("_think")
    _streaming = _active_prop("_streaming")
    _thinking = _active_prop("_thinking")
    _cur_tool = _active_prop("_cur_tool")
    _think_t0 = _active_prop("_think_t0")
    _tool_count = _active_prop("_tool_count")
    _turn = _active_prop("_turn")
    _cancel = _active_prop("_cancel")
    _queue = _active_prop("_queue")
    _turn_t0 = _active_prop("_turn_t0")
    _phase_act = _active_prop("_phase_act")
    _phase_t0 = _active_prop("_phase_t0")
    _autotitled = _active_prop("_autotitled")
    _turn_marks = _active_prop("_turn_marks")
    _suggestion = _active_prop("_suggestion")
    _todos = _active_prop("_todos")
    _scroll_off = _active_prop("_scroll_off")
    _follow = _active_prop("_follow")
    _req = _active_prop("_req")
    _req_answer = _active_prop("_req_answer")
    _req_event = _active_prop("_req_event")

    @property
    def active(self) -> "AgentSession":
        return self._sessions[self._active_idx]

    def __init__(self, config, agent=None):
        self._fleet_root = Path(config.project_root).resolve(strict=False)
        self.config = config
        style_mod.set_theme(config.get("theme", "dark"))
        # the fleet: one active AgentSession now; /dashboard spawns + switches more. Every
        # per-conversation field (agent, blocks, _buf, _turn, _todos, _req, …) is an _active_prop
        # that reads/writes the ACTIVE session, so the rest of the TUI is untouched.
        self._sessions: list[AgentSession] = [AgentSession(config, self, agent=agent)]
        self._active_idx = 0
        self._tls = threading.local()      # per-thread: which session a worker thread's turn belongs to
        self._aux_lock = threading.Lock()  # title/suggestion calls serialize across the whole fleet
        self.agent.ui = self               # the agent calls back into this TUI

        self._start = time.monotonic()
        self.deny_reason = ""              # set when the user denies a tool "with a reason"
        self.plan_feedback = ""            # one-shot steer after "Keep planning"
        self.app: Application | None = None
        import shutil
        _sz = shutil.get_terminal_size((100, 30))
        self._width, self._height = _sz.columns, _sz.lines   # os.terminal_size uses .lines
        self._flash_msg = ""               # transient confirmation (clicks / mode switch)
        self._flash_until = 0.0
        self._mouse_on = True              # mouse capture (wheel-scroll/clicks); /copy toggles it OFF
                                           # so the terminal's own text selection + copy work
        self._naming = False               # inline "name this new session" prompt is active
        self._prompt_history: list[str] = []   # submitted prompts, for /history (Ctrl+R) recall
        self._menu_rows: dict[int, str] = {}   # terminal-row → welcome-menu action (set on render)
        self._hover_row: int | None = None     # welcome-menu row under the mouse (hover highlight)
        self._ctx_hover = False                # the top-right context chip is under the mouse (→ morph)
        self._ctx_x0 = self._ctx_x1 = -1       # context chip x-range on row 0, for hover/click hit-testing
        self._picker: dict | None = None   # {labels, cb} numbered pick (models, sessions, …)
        self._input: dict | None = None    # {prompt, cb} free-text prompt (custom host URL, …)
        self._overlay: dict | None = None  # floating dropdown/modal above the composer
        self._quit_armed = 0.0             # monotonic time of the first Ctrl+C (double-press to quit)
        self._build()
        if len(self.agent.messages) > 1:   # a session was already loaded (dgc --continue) → show it
            self._render_history()

    # ---- floating overlay (a dropdown/modal above the composer) ----
    def _show_picker(self, title: str, labels: list[str], cb, delete_cb=None) -> None:
        """Open a floating, filterable, arrow-navigable picker above the composer (NOT chat text)."""
        rows = [{"label": str(l), "value": i} for i, l in enumerate(labels)]
        foot = "↑↓ move · type to filter · Enter select" + ("  · ^D delete" if delete_cb else "") + " · Esc close"
        self._open_overlay(rows, on_pick=lambda r: cb(r["value"]), title=title, footer=foot,
                           on_delete=(lambda r: delete_cb(r["value"])) if delete_cb else None)

    def _open_overlay(self, rows, on_pick, *, title=None, tabs=None, tab=0, footer=None,
                      on_delete=None, on_action=None, rebuild=None, on_submit=None,
                      keep_input=False, header=None, accent=False, back=None, info=False,
                      reader=False) -> None:
        if not keep_input:
            self.input_buf.reset()                      # composer becomes the filter box
        self._overlay = {"rows": rows, "on_pick": on_pick, "title": title, "tabs": tabs, "tab": tab,
                         "footer": footer, "on_delete": on_delete, "on_action": on_action,
                         "rebuild": rebuild, "on_submit": on_submit, "header": header,
                         "accent": accent, "sel": 0, "scroll": 0, "back": back, "info": info,
                         "reader": reader}
        self._invalidate()

    def _open_command_palette(self) -> None:
        """The `/` menu as an overlay (same engine as the pickers): the composer holds `/query`,
        rows filter live, ↑/↓ select, Enter runs. Replaces the flaky completion-menu Enter path."""
        def rebuild(ov):
            q = self.input_buf.text.lstrip("/").strip().lower()
            rows = command_pairs_with_custom("tui", self.config.project_root)
            rows = [(n, d) for n, d in rows if not q or q in n.lower() or q in d.lower()]
            if q:   # rank: exact name, then name-prefix, then name-substring, then description-only
                rows.sort(key=lambda nd: (nd[0].lower() != q, not nd[0].lower().startswith(q),
                                          q not in nd[0].lower(), nd[0]))
            return [{"label": "/" + n, "desc": d, "value": n} for n, d in rows]

        def submit(row, typed):
            if " " in typed:                            # typed args → run verbatim (e.g. /model qwen)
                self._run_command(typed)
            elif row:                                   # selected a row → run it
                self._run_command("/" + row["value"])
            elif typed.startswith("/") and len(typed) > 1:
                self._run_command(typed)
            else:
                return
            # if the command opened ANOTHER menu (sub-menu, model/provider/subagent picker, Skills modal…),
            # give it Esc-back to this palette so one Esc steps back and a second Esc closes.
            if self._overlay is not None and not self._overlay.get("back"):
                self._overlay["back"] = self._palette_back
        self._open_overlay([], on_pick=lambda r: None, rebuild=rebuild, on_submit=submit,
                           footer="↑↓ move · type to filter · Enter run · Esc close", keep_input=True)

    def _palette_back(self) -> None:
        """Reopen the `/` palette — the Esc-back target for any menu opened from it."""
        self.input_buf.reset(); self.input_buf.insert_text("/")
        self._open_command_palette()

    # commands that take a fixed set of options → the palette opens a SUB-MENU to pick one
    _SUBMENUS = {
        "thoughts": ([("Show thinking", "show"), ("Hide thinking", "hide")],
                     lambda s: "show" if s.config.get("show_reasoning", True) else "hide"),
        "think": ([("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high")],
                  lambda s: s.config.get("thinking", "off")),
        "mode": ([("Default — ask before writes", "default"), ("Accept edits — auto-edit, ask shell", "acceptEdits"),
                  ("Plan — read-only", "plan"), ("Auto — full access", "auto")],
                 lambda s: s.agent.mode),
        "bg": ([("Auto", "auto"), ("Dark", "dark"), ("Inherit", "inherit")],
               lambda s: s.config.get("background", "auto")),
        "theme": ([("Auto — match the terminal", "auto"), ("Dark", "dark"), ("Light", "light")],
                  lambda s: s.config.get("theme", "auto")),
        "sandbox": ([("On — project only, no network", "on"), ("Off", "off")],
                    lambda s: "on" if s.config.get("sandbox") else "off"),
    }

    def _run_command(self, text: str) -> None:
        if not text.startswith("/"):
            return
        parts = text[1:].split(maxsplit=1)
        cmd = parts[0].lower()
        if cmd in self._SUBMENUS and len(parts) == 1:   # bare option-command → open a sub-menu
            self._open_submenu(cmd)
        else:
            self._handle_slash(text)

    def _open_submenu(self, cmd: str) -> None:
        opts, current = self._SUBMENUS[cmd]
        cur = current(self)
        rows = [{"label": ("● " if v == cur else "○ ") + label, "value": v} for label, v in opts]
        self._open_overlay(rows, on_pick=lambda r: self._handle_slash(f"/{cmd} {r['value']}"),
                           title=f"/{cmd}", footer="↑↓ move · Enter select · Esc back",
                           back=self._palette_back)   # Esc → back to the `/` palette

    # ---- /settings — a full, editable settings browser (categories → keys → inline edit) ----
    # (key, label, type[, choices]); type ∈ str|int|float|bool|enum. Values live in config.
    _SETTINGS = {
        "Model & sampling": [
            ("model", "Model", "str"), ("base_url", "Endpoint URL", "str"),
            ("api_mode", "API transport", "enum",
             ["auto", "ollama", "anthropic", "chat_completions", "responses"]),
            ("provider_state", "Responses state", "enum", ["stateless", "server"]),
            ("prompt_cache", "Prompt cache routing", "bool"),
            ("prompt_cache_key", "Prompt cache key", "str"),
            ("capability_cache_ttl_s", "Capability retry TTL (s)", "int"),
            ("thinking", "Thinking effort", "enum", ["off", "low", "medium", "high"]),
            ("temperature", "Temperature", "float"), ("top_p", "Top-p", "float"),
            ("top_k", "Top-k", "int"), ("min_p", "Min-p", "float"),
            ("max_tokens", "Max output tokens", "int"), ("context_size", "Context window", "int"),
        ],
        "Behaviour": [
            ("mode", "Permission mode", "enum", ["default", "acceptEdits", "plan", "auto"]),
            ("max_turns", "Max tool iterations", "int"), ("bash_timeout", "Bash timeout (s)", "int"),
            ("search_timeout", "Search timeout (s)", "int"),
            ("verify_before_done", "Verify before finishing", "bool"),
            ("verify_command", "Verify command", "str"), ("suggest", "Ghost-text suggestions", "bool"),
            ("aux_idle_delay_ms", "Title/suggestion idle delay (ms)", "int"),
            ("sandbox", "Confine bash (sandbox)", "bool"),
            ("sandbox_network", "Sandbox network access", "bool"),
            ("session_redaction", "Redact credentials from saved sessions", "bool"),
        ],
        "Model routing": [
            ("subagent_model", "Sub-agent model", "str"),
            ("subagent_base_url", "Sub-agent endpoint", "str"),
            ("subagent_api_mode", "Sub-agent transport", "enum",
             ["inherit", "auto", "ollama", "anthropic", "chat_completions", "responses"]),
            ("max_parallel_tasks", "Parallel task workers (1–8)", "int"),
            ("fleet_worktree_root", "Fleet worktree storage", "str"),
            ("fallback_model", "Fallback model", "str"),
            ("fallback_base_url", "Fallback endpoint", "str"),
            ("fallback_api_mode", "Fallback transport", "enum",
             ["inherit", "auto", "ollama", "anthropic", "chat_completions", "responses"]),
        ],
        "Display": [
            ("theme", "Theme", "enum", ["auto", "dark", "light"]),
            ("background", "Background", "enum", ["auto", "dark", "inherit"]),
            ("show_reasoning", "Show reasoning", "bool"), ("logo_animation", "Animate logo", "bool"),
        ],
        "Artifacts": [
            ("artifact_bind", "Reach", "enum", ["localhost", "lan"]),
            ("artifact_port", "Port", "int"), ("artifact_autostart", "Autostart server", "bool"),
            ("artifact_hostname", "Public hostname", "str"),
            ("plan_artifact", "Automatic plan preview (loopback)", "bool"),
            ("artifact_in_plan", "Allow arbitrary project previews in plan mode", "bool"),
        ],
    }
    _CLIENT_KEYS = {"model", "base_url", "api_key", "api_mode", "provider_state", "prompt_cache",
                    "prompt_cache_key", "capability_cache_ttl_s", "temperature", "top_p", "top_k", "min_p",
                    "max_tokens", "context_size", "thinking", "request_timeout", "ollama_keep_alive"}

    def _open_settings(self) -> None:
        rows = [{"label": cat, "desc": f"{len(items)} settings", "value": cat}
                for cat, items in self._SETTINGS.items()]
        self._open_overlay(rows, on_pick=lambda r: self._open_settings_cat(r["value"]),
                           title="Settings", footer="↑↓ move · Enter open · Esc close",
                           accent=True, back=self._palette_back)

    def _fmt_setting(self, key: str, typ: str):
        v = self.config.get(key, "")
        if typ == "bool":
            return "on" if v else "off"
        return str(v) if v != "" else "(default)"

    def _open_settings_cat(self, cat: str) -> None:
        items = self._SETTINGS.get(cat, [])
        rows = [{"label": lbl, "desc": self._fmt_setting(key, typ), "value": (key, typ, spec)}
                for (key, lbl, typ, *spec) in items]
        self._open_overlay(rows, on_pick=lambda r: self._edit_setting(cat, *r["value"]),
                           title=f"Settings · {cat}", footer="↑↓ move · Enter edit · Esc back",
                           accent=True, back=self._open_settings)

    def _edit_setting(self, cat: str, key: str, typ: str, spec) -> None:
        if typ in ("bool", "enum"):
            choices = (["on", "off"] if typ == "bool" else spec[0])
            cur = self._fmt_setting(key, typ) if typ == "bool" else str(self.config.get(key, ""))
            if key in ("subagent_api_mode", "fallback_api_mode") and not cur:
                cur = "inherit"
            rows = [{"label": ("● " if c == cur else "○ ") + c, "value": c} for c in choices]
            self._open_overlay(rows, on_pick=lambda r: self._apply_setting(cat, key, r["value"], typ),
                               title=key, footer="↑↓ move · Enter select · Esc back",
                               accent=True, back=lambda: self._open_settings_cat(cat))
        else:                                   # str/int/float → free-text input
            cur = self.config.get(key, "")
            self._ask_input(f"{key} = {cur!r}  · type a new value (blank = default) ",
                            lambda text: self._apply_setting(cat, key, text, typ))

    def _apply_setting(self, cat: str, key: str, raw, typ: str) -> None:
        # parse to the right type; blank/"default" clears back to the DEFAULTS value
        from .config import DEFAULTS
        try:
            if typ == "bool":
                val = raw == "on" if isinstance(raw, str) else bool(raw)
            elif key in ("subagent_api_mode", "fallback_api_mode") and raw == "inherit":
                val = ""
            elif str(raw).strip() in ("", "default", "none") and typ != "enum":
                val = DEFAULTS.get(key)         # the REAL default ("" for sampling, "qwen3:8b" for model)
            elif typ == "int":
                val = int(str(raw).strip())
            elif typ == "float":
                val = float(str(raw).strip())
            else:                               # str / enum
                val = str(raw).strip()
        except ValueError:
            self._flash(f"'{raw}' isn't a valid value for {key}"); self._open_settings_cat(cat); return
        if key == "mode":
            self._request_mode(str(val), after=lambda: self._open_settings_cat(cat))
            return
        elif key == "theme":
            self._handle_slash(f"/theme {val}")
        else:
            self.config.set(key, val)
            if key in self._CLIENT_KEYS:
                self.agent.refresh_client()     # sampling / model / timeouts take effect immediately
        self._flash(f"{key} = {val}" if val not in ("",) else f"{key} reset to default")
        self._open_settings_cat(cat)            # back to the category page (values refreshed)

    def _close_overlay(self) -> None:
        self._overlay = None
        self.input_buf.reset()
        self._invalidate()

    _OVERLAY_CAP = 14                                   # max rows shown at once (fits all built-in skills)

    def _overlay_rows(self) -> list:
        """Rows for the overlay; a rebuild callback owns its own filtering, otherwise filter by
        the composer text. Clamps the selection into range."""
        ov = self._overlay
        if not ov:
            return []
        if ov.get("rebuild"):
            rows = ov["rebuild"](ov)
        else:
            flt = self.input_buf.text.strip().lower()
            rows = [r for r in ov["rows"] if not flt or flt in r.get("label", "").lower()
                    or flt in r.get("desc", "").lower()] if flt else ov["rows"]
        if ov["sel"] >= len(rows):
            ov["sel"] = max(0, len(rows) - 1)
        return rows

    def _overlay_move(self, d: int) -> None:
        ov = self._overlay
        ov["armed_del"] = None                          # moving off a row disarms a pending delete
        if ov.get("reader"):                            # a doc reader — arrows scroll, no selection
            ov["scroll"] = max(0, ov.get("scroll", 0) + d)
            self._invalidate()
            return
        n = len(self._overlay_rows())
        if n:
            ov["sel"] = (ov["sel"] + d) % n             # wrap-around
        self._invalidate()

    def _overlay_delete_armed(self) -> None:
        """Delete the selected row of a picker that declares on_delete, with a one-keystroke arm→confirm
        (first ^D/^X arms + flashes; a second on the SAME row commits). Shared by Ctrl+D and Ctrl+X so the
        advertised '^D delete' actually deletes instead of closing the menu."""
        ov = self._overlay
        if not (ov and ov.get("on_delete")):
            return
        rows = self._overlay_rows()
        if not rows:
            return
        sel = ov["sel"]
        row = rows[sel]
        if ov.get("armed_del") == sel:                  # confirmed → delete (cb re-opens with fresh rows)
            ov["armed_del"] = None
            ov["on_delete"](row)
        else:                                           # arm + tell the user how to confirm/cancel
            ov["armed_del"] = sel
            label = (row.get("label", "") if isinstance(row, dict) else str(row))[:40]
            self._flash(f"delete “{label}”? press ^D again to confirm · move/Esc cancels")
            self._invalidate()

    def _overlay_row_at(self, y: int):
        """Map a mouse y (within the overlay window) to a filtered-row index, or None.
        Reads the row→screen-y map recorded by the last _render_overlay — 
        record-rects-at-render, hit-test-at-event pattern — so it stays exact across
        tabs, titles, headers and scrolling instead of guessing from a formula."""
        ov = self._overlay
        if not ov:
            return None
        return ov.get("_rowmap", {}).get(y)

    def _overlay_tab_at(self, x: int, y: int):
        """Map a mouse (x, y) to a tab index when it lands on the tab strip, else None."""
        ov = self._overlay
        if not ov or not ov.get("tabs") or y != ov.get("_tab_y"):
            return None
        for x0, x1, i in ov.get("_tabmap", []):
            if x0 <= x < x1:
                return i
        return None

    def _overlay_switch_tab(self, i: int) -> None:
        ov = self._overlay
        if ov and ov.get("tabs") and 0 <= i < len(ov["tabs"]) and ov.get("tab") != i:
            ov["tab"], ov["sel"], ov["scroll"] = i, 0, 0
            self._invalidate()

    def _overlay_select(self) -> None:
        """Commit the current overlay selection (shared by Enter and mouse-click)."""
        ov = self._overlay
        if not ov or ov.get("tabs") or ov.get("reader"):   # tabbed modals use a/x/r; readers just scroll
            return
        rows = self._overlay_rows()
        sel = rows[ov["sel"]] if rows else None
        typed = self.input_buf.text.strip()
        submit, on_pick = ov.get("on_submit"), ov["on_pick"]
        self._close_overlay()
        if submit:
            submit(sel, typed)
        elif sel:
            on_pick(sel)

    def _overlay_hover(self, position) -> None:
        ov = self._overlay
        if not ov:
            return
        t = self._overlay_tab_at(position.x, position.y)    # over a tab → highlight it
        if t is not None:
            if ov.get("_tab_hover") != t:
                ov["_tab_hover"] = t
                self._invalidate()
            return
        if ov.get("_tab_hover") is not None:                # cursor left the tab strip
            ov["_tab_hover"] = None
            self._invalidate()
        r = self._overlay_row_at(position.y)
        if r is not None and ov.get("sel") != r:
            ov["sel"] = r
            self._invalidate()

    def _overlay_click(self, position) -> bool:
        ov = self._overlay
        if not ov:
            return False
        t = self._overlay_tab_at(position.x, position.y)    # click a tab → switch to it
        if t is not None:
            self._overlay_switch_tab(t)
            return True
        r = self._overlay_row_at(position.y)
        if r is None:
            return False
        ov["sel"] = r
        if ov.get("tabs"):                                  # tabbed modal: click just selects; a/x/r act
            self._invalidate()
        else:
            self._overlay_select()
        return True

    def _overlay_height(self) -> int:
        if not self._overlay:
            return 0
        n = min(len(self._overlay_rows()) or 1, self._OVERLAY_CAP)
        h = n + 2                                       # rows + top/bottom border
        h += 2 if self._overlay.get("tabs") else (1 if self._overlay.get("title") else 0)
        h += 2 if self._overlay.get("footer") else 0
        h += len(self._overlay["header"]) + 1 if self._overlay.get("header") else 0
        avail = max(4, getattr(self, "_height", 30) - 9)   # leave room for slim header + status + composer
        return min(h, 20, avail)

    def _render_overlay(self):
        from rich import box as _box
        from rich.padding import Padding
        from rich.panel import Panel
        from rich.text import Text
        th = style_mod.theme()
        ov = self._overlay
        if not ov:
            return ANSI("")
        avail = max(20, self._width - 2)                # the width _console()/_rich actually render into
        W = min(max(46, self._width - 6), 108, avail - 4)   # panel never wider than the console → no wrap
        inner = W - 4
        lpad = max(0, (avail - W) // 2)                  # center within the ACTUAL console width
        rows = self._overlay_rows()
        sel, cap = ov["sel"], self._OVERLAY_CAP
        scroll = ov.get("scroll", 0)
        if ov.get("reader"):                            # a scrollable doc — scroll is independent of sel
            scroll = max(0, min(scroll, len(rows) - cap)) if len(rows) > cap else 0
        else:
            scroll = min(scroll, sel)
            if sel >= scroll + cap:
                scroll = sel - cap + 1
            scroll = max(0, scroll)
        ov["scroll"] = scroll
        visible = rows[scroll:scroll + cap]
        labw = min(max((_cell_len(r.get("label", "")) for r in rows), default=8), 34)
        # Hit-map recorded during render : screen-y → row index, and the
        # tab strip's x-ranges. Panel line 0 is the top border, so the k-th content line
        # sits at screen y = 1 + k. Every content line is kept to ONE screen row (truncated,
        # never wrapped) so the map stays exact. XOFF = left pad + 1 border + 1 panel pad.
        ov["_rowmap"], ov["_tabmap"], ov["_tab_y"], XOFF = {}, [], None, lpad + 2
        lines: list = []

        def emit(line):                                 # append, clamped to one screen row
            if not isinstance(line, Text):
                line = Text(style_mod.terminal_safe_text(line))
            line.truncate(inner, overflow="ellipsis")
            lines.append(line)

        if ov.get("tabs"):                              # tab strip (tabbed modal)
            strip = Text()
            ov["_tab_y"] = 1 + len(lines)
            cx = XOFF
            for i, t in enumerate(ov["tabs"]):
                seg = f" {style_mod.terminal_safe_text(t).replace(chr(10), ' ')} "
                segw = _cell_len(seg)
                if i == ov["tab"]:
                    stl = f"bold {th.bg} on {th.accent}"
                elif i == ov.get("_tab_hover"):
                    stl = f"bold {th.text} on {th.surface2}"     # hover feedback
                else:
                    stl = th.muted
                ov["_tabmap"].append((cx, cx + segw, i))
                strip.append(seg, style=stl)
                strip.append(" ")
                cx += segw + 1
            lines.append(strip)                          # (2 short tabs never wrap)
            emit(Text("─" * inner, style=th.border))
        elif ov.get("title"):
            emit(Text(style_mod.terminal_safe_text(ov["title"]), style="bold"))
        if ov.get("header"):                            # a rich block (e.g. the command being approved)
            for h in ov["header"]:
                emit(h if isinstance(h, Text) else Text(str(h)))
            emit(Text("─" * inner, style=th.border))
        if not visible and not ov.get("info"):
            emit(Text("  (no matches)", style=th.faint))
        for i, r in enumerate(visible):
            if ov.get("reader"):                        # a doc line — render pre-styled, no cursor/bar
                t = r.get("text")
                line = (t.copy() if isinstance(t, Text)
                        else Text(style_mod.terminal_safe_text(r.get("label", ""))))
                line.truncate(inner, overflow="ellipsis")
                ov["_rowmap"][1 + len(lines)] = scroll + i
                lines.append(line)
                continue
            hot = (scroll + i == sel)
            line = Text()
            line.append("❯ " if hot else "  ", style=f"bold {th.accent}" if hot else th.faint)
            label = Text(style_mod.terminal_safe_text(r.get("label", "")),
                         style="bold" if hot else th.text)
            label.truncate(labw, overflow="ellipsis")   # keep Unicode labels in their cell column
            if label.cell_len < labw:                    # (e.g. an artifact or Unicode session name)
                label.append(" " * (labw - label.cell_len))
            line.append_text(label)
            if r.get("desc"):
                line.append("  " + style_mod.terminal_safe_text(r["desc"]),
                            style=th.muted)   # readable (not dim faint) either way
            line.truncate(inner, overflow="ellipsis")   # one screen row → hit-map stays exact
            pad = inner - line.cell_len
            if pad > 0:
                line.append(" " * pad)
            if hot:
                line.stylize(f"on {th.surface2}")       # subtle full-width highlight bar
            ov["_rowmap"][1 + len(lines)] = scroll + i
            lines.append(line)
        if len(rows) > cap:                             # scroll indicator
            emit(Text(f"  {scroll + 1}–{scroll + len(visible)} of {len(rows)}", style=th.faint))
        if ov.get("footer"):
            lines.append(Text(""))
            emit(Text(style_mod.terminal_safe_text(ov["footer"]), style=th.faint))
        panel = Panel(Text("\n").join(lines), box=_box.ROUNDED,
                      border_style=(th.accent if ov.get("accent") else th.border_strong),
                      padding=(0, 1), width=W)
        return ANSI(self._rich(Padding(panel, (0, 0, 0, lpad))))

    def _ask_input(self, prompt: str, cb, secret: bool = False) -> None:
        self._input = {"cb": cb, "prompt": prompt, "secret": secret}
        self._flash(prompt)

    def _flash(self, msg: str, secs: float = 2.2) -> None:
        """Show a short confirmation in the status line so an action visibly registered."""
        self._flash_msg = msg
        self._flash_until = time.monotonic() + secs
        self._invalidate()

    # ------------------------------------------------------------ rendering ---
    def _sync_width(self) -> None:
        """Track the live terminal size so the layout resizes with the window."""
        try:
            from prompt_toolkit.application import get_app
            sz = get_app().output.get_size()
            self._width, self._height = sz.columns, sz.rows
        except Exception:
            pass

    def _console(self) -> Console:
        return Console(file=io.StringIO(), force_terminal=True, color_system=style_mod.rich_color_system(),
                       width=max(20, self._width - 2), highlight=False,
                       theme=render_mod.markdown_theme())

    def _rich(self, *renderables, **kw) -> str:
        c = self._console()
        c.print(*renderables, **kw)
        return c.file.getvalue().rstrip("\n")

    def _append(self, ansi: str) -> None:
        self.blocks.append(ansi)
        if self._follow:                   # only snap to bottom while following; a scroll-up holds position
            self._scroll_off = 0
        self._invalidate()

    def _invalidate(self) -> None:
        if self.app:
            try:
                self.app.invalidate()
            except Exception:
                pass

    def _scroll_top_offset(self):
        """Keep the cursor pinned to the BOTTOM row of the transcript window (top-offset = height-1)
        so a paged/wheeled scroll moves the view IMMEDIATELY at any terminal height — otherwise PT
        (wrap_lines) leaves the cursor merely 'visible' and small scrolls on a tall window do nothing."""
        ri = getattr(self, "_transcript_win", None)
        ri = getattr(ri, "render_info", None) if ri else None
        return max(0, ri.window_height - 1) if ri else 0

    def _wheel(self, delta: int) -> None:
        """Mouse-wheel scroll of the transcript. delta>0 scrolls up into history (drops follow so
        streaming no longer yanks the view down); delta<0 scrolls toward the live bottom, re-following there."""
        if delta > 0:
            self._scroll_off += delta
            self._follow = False
        else:
            self._scroll_off = max(0, self._scroll_off + delta)
            self._follow = self._scroll_off == 0
        self._invalidate()

    def _live_marker(self) -> str:
        """An animated braille spinner for the LIVE (in-transcript) thinking/response lines, so the
        chat itself shows the model actively working right there — not only the bottom status bar."""
        return glyphs.SPINNER[int(time.monotonic() * 8) % len(glyphs.SPINNER)]

    def _rail_frag(self, running: bool, row: int, error: bool = False):
        """A left accent-bar fragment (a block rail), grouping a tool/reasoning block off the
        page. While it runs the bar is an animated downward traveling wave in the accent; on finish
        it settles to a static faint rail (red on error). refresh_interval=0.08 animates it for free."""
        import math
        th = style_mod.theme()
        if not running:
            col = th.err if error else th.border_strong
        else:                                     # sin² wave: bright band travels down the rows
            bright = math.sin(time.monotonic() * 3.0 + row * (2 * math.pi / 8)) ** 2
            col = style_mod.lerp_rgb(th.bg, th.accent, 0.30 + 0.70 * bright)
        return (f"fg:{col}", f"{glyphs.RAIL} ")

    def _wrap_tail(self, text: str, width: int, n: int) -> list[str]:
        """The last `n` display lines of `text` wrapped to `width` — so LIVE reasoning shows a calm
        rolling tail instead of one ever-growing line (a rolling truncated view)."""
        width, n = max(1, int(width)), max(0, int(n))
        if n == 0:
            return []
        console = self._console()
        out: list[str] = []
        for para in text.split("\n"):
            wrapped = Text(para).wrap(console, width, overflow="fold") if para.strip() else []
            out.extend(row.plain for row in (wrapped or [Text("")]))
        return out[-n:] if out else []

    # ---- the transcript control ----
    def _transcript(self):
        from prompt_toolkit.formatted_text import to_formatted_text
        th = style_mod.theme()
        ft = []
        prev = None                             # kind of the previous block (None = first)
        def add(frags, kind):
            nonlocal prev
            if prev is not None:
                # spacing rhythm — a 1-row inter-entry gap: one untinted blank row around assistant
                # prose, reasoning, AND the user band — so each breathes on both sides. Only adjacent
                # tool rows pack together. The band's own tinted vpad sits INSIDE this untinted gap.
                spaced = kind in ("text", "think", "user") or prev in ("text", "think", "user")
                ft.append(("", "\n\n" if spaced else "\n"))
            elif kind == "user":
                # first block: keep the tinted band from butting against the slim header
                ft.append(("", "\n"))
            ft.extend(frags)
            prev = kind
        for blk in self.blocks:
            if isinstance(blk, dict) and blk.get("kind") == "think":
                add(self._think_frags(blk), "think")
            elif isinstance(blk, dict) and blk.get("kind") == "tool":
                add(self._tool_frags(blk), "tool")
            elif isinstance(blk, dict) and blk.get("kind") == "user":
                # re-rendered every frame at the CURRENT width so the full-width band reflows on
                # resize instead of keeping stale padding (the "box dismantles on resize" bug).
                add(list(to_formatted_text(ANSI(self._user_band(blk["text"], blk.get("tag", ""))))), "user")
            elif blk:
                add(list(to_formatted_text(ANSI(blk))), "text")
        if self._think:                     # in-flight reasoning: a header + a rolling last-N tail,
            m = self._live_marker()         #   each line rail-wrapped, instead of one growing grey smear
            frags = [(f"bold fg:{th.accent}", m + " "), (f"fg:{th.muted}", "Thinking…")]
            for i, ln in enumerate(self._wrap_tail(self._think, max(1, self._width - 4), 5)):
                frags.append(("", "\n"))
                frags.append(self._rail_frag(True, i))
                frags.append((f"fg:{th.faint} italic", ln))
            add(frags, "think")
        if self._buf:                       # in-flight assistant text — animated marker on the live line
            m = self._live_marker()
            frags = [(f"bold fg:{th.accent}", m + " ")]
            frags += list(to_formatted_text(ANSI(self._rich(self._md(self._buf)))))
            add(frags, "text")
        if prev is None:
            self._scroll_off = 0
            return ANSI("")                      # empty transcript (welcome state) — kept clear
        ft.append(("", "\n"))
        return self._place_cursor(ft)

    def _think_frags(self, b: dict):
        """A collapsible reasoning block: a clickable dim `◆ ▸ Thought for Xs` header that expands
        (▾) to the full reasoning on click  collapse/expand."""
        from prompt_toolkit.mouse_events import MouseEventType
        th = style_mod.theme()
        secs = b.get("secs", 0)
        tstr = f"{secs:.1f}s" if secs < 60 else f"{int(secs // 60)}m{int(secs % 60)}s"
        head = f"Thought for {tstr}" if secs else "Thought"
        caret = "▾" if b.get("exp") else "▸"

        def toggle(mouse_event):
            if mouse_event.event_type == MouseEventType.MOUSE_UP:
                b["exp"] = not b.get("exp")
                self._invalidate()
        frags = [(f"fg:{th.faint}", f"{glyphs.DIAMOND} {caret} {head}", toggle)]
        if b.get("exp"):
            for ln in b.get("text", "").strip().split("\n"):
                frags.append(("", "\n"))
                frags.append((f"fg:{th.faint} italic", f"  {glyphs.RAIL} {ln}"))
        return frags

    _TOOL_HEAD = 10                        # tool-output lines shown before it collapses

    def _tool_frags(self, b: dict):
        """One tool step: a rail-prefixed header (tense-aware verb + summary) then its output
        or diff, every row wearing the accent rail — an animated wave while running, static when done.
        Long output collapses to a clickable '▸ N more lines' that expands in place."""
        from prompt_toolkit.formatted_text import to_formatted_text
        from prompt_toolkit.mouse_events import MouseEventType
        th = style_mod.theme()
        running, error = bool(b.get("running")), bool(b.get("error"))
        name, summary, exp = b.get("name", ""), b.get("summary", ""), bool(b.get("exp"))
        verb = (self._TOOL_ING if running else self._TOOL_ED).get(name) or self._TOOL_VERB.get(name, name)

        row = [0]
        def rail():
            f = self._rail_frag(running, row[0], error)
            row[0] += 1
            return f

        def toggle(mouse_event):
            if mouse_event.event_type == MouseEventType.MOUSE_UP:
                b["exp"] = not b.get("exp")
                self._invalidate()

        frags = [rail(), (f"bold fg:{th.accent}", f"{glyphs.tool_icon(name)} {verb}")]
        if summary:
            frags.append((f"fg:{th.faint}", f" {summary}"))
        if running:                                     # a live marker on the header while it works
            frags.append((f"fg:{th.accent}", f"  {self._live_marker()}"))

        progress = b.get("progress") if running else None
        if isinstance(progress, dict):
            value, total = progress.get("value"), progress.get("total")
            amount = ""
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if isinstance(total, (int, float)) and not isinstance(total, bool) and total:
                    pct = max(0.0, min(100.0, value / total * 100.0))
                    amount = f" · {pct:.0f}%"
                else:
                    amount = f" · {value:g}"
            frags.append(("", "\n")); frags.append(rail())
            level = str(progress.get("level") or "")
            color = th.err if level in ("error", "critical", "alert", "emergency") else th.faint
            frags.append((f"fg:{color}", f"{str(progress.get('message') or '')[:500]}{amount}"))

        diff = b.get("diff")
        if diff:                                        # pre-rendered (coloured) diff — rail each line
            for ln in diff.split("\n"):
                frags.append(("", "\n"))
                frags.append(rail())
                frags.extend(to_formatted_text(ANSI(ln)))
        else:
            lines = (b.get("out") or "").splitlines()
            for ln in (lines if exp else lines[:self._TOOL_HEAD]):
                frags.append(("", "\n"))
                frags.append(rail())
                frags.append((f"fg:{th.faint}", ln))
            if len(lines) > self._TOOL_HEAD:
                frags.append(("", "\n"))
                frags.append(rail())
                caret = "▾" if exp else "▸"
                label = "show less" if exp else f"{len(lines) - self._TOOL_HEAD} more lines — click /  expand"
                frags.append((f"fg:{th.accent_dim}", f"{caret} {label}", toggle))
        return frags

    def _cursor_ft(self, text: str):
        """Transcript formatted text with a [SetCursorPosition] marker at the line we want kept
        visible. With wrap_lines=True prompt_toolkit IGNORES get_vertical_scroll and instead
        scrolls to keep the cursor visible — so for a tall transcript (e.g. a resumed chat) the
        default cursor at line 0 pins the view to the TOP and hides the live stream at the bottom.
        Placing the cursor at the bottom (scroll_off 0) makes it follow new output; a paged-up
        offset keeps that line visible instead."""
        from prompt_toolkit.formatted_text import to_formatted_text
        return self._place_cursor(list(to_formatted_text(ANSI(text))))

    def _place_cursor(self, frags):
        """Insert a [SetCursorPosition] marker into a fragment list at the line to keep visible
        (scroll-follow). Preserves per-fragment mouse handlers (3-tuples) so clickable blocks
        (e.g. collapsible thinking) keep working."""
        total = 1 + sum(f[1].count("\n") for f in frags)
        target = total - 1 - max(0, min(self._scroll_off, total - 1))
        if target <= 0:
            return [("[SetCursorPosition]", "")] + frags
        out, line, placed = [], 0, False
        for frag in frags:
            style, txt = frag[0], frag[1]
            handler = frag[2] if len(frag) > 2 else None
            if placed or "\n" not in txt:
                out.append(frag); continue
            segs = txt.split("\n")
            for k, seg in enumerate(segs):
                if seg:
                    out.append((style, seg, handler) if handler else (style, seg))
                if k < len(segs) - 1:
                    line += 1
                    out.append((style, "\n"))
                    if not placed and line >= target:
                        out.append(("[SetCursorPosition]", "")); placed = True
        if not placed:
            out.append(("[SetCursorPosition]", ""))
        return out

    def _tip(self):
        th = style_mod.theme()
        if self.blocks or self._buf or self._overlay or self._welcome_metrics()[2] == "compact":
            return ANSI("")
        upd = cached_update()
        if upd:                                            # echo the update CTA in the tip, like 
            return ANSI(self._rich(f"  [bold]Tip:[/] [{th.faint}]a newer DGC ([bold {self._GOLD}]v{upd}[/]) "
                                   f"is out — type [bold {self._GOLD}]/update[/] or click [ Update now ][/]"))
        return ANSI(self._rich(f"  [bold]Tip:[/] [{th.faint}]Shift+Tab to switch mode "
                               f"{glyphs.MIDDOT} /help for commands {glyphs.MIDDOT} Esc to stop a turn[/]"))

    def _shortcut_bar(self):
        """A persistent, context-aware key-hint bar pinned to the very bottom — 
        shortcuts_bar.rs ported: bold-bright key + dim label chips, a dim separator, and a
        'press again to quit' takeover. Rebuilt every frame so keys track the current state."""
        th = style_mod.theme()
        armed = (time.monotonic() - self._quit_armed) < 2.0
        if armed and not self._turn.is_set() and self._overlay is None and self._req is None:
            chips = [("Ctrl+C", "press again to quit")]
        elif not self._mouse_on:
            chips = [("select mode", "drag to select & copy"), ("/copy", "back to scroll")]
        elif self._req is not None or self._input is not None or self._naming:
            chips = [("Enter", "confirm"), ("Esc", "cancel")]
        elif self._overlay is not None:
            chips = [("↑↓", "move"), ("Enter", "select"), ("Esc", "close")]
        elif self._turn.is_set():
            chips = [("Esc", "stop"), ("Enter", "follow up")]
        else:
            chips = [("Enter", "send"), ("Shift+Tab", "mode"), ("/", "commands"),
                     ("Ctrl+N", "new"), ("Ctrl+C", "quit")]
        key, lbl, sep = f"bold {th.muted}", th.faint, th.faint
        body = f"[{sep}]  {glyphs.RAIL}  [/]".join(
            f"[{key}]{_esc(k)}[/] [{lbl}]{_esc(l)}[/]" for k, l in chips)
        # fleet indicator: how many agents + whether a BACKGROUND one is running / needs you (^\ = dashboard)
        if len(self._sessions) > 1:
            need = sum(1 for i, s in enumerate(self._sessions) if i != self._active_idx and s.state == "needs_input")
            run = sum(1 for i, s in enumerate(self._sessions) if i != self._active_idx and s.state == "running")
            seg = f"[bold {th.accent}]⧉ {len(self._sessions)}[/]"
            if need:
                seg += f" [bold {th.err}]◆{need} need you[/]"
            elif run:
                seg += f" [{th.warn}]⋮{run}[/]"
            seg += f" [{th.faint}]Ctrl+\\ [/]"          # trailing space: avoid rich reading \] as an escape
            body += f"[{sep}]  {glyphs.RAIL}  [/]" + seg
        return ANSI("  " + self._rich(body))

    @staticmethod
    def _md(text: str):
        return render_mod.render_markdown(style_mod.terminal_safe_text(text))

    # ---- header (welcome card when empty, slim line when busy) ----
    def _header(self):
        self._sync_width()                  # resize with the terminal, before laying anything out
        th = style_mod.theme()
        if self.blocks or self._buf or self._overlay:   # conversation / overlay open → slim line
            nm = f" · {self.agent.session_name}" if self.agent.session_name else ""
            branch = getattr(self.active, "workspace_branch", "")
            ws = f" · {branch}" if branch else ""
            left_text = Text.from_markup(
                f" [bold {th.accent}]Vibe DGC[/] "
                f"[{th.faint}]· {_esc(self._model_label())} · {_esc(self.agent.mode)}"
                f"{_esc(nm)}{_esc(ws)}[/]")
            chip, _ = self._context_chip(self._ctx_hover)      # top-right token counter
            right_text = Text.from_markup(chip)
            usable = max(1, self._width - 1)
            # Preserve a useful right-aligned context chip and at least one cell of the identity
            # header. Both sides are truncated before ANSI rendering so Rich cannot insert hidden
            # newlines when model/session/worktree labels contain wide or very long text.
            right_text.truncate(min(right_text.cell_len, max(1, usable - 3)),
                                overflow="ellipsis")
            rw = right_text.cell_len
            remaining = max(0, usable - rw)
            left_text.truncate(max(0, remaining - 2), overflow="ellipsis")
            lw = left_text.cell_len
            gap = max(0, usable - lw - rw)
            left = self._rich(left_text, soft_wrap=True, end="") if lw else ""
            right = self._rich(right_text, soft_wrap=True, end="")
            self._ctx_x0, self._ctx_x1 = lw + gap, lw + gap + rw   # record for hover/click
            return ANSI(left + " " * gap + right)
        self._ctx_x0 = self._ctx_x1 = -1
        return ANSI(self._welcome_card())

    def _ctx_color(self, pct: float, th):
        return th.err if pct >= 90 else th.warn if pct >= 75 else th.muted if pct >= 50 else th.text

    def _context_window_size(self) -> int:
        effective = getattr(self.agent, "context_size", None)
        if callable(effective):
            return int(effective())
        return int(self.config.get("context_size", 32768))

    def _context_chip(self, hover: bool):
        """Top-right context counter  Default: `used / total` (colored by an
        urgency gradient). Hover: morph to `█████ 42.0%` at the SAME width (no layout shift)."""
        th = style_mod.theme()
        used, size = self.agent.estimate_tokens(), self._context_window_size()
        pct = min(100.0, used * 100 / size) if size else 0.0
        col = self._ctx_color(pct, th)
        default = f"{render_mod.fmt_tokens(used)} / {render_mod.fmt_tokens(size)}"
        total_w = max(len(default), 6)                        # reserve ≥ bar(…)+gap+pct
        if not hover:
            return f"[{col}]{default:<{total_w}}[/]", total_w
        bw = total_w - 6                                      # 6 = 1 gap + 5-char pct
        _full, _part, _empty = render_mod.frac_bar(pct, bw)
        bar = "█" * _full + _part + " " * _empty
        pctstr = (f"{pct:.2f}%" if pct < 10 else f"{pct:.1f}%") if pct < 100 else "MAX %"
        return f"[{col}]{bar}[/] [{th.muted}]{pctstr:>5}[/]", total_w

    def _open_context_popup(self) -> None:
        """Click the context chip → a details popup : the token
        summary, a bar, the model, and turn/tool stats."""
        from rich.text import Text
        th = style_mod.theme()
        used, size = self.agent.estimate_tokens(), self._context_window_size()
        pct = used * 100 / size if size else 0.0
        col = self._ctx_color(pct, th)
        barw = 34
        _full, _part, _empty = render_mod.frac_bar(pct, barw)
        # rough split: the system prompt (messages[0]) vs the rest of the conversation
        sys_tok = 0
        try:
            sys_tok = len(str(self.agent.messages[0].get("content", ""))) // 4 if self.agent.messages else 0
        except Exception:
            pass
        msg_tok = max(0, used - sys_tok)
        header = [
            Text.from_markup(f"[bold]Context[/]  [{th.faint}]{_esc(self.config.model)}[/]"),
            Text(""),
            Text.from_markup(f"[{th.text}]{render_mod.fmt_tokens(used)} / {render_mod.fmt_tokens(size)} tokens[/]  [{col}]({pct:.1f}%)[/]"),
            Text.from_markup(f"[{col}]{'█' * _full}{_part}[/][{th.border_strong}]{'░' * _empty}[/]"),
            Text(""),
            Text.from_markup(f"[{th.text}]{glyphs.DIAMOND}[/] [{th.muted}]System prompt[/]   [{th.faint}]{render_mod.fmt_tokens(sys_tok)}[/]"),
            Text.from_markup(f"[{th.accent}]{glyphs.DIAMOND}[/] [{th.muted}]Conversation[/]    [{th.faint}]{render_mod.fmt_tokens(msg_tok)}[/]"),
            Text.from_markup(f"[{th.border_strong}]{glyphs.DIAMOND_O}[/] [{th.muted}]Free[/]            [{th.faint}]{render_mod.fmt_tokens(max(0, size - used))}[/]"),
            Text(""),
            Text.from_markup(f"[{th.faint}]Turns {sum(1 for m in self.agent.messages if m.get('role') == 'user')}"
                             f"  {glyphs.MIDDOT}  Tool calls {self._tool_count}[/]"),
        ]
        self._open_overlay([], on_pick=lambda r: None, header=header,
                           footer="Esc close", accent=True, info=True)

    def _block_lines(self, blk) -> int:
        if isinstance(blk, dict) and blk.get("kind") == "think":
            return 1 + (len(blk.get("text", "").strip().split("\n")) if blk.get("exp") else 0)
        if isinstance(blk, dict) and blk.get("kind") == "user":
            _, compact, _, rows = self._user_band_layout(
                blk.get("text", ""), blk.get("tag", ""))
            return len(rows) + (0 if compact else 2)
        if isinstance(blk, dict) and blk.get("kind") == "tool":
            if blk.get("diff"):
                return 1 + blk["diff"].count("\n") + 1          # header + rendered diff lines
            n = len((blk.get("out") or "").splitlines())
            body = (n if blk.get("exp") else min(n, self._TOOL_HEAD)) + (1 if n > self._TOOL_HEAD else 0)
            return 1 + body + (1 if blk.get("running") and blk.get("progress") else 0)
        return re.sub(r"\x1b\[[0-9;?]*m", "", str(blk)).count("\n") + 1

    def _jump_to_block(self, i: int) -> None:
        """Scroll the transcript so block `i` (a turn's prompt) is in view """
        if not (0 <= i < len(self.blocks)):
            return
        before = sum(self._block_lines(b) for b in self.blocks[:i]) + i          # +i newline separators
        total = sum(self._block_lines(b) for b in self.blocks) + max(0, len(self.blocks) - 1) + 1
        self._scroll_off = max(0, total - 1 - before)
        self._invalidate()

    def _open_jump(self) -> None:
        """A picker of every turn — Enter scrolls the transcript to it ."""
        if not self._turn_marks:
            self._flash("no turns to jump to yet"); return
        rows = [{"label": f"{n + 1}.", "desc": prev, "value": bi}
                for n, (bi, prev) in enumerate(self._turn_marks)]
        self._open_overlay(rows, on_pick=lambda r: self._jump_to_block(r["value"]),
                           title="Jump to a turn", footer="↑↓ move · Enter jump · Esc cancel")

    def _open_rewind(self) -> None:
        """Pick a past turn to restore code + conversation to , then confirm."""
        pts = self.agent.checkpoints.listing()
        if not pts:
            self._flash("no checkpoints yet — run a turn first"); return
        rows = [{"label": prev, "desc": f"{nf} file{'' if nf == 1 else 's'}", "value": i}
                for (i, prev, nf) in pts]
        self._open_overlay(rows, on_pick=lambda r: self._confirm_rewind(r["value"]),
                           title="Rewind to (restores code + conversation)",
                           footer="↑↓ move · Enter select · Esc cancel")

    def _confirm_rewind(self, idx: int) -> None:
        from rich.text import Text
        th = style_mod.theme()
        info = {i: (prev, nf) for (i, prev, nf) in self.agent.checkpoints.listing()}
        prev, nf = info.get(idx, ("", 0))
        header = [Text.from_markup(f"[bold]Rewind to:[/] {_esc(prev)}"),
                  Text.from_markup(f"[{th.warn}]Reverts {nf} file(s) and truncates the conversation. "
                                   f"This cannot be undone.[/]")]
        rows = [{"label": f"{glyphs.CHECK}  Rewind", "value": "yes"},
                {"label": f"{glyphs.CROSS}  Cancel", "value": "no"}]
        self._open_overlay(rows, on_pick=lambda r: self._do_rewind(idx) if r["value"] == "yes" else None,
                           header=header, footer="Enter select · Esc cancel", accent=True)

    def _do_rewind(self, idx: int) -> None:
        try:
            msgs, nfiles = self.agent.rewind(idx)
        except Exception as e:
            self._flash(f"rewind failed: {type(e).__name__}"); return
        if msgs < 0:
            self._flash("rewind could not complete; recovery point retained")
            return
        self.blocks.clear(); self._turn_marks = []; self._buf = ""; self._think = ""
        self._render_history()
        self._scroll_off = 0
        self._flash(f"{glyphs.ARROW_L if hasattr(glyphs, 'ARROW_L') else '↩'} rewound — restored {nfiles} file(s)")
        self._invalidate()

    def _open_history(self) -> None:
        """A filterable list of your past prompts — Enter recalls one into the composer (Ctrl+R)."""
        seen, hist = set(), []
        for h in reversed(self._prompt_history):        # most-recent-first, de-duped
            k = h.strip()
            if k and k not in seen:
                seen.add(k); hist.append(h)
        if not hist:
            self._flash("no prompt history yet"); return
        rows = [{"label": h.replace("\n", " ⏎ ")[:140], "value": h} for h in hist]

        def pick(row):
            self.input_buf.text = row["value"]
            self.input_buf.cursor_position = len(row["value"])
        self._open_overlay(rows, on_pick=pick, title="Recall a prompt",
                           footer="↑↓ move · type to filter · Enter recall · Esc cancel")

    def _open_cheatsheet(self) -> None:
        """A grouped keyboard + command reference  (Ctrl+G)."""
        from rich.text import Text
        th = style_mod.theme()
        groups = [
            ("Compose", [("Enter", "send"), ("Shift+Enter", "newline"), ("Shift+Tab", "cycle permission mode"),
                         ("/", "command palette"), ("@path", "attach one exact bounded file"),
                         ("Ctrl+R", "recall a past prompt"),
                         ("! command", "run a shell command"), ("# note", "save a memory")]),
            ("This turn", [("Esc", "stop the turn"), ("Ctrl+C", "cancel · clear draft · quit")]),
            ("Navigate", [("PageUp / PageDn", "scroll the transcript"), ("End", "jump to the latest"),
                          ("click ◆ Thought", "expand the reasoning"), ("click token count", "context details")]),
            ("Session", [("Ctrl+N", "new session"), ("/resume", "reopen a past one"), ("/name", "rename this one")]),
        ]
        lines = []
        for title, keys in groups:
            lines.append(Text(title.upper(), style=f"bold {th.accent_bright}"))
            for k, d in keys:
                t = Text("  ")
                t.append(f"{k:<20}", style=f"bold {th.muted}")
                t.append(d, style=th.faint)
                lines.append(t)
            lines.append(Text(""))
        if lines:
            lines.pop()                                  # drop the trailing blank
        self._open_overlay([], on_pick=lambda r: None, header=lines, footer="Esc close", accent=True, info=True)

    def _open_docs(self) -> None:
        """/docs — a picker over the in-app how-to library."""
        from . import docs as docs_mod
        rows = [{"label": t, "desc": d, "value": t} for t, d, _ in docs_mod.DOCS]
        self._open_overlay(rows, on_pick=lambda r: self._open_doc_reader(r["value"]),
                           title="DGC docs", footer="↑↓ move · Enter read · Esc close", accent=True)

    def _open_reader(self, md: str, *, footer: str, back=None) -> None:
        """Render markdown into a scrollable reader overlay (shared by /docs and /view-plan)."""
        from rich.text import Text
        w = min(max(46, self._width - 6), 108) - 6           # ~= the panel's inner text width
        c = Console(file=io.StringIO(), force_terminal=True, color_system=style_mod.rich_color_system(),
                    width=max(20, w), highlight=False, theme=render_mod.markdown_theme())
        c.print(render_mod.render_markdown(style_mod.terminal_safe_text(md)))
        ansi = c.file.getvalue().rstrip("\n")
        rows = [{"text": Text.from_ansi(ln), "label": ln} for ln in ansi.split("\n")]
        self._open_overlay(rows, on_pick=lambda r: None, reader=True, accent=True,
                           footer=footer, back=back)

    def _open_doc_reader(self, title: str) -> None:
        """Render one doc's markdown into a scrollable reader overlay."""
        from . import docs as docs_mod
        entry = docs_mod.find(title)
        if not entry:
            return
        self._open_reader(entry[2], footer="↑↓ · PgUp/PgDn scroll · Esc back", back=self._open_docs)

    def _open_plan_view(self) -> None:
        """/view-plan — reopen the plan saved during the last plan-mode turn."""
        from . import sessions
        md = (sessions.load_plan(self.agent.session_file,
                                 getattr(self.agent, "session_root", self._fleet_root))
              if self.agent.session_file else None)
        if not md:
            self._flash("no saved plan yet — /mode plan, then ask for one")
            return
        self._open_reader(md, footer="the saved plan · ↑↓ scroll · Esc close")

    @staticmethod
    def _reltime(secs: float) -> str:
        secs = int(max(0, secs))
        if secs < 60:
            return f"{secs}s"
        if secs < 3600:
            return f"{secs // 60}m"
        if secs < 86400:
            return f"{secs // 3600}h"
        return f"{secs // 86400}d"

    def _open_dashboard(self) -> None:
        """The agent fleet console — every concurrent session in one place. A status header, a
        `+ New agent` action, each LIVE session with its state (active/running/needs-input/idle),
        then saved sessions you can reopen. Enter attaches/opens · x closes/deletes · p pins · r renames."""
        from rich.text import Text
        from . import sessions, artifacts
        th = style_mod.theme()
        used, size = self.agent.estimate_tokens(), self._context_window_size()
        pct = used * 100 / size if size else 0.0
        col = self._ctx_color(pct, th)
        full, part, empty = render_mod.frac_bar(pct, 22)
        arts = artifacts.registry()
        running = sum(1 for s in self._sessions if s.state == "running")
        needs = sum(1 for s in self._sessions if s.state == "needs_input")

        h1 = Text("  "); h1.append(style_mod.terminal_safe_text(self._model_label()),
                                    style=f"bold {th.text_strong}")
        h1.append("   " + style_mod.terminal_safe_text(self.agent.mode)
                  + " · think " + style_mod.terminal_safe_text(
                      self.config.get("thinking", "off")), style=th.muted)
        h2 = Text("  "); h2.append(f"{render_mod.fmt_tokens(used)} / {render_mod.fmt_tokens(size)}  ", style=th.faint)
        h2.append("█" * full + part, style=col); h2.append("░" * empty, style=th.border_strong)
        h2.append(f"  {pct:.0f}%", style=col)
        h2.append(f"    {len(self._sessions)} agent" + ("" if len(self._sessions) == 1 else "s"), style=th.muted)
        if running:
            h2.append(f" · {running} running", style=th.warn)
        if needs:
            h2.append(f" · {needs} need you", style=th.err)
        if arts:
            h2.append(f" · ◈ {len(arts)}", style=th.warn)
        header = [h1, h2]

        rows = [{"label": "+ New agent", "desc": "spawn a concurrent agent", "value": ("new", None)}]
        # live fleet — pinned first, then most-recently-active
        _MARK = {"active": "●", "needs_input": "◆", "running": "⋮", "idle": "○"}
        _DESC = {"active": "on screen", "needs_input": "waiting for you", "running": "working…", "idle": "idle"}
        open_files = set()
        for s in sorted(self._sessions, key=lambda s: (not s.pinned, -s.last_activity)):
            st = "active" if s is self.active else s.state
            preview = next((str(m.get("content", "")) for m in s.agent.messages if m.get("role") == "user"), "")
            title = (s.name or (preview[:40] if preview else "(new agent)"))[:40]
            pin = "⟐ " if s.pinned else ""
            tools = f" · {s._tool_count} tools" if s._tool_count else ""
            workspace = (f" · isolated {s.workspace_branch}" if getattr(s, "workspace_branch", "")
                         else " · shared checkout")
            rows.append({"label": f"{_MARK.get(st, '○')} {pin}{title}",
                         "desc": _DESC.get(st, "idle") + tools + workspace,
                         "value": ("switch", s), "action": True})
            if s.agent.session_file:
                open_files.add(str(s.agent.session_file))
        # saved sessions not currently open in the fleet
        now = time.time()
        fleet_root = getattr(self, "_fleet_root", self.config.project_root)
        for p, ts, prev, n, name in sessions.listing(
                fleet_root, redact_secrets=secret_values(self.config))[:30]:
            if str(p) in open_files:
                continue
            title = (name or prev or "(empty)")[:40]
            rows.append({"label": "○ " + title, "value": ("open", p), "action": True,
                         "desc": f"saved · {self._reltime(now - ts)} · {n} msg" + ("" if n == 1 else "s")})

        def on_pick(r):
            kind, v = r["value"]
            if kind == "new":
                self._new_session()
            elif kind == "switch":
                if v in self._sessions:
                    self._switch_to(self._sessions.index(v))
            else:                                        # reopen it in its associated isolated workspace
                self._open_saved_session(v)

        def on_action(key, r):
            if not r:
                return
            kind, v = r["value"]
            if key in ("x", "space"):
                if kind == "switch" and v in self._sessions:
                    self._close_session(self._sessions.index(v)); self._open_dashboard()
                elif kind == "open":
                    deleted = sessions.delete(v, fleet_root)
                    self._flash("deleted" if deleted else "session is active; deletion was not run")
                    self._open_dashboard()
            elif key == "p" and kind == "switch":
                v.pinned = not v.pinned; self._open_dashboard()
            elif key == "r" and kind == "switch":
                self._close_overlay()
                self._ask_input(f"rename '{v.name or 'agent'}' then Enter",
                                lambda nm, _v=v: (self._name_session(_v, nm),
                                                  self._open_dashboard()))

        self._open_overlay(rows, on_pick=on_pick, on_action=on_action, header=header,
                           title="Agents", accent=True,
                           footer="Enter open · x close · p pin · r rename · Esc close")

    # rows the right column needs: title(1) blank(1) [msg+cta(2)|tagline(1)] blank(1) newsession(1) blank(1) menu(4)
    def _right_rows(self, upd) -> int:
        return 9 + (2 if upd else 1)

    _CHROME_BELOW = 5     # rows under the header at welcome: status(1) + composer box(3) + shortcut bar(1)
    _WIDE_MIN = 82       # below this terminal WIDTH the card stacks (logo on top)  feel
    _CARD_W = 96         # FIXED card width — a capped box that never stretches; it stays this
                          # size and centered no matter how large the terminal gets.

    def _card_body_rows(self, mode, upd) -> int:
        """Rows INSIDE the panel (before its border+padding) for the chosen layout."""
        right = self._right_rows(upd)
        if mode == "stacked":
            return len(logo_mod.LOGO_SMALL) + 1 + right     # logo on top + blank + right column
        return max(len(logo_mod.LOGO), right)               # wide: the taller of the two columns

    def _welcome_metrics(self):
        """Card width W (FIXED, centered — never stretches), inner width, layout mode, and the card's
        PANEL height (border+pad included). The vertical/horizontal centering is added in _welcome_card.

        mode: 'wide' , 'stacked' (narrow → logo
        on TOP, menu below), or 'compact' (too short → 1-line header, so a phone never hits 'too small').
        """
        w, h = self._width, getattr(self, "_height", 30)
        upd = cached_update()
        margin = 4 if w < 62 else 6
        W = max(30, min(w - margin, self._CARD_W))         # capped → fixed size on big terminals
        cw_area = W - 10                                   # inside border(2) + padding(2*4)
        avail = h - self._chrome_below()
        wide_h = self._card_body_rows("wide", upd) + 6     # + border(2) + padding(2*2)
        stack_h = self._card_body_rows("stacked", upd) + 6
        if w >= self._WIDE_MIN and avail >= wide_h + 2:
            return W, cw_area, "wide", wide_h, upd
        if w >= 40 and avail >= stack_h + 2:
            return W, cw_area, "stacked", stack_h, upd
        return W, cw_area, "compact", 1, upd

    # (label, keyboard shortcut, slash command, click-action) — the card shows BOTH ways in.
    _MENU = [("New session", "Ctrl+N", "/new", "new"), ("Switch mode", "Shift+Tab", "/mode", "switch"),
             ("Commands", "type /", "/help", "commands"), ("Quit", "Ctrl+Q", "/quit", "quit")]
    _GOLD = "#E0A24E"                                       # update CTA accent (stands out, like )

    def _welcome_card(self) -> str:
        from rich import box
        from rich.padding import Padding
        from rich.panel import Panel
        from rich.text import Text
        th = style_mod.theme()
        secs = time.monotonic() - self._start
        W, cw_area, mode, card_h, upd = self._welcome_metrics()
        if mode == "compact":                              # tiny terminal → 1-line header only
            self._menu_rows = {}
            t = Text()
            t.append("╱╱╱ ", style=f"bold {th.accent}")
            t.append("Vibe DGC", style="bold #FFFFFF")
            t.append(f" v{__version__}", style=th.faint)
            t.append(f"  {glyphs.MIDDOT} /help", style=th.faint)
            if upd:
                t.append(f"  {glyphs.MIDDOT} ⬆ v"
                         + style_mod.terminal_safe_text(upd) + " /update",
                         style=f"bold {self._GOLD}")
            return self._rich(Padding(t, (0, 0, 0, 1)))

        # centre the fixed-size card on screen (like ): top-pad within the filled header height,
        # left-margin within the terminal width.
        avail = self._height - self._chrome_below()
        top_pad = max(1, (avail - card_h) // 2)
        left_margin = max(0, (self._width - W) // 2)
        base = top_pad + 3                                 # top-pad + top border(1) + panel v-pad(2)

        # ── figure logo geometry + the content-column offset FIRST, so click/hover rows are exact ──
        if mode == "stacked":
            # pad every row to the SAME width so the mark is a rigid block — then it can be centered
            # with ONE offset. Centering each row by its own length would shear the /// diagonal apart.
            logo_p = logo_mod.shimmer_lines(secs, small=True, pad=logo_mod.WIDTH_SMALL)
            text_w = cw_area
            content_off = len(logo_p) + 1                  # logo rows + one blank
            logo_w = gap = loff = 0
        else:                                              # wide
            logo_w, gap = logo_mod.WIDTH, 6                # gap = breathing room between logo and text
            text_w = cw_area - logo_w - gap
            logo_p = logo_mod.shimmer_lines(secs, small=False, pad=logo_w)
            n_right = self._right_rows(upd)
            loff = max(0, (n_right - len(logo_p)) // 2)     # centre the shorter column vertically
            content_off = max(0, (len(logo_p) - n_right) // 2)

        self._menu_rows = {}

        def hot(ci: int) -> bool:
            return (base + content_off + ci) == self._hover_row

        content: list = []

        def add(text, action=None):
            if action:
                self._menu_rows[base + content_off + len(content)] = action
            content.append(text)

        def mrow(lbl, key, slash, h):
            right = _cell_len(key) + 2 + _cell_len(slash)
            t = Text()
            t.append("› " if h else "  ", style=f"bold {th.accent}")
            t.append(lbl, style=f"bold {th.accent}" if h else "bold")
            t.append(" " * max(2, text_w - 2 - _cell_len(lbl) - right))
            t.append(key, style=th.accent if h else th.faint); t.append("  ")
            t.append(slash, style=f"bold {th.accent_bright}" if h else th.accent_dim)
            return t

        # title
        title = Text(); title.append("Vibe DGC", style="bold #FFFFFF")
        title.append(f"  v{__version__}", style=th.faint)
        if self.agent.session_name:
            title.append(f"  {glyphs.MIDDOT}  "
                         + style_mod.terminal_safe_text(self.agent.session_name), style=th.accent)
        add(title)
        add(Text(""))
        if upd:                                            # ── update available: message + clickable CTA ──
            msg = Text("v" + style_mod.terminal_safe_text(upd) + " is out",
                       style=f"bold {self._GOLD}")
            msg.append(" — update for the latest.", style=th.muted)
            add(msg)
            ci = len(content); h = hot(ci)
            cta = Text("› " if h else "", style=f"bold {self._GOLD}")
            cta.append("[ Update now ]", style=f"bold {'#FFFFFF' if h else self._GOLD}")
            cta.append("  or type ", style=th.faint); cta.append("/update", style=f"bold {self._GOLD}")
            add(cta, "update")
        else:
            add(Text("a coding agent for the models you run", style=th.muted))
        add(Text(""))
        ci = len(content); h = hot(ci)
        newc = Text("[ New session ]", style=f"bold {'#FFFFFF' if h else th.accent}")
        newc.append("  or just start typing", style=th.faint)
        add(newc, "new")
        add(Text(""))
        for lbl, key, slash, action in self._MENU:
            add(mrow(lbl, key, slash, hot(len(content))), action)

        # ── compose rows ──
        rows: list = []
        if mode == "stacked":
            block_pad = max(0, (cw_area - logo_mod.WIDTH_SMALL) // 2)   # ONE offset → diagonal intact
            for lr in logo_p:
                r = Text(" " * block_pad); r.append_text(lr); rows.append(r)
            rows.append(Text(""))
            rows.extend(content)
        else:
            n = max(len(logo_p) + loff, content_off + len(content))
            for i in range(n):
                r = Text()
                li = i - loff
                r.append_text(logo_p[li] if 0 <= li < len(logo_p) else Text(" " * logo_w))
                r.append(" " * gap)
                ci = i - content_off
                r.append_text(content[ci] if 0 <= ci < len(content) else Text(""))
                rows.append(r)

        body = Text("\n").join(rows)
        panel = Panel(body, box=box.ROUNDED, border_style=th.border_strong, padding=(2, 4), width=W)
        return self._rich(Padding(panel, (top_pad, 0, 0, left_margin)))

    # ---- status line ----
    def _status(self):
        th = style_mod.theme()
        if self._naming:
            return ANSI(self._rich(f"[bold {th.accent_bright}]{glyphs.DIAMOND}[/] [{th.text}]name this session[/] "
                                   f"[{th.faint}]· type a name then Enter (blank = unnamed) · Esc to cancel[/]"))
        if self._flash_msg and time.monotonic() < self._flash_until:
            return ANSI(self._rich(f"[{th.accent_bright}]{glyphs.DIAMOND}[/] [{th.text}]{_esc(self._flash_msg)}[/]"))
        if self._input is not None:             # a free-text prompt is waiting (host URL, MCP field, …)
            return ANSI(self._rich(f"[bold {th.accent_bright}]{glyphs.DIAMOND}[/] "
                                   f"[{th.text}]{_esc(self._input.get('prompt', ''))}[/] "
                                   f"[{th.faint}]· type then Enter · Esc to cancel[/]"))
        if self._req:
            return ANSI(self._rich(f"[bold {th.accent}]{glyphs.DIAMOND}[/] "
                                   f"[{th.text}]waiting for your answer[/] "
                                   f"[{th.faint}]· {_esc(self._req.get('hint', ''))}[/]"))
        if self._turn.is_set():
            el = time.monotonic() - self._turn_t0
            fr = glyphs.THINK_FRAMES[int(time.monotonic() * 6) % len(glyphs.THINK_FRAMES)]
            if self._streaming:
                act = "Responding"
            elif self._cur_tool:
                act = self._cur_tool            # "Run npm test" · "Read x.py" · "Search …"
            elif self._thinking:
                act = "Thinking"
            else:
                act = "Waiting"                 #  never shows a bare "Working" for an inference turn
            # per-phase timer : reset whenever the activity label changes.
            if getattr(self, "_phase_act", None) != act:
                self._phase_act, self._phase_t0 = act, time.monotonic()
            pel = time.monotonic() - self._phase_t0
            pstr = f"{pel:.1f}s" if pel < 60 else f"{int(pel // 60)}m{int(pel % 60)}s"
            #  turn-status structure: spinner + activity + phase-timer (left); total-time + ⇣tokens + [stop] (right).
            tstr = f"{el:.0f}s" if el < 60 else f"{int(el // 60)}m{int(el % 60)}s"
            toks = render_mod.fmt_tokens(self.agent.estimate_tokens())
            left = f"[{th.accent}]{fr}[/] [{th.muted}]{_esc(act)}…[/] [{th.faint}]{pstr}[/]"
            right = f"[{th.faint}]{tstr}  ⇣{toks}[/]  [{th.err}][stop][/]"
            return self._pad_lr(left, right)
        return ANSI("")                          # idle: the context bar now lives top-right in the header

    def _pad_lr(self, left: str, right: str, indent: str = "  "):
        """One row with `left` markup at the start and `right` markup flush to the terminal edge —
        the status layout (activity left; timer + tokens + [stop] right)."""
        L, R = self._rich(left), self._rich(right)
        gap = max(2, self._width - _cell_len(indent) - _ansi_cell_len(L)
                  - _ansi_cell_len(R) - 1)
        return ANSI(indent + L + " " * gap + R)

    def _model_label(self) -> str:
        """What the status displays call 'the model' — the subscription engine's
        name when delegating, otherwise the direct model DGC drives itself."""
        se = str(self.config.get("subscription_engine", "")).strip().lower()
        if se:
            from . import subscriptions as subs
            eng = subs.get_engine(se)
            if eng is not None:
                m = str(self.config.get("subscription_model", "")).strip()
                return f"{eng.short_label} · {m}" if m else f"{eng.short_label} · subscription"
        return self.config.model

    # ---- composer info line (model · mode) ----
    def _info(self):
        th = style_mod.theme()
        mode = self.agent.mode
        mc = {"default": th.muted, "acceptEdits": th.accent, "plan": th.accent_bright, "auto": th.err}
        return ANSI(self._rich(f"[{th.faint}]{_esc(self._model_label())}[/]  "
                               f"[{th.faint}]{glyphs.MIDDOT}[/]  "
                               f"[{mc.get(mode, th.muted)}]{_esc(mode)}[/]",
                               end=""))

    # ---- the rounded composer box ----
    def _border_color(self) -> str:
        th = style_mod.theme()
        return th.accent_bright if self.agent.mode == "plan" else th.border_strong

    def _hborder(self, left: str, right: str):
        w = max(4, self._width)
        c = style_mod.ansi_fg(self._border_color())
        return ANSI(f"{c}{left}{'─' * (w - 2)}{right}{style_mod.ANSI_RESET}")

    def _bottom_border(self):
        """Bottom composer border with `model · mode` embedded at the right."""
        w = max(10, self._width)
        th = style_mod.theme()
        c, dim, rst = style_mod.ansi_fg(self._border_color()), style_mod.ansi_fg(th.faint), style_mod.ANSI_RESET
        info = (f" {style_mod.terminal_safe_text(self._model_label())} {glyphs.MIDDOT} "
                f"{style_mod.terminal_safe_text(self.agent.mode)} ")
        n = w - 3 - _cell_len(info)
        if n < 2:
            return ANSI(f"{c}╰{'─' * (w - 2)}╯{rst}")
        return ANSI(f"{c}╰{'─' * n}{rst}{dim}{info}{c}─╯{rst}")

    # ------------------------------------------------------ AgentUI callbacks ---
    def on_text(self, chunk: str) -> None:
        if self._thinking:
            self._thinking = False
        self._cur_tool = None
        self._flush_think()                 # finalize any reasoning above the answer
        self._buf += style_mod.terminal_safe_text(chunk)
        self._streaming = True
        self._invalidate()

    def on_thinking(self, chunk: str) -> None:
        self._thinking = True
        if self._think_t0 is None:
            self._think_t0 = time.monotonic()   # start timing this reasoning block
        if self.config.get("show_reasoning", True):
            self._think += style_mod.terminal_safe_text(chunk)  # shown live + muted in transcript
        self._invalidate()

    def _flush_think(self) -> None:
        """Collapse the streamed reasoning to a single dim `◆ Thought for Xs` line once the answer
        starts  auto-collapse (the live reasoning still streams during the turn;
        it just folds away after, instead of leaving a wall of grey text in the transcript)."""
        if self._think.strip():
            secs = (time.monotonic() - self._think_t0) if self._think_t0 else 0
            self.blocks.append({"kind": "think", "secs": secs,        # keep the text so it can re-expand
                                "text": self._think.strip(), "exp": False})
            self._scroll_off = 0
            self._invalidate()
        self._think = ""
        self._think_t0 = None
        self._thinking = False        # reasoning is done → clear the "Thinking…" latch (a reasoning-only
        #                               turn never calls on_text, so this is the only reset it gets)

    def end_stream(self) -> None:
        self._flush_think()
        if self._buf.strip():
            self._append(self._rich(self._md(self._buf)))
        self._buf = ""; self._think = ""
        self._streaming = False
        self._cur_tool = None

    _TOOL_VERB = {"bash": "Run", "bash_output": "Read output", "read_file": "Read", "write_file": "Write",
                  "edit_file": "Edit", "apply_patch": "Patch", "repo_map": "Map repo",
                  "code_intel": "Inspect code",
                  "grep": "Search", "glob": "Find", "web_search": "Search",
                  "web_fetch": "Fetch", "task": "Delegate", "todo": "Plan", "skill": "Load skill",
                  "add_skill": "Install skill", "save_memory": "Remember"}

    # tense-aware verbs: present-progressive while running → past when done.
    _TOOL_ING = {"bash": "Running", "bash_output": "Reading output", "read_file": "Reading",
                 "write_file": "Writing", "edit_file": "Editing", "apply_patch": "Patching",
                 "repo_map": "Mapping repo", "code_intel": "Inspecting code",
                 "grep": "Searching", "glob": "Finding",
                 "web_search": "Searching", "web_fetch": "Fetching", "task": "Delegating", "todo": "Planning",
                 "skill": "Loading skill", "add_skill": "Installing skill", "save_memory": "Remembering"}
    _TOOL_ED = {"bash": "Ran", "bash_output": "Read output", "read_file": "Read", "write_file": "Wrote",
                "edit_file": "Edited", "apply_patch": "Patched", "repo_map": "Mapped repo",
                "code_intel": "Inspected code",
                "grep": "Searched", "glob": "Found", "web_search": "Searched",
                "web_fetch": "Fetched", "task": "Delegated", "todo": "Planned", "skill": "Loaded skill",
                "add_skill": "Installed skill", "save_memory": "Remembered"}

    def tool_call(self, name: str, args: dict, call_id: str | None = None) -> None:
        self._flush_text()
        self._tool_count += 1
        summary = _arg_summary(args)
        safe_name = style_mod.terminal_safe_text(name)
        verb = self._TOOL_VERB.get(name, name)          # bottom status reads "Run npm test", "Read x.py"
        verb = style_mod.terminal_safe_text(verb)
        self._cur_tool = f"{verb} {summary}".strip()[:48] if summary else verb
        # ONE stateful block for the whole step: header + result together, live accent rail while
        # it runs. tool_result fills it in. `running` drives the wave; `out`/`diff` are attached on finish.
        self.blocks.append({"kind": "tool", "name": safe_name, "route_name": name,
                            "call_id": call_id,
                            "summary": summary, "running": True,
                            "error": False, "out": None, "diff": None, "exp": False})
        if self._follow:
            self._scroll_off = 0
        self._invalidate()

    def tool_progress(self, name: str, message: str, *, progress=None, total=None,
                      level: str = "", call_id: str | None = None) -> None:
        blk = self._live_tool_block(name, call_id)
        if blk is None:
            return
        blk["progress"] = {"message": style_mod.terminal_safe_text(message)[:500],
                           "value": progress,
                           "total": total, "level": str(level)[:20]}
        self._invalidate()

    def _live_tool_block(self, name: str, call_id: str | None = None):
        """The most recent still-running tool block for `name` (this session's transcript)."""
        for blk in reversed(self.blocks):
            if (isinstance(blk, dict) and blk.get("kind") == "tool" and blk.get("running")
                    and blk.get("route_name", blk.get("name")) == name
                    and (call_id is None or blk.get("call_id") == call_id)):
                return blk
        return None

    def tool_result(self, name: str, out: str, call_id: str | None = None) -> None:
        self._cur_tool = None
        blk = self._live_tool_block(name, call_id)
        if blk is None:                                 # defensive: no matching open block → start one
            blk = {"kind": "tool", "name": style_mod.terminal_safe_text(name),
                   "route_name": name, "call_id": call_id, "summary": "", "exp": False}
            self.blocks.append(blk)
        blk["running"] = False
        from .ui import tool_output_is_error
        blk["error"] = tool_output_is_error(out)
        out = style_mod.terminal_safe_text(out)
        if "\n--- " in out or out.startswith("---"):    # a diff → render it (rich) and keep for rail-wrapping
            diff = out[out.find("---"):]
            if len(diff) < 8000:
                blk["diff"] = self._rich(render_mod.render_diff(diff))
                blk["out"] = None
            else:
                blk["out"] = out
        else:
            blk["out"] = out                            # full output kept; collapses past the preview
        if self._follow:
            self._scroll_off = 0
        self._invalidate()

    def _settle_running_tools(self) -> None:
        """Turn end / cancel: stop any tool block still marked running so its rail doesn't animate forever."""
        for blk in self.blocks:
            if isinstance(blk, dict) and blk.get("kind") == "tool" and blk.get("running"):
                blk["running"] = False

    def tool_denied(self, name: str, args: dict, reason: str,
                    call_id: str | None = None) -> None:
        th = style_mod.theme()
        self._append(self._rich(
            f"[{th.err}]{glyphs.CROSS} {_esc(name)} denied[/] [{th.faint}]{_esc(reason)}[/]"))

    # task list: icon glyph + icon colour + text style, per status.
    _TODO_STYLE = {
        "pending":     ("SQUARE", "text",  "{text}"),
        "in_progress": ("PLAY",   "warn",  "bold {text}"),
        "done":        ("CHECK",  "ok",    "strike {faint}"),
        "cancelled":   ("CROSS",  "err",   "strike {faint}"),
    }

    def on_todo(self, todos: list) -> None:
        # Store + render live in a PINNED pane above the composer , instead of
        # re-printing the whole list into the transcript on every update.
        self._todos = list(todos or [])
        self._invalidate()

    def _todos_visible(self) -> bool:
        return bool(self._todos) and (self._turn.is_set()
                                      or any(t.get("status") not in ("done", "cancelled") for t in self._todos))

    def _todo_pane_height(self) -> int:
        return (len(self._todos) + 1) if self._todos_visible() else 0   # title row + one per task

    def _todo_pane(self):
        th = style_mod.theme()
        cols = {"text": th.text, "warn": th.warn, "ok": th.ok, "err": th.err, "faint": th.faint}
        rail = f"[{th.border_strong}]{glyphs.RAIL}[/]"
        done_n = sum(1 for t in self._todos if t.get("status") == "done")
        out = [f"{rail} [bold {th.muted}]Tasks[/] [{th.faint}]{done_n}/{len(self._todos)}[/]"]
        for t in self._todos:
            g, icol, tstyle = self._TODO_STYLE.get(t.get("status"), self._TODO_STYLE["pending"])
            icon = getattr(glyphs, g)
            out.append(f"{rail} [{cols[icol]}]{icon}[/] [{tstyle.format(**cols)}]{_esc(t.get('content', ''))}[/]")
        return ANSI(self._rich("\n".join(out)))

    def info(self, msg: str) -> None:
        th = style_mod.theme()
        self._append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} {_esc(msg)}[/]"))

    def hook_activity(self, event: str, status: str, *, configured: int = 0,
                      duration_ms: int = 0, message: str = "") -> None:
        if status == "started":
            return
        suffix = f" · {message}" if message else ""
        self.info(
            f"hook {event} {status} · {configured} configured · {duration_ms}ms{suffix}")

    def goal_changed(self, goal: str, status: str) -> None:
        self._flash(f"standing goal → {status}: {goal[:70]}")

    def artifact_ready(self, art) -> None:
        """Propose opening a freshly-served localhost artifact, right in the transcript."""
        from rich.text import Text
        th = style_mod.theme()
        t = Text()
        t.append("  ▶ ", style=f"bold {th.accent}")
        t.append("Artifact ready", style=f"bold {th.text_strong}")
        t.append(f"   {style_mod.terminal_safe_text(art.name)}", style=th.muted)
        t.append("\n     ")
        t.append(style_mod.terminal_safe_text(art.url), style=f"bold {th.accent_bright}")
        t.append("   ← open in your browser", style=th.faint)
        t.append("\n     ", style=th.faint)
        t.append("/artifact", style=th.muted)
        t.append(" to open or stop running previews", style=th.faint)
        self._append(self._rich(t))
        self._flash(f"artifact live → {art.url}")

    def _open_url(self, url: str) -> bool:
        import webbrowser
        try:
            return bool(webbrowser.open(url))
        except Exception:
            return False

    def _open_artifacts(self) -> None:
        """`/artifact` — previews + reach/plan settings. Always opens (even with none) so the LAN
        and plan-mode toggles are reachable before the agent has served anything."""
        from . import artifacts
        arts = artifacts.registry()
        lan = str(self.config.get("artifact_bind", "localhost")).lower() == "lan"
        plan_on = bool(self.config.get("plan_artifact", True))
        title = f"Artifacts · {'shared on LAN' if lan else 'private (this machine)'} · plan preview: {'on' if plan_on else 'off'}"
        foot = ("Enter open · x remove · " + ("b → make private" if lan else "b → share on LAN")
                + " · p plan-artifact · Esc close")
        if arts:
            rows = [{"label": a.name, "desc": f"{a.url}  ·  up {a.uptime}", "value": a.id} for a in arts]
        else:
            rows = [{"label": "(no previews yet)",
                     "desc": "the agent serves one with the artifact tool", "value": ""}]
        # A plain-language reach explainer, ALWAYS shown, so LAN sharing isn't a mystery.
        from rich.text import Text
        th = style_mod.theme()
        if lan:
            header = [Text.from_markup(f"[{th.ok}]● Shared on your network[/][{th.faint}] — no password; "
                                       f"anyone on your Wi-Fi/LAN can open these.[/]"),
                      Text.from_markup(f"[{th.faint}]Press [/][{th.text}]b[/][{th.faint}] to make private "
                                       f"again. Open on another device at:[/]")]
            for label, url in artifacts.reachable_urls(int(self.config.get("artifact_port", 45000)),
                                                       str(self.config.get("artifact_hostname", ""))):
                header.append(Text.from_markup(
                    f"    [{th.faint}]{label:>11}[/]  [{th.accent_bright}]{_esc(url)}[/]"))
        else:
            header = [Text.from_markup(f"[{th.muted}]○ Private — only this machine can open these.[/]"),
                      Text.from_markup(f"[{th.faint}]To view on your phone or another device, press [/]"
                                       f"[{th.text}]b[/][{th.faint}] to share it on your LAN.[/]")]
        self._open_overlay(rows, on_pick=lambda r: self._artifact_open(r["value"]),
                           on_action=self._artifact_action, title=title, footer=foot,
                           header=header, accent=True)

    def _artifact_open(self, aid: str) -> None:
        from . import artifacts
        art = artifacts.get(aid) if aid else None
        if not art:
            return
        opened = self._open_url(art.url)
        self._flash((f"opened {art.url}" if opened else f"open {art.url} in your browser"))

    def _artifact_action(self, key: str, row) -> None:
        from . import artifacts
        if key == "b":                                   # toggle localhost <-> LAN reach
            if str(self.config.get("artifact_bind", "localhost")).lower() == "lan":
                self._set_artifact_bind(False)           # LAN → localhost needs no confirm
            else:
                self._confirm_lan_share()                # network exposure (no auth) → confirm first
            return
        if key == "p":                                   # toggle the sanitized automatic plan preview
            on = not bool(self.config.get("plan_artifact", True))
            self.config.set("plan_artifact", on)
            self._flash("automatic plan previews on (always private to this machine)"
                        if on else "automatic plan previews off")
            self._open_artifacts()
            return
        if row and row.get("value") and key in ("x", "space"):
            self._confirm_remove_artifact(row["value"], row.get("label", "this artifact"))

    def _confirm_remove_artifact(self, aid: str, name: str) -> None:
        """Ask before removing an artifact — a stop is easy to hit by accident on the wrong row."""
        from rich.text import Text
        from . import artifacts
        th = style_mod.theme()
        def _do(r):
            if r["value"] == "yes":
                artifacts.stop(aid)
                self._flash(f"removed {name[:40]}")
            self._open_artifacts()                       # back to the list either way (refreshed)
        header = [Text.from_markup(f"[bold]Remove this preview?[/]  [{th.muted}]{_esc(name[:60])}[/]"),
                  Text.from_markup(f"[{th.faint}]Stops serving it and drops it from the list. The .html "
                                   f"file on disk is untouched.[/]")]
        rows = [{"label": f"{glyphs.CROSS}  Remove", "value": "yes"},
                {"label": f"{glyphs.CHECK}  Keep it", "value": "no"}]
        self._open_overlay(rows, header=header, footer="Enter select · Esc cancel", accent=True,
                           on_pick=_do)

    def _confirm_lan_share(self) -> None:
        """Confirm before binding 0.0.0.0 — a no-auth network exposure — and show the shareable URL."""
        from rich.text import Text
        from . import artifacts
        th = style_mod.theme()
        ip = artifacts._lan_ip()
        port = int(self.config.get("artifact_port", 45000))
        where = f"http://{ip}:{port}" if ip != "127.0.0.1" else "(no LAN IP found — are you on a network?)"
        header = [Text.from_markup("[bold]Share artifacts on your LAN?[/]"),
                  Text.from_markup(f"[{th.warn}]Anyone on this network can open your artifacts — "
                                   f"there is no password.[/]"),
                  Text.from_markup(f"[{th.muted}]They'll reach it at [/][{th.accent_bright}]{_esc(where)}[/]"
                                   f"[{th.muted}]  · the localhost URL keeps working too.[/]")]
        rows = [{"label": f"{glyphs.CHECK}  Share on LAN", "value": "yes"},
                {"label": f"{glyphs.CROSS}  Cancel", "value": "no"}]
        self._open_overlay(rows, header=header, footer="Enter select · Esc cancel", accent=True,
                           on_pick=lambda r: self._set_artifact_bind(True) if r["value"] == "yes" else None)

    def _set_artifact_bind(self, lan: bool) -> None:
        from . import artifacts
        self.config.set("artifact_bind", "lan" if lan else "localhost")
        artifacts.set_bind(lan, int(self.config.get("artifact_port", 45000)))
        if lan:
            urls = artifacts.reachable_urls(int(self.config.get("artifact_port", 45000)),
                                            str(self.config.get("artifact_hostname", "")))
            share = [f"{lbl}: {u}" for lbl, u in urls if lbl != "this machine"]
            if share:                                    # surface EVERY address (selectable via /copy)
                self.info("artifacts shared (no password) — reachable at:  " + "   ".join(share))
            else:
                self._flash("LAN mode on, but no LAN/Tailscale address was found — are you on a network?")
        else:
            self._flash("artifacts now localhost-only (this machine)")
        self._open_artifacts()

    def error(self, msg: str) -> None:
        th = style_mod.theme()
        self._append(self._rich(f"[{th.err}]error:[/] {_esc(msg)}"))

    def add_permission_rule(self, name: str, args: dict) -> None:
        from .permissions import Rule, rule_for
        try:
            r = str(rule_for(name, args))
            Rule.parse(r, "allow")
            self.config.permissions.setdefault("allow", []).append(r)
            self.config.save()
        except Exception:
            pass

    def _flush_text(self) -> None:
        self._flush_think()
        if self._buf.strip():
            self._append(self._rich(self._md(self._buf)))
        self._buf = ""; self._think = ""
        self._streaming = False

    # ---- blocking prompts (run on the worker thread; answered by the UI) ----
    def _show_req_overlay(self, sess: "AgentSession") -> None:
        """Open the approval/plan/options card for `sess`'s pending request (on screen now)."""
        req = sess._req
        if not req:
            return
        options = req.get("options", [])
        rows = [{"label": f"{i + 1}  {o}", "value": i} for i, o in enumerate(options)]   # 1-9 shortcuts
        self._open_overlay(rows, on_pick=sess._req_pick, title=req.get("title"), header=req.get("header"),
                           footer=req.get("footer", "↑↓ move · 1-9 or Enter select · Esc cancel"),
                           accent=True)

    def _ask(self, req: dict, cancel=None):
        """A blocking prompt for the CALLING session. Runs on that session's worker thread; the UI
        thread answers via on_pick / number keys / Esc. If the session is on screen the card opens
        now; if it's a BACKGROUND agent, the request is parked (◆ needs you) until you switch to it."""
        sess = self._cur_session()
        sess._req = req
        sess._req_event.clear()

        def pick(row):
            sess._req_answer = row["value"]
            sess._req_event.set()
        sess._req_pick = pick
        if sess is self.active:
            self._show_req_overlay(sess)
        else:
            self._flash(f"◆ {sess.name or 'agent'} needs you — ^\\ to answer")
        self._invalidate()

        while not sess._req_event.wait(0.1):
            if cancel is not None and cancel.is_set():
                sess._req_answer = None
                break
        sess._req = None
        if sess is self.active and self._overlay is not None:
            self._overlay = None                        # close (option chosen or Esc-cancelled)
        self._invalidate()
        return sess._req_answer

    def approve(self, name: str, args: dict, call_id: str | None = None) -> str:
        from rich.text import Text
        self._flush_text()
        th = style_mod.theme()
        header = [Text(f"{glyphs.RAIL} Allow ", style="bold").append(
                  style_mod.terminal_safe_text(name), style=f"bold {th.accent}")
                  .append(" to run?", style="bold")]
        if name == "bash" and args.get("command"):      # show the shell command itself
            for ln in style_mod.terminal_safe_text(args["command"]).splitlines()[:6]:
                header.append(Text("  $ ", style=th.faint).append(ln, style=th.text))
        else:
            detail = _arg_summary(args)
            if detail:
                header.append(Text("  " + detail, style=th.muted))
        ans = self._ask({"kind": "approve", "header": header,
                         "options": ["Allow once", "Always allow this", "Deny", "Deny with a reason"],
                         "footer": "↑↓ · 1 allow · 2 always · 3 deny · Enter select · Esc deny"})
        if ans == 3:                                     # deny + tell the model why (steers the retry)
            self.deny_reason = self._ask_text("why / what to do instead:")
            return "no"
        self.deny_reason = ""
        return {0: "once", 1: "always"}.get(ans, "no")

    def _ask_text(self, prompt: str, cancel=None) -> str:
        """A BLOCKING free-text prompt (worker thread) — used to capture a denial reason."""
        result = {"v": ""}
        self._req_event.clear()

        def cb(text):
            result["v"] = text
            self._req_event.set()
        self._input = {"cb": cb, "prompt": prompt}
        self._invalidate()
        while not self._req_event.wait(0.1):
            if cancel is not None and cancel.is_set():
                break
        self._input = None
        self._invalidate()
        return result["v"].strip()

    def present_plan(self, plan: str):
        self._flush_text()
        th = style_mod.theme()
        self._append(self._rich(f"[bold {th.accent}]{glyphs.BULLET} proposed plan[/]\n"
                                + self._rich(self._md(plan or "(empty plan)"))))
        ans = self._ask({"kind": "plan",
                         "options": ["Build (accept edits)", "Build (default)", "Build it (auto)", "Keep planning"],
                         "footer": "↑↓ · Enter build · Esc keep planning"})
        target = {0: "acceptEdits", 1: "default", 2: "auto"}.get(ans)
        if target == "auto":
            from rich.text import Text
            th = style_mod.theme()
            confirm = self._ask({"kind": "plan-auto",
                                 "header": [Text("Full-auto executes every plan write and shell command "
                                                 "without another prompt.", style=th.warn)],
                                 "options": ["Enable full-auto and build", "Keep planning"],
                                 "footer": "Enter confirm · Esc keep planning"})
            if confirm != 0:
                self.plan_feedback = "Full-auto was not confirmed; offer a safer execution mode."
                return None
        if target:
            self.plan_feedback = ""
            return target
        self.plan_feedback = self._ask_text("what should change in the plan (optional):")
        return None

    def propose_options(self, question: str, options: list[str]) -> str:
        from rich.text import Text
        self._flush_text()
        ans = self._ask({"kind": "options", "options": list(options),
                         "header": [Text(style_mod.terminal_safe_text(question), style="bold")]})
        return options[ans] if isinstance(ans, int) and 0 <= ans < len(options) else options[0]

    def mcp_capabilities(self) -> dict:
        return {"sampling": {}, "elicitation": {"form": {}, "url": {}}}

    def mcp_input(self, server: str, kind: str, payload: dict, *, cancel=None) -> dict:
        """Park a consent card on the owning fleet session and fail closed on dismissal."""
        from rich.text import Text
        self._flush_text()
        if cancel is not None and cancel.is_set():
            return {"action": "cancel"}
        th = style_mod.theme()
        self._append(self._rich(
            f"[bold {th.accent}]MCP input requested · {_esc(str(server)[:120])}[/]"))
        if kind in ("sampling_request", "sampling_response"):
            title = ("Allow this server to ask your model?" if kind == "sampling_request"
                     else "Share this generated response with the server?")
            preview = style_mod.terminal_safe_text(
                json.dumps(payload, ensure_ascii=False, indent=2))[:12_000]
            self._append(self._rich(f"[bold]{_esc(title)}[/]\n[{th.muted}]{_esc(preview)}[/]"))
            ans = self._ask({"kind": kind,
                             "header": [Text(title, style="bold")],
                             "options": ["Approve once", "Decline", "Cancel"],
                             "footer": "review carefully · Esc cancels"}, cancel=cancel)
            return {"action": {0: "accept", 1: "decline"}.get(ans, "cancel")}
        if kind != "elicitation":
            return {"action": "cancel"}

        message = style_mod.terminal_safe_text(payload.get("message") or "")
        self._append(self._rich(_esc(message)))
        if payload.get("mode") == "url":
            url, host = str(payload.get("url") or ""), str(payload.get("host") or "")
            warning = ("\n[bold red]Punycode host — inspect for lookalike characters.[/]"
                       if payload.get("suspicious_host") else "")
            self._append(self._rich(
                f"[bold]Host: {_esc(host)}[/]\n[{th.muted}]{_esc(url)}[/]{warning}"))
            ans = self._ask({"kind": "mcp-url",
                             "header": [Text("Open this exact URL outside DGC?", style="bold")],
                             "options": ["Open in browser", "Decline", "Cancel"],
                             "footer": "the server cannot see browser input · Esc cancels"}, cancel=cancel)
            if ans != 0:
                return {"action": "decline" if ans == 1 else "cancel"}
            if cancel is not None and cancel.is_set():
                return {"action": "cancel"}
            try:
                opened = webbrowser.open(url, new=2)
            except Exception:
                opened = False
            if not opened:
                self.error("could not open the MCP URL in a browser")
                return {"action": "cancel"}
            return {"action": "accept"}

        schema = payload.get("requestedSchema") or {}
        properties = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        from .mcp import MCPInputError, _form_options, validate_elicitation_response
        while True:
            content: dict = {}
            try:
                for key, field in properties.items():
                    label = style_mod.terminal_safe_text(field.get("title") or key)
                    optional = key not in required
                    options = _form_options(field)
                    field_kind = field.get("type")
                    if field_kind == "array":
                        titles = [style_mod.terminal_safe_text(item.get("title")) for item in
                                  (field.get("items") or {}).get("anyOf", [])] or options
                        self._append(self._rich(_esc(
                            f"{label}: " + ", ".join(f"{i + 1}={v}" for i, v in enumerate(titles)))))
                        raw = self._ask_text(
                            f"{label} · comma-separated numbers{' · blank skips' if optional else ''}:",
                            cancel=cancel)
                        if cancel is not None and cancel.is_set():
                            return {"action": "cancel"}
                        if not raw and optional:
                            continue
                        picks = [] if not raw else [int(part.strip()) - 1 for part in raw.split(",")]
                        content[key] = [options[i] for i in picks if 0 <= i < len(options)]
                    elif options:
                        labels = ([style_mod.terminal_safe_text(item.get("title"))
                                   for item in field.get("oneOf", [])]
                                  or [style_mod.terminal_safe_text(item)
                                      for item in (field.get("enumNames") or [])]
                                  or [style_mod.terminal_safe_text(item) for item in options])
                        rows = list(labels) + (["Skip this field"] if optional else [])
                        ans = self._ask({"kind": "mcp-form-field",
                                         "header": [Text(label, style="bold")],
                                         "options": rows}, cancel=cancel)
                        if ans is None:
                            return {"action": "cancel"}
                        if optional and ans == len(labels):
                            continue
                        content[key] = options[ans]
                    elif field_kind == "boolean":
                        rows = ["Yes", "No"] + (["Skip this field"] if optional else [])
                        ans = self._ask({"kind": "mcp-form-field", "header": [Text(label, style="bold")],
                                         "options": rows}, cancel=cancel)
                        if ans is None:
                            return {"action": "cancel"}
                        if optional and ans == 2:
                            continue
                        content[key] = ans == 0
                    else:
                        default = field.get("default")
                        raw = self._ask_text(
                            f"{label}{f' · default {default}' if default is not None else ''}"
                            f"{' · optional' if optional else ''}:", cancel=cancel)
                        if cancel is not None and cancel.is_set():
                            return {"action": "cancel"}
                        if not raw and default is not None:
                            value = default
                        elif not raw and optional:
                            continue
                        elif field_kind == "integer":
                            value = int(raw)
                        elif field_kind == "number":
                            value = float(raw)
                        else:
                            value = raw
                        content[key] = value
                candidate = validate_elicitation_response(
                    payload, {"action": "accept", "content": content})
            except (ValueError, IndexError, MCPInputError) as exc:
                self.error(f"invalid form response: {exc}")
                continue
            preview = json.dumps(candidate["content"], ensure_ascii=False, indent=2)
            self._append(self._rich(
                f"[bold]Review before sharing[/]\n[{th.muted}]{_esc(preview)}[/]"))
            ans = self._ask({"kind": "mcp-form-review",
                             "options": ["Submit these values", "Edit answers", "Decline", "Cancel"],
                             "footer": "nothing is sent until Submit · Esc cancels"}, cancel=cancel)
            if ans == 0:
                return candidate
            if ans == 2:
                return {"action": "decline"}
            if ans != 1:
                return {"action": "cancel"}

    # --------------------------------------------------------------- the app ---
    def _build(self) -> None:
        # `/` opens the command palette as an overlay (see the `/` key binding) — no completer.
        self.input_buf = Buffer(multiline=True, auto_suggest=_NextSuggest(self))   # ghost-text next-prompt

        header = Window(_ClickControl(self._header, self._menu_click, self._menu_hover),
                        height=self._header_height, align="center")
        transcript = Window(_ClickControl(self._transcript, on_scroll=self._wheel), wrap_lines=True,
                            scroll_offsets=ScrollOffsets(top=self._scroll_top_offset),
                            height=Dimension(weight=1))   # scroll is driven by the cursor marker (_cursor_ft)
        self._transcript_win = transcript
        status = Window(FormattedTextControl(self._status), height=1, style="class:status")
        secret_input = Condition(lambda: self._input is not None and self._input.get("secret") is True)
        composer = Window(BufferControl(
                              self.input_buf, focus_on_click=True,
                              input_processors=[ConditionalProcessor(
                                  PasswordProcessor(char="•"), filter=secret_input)]),
                          get_line_prefix=self._line_prefix, wrap_lines=True,
                          height=self._composer_height, style="class:composer")
        side = lambda: f"fg:{self._border_color()}"          # noqa: E731
        composer_box = HSplit([
            Window(FormattedTextControl(lambda: self._hborder("╭", "╮")), height=1),
            VSplit([
                Window(width=1, char="│", style=side),
                composer,
                Window(width=1, char="│", style=side),
            ]),
            Window(FormattedTextControl(self._bottom_border), height=1),
        ])
        shortcut_bar = Window(FormattedTextControl(self._shortcut_bar), height=1, style="class:status")
        # The floating overlay (pickers / tabbed modal) grows a region ABOVE the composer —
        # it pushes the transcript up instead of dumping the menu into the chat.
        overlay_panel = ConditionalContainer(
            Window(_ClickControl(self._render_overlay, self._overlay_click, self._overlay_hover),
                   height=self._overlay_height,
                   dont_extend_height=True),
            filter=Condition(lambda: self._overlay is not None))
        # A live task list pinned just above the composer  — shows while a turn
        # runs or any task is still open, then folds away.
        todo_panel = ConditionalContainer(
            Window(FormattedTextControl(self._todo_pane), height=self._todo_pane_height,
                   dont_extend_height=True),
            filter=Condition(self._todos_visible))
        root = HSplit([header, transcript, overlay_panel, todo_panel, status, composer_box, shortcut_bar])
        # Adaptive colour depth (grey logo + solid accents stay clean at any depth); the dark
        # canvas is handled separately via OSC 10/11 (dgc/termbg.py).
        # Mouse capture ON so the wheel scrolls DGC's own transcript instead of the
        # terminal's scrollback (which would show pre-DGC output). Copy text with Option/Shift-drag.
        self.app = Application(layout=Layout(root, focused_element=composer),
                               key_bindings=self._keys(), full_screen=True,
                               mouse_support=Condition(lambda: self._mouse_on),
                               style=self._pt_style(), refresh_interval=0.08,
                               # NOT erase_when_done: full-screen uses the alternate screen, which the
                               # terminal restores on exit. erase_when_done ALSO erases on top of that
                               # and, with the tall centered header, left ~a screen of blank lines.
                               color_depth=style_mod.detect_color_depth())

    def _header_height(self) -> int:
        if self.blocks or self._buf or self._overlay:
            return 1
        self._sync_width()
        _, _, mode, card_h, _ = self._welcome_metrics()
        if mode == "compact":                   # tiny / in-between terminal → 1-line header
            return 1
        # Fill the space above the tip/status/composer so the card can float centered vertically
        # inside it (_welcome_card's top-pad does the centering).
        return max(card_h, self._height - self._chrome_below())

    def _composer_height(self) -> int:
        # Grow vertically with WRAPPED lines, not just explicit newlines: the composer wraps
        # (wrap_lines=True), so a long line past the terminal width needs extra rows or its tail hides.
        w = max(8, self._width - 5)                     # inside the │ borders, minus the `❯ ` prefix
        rows = 0
        for ln in self.input_buf.text.split("\n"):
            rows += max(1, math.ceil(_cell_len(ln) / w))  # visual cells, not Unicode code points
        # CAP it to the terminal: always leave >=2 rows for the transcript/header + the fixed
        # chrome (status 1 + box borders 2 + shortcut 1) so a long prompt on a SMALL phone screen
        # grows + scrolls INSIDE the box instead of overflowing the layout ("window too small").
        cap = max(1, self._height - 6)
        return min(max(1, rows), cap, 14)

    def _chrome_below(self) -> int:
        # the actual rows under the header: status(1) + composer box(composer+2) + shortcut(1).
        return self._composer_height() + 4

    def _line_prefix(self, line_no, wrap_count):
        th = style_mod.theme()
        if line_no == 0 and wrap_count == 0:
            return ANSI(f" {style_mod.ansi_fg(th.accent)}{glyphs.ARROW}{style_mod.ANSI_RESET} ")
        return "   "

    def _pt_style(self):
        from prompt_toolkit.styles import Style
        th = style_mod.theme()
        # The dark canvas is set at the TERMINAL level via OSC 10/11 in termbg.apply() (a
        # light phone/SSH terminal is repainted dark; an already-dark one is left alone). We only
        # define foregrounds here — prompt_toolkit won't reliably fill empty cells with a bg.
        return Style.from_dict({
            "": f"fg:{th.text}",
            "rule": f"fg:{th.border}",
            "status": f"fg:{th.muted}",
            "composer": f"fg:{th.text}",
            # the `/` command palette (dropdown above the composer)
            "completion-menu": f"bg:{th.surface} fg:{th.muted}",
            "completion-menu.completion": f"bg:{th.surface} fg:{th.text}",
            "completion-menu.completion.current": f"bg:{th.accent} fg:{th.bg} bold",
            "completion-menu.meta.completion": f"bg:{th.surface} fg:{th.faint}",
            "completion-menu.meta.completion.current": f"bg:{th.accent} fg:{th.bg}",
            "scrollbar.background": f"bg:{th.surface}",
            "scrollbar.button": f"bg:{th.accent}",
        })

    # ---- shared menu actions (invoked by both keys and mouse clicks) ----
    def _prompt_new_session(self) -> None:
        """Spawn a fresh agent into the fleet immediately (even while another is running — that's
        the point). A title is auto-derived from the first prompt; /name overrides it."""
        self._new_session()

    def _cancel_auxiliary(self) -> None:
        """Cancel every low-priority model request before any foreground turn starts."""
        for session in list(getattr(self, "_sessions", ())):
            session._aux_generation += 1
            session._aux_cancel.set()
            session._autotitle_pending = False

    def _name_session(self, sess, name: str) -> bool:
        """Apply an explicit name and retire any now-obsolete automatic title request."""
        value = name.strip()
        if not value:
            return False
        sess._aux_generation += 1
        sess._aux_cancel.set()
        sess._autotitle_pending = False
        sess._autotitled = True
        saved = sess.agent.name_session(value) is not False
        if not saved:
            self._flash(getattr(sess.agent, "_last_persist_error", "") or "session rename failed")
        return saved

    def _foreground_aux_barrier(self) -> None:
        """Wait until a canceled auxiliary call releases the shared local-model slot."""
        lock = getattr(self, "_aux_lock", None)
        if lock is None:
            return
        lock.acquire()
        lock.release()

    def _autotitle(self, sess, prompt: str, cancel=None) -> None:
        """Background: derive a session title from the first prompt and apply it, unless the user
        already named it. Silent on failure."""
        self._tls.session = sess        # route _active_prop reads/writes to the session that FINISHED,
        #                                 not whatever is on screen now (fleet: user may have switched)
        try:
            title = self.agent.generate_title(prompt, cancel=cancel)
        except Exception:
            title = None
        if title and not (cancel and cancel.is_set()) and not self.agent.session_name:
            if self.agent.name_session(title) is not False:
                self._invalidate()

    def _do_handoff(self, sess) -> None:
        """Background: generate a HANDOFF document from the whole session, save it to a file the user
        can hand to another agent, and show it in the transcript (selectable via /copy)."""
        self._tls.session = sess        # route the transcript output to the session /handoff was run in
        try:
            md = self.agent.generate_handoff(save=True)
        except Exception as e:
            self.error(f"handoff failed: {type(e).__name__}: {e}")
            return
        path = self.agent._last_handoff_path
        saved = str(path) if path else ""
        self._append(self._rich(self._md(md)))          # show the handoff in the chat
        th = style_mod.theme()
        if saved:
            self._append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} handoff saved to [/]"
                                    f"[{th.accent_bright}]{_esc(saved)}[/]"
                                    f"[{th.faint}] — hand this file (or the text above) to another agent[/]"))
        self._flash(f"handoff saved → {path.name}" if path else
                    (self.agent._last_handoff_error or "handoff ready above (couldn't write a file)"))

    def _compute_suggestion(self, sess, prompt: str, resp: str, cancel=None) -> None:
        """Background: predict the next prompt (ghost text)."""
        self._tls.session = sess        # bind to the finishing session (see _autotitle) so a fleet
        #                                 switch during this ~1s window can't ghost-text the wrong session
        try:
            s = self.agent.suggest_next(prompt, resp, cancel=cancel)
        except Exception:
            s = None
        if cancel and cancel.is_set():
            return
        self._suggestion = s
        self._invalidate()

    def _schedule_auxiliary(self, sess, prompt: str, resp: str, *,
                            title: bool, suggestion: bool) -> None:
        """Run title then suggestion only while the whole fleet is idle.

        One lock serializes auxiliary generations across sessions. A new foreground prompt sets the
        per-job cancellation event and waits at the lock boundary, preventing title/suggestion work
        from consuming the same local model concurrently with a real turn.
        """
        if not title and not suggestion:
            return
        sess._aux_generation += 1
        generation = sess._aux_generation
        sess._aux_cancel.set()
        cancel = threading.Event()
        sess._aux_cancel = cancel
        if title:
            sess._autotitle_pending = True
        delay = max(0, min(60_000, int(sess.config.get("aux_idle_delay_ms", 750)))) / 1000.0

        def work():
            self._tls.session = sess
            acquired = False
            title_attempted = False
            try:
                if cancel.wait(delay):
                    return
                deadline = time.monotonic() + 30.0
                while not cancel.is_set() and time.monotonic() < deadline:
                    fleet = list(getattr(self, "_sessions", (sess,)))
                    if any(s._turn.is_set() or s._queue for s in fleet):
                        cancel.wait(0.1)
                        continue
                    lock = getattr(self, "_aux_lock", None)
                    if lock is None or lock.acquire(blocking=False):
                        acquired = lock is not None
                        if any(s._turn.is_set() or s._queue for s in fleet):
                            if acquired:
                                lock.release()
                                acquired = False
                            cancel.wait(0.1)
                            continue
                        break
                    cancel.wait(0.1)
                else:
                    return
                if cancel.is_set():
                    return
                if title:
                    title_attempted = True
                    self._autotitle(sess, prompt, cancel=cancel)
                fleet = list(getattr(self, "_sessions", (sess,)))
                if (suggestion and not cancel.is_set()
                        and not any(s._turn.is_set() or s._queue for s in fleet)):
                    self._compute_suggestion(sess, prompt, resp, cancel=cancel)
            finally:
                if acquired:
                    self._aux_lock.release()
                if sess._aux_generation == generation:
                    sess._autotitle_pending = False
                    if title_attempted and not cancel.is_set():
                        sess._autotitled = True

        sess._aux_thread = threading.Thread(
            target=work, name=f"dgc-aux-{sess.id}", daemon=True)
        sess._aux_thread.start()

    def _new_session(self, name: str | None = None, session_path=None) -> AgentSession | None:
        """Spawn/reopen a fleet agent in an automatically isolated Git worktree.

        The initial launch session stays in the checkout the user selected. Every additional Git
        session receives an exact tracked/non-ignored-untracked snapshot under the source mutation
        lease. Non-Git projects retain the shared-checkout fallback and say so explicitly.
        """
        if not session_path:
            return self._new_session_reserved(name=name, session_path=session_path)
        from . import sessions as _sess
        try:
            turn_lease = _sess.session_turn_lock(session_path, self._fleet_root)
            turn_acquired = turn_lease.acquire(blocking=False)
        except (OSError, TypeError, ValueError):
            turn_lease, turn_acquired = None, False
        if not turn_acquired:
            self._flash("couldn't open session — it has an active turn in another DGC process")
            return None
        try:
            return self._new_session_reserved(name=name, session_path=session_path)
        finally:
            turn_lease.release()

    def _new_session_reserved(self, name: str | None = None,
                              session_path=None) -> AgentSession | None:
        """Build and durably associate a fleet runtime while its saved session is reserved."""
        from . import sessions as _sess, worktree as _wt
        from .config import Config as _Config
        from .scheduler import workspace_mutation_lock

        source_config = _Config(self._fleet_root)
        configured = str(source_config.get("fleet_worktree_root", "") or "").strip()
        storage_root = Path(configured).expanduser() if configured else None
        workspace = None
        kind = "shared"
        root = self._fleet_root
        association = _sess.load_workspace(session_path, self._fleet_root) if session_path else None
        attach_error = ""

        if association and association.get("kind") == "managed":
            workspace, attach_error = _wt.FleetWorkspace.attach(
                self._fleet_root, association, storage_root)
            if workspace is not None:
                kind, root = "managed", workspace.project_root
        elif association and association.get("kind") == "manual":
            candidate = Path(association.get("worktree", "")).resolve(strict=False)
            candidate_repo = _wt.repo_root(candidate) if candidate.is_dir() else None
            registered = next((row for row in _wt.list_worktrees(self._fleet_root)
                               if candidate_repo is not None
                               and Path(row.get("path", "")).resolve(strict=False) == candidate_repo), None)
            if (candidate.is_dir() and candidate_repo is not None and registered
                    and registered.get("branch", "") == association.get("branch", "")):
                kind, root = "manual", candidate
            else:
                attach_error = "saved manual worktree is missing or no longer on the recorded branch"

        if kind == "shared":
            repo = _wt.repo_root(self._fleet_root)
            if repo is not None:
                lease = workspace_mutation_lock(self._fleet_root)
                if not lease.acquire(timeout=10.0):
                    detail = lease.last_error or "the source checkout stayed busy for 10 seconds"
                    self._flash(f"couldn't create an isolated agent — {detail}")
                    return None
                try:
                    label = name or (Path(session_path).stem if session_path else f"agent-{len(self._sessions) + 1}")
                    workspace, error = _wt.FleetWorkspace.prepare(
                        self._fleet_root, label, storage_root)
                finally:
                    lease.release()
                if workspace is None:
                    self._flash(f"couldn't create an isolated agent — {error}")
                    return None
                kind, root = "managed", workspace.project_root
            elif attach_error:
                self._flash(f"{attach_error}; reopening in the shared non-Git project")

        try:
            session_config = _Config(root)
            agent = Agent(session_config, self)
            agent.session_root = self._fleet_root
            if session_path:
                agent.load_session(session_path)
            else:
                agent.session_file = _sess.new_path(self._fleet_root)
            sess = AgentSession(session_config, self, agent=agent)
            sess.workspace = workspace
            sess.workspace_kind = kind
            sess.workspace_path = Path(root).resolve(strict=False)
            sess.workspace_branch = (workspace.branch if workspace is not None
                                     else (str((association or {}).get("branch", ""))
                                           if kind == "manual" else ""))
            if kind == "managed" and workspace is not None:
                associated = _sess.save_workspace(
                    agent.session_file, self._fleet_root, kind="managed",
                    worktree=workspace.path, branch=workspace.branch,
                    metadata=workspace.metadata_path, **_session_generation_guard(agent))
            elif kind == "manual":
                associated = _sess.save_workspace(
                    agent.session_file, self._fleet_root, kind="manual",
                    worktree=root, branch=sess.workspace_branch,
                    **_session_generation_guard(agent))
            elif session_path:
                associated = _sess.clear_workspace(
                    agent.session_file, self._fleet_root, **_session_generation_guard(agent))
            else:
                associated = True
            if not associated:
                if workspace is not None:
                    workspace.retain("session association changed during startup", [])
                    workspace = None  # the generic exception cleanup must not delete uncertain work
                raise RuntimeError("the saved session changed while attaching its workspace")
        except Exception as exc:
            if workspace is not None:
                workspace.finish("fleet session startup failed")
            self._flash(f"couldn't start agent — {type(exc).__name__}: {exc}")
            return None

        if name:
            self._name_session(sess, name)
        self._sessions.append(sess)
        self._naming = False
        self._switch_to(len(self._sessions) - 1)
        place = (f"isolated {sess.workspace_branch}" if kind != "shared"
                 else "non-Git shared checkout · writes serialized")
        note = f" · prior workspace unavailable: {attach_error}" if attach_error else ""
        self._flash(f"{'opened' if session_path else 'new agent'}{f': {name}' if name else ''}"
                    f" · {len(self._sessions)} agents · {place}{note}")
        return sess

    def _open_saved_session(self, path) -> None:
        sess = self._new_session(session_path=path)
        if sess is None:
            return
        sess.blocks.clear(); sess._buf = ""; sess._think = ""
        self._render_history()
        count = max(0, len(sess.agent.messages) - 1)
        self._flash(f"opened ({count} messages) · "
                    + (f"isolated {sess.workspace_branch}" if sess.workspace_branch else "shared checkout"))

    def _switch_to(self, idx: int) -> None:
        """Make session `idx` the active (on-screen) one; the others keep running in the background."""
        if not self._sessions:
            return
        if self._overlay is None:                        # stash a REAL draft, not an overlay's filter text
            self.active.draft = self.input_buf.text
        self._active_idx = max(0, min(idx, len(self._sessions) - 1))
        self._close_overlay()
        self.input_buf.reset()
        if self.active.draft:
            self.input_buf.insert_text(self.active.draft)
        if self.active._req is not None:                 # this agent was waiting on you → show its card
            self._show_req_overlay(self.active)
        self._invalidate()

    def _finalize_session_workspace(self, sess: AgentSession, reason: str,
                                    *, retain_if_running: bool = False):
        """Finish one managed checkout exactly once; uncertain/changed state is always retained."""
        workspace = getattr(sess, "workspace", None)
        if workspace is None:
            return None
        with sess._workspace_lock:
            if sess._workspace_finalized:
                return None
            worker = sess._worker_thread
            running_elsewhere = bool(worker and worker.is_alive()
                                     and worker is not threading.current_thread())
            if running_elsewhere:
                if retain_if_running:
                    workspace.retain(reason, [])
                return None
            from . import sessions as _sess

            def retain_uncertain(detail):
                error = workspace.retain(detail, []) or ""
                from .worktree import FleetWorkspaceResult
                result = FleetWorkspaceResult(
                    "error" if error else "retained", workspace.path, workspace.branch,
                    error=error)
                sess._workspace_finalized = True
                return result

            try:
                turn_lease = _sess.session_turn_lock(
                    sess.agent.session_file, self._fleet_root)
                turn_acquired = turn_lease.acquire(blocking=False)
            except (OSError, TypeError, ValueError):
                turn_lease, turn_acquired = None, False
            if not turn_acquired:
                return retain_uncertain(
                    f"{reason}: session has an active turn in another DGC process")
            try:
                guard = _session_generation_guard(sess.agent)
                if guard and not _sess.generation_matches(
                        sess.agent.session_file, self._fleet_root, **guard):
                    return retain_uncertain(
                        f"{reason}: session generation changed in another process")
                result = workspace.finish(reason)
                sess._workspace_finalized = True
                if result.status == "cleaned":
                    if sess.agent.session_file:
                        associated = _sess.clear_workspace(
                            sess.agent.session_file, self._fleet_root,
                            **_session_generation_guard(sess.agent))
                        if not associated:
                            self._flash(
                                "workspace cleaned, but the session association changed elsewhere")
                elif sess.agent.session_file:
                    associated = _sess.save_workspace(
                        sess.agent.session_file, self._fleet_root, kind="managed",
                        worktree=workspace.path, branch=workspace.branch,
                        metadata=workspace.metadata_path,
                        **_session_generation_guard(sess.agent))
                    if not associated:
                        self._flash("retained workspace association changed in another process")
                return result
            finally:
                turn_lease.release()

    def _close_session(self, idx: int) -> None:
        """Stop + remove a session, safely resolving any DGC-owned checkout."""
        if not (0 <= idx < len(self._sessions)) or len(self._sessions) <= 1:
            self._flash("can't close the only session"); return
        sess = self._sessions.pop(idx)
        sess._closing = True
        with sess._queue_lock:
            sess._queue.clear()
        try:
            sess._aux_cancel.set()
            sess.agent.cancelled.set()                   # stop its turn if one is running
            sess._req_answer = None
            sess._req_event.set()                        # never strand a worker awaiting approval
            sess.agent.mcp.stop_all()
        except Exception:
            pass
        worker = sess._worker_thread
        if worker and worker.is_alive() and worker is not threading.current_thread():
            worker.join(0.25)
        result = self._finalize_session_workspace(
            sess, "fleet session closed", retain_if_running=True)
        if self._active_idx >= len(self._sessions):
            self._active_idx = len(self._sessions) - 1
        elif idx < self._active_idx:
            self._active_idx -= 1
        if result is not None:
            if result.status == "cleaned":
                self._flash(f"closed agent · removed untouched {result.branch}")
            else:
                detail = f" · {len(result.changed_paths)} changed path(s)" if result.changed_paths else ""
                self._flash(f"closed agent · retained {result.branch} at {result.path}{detail}")
        elif worker and worker.is_alive() and sess.workspace is not None:
            self._flash(f"agent stopping · isolated work stays at {sess.workspace.path}")
        self._invalidate()

    def _cycle_mode(self) -> None:
        order = ["default", "acceptEdits", "plan", "auto"]
        cur = order.index(self.agent.mode) if self.agent.mode in order else 0
        self._request_mode(order[(cur + 1) % len(order)])

    def _request_mode(self, mode: str, after=None) -> None:
        """Apply a permission mode, with a modal acknowledgement before full auto."""
        def commit() -> None:
            self.agent.set_mode(mode)
            self._flash(f"mode → {mode}")
            self._invalidate()
            if after:
                after()

        if mode != "auto" or self.agent.mode == "auto":
            commit()
            return
        from rich.text import Text
        th = style_mod.theme()
        header = [Text.from_markup("[bold]Enable full-auto mode?[/]"),
                  Text.from_markup(f"[{th.warn}]Every file write and shell command will run without a prompt.[/]"),
                  Text.from_markup(f"[{th.muted}]Use this only in a trusted sandbox or disposable worktree.[/]")]
        rows = [{"label": f"{glyphs.CHECK}  Enable auto", "value": "yes"},
                {"label": f"{glyphs.CROSS}  Keep current mode", "value": "no"}]
        def picked(row) -> None:
            if row["value"] == "yes":
                commit()
            elif after:
                after()
        self._open_overlay(rows, header=header, footer="Enter select · Esc cancel", accent=True,
                           on_pick=picked)

    def _menu_hover(self, position) -> None:
        """Welcome-menu row hover + the top-right context chip hover (→ morph to a bar + %)."""
        ch = (position.y == 0 and self._ctx_x0 >= 0 and self._ctx_x0 <= position.x < self._ctx_x1)
        if ch != self._ctx_hover:
            self._ctx_hover = ch
            self._invalidate()
        new = position.y if (not self.blocks and not self._buf
                             and position.y in self._menu_rows) else None
        if new != self._hover_row:
            self._hover_row = new
            self._invalidate()

    def _menu_click(self, position) -> bool:
        """Map a click on the welcome card to its menu action, using the row map that
        _welcome_card records for the current layout (wide or stacked-narrow)."""
        if position.y == 0 and self._ctx_x0 >= 0 and self._ctx_x0 <= position.x < self._ctx_x1:
            self._open_context_popup()          # click the top-right context chip → details popup
            return True
        if self.blocks or self._buf:            # only the welcome screen has a menu
            return False
        action = self._menu_rows.get(position.y)
        if action == "new":
            self._prompt_new_session(); return True
        if action == "update":                  # clicked "[ Update now ]"
            self._handle_slash("/update"); return True
        if action == "switch":
            self._cycle_mode(); return True
        if action == "commands":
            self._handle_slash("/help"); return True
        if action == "quit":
            if self.app:
                self.app.exit()
            return True
        return False

    # ---- slash commands (the canonical terminal catalog; custom commands are merged at runtime) ----
    def _handle_slash(self, text: str) -> bool:
        parts = text[1:].split(maxsplit=1)
        cmd = canonical_command_name(parts[0] if parts else "", "tui")
        rest = parts[1].strip() if len(parts) > 1 else ""
        th = style_mod.theme()
        cfg = self.config
        if cmd in ("help", "?", "commands"):
            # open the interactive `/` palette overlay (arrow-select · Enter runs · Esc closes)
            self.input_buf.reset()
            self.input_buf.insert_text("/")
            self._open_command_palette()
        elif cmd in ("keys", "shortcuts", "cheatsheet"):
            self._open_cheatsheet()
        elif cmd in ("docs", "doc", "guide"):
            if rest:
                self._open_doc_reader(rest)
            else:
                self._open_docs()
        elif cmd in ("history", "hist"):
            self._open_history()
        elif cmd in ("view-plan", "plan-view", "viewplan"):
            self._open_plan_view()
        elif cmd in ("artifact", "artifacts"):
            self._open_artifacts()
        elif cmd in ("copy", "select", "selection"):
            # toggle mouse capture: OFF hands selection back to the terminal so the user can
            # drag-select and copy model responses; ON restores wheel-scroll + clickable menus.
            self._mouse_on = not self._mouse_on
            self._invalidate()
            self._flash("mouse ON — wheel scrolls, /copy to select text" if self._mouse_on
                        else "select mode — drag to select & copy in your terminal · /copy to exit")
        elif cmd in ("expand", "expandall"):
            hits = [b for b in self.blocks if isinstance(b, dict) and b.get("kind") == "tool"
                    and len(b.get("out", "").splitlines()) > self._TOOL_HEAD]
            if not hits:
                self._flash("no collapsed tool output to expand")
            else:
                for b in (hits if cmd == "expandall" else hits[-1:]):
                    b["exp"] = True
                self._invalidate()
                self._flash("expanded all tool output" if cmd == "expandall" else "expanded the last tool output")
        elif cmd in ("dashboard", "dash", "home"):
            self._open_dashboard()
        elif cmd == "jump":
            self._open_jump()
        elif cmd == "rewind":
            self._open_rewind()
        elif cmd in ("new", "session"):
            self._prompt_new_session()
        elif cmd == "name":
            if rest:
                if self._name_session(self.active, rest):
                    self._flash(f"session named: {rest}")
            else:
                self._flash(f"session: {self.agent.session_name or '(unnamed)'} — /name <name>")
        elif cmd == "goal":
            if rest.lower() in ("clear", "off", "none", "remove"):
                self._flash("standing goal cleared" if self.agent.set_goal("") else
                            (getattr(self.agent, "_last_persist_error", "")
                             or "goal update was not saved"))
            elif rest.lower() in ("complete", "completed", "done"):
                self._flash("standing goal → completed" if self.agent.update_goal("completed")
                            else (getattr(self.agent, "_last_persist_error", "")
                                  or "no standing goal to complete"))
            elif rest.lower() in ("blocked", "block", "pause", "paused"):
                self._flash("standing goal → paused" if self.agent.update_goal("blocked")
                            else (getattr(self.agent, "_last_persist_error", "")
                                  or "no standing goal to pause"))
            elif rest.lower() in ("resume", "active", "reactivate"):
                self._flash("standing goal → active" if self.agent.update_goal("active")
                            else (getattr(self.agent, "_last_persist_error", "")
                                  or "no standing goal to resume"))
            elif rest:
                self._flash(f"goal set — the agent keeps working toward it: {rest[:56]}"
                            if self.agent.set_goal(rest) else
                            (getattr(self.agent, "_last_persist_error", "")
                             or "goal update was not saved"))
            else:
                g = getattr(self.agent, "goal", "")
                if g:
                    self._open_reader(
                        f"# Standing goal\n\n**Status:** {self.agent.goal_status}\n\n{g}\n\n"
                        "`/goal complete` · `/goal pause` · `/goal resume` · `/goal clear`",
                        footer="the standing objective · ↑↓ scroll · Esc close")
                else:
                    self._flash("no goal set — /goal <objective> to set one")
        elif cmd == "set":
            from .config import DEFAULTS
            tunable = ("temperature", "top_p", "top_k", "min_p", "max_tokens", "context_size",
                       "bash_timeout", "search_timeout", "request_timeout", "artifact_hostname")
            sp = rest.split(maxsplit=1)
            if not sp:
                cur = " · ".join(f"{k}={self.config.get(k, '') or '(default)'}" for k in tunable)
                self._flash(f"/set <key> <value> — {cur}")
            else:
                key = sp[0]
                val = sp[1].strip() if len(sp) > 1 else ""
                if key not in DEFAULTS or isinstance(DEFAULTS[key], (dict, list)):
                    self._flash(f"can't set '{key}' here — /set is for scalar settings (try /settings)")
                elif key == "mode":                          # route through the mode validator
                    if val in ("default", "acceptEdits", "plan", "auto"):
                        self._request_mode(val)
                    else:
                        self._flash("mode must be one of: default · acceptEdits · plan · auto")
                elif key == "theme":                         # route through /theme (repaints)
                    self._handle_slash(f"/theme {val}")
                else:
                    dflt = DEFAULTS[key]
                    try:
                        if val in ("", "default", "none"):
                            parsed = dflt                    # the REAL default, not ""
                        elif isinstance(dflt, bool):
                            parsed = val.lower() in ("1", "true", "on", "yes")
                        elif isinstance(dflt, int) and not isinstance(dflt, bool):
                            parsed = int(val)
                        elif isinstance(dflt, float):
                            parsed = float(val)
                        else:
                            parsed = val
                    except ValueError:
                        self._flash(f"'{val}' isn't a valid value for {key}"); return True
                    self.config.set(key, parsed)
                    if key in self._CLIENT_KEYS:
                        self.agent.refresh_client()   # sampling / max_tokens / timeout take effect now
                    self._flash(f"{key} = {parsed}" if parsed != dflt else f"{key} reset to the default")
        elif cmd in ("settings", "config", "prefs", "preferences"):
            self._open_settings()
        elif cmd in ("handoff", "handover"):
            sess = self.active
            self._flash("generating a handoff document…")
            threading.Thread(target=self._do_handoff, args=(sess,), daemon=True).start()
        elif cmd == "resume":
            self._resume_flow()
        elif cmd in ("model", "models"):
            _se = str(self.config.get("subscription_engine", "")).strip().lower()
            if _se:                                    # steer the subscription's model, not the endpoint
                if rest:
                    self.config.set("subscription_model", rest)
                    self._flash(f"subscription model → {rest}")
                else:
                    self._subscription_model_flow(_se)
            elif cmd == "model" and rest:
                self._set_model_tui(rest)
            else:
                self._model_flow()
        elif cmd == "connect":
            self._connect_flow(rest)
        elif cmd == "subagent":
            self._subagent_flow(rest)
        elif cmd == "worktree":
            self._tui_worktree(rest)
        elif cmd == "tasks":
            self._tui_tasks(rest)
        elif cmd in ("bg", "background"):
            val = rest.strip().lower()
            if val not in ("auto", "dark", "inherit"):
                self._flash(f"background: {cfg.get('background', 'auto')} — /bg auto|dark|inherit")
            else:
                cfg.set("background", val)
                from . import termbg
                if val == "dark":
                    import sys
                    sys.stdout.write(f"\x1b]10;{th.text}\x07\x1b]11;{th.bg}\x07"); sys.stdout.flush()
                    termbg._applied = True; self._flash("background → dark")
                elif val == "inherit":
                    termbg.reset(); self._flash("background → inherit")
                else:
                    self._flash("background → auto (applies on next launch)")
        elif cmd == "sandbox":
            from . import sandbox
            val = rest.strip().lower()
            if val in ("off", "false", "0"):
                cfg.set("sandbox", False); self._flash("sandbox OFF")
            elif val in ("on", "true", "1") and not sandbox.available():
                cfg.set("sandbox", False)
                self._flash("sandbox remains OFF — no supported confinement backend found")
            elif val in ("on", "true", "1"):
                cfg.set("sandbox", True)
                self._flash(f"sandbox ON — {sandbox.describe(cfg)}")
            elif val in ("network on", "net on"):
                cfg.set("sandbox_network", True)
                self._flash("sandbox network ON — commands still require normal approval")
            elif val in ("network off", "net off"):
                cfg.set("sandbox_network", False)
                self._flash("sandbox network OFF")
            else:
                net = "on" if cfg.get("sandbox_network", False) else "off"
                state = "on" if cfg.get("sandbox") else "off"
                self._flash(
                    f"sandbox: {state}, network: {net} — {sandbox.describe(cfg)} — "
                    "/sandbox on|off|network on|network off")
        elif cmd == "mode":
            if rest in ("default", "acceptEdits", "plan", "auto"):
                self._request_mode(rest)
            else:
                self._cycle_mode()
        elif cmd == "think":
            _se = str(cfg.get("subscription_engine", "")).strip().lower()
            if _se:                                    # /think steers the subscription's reasoning effort
                from . import subscriptions as subs
                eng = subs.get_engine(_se)
                if eng is not None and not eng.supports_effort():
                    self._flash(f"{eng.short_label} takes no reasoning-effort flag — steer it via /model")
                elif rest in ("off", "low", "medium", "high"):
                    val = "" if rest == "off" else rest
                    cfg.set("subscription_effort", val); self._flash(f"subscription effort → {val or 'default'}")
                else:
                    self._flash(f"subscription effort: {cfg.get('subscription_effort', '') or 'default'}"
                                " — /think off|low|medium|high")
            elif rest in ("off", "low", "medium", "high"):
                cfg.set("thinking", rest); self._flash(f"thinking → {rest}")
            else:
                self._flash(f"thinking: {cfg.get('thinking', 'off')} — /think off|low|medium|high")
        elif cmd in ("thoughts", "reasoning", "reason"):   # display toggle (NOT the model's effort — that's /think)
            val = rest.strip().lower()
            if val in ("show", "on", "true", "1"):
                cfg.set("show_reasoning", True); self._flash("thoughts shown in the transcript")
            elif val in ("hide", "off", "false", "0"):
                cfg.set("show_reasoning", False); self._flash("thoughts hidden")
            else:
                self._flash(f"thoughts: {'shown' if cfg.get('show_reasoning', True) else 'hidden'} — /thoughts show|hide")
        elif cmd == "theme":
            val = rest or ("light" if cfg.get("theme") == "dark" else "dark")
            cfg.set("theme", val); style_mod.set_theme(val); self._flash(f"theme → {val}")
        elif cmd == "context":
            self._open_context_popup()          # the top-right chip's details popup
        elif cmd == "compact":
            if self.agent.maybe_compact(force=True):
                self._flash("context compacted")
            else:
                self._flash(getattr(self.agent, "_last_persist_error", "")
                            or "context compaction failed")
        elif cmd == "status":
            self._append(self._rich(self._status_block()))
        elif cmd == "mcp":
            sub = rest.strip().split()
            if sub and sub[0] == "add":
                self._mcp_add_flow()
            elif sub and sub[0] in ("remove", "rm") and len(sub) > 1:
                servers = dict(cfg.get("mcp_servers", {}) or {})
                if servers.pop(sub[1], None) is not None:
                    cfg.set("mcp_servers", servers)
                    live = self.agent.mcp.servers.pop(sub[1], None)
                    self.agent.mcp.failures.pop(sub[1], None)
                    if live:
                        live.stop()
                    self.agent.mcp._rebuild_routes()
                    self._flash(f"removed MCP server '{sub[1]}'")
                else:
                    self._flash(f"no MCP server named '{sub[1]}'")
            else:
                self._extensions_modal(tab=1)           # open the tabbed Skills/MCP modal on MCP
        elif cmd == "hooks":
            from .hooks import hook_catalog
            catalog = hook_catalog(cfg)
            lines = []
            for item in catalog["items"]:
                matchers = ", ".join(item["matchers"]) or "—"
                state = "ready" if item["valid"] else "invalid"
                lines.append(
                    f"  [{th.accent}]{item['event']}[/]  [{th.text}]{item['configured']}[/]  "
                    f"[{th.faint}]{_esc(matchers)} · {state}[/]")
            if catalog["invalid"]:
                lines.append(
                    f"  [{th.err}]{catalog['invalid']} invalid or unsupported entry(s)[/]")
            self._append(self._rich(
                f"[bold {th.accent}]lifecycle hooks[/]\n" + "\n".join(lines)))
        elif cmd == "agents":
            sm = cfg.get("subagent_model") or f"(inherit: {cfg.model})"
            sh = cfg.get("subagent_base_url") or f"(inherit: {cfg.base_url})"
            st = cfg.get("subagent_api_mode") or "(inherit/infer)"
            defs = ", ".join(getattr(self.agent, "agent_defs", {}).keys()) or "(none)"
            self._append(self._rich(f"[bold {th.accent}]sub-agents[/]\n  model  [{th.text}]{_esc(sm)}[/]\n"
                                    f"  host   [{th.text}]{_esc(sh)}[/]\n"
                                    f"  route  [{th.text}]{_esc(st)}[/]\n"
                                    f"  named  [{th.faint}]{_esc(defs)}[/]\n"
                                    f"  [{th.faint}]/subagent to change[/]"))
        elif cmd in ("skills", "extensions", "ext"):
            self._extensions_modal(tab=0)               # open the tabbed Skills/MCP modal on Skills
        elif cmd == "memory":
            match = re.match(r"add\s+(user\s+)?(.+)", rest, re.S) if rest else None
            if rest and rest != "show" and match is None:
                self._flash("usage: /memory [show] | /memory add [user] TEXT")
            elif match is not None:
                self._save_memory_direct(
                    match.group(2), "user" if match.group(1) else "project", show_entry=False)
            else:
                from .memory import bounded_memory_view, load_memories
                project_memory, user_memory = load_memories(
                    cfg.project_root,
                    sanitizer=lambda value: redact_text(value, secret_values(cfg)))
                project_body = bounded_memory_view(
                    project_memory or "(no project DGC.md — durable memory file)", 4000)
                user_body = bounded_memory_view(user_memory or "(no user DGC.md)", 4000)
                self._append(self._rich(
                    f"[bold {th.accent}]project DGC.md[/]\n[{th.faint}]{_esc(project_body)}[/]\n"
                    f"[bold {th.accent}]user DGC.md[/]\n[{th.faint}]{_esc(user_body)}[/]"))
        elif cmd == "permissions":
            perms = getattr(cfg, "permissions", {}) or {}
            spec = rest.strip().split(maxsplit=1)
            if spec:
                if len(spec) != 2 or spec[0] not in ("allow", "ask", "deny"):
                    self._flash("usage: /permissions allow|ask|deny Tool(pattern)")
                    return True
                from .permissions import Rule
                action, rule_text = spec
                try:
                    rule = Rule.parse(rule_text, action)
                except ValueError as e:
                    self._flash(str(e)); return True
                rendered = rule.render()
                if rendered not in cfg.permissions.setdefault(action, []):
                    cfg.permissions[action].append(rendered)
                    cfg.save()
                self._flash(f"permission {action}: {rendered}")
                return True
            lines = [f"  [{th.accent}]{a}[/]  [{th.faint}]{_esc(', '.join(perms.get(a, [])) or '—')}[/]"
                     for a in ("allow", "ask", "deny")]
            self._append(self._rich(f"[bold {th.accent}]permission rules[/]\n" + "\n".join(lines)))
        elif cmd in ("bug", "feedback", "report", "issue"):
            self._append(self._rich(f"[bold {th.accent}]report a bug / request a feature[/]\n"
                                    f"  [{th.text}]https://github.com/OpenPeach-ai/dgc/issues[/]  "
                                    f"[{th.faint}](include your `dgc --version`)[/]"))
        elif cmd == "clear":
            from . import sessions as _sess
            sess = self.active
            sess._aux_generation += 1
            sess._aux_cancel.set()
            sess._autotitle_pending = False
            sess.agent.reset()
            sess.agent.session_file = _sess.new_path(
                getattr(sess.agent, "session_root", self._fleet_root))
            if sess.workspace_kind == "managed" and sess.workspace is not None:
                _sess.save_workspace(sess.agent.session_file, self._fleet_root, kind="managed",
                                     worktree=sess.workspace.path, branch=sess.workspace.branch,
                                     metadata=sess.workspace.metadata_path,
                                     **_session_generation_guard(sess.agent))
            elif sess.workspace_kind == "manual":
                _sess.save_workspace(sess.agent.session_file, self._fleet_root, kind="manual",
                                     worktree=sess.workspace_path, branch=sess.workspace_branch,
                                     **_session_generation_guard(sess.agent))
            sess.blocks.clear()
            sess._turn_marks = []
            sess._buf = ""
            sess._think = ""
            sess._tool_count = 0
            sess._suggestion = None
            sess._todos = []
            sess._scroll_off = 0
            sess._follow = True
            sess._autotitled = False
            self._flash("conversation cleared")
        elif cmd == "update":
            # exit the full-screen app cleanly, THEN run the installer on the raw terminal
            # (curl | bash needs a normal TTY; it can't run inside the alt-screen app).
            if cached_update() or rest in ("force", "-f", "now"):
                self._pending_update = True
                if self.app:
                    self.app.exit()
            else:
                self._flash(f"you're on the latest — DGC v{__version__}")
        elif cmd in ("init", "search"):
            self._flash(f"/{cmd} is available in the classic REPL — run: dgc --classic")
        elif cmd in ("quit", "exit"):
            if self.app:
                self.app.exit()
        else:
            from .commands import discover_commands, render_command
            custom = discover_commands(cfg.project_root)
            if cmd in custom:
                rendered = render_command(custom[cmd], rest, cfg.project_root)
                if rendered:
                    self._submit(rendered)
            else:
                self._append(self._rich(f"[{th.err}]unknown command:[/] /{_esc(cmd)}  [{th.faint}]— /help[/]"))
        self._invalidate()
        return True

    # ---- command flows that use the picker / input prompts ----
    def _status_block(self) -> str:
        th = style_mod.theme()
        cfg = self.config
        used, size = self.agent.estimate_tokens(), self._context_window_size()
        rows = [("model", cfg.model), ("host", cfg.base_url), ("mode", self.agent.mode),
                ("thinking", cfg.get("thinking", "off")), ("context", f"{used} / {size} tokens"),
                ("session", self.agent.session_name or "(unnamed)"),
                ("workspace", getattr(self.active, "workspace_branch", "") or "shared checkout")]
        return f"[bold {th.accent}]status[/]\n" + "\n".join(
            f"  [{th.faint}]{k:<9}[/] [{th.text}]{_esc(str(v))}[/]" for k, v in rows)

    def _set_model_tui(self, model: str, subagent: bool = False) -> None:
        if subagent:
            self.config.set("subagent_model", model)
            self._flash(f"sub-agent model → {model}")
            return
        self.config.set("model", model)
        self.agent.refresh_client()
        ctx = self.agent.recommended_context_size(model)
        if ctx and ctx != int(self.config.get("context_size", 32768)):
            self.config.set("context_size", ctx)
            self._flash(f"model → {model}  ·  context {ctx // 1024}k")
        else:
            self._flash(f"model → {model}")

    def _list_models(self, base_url=None, api_key=None):
        from .llm import LLMClient
        client = (self.agent.client if base_url is None else
                  LLMClient(base_url,
                            self.agent._route_api_key(base_url, "subagent_api_key", api_key or ""),
                            "",
                            api_mode=self.agent._route_api_mode(base_url, "subagent_api_mode")))
        return client.list_models()

    def _subscription_model_flow(self, engine_key: str) -> None:
        """`/model` when a subscription engine is active — steer that CLI's own model
        and reasoning effort, not the local endpoint."""
        from . import subscriptions as subs
        eng = subs.get_engine(engine_key)
        if eng is None:
            return
        name = eng.short_label
        cur_m = str(self.config.get("subscription_model", "")).strip() or "the CLI's default"
        cur_e = str(self.config.get("subscription_effort", "")).strip() or "default"
        hints = list(eng.model_hints)
        labels = list(hints) + ["Custom model name…"]
        eff_index = None
        if eng.supports_effort():
            eff_index = len(labels)
            labels.append(f"Reasoning effort  ({cur_e})")
        reset_index = len(labels)
        labels.append("Reset to the CLI's default")

        def pick(i):
            if i < len(hints):
                self.config.set("subscription_model", hints[i])
                self._flash(f"{name} model → {hints[i]}")
            elif i == len(hints):
                self._ask_input(f"{name} model name (blank = its default)",
                                lambda v: self._set_subscription_model(v.strip(), name))
            elif eff_index is not None and i == eff_index:
                self._subscription_effort_flow(name)
            elif i == reset_index:
                self.config.set("subscription_model", "")
                self.config.set("subscription_effort", "")
                self._flash(f"{name} → the CLI's defaults")
        self._show_picker(f"{name} · your subscription   (model: {cur_m})", labels, pick)

    def _set_subscription_model(self, model: str, name: str) -> None:
        self.config.set("subscription_model", model)
        self._flash(f"{name} model → {model or 'the CLI default'}")

    def _subscription_effort_flow(self, name: str) -> None:
        levels = ["default", "low", "medium", "high"]

        def pick(i):
            val = "" if i == 0 else levels[i]
            self.config.set("subscription_effort", val)
            self._flash(f"{name} reasoning effort → {val or 'default'}")
        self._show_picker(f"Reasoning effort · {name}", levels, pick)

    def _model_flow(self, subagent: bool = False) -> None:
        base = self.config.get("subagent_base_url") or self.config.base_url if subagent else None
        ep = base or self.config.base_url
        try:
            models = self._list_models(base, self.config.get("subagent_api_key") if subagent else None)
        except Exception as e:
            if "conn" in type(e).__name__.lower() or "connect" in str(e).lower():
                self._flash(f"can't reach {ep} — server down, or not reachable from this device? "
                            f"/connect a reachable host (e.g. the machine's LAN IP)")
            else:
                self._flash(f"couldn't list models from {ep}: {type(e).__name__}")
            return
        if not models:
            self._flash(f"no models offered by {ep}"); return
        self._show_picker(f"{'Sub-agent model' if subagent else 'Model'} @ {base or self.config.base_url}",
                          models, lambda i: self._set_model_tui(models[i], subagent=subagent))

    def _render_history(self) -> None:
        """Repopulate the transcript from the loaded session so a resumed chat is actually visible."""
        th = style_mod.theme()

        def _text(content) -> str:
            if isinstance(content, str):
                return content
            if isinstance(content, list):       # multimodal → keep the text parts
                return " ".join(p.get("text", "") for p in content
                                if isinstance(p, dict) and p.get("type") == "text")
            return ""

        for m in self.agent.messages:
            role = m.get("role")
            body = _text(m.get("content")).strip()
            if role == "user":
                if body.startswith("<system-reminder>"):
                    continue                    # internal nudges aren't part of the chat
                if body.startswith("<user-interjection>"):
                    body = body.replace("<user-interjection>", "").replace("</user-interjection>", "").strip()
                if body:
                    self.blocks.append({"kind": "user", "text": body[:6000]})   # tinted band, same as live submit
                    self._turn_marks.append((len(self.blocks) - 1, body.replace("\n", " ")[:70]))   # /jump
            elif role == "assistant":
                if body:
                    self.blocks.append(self._rich(self._md(body)))   # _md → renderable; blocks need ANSI str
                tcs = m.get("tool_calls") or []
                if tcs:
                    names = ", ".join(tc.get("function", {}).get("name", "?") for tc in tcs)
                    self.blocks.append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} used {_esc(names)}[/]"))
            # role == "tool" (results) and "system" are omitted — too verbose for the recap
        if self.blocks:
            self.blocks.append(self._rich(f"[{th.faint}]{'─' * 20} resumed here {'─' * 20}[/]"))
        self._scroll_off = 0               # resumed conversation: show the newest end, not the top

    def _resume_flow(self) -> None:
        from . import sessions
        items = sessions.listing(
            self._fleet_root, redact_secrets=secret_values(self.config))
        if not items:
            self._flash("no saved sessions in this directory"); return
        labels = [f"{sessions.when(ts)}  ({cnt} msgs)  {(nm + ' · ' if nm else '')}{prev}"
                  for (p, ts, prev, cnt, nm) in items[:30]]

        def pick(i):
            association = sessions.load_workspace(items[i][0], self._fleet_root)
            if association:
                self._open_saved_session(items[i][0])
                return
            n = self.agent.load_session(items[i][0])
            self.blocks.clear(); self._buf = ""; self._think = ""
            self._render_history()          # show the loaded conversation, not a blank screen
            self._flash(f"resumed ({n} messages)"
                        + (f" — {self.agent.session_name}" if self.agent.session_name else ""))

        def dele(i):
            deleted = sessions.delete(items[i][0], self._fleet_root)
            self._flash("session deleted" if deleted else
                        "session is active; deletion was not run")
            self._resume_flow()             # re-show the updated list
        self._show_picker("Resume a session", labels, pick, delete_cb=dele)

    def _extensions_modal(self, tab: int = 0) -> None:
        """A centered tabbed dialog with Skills + MCP Servers tabs (a tabbed Skills + MCP dialog)."""
        from .skills import discover_skills

        def rebuild(ov):
            if ov["tab"] == 0:                          # Skills
                sk = discover_skills(self.config.project_root)
                return [{"label": name, "desc": (s.description or "skill"),
                         "value": ("skill", name)} for name, s in sk.items()]
            servers = self.config.get("mcp_servers", {}) or {}   # MCP Servers
            out = []
            for name, spec in servers.items():
                manager = getattr(self.agent, "mcp", None)
                server = getattr(manager, "servers", {}).get(name) if manager else None
                live = bool(server and server.proc is not None and server.proc.poll() is None)
                tail = f"{spec.get('command', '')} {' '.join(spec.get('args', []))}".strip()
                failure = getattr(manager, "failures", {}).get(name, "") if manager else ""
                if server is not None and not live:
                    failure = server.error or server._diagnostic_tail() or "process exited"
                desc = f"failed: {failure}" if failure else tail
                out.append({"label": ("● " if live else "○ ") + name, "desc": desc[:64],
                            "value": ("mcp", name)})
            return out

        def on_action(key, row):
            ov = self._overlay
            is_mcp = ov["tab"] == 1
            if key == "a":                              # add
                self._close_overlay()
                if is_mcp:
                    self._mcp_add_flow()
                else:
                    self._ask_input("skill URL (a raw SKILL.md or a github link):", self._install_skill_url)
            elif key == "x" and row:                    # remove
                kind, name = row["value"]
                if kind == "mcp":
                    servers = dict(self.config.get("mcp_servers", {}) or {}); servers.pop(name, None)
                    self.config.set("mcp_servers", servers)
                    if getattr(self.agent, "mcp", None):
                        live = self.agent.mcp.servers.pop(name, None)
                        self.agent.mcp.failures.pop(name, None)
                        if live:
                            live.stop()
                        self.agent.mcp._rebuild_routes()
                else:
                    import shutil
                    from .config import USER_SKILLS
                    shutil.rmtree(USER_SKILLS / name, ignore_errors=True)
                ov["sel"] = 0
                self._invalidate()
            elif key == "r":                            # reload (rebuild happens on render)
                self._invalidate()

        self._open_overlay([], on_pick=lambda r: None, tabs=["Skills", "MCP Servers"], tab=tab,
                           footer="Tab switch · ↑↓ move · a add · x remove · r reload · Esc close",
                           rebuild=rebuild, on_action=on_action)

    def _install_skill_url(self, url: str) -> None:
        url = url.strip()
        if not url:
            self._flash("cancelled"); return
        from . import tools
        res = tools.add_skill({"url": url}, self.agent.ctx)
        self._flash(res.split(".")[0][:70])

    def _mcp_add_flow(self, st: dict | None = None) -> None:
        """A single FORM modal to add an MCP server: every field is visible; arrow to a field and
        Enter to edit it (or toggle the type), then choose 'Add server'. Esc cancels."""
        st = st if st is not None else {"name": "", "transport": "local", "target": "", "token": "", "env": ""}
        st.setdefault("env", "")
        remote = st["transport"] == "remote"

        def frow(label, value, key):
            return {"label": f"{label:<12}{value}", "value": key}

        rows = [
            frow("Name", st["name"] or "—", "name"),
            frow("Type", "Remote — a URL" if remote else "Local — a command", "transport"),
            frow("URL" if remote else "Command", st["target"] or "—", "target"),
        ]
        if remote:
            rows.append(frow("Auth token", "•" * 8 if st["token"] else "(none)", "token"))
        else:                                          # local servers get their token as an env var
            keys = [kv.split("=", 1)[0] for kv in st["env"].split() if "=" in kv]
            rows.append(frow("Env / token", ", ".join(keys) if keys else "(none)", "env"))
        rows += [{"label": "✓  Add server", "value": "save"},
                 {"label": "✗  Cancel", "value": "cancel"}]

        def pick(row):
            v = row["value"]
            if v == "cancel":
                self._close_overlay(); return
            if v == "transport":                         # toggle local ⇄ remote, keep the form open
                st["transport"] = "remote" if st["transport"] == "local" else "local"
                self._mcp_add_flow(st); return
            if v == "save":
                if not st["name"].strip():
                    self._flash("a name is required"); self._mcp_add_flow(st); return
                if not st["target"].strip():
                    self._flash(("a URL" if remote else "a command") + " is required")
                    self._mcp_add_flow(st); return
                name = re.sub(r"\s+", "-", st["name"].strip())
                if st["transport"] == "remote":          # bridge via the standard mcp-remote stdio proxy
                    args = ["-y", "mcp-remote", st["target"].strip()]
                    if st["token"].strip():
                        args += ["--header", f"Authorization: Bearer {st['token'].strip()}"]
                    self._mcp_save(name, {"command": "npx", "args": args})
                else:
                    parts = st["target"].split()
                    spec = {"command": parts[0], "args": parts[1:]}
                    env = dict(kv.split("=", 1) for kv in st["env"].split() if "=" in kv)
                    if env:                             # service tokens etc. → passed as env vars
                        spec["env"] = env
                    self._mcp_save(name, spec)
                return
            # a text field → close the form, prompt for the value, re-open the form on submit
            prompts = {
                "name": "Server name (e.g. github, filesystem)",
                "target": ("Server URL (e.g. https://mcp.example.com/mcp)" if remote
                           else "Command (e.g. npx -y @modelcontextprotocol/server-filesystem ~/)"),
                "token": "Auth token for the Authorization header (blank = none)",
                "env": "Env vars as KEY=VALUE, space-separated "
                       "(e.g. GITHUB_PERSONAL_ACCESS_TOKEN=ghp_… )",
            }

            def got(val):
                st[v] = val.strip()
                self._mcp_add_flow(st)
            self._close_overlay()
            self._ask_input(prompts[v], got)

        self._open_overlay(rows, on_pick=pick, title="Add an MCP server",
                           footer="↑↓ move · Enter edit / toggle / add · Esc cancel",
                           back=self._palette_back)

    def _mcp_save(self, name: str, spec: dict) -> None:
        cfg = self.config
        servers = dict(cfg.get("mcp_servers", {}) or {})
        servers[name] = spec
        cfg.set("mcp_servers", servers)
        try:                                     # connect just the new one so it's live this session
            self.agent.mcp.connect_all({name: spec})
            live = name in getattr(self.agent.mcp, "servers", {})
        except Exception:
            live = False
        tail = f"{spec.get('command')} {' '.join(spec.get('args', []))}".strip()
        self._flash((f"MCP '{name}' added + connected" if live
                     else f"MCP '{name}' saved (connects next launch)") + f" — {tail}"[:52])

    def _connect_flow(self, rest: str, subagent: bool = False) -> None:
        from .config import PROVIDERS
        from . import subscriptions as subs
        bk = "subagent_base_url" if subagent else "base_url"
        kk = "subagent_api_key" if subagent else "api_key"
        who = "sub-agent host" if subagent else "endpoint"

        def selected_provider(prov) -> None:
            def finish(key: str = "") -> None:
                if prov["needs_key"]:
                    if not key:
                        env_name = "DGC_SUBAGENT_API_KEY" if subagent else "DGC_API_KEY"
                        self._flash(f"cancelled — use dgc setup or {env_name} instead")
                        return
                self.config.set(bk, prov["base_url"])
                self.config.set(kk, key if prov["needs_key"] else prov["api_key"])
                if subagent:
                    self.config.set("subagent_api_mode", "auto")
                else:
                    self.config.set("subscription_engine", "")   # a direct model turns delegation off
                    self.config.set("api_mode", "auto")
                    self.agent.refresh_client()
                self._flash(f"{who} → {prov['base_url']}")

            if prov["needs_key"]:
                self._ask_input(f"API key for {prov['label']} (masked) then Enter", finish, secret=True)
            else:
                finish()

        def selected_engine(key: str) -> None:                # a subscription CLI (their own plan)
            prev = str(self.config.get("subscription_engine", "")).strip().lower()
            eng = subs.get_engine(key)
            self.config.set("subscription_engine", key)
            if key != prev:                    # model/effort are engine-specific — never carry them over
                self.config.set("subscription_model", "")
                self.config.set("subscription_effort", "")
            if eng.resolve() is None:
                self._offer_engine_install(eng)
            elif not eng.logged_in():
                self._offer_engine_login(eng)
            else:
                self._flash(f"provider → {eng.label} (your subscription) — signed in ✓", secs=8)

        if rest:                                       # /connect <engine|preset|url>
            if not subagent and subs.get_engine(rest) is not None:
                selected_engine(rest.strip().lower())
            elif rest in PROVIDERS:
                selected_provider(PROVIDERS[rest])
            else:
                self.config.set(bk, rest)
                if not subagent:
                    self.config.set("subscription_engine", "")
                    self.agent.refresh_client()
                self._flash(f"{who} → {self.config.get(bk)}")
            return
        sub_status = subs.status() if not subagent else []      # subscriptions are a main-model concept
        sub_labels = [f"{s['label']} — your subscription"
                      + ("  ✓" if s["logged_in"] else ("  (sign in)" if s["installed"] else "  (not installed)"))
                      for s in sub_status]
        n_sub = len(sub_status)
        keys = list(PROVIDERS)
        labels = sub_labels + [f"{PROVIDERS[k]['label']}  ({PROVIDERS[k]['base_url']})" for k in keys]
        labels.append("Custom host — enter a URL (e.g. a machine on your LAN)")

        def pick(i):
            if i < n_sub:                               # a subscription engine
                selected_engine(sub_status[i]["key"]); return
            i -= n_sub
            if i == len(keys):                          # custom host
                self._ask_input("host URL (e.g. http://192.168.1.50:11434/v1) then Enter",
                                lambda url: self._set_host(url.strip(), subagent))
                return
            selected_provider(PROVIDERS[keys[i]])
        self._show_picker(f"Connect a {who}", labels, pick)

    def _run_setup_cmd(self, cmd_str: str, note: str = "") -> None:
        """Hand the real terminal to an install / sign-in command (suspends the
        full-screen app), then return to DGC. The vendor command owns the browser
        flow and any token — DGC never touches credentials."""
        from prompt_toolkit.application import run_in_terminal
        import shlex
        import subprocess

        def runner():
            print(f"\n  \033[1m$ {cmd_str}\033[0m")
            if note:
                print(f"  {note}")
            print()
            try:
                subprocess.run(shlex.split(cmd_str))
            except FileNotFoundError:
                print(f"  command not found: {shlex.split(cmd_str)[0]}")
            except KeyboardInterrupt:
                pass
            try:
                input("\n  ── press Enter to return to DGC ── ")
            except (EOFError, KeyboardInterrupt):
                pass
        try:
            run_in_terminal(runner)
        except Exception as e:
            self.error(f"couldn't run '{cmd_str}': {e}")

    def _offer_engine_install(self, eng) -> None:
        """Offer to install a not-yet-installed subscription CLI from inside DGC."""
        if not eng.install_cmd:
            self.info(f"{eng.short_label} isn't installed — install its CLI, then /connect again.")
            return

        def pick(i):
            if i != 0:
                self.info(f"{eng.short_label} isn't installed — install it, then /connect again.")
                return
            self._run_setup_cmd(eng.install_cmd, "installing — this can take a minute…")
        self._show_picker(f"{eng.short_label} isn't installed. Install it now?   ({eng.install_cmd})",
                          ["Yes, install it", "No"], pick)

    def _offer_engine_login(self, eng) -> None:
        """Offer to sign in to a subscription CLI from inside DGC. It runs the vendor's
        own login with the real terminal handed over, so the browser / device flow
        works; the vendor keeps the token."""
        cmd = eng.login_run or eng.binary        # a bare binary triggers the device flow (qwen/copilot)
        hint = ("sign in, then type /quit (or Ctrl+D) in that CLI to come back"
                if not eng.login_run.endswith("login") and eng.login_run in ("qwen", "copilot")
                else "complete the sign-in in your browser, then come back here")

        def pick(i):
            if i != 0:
                self.info(f"sign in later: run  {eng.login_cmd}  then reselect {eng.short_label}.")
                return
            self._run_setup_cmd(cmd, hint)
        self._show_picker(f"Sign in to {eng.short_label} now? (opens your browser)",
                          ["Yes, sign in", "No"], pick)

    def _set_host(self, url: str, subagent: bool) -> None:
        if not url:
            self._flash("cancelled"); return
        self.config.set("subagent_base_url" if subagent else "base_url", url)
        if not subagent:
            self.agent.refresh_client()
        self._flash(f"{'sub-agent host' if subagent else 'endpoint'} → {url}")

    def _subagent_flow(self, rest: str) -> None:
        cfg = self.config
        args = rest.split()
        if args and args[0] == "model" and len(args) > 1:
            self._set_model_tui(args[1], subagent=True); return
        if args and args[0] == "host" and len(args) > 1:
            self._set_host(args[1], subagent=True); return
        if args and args[0] == "transport" and len(args) == 2:
            mode = args[1].lower()
            if mode not in ("auto", "ollama", "anthropic", "chat_completions", "responses"):
                self._flash(
                    "transport must be auto, ollama, anthropic, chat_completions, or responses"); return
            cfg.set("subagent_api_mode", mode)
            self._flash(f"sub-agent transport → {mode}"); return
        if args and args[0] == "clear":
            for k in ("subagent_model", "subagent_base_url", "subagent_api_key",
                      "subagent_api_mode"):
                cfg.set(k, "")
            self._flash("sub-agent overrides cleared — inherits the main model/host"); return
        labels = ["Set sub-agent host (provider or a custom LAN URL)",
                  "Set sub-agent model (from that host)",
                  "Set sub-agent API transport",
                  "Clear — inherit the main model & host"]

        def pick(i):
            if i == 0:
                self._connect_flow("", subagent=True)
            elif i == 1:
                self._model_flow(subagent=True)
            elif i == 2:
                modes = ["auto", "ollama", "anthropic", "chat_completions", "responses"]
                self._show_picker("Sub-agent transport", modes,
                                  lambda j: self._subagent_flow(f"transport {modes[j]}"))
            else:
                for k in ("subagent_model", "subagent_base_url", "subagent_api_key",
                          "subagent_api_mode"):
                    cfg.set(k, "")
                self._flash("sub-agent → inherits the main model/host")
        sm = cfg.get("subagent_model") or f"(inherit: {cfg.model})"
        sh = cfg.get("subagent_base_url") or "(inherit main host)"
        st = cfg.get("subagent_api_mode") or "inherit/infer"
        self._append(self._rich(
            f"[{style_mod.theme().faint}]sub-agent model {_esc(sm)} · host {_esc(sh)} · "
            f"transport {_esc(st)}[/]"))
        self._show_picker("Sub-agents", labels, pick)

    def _tui_worktree(self, rest: str) -> None:
        from . import worktree as wt
        th = style_mod.theme()
        root = self._fleet_root
        parts = rest.split()
        if not parts or parts[0] == "list":
            wts = wt.list_worktrees(root)
            if not wts:
                self._flash("not a git repo, or no worktrees — /worktree <name>")
                return
            rows = "\n".join(f"  [{th.accent}]{_esc(w.get('branch', '(detached)'))}[/]  "
                             f"[{th.faint}]{_esc(w['path'])}[/]" for w in wts)
            self._append(self._rich(f"[{th.faint}]git worktrees[/]\n{rows}"))
            return
        if parts[0] == "remove" and len(parts) > 1:
            target = " ".join(parts[1:])
            target_row = wt.find_worktree(root, target)
            target_path = (Path(target_row["path"]).resolve(strict=False)
                           if target_row is not None else None)
            live = next((s for s in self._sessions if target_path is not None
                         and wt.repo_root(getattr(s, "workspace_path", root)) == target_path), None)
            if live is not None:
                self._flash("that worktree belongs to a live agent — close the agent first")
                return
            err = wt.remove(root, target)
            self._flash(err or f"removed worktree {parts[1]}")
            return
        if self._turn.is_set():
            self._flash("stop the current turn before switching its workspace")
            return
        wt_path, branch, err = wt.create(root, rest.strip())
        if err:
            self._append(self._rich(f"[{th.err}]{_esc(err)}[/]"))
            return
        # Never chdir the whole process: other fleet workers may still be running. Replace only
        # this slot's runtime with one rooted in the isolated worktree.
        from .config import Config as _Config
        sess = self.active
        old_agent = sess.agent
        repo = wt.repo_root(root) or root
        try:
            project_rel = root.relative_to(repo)
        except ValueError:
            project_rel = Path(".")
        project_root = wt_path / project_rel
        new_config = _Config(project_root)
        try:
            new_agent = Agent(new_config, self)
        except Exception as exc:
            cleanup_error = wt.remove(root, str(wt_path))
            detail = f"; checkout retained at {wt_path}: {cleanup_error}" if cleanup_error else ""
            self._flash(f"couldn't start agent in {branch}: {type(exc).__name__}: {exc}{detail}")
            return
        new_agent.session_root = self._fleet_root
        prior_result = self._finalize_session_workspace(
            sess, "agent switched to a manual worktree")
        sess._aux_generation += 1
        sess._aux_cancel.set()
        sess._autotitle_pending = False
        try:
            old_agent.mcp.stop_all()
        except Exception:
            pass
        sess.config = new_config
        sess.agent = new_agent
        sess._cancel = new_agent.cancelled
        from . import sessions as _sess
        new_agent.session_file = _sess.new_path(self._fleet_root)
        new_agent.session_name = f"worktree {branch}"
        sess.workspace = None
        sess.workspace_kind = "manual"
        sess.workspace_path = project_root.resolve(strict=False)
        sess.workspace_branch = branch
        sess._workspace_finalized = False
        _sess.save_workspace(new_agent.session_file, self._fleet_root, kind="manual",
                             worktree=project_root, branch=branch,
                             **_session_generation_guard(new_agent))
        self.blocks.clear(); self._buf = ""
        prior = (f" · retained prior {prior_result.branch}" if prior_result is not None
                 and prior_result.status != "cleaned" else "")
        self._flash(f"worktree {branch} — switched, fresh session{prior}")

    def _tui_tasks(self, rest: str) -> None:
        th = style_mod.theme()
        try:
            parts = shlex.split(rest)
        except ValueError as exc:
            self._flash(f"invalid /tasks arguments: {exc}")
            return
        action = parts[0].lower() if parts else "list"
        tasks, errors = self.agent.retained_tasks()
        if action in ("list", "show"):
            selected = tasks
            if action == "show":
                if len(parts) != 2:
                    self._flash("usage: /tasks show ID")
                    return
                selected = [task for task in tasks if task.id == parts[1]]
                if not selected:
                    self._flash(f"no retained task matching {parts[1]}")
                    return
            if selected:
                rows = []
                for task in selected[:100]:
                    state = "legacy/manual" if task.legacy else ("ready" if task.available else "stale")
                    paths = ", ".join(task.display_paths[:5]) or "(none)"
                    if len(task.display_paths) > 5:
                        paths += f" (+{len(task.display_paths) - 5})"
                    rows.append(f"  [{th.accent}]{_esc(task.id)}[/]  [{th.faint}]{_esc(state)}[/]\n"
                                f"    {_esc(paths)}\n    [{th.faint}]{_esc(task.reason or '(unspecified)')}[/]\n"
                                f"    [{th.faint}]{_esc(str(task.path))}[/]")
                self._append(self._rich("retained sub-agent work\n" + "\n".join(rows)
                                        + (f"\n\nshowing 100 of {len(selected)} records" if len(selected) > 100 else "")
                                        + "\n\n/tasks apply ID  ·  /tasks drop ID --confirm"))
            else:
                self._flash("no retained sub-agent work for this project")
            for error in errors:
                self._append(self._rich(f"[{th.err}]{_esc(error)}[/]"))
            return
        if action not in ("apply", "drop") or len(parts) < 2:
            self._flash("usage: /tasks [list | show ID | apply ID | drop ID --confirm]")
            return
        if self.active._turn.is_set():
            self._flash("wait for the active turn to finish before resolving retained work")
            return
        task_id = parts[1]
        if action == "drop" and "--confirm" not in parts[2:]:
            self._flash(f"permanent: repeat /tasks drop {shlex.quote(task_id)} --confirm")
            return
        result = self.agent.resolve_retained_task(task_id, action)
        if result.status == "applied":
            warning = f" · cleanup warning: {result.cleanup_error}" if result.cleanup_error else ""
            self._flash(f"applied {len(result.paths)} path(s) from {task_id} · /rewind to undo{warning}")
        elif result.status == "clean":
            warning = f" · cleanup warning: {result.cleanup_error}" if result.cleanup_error else ""
            self._flash(f"{task_id} had no remaining changes{warning}")
        elif result.status == "dropped":
            self._flash(f"dropped retained task {task_id}")
        else:
            conflicts = f" · conflicts: {', '.join(result.conflicts[:8])}" if result.conflicts else ""
            self._append(self._rich(f"[{th.err}]could not {_esc(action)} {_esc(task_id)}: "
                                    f"{_esc(result.error or result.status)}{_esc(conflicts)}[/]"))

    def _keys(self) -> KeyBindings:
        kb = KeyBindings()

        ov_open = Condition(lambda: self._overlay is not None)

        @kb.add("/")
        def _(ev):
            b = self.input_buf
            if (self._overlay is None and not b.text
                    and self._req is None and not self._naming and self._input is None):
                b.insert_text("/")
                self._open_command_palette()            # `/` on an empty composer → command palette
                # (works mid-turn too — many commands like /copy, /expand, /thoughts are useful then)
            else:
                b.insert_text("/")

        @kb.add("backspace", filter=Condition(lambda: self._overlay is not None and self._overlay.get("on_submit")))
        def _(ev):
            self.input_buf.delete_before_cursor()
            if not self.input_buf.text.startswith("/"):  # deleted the leading slash → close palette
                self._close_overlay()

        @kb.add("up", filter=ov_open)
        def _(ev):
            self._overlay_move(-1)

        @kb.add("down", filter=ov_open)
        def _(ev):
            self._overlay_move(1)

        # `/` command palette navigation — the composer is multiline, so without these Down/Up would
        # move the cursor and CLOSE the completion menu (then Enter submitted a bare "/").
        comp_open = Condition(lambda: self._overlay is None and self.input_buf.complete_state is not None)

        @kb.add("down", filter=comp_open)
        def _(ev):
            self.input_buf.complete_next()

        @kb.add("up", filter=comp_open)
        def _(ev):
            self.input_buf.complete_previous()

        @kb.add("tab", filter=comp_open)
        def _(ev):
            self.input_buf.complete_next()

        @kb.add("c-p", filter=ov_open)
        def _(ev):
            self._overlay_move(-1)

        @kb.add("c-n", filter=ov_open)
        def _(ev):
            self._overlay_move(1)

        @kb.add("tab", filter=Condition(lambda: self._overlay is not None and self._overlay.get("tabs")))
        def _(ev):
            ov = self._overlay
            ov["tab"] = (ov["tab"] + 1) % len(ov["tabs"]); ov["sel"] = 0; ov["scroll"] = 0
            self.input_buf.reset(); self._invalidate()

        @kb.add("c-x", filter=Condition(lambda: self._overlay is not None and self._overlay.get("on_delete")))
        def _(ev):
            self._overlay_delete_armed()             # arm→confirm; cb re-opens with fresh rows

        # tabbed-modal action keys (a/x/r/space) — only when the overlay declares on_action
        has_actions = Condition(lambda: self._overlay is not None and self._overlay.get("on_action"))

        def _ov_action(key):
            ov = self._overlay
            if not (ov and ov.get("on_action")):
                return
            rows = self._overlay_rows()
            ov["on_action"](key, rows[ov["sel"]] if rows else None)

        for _ch in ("a", "x", "r", "p", "b"):
            @kb.add(_ch, filter=has_actions)
            def _(ev, _ch=_ch):
                _ov_action(_ch)

        @kb.add("space", filter=has_actions)
        def _(ev):
            _ov_action("space")

        @kb.add("enter")
        def _(ev):
            if self._overlay is not None:           # floating picker/modal
                self._overlay_select()              # shared with mouse-click
                return
            buf = self.input_buf
            if buf.complete_state is not None:      # the `/` command palette is open → resolve + RUN
                cs = buf.complete_state
                typed = buf.text.strip()
                names = {"/" + n for n, _ in SLASH_COMMANDS}
                if typed in names:                  # an exact command was typed → run it as-is
                    buf.cancel_completion()          # (so `/mode` isn't hijacked by `/model`)
                elif cs.current_completion is not None:
                    buf.apply_completion(cs.current_completion)   # user navigated → take it
                elif cs.completions:
                    buf.apply_completion(cs.completions[0])       # else take the top match
                else:
                    buf.cancel_completion()
                # fall through and submit — one Enter runs the command
            if self._req is not None:
                return                      # answered via number keys
            text = self.input_buf.text.strip()
            self.input_buf.reset()
            if self._naming:                # naming a fresh session (blank = unnamed)
                self._new_session(name=text or None)
                return
            if self._input is not None:     # free-text prompt (e.g. a custom host URL, MCP field)
                cb = self._input["cb"]; self._input = None
                cb(text)
                return
            if self._picker is not None:    # numbered pick (or dN to delete)
                p = self._picker; self._picker = None
                dc = p.get("delete_cb")
                if dc and text[:1].lower() == "d" and text[1:].strip().isdigit() \
                        and 1 <= int(text[1:]) <= len(p["labels"]):
                    dc(int(text[1:]) - 1)
                elif text.isdigit() and 1 <= int(text) <= len(p["labels"]):
                    p["cb"](int(text) - 1)
                else:
                    self._flash("cancelled")
                return
            if not text:
                return
            if self._turn.is_set():
                self._route_followup(text)
                return
            if text.startswith("/") and self._handle_slash(text):
                return
            if text.startswith("#"):
                self._save_memory_direct(text[1:])
                return
            if text.startswith("!"):
                self._submit_shell(text[1:])
                return
            self._submit(text)

        @kb.add("escape")
        def _(ev):
            if self._req is not None:                       # blocking prompt (permission card) → deny/cancel
                self._req_answer = None
                self._req_event.set()
                return
            if self._input is not None:                     # blocking/free-text prompt → cancel (empty)
                cb = self._input["cb"]; self._input = None
                cb("")
                return
            if self._overlay is not None:                   # non-blocking picker/palette/modal
                back = self._overlay.get("back")
                if back:                                    # sub-menu → step back to the parent menu
                    back()
                else:                                       # top-level menu → close
                    self._close_overlay()
                return
            if self._naming:
                self._naming = False
                self._flash("cancelled")
            elif self._picker is not None:
                self._picker = None
                self._flash("cancelled")
            elif self._turn.is_set():
                self._cancel.set()
            else:
                self.input_buf.reset()

        def cancel_gesture(ev):
            if self._req is not None:            # blocking prompt → cancel/deny (don't deadlock the worker)
                self._req_answer = None; self._req_event.set(); return
            if self._input is not None:
                cb = self._input["cb"]; self._input = None; cb(""); return
            if self._turn.is_set():             # a turn is running → cancel it
                self._cancel.set(); return
            if self._overlay is not None:        # a menu is open → close it
                self._close_overlay(); return
            if self.input_buf.complete_state is not None:
                self.input_buf.cancel_completion(); return
            if self.input_buf.text.strip():      # a draft is typed → clear it first
                self.input_buf.reset(); self._flash("draft cleared"); return
            now = time.monotonic()               # idle + empty → double-press to quit
            if now - self._quit_armed < 2.0:
                ev.app.exit()
            else:
                self._quit_armed = now
                self._flash("press Ctrl+C again to quit")

        @kb.add("c-c")
        @kb.add("c-q")
        def _(ev):
            cancel_gesture(ev)

        @kb.add("c-d")
        def _(ev):
            # Ctrl+D inside a picker that supports delete → delete the selected row (arm→confirm),
            # NOT close the menu — otherwise the advertised "^D delete" was a lie that closed the picker.
            if self._overlay is not None and self._overlay.get("on_delete"):
                self._overlay_delete_armed(); return
            cancel_gesture(ev)

        @kb.add("c-n")
        def _(ev):
            self._prompt_new_session()

        # cycle the active agent (Ctrl+O → next, wraps) — /dashboard for the full fleet. NOT Ctrl+] or
        # Ctrl+[: prompt_toolkit uses those (char-search prefix / Esc), and they swallow the next key.
        @kb.add("c-o", filter=Condition(lambda: self._overlay is None and len(self._sessions) > 1))
        def _(ev):
            self._switch_to((self._active_idx + 1) % len(self._sessions))

        # open the fleet dashboard — works even mid-turn (typing then would just steer the turn)
        @kb.add("c-\\", filter=Condition(lambda: self._overlay is None and self._req is None
                                         and not self._naming and self._input is None))
        def _(ev):
            self._open_dashboard()

        @kb.add("s-tab")
        def _(ev):
            self._cycle_mode()

        @kb.add("pageup")
        def _(ev):
            if self._overlay is not None and self._overlay.get("reader"):
                self._overlay_move(-(self._OVERLAY_CAP - 1)); return   # page the doc reader
            self._scroll_off += 10          # page up: keep an earlier line visible
            self._follow = False            # grab the transcript — new output no longer yanks us down
            self._invalidate()

        @kb.add("pagedown")
        def _(ev):
            if self._overlay is not None and self._overlay.get("reader"):
                self._overlay_move(self._OVERLAY_CAP - 1); return
            self._scroll_off = max(0, self._scroll_off - 10)
            self._follow = self._scroll_off == 0   # re-follow the live bottom once we reach it
            self._invalidate()

        # Arrow Up/Down scroll the transcript while the input is empty (browsing the chat); once you
        # start typing, arrows edit the prompt as usual. Overlay/completion nav is handled above.
        scroll_idle = Condition(lambda: self._overlay is None
                                and self.input_buf.complete_state is None
                                and not self.input_buf.text)

        @kb.add("up", filter=scroll_idle)
        def _(ev):
            self._scroll_off += 3
            self._follow = False
            self._invalidate()

        @kb.add("down", filter=scroll_idle)
        def _(ev):
            self._scroll_off = max(0, self._scroll_off - 3)
            self._follow = self._scroll_off == 0
            self._invalidate()

        @kb.add("end")
        def _(ev):
            self._scroll_off = 0            # jump back to the live bottom
            self._follow = True
            self._invalidate()

        @kb.add("c-r", filter=Condition(lambda: self._overlay is None and self._req is None
                                        and not self._turn.is_set() and not self._naming))
        def _(ev):
            self._open_history()            # recall a past prompt

        @kb.add("c-g", filter=Condition(lambda: self._overlay is None and self._req is None))
        def _(ev):
            self._open_cheatsheet()         # keyboard cheatsheet

        @kb.add("tab", filter=Condition(lambda: self.input_buf.suggestion is not None
                                        and self._overlay is None and self.input_buf.complete_state is None))
        @kb.add("right", filter=Condition(lambda: self.input_buf.suggestion is not None
                                          and self.input_buf.document.is_cursor_at_the_end and self._overlay is None))
        def _(ev):                          # accept the ghost-text suggestion 
            s = self.input_buf.suggestion
            if s:
                self.input_buf.insert_text(s.text)

        for i in range(1, 5):               # number keys answer a blocking request
            @kb.add(str(i))
            def _(ev, n=i):
                if self._req is not None:
                    opts = self._req.get("options", [])
                    if n - 1 < len(opts):
                        self._req_answer = n - 1
                        self._req_event.set()
                else:
                    self.input_buf.insert_text(str(n))
        return kb

    def _user_band_layout(self, text: str, tag: str = ""):
        """Return the cell-aware row plan shared by rendering and jump geometry."""
        text = style_mod.terminal_safe_text(text)
        tag = style_mod.terminal_safe_text(tag).replace("\n", " ")
        W = max(8, self._width - 2)
        compact = 0 < getattr(self, "_height", 0) <= self._AUTO_COMPACT_ROWS
        arrow = "" if compact else f"{glyphs.ARROW} "
        indent = "" if compact else "  "
        cw = max(1, W - _cell_len(arrow))
        tag_s = f"   {tag}" if tag else ""
        # A tag is secondary metadata. Drop it when a tiny terminal cannot retain at least one text
        # cell beside it instead of letting the background band overflow its promised width.
        if tag_s and _cell_len(tag_s) >= cw:
            tag_s = ""
        console = self._console()
        visual: list[tuple[str, str, bool]] = []
        for li, ln in enumerate((text.rstrip("\n") or "").split("\n")):
            first = li == 0
            avail = max(1, cw - (_cell_len(tag_s) if first else 0))
            wrapped = Text(ln).wrap(console, avail, overflow="fold") or [Text("")]
            for j, segment in enumerate(wrapped):
                visual.append((arrow if (first and j == 0) else indent,
                               segment.plain, first and j == 0))
        return W, compact, tag_s, visual

    def _user_band(self, text: str, tag: str = ""):
        """The user's prompt as a full-width, bg-tinted band with a ❯ prefix — a highlighted block
        that reads distinctly from the assistant text. Every visual row is padded to the exact band
        width so the tint spans edge-to-edge at ANY terminal size: a short or wrapped line never
        leaves a ragged/partial tint (the small-terminal "box breaks" bug). Long lines word-wrap to
        the content width with continuation rows indented under the arrow; `tag` marks the first row
        (e.g. "follow-up" for a mid-turn prompt). Normally one tinted blank row pads above and below
        the text (the untinted breathing room around it is the transcript's inter-block gap). On a
        SHORT terminal (height ≤ _AUTO_COMPACT_ROWS) the band auto-compacts: it drops those tinted
        vpad rows AND the ❯ prefix, keeping only the tint — so a small window isn't eaten by padding."""
        th = style_mod.theme()
        W, compact, tag_s, visual = self._user_band_layout(text, tag)
        t = Text()
        if not compact:
            t.append(" " * W + "\n")                  # tinted vpad — top (skipped when compact)
        for pre, seg, is_first in visual:
            row = Text()
            row.append(pre, style=f"bold {th.accent}")
            row.append(seg, style=th.text_strong)
            if is_first and tag_s:
                row.append(tag_s, style=th.faint)
            row.truncate(W, overflow="ellipsis")
            if row.cell_len < W:
                row.append(" " * (W - row.cell_len))  # pad in terminal cells so the tint reaches the edge
            t.append_text(row)
            t.append("\n")
        if not compact:
            t.append(" " * W)                         # tinted vpad — bottom (skipped when compact)
        # compact ends on the last text row; _rich() strips the trailing newline, so no blank tinted row.
        t.stylize(f"on {th.band}")                    # a clearly-visible raised background band
        return self._rich(t)

    def _cur_session(self) -> "AgentSession":
        """The session the CURRENT thread is acting for: a worker thread's own session, else active."""
        tls = getattr(self, "_tls", None)
        return (getattr(tls, "session", None) if tls else None) or self.active

    @staticmethod
    def _queue_followup(sess: "AgentSession", text: str, *, shown: bool,
                        front: bool = False) -> bool:
        """Retain one bounded follow-up for the session's serialized next turn."""
        item = (str(text), bool(shown))
        with sess._queue_lock:
            queued_chars = sum(len(queued_text) for queued_text, _ in sess._queue)
            char_limit = (_MAX_TRANSITIONAL_FOLLOWUP_CHARS if front
                          else _MAX_QUEUED_FOLLOWUP_CHARS)
            if ((not front and len(sess._queue) >= _MAX_QUEUED_FOLLOWUPS)
                    or queued_chars + len(item[0]) > char_limit):
                return False
            if front:
                sess._queue.insert(0, item)
            else:
                sess._queue.append(item)
        return True

    @staticmethod
    def _pop_followup(sess: "AgentSession") -> tuple[str, bool] | None:
        with sess._queue_lock:
            return sess._queue.pop(0) if sess._queue else None

    def _route_followup(self, text: str) -> str:
        """Atomically steer the active model turn or retain text as the next turn."""
        sess = self._cur_session()
        if sess.agent.steer(text):
            sess.blocks.append({"kind": "user", "text": text,
                                "tag": "follow-up · steering this turn"})
            sess._scroll_off = 0
            sess._follow = True
            self._invalidate()
            return "steered"
        if not self._queue_followup(sess, text, shown=False):
            self._flash(
                f"follow-up queue full ({_MAX_QUEUED_FOLLOWUPS} prompts / "
                f"{_MAX_QUEUED_FOLLOWUP_CHARS} characters) — wait for this turn")
            return "full"
        self._flash("follow-up queued for the next turn")
        return "queued"

    def _run_delegated_turn(self, engine_key: str, prompt: str) -> bool:
        """3b — run this turn through the user's own subscription CLI, streaming its
        output into the transcript via the same UI callbacks the agent uses. Esc/Ctrl-C
        cancels it (the CLI's whole process group is killed)."""
        from . import subscriptions as subs
        engine = subs.get_engine(engine_key)
        if engine is None:
            self.error(f"unknown subscription engine '{engine_key}'")
            return False
        try:
            subs.preflight(engine)
        except subs.EngineError as e:
            self.error(str(e))
            return False
        self.info(f"running this turn through {engine.label} (your subscription)…")
        turns = getattr(self, "_delegated_turns", 0)
        shown = {"text": False}
        names, diffs = {}, {}                     # tool_use id → (display name, prebuilt edit diff)

        def on_event(ev: dict) -> None:
            kind = ev.get("kind")
            if kind == "text" and ev.get("text"):            # the assistant's answer, streamed
                shown["text"] = True
                self.on_text(ev["text"] if ev["text"].endswith("\n") else ev["text"] + "\n")
            elif kind == "thinking" and ev.get("text"):      # dimmed reasoning, like a native turn
                self.on_thinking(ev["text"])
            elif kind == "tool_call":                        # a real tool card (name + args)
                nm, cid = ev.get("name", "tool"), ev.get("id") or None
                if cid:
                    names[cid] = nm
                    d = subs.edit_diff(nm, ev.get("args") or {})
                    if d:
                        diffs[cid] = d
                self.tool_call(nm, ev.get("args") or {}, cid)
            elif kind == "tool_result":                      # fills the card; a diff renders as a diff
                cid = ev.get("id") or None
                self.tool_result(names.get(cid, ""), diffs.get(cid) or ev.get("output", ""), cid)
            elif kind == "result" and not shown["text"] and ev.get("text"):
                self.on_text(ev["text"] if ev["text"].endswith("\n") else ev["text"] + "\n")

        budget = int(self.config.get("turn_budget_s") or 0) or 1800
        try:
            res = subs.run_turn(engine, prompt, self.config.project_root,
                                cont=turns > 0, timeout=budget, on_event=on_event,
                                cancel=self._cancel.is_set,
                                model=str(self.config.get("subscription_model", "")).strip(),
                                effort=str(self.config.get("subscription_effort", "")).strip())
        except subs.EngineError as e:
            self.error(str(e))
            return False
        finally:
            self.end_stream()
        if res.get("cancelled"):
            self.info("stopped.")
            return False
        if res.get("timeout"):
            self.error("the delegated turn hit the time budget and was stopped")
            return False
        setattr(self, "_delegated_turns", turns + 1)
        return res.get("rc") == 0

    def _submit(self, text: str, *, echo: bool = True) -> None:
        sess = self._cur_session()                    # this turn belongs to THIS session
        sess.last_activity = time.monotonic()
        self._cancel_auxiliary()                       # foreground work always preempts title/suggest
        self._cancel.clear()
        self._tool_count = 0
        self._suggestion = None                       # a new prompt supersedes the ghost text
        if text.strip():
            self._prompt_history.append(text)         # for /history (Ctrl+R) recall
        if echo:
            self.blocks.append({"kind": "user", "text": text})  # reflows at current width
            mark = len(self.blocks) - 1
        else:
            mark = next((index for index in range(len(self.blocks) - 1, -1, -1)
                         if self.blocks[index].get("kind") == "user"
                         and self.blocks[index].get("text") == text), len(self.blocks) - 1)
        if mark >= 0:
            self._turn_marks.append((mark, text.replace("\n", " ")[:70]))  # for /jump
        self._scroll_off = 0                # ALWAYS snap to the bottom so the prompt + stream are visible
        self._follow = True
        self._turn.set()
        self._turn_t0 = time.monotonic()

        def work():
            self._tls.session = sess        # route this worker thread's agent callbacks to `sess`
            succeeded = False
            try:
                self._foreground_aux_barrier()
                # _submit cleared stale state before marking the turn active. Preserve an Esc/Ctrl-C
                # received while the worker waits at the auxiliary-generation barrier.
                model_text = self._expand_mentions(text)
                _se = str(self.config.get("subscription_engine", "")).strip().lower()
                if _se:
                    succeeded = self._run_delegated_turn(_se, model_text)
                else:
                    succeeded = self.agent.run_turn(model_text, reset_cancel=False) is not False
            except Exception as e:
                self.error(f"{type(e).__name__}: {e}")
            finally:
                take_deferred = getattr(self.agent, "take_deferred_steers", None)
                deferred = take_deferred() if callable(take_deferred) else []
                if deferred:
                    # These bands were rendered when accepted as steering. The old turn ended before
                    # consuming them, so preserve their order as one subsequent prompt without echoing.
                    self._queue_followup(sess, "\n".join(deferred), shown=True, front=True)
                self._flush_text()
                self._settle_running_tools()     # stop any tool rail still animating (e.g. cancelled mid-run)
                self._turn.clear()
                sess.last_activity = time.monotonic()
                el = time.monotonic() - self._turn_t0
                th = style_mod.theme()
                verb = ("stopped" if self._cancel.is_set() else
                        ("done" if succeeded else "failed"))
                self._append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} {verb} · {el:.0f}s"
                                        + (f" · {self._tool_count} tool" +
                                           ("" if self._tool_count == 1 else "s") if self._tool_count else "") + "[/]"))
                if sess is not self.active and not self._cancel.is_set():   # a background agent finished
                    self._flash(f"⧉ {sess.name or 'agent'} finished — ^\\ to view")
                self._invalidate()
                if sess._closing:
                    result = self._finalize_session_workspace(sess, "fleet session stopped")
                    sess._worker_thread = None
                    if result is not None and result.status != "cleaned":
                        self._flash(f"retained {result.branch} at {result.path}")
                    return
                queued = self._pop_followup(sess)
                if queued is not None:
                    sess._worker_thread = None
                    queued_text, shown = queued
                    self._submit(queued_text, echo=not shown)
                    return
                if not succeeded:
                    sess._worker_thread = None
                    return
                title_needed = (not self.agent.session_name and not self._autotitled
                                and not sess._autotitle_pending and not self._cancel.is_set())
                suggestion_needed = (bool(self.config.get("suggest", True))
                                     and not self._cancel.is_set())
                resp = next((m.get("content", "") for m in reversed(self.agent.messages)
                             if m.get("role") == "assistant"), "")
                self._schedule_auxiliary(
                    sess, text, str(resp), title=title_needed, suggestion=suggestion_needed)
                sess._worker_thread = None

        sess._worker_thread = threading.Thread(
            target=work, name=f"dgc-turn-{sess.id}", daemon=True)
        sess._worker_thread.start()

    def _expand_mentions(self, text: str) -> str:
        """Prepare the same bounded @path payload used by classic and one-shot CLI turns."""
        self.agent._pending_images = None
        result = attachments_mod.expand_attachments(
            text, self.config.project_root,
            sanitizer=lambda value: redact_text(value, secret_values(self.config)),
            cancelled=self._cancel)
        self.agent._pending_images = list(result.images) or None
        for notice in result.notices:
            self.info(notice)
        return result.text

    def _save_memory_direct(self, text: str, scope: str = "project", *, show_entry: bool = True) -> bool:
        """Persist an explicit terminal memory action without asking the model to interpret it."""
        value = str(text or "").strip()
        if not value:
            self._flash("enter a memory after #, or use /memory add [user] TEXT")
            return False
        self._cancel.clear()
        try:
            from .memory import add_memory
            path = add_memory(value, self.config.project_root, scope, cancelled=self._cancel)
        except (OSError, RuntimeError, ValueError) as exc:
            self._flash(f"memory was not saved: {str(exc)[:160]}")
            return False
        if show_entry:
            shown = "#" + value
            self.blocks.append({"kind": "user", "text": shown, "tag": "saved memory"})
            self._scroll_off = 0
            self._follow = True
            self._invalidate()
        label = "user memory" if scope == "user" else "project memory"
        self._flash(f"saved to {label} · {path.name}")
        return True

    def _submit_shell(self, command: str) -> None:
        """Execute an explicitly entered ``!`` command without routing it through the model."""
        command = str(command or "").strip()
        if not command:
            self._flash("enter a command after !")
            return
        sess = self._cur_session()
        sess.last_activity = time.monotonic()
        self._cancel_auxiliary()
        self._cancel.clear()
        self._suggestion = None
        shown = "!" + command
        self.blocks.append({"kind": "user", "text": shown, "tag": "direct shell"})
        self._turn_marks.append((len(self.blocks) - 1, shown.replace("\n", " ")[:70]))
        self._scroll_off = 0
        self._follow = True
        self._turn.set()
        self._turn_t0 = time.monotonic()

        def work() -> None:
            self._tls.session = sess
            succeeded = False
            try:
                self._foreground_aux_barrier()
                from .tools import direct_bash
                result = direct_bash(command, self.agent.ctx)
                succeeded = not result.startswith("error:")
                th = style_mod.theme()
                self._append(self._rich(Text(
                    style_mod.terminal_safe_text(result),
                    style=th.faint if succeeded else th.err)))
            except Exception as exc:
                self.error(f"{type(exc).__name__}: {exc}")
            finally:
                self._turn.clear()
                sess.last_activity = time.monotonic()
                elapsed = time.monotonic() - self._turn_t0
                th = style_mod.theme()
                verb = ("stopped" if self._cancel.is_set() else
                        ("done" if succeeded else "failed"))
                self._append(self._rich(
                    f"[{th.faint}]{glyphs.MIDDOT} {verb} · {elapsed:.0f}s · direct shell[/]"))
                self._invalidate()
                if sess._closing:
                    result = self._finalize_session_workspace(sess, "fleet session stopped")
                    sess._worker_thread = None
                    if result is not None and result.status != "cleaned":
                        self._flash(f"retained {result.branch} at {result.path}")
                    return
                queued = self._pop_followup(sess)
                if queued is not None:
                    sess._worker_thread = None
                    queued_text, shown = queued
                    self._submit(queued_text, echo=not shown)
                    return
                sess._worker_thread = None

        sess._worker_thread = threading.Thread(
            target=work, name=f"dgc-shell-{sess.id}", daemon=True)
        sess._worker_thread.start()

    def _shutdown_fleet(self) -> None:
        """Cancel all workers and preserve every managed checkout before the TUI process exits."""
        fleet = list(getattr(self, "_sessions", ()))
        for sess in fleet:
            sess._closing = True
            with sess._queue_lock:
                sess._queue.clear()
            sess._aux_cancel.set()
            sess._cancel.set()
            sess._req_answer = None
            sess._req_event.set()
            try:
                sess.agent.mcp.stop_all()
            except Exception:
                pass
        deadline = time.monotonic() + 2.0
        for sess in fleet:
            worker = sess._worker_thread
            if worker and worker.is_alive() and worker is not threading.current_thread():
                worker.join(max(0.0, deadline - time.monotonic()))
        for sess in fleet:
            worker = sess._worker_thread
            self._finalize_session_workspace(
                sess, "DGC exited before this fleet agent fully stopped",
                retain_if_running=bool(worker and worker.is_alive()))

    def run(self) -> None:
        # keep the width in sync + drive the idle/turn animation
        def sizer():
            while True:
                try:
                    self._width = self.app.output.get_size().columns
                except Exception:
                    pass
                time.sleep(0.5)
        threading.Thread(target=sizer, daemon=True).start()
        from . import termbg
        termbg.apply(self.config)          # dark canvas on a light terminal (idempotent; CLI may have done it)
        try:
            self.app.run()
        finally:
            self._shutdown_fleet()
            termbg.reset()
        if getattr(self, "_pending_update", False):     # user ran /update — install on the raw TTY
            from .update import run_update
            run_update()
            return
        # NOTE: the resume hint on exit is printed ONCE by the CLI (cli._print_resume_hint), which
        # offers BOTH `dgc --continue` and `dgc --resume <id>` in a single block. Don't print a second
        # one here or the user sees two separate "Resume this session" notices.


# ---------------------------------------------------------------- helpers ---
def _tui_help() -> str:
    th = style_mod.theme()
    groups = [
        ("session", [("/new", "start a new session (asks for a name)"),
                     ("/name <name>", "name the current session"),
                     ("/resume", "pick a past session to resume"),
                     ("/worktree <name>", "list or switch to a named long-lived worktree"),
                     ("/tasks", "inspect/apply/drop retained sub-agent work"),
                     ("/clear", "clear the transcript")]),
        ("model & host", [("/model", "pick a model from the endpoint"),
                          ("/connect", "pick a provider, or enter a custom LAN host URL"),
                          ("/subagent", "sub-agent model + host + API transport"),
                          ("/think off|low|medium|high", "reasoning effort")]),
        ("settings", [("/mode <mode>", "default · acceptEdits · plan · auto (Shift+Tab cycles)"),
                      ("/bg auto|dark|inherit", "background (dark = force on a light terminal)"),
                      ("/theme dark|light", "colour theme"),
                      ("/sandbox on|off", "strongest supported OS shell boundary; network off by default"),
                      ("/context", "context usage"), ("/compact", "summarise old turns now")]),
        ("inspect", [("/status", "model · host · mode · context · session"),
                     ("/agents", "sub-agent defaults"), ("/skills", "installed skills"),
                     ("/mcp", "MCP servers"), ("/memory", "project DGC.md"),
                     ("/permissions", "allow/ask/deny rules"), ("/bug", "report a bug on GitHub"),
                     ("/quit", "exit (Ctrl+Q)")]),
    ]
    out = [f"[bold {th.accent}]commands[/]"]
    for name, rows in groups:
        out.append(f"[{th.muted}]{name}[/]")
        for c, d in rows:
            out.append(
                f"  [bold]{_esc(c)}[/]{' ' * max(2, 30 - _cell_len(c))}"
                f"[{th.faint}]{_esc(d)}[/]")
    out.append(f"[{th.faint}]  /rewind, /init, /search live in the classic REPL: dgc --classic[/]")
    return "\n".join(out)


class _ClickControl(FormattedTextControl):
    """A FormattedTextControl that also dispatches whole-control clicks to `on_click`
    (so the welcome card's menu rows are mouse-clickable), and mouse-wheel scroll to
    `on_scroll(delta)` (+ = up into history)."""

    def __init__(self, text, on_click=None, on_move=None, on_scroll=None):
        super().__init__(text)
        self._on_click = on_click
        self._on_move = on_move
        self._on_scroll = on_scroll

    def mouse_handler(self, mouse_event):
        from prompt_toolkit.mouse_events import MouseEventType
        et = mouse_event.event_type
        if self._on_scroll and et == MouseEventType.SCROLL_UP:
            self._on_scroll(3); return None
        if self._on_scroll and et == MouseEventType.SCROLL_DOWN:
            self._on_scroll(-3); return None
        if et == MouseEventType.MOUSE_MOVE and self._on_move:
            self._on_move(mouse_event.position)
            return None
        if et == MouseEventType.MOUSE_UP and self._on_click and self._on_click(mouse_event.position):
            return None
        return super().mouse_handler(mouse_event)


def _arg_summary(args: dict) -> str:
    for k in ("path", "command", "pattern", "url", "name", "description", "symbol", "operation"):
        if k in args:
            v = style_mod.terminal_safe_text(args[k]).replace("\n", " ")
            return v[:100] + ("…" if len(v) > 100 else "")
    return ""


def _esc(s: str) -> str:
    return style_mod.terminal_safe_text(s).replace("[", r"\[")
