"""The full-screen DGC app — a Grok-Build-style alt-screen TUI.

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
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import HSplit, Layout, VSplit, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from rich.console import Console

from . import __version__, glyphs, logo as logo_mod, render as render_mod, style as style_mod
from .agent import Agent


class TUI:
    """A full-screen app that also *is* the AgentUI the agent calls back into."""

    def __init__(self, config, agent=None):
        self.config = config
        style_mod.set_theme(config.get("theme", "dark"))
        self.agent = agent or Agent(config, self)
        self.agent.ui = self               # the agent calls back into this TUI

        self.blocks: list[str] = []        # rendered ANSI blocks (the transcript)
        self._buf = ""                     # current streaming assistant text
        self._streaming = False
        self._thinking = False
        self._tool_count = 0
        self._start = time.monotonic()

        self._turn = threading.Event()     # set while a turn is running
        self._cancel = self.agent.cancelled
        self._queue: list[str] = []

        # a cross-thread blocking request (approve / plan / options)
        self._req: dict | None = None
        self._req_answer = None
        self._req_event = threading.Event()

        self.app: Application | None = None
        self._width = 80
        self._stick = True                 # transcript auto-scrolls to bottom
        self._build()

    # ------------------------------------------------------------ rendering ---
    def _console(self) -> Console:
        return Console(file=io.StringIO(), force_terminal=True, color_system="truecolor",
                       width=max(20, self._width - 2), highlight=False)

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
        parts = list(self.blocks)
        if self._buf:                       # the in-flight assistant text
            parts.append(self._rich(self._md(self._buf)))
        if not parts:
            th = style_mod.theme()
            return ANSI(self._rich(f"[{th.faint}]  Ask DGC anything.  "
                                   f"/help for commands · Shift+Tab to switch mode · Esc to stop[/]"))
        return ANSI("\n".join(p for p in parts if p) + "\n")

    @staticmethod
    def _md(text: str):
        from rich.markdown import Markdown
        return Markdown(text)

    # ---- header (Grok-style welcome card when empty, slim line when busy) ----
    def _header(self):
        th = style_mod.theme()
        if self.blocks or self._buf:        # conversation started → slim line
            return ANSI(self._rich(f"[bold {th.accent}]Vibe DGC[/] "
                                   f"[{th.faint}]· {self.config.model} · {self.agent.mode}[/]"))
        return ANSI(self._welcome_card())

    def _welcome_card(self) -> str:
        from rich import box
        from rich.panel import Panel
        from rich.table import Table
        from rich.text import Text
        th = style_mod.theme()
        secs = time.monotonic() - self._start
        logo = logo_mod.shimmer_text(secs)                 # the shimmering DGC mark

        right = Table.grid(expand=True, padding=(0, 2))
        right.add_column(ratio=1)
        right.add_column(justify="right")
        title = Text("Vibe DGC", style="bold #FFFFFF")
        title.append(f"  {__version__}", style=th.faint)
        right.add_row(title, "")
        right.add_row("", "")
        right.add_row(Text("a coding agent for the models you run", style=th.muted), "")
        right.add_row("", "")
        for lbl, key in (("New session", "Ctrl+N"), ("Switch mode", "Shift+Tab"),
                         ("Commands", "type /help"), ("Quit", "Ctrl+Q")):
            right.add_row(Text(lbl, style="bold"), Text(key, style=th.faint))

        grid = Table.grid(padding=(0, 4))
        grid.add_column()
        grid.add_column(ratio=1)
        grid.add_row(logo, right)
        panel = Panel(grid, box=box.ROUNDED, border_style=th.border_strong, padding=(1, 3), expand=True)
        return self._rich(panel)

    # ---- status line ----
    def _status(self):
        th = style_mod.theme()
        if self._req:
            return ANSI(self._rich(f"[bold {th.accent}]{glyphs.DIAMOND}[/] "
                                   f"[{th.text}]waiting for your answer[/] "
                                   f"[{th.faint}]· {self._req.get('hint', '')}[/]"))
        if self._turn.is_set():
            el = int(time.monotonic() - self._turn_t0)
            fr = glyphs.SPINNER[int((time.monotonic() * 8)) % len(glyphs.SPINNER)]
            toks = render_mod.fmt_tokens(len(self._buf) // 4) if self._buf else "0"
            act = "responding" if self._streaming else ("thinking" if self._thinking else "working")
            return ANSI(self._rich(f"[{th.accent}]{fr}[/] [{th.muted}]{act}… {el}s "
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

    # ---- the rounded composer box (Grok's ╭─╮│╰─╯) ----
    def _border_color(self) -> str:
        th = style_mod.theme()
        return th.accent_bright if self.agent.mode == "plan" else th.border_strong

    def _hborder(self, left: str, right: str):
        w = max(4, self._width)
        c = style_mod.ansi_fg(self._border_color())
        return ANSI(f"{c}{left}{'─' * (w - 2)}{right}{style_mod.ANSI_RESET}")

    def _bottom_border(self):
        """Bottom composer border with `model · mode` embedded at the right (Grok style)."""
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
        self._buf += chunk
        self._streaming = True
        self._invalidate()

    def on_thinking(self, chunk: str) -> None:
        self._thinking = True
        self._invalidate()

    def end_stream(self) -> None:
        if self._buf.strip():
            self._append(self._rich(self._md(self._buf)))
        self._buf = ""
        self._streaming = False

    def tool_call(self, name: str, args: dict) -> None:
        self._flush_text()
        self._tool_count += 1
        th = style_mod.theme()
        summary = _arg_summary(args)
        self._append(self._rich(f"[bold {th.accent}]{glyphs.tool_icon(name)} {name}[/] "
                                f"[{th.faint}]{summary}[/]"))

    def tool_result(self, name: str, out: str) -> None:
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
        if self._buf.strip():
            self._append(self._rich(self._md(self._buf)))
        self._buf = ""
        self._streaming = False

    # ---- blocking prompts (run on the worker thread; answered by the UI) ----
    def _ask(self, req: dict):
        self._req = req
        self._req_event.clear()
        self._invalidate()
        self._req_event.wait()
        self._req = None
        self._invalidate()
        return self._req_answer

    def approve(self, name: str, args: dict) -> str:
        from .permissions import rule_for
        self._flush_text()
        th = style_mod.theme()
        body = f"[bold]{glyphs.RAIL} permission requested[/] [{th.faint}]— {name}[/]"
        detail = _arg_summary(args)
        self._append(self._rich(body + (f"\n  [{th.faint}]{_esc(detail)}[/]" if detail else "")))
        ans = self._ask({"kind": "approve", "options": ["allow once", "always allow", "deny"],
                         "hint": "1 allow · 2 always · 3 deny"})
        return {0: "once", 1: "always"}.get(ans, "no")

    def present_plan(self, plan: str):
        self._flush_text()
        th = style_mod.theme()
        self._append(self._rich(f"[bold {th.accent}]{glyphs.BULLET} proposed plan[/]\n"
                                + self._rich(self._md(plan or "(empty plan)"))))
        ans = self._ask({"kind": "plan",
                         "options": ["build (auto)", "build (acceptEdits)", "build (default)", "keep planning"],
                         "hint": "1 auto · 2 acceptEdits · 3 default · 4 keep planning"})
        return {0: "auto", 1: "acceptEdits", 2: "default"}.get(ans)

    def propose_options(self, question: str, options: list[str]) -> str:
        self._flush_text()
        th = style_mod.theme()
        self._append(self._rich(f"[bold]{_esc(question)}[/]"))
        ans = self._ask({"kind": "options", "options": list(options),
                         "hint": " · ".join(f"{i+1} {o}" for i, o in enumerate(options))[:60]})
        return options[ans] if isinstance(ans, int) and 0 <= ans < len(options) else options[0]

    # --------------------------------------------------------------- the app ---
    def _build(self) -> None:
        self.input_buf = Buffer(multiline=True)

        header = Window(FormattedTextControl(self._header), height=self._header_height, align="center")
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
        root = HSplit([
            header,
            transcript,
            status,
            composer_box,
        ])
        self.app = Application(layout=Layout(root, focused_element=composer),
                               key_bindings=self._keys(), full_screen=True, mouse_support=False,
                               style=self._pt_style(), refresh_interval=0.08)

    def _header_height(self) -> int:
        return 1 if (self.blocks or self._buf) else 13

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
        return Style.from_dict({
            "rule": f"fg:{th.border}",
            "status": f"fg:{th.muted}",
            "composer": f"fg:{th.text}",
        })

    def _keys(self) -> KeyBindings:
        kb = KeyBindings()

        @kb.add("enter")
        def _(ev):
            if self._req is not None:
                return                      # answered via number keys
            text = self.input_buf.text.strip()
            self.input_buf.reset()
            if not text:
                return
            if self._turn.is_set():
                self._queue.append(text)
                self._append(self._rich(f"[{style_mod.theme().faint}]{glyphs.ARROW} queued: {_esc(text[:70])}[/]"))
                return
            self._submit(text)

        @kb.add("escape")
        def _(ev):
            if self._req is not None:
                self._req_answer = None
                self._req_event.set()
            elif self._turn.is_set():
                self._cancel.set()
            else:
                self.input_buf.reset()

        @kb.add("c-c")
        @kb.add("c-d")
        @kb.add("c-q")
        def _(ev):
            if self._turn.is_set():
                self._cancel.set()
            else:
                ev.app.exit()

        @kb.add("c-n")
        def _(ev):
            if self._turn.is_set():
                return
            self.agent.reset()
            self.blocks.clear()
            self._buf = ""
            from . import sessions as _sess
            self.agent.session_file = _sess.new_path(self.config.project_root)
            self._invalidate()

        @kb.add("s-tab")
        def _(ev):
            order = ["default", "acceptEdits", "plan", "auto"]
            cur = order.index(self.agent.mode) if self.agent.mode in order else 0
            self.agent.set_mode(order[(cur + 1) % len(order)])
            self._invalidate()

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
        self.app.run()


# ---------------------------------------------------------------- helpers ---
def _arg_summary(args: dict) -> str:
    for k in ("path", "command", "pattern", "url", "name", "description"):
        if k in args:
            v = str(args[k]).replace("\n", " ")
            return v[:100] + ("…" if len(v) > 100 else "")
    return ""


def _esc(s: str) -> str:
    return str(s).replace("[", r"\[")
