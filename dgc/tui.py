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
import threading
import time

from prompt_toolkit.application import Application
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
    ("new", "start a new session (asks a name)"),
    ("resume", "reopen a past session · dN deletes one"),
    ("model", "switch the model"),
    ("connect", "pick a provider or a custom LAN host"),
    ("subagent", "set the sub-agent model + host"),
    ("mode", "permission mode: default · acceptEdits · plan · auto"),
    ("think", "how hard the model reasons: off · low · medium · high"),
    ("thoughts", "show or hide the model's thinking in the transcript"),
    ("worktree", "isolate edits in a git worktree"),
    ("sandbox", "confine bash to the project + /tmp"),
    ("bg", "terminal background: auto · dark · inherit"),
    ("theme", "colour theme: dark · light"),
    ("context", "context-window usage"),
    ("compact", "summarise the older turns now"),
    ("status", "model · host · mode · context"),
    ("name", "name this session"),
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


class TUI:
    """A full-screen app that also *is* the AgentUI the agent calls back into."""

    def __init__(self, config, agent=None):
        self.config = config
        style_mod.set_theme(config.get("theme", "dark"))
        self.agent = agent or Agent(config, self)
        self.agent.ui = self               # the agent calls back into this TUI

        self.blocks: list[str] = []        # rendered ANSI blocks (the transcript)
        self._buf = ""                     # current streaming assistant text
        self._think = ""                   # current streaming reasoning (shown muted)
        self._streaming = False
        self._thinking = False
        self._cur_tool: str | None = None   # activity label while a tool runs ("Run npm test")
        self._think_t0: float | None = None  # when the current reasoning block started
        self._tool_count = 0
        self._start = time.monotonic()

        self._turn = threading.Event()     # set while a turn is running
        self._cancel = self.agent.cancelled
        self._queue: list[str] = []

        # a cross-thread blocking request (approve / plan / options)
        self._req: dict | None = None
        self._req_answer = None
        self._req_event = threading.Event()
        self.deny_reason = ""              # set when the user denies a tool "with a reason"

        self.app: Application | None = None
        import shutil
        _sz = shutil.get_terminal_size((100, 30))
        self._width, self._height = _sz.columns, _sz.lines   # os.terminal_size uses .lines
        self._stick = True                 # transcript auto-scrolls to bottom
        self._flash_msg = ""               # transient confirmation (clicks / mode switch)
        self._flash_until = 0.0
        self._naming = False               # inline "name this new session" prompt is active
        self._menu_rows: dict[int, str] = {}   # terminal-row → welcome-menu action (set on render)
        self._hover_row: int | None = None     # welcome-menu row under the mouse (hover highlight)
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
                      keep_input=False, header=None, accent=False, back=None) -> None:
        if not keep_input:
            self.input_buf.reset()                      # composer becomes the filter box
        self._overlay = {"rows": rows, "on_pick": on_pick, "title": title, "tabs": tabs, "tab": tab,
                         "footer": footer, "on_delete": on_delete, "on_action": on_action,
                         "rebuild": rebuild, "on_submit": on_submit, "header": header,
                         "accent": accent, "sel": 0, "scroll": 0, "back": back}
        self._invalidate()

    def _open_command_palette(self) -> None:
        """The `/` menu as an overlay (same engine as the pickers): the composer holds `/query`,
        rows filter live, ↑/↓ select, Enter runs. Replaces the flaky completion-menu Enter path."""
        def rebuild(ov):
            q = self.input_buf.text.lstrip("/").strip().lower()
            return [{"label": "/" + n, "desc": d, "value": n} for n, d in SLASH_COMMANDS
                    if not q or q in n.lower() or q in d.lower()]

        def submit(row, typed):
            if " " in typed:                            # typed args → run verbatim (e.g. /model qwen)
                self._run_command(typed)
            elif row:                                   # selected a row → run it
                self._run_command("/" + row["value"])
            elif typed.startswith("/") and len(typed) > 1:
                self._run_command(typed)
        self._open_overlay([], on_pick=lambda r: None, rebuild=rebuild, on_submit=submit,
                           footer="↑↓ move · type to filter · Enter run · Esc close", keep_input=True)

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
        "theme": ([("Dark", "dark"), ("Light", "light")], lambda s: s.config.get("theme", "dark")),
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

        def back():                                     # Esc in a sub-menu → return to the `/` palette
            self.input_buf.reset(); self.input_buf.insert_text("/")
            self._open_command_palette()
        self._open_overlay(rows, on_pick=lambda r: self._handle_slash(f"/{cmd} {r['value']}"),
                           title=f"/{cmd}", footer="↑↓ move · Enter select · Esc back", back=back)

    def _close_overlay(self) -> None:
        self._overlay = None
        self.input_buf.reset()
        self._invalidate()

    _OVERLAY_CAP = 10                                   # max rows shown at once

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
        n = len(self._overlay_rows())
        if n:
            ov["sel"] = (ov["sel"] + d) % n             # wrap-around
        self._invalidate()

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
        W = min(max(46, self._width - 6), 108)
        inner = W - 4
        rows = self._overlay_rows()
        sel, cap = ov["sel"], self._OVERLAY_CAP
        scroll = ov.get("scroll", 0)
        scroll = min(scroll, sel)
        if sel >= scroll + cap:
            scroll = sel - cap + 1
        ov["scroll"] = scroll = max(0, scroll)
        visible = rows[scroll:scroll + cap]
        labw = min(max((len(r.get("label", "")) for r in rows), default=8), 34)
        lines: list = []
        if ov.get("tabs"):                              # tab strip (tabbed modal)
            strip = Text()
            for i, t in enumerate(ov["tabs"]):
                strip.append(f" {t} ", style=(f"bold {th.bg} on {th.accent}" if i == ov["tab"] else th.muted))
                strip.append(" ")
            lines += [strip, Text("─" * inner, style=th.border)]
        elif ov.get("title"):
            lines.append(Text(ov["title"], style="bold"))
        if ov.get("header"):                            # a rich block (e.g. the command being approved)
            for h in ov["header"]:
                lines.append(h if isinstance(h, Text) else Text(str(h)))
            lines.append(Text("─" * inner, style=th.border))
        if not visible:
            lines.append(Text("  (no matches)", style=th.faint))
        for i, r in enumerate(visible):
            hot = (scroll + i == sel)
            line = Text()
            line.append("❯ " if hot else "  ", style=f"bold {th.accent}" if hot else th.faint)
            line.append(r.get("label", "").ljust(labw), style="bold" if hot else th.text)
            if r.get("desc"):
                line.append("  " + r["desc"], style=th.muted if hot else th.faint)
            pad = inner - line.cell_len
            if pad > 0:
                line.append(" " * pad)
            if hot:
                line.stylize(f"on {th.surface2}")       # subtle full-width highlight bar
            lines.append(line)
        if len(rows) > cap:                             # scroll indicator
            lines.append(Text(f"  {scroll + 1}–{scroll + len(visible)} of {len(rows)}", style=th.faint))
        if ov.get("footer"):
            lines += [Text(""), Text(ov["footer"], style=th.faint)]
        panel = Panel(Text("\n").join(lines), box=_box.ROUNDED,
                      border_style=(th.accent if ov.get("accent") else th.border_strong),
                      padding=(0, 1), width=W)
        return ANSI(self._rich(Padding(panel, (0, 0, 0, 2))))

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
        return Console(file=io.StringIO(), force_terminal=True, color_system="truecolor",
                       width=max(20, self._width - 2), highlight=False,
                       theme=render_mod.markdown_theme())

    def _rich(self, *renderables, **kw) -> str:
        c = self._console()
        c.print(*renderables, **kw)
        return c.file.getvalue().rstrip("\n")

    def _append(self, ansi: str) -> None:
        self.blocks.append(ansi)
        self._stick = True
        self._invalidate()

    def _invalidate(self) -> None:
        if self.app:
            try:
                self.app.invalidate()
            except Exception:
                pass

    # ---- the transcript control ----
    def _transcript(self):
        th = style_mod.theme()
        parts = list(self.blocks)
        if self._think:                     # the in-flight reasoning (muted)
            parts.append(self._rich(f"[{th.faint} italic]{glyphs.RAIL} reasoning… "
                                    f"{_esc(self._think)}[/]"))
        if self._buf:                       # the in-flight assistant text
            parts.append(self._rich(self._md(self._buf)))
        if not parts:
            return ANSI("")                      # empty transcript (welcome state) — kept clear
        return ANSI("\n".join(p for p in parts if p) + "\n")

    def _tip(self):
        th = style_mod.theme()
        if self.blocks or self._buf or self._overlay or self._welcome_metrics()[2] == "compact":
            return ANSI("")
        upd = cached_update()
        if upd:                                            # echo the update CTA in the tip, like Grok
            return ANSI(self._rich(f"  [bold]Tip:[/] [{th.faint}]a newer DGC ([bold {self._GOLD}]v{upd}[/]) "
                                   f"is out — type [bold {self._GOLD}]/update[/] or click [ Update now ][/]"))
        return ANSI(self._rich(f"  [bold]Tip:[/] [{th.faint}]Shift+Tab to switch mode "
                               f"{glyphs.MIDDOT} /help for commands {glyphs.MIDDOT} Esc to stop a turn[/]"))

    @staticmethod
    def _md(text: str):
        return render_mod.render_markdown(text)

    # ---- header (welcome card when empty, slim line when busy) ----
    def _header(self):
        self._sync_width()                  # resize with the terminal, before laying anything out
        th = style_mod.theme()
        if self.blocks or self._buf or self._overlay:   # conversation / overlay open → slim line
            nm = f" · {self.agent.session_name}" if self.agent.session_name else ""
            return ANSI(self._rich(f"[bold {th.accent}]Vibe DGC[/] "
                                   f"[{th.faint}]· {self.config.model} · {self.agent.mode}{_esc(nm)}[/]"))
        return ANSI(self._welcome_card())

    # rows the right column needs = title + blank + (2 update-CTA | 1 tagline) + blank + cta + blank + 4 menu
    def _right_rows(self, upd) -> int:
        return 4 + 4 + (2 if upd else 1)

    def _welcome_metrics(self):
        """Card width W, inner content width, layout mode, and the exact header height.

        mode: 'wide' (Grok-style — braille logo LEFT, text RIGHT), 'stacked' (narrow: logo on top,
        menu below), or 'compact' (too short → a 1-line header, so a phone terminal never hits
        'window too small'). header_h is the full rendered height so _header_height matches the card.
        """
        w, h = self._width, getattr(self, "_height", 30)
        upd = cached_update()
        margin = 4 if w < 62 else 6
        W = max(30, min(w - margin, 150))
        cw_area = W - 8                                    # inside border(2) + padding(2*3)
        RESERVED = 6                                       # tip + status + composer(3) + transcript(1)
        avail = h - RESERVED
        wide_inner = max(len(logo_mod.LOGO), self._right_rows(upd))
        wide_h = wide_inner + 4 + 2                        # panel pad(2)+border(2) + top pad(2)
        stack_inner = len(logo_mod.LOGO_SMALL) + self._right_rows(upd) + 1
        stack_h = stack_inner + 4 + 2
        if w >= 72 and avail >= wide_h:
            return W, cw_area, "wide", wide_h, upd
        if w >= 40 and avail >= stack_h:
            return W, cw_area, "stacked", stack_h, upd
        return W, cw_area, "compact", 1, upd

    # (label, keyboard shortcut, slash command, click-action) — the card shows BOTH ways in.
    _MENU = [("New session", "Ctrl+N", "/new", "new"), ("Switch mode", "Shift+Tab", "/mode", "switch"),
             ("Commands", "type /", "/help", "commands"), ("Quit", "Ctrl+Q", "/quit", "quit")]
    _GOLD = "#E0A24E"                                       # update CTA accent (stands out, like Grok's)

    def _welcome_card(self) -> str:
        from rich import box
        from rich.padding import Padding
        from rich.panel import Panel
        from rich.text import Text
        th = style_mod.theme()
        secs = time.monotonic() - self._start
        W, cw_area, mode, _hh, upd = self._welcome_metrics()
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

        top_pad, left_margin = 2, 3
        base = top_pad + 2                                 # top padding + top border + panel pad

        # ── figure logo geometry + the content-column offset FIRST, so click/hover rows are exact ──
        if mode == "stacked":
            logo_p = logo_mod.shimmer_lines(secs, small=True)
            text_w = cw_area
            content_off = len(logo_p) + 1                  # logo rows + one blank
            logo_w = gap = loff = 0
        else:                                              # wide
            logo_w, gap = logo_mod.WIDTH, 4                # gap = breathing room between logo and text
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
            for lr in logo_p:
                pad = max(0, (cw_area - lr.cell_len) // 2)
                r = Text(" " * pad); r.append_text(lr); rows.append(r)
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
        panel = Panel(body, box=box.ROUNDED, border_style=th.border_strong, padding=(1, 3), width=W)
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
            el = int(time.monotonic() - self._turn_t0)
            fr = glyphs.THINK_FRAMES[int(time.monotonic() * 6) % len(glyphs.THINK_FRAMES)]
            toks = render_mod.fmt_tokens(len(self._buf) // 4) if self._buf else "0"
            if self._streaming:
                act = "responding"
            elif self._cur_tool:
                act = self._cur_tool            # "Run npm test" · "Read x.py" · "Search …"
            elif self._thinking:
                act = "thinking"
            else:
                act = "working"
            return ANSI(self._rich(f"[{th.accent}]{fr}[/] [{th.muted}]{_esc(act)}… {el}s "
                                   f"{glyphs.MIDDOT} {toks} tok[/]  [{th.faint}]esc to stop[/]"))
        used, size = self.agent.estimate_tokens(), int(self.config.get("context_size", 32768))
        return ANSI(self._rich(render_mod.context_bar(used, size, width=14)))

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
        """Move the streamed reasoning into a permanent muted block above the answer."""
        if self._think.strip():
            th = style_mod.theme()
            secs = int(time.monotonic() - self._think_t0) if self._think_t0 else 0
            head = f"Thought for {secs}s" if secs else "Thought"
            self._append(self._rich(f"[{th.faint} italic]{glyphs.RAIL} {head}[/]\n"
                                    f"[{th.faint} italic]{_esc(self._think.strip())}[/]"))
        self._think = ""
        self._think_t0 = None

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

    def tool_call(self, name: str, args: dict) -> None:
        self._flush_text()
        self._tool_count += 1
        th = style_mod.theme()
        summary = _arg_summary(args)
        verb = self._TOOL_VERB.get(name, name)          # status now reads "Run npm test", "Read x.py"
        self._cur_tool = f"{verb} {summary}".strip()[:48] if summary else verb
        self._append(self._rich(f"[bold {th.accent}]{glyphs.tool_icon(name)} {name}[/] "
                                f"[{th.faint}]{summary}[/]"))

    def tool_result(self, name: str, out: str) -> None:
        self._cur_tool = None
        if "\n--- " in out or out.startswith("---"):
            diff = out[out.find("---"):]
            if len(diff) < 8000:
                self._append(self._rich(render_mod.render_diff(diff)))
                return
        th = style_mod.theme()
        lines = out.splitlines()
        shown = "\n".join("  " + ln for ln in lines[:10])
        if len(lines) > 10:
            shown += f"\n  {glyphs.ELLIPSIS_V} {len(lines) - 10} more lines"
        self._append(self._rich(f"[{th.faint}]{_esc(shown)}[/]"))

    def tool_denied(self, name: str, args: dict, reason: str) -> None:
        th = style_mod.theme()
        self._append(self._rich(f"[{th.err}]{glyphs.CROSS} {name} denied[/] [{th.faint}]{reason}[/]"))

    def on_todo(self, todos: list) -> None:
        th = style_mod.theme()
        marks = {"done": glyphs.CHECK, "in_progress": glyphs.DIAMOND, "pending": glyphs.DIAMOND_O}
        rows = "\n".join(f"  [{th.accent if t['status'] == 'in_progress' else th.faint}]"
                         f"{marks.get(t['status'], glyphs.DIAMOND_O)}[/] {_esc(t['content'])}" for t in todos)
        self._append(self._rich(f"[{th.faint}]todos[/]\n{rows}"))

    def info(self, msg: str) -> None:
        th = style_mod.theme()
        self._append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} {_esc(msg)}[/]"))

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
    def _ask(self, req: dict):
        """Render a blocking prompt as a navigable overlay CARD (↑↓ + Enter + number shortcuts).
        Runs on the worker thread; the UI thread answers via on_pick / number keys / Esc."""
        self._req = req
        self._req_event.clear()
        options = req.get("options", [])
        rows = [{"label": o, "value": i} for i, o in enumerate(options)]

        def pick(row):
            self._req_answer = row["value"]
            self._req_event.set()
        self._open_overlay(rows, on_pick=pick, title=req.get("title"), header=req.get("header"),
                           footer=req.get("footer", "↑↓ move · 1-9 or Enter select · Esc cancel"),
                           accent=True)
        self._invalidate()
        self._req_event.wait()
        self._req = None
        self._overlay = None                            # closed (option chosen or Esc-cancelled)
        self._invalidate()
        return self._req_answer

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
        self.input_buf = Buffer(multiline=True)

        header = Window(_ClickControl(self._header, self._menu_click, self._menu_hover),
                        height=self._header_height, align="center")
        transcript = Window(FormattedTextControl(self._transcript), wrap_lines=True,
                            get_vertical_scroll=self._vscroll, height=Dimension(weight=1))
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
        tip = Window(FormattedTextControl(self._tip), height=1, style="class:status")
        # The floating overlay (pickers / tabbed modal) grows a region ABOVE the composer —
        # it pushes the transcript up instead of dumping the menu into the chat.
        overlay_panel = ConditionalContainer(
            Window(FormattedTextControl(self._render_overlay), height=self._overlay_height,
                   dont_extend_height=True),
            filter=Condition(lambda: self._overlay is not None))
        root = HSplit([header, transcript, overlay_panel, tip, status, composer_box])
        # Adaptive colour depth (grey logo + solid accents stay clean at any depth); the dark
        # canvas is handled separately via OSC 10/11 (dgc/termbg.py).
        # Mouse capture ON so the wheel scrolls DGC's own transcript instead of the
        # terminal's scrollback (which would show pre-DGC output). Copy text with Option/Shift-drag.
        self.app = Application(layout=Layout(root, focused_element=composer),
                               key_bindings=self._keys(), full_screen=True, mouse_support=True,
                               style=self._pt_style(), refresh_interval=0.08,
                               erase_when_done=True,   # wipe the TUI frame on exit — no blank gap above the hint
                               color_depth=style_mod.detect_color_depth())

    def _header_height(self) -> int:
        if self.blocks or self._buf or self._overlay:
            return 1
        self._sync_width()
        _, _, mode, header_h, _ = self._welcome_metrics()
        if mode == "compact":                   # tiny / in-between terminal → 1-line header
            return 1
        return max(1, min(header_h, self._height - 6))   # never exceed the terminal (belt + suspenders)

    def _composer_height(self) -> int:
        return min(max(1, self.input_buf.text.count("\n") + 1), 8)

    def _line_prefix(self, line_no, wrap_count):
        th = style_mod.theme()
        if line_no == 0 and wrap_count == 0:
            return ANSI(f" {style_mod.ansi_fg(th.accent)}{glyphs.ARROW}{style_mod.ANSI_RESET} ")
        return "   "

    def _vscroll(self, win) -> int:
        if not self._stick:
            return win.vertical_scroll
        # stick to bottom: show the last screenful
        info = win.render_info
        if info is None:
            return 0
        return max(0, info.content_height - info.window_height)

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
        """ask for an optional name before creating the session."""
        if self._turn.is_set():
            return
        self._naming = True
        self.input_buf.reset()
        self._invalidate()

    def _new_session(self, name: str | None = None) -> None:
        if self._turn.is_set():
            return
        self.agent.reset()
        self.blocks.clear()
        self._buf = ""; self._think = ""
        from . import sessions as _sess
        self.agent.session_file = _sess.new_path(self.config.project_root)
        if name:
            self.agent.name_session(name)
        self._naming = False
        self._flash(f"new session{f': {name}' if name else ''}")
        self._invalidate()

    def _cycle_mode(self) -> None:
        order = ["default", "acceptEdits", "plan", "auto"]
        cur = order.index(self.agent.mode) if self.agent.mode in order else 0
        self.agent.set_mode(order[(cur + 1) % len(order)])
        self._flash(f"mode → {self.agent.mode}")
        self._invalidate()

    def _menu_hover(self, position) -> None:
        """Highlight the welcome-menu row under the mouse (hover)."""
        new = position.y if (not self.blocks and not self._buf
                             and position.y in self._menu_rows) else None
        if new != self._hover_row:
            self._hover_row = new
            self._invalidate()

    def _menu_click(self, position) -> bool:
        """Map a click on the welcome card to its menu action, using the row map that
        _welcome_card records for the current layout (wide or stacked-narrow)."""
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
        elif cmd in ("new", "session"):
            self._prompt_new_session()
        elif cmd == "name":
            if rest:
                self.agent.name_session(rest); self._flash(f"session named: {rest}")
            else:
                self._flash(f"session: {self.agent.session_name or '(unnamed)'} — /name <name>")
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
            used, size = self.agent.estimate_tokens(), int(cfg.get("context_size", 32768))
            self._append(self._rich(render_mod.context_bar(used, size, width=26)))
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
            self.blocks.clear(); self._buf = ""; self._flash("cleared")
        elif cmd == "update":
            # exit the full-screen app cleanly, THEN run the installer on the raw terminal
            # (curl | bash needs a normal TTY; it can't run inside the alt-screen app).
            if cached_update() or rest in ("force", "-f", "now"):
                self._pending_update = True
                if self.app:
                    self.app.exit()
            else:
                self._flash(f"you're on the latest — DGC v{__version__}")
        elif cmd in ("rewind", "init", "search"):
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
        try:
            models = self._list_models(base, self.config.get("subagent_api_key") if subagent else None)
        except Exception as e:
            self._flash(f"couldn't list models: {type(e).__name__}"); return
        if not models:
            self._flash("no models offered by the endpoint"); return
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
                    self.blocks.append(self._rich(f"[bold]{glyphs.ARROW}[/] {_esc(body[:6000])}"))
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
        self._stick = True

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

    def _mcp_add_flow(self) -> None:
        """Interactive: add an MCP server (remote URL+token or a local command) via prompts."""
        def got_name(name):
            name = re.sub(r"\s+", "-", name.strip())
            if not name:
                self._flash("cancelled — no name"); return

            def pick_type(i):
                if i == 0:                       # remote server over a URL
                    def got_url(url):
                        url = url.strip()
                        if not url:
                            self._flash("cancelled — no URL"); return

                        def got_token(tok):
                            # bridge a remote MCP endpoint through the standard `mcp-remote` stdio proxy
                            args = ["-y", "mcp-remote", url]
                            if tok.strip():
                                args += ["--header", f"Authorization: Bearer {tok.strip()}"]
                            self._mcp_save(name, {"command": "npx", "args": args})
                        self._ask_input(f"auth token for '{name}' (leave blank if none):", got_token)
                    self._ask_input(f"URL for '{name}' (e.g. https://host/mcp):", got_url)
                else:                            # local stdio command
                    def got_cmd(cmdline):
                        parts = cmdline.split()
                        if not parts:
                            self._flash("cancelled — no command"); return
                        self._mcp_save(name, {"command": parts[0], "args": parts[1:]})
                    self._ask_input(f"command for '{name}' "
                                    f"(e.g. npx -y @modelcontextprotocol/server-filesystem ~/):", got_cmd)
            self._show_picker(f"Add MCP server '{name}' — which kind?",
                              ["Remote server  (a URL, optional token)",
                               "Local server  (a command that speaks MCP over stdio)"], pick_type)
        self._ask_input("name for the MCP server (e.g. github, filesystem):", got_name)

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
            if (self._overlay is None and not b.text and not self._turn.is_set()
                    and self._req is None and not self._naming and self._input is None):
                b.insert_text("/")
                self._open_command_palette()            # `/` on an empty composer → command palette
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
            rows = self._overlay_rows()
            if rows:
                self._overlay["on_delete"](rows[self._overlay["sel"]])   # cb re-opens with fresh rows

        # tabbed-modal action keys (a/x/r/space) — only when the overlay declares on_action
        has_actions = Condition(lambda: self._overlay is not None and self._overlay.get("on_action"))

        def _ov_action(key):
            ov = self._overlay
            if not (ov and ov.get("on_action")):
                return
            rows = self._overlay_rows()
            ov["on_action"](key, rows[ov["sel"]] if rows else None)

        for _ch in ("a", "x", "r"):
            @kb.add(_ch, filter=has_actions)
            def _(ev, _ch=_ch):
                _ov_action(_ch)

        @kb.add("space", filter=has_actions)
        def _(ev):
            _ov_action("space")

        @kb.add("enter")
        def _(ev):
            if self._overlay is not None:           # floating picker/modal
                ov = self._overlay
                if ov.get("tabs"):                  # tabbed modal → Enter is inert (use a/x/r · Esc)
                    return
                rows = self._overlay_rows()
                sel = rows[ov["sel"]] if rows else None
                typed = self.input_buf.text.strip()
                submit, on_pick = ov.get("on_submit"), ov["on_pick"]
                self._close_overlay()
                if submit:                          # command palette: (selected row, typed text)
                    submit(sel, typed)
                elif sel:
                    on_pick(sel)
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
                # inject into the RUNNING turn (the model reads it mid-turn), not a later turn
                self.agent.steer(text)
                self._append(self._rich(f"[{style_mod.theme().accent}]{glyphs.ARROW} steering:[/] "
                                        f"[{style_mod.theme().faint}]{_esc(text[:70])}[/]"))
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

        @kb.add("c-c")
        @kb.add("c-d")
        @kb.add("c-q")
        def _(ev):
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

        @kb.add("c-n")
        def _(ev):
            self._prompt_new_session()

        @kb.add("s-tab")
        def _(ev):
            self._cycle_mode()

        @kb.add("pageup")
        def _(ev):
            self._stick = False
            self._transcript_win.vertical_scroll = max(0, self._transcript_win.vertical_scroll - 8)

        @kb.add("pagedown")
        def _(ev):
            self._transcript_win.vertical_scroll += 8

        @kb.add("end")
        def _(ev):
            self._stick = True

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

    def _submit(self, text: str) -> None:
        self._cancel.clear()
        self._tool_count = 0
        self.blocks.append(self._rich(f"[bold]{glyphs.ARROW}[/] {_esc(text)}"))
        self._stick = True                  # ALWAYS snap to the bottom so the prompt + stream are visible
        self._turn.set()
        self._turn_t0 = time.monotonic()

        def work():
            try:
                self.agent.run_turn(text)
            except Exception as e:
                self.error(f"{type(e).__name__}: {e}")
            finally:
                self._flush_text()
                self._turn.clear()
                el = time.monotonic() - self._turn_t0
                th = style_mod.theme()
                verb = "stopped" if self._cancel.is_set() else "done"
                self._append(self._rich(f"[{th.faint}]{glyphs.MIDDOT} {verb} · {el:.0f}s"
                                        + (f" · {self._tool_count} tool" +
                                           ("" if self._tool_count == 1 else "s") if self._tool_count else "") + "[/]"))
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
    (so the welcome card's menu rows are mouse-clickable, )."""

    def __init__(self, text, on_click, on_move=None):
        super().__init__(text)
        self._on_click = on_click
        self._on_move = on_move

    def mouse_handler(self, mouse_event):
        from prompt_toolkit.mouse_events import MouseEventType
        if mouse_event.event_type == MouseEventType.MOUSE_MOVE and self._on_move:
            self._on_move(mouse_event.position)
            return None
        if mouse_event.event_type == MouseEventType.MOUSE_UP and self._on_click(mouse_event.position):
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
