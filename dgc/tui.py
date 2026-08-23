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
import math
import re
import threading
import time

from prompt_toolkit.application import Application
from prompt_toolkit.auto_suggest import AutoSuggest, Suggestion
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import ConditionalContainer, Float, FloatContainer, HSplit, Layout, VSplit, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.menus import CompletionsMenu
from rich.console import Console

from . import __version__, glyphs, logo as logo_mod, render as render_mod, style as style_mod
from .update import cached_update
from .agent import Agent

# The slash-command palette — name → one-line description. Drives both the `/` menu
# (a live dropdown above the composer) and the /help listing. Order = most-reached first.
SLASH_COMMANDS: list[tuple[str, str]] = [
    ("help", "list every command"),
    ("keys", "keyboard shortcuts cheatsheet"),
    ("docs", "in-app how-to guides"),
    ("new", "start a new session"),
    ("resume", "reopen a past session · ^D deletes one"),
    ("history", "search & recall a past prompt"),
    ("jump", "jump the transcript to a past turn"),
    ("rewind", "restore code + conversation to a past turn"),
    ("model", "switch the model"),
    ("connect", "pick a provider or a custom LAN host"),
    ("subagent", "set the sub-agent model + host"),
    ("mode", "permission mode: default · acceptEdits · plan · auto"),
    ("view-plan", "reopen the plan saved in plan mode"),
    ("think", "how hard the model reasons: off · low · medium · high"),
    ("thoughts", "show or hide the model's thinking in the transcript"),
    ("expand", "expand the last collapsed tool output (/expandall for all)"),
    ("copy", "select & copy text — releases the mouse to your terminal"),
    ("worktree", "isolate edits in a git worktree"),
    ("sandbox", "confine bash to the project + /tmp"),
    ("bg", "terminal background: auto · dark · inherit"),
    ("theme", "colour theme: auto · dark · light"),
    ("context", "context-window usage"),
    ("artifact", "open / stop localhost artifact previews"),
    ("compact", "summarise the older turns now"),
    ("status", "model · host · mode · context"),
    ("dashboard", "session roster — open, switch, start, or delete sessions"),
    ("name", "name this session"),
    ("goal", "set a standing objective the agent keeps working toward · /goal clear"),
    ("set", "tune a setting live: /set temperature 0.7 · top_p · top_k · min_p · max_tokens"),
    ("settings", "browse & edit all settings in a menu (model, sampling, display, artifacts)"),
    ("handoff", "write a full handoff doc (objective, done, next steps) to give another agent"),
    ("mcp", "MCP servers — /mcp add to connect one, /mcp remove <name>"),
    ("agents", "sub-agent configuration"),
    ("skills", "installed skills"),
    ("memory", "view the project DGC.md"),
    ("permissions", "allow · ask · deny rules"),
    ("bug", "report a bug / request a feature"),
    ("update", "update DGC to the latest version"),
    ("clear", "clear the transcript"),
    ("quit", "exit dgc"),
]


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
        self._queue: list[str] = []
        self._turn_t0 = 0.0
        self._phase_act: str | None = None
        self._phase_t0 = 0.0
        self._autotitled = False
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

    # per-session state → delegated to the active AgentSession (multi-agent fleet)
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
        self.config = config
        style_mod.set_theme(config.get("theme", "dark"))
        # the fleet: one active AgentSession now; /dashboard spawns + switches more. Every
        # per-conversation field (agent, blocks, _buf, _turn, _todos, _req, …) is an _active_prop
        # that reads/writes the ACTIVE session, so the rest of the TUI is untouched.
        self._sessions: list[AgentSession] = [AgentSession(config, self, agent=agent)]
        self._active_idx = 0
        self._tls = threading.local()      # per-thread: which session a worker thread's turn belongs to
        self.agent.ui = self               # the agent calls back into this TUI

        self._start = time.monotonic()
        self.deny_reason = ""              # set when the user denies a tool "with a reason"
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
            rows = [(n, d) for n, d in SLASH_COMMANDS if not q or q in n.lower() or q in d.lower()]
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
        "sandbox": ([("On — confine bash", "on"), ("Off", "off")],
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
            ("thinking", "Thinking effort", "enum", ["off", "low", "medium", "high"]),
            ("temperature", "Temperature", "float"), ("top_p", "Top-p", "float"),
            ("top_k", "Top-k", "int"), ("min_p", "Min-p", "float"),
            ("max_tokens", "Max output tokens", "int"), ("context_size", "Context window", "int"),
        ],
        "Behaviour": [
            ("mode", "Permission mode", "enum", ["default", "acceptEdits", "plan", "auto"]),
            ("max_turns", "Max tool iterations", "int"), ("bash_timeout", "Bash timeout (s)", "int"),
            ("verify_before_done", "Verify before finishing", "bool"),
            ("verify_command", "Verify command", "str"), ("suggest", "Ghost-text suggestions", "bool"),
            ("sandbox", "Confine bash (sandbox)", "bool"),
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
            ("artifact_in_plan", "Allow in plan mode", "bool"),
        ],
    }
    _CLIENT_KEYS = {"model", "base_url", "api_key", "temperature", "top_p", "top_k", "min_p",
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
            self.agent.set_mode(str(val))
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
        labw = min(max((len(r.get("label", "")) for r in rows), default=8), 34)
        # Hit-map recorded during render : screen-y → row index, and the
        # tab strip's x-ranges. Panel line 0 is the top border, so the k-th content line
        # sits at screen y = 1 + k. Every content line is kept to ONE screen row (truncated,
        # never wrapped) so the map stays exact. XOFF = left pad + 1 border + 1 panel pad.
        ov["_rowmap"], ov["_tabmap"], ov["_tab_y"], XOFF = {}, [], None, lpad + 2
        lines: list = []

        def emit(line):                                 # append, clamped to one screen row
            if not isinstance(line, Text):
                line = Text(str(line))
            line.truncate(inner, overflow="ellipsis")
            lines.append(line)

        if ov.get("tabs"):                              # tab strip (tabbed modal)
            strip = Text()
            ov["_tab_y"] = 1 + len(lines)
            cx = XOFF
            for i, t in enumerate(ov["tabs"]):
                seg = f" {t} "
                if i == ov["tab"]:
                    stl = f"bold {th.bg} on {th.accent}"
                elif i == ov.get("_tab_hover"):
                    stl = f"bold {th.text} on {th.surface2}"     # hover feedback
                else:
                    stl = th.muted
                ov["_tabmap"].append((cx, cx + len(seg), i))
                strip.append(seg, style=stl)
                strip.append(" ")
                cx += len(seg) + 1
            lines.append(strip)                          # (2 short tabs never wrap)
            emit(Text("─" * inner, style=th.border))
        elif ov.get("title"):
            emit(Text(ov["title"], style="bold"))
        if ov.get("header"):                            # a rich block (e.g. the command being approved)
            for h in ov["header"]:
                emit(h if isinstance(h, Text) else Text(str(h)))
            emit(Text("─" * inner, style=th.border))
        if not visible and not ov.get("info"):
            emit(Text("  (no matches)", style=th.faint))
        for i, r in enumerate(visible):
            if ov.get("reader"):                        # a doc line — render pre-styled, no cursor/bar
                t = r.get("text")
                line = t.copy() if isinstance(t, Text) else Text(r.get("label", ""))
                line.truncate(inner, overflow="ellipsis")
                ov["_rowmap"][1 + len(lines)] = scroll + i
                lines.append(line)
                continue
            hot = (scroll + i == sel)
            line = Text()
            line.append("❯ " if hot else "  ", style=f"bold {th.accent}" if hot else th.faint)
            line.append(r.get("label", "").ljust(labw), style="bold" if hot else th.text)
            if r.get("desc"):
                line.append("  " + r["desc"], style=th.muted)   # readable (not dim faint) either way
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
            emit(Text(ov["footer"], style=th.faint))
        panel = Panel(Text("\n").join(lines), box=_box.ROUNDED,
                      border_style=(th.accent if ov.get("accent") else th.border_strong),
                      padding=(0, 1), width=W)
        return ANSI(self._rich(Padding(panel, (0, 0, 0, lpad))))

    def _ask_input(self, prompt: str, cb) -> None:
        self._input = {"cb": cb, "prompt": prompt}
        self._flash(prompt)

    def _flash(self, msg: str) -> None:
        """Show a short confirmation in the status line so an action visibly registered."""
        self._flash_msg = msg
        self._flash_until = time.monotonic() + 2.2
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
        import textwrap
        out: list[str] = []
        for para in text.split("\n"):
            out.extend(textwrap.wrap(para, width) if para.strip() else [""])
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
                # spacing rhythm: a blank line above assistant prose + reasoning (breathing room);
                # pack everything else together — adjacent tool calls, and bands that already carry
                # their own vertical padding.
                ft.append(("", "\n\n" if kind in ("text", "think") else "\n"))
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
            for i, ln in enumerate(self._wrap_tail(self._think, max(20, self._width - 4), 5)):
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
        return render_mod.render_markdown(text)

    # ---- header (welcome card when empty, slim line when busy) ----
    def _header(self):
        self._sync_width()                  # resize with the terminal, before laying anything out
        th = style_mod.theme()
        if self.blocks or self._buf or self._overlay:   # conversation / overlay open → slim line
            import re
            nm = f" · {self.agent.session_name}" if self.agent.session_name else ""
            left = self._rich(f" [bold {th.accent}]Vibe DGC[/] "
                              f"[{th.faint}]· {self.config.model} · {self.agent.mode}{_esc(nm)}[/]")
            chip, cw = self._context_chip(self._ctx_hover)      # top-right token counter 
            right = self._rich(chip)
            lw = len(re.sub(r"\x1b\[[0-9;?]*m", "", left))
            gap = max(2, self._width - lw - cw - 1)
            self._ctx_x0, self._ctx_x1 = lw + gap, lw + gap + cw   # record for hover/click
            return ANSI(left + " " * gap + right)
        self._ctx_x0 = self._ctx_x1 = -1
        return ANSI(self._welcome_card())

    def _ctx_color(self, pct: float, th):
        return th.err if pct >= 90 else th.warn if pct >= 75 else th.muted if pct >= 50 else th.text

    def _context_chip(self, hover: bool):
        """Top-right context counter  Default: `used / total` (colored by an
        urgency gradient). Hover: morph to `█████ 42.0%` at the SAME width (no layout shift)."""
        th = style_mod.theme()
        used, size = self.agent.estimate_tokens(), int(self.config.get("context_size", 32768))
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
        used, size = self.agent.estimate_tokens(), int(self.config.get("context_size", 32768))
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
            return 2 + len((blk.get("text", "").rstrip("\n") or "").split("\n"))  # top+bottom vpad + text lines
        if isinstance(blk, dict) and blk.get("kind") == "tool":
            if blk.get("diff"):
                return 1 + blk["diff"].count("\n") + 1          # header + rendered diff lines
            n = len((blk.get("out") or "").splitlines())
            body = (n if blk.get("exp") else min(n, self._TOOL_HEAD)) + (1 if n > self._TOOL_HEAD else 0)
            return 1 + body                                     # header line + output body
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
            _msgs, nfiles = self.agent.rewind(idx)
        except Exception as e:
            self._flash(f"rewind failed: {type(e).__name__}"); return
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
                         ("/", "command palette"), ("@ path", "attach a file"), ("Ctrl+R", "recall a past prompt"),
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
        c.print(render_mod.render_markdown(md))
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
        md = sessions.load_plan(self.agent.session_file) if self.agent.session_file else None
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
        used, size = self.agent.estimate_tokens(), int(self.config.get("context_size", 32768))
        pct = used * 100 / size if size else 0.0
        col = self._ctx_color(pct, th)
        full, part, empty = render_mod.frac_bar(pct, 22)
        arts = artifacts.registry()
        running = sum(1 for s in self._sessions if s.state == "running")
        needs = sum(1 for s in self._sessions if s.state == "needs_input")

        h1 = Text("  "); h1.append(self.config.model, style=f"bold {th.text_strong}")
        h1.append(f"   {self.agent.mode} · think {self.config.get('thinking', 'off')}", style=th.muted)
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
            rows.append({"label": f"{_MARK.get(st, '○')} {pin}{title}", "desc": _DESC.get(st, "idle") + tools,
                         "value": ("switch", s), "action": True})
            if s.agent.session_file:
                open_files.add(str(s.agent.session_file))
        # saved sessions not currently open in the fleet
        now = time.time()
        for p, ts, prev, n, name in sessions.listing(self.config.project_root)[:30]:
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
            else:                                        # open a saved session into a fresh fleet slot
                self._new_session()
                n = self.agent.load_session(v)
                self.blocks.clear(); self._buf = ""; self._think = ""
                self._render_history()
                self._flash(f"opened ({n} messages)")

        def on_action(key, r):
            if not r:
                return
            kind, v = r["value"]
            if key in ("x", "space"):
                if kind == "switch" and v in self._sessions:
                    self._close_session(self._sessions.index(v)); self._open_dashboard()
                elif kind == "open":
                    sessions.delete(v); self._flash("deleted"); self._open_dashboard()
            elif key == "p" and kind == "switch":
                v.pinned = not v.pinned; self._open_dashboard()
            elif key == "r" and kind == "switch":
                self._close_overlay()
                self._ask_input(f"rename '{v.name or 'agent'}' then Enter",
                                lambda nm, _v=v: (_v.agent.name_session(nm.strip()) if nm.strip() else None,
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
                t.append(f"  {glyphs.MIDDOT} ⬆ v{upd} /update", style=f"bold {self._GOLD}")
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
            right = len(key) + 2 + len(slash)
            t = Text()
            t.append("› " if h else "  ", style=f"bold {th.accent}")
            t.append(lbl, style=f"bold {th.accent}" if h else "bold")
            t.append(" " * max(2, text_w - 2 - len(lbl) - right))
            t.append(key, style=th.accent if h else th.faint); t.append("  ")
            t.append(slash, style=f"bold {th.accent_bright}" if h else th.accent_dim)
            return t

        # title
        title = Text(); title.append("Vibe DGC", style="bold #FFFFFF")
        title.append(f"  v{__version__}", style=th.faint)
        if self.agent.session_name:
            title.append(f"  {glyphs.MIDDOT}  {self.agent.session_name}", style=th.accent)
        add(title)
        add(Text(""))
        if upd:                                            # ── update available: message + clickable CTA ──
            msg = Text(f"v{upd} is out", style=f"bold {self._GOLD}")
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
                                   f"[{th.faint}]· {self._req.get('hint', '')}[/]"))
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
        import re
        L, R = self._rich(left), self._rich(right)
        vis = lambda s: len(re.sub(r"\x1b\[[0-9;?]*m", "", s))   # visible width (ANSI stripped)
        gap = max(2, self._width - len(indent) - vis(L) - vis(R) - 1)
        return ANSI(indent + L + " " * gap + R)

    # ---- composer info line (model · mode) ----
    def _info(self):
        th = style_mod.theme()
        mode = self.agent.mode
        mc = {"default": th.muted, "acceptEdits": th.accent, "plan": th.accent_bright, "auto": th.err}
        return ANSI(self._rich(f"[{th.faint}]{self.config.model}[/]  "
                               f"[{th.faint}]{glyphs.MIDDOT}[/]  [{mc.get(mode, th.muted)}]{mode}[/]",
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
        info = f" {self.config.model} {glyphs.MIDDOT} {self.agent.mode} "
        n = w - 3 - len(info)
        if n < 2:
            return ANSI(f"{c}╰{'─' * (w - 2)}╯{rst}")
        return ANSI(f"{c}╰{'─' * n}{rst}{dim}{info}{c}─╯{rst}")

    # ------------------------------------------------------ AgentUI callbacks ---
    def on_text(self, chunk: str) -> None:
        if self._thinking:
            self._thinking = False
        self._cur_tool = None
        self._flush_think()                 # finalize any reasoning above the answer
        self._buf += chunk
        self._streaming = True
        self._invalidate()

    def on_thinking(self, chunk: str) -> None:
        self._thinking = True
        if self._think_t0 is None:
            self._think_t0 = time.monotonic()   # start timing this reasoning block
        if self.config.get("show_reasoning", True):
            self._think += chunk            # shown live + muted in the transcript
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
                  "edit_file": "Edit", "grep": "Search", "glob": "Find", "web_search": "Search",
                  "web_fetch": "Fetch", "task": "Delegate", "todo": "Plan", "skill": "Load skill",
                  "add_skill": "Install skill", "save_memory": "Remember"}

    # tense-aware verbs: present-progressive while running → past when done.
    _TOOL_ING = {"bash": "Running", "bash_output": "Reading output", "read_file": "Reading",
                 "write_file": "Writing", "edit_file": "Editing", "grep": "Searching", "glob": "Finding",
                 "web_search": "Searching", "web_fetch": "Fetching", "task": "Delegating", "todo": "Planning",
                 "skill": "Loading skill", "add_skill": "Installing skill", "save_memory": "Remembering"}
    _TOOL_ED = {"bash": "Ran", "bash_output": "Read output", "read_file": "Read", "write_file": "Wrote",
                "edit_file": "Edited", "grep": "Searched", "glob": "Found", "web_search": "Searched",
                "web_fetch": "Fetched", "task": "Delegated", "todo": "Planned", "skill": "Loaded skill",
                "add_skill": "Installed skill", "save_memory": "Remembered"}

    def tool_call(self, name: str, args: dict) -> None:
        self._flush_text()
        self._tool_count += 1
        summary = _arg_summary(args)
        verb = self._TOOL_VERB.get(name, name)          # bottom status reads "Run npm test", "Read x.py"
        self._cur_tool = f"{verb} {summary}".strip()[:48] if summary else verb
        # ONE stateful block for the whole step: header + result together, live accent rail while
        # it runs. tool_result fills it in. `running` drives the wave; `out`/`diff` are attached on finish.
        self.blocks.append({"kind": "tool", "name": name, "summary": summary, "running": True,
                            "error": False, "out": None, "diff": None, "exp": False})
        if self._follow:
            self._scroll_off = 0
        self._invalidate()

    def _live_tool_block(self, name: str):
        """The most recent still-running tool block for `name` (this session's transcript)."""
        for blk in reversed(self.blocks):
            if isinstance(blk, dict) and blk.get("kind") == "tool" and blk.get("running") and blk.get("name") == name:
                return blk
        return None

    def tool_result(self, name: str, out: str) -> None:
        self._cur_tool = None
        blk = self._live_tool_block(name)
        if blk is None:                                 # defensive: no matching open block → start one
            blk = {"kind": "tool", "name": name, "summary": "", "exp": False}
            self.blocks.append(blk)
        blk["running"] = False
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

    def tool_denied(self, name: str, args: dict, reason: str) -> None:
        th = style_mod.theme()
        self._append(self._rich(f"[{th.err}]{glyphs.CROSS} {name} denied[/] [{th.faint}]{reason}[/]"))

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

    def artifact_ready(self, art) -> None:
        """Propose opening a freshly-served localhost artifact, right in the transcript."""
        from rich.text import Text
        th = style_mod.theme()
        t = Text()
        t.append("  ▶ ", style=f"bold {th.accent}")
        t.append("Artifact ready", style=f"bold {th.text_strong}")
        t.append(f"   {art.name}", style=th.muted)
        t.append("\n     ")
        t.append(art.url, style=f"bold {th.accent_bright}")
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
        plan_on = bool(self.config.get("artifact_in_plan", False))
        reach = "LAN (network)" if lan else "localhost only"
        title = f"Artifacts · reach: {reach} · plan-artifact: {'on' if plan_on else 'off'}"
        foot = ("Enter open · x remove · " + ("b → localhost" if lan else "b → share on LAN")
                + " · p plan-artifact · Esc close")
        if arts:
            rows = [{"label": a.name, "desc": f"{a.url}  ·  up {a.uptime}", "value": a.id} for a in arts]
        else:
            rows = [{"label": "(no previews yet)",
                     "desc": "the agent serves one with the artifact tool", "value": ""}]
        header = None
        if lan:                                          # show EVERY way to open it: LAN + Tailscale + host
            from rich.text import Text
            th = style_mod.theme()
            urls = artifacts.reachable_urls(int(self.config.get("artifact_port", 45000)),
                                            str(self.config.get("artifact_hostname", "")))
            header = [Text.from_markup(f"[{th.muted}]reachable at (no password on your network):[/]")]
            for label, url in urls:
                header.append(Text.from_markup(
                    f"  [{th.faint}]{label:>11}[/]  [{th.accent_bright}]{_esc(url)}[/]"))
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
        if key == "p":                                   # toggle plan-mode artifacts (item: plan settings)
            on = not bool(self.config.get("artifact_in_plan", False))
            self.config.set("artifact_in_plan", on)
            self.agent._refresh_system()                 # re-emit the system prompt with the new plan rules
            self._flash("plan mode can now serve artifacts (plan page + existing .html files)"
                        if on else "plan mode is read-only again — no artifacts")
            self._open_artifacts()
            return
        if row and row.get("value") and key in ("x", "space"):
            artifacts.stop(row["value"])
            self._open_artifacts()                       # refresh (closes if none remain)

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

    def _ask(self, req: dict):
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
        sess._req_event.wait()
        sess._req = None
        if sess is self.active and self._overlay is not None:
            self._overlay = None                        # close (option chosen or Esc-cancelled)
        self._invalidate()
        return sess._req_answer

    def approve(self, name: str, args: dict) -> str:
        from rich.text import Text
        self._flush_text()
        th = style_mod.theme()
        header = [Text(f"{glyphs.RAIL} Allow ", style="bold").append(name, style=f"bold {th.accent}")
                  .append(" to run?", style="bold")]
        if name == "bash" and args.get("command"):      # show the shell command itself
            for ln in str(args["command"]).splitlines()[:6]:
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

    def _ask_text(self, prompt: str) -> str:
        """A BLOCKING free-text prompt (worker thread) — used to capture a denial reason."""
        result = {"v": ""}
        self._req_event.clear()

        def cb(text):
            result["v"] = text
            self._req_event.set()
        self._input = {"cb": cb, "prompt": prompt}
        self._invalidate()
        self._req_event.wait()
        self._input = None
        self._invalidate()
        return result["v"].strip()

    def present_plan(self, plan: str):
        self._flush_text()
        th = style_mod.theme()
        self._append(self._rich(f"[bold {th.accent}]{glyphs.BULLET} proposed plan[/]\n"
                                + self._rich(self._md(plan or "(empty plan)"))))
        ans = self._ask({"kind": "plan",
                         "options": ["Build it (auto)", "Build (accept edits)", "Build (default)", "Keep planning"],
                         "footer": "↑↓ · Enter build · Esc keep planning"})
        return {0: "auto", 1: "acceptEdits", 2: "default"}.get(ans)

    def propose_options(self, question: str, options: list[str]) -> str:
        from rich.text import Text
        self._flush_text()
        ans = self._ask({"kind": "options", "options": list(options),
                         "header": [Text(question, style="bold")]})
        return options[ans] if isinstance(ans, int) and 0 <= ans < len(options) else options[0]

    # --------------------------------------------------------------- the app ---
    def _build(self) -> None:
        # `/` opens the command palette as an overlay (see the `/` key binding) — no completer.
        self.input_buf = Buffer(multiline=True, auto_suggest=_NextSuggest(self))   # ghost-text next-prompt

        header = Window(_ClickControl(self._header, self._menu_click, self._menu_hover),
                        height=self._header_height, align="center")
        transcript = Window(_ClickControl(self._transcript, on_scroll=self._wheel), wrap_lines=True,
                            height=Dimension(weight=1))   # scroll is driven by the cursor marker (_cursor_ft)
        self._transcript_win = transcript
        status = Window(FormattedTextControl(self._status), height=1, style="class:status")
        composer = Window(BufferControl(self.input_buf, focus_on_click=True),
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
            rows += max(1, -(-len(ln) // w))            # ceil(len / width) visual rows per logical line
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

    def _autotitle(self, sess, prompt: str) -> None:
        """Background: derive a session title from the first prompt and apply it, unless the user
        already named it. Silent on failure."""
        self._tls.session = sess        # route _active_prop reads/writes to the session that FINISHED,
        #                                 not whatever is on screen now (fleet: user may have switched)
        try:
            title = self.agent.generate_title(prompt)
        except Exception:
            title = None
        if title and not self.agent.session_name:
            self.agent.name_session(title)
            self._invalidate()

    def _do_handoff(self, sess) -> None:
        """Background: generate a HANDOFF document from the whole session, save it to a file the user
        can hand to another agent, and show it in the transcript (selectable via /copy)."""
        self._tls.session = sess        # route the transcript output to the session /handoff was run in
        try:
            md = self.agent.generate_handoff()
        except Exception as e:
            self.error(f"handoff failed: {type(e).__name__}: {e}")
            return
        import time as _t
        name = f"HANDOFF-{_t.strftime('%Y%m%d-%H%M%S')}.md"
        saved = ""
        try:
            path = self.config.project_root / name
            path.write_text(md)
            saved = str(path)
        except OSError:
            pass
        self._append(self._rich(self._md(md)))          # show the handoff in the chat
        th = style_mod.theme()
        if saved:
            self._append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} handoff saved to [/]"
                                    f"[{th.accent_bright}]{_esc(saved)}[/]"
                                    f"[{th.faint}] — hand this file (or the text above) to another agent[/]"))
        self._flash(f"handoff saved → {name}" if saved else "handoff ready above (couldn't write a file)")

    def _compute_suggestion(self, sess, prompt: str, resp: str) -> None:
        """Background: predict the next prompt (ghost text)."""
        self._tls.session = sess        # bind to the finishing session (see _autotitle) so a fleet
        #                                 switch during this ~1s window can't ghost-text the wrong session
        try:
            s = self.agent.suggest_next(prompt, resp)
        except Exception:
            s = None
        self._suggestion = s
        self._invalidate()

    def _new_session(self, name: str | None = None) -> None:
        """SPAWN a new agent into the fleet and switch to it. The previous session keeps running
        in the background (it doesn't reset) — reach it again via /dashboard."""
        from . import sessions as _sess
        sess = AgentSession(self.config, self)
        sess.agent.session_file = _sess.new_path(self.config.project_root)
        if name:
            sess.agent.name_session(name)
            sess._autotitled = True                  # a manual name skips auto-titling
        self._sessions.append(sess)
        self._naming = False
        self._switch_to(len(self._sessions) - 1)
        self._flash(f"new agent{f': {name}' if name else ''}  ·  {len(self._sessions)} running")

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

    def _close_session(self, idx: int) -> None:
        """Stop + remove a session (its turn is cancelled). The fleet always keeps at least one."""
        if not (0 <= idx < len(self._sessions)) or len(self._sessions) <= 1:
            self._flash("can't close the only session"); return
        sess = self._sessions.pop(idx)
        try:
            sess.agent.cancelled.set()                   # stop its turn if one is running
        except Exception:
            pass
        if self._active_idx >= len(self._sessions):
            self._active_idx = len(self._sessions) - 1
        elif idx < self._active_idx:
            self._active_idx -= 1
        self._invalidate()

    def _cycle_mode(self) -> None:
        order = ["default", "acceptEdits", "plan", "auto"]
        cur = order.index(self.agent.mode) if self.agent.mode in order else 0
        self.agent.set_mode(order[(cur + 1) % len(order)])
        self._flash(f"mode → {self.agent.mode}")
        self._invalidate()

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

    # ---- slash commands (a focused subset; the classic REPL has the full set) ----
    def _handle_slash(self, text: str) -> bool:
        parts = text[1:].split(maxsplit=1)
        cmd = parts[0].lower() if parts else ""
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
                self.agent.name_session(rest); self._flash(f"session named: {rest}")
            else:
                self._flash(f"session: {self.agent.session_name or '(unnamed)'} — /name <name>")
        elif cmd == "goal":
            if rest.lower() in ("clear", "off", "none", "remove"):
                self.agent.set_goal(""); self._flash("standing goal cleared")
            elif rest:
                self.agent.set_goal(rest)
                self._flash(f"goal set — the agent keeps working toward it: {rest[:56]}")
            else:
                g = getattr(self.agent, "goal", "")
                self._flash((f"goal: {g[:70]}  · /goal clear to remove") if g
                            else "no goal set — /goal <objective> to set one")
        elif cmd == "set":
            from .config import DEFAULTS
            tunable = ("temperature", "top_p", "top_k", "min_p", "max_tokens", "context_size",
                       "bash_timeout", "request_timeout", "artifact_hostname")
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
                        self.agent.set_mode(val); self._flash(f"mode = {val}")
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
            if cmd == "model" and rest:
                self._set_model_tui(rest)
            else:
                self._model_flow()
        elif cmd == "connect":
            self._connect_flow(rest)
        elif cmd == "subagent":
            self._subagent_flow(rest)
        elif cmd == "worktree":
            self._tui_worktree(rest)
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
            if not sandbox.available():
                self._flash("no sandbox tool found — install bubblewrap (bwrap) on Linux")
            else:
                val = rest.strip().lower()
                if val in ("on", "true", "1"):
                    cfg.set("sandbox", True)
                    self._flash("sandbox ON — bash confined to the project + /tmp, auto-approved")
                elif val in ("off", "false", "0"):
                    cfg.set("sandbox", False); self._flash("sandbox OFF")
                else:
                    self._flash(f"sandbox: {'on' if cfg.get('sandbox') else 'off'} — /sandbox on|off")
        elif cmd == "mode":
            if rest in ("default", "acceptEdits", "plan", "auto"):
                self.agent.set_mode(rest); self._flash(f"mode → {rest}")
            else:
                self._cycle_mode()
        elif cmd == "think":
            if rest in ("off", "low", "medium", "high"):
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
            self.agent.maybe_compact(force=True); self._flash("context compacted")
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
                    self.agent.mcp.servers.pop(sub[1], None)
                    self._flash(f"removed MCP server '{sub[1]}'")
                else:
                    self._flash(f"no MCP server named '{sub[1]}'")
            else:
                self._extensions_modal(tab=1)           # open the tabbed Skills/MCP modal on MCP
        elif cmd == "agents":
            sm = cfg.get("subagent_model") or f"(inherit: {cfg.model})"
            sh = cfg.get("subagent_base_url") or f"(inherit: {cfg.base_url})"
            defs = ", ".join(getattr(self.agent, "agent_defs", {}).keys()) or "(none)"
            self._append(self._rich(f"[bold {th.accent}]sub-agents[/]\n  model  [{th.text}]{_esc(sm)}[/]\n"
                                    f"  host   [{th.text}]{_esc(sh)}[/]\n  named  [{th.faint}]{_esc(defs)}[/]\n"
                                    f"  [{th.faint}]/subagent to change[/]"))
        elif cmd in ("skills", "extensions", "ext"):
            self._extensions_modal(tab=0)               # open the tabbed Skills/MCP modal on Skills
        elif cmd == "memory":
            p = cfg.project_root / "DGC.md"
            body = p.read_text()[:1500] if p.exists() else "(no project DGC.md — durable memory file)"
            self._append(self._rich(f"[bold {th.accent}]DGC.md[/]\n[{th.faint}]{_esc(body)}[/]"))
        elif cmd == "permissions":
            perms = getattr(cfg, "permissions", {}) or {}
            lines = [f"  [{th.accent}]{a}[/]  [{th.faint}]{_esc(', '.join(perms.get(a, [])) or '—')}[/]"
                     for a in ("allow", "ask", "deny")]
            self._append(self._rich(f"[bold {th.accent}]permission rules[/]\n" + "\n".join(lines)))
        elif cmd in ("bug", "feedback", "report", "issue"):
            self._append(self._rich(f"[bold {th.accent}]report a bug / request a feature[/]\n"
                                    f"  [{th.text}]https://github.com/OpenPeach-ai/dgc/issues[/]  "
                                    f"[{th.faint}](include your `dgc --version`)[/]"))
        elif cmd == "clear":
            self.blocks.clear(); self._turn_marks = []; self._buf = ""; self._flash("cleared")
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
                rendered = render_command(custom[cmd], rest)
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
        used, size = self.agent.estimate_tokens(), int(cfg.get("context_size", 32768))
        rows = [("model", cfg.model), ("host", cfg.base_url), ("mode", self.agent.mode),
                ("thinking", cfg.get("thinking", "off")), ("context", f"{used} / {size} tokens"),
                ("session", self.agent.session_name or "(unnamed)")]
        return f"[bold {th.accent}]status[/]\n" + "\n".join(
            f"  [{th.faint}]{k:<9}[/] [{th.text}]{_esc(str(v))}[/]" for k, v in rows)

    def _set_model_tui(self, model: str, subagent: bool = False) -> None:
        from .config import context_for_model
        if subagent:
            self.config.set("subagent_model", model)
            self._flash(f"sub-agent model → {model}")
            return
        self.config.set("model", model)
        self.agent.refresh_client()
        ctx = context_for_model(model)
        if ctx and ctx != int(self.config.get("context_size", 32768)):
            self.config.set("context_size", ctx)
            self._flash(f"model → {model}  ·  context {ctx // 1024}k")
        else:
            self._flash(f"model → {model}")

    def _list_models(self, base_url=None, api_key=None):
        from .llm import LLMClient
        client = self.agent.client if base_url is None else LLMClient(base_url, api_key or self.config.api_key, "")
        return client.list_models()

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
        items = sessions.listing(self.config.project_root)
        if not items:
            self._flash("no saved sessions in this directory"); return
        labels = [f"{sessions.when(ts)}  ({cnt} msgs)  {(nm + ' · ' if nm else '')}{prev}"
                  for (p, ts, prev, cnt, nm) in items[:30]]

        def pick(i):
            n = self.agent.load_session(items[i][0])
            self.blocks.clear(); self._buf = ""; self._think = ""
            self._render_history()          # show the loaded conversation, not a blank screen
            self._flash(f"resumed ({n} messages)"
                        + (f" — {self.agent.session_name}" if self.agent.session_name else ""))

        def dele(i):
            sessions.delete(items[i][0])
            self._flash("session deleted")
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
                live = name in getattr(self.agent.mcp, "servers", {}) if getattr(self.agent, "mcp", None) else False
                tail = f"{spec.get('command', '')} {' '.join(spec.get('args', []))}".strip()
                out.append({"label": ("● " if live else "○ ") + name, "desc": tail[:64],
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
                        self.agent.mcp.servers.pop(name, None)
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
        bk = "subagent_base_url" if subagent else "base_url"
        kk = "subagent_api_key" if subagent else "api_key"
        who = "sub-agent host" if subagent else "endpoint"
        if rest:                                       # /connect <preset|url>
            if rest in PROVIDERS:
                prov = PROVIDERS[rest]
                self.config.set(bk, prov["base_url"]); self.config.set(kk, prov["api_key"])
            else:
                self.config.set(bk, rest)
            if not subagent:
                self.agent.refresh_client()
            self._flash(f"{who} → {self.config.get(bk)}"); return
        keys = list(PROVIDERS)
        labels = [f"{PROVIDERS[k]['label']}  ({PROVIDERS[k]['base_url']})" for k in keys]
        labels.append("Custom host — enter a URL (e.g. a machine on your LAN)")

        def pick(i):
            if i == len(keys):                          # custom host
                self._ask_input("host URL (e.g. http://192.168.1.50:11434/v1) then Enter",
                                lambda url: self._set_host(url.strip(), subagent))
                return
            prov = PROVIDERS[keys[i]]
            self.config.set(bk, prov["base_url"]); self.config.set(kk, prov["api_key"])
            if not subagent:
                self.agent.refresh_client()
            self._flash(f"{who} → {prov['base_url']}")
        self._show_picker(f"Connect a {who}", labels, pick)

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
        if args and args[0] == "clear":
            for k in ("subagent_model", "subagent_base_url", "subagent_api_key"):
                cfg.set(k, "")
            self._flash("sub-agent overrides cleared — inherits the main model/host"); return
        labels = ["Set sub-agent host (provider or a custom LAN URL)",
                  "Set sub-agent model (from that host)",
                  "Clear — inherit the main model & host"]

        def pick(i):
            if i == 0:
                self._connect_flow("", subagent=True)
            elif i == 1:
                self._model_flow(subagent=True)
            else:
                for k in ("subagent_model", "subagent_base_url", "subagent_api_key"):
                    cfg.set(k, "")
                self._flash("sub-agent → inherits the main model/host")
        sm = cfg.get("subagent_model") or f"(inherit: {cfg.model})"
        sh = cfg.get("subagent_base_url") or "(inherit main host)"
        self._append(self._rich(f"[{style_mod.theme().faint}]sub-agent model {sm} · host {sh}[/]"))
        self._show_picker("Sub-agents", labels, pick)

    def _tui_worktree(self, rest: str) -> None:
        from . import worktree as wt
        th = style_mod.theme()
        root = self.config.project_root
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
            err = wt.remove(root, " ".join(parts[1:]))
            self._flash(err or f"removed worktree {parts[1]}")
            return
        wt_path, branch, err = wt.create(root, rest.strip())
        if err:
            self._append(self._rich(f"[{th.err}]{_esc(err)}[/]"))
            return
        import os as _os
        try:
            _os.chdir(wt_path)
        except OSError:
            pass
        self.config.project_root = wt_path
        self.agent.ctx.project_root = wt_path
        self.agent.reset()
        from . import sessions as _sess
        self.agent.session_file = _sess.new_path(wt_path)
        self.agent.session_name = f"worktree {branch}"
        self.blocks.clear(); self._buf = ""
        self._flash(f"worktree {branch} — switched, fresh session")

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
                # inject into the RUNNING turn (the model reads it mid-turn), not a later turn.
                # Show it in the same highlighted band as a normal prompt, tagged as a follow-up.
                self.agent.steer(text)
                self.blocks.append({"kind": "user", "text": text, "tag": "follow-up · steering this turn"})
                self._scroll_off = 0
                self._follow = True
                self._invalidate()
                return
            if text.startswith("/") and self._handle_slash(text):
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

    def _user_band(self, text: str, tag: str = ""):
        """The user's prompt as a bg-tinted band with a ❯ prefix  — a highlighted
        block that reads distinctly from the assistant text. No border/rail; continuation lines
        indent under the arrow, and the whole thing sits on a subtle raised background.
        `tag` renders a faint marker on the first row (e.g. "follow-up" for a mid-turn prompt)."""
        from rich.text import Text
        th = style_mod.theme()
        W = max(30, self._width)                      # full-width band
        t = Text()
        t.append(" " * W + "\n")                      # vpad: a blank tinted line above
        lines = (text.rstrip("\n") or "").split("\n")
        for i, ln in enumerate(lines):
            pre = f"{glyphs.ARROW} " if i == 0 else "  "
            suffix = f"   {tag}" if (i == 0 and tag) else ""
            t.append(pre, style=f"bold {th.accent}")
            t.append(ln, style=th.text_strong)
            if suffix:
                t.append(suffix, style=th.faint)
            pad = W - len(pre) - len(ln) - len(suffix)
            if pad > 0:
                t.append(" " * pad)                 # fill the row so the band spans the full width
            t.append("\n")
        t.append(" " * W)                             # vpad: a blank tinted line below
        t.stylize(f"on {th.band}")                    # a clearly-visible raised background band
        return self._rich(t)

    def _cur_session(self) -> "AgentSession":
        """The session the CURRENT thread is acting for: a worker thread's own session, else active."""
        tls = getattr(self, "_tls", None)
        return (getattr(tls, "session", None) if tls else None) or self.active

    def _submit(self, text: str) -> None:
        sess = self._cur_session()                    # this turn belongs to THIS session
        sess.last_activity = time.monotonic()
        self._cancel.clear()
        self._tool_count = 0
        self._suggestion = None                       # a new prompt supersedes the ghost text
        if text.strip():
            self._prompt_history.append(text)         # for /history (Ctrl+R) recall
        self.blocks.append({"kind": "user", "text": text})   # re-rendered at current width (reflows on resize)
        self._turn_marks.append((len(self.blocks) - 1, text.replace("\n", " ")[:70]))   # for /jump
        self._scroll_off = 0                # ALWAYS snap to the bottom so the prompt + stream are visible
        self._follow = True
        self._turn.set()
        self._turn_t0 = time.monotonic()

        def work():
            self._tls.session = sess        # route this worker thread's agent callbacks to `sess`
            try:
                self.agent.run_turn(text)
            except Exception as e:
                self.error(f"{type(e).__name__}: {e}")
            finally:
                self._flush_text()
                self._settle_running_tools()     # stop any tool rail still animating (e.g. cancelled mid-run)
                self._turn.clear()
                sess.last_activity = time.monotonic()
                el = time.monotonic() - self._turn_t0
                th = style_mod.theme()
                verb = "stopped" if self._cancel.is_set() else "done"
                self._append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} {verb} · {el:.0f}s"
                                        + (f" · {self._tool_count} tool" +
                                           ("" if self._tool_count == 1 else "s") if self._tool_count else "") + "[/]"))
                if sess is not self.active and not self._cancel.is_set():   # a background agent finished
                    self._flash(f"⧉ {sess.name or 'agent'} finished — ^\\ to view")
                # auto-derive a title for an unnamed session from the first prompt
                if (not self.agent.session_name and not self._autotitled
                        and not self._cancel.is_set()):
                    self._autotitled = True
                    threading.Thread(target=self._autotitle, args=(sess, text), daemon=True).start()
                if self.config.get("suggest", True) and not self._cancel.is_set():
                    resp = next((m.get("content", "") for m in reversed(self.agent.messages)
                                 if m.get("role") == "assistant"), "")
                    threading.Thread(target=self._compute_suggestion,
                                     args=(sess, text, str(resp)), daemon=True).start()
                self._invalidate()
                if self._queue:
                    self._submit(self._queue.pop(0))

        threading.Thread(target=work, daemon=True).start()

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
            termbg.reset()
        if getattr(self, "_pending_update", False):     # user ran /update — install on the raw TTY
            from .update import run_update
            run_update()
            return
        if len(self.agent.messages) > 1 and self.agent.session_file:   # resume hint on exit
            import sys
            nm = f" ({self.agent.session_name})" if self.agent.session_name else ""
            # printed to the RAW terminal (outside the TUI's colour handling), so use 16-colour-safe
            # dim/bold — truecolor purple would downsample to cyan on a non-truecolor terminal.
            dim, bold, rst = "\x1b[2m", "\x1b[1m", "\x1b[0m"
            sys.stdout.write(f"\n  {dim}Resume this session{nm} with:{rst}\n"
                             f"    {bold}dgc --continue{rst}\n\n")


# ---------------------------------------------------------------- helpers ---
def _tui_help() -> str:
    th = style_mod.theme()
    groups = [
        ("session", [("/new", "start a new session (asks for a name)"),
                     ("/name <name>", "name the current session"),
                     ("/resume", "pick a past session to resume"),
                     ("/worktree <name>", "create + switch to a git worktree (dgc/<name>)"),
                     ("/clear", "clear the transcript")]),
        ("model & host", [("/model", "pick a model from the endpoint"),
                          ("/connect", "pick a provider, or enter a custom LAN host URL"),
                          ("/subagent", "sub-agent model + host (or a custom LAN host)"),
                          ("/think off|low|medium|high", "reasoning effort")]),
        ("settings", [("/mode <mode>", "default · acceptEdits · plan · auto (Shift+Tab cycles)"),
                      ("/bg auto|dark|inherit", "background (dark = force on a light terminal)"),
                      ("/theme dark|light", "colour theme"),
                      ("/sandbox on|off", "confine bash to project + /tmp (auto-approves it)"),
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
            out.append(f"  [bold]{_esc(c)}[/]{' ' * max(2, 30 - len(c))}[{th.faint}]{_esc(d)}[/]")
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
    for k in ("path", "command", "pattern", "url", "name", "description"):
        if k in args:
            v = str(args[k]).replace("\n", " ")
            return v[:100] + ("…" if len(v) > 100 else "")
    return ""


def _esc(s: str) -> str:
    return str(s).replace("[", r"\[")
