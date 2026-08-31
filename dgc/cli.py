"""Interactive CLI for dgc — REPL, slash commands, streaming render,
approval prompts and plan-mode approval flow."""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import threading
import time
import webbrowser
from pathlib import Path

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.history import FileHistory
from rich.console import Console
from rich.markup import escape as escape_markup
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from . import (__version__, attachments as attachments_mod, glyphs, logo as logo_mod,
               memory as memory_mod, render, sessions as sessions_mod)
from . import style as style_mod
from .agent import Agent
from .commands import (canonical_command_name, command_pairs_with_custom, command_specs,
                       custom_command_names)
from .config import PROVIDERS, SEARCH_PROVIDERS, USER_CONFIG, USER_HOME, Config
from .llm import LLMError
from .menu import select as menu_select
from .permissions import DISPLAY, MODES, MODE_DESCRIPTIONS, Rule, rule_for
from .redaction import redact_text, secret_values
from .style import (ANSI_DIM, ANSI_RESET, BRAND, BRAND_MAGENTA, DIM, section,
                    terminal_safe_text)
from .tools import TOOL_SCHEMAS

from .update import (  # update-check lives in its own module so the TUI can share it
    UPDATE_CACHE, VERSION_URL, cached_update, refresh_update_async, run_update)


def _markup_literal(value) -> str:
    """Dynamic terminal data safe for insertion inside DGC-owned Rich markup."""
    return escape_markup(terminal_safe_text(value))


def _literal_cell(value, *, style: str | None = None) -> Text:
    """Literal terminal-safe cell for Rich tables and panels."""
    return Text(terminal_safe_text(value), style=style)


def auto_warning(console: Console) -> None:
    console.print(Panel(
        "full-auto approves [bold]every[/bold] file write and shell command with no prompts.\n"
        "Only use it on code and a directory you trust.",
        title="[bold red]⚠ auto mode[/bold red]", border_style="red", expand=False))


MODE_CYCLE = ["default", "acceptEdits", "plan", "auto"]
# mono + purple: muted / accent / lavender / red (auto stays red as a danger signal)
MODE_COLOR = {"default": "#9A9A9E", "acceptEdits": "#7C5CFF", "plan": "#A78BFA", "auto": "#DC5A64"}
THINK_LEVELS = ["off", "low", "medium", "high"]


class UI:
    """All user-facing rendering + interaction. The agent calls back into this."""

    def __init__(self):
        self.console = Console(theme=render.markdown_theme(), highlight=False)
        self._thinking = False
        self._streamed = False
        self._rule_hook = None  # set by CLI: fn(rule_text) -> None
        self._live = None       # set by CLI during a live turn: the key-reader that owns stdin
        self._work_stop = None  # set while a "working…" spinner is running
        self._tool_count = 0    # tools used in the current turn (for the done marker)
        self.deny_reason = ""   # optional steer captured when the user denies a tool
        self.plan_feedback = "" # one-shot steer captured when the user rejects a plan

    # --------------------------------------------------- working indicator ---
    def start_working(self, label: str = "working") -> None:
        """Show a live spinner from submit until the first token/tool — so the user
        knows the model is loading/generating, not that the CLI hung."""
        if not sys.stdout.isatty():
            return
        label = terminal_safe_text(label).replace("\n", " ")
        self.stop_working()
        stop = threading.Event()
        self._work_stop = stop

        def spin() -> None:
            frames = glyphs.THINK_FRAMES
            acc, dim, rst = style_mod.ansi_fg(style_mod.theme().accent), ANSI_DIM, ANSI_RESET
            t0, i = time.time(), 0
            while not stop.wait(0.14):
                el = int(time.time() - t0)
                et = f" {el}s" if el else ""
                sys.stdout.write(f"\r  {acc}{frames[i % len(frames)]}{rst} {dim}{label}…{et}"
                                 f"   {glyphs.MIDDOT} esc to stop{rst}\x1b[K")
                sys.stdout.flush()
                i += 1
        threading.Thread(target=spin, daemon=True).start()

    def stop_working(self) -> None:
        stop = self._work_stop
        if stop and not stop.is_set():
            stop.set()
            if sys.stdout.isatty():
                sys.stdout.write("\r\x1b[K")   # wipe the spinner line before real output
                sys.stdout.flush()
        self._work_stop = None

    def turn_complete(self, elapsed: float, cancelled: bool = False,
                      failed: bool = False) -> None:
        """A clear end-of-turn delimiter so the user knows the model is done and it's
        their turn — not still working, not waiting on a follow-up."""
        self.stop_working()
        if self._streamed:                       # close off any mid-stream line
            self.console.print()
            self._streamed = False
        if not sys.stdout.isatty():              # scripts / pipes don't want a UX marker
            return
        verb = "stopped" if cancelled else ("failed" if failed else "done")
        parts = [f"{elapsed:.0f}s"]
        if self._tool_count:
            parts.append(f"{self._tool_count} tool" + ("" if self._tool_count == 1 else "s"))
        self.console.print(f"  [{DIM}]· {verb} · {' · '.join(parts)}[/]", highlight=False)

    def _yield_stdin(self) -> None:
        """If a live key-reader owns stdin during this turn, ask it to release before we input()."""
        self.stop_working()
        live = self._live
        if live and live["active"].is_set():
            live["stop"].set()
            live["released"].wait(timeout=2)

    # ------------------------------------------------ streaming callbacks ---
    def on_text(self, chunk: str) -> None:
        self.stop_working()
        if self._thinking:
            self.console.print()
            self._thinking = False
        self.console.print(terminal_safe_text(chunk), end="", markup=False, highlight=False,
                           soft_wrap=True)
        self.console.file.flush()  # stream live — rich/stdout otherwise buffers until a newline
        self._streamed = True

    def on_thinking(self, chunk: str) -> None:
        self.stop_working()
        if not self._thinking:
            self.console.print("\n[dim italic]· thinking…[/] ", end="")
            self._thinking = True
        self.console.print(terminal_safe_text(chunk), end="", markup=False, highlight=False,
                           style="dim italic")
        self.console.file.flush()
        self._streamed = True

    def end_stream(self) -> None:
        if self._streamed:
            self.console.print()
            self._streamed = False
            self._thinking = False

    # ------------------------------------------------------ tool rendering ---
    def tool_call(self, name: str, args: dict, call_id: str | None = None) -> None:
        self.stop_working()
        self._tool_count += 1
        summary = self._arg_summary(name, args)
        self.console.print(f"\n[bold {BRAND}]{glyphs.tool_icon(name)} {_markup_literal(name)}[/] "
                           f"[{DIM}]{_markup_literal(summary)}[/]", highlight=False)

    def tool_progress(self, name: str, message: str, *, progress=None, total=None,
                      level: str = "", call_id: str | None = None) -> None:
        self.stop_working()
        amount = ""
        if isinstance(progress, (int, float)) and not isinstance(progress, bool):
            if isinstance(total, (int, float)) and not isinstance(total, bool) and total:
                amount = f" · {progress:g}/{total:g} ({max(0, min(100, progress / total * 100)):.0f}%)"
            else:
                amount = f" · {progress:g}"
        color = "red" if level in ("error", "critical", "alert", "emergency") else DIM
        # MCP text is untrusted server output, not Rich markup.
        self.console.print(f"  · {terminal_safe_text(message)[:500]}{amount}", style=color, markup=False,
                           highlight=False)
        self.start_working(name)

    def tool_result(self, name: str, out: str, call_id: str | None = None) -> None:
        out = terminal_safe_text(out)
        if "\n--- " in out or out.startswith("---"):
            diff = out[out.find("---"):]
            if len(diff) < 8000:
                self.console.print(render.render_diff(diff))
                self.start_working()                         # spin again until the next step
                return
        lines = out.splitlines()
        for ln in lines[:12]:                                # flat, 2-space indented (no box)
            self.console.print("  " + ln, style=DIM, markup=False, highlight=False, soft_wrap=True)
        if len(lines) > 12:
            self.console.print(f"  … ({len(lines) - 12} more lines)", style=DIM,
                               markup=False, highlight=False)
        self.start_working()                                 # spin again until the next step

    def tool_denied(self, name: str, args: dict, reason: str,
                    call_id: str | None = None) -> None:
        self.stop_working()
        self.console.print(
            f"[bold red]✗ {_markup_literal(name)} denied[/bold red] "
            f"[{DIM}]{_markup_literal(reason)}[/]", highlight=False)

    def hook_activity(self, event: str, status: str, *, configured: int = 0,
                      duration_ms: int = 0, message: str = "") -> None:
        if status == "started":
            return
        detail = f" · {terminal_safe_text(message)}" if message else ""
        self.console.print(
            f"  · hook {terminal_safe_text(event)} {terminal_safe_text(status)} · "
            f"{configured} configured · {duration_ms}ms{detail}",
            style="red" if status not in ("completed",) else DIM,
            markup=False, highlight=False)

    @staticmethod
    def _arg_summary(name: str, args: dict) -> str:
        for key in ("path", "command", "pattern", "url", "name", "memory", "symbol", "operation"):
            if key in args:
                value = terminal_safe_text(args[key]).replace("\n", " ")
                return value[:120] + ("…" if len(value) > 120 else "")
        return ""

    # ---------------------------------------------------------- approvals ---
    def approve(self, name: str, args: dict, call_id: str | None = None) -> str:
        """Return 'once' | 'always' | 'no'."""
        self._yield_stdin()
        section(self.console, "permission requested", name)
        if name == "bash":
            self.console.print(render.mono_syntax(
                terminal_safe_text(args.get("command", "")), "bash"))
        else:
            summary = self._arg_summary(name, args)
            if summary:
                self.console.print(f"  [{DIM}]{_markup_literal(summary)}[/]", highlight=False)
        rule = rule_for(name, args)
        idx = menu_select("Allow this?",
                          ["allow once", "always allow", "deny"],
                          ["just this time", f"add rule {terminal_safe_text(rule)}", "block it"])
        if idx in (0, 1):
            return {0: "once", 1: "always"}[idx]
        # denied (or esc) — capture optional feedback so the model can adjust in one step
        try:
            self.deny_reason = input("  why / what to do instead (optional) › ").strip()
        except (EOFError, KeyboardInterrupt):
            self.deny_reason = ""
        return "no"

    def present_plan(self, plan: str):
        """Return target mode string on approval, or None to keep planning."""
        self._yield_stdin()
        section(self.console, "📋 proposed plan")
        self.console.print(render.render_markdown(terminal_safe_text(plan or "(empty plan)")))
        idx = menu_select("Approve this plan?",
                          ["build with acceptEdits", "build in default", "build in full-auto",
                           "keep planning"],
                          ["auto-approve edits", "ask per action", "approve everything",
                           "reject & refine"])
        target = {0: "acceptEdits", 1: "default", 2: "auto"}.get(idx)
        if target == "auto":
            auto_warning(self.console)
            try:
                confirmed = input("  execute this plan in full-auto? [y/N] › ").strip().lower() in ("y", "yes")
            except (EOFError, KeyboardInterrupt):
                confirmed = False
            if not confirmed:
                self.plan_feedback = "Full-auto was not confirmed; offer a safer execution mode."
                return None
        if target:
            self.plan_feedback = ""
            return target
        try:
            self.plan_feedback = input("  feedback for the plan (optional): ").strip()
        except EOFError:
            self.plan_feedback = ""
            return None
        if self.plan_feedback:
            self.console.print(f"  [{DIM}]feedback noted — the agent will see your denial[/]")
        return None

    def propose_options(self, question: str, options: list[str]) -> str:
        """Model-driven multiple choice — the agent asks, the user picks. Returns the chosen text."""
        self._yield_stdin()
        idx = menu_select(terminal_safe_text(question or "Choose one"),
                          [terminal_safe_text(option) for option in options] + ["something else…"],
                          [""] * len(options) + ["type your own answer"])
        if idx is None:
            return options[0]
        if idx == len(options):                          # the "something else…" row
            try:
                raw = input("  › ").strip()
            except EOFError:
                return options[0]
            return raw or options[0]
        return options[idx]

    def mcp_capabilities(self) -> dict:
        return {"sampling": {}, "elicitation": {"form": {}, "url": {}}}

    def mcp_input(self, server: str, kind: str, payload: dict, *, cancel=None) -> dict:
        """Review one MCP server request. Nothing is sampled, opened, or disclosed by default."""
        self._yield_stdin()
        self.stop_working()
        section(self.console, "MCP input requested", str(server)[:120])
        if cancel is not None and cancel.is_set():
            return {"action": "cancel"}
        if kind in ("sampling_request", "sampling_response"):
            title = ("Let this server ask your model?" if kind == "sampling_request"
                     else "Share this sampled response with the server?")
            self.console.print(title, style="bold", markup=False)
            self.console.print(terminal_safe_text(
                json.dumps(payload, ensure_ascii=False, indent=2))[:12_000],
                               style=DIM, markup=False, highlight=False, soft_wrap=True)
            idx = menu_select("MCP sampling consent", ["approve once", "decline", "cancel"],
                              ["continue this request", "tell the server no", "dismiss"])
            if cancel is not None and cancel.is_set():
                return {"action": "cancel"}
            return {"action": {0: "accept", 1: "decline"}.get(idx, "cancel")}
        if kind != "elicitation":
            return {"action": "cancel"}

        message = terminal_safe_text(payload.get("message") or "")
        self.console.print(message, markup=False, highlight=False, soft_wrap=True)
        if payload.get("mode") == "url":
            url = str(payload.get("url") or "")
            host = terminal_safe_text(payload.get("host") or "")
            self.console.print(f"Host: {host}", style="bold", markup=False)
            self.console.print(terminal_safe_text(url), style=DIM, markup=False, highlight=False,
                               soft_wrap=True)
            if payload.get("suspicious_host"):
                self.console.print("Warning: this host contains Punycode; inspect it carefully.",
                                   style="bold red", markup=False)
            idx = menu_select("Open this exact URL?", ["open in browser", "decline", "cancel"],
                              ["navigate outside DGC", "tell the server no", "dismiss"])
            if idx != 0:
                return {"action": "decline" if idx == 1 else "cancel"}
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
                    label = terminal_safe_text(field.get("title") or key)
                    optional = key not in required
                    options = _form_options(field)
                    kind_name = field.get("type")
                    if kind_name == "array":
                        shown = [terminal_safe_text(item.get("title")) for item in
                                 (field.get("items") or {}).get("anyOf", [])] or options
                        self.console.print(f"  {label}: " + ", ".join(
                            f"{i + 1}={name}" for i, name in enumerate(shown)), markup=False)
                        raw = input("  choose comma-separated numbers" +
                                    (" (blank skips)" if optional else "") + " › ").strip()
                        if not raw and optional:
                            continue
                        picks = [] if not raw else [int(part.strip()) - 1 for part in raw.split(",")]
                        content[key] = [options[i] for i in picks if 0 <= i < len(options)]
                    elif options:
                        labels = ([terminal_safe_text(item.get("title"))
                                   for item in field.get("oneOf", [])]
                                  or [terminal_safe_text(item)
                                      for item in (field.get("enumNames") or [])]
                                  or [terminal_safe_text(item) for item in options])
                        rows = list(labels) + (["skip"] if optional else [])
                        idx = menu_select(label, rows, [""] * len(rows))
                        if idx is None or (optional and idx == len(labels)):
                            continue
                        content[key] = options[idx]
                    elif kind_name == "boolean":
                        rows = ["yes", "no"] + (["skip"] if optional else [])
                        idx = menu_select(label, rows, [""] * len(rows))
                        if idx is None or (optional and idx == 2):
                            continue
                        content[key] = idx == 0
                    else:
                        default = field.get("default")
                        hint = f" [{default}]" if default is not None else ""
                        raw = input(f"  {label}{hint}{' (optional)' if optional else ''} › ").strip()
                        if not raw and default is not None:
                            value = default
                        elif not raw and optional:
                            continue
                        elif kind_name == "integer":
                            value = int(raw)
                        elif kind_name == "number":
                            value = float(raw)
                        else:
                            value = raw
                        content[key] = value
                candidate = validate_elicitation_response(
                    payload, {"action": "accept", "content": content})
            except (EOFError, KeyboardInterrupt):
                return {"action": "cancel"}
            except (ValueError, IndexError, MCPInputError) as exc:
                self.error(f"invalid form response: {exc}")
                continue
            self.console.print("Review before sharing:", style="bold", markup=False)
            self.console.print(terminal_safe_text(
                json.dumps(candidate["content"], ensure_ascii=False, indent=2)),
                               style=DIM, markup=False, highlight=False)
            idx = menu_select("Send this form to the MCP server?",
                              ["submit", "edit", "decline", "cancel"],
                              ["share these exact values", "change answers", "tell the server no", "dismiss"])
            if cancel is not None and cancel.is_set():
                return {"action": "cancel"}
            if idx == 0:
                return candidate
            if idx == 2:
                return {"action": "decline"}
            if idx != 1:
                return {"action": "cancel"}

    # ---------------------------------------------------------------- misc ---
    def on_todo(self, todos: list) -> None:
        self.stop_working()
        if not todos:
            return
        marks = {"done": "[green]☑[/green]", "in_progress": f"[{BRAND}]◐[/]", "pending": f"[{DIM}]☐[/]"}
        section(self.console, "todos")
        for t in todos:
            self.console.print(
                f"  {marks.get(t['status'], '☐')} {_markup_literal(t['content'])}",
                highlight=False)

    def artifact_ready(self, art) -> None:
        self.info(f"artifact ready: {art.name} · {art.url}")

    def goal_changed(self, goal: str, status: str) -> None:
        self.info(f"standing goal → {status}: {goal[:120]}")

    def info(self, msg: str) -> None:
        self.stop_working()
        self.console.print(
            f"  [{DIM}]· {_markup_literal(msg)}[/]", highlight=False)

    def error(self, msg: str) -> None:
        self.stop_working()
        self.console.print(
            f"[bold red]error:[/bold red] {_markup_literal(msg)}")

    def add_permission_rule(self, name: str, args: dict) -> None:
        """Persist an allow-rule for this tool call — the 'always allow' path."""
        if self._rule_hook:
            self._rule_hook(str(rule_for(name, args)))


# ------------------------------------------------------------------- REPL ---

def _help_table(console, rows) -> None:
    """Render literal command syntax in a responsive two-column grid."""
    from rich.text import Text
    values = [(terminal_safe_text(token).replace("\n", " "),
               terminal_safe_text(description).replace("\n", " "))
              for token, description in rows]
    if not values:
        return
    terminal_width = max(32, int(console.size.width or 80))
    token_width = min(max(len(token) + 2 for token, _description in values),
                      max(14, terminal_width // 2), 40)
    table = Table.grid(expand=True, padding=(0, 2))
    table.add_column(width=token_width, no_wrap=True, overflow="ellipsis")
    table.add_column(ratio=1)
    for token, description in values:
        command = Text("  ")
        command.append(token, style=BRAND)
        table.add_row(command, _literal_cell(description, style=DIM))
    console.print(table)


def render_help(console, project_root: Path | None = None) -> None:
    """Render classic help from the same command registry used by every command palette."""
    from rich.text import Text
    console.print("[bold]chat[/bold]", highlight=False)
    _help_table(console, (
        ("just type", "ask dgc anything; it uses tools to act on your project"),
        ("#fact", "quick-add a memory to DGC.md"),
        ("!cmd", "run a shell command directly"),
        ("@path/to/file", "attach one exact bounded text or image file"),
    ))

    console.print()
    console.print("[bold]slash commands[/bold]", highlight=False)
    _help_table(console, (("/" + (spec.usage or spec.name), spec.description)
                          for spec in command_specs("classic")))

    if project_root is not None:
        custom = custom_command_names(project_root)
        if custom:
            console.print()
            console.print("[bold]custom prompt commands[/bold]", highlight=False)
            _help_table(console, (("/" + name + " [ARGS]",
                                   "project or personal prompt template") for name in custom))

    quit_spec = next(spec for spec in command_specs("classic") if spec.name == "quit")
    aliases = " and ".join("/" + name for name in quit_spec.aliases)
    console.print(Text(f"  {aliases} are aliases for /quit", style=DIM))
    console.print(Text(
        "  while a turn runs: type a follow-up + Enter to queue it · Esc to interrupt",
        style=DIM))


class ClassicSlashCompleter(Completer):
    """Live classic-REPL completion derived from the shared command registry."""

    def __init__(self, project_root: Path):
        self.project_root = project_root

    def get_completions(self, document, complete_event):
        del complete_event
        before = document.text_before_cursor
        if not before.startswith("/") or any(ch.isspace() for ch in before):
            return
        query = before[1:].casefold()
        for name, description in command_pairs_with_custom("classic", self.project_root):
            if name.casefold().startswith(query):
                yield Completion("/" + name, start_position=-len(before),
                                 display="/" + name, display_meta=description)


class CLI:
    def __init__(self, config: Config):
        self.config = config
        style_mod.set_theme(config.get("theme", "dark"))   # honour the saved theme
        self.ui = UI()
        self.ui._rule_hook = self._add_rule
        self.agent = Agent(config, self.ui)
        self.console = self.ui.console

    def _context_window_size(self) -> int:
        effective = getattr(self.agent, "context_size", None)
        if callable(effective):
            return int(effective())
        return int(self.config.get("context_size", 32768))

    # ------------------------------------------------------------- banner ---
    # DGC wordmark — assembled from fixed-width block letters so it always aligns.
    _LOGO_D = ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "]
    _LOGO_G = [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "]
    _LOGO_C = [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"]
    _LOGO_COLORS = ["#22D3EE", "#3EC7EE", "#6FA6EE", "#9B84E8", "#C25FD8", "#E84CC6"]  # cyan → magenta

    def _logo(self) -> None:
        c = self.console
        c.print()
        if (c.size.width or 80) < 34:                        # minimal: no art, one dim brand line
            cfg = self.config
            c.print(f"  [bold {BRAND_MAGENTA}]dgc[/] [{DIM}]v{__version__} · "
                    f"{_markup_literal(cfg.model)} · "
                    f"{_markup_literal(cfg.data.get('mode', 'default'))}[/]", highlight=False)
            return
        logo_mod.show(c, animate=bool(self.config.get("logo_animation", True)))   # animated shimmer wordmark
        c.print(f"  [{DIM}]v{__version__} · a coding agent for the models you run[/]", highlight=False)
        c.print(f"  [{DIM}]Built by Mohit Kalra[/]\n", highlight=False)

    def banner(self) -> None:
        c = self.console
        cfg = self.config
        mode, think = cfg.data.get("mode", "default"), cfg.data.get("thinking", "off")
        self._logo()
        if (c.size.width or 80) < 34:                        # minimal: skip the config block
            return
        def row(label, value):                               # dim padded label + value (peachd statusLine)
            safe_label = _markup_literal(label)
            c.print(f"  [{DIM}]{safe_label:<8}[/]  {_markup_literal(value)}", highlight=False)
        row("endpoint", cfg.base_url)
        row("model", cfg.model)
        c.print(f"  [{DIM}]{'mode':<8}[/]  "
                f"[{MODE_COLOR.get(mode, 'white')}]{_markup_literal(mode)}[/]  "
                f"[{DIM}]· {_markup_literal(MODE_DESCRIPTIONS.get(mode, ''))}[/]",
                highlight=False)
        row("thinking", think)
        row("project", cfg.project_root)
        if self.agent.skills:
            row("skills", ", ".join(self.agent.skills))
        proj_mem, user_mem = memory_mod.load_memories(cfg.project_root)
        loaded = [n for n, m in (("DGC.md", proj_mem), ("user DGC.md", user_mem)) if m]
        if loaded:
            row("memory", "loaded: " + ", ".join(loaded))
        row("search", cfg.get("search_provider", "duckduckgo"))
        c.print(f"  [{DIM}]{'context':<8}[/]  ", render.context_bar(self.agent.estimate_tokens(),
                self._context_window_size()), highlight=False)
        upd = cached_update()
        if upd:
            c.print(f"  [bold {BRAND_MAGENTA}]⬆ update available: "
                    f"v{_markup_literal(upd)}[/]  "
                    f"[{DIM}]— run [bold]dgc update[/bold][/]", highlight=False)
        if mode == "auto":
            auto_warning(c)
        c.print(f"  [{DIM}]type [bold]/help[/bold] for commands, [bold]/exit[/bold] to quit[/]\n")

    # ------------------------------------------------------- rule handling ---
    def _add_rule(self, rule_text: str) -> None:
        try:
            Rule.parse(rule_text, "allow")
        except ValueError as e:
            self.ui.error(str(e))
            return
        self.config.permissions["allow"].append(rule_text)
        self.config.save()
        self.ui.info(f"rule saved: allow {rule_text}")

    # ------------------------------------------------------ slash commands ---
    def handle_slash(self, line: str) -> bool:
        parts = line[1:].split(None, 1)
        cmd = canonical_command_name(parts[0] if parts else "", "classic")
        rest = parts[1] if len(parts) > 1 else ""
        cfg = self.config

        if cmd in ("exit", "quit", "q"):
            raise EOFError
        if cmd == "help":
            render_help(self.console, cfg.project_root)
        elif cmd == "connect":
            args = rest.split()
            if len(args) > 1:
                self.ui.error("API keys are not accepted inline — use the masked prompt, dgc setup, or DGC_API_KEY")
                return True
            if not args:
                from .menu import select
                pk = list(PROVIDERS)
                idx = select("Connect a provider", [PROVIDERS[k]["label"] for k in pk],
                             [PROVIDERS[k]["base_url"] for k in pk])
                if idx is not None:
                    prov = PROVIDERS[pk[idx]]
                    cfg.set("base_url", prov["base_url"])
                    cfg.set("api_mode", "auto")
                    if prov["needs_key"]:
                        from getpass import getpass
                        key = getpass(f"  API key for {prov['label']} › ").strip()
                        cfg.set("api_key", key or prov["api_key"])
                    else:
                        cfg.set("api_key", prov["api_key"])
                    self.agent.refresh_client()
                    self.ui.info(f"endpoint set to {cfg.base_url}  ·  model {cfg.model}")
            else:
                target = args[0]
                if target in PROVIDERS:
                    prov = PROVIDERS[target]
                    cfg.set("base_url", prov["base_url"])
                    cfg.set("api_mode", "auto")
                    if prov["needs_key"]:
                        from getpass import getpass
                        key = getpass(f"  API key for {prov['label']} › ").strip()
                        cfg.set("api_key", key or prov["api_key"])
                    else:
                        cfg.set("api_key", prov["api_key"])
                else:
                    cfg.set("base_url", target)
                self.agent.refresh_client()
                self.ui.info(f"endpoint set to {cfg.base_url}  ·  model {cfg.model}")
        elif cmd == "models":
            try:
                models = self.agent.client.list_models()
            except (LLMError, Exception) as e:
                self.ui.error(str(e))
                return True
            if not models:
                self.ui.info("no models offered by the endpoint")
            else:
                from .menu import select
                mi = select("Model", models)
                if mi is not None:
                    self._set_model(models[mi])
        elif cmd == "model":
            if rest:
                self._set_model(rest.strip())
            else:
                self.ui.info(f"model: {cfg.model}")
        elif cmd in ("mode",):
            if not rest:
                i = MODE_CYCLE.index(self.agent.mode) if self.agent.mode in MODE_CYCLE else 0
                rest = MODE_CYCLE[(i + 1) % len(MODE_CYCLE)]
            if rest not in MODES:
                self.ui.error(f"unknown mode {rest!r} — choose from {', '.join(MODES)}")
            elif rest == "auto" and self.agent.mode != "auto":
                auto_warning(self.console)
                if input("  enable full-auto? [y/N] › ").strip().lower() in ("y", "yes"):
                    self.agent.set_mode("auto")
                    self.ui.info(f"mode → auto ({MODE_DESCRIPTIONS['auto']})")
                else:
                    self.ui.info(f"kept {self.agent.mode}")
            else:
                self.agent.set_mode(rest)
                self.ui.info(f"mode → {rest} ({MODE_DESCRIPTIONS[rest]})")
        elif cmd == "plan":
            target = "default" if self.agent.mode == "plan" else "plan"
            self.agent.set_mode(target)
            self.ui.info(f"mode → {target} ({MODE_DESCRIPTIONS[target]})")
        elif cmd in ("view-plan", "plan-view", "viewplan"):
            plan = (sessions_mod.load_plan(self.agent.session_file, cfg.project_root)
                    if self.agent.session_file else None)
            if plan:
                self.console.print(render.render_markdown(terminal_safe_text(plan)))
            else:
                self.ui.info("no saved plan yet — /mode plan, then ask for one")
        elif cmd == "goal":
            action = rest.strip()
            low = action.lower()
            if low in ("clear", "off", "none", "remove"):
                if self.agent.set_goal(""):
                    self.ui.info("standing goal cleared")
                else:
                    self.ui.error(self.agent._last_persist_error or "goal update was not saved")
            elif low in ("complete", "completed", "done"):
                if not self.agent.update_goal("completed"):
                    if self.agent._last_persist_error:
                        self.ui.error(self.agent._last_persist_error)
                    else:
                        self.ui.info("no standing goal to complete")
            elif low in ("blocked", "block", "pause", "paused"):
                if not self.agent.update_goal("blocked"):
                    if self.agent._last_persist_error:
                        self.ui.error(self.agent._last_persist_error)
                    else:
                        self.ui.info("no standing goal to pause")
            elif low in ("resume", "active", "reactivate"):
                if not self.agent.update_goal("active"):
                    if self.agent._last_persist_error:
                        self.ui.error(self.agent._last_persist_error)
                    else:
                        self.ui.info("no standing goal to resume")
            elif action:
                if self.agent.set_goal(action):
                    self.ui.info(f"standing goal → active: {self.agent.goal[:120]}")
                else:
                    self.ui.error(self.agent._last_persist_error or "goal update was not saved")
            elif self.agent.goal:
                self.console.print(render.render_markdown(terminal_safe_text(
                    f"# Standing goal\n\n**Status:** {self.agent.goal_status}\n\n{self.agent.goal}")))
            else:
                self.ui.info("no standing goal — /goal <objective> to set one")
        elif cmd == "think":
            if not rest:
                i = THINK_LEVELS.index(cfg.get("thinking", "off"))
                rest = THINK_LEVELS[(i + 1) % len(THINK_LEVELS)]
            if rest not in THINK_LEVELS:
                self.ui.error(f"unknown level {rest!r} — choose from {', '.join(THINK_LEVELS)}")
            else:
                cfg.set("thinking", rest)   # persisted across restarts
                self.ui.info(f"thinking → {rest}")
                from .llm import is_reasoning_model
                if rest == "off" and is_reasoning_model(cfg.get("model", "")):
                    self.ui.info("  tip: this looks like a reasoning model — /think high often does "
                                 "better on hard tasks")
        elif cmd == "permissions":
            self._permissions_cmd(rest)
        elif cmd == "memory":
            self._memory_cmd(rest)
        elif cmd == "skills":
            if not self.agent.skills:
                self.ui.info("no skills found — add dirs with SKILL.md under .dgc/skills/ or ~/.dgc/skills/")
            table = Table("skill", "description", "location")
            for s in self.agent.skills.values():
                table.add_row(_literal_cell(s.name), _literal_cell(s.description),
                              _literal_cell(s.path))
            self.console.print(table)
        elif cmd == "mcp":
            self.console.print("[bold]MCP servers[/bold] [dim](configure in ~/.dgc/config.json → mcp_servers)[/dim]")
            self.console.print(terminal_safe_text(self.agent.mcp.summary()), markup=False,
                               highlight=False)
        elif cmd == "hooks":
            from .hooks import hook_catalog
            catalog = hook_catalog(cfg)
            table = Table("event", "configured", "matchers", "state")
            for item in catalog["items"]:
                table.add_row(item["event"], str(item["configured"]),
                              _literal_cell(", ".join(item["matchers"]) or "—"),
                              "ready" if item["valid"] else "invalid")
            self.console.print(table)
            if catalog["invalid"]:
                self.ui.error(f"hook configuration has {catalog['invalid']} invalid or unsupported entry(s)")
        elif cmd == "skill":
            args = rest.split(None, 1)
            sk = self.agent.skills.get(args[0]) if args else None
            if not sk:
                self.ui.error(f"unknown skill — try /skills")
            else:
                self.agent.run_turn(sk.render(args[1] if len(args) > 1 else ""))
        elif cmd == "init":
            memory_mod.init_project_memory(cfg.project_root)
            self.agent.run_turn(
                "Analyze this project (read key files, manifests, existing docs) and rewrite "
                "DGC.md at the project root as a concise, accurate guide for a coding agent: "
                "what the project is, stack, layout, build/test/lint commands, conventions. "
                "Use write_file to save it.")
        elif cmd == "status":
            self.banner()
        elif cmd == "context":
            used, size = self.agent.estimate_tokens(), self._context_window_size()
            self.console.print("  [bold]context[/bold]  ", render.context_bar(used, size), highlight=False)
        elif cmd == "theme":
            if not rest:
                self.ui.info(f"theme: {style_mod.theme().name}  ·  available: {', '.join(style_mod.THEMES)}")
            elif style_mod.set_theme(rest.strip()):
                cfg.set("theme", rest.strip())
                self.banner()
            else:
                self.ui.error(f"unknown theme {rest!r} — choose from {', '.join(style_mod.THEMES)}")
        elif cmd == "compact":
            if self.agent.maybe_compact(force=True):
                self.ui.info(f"~{self.agent.estimate_tokens()} tokens in context")
            else:
                self.ui.error(self.agent._last_persist_error or "context compaction failed")
        elif cmd in ("clear", "new"):
            self.agent.reset()
            self.agent.session_file = sessions_mod.new_path(cfg.project_root)
            self.ui.info("new session started" if cmd == "new" else "conversation cleared")
        elif cmd == "rewind":
            pts = self.agent.checkpoints.listing()
            if not pts:
                self.ui.info("no checkpoints yet — run a turn first")
            else:
                labels = [f"{prev}  [{nf} file{'' if nf == 1 else 's'}]" for (_i, prev, nf) in pts]
                mi = select("Rewind to (restores code + conversation)", labels)
                if mi is not None:
                    msgs, nfiles = self.agent.rewind(pts[mi][0])
                    if msgs >= 0:
                        self.ui.info(f"↩ rewound — restored {nfiles} file(s); conversation truncated")
                    else:
                        self.ui.error("rewind could not complete; the recovery point was retained")
        elif cmd == "search":
            self._search_cmd(rest)
        elif cmd == "resume":
            self._resume_cmd()
        elif cmd in ("artifact", "artifacts"):
            from . import artifacts
            args = rest.split()
            if len(args) == 2 and args[0] in ("stop", "remove", "rm"):
                self.ui.info("artifact stopped" if artifacts.stop(args[1]) else f"no artifact {args[1]!r}")
            else:
                arts = artifacts.registry()
                if not arts:
                    self.ui.info("no project artifacts are running")
                else:
                    table = Table("id", "name", "URL", "age")
                    for art in arts:
                        table.add_row(*(_literal_cell(value) for value in
                                        (art.id, art.name, art.url, art.uptime)))
                    self.console.print(table)
        elif cmd in ("handoff", "handover"):
            md = self.agent.generate_handoff(save=True)
            path = self.agent._last_handoff_path
            if path:
                self.ui.info(f"handoff saved → {path}")
            elif self.agent._last_handoff_error:
                self.ui.error(self.agent._last_handoff_error)
            self.console.print(render.render_markdown(terminal_safe_text(md)))
        elif cmd == "name":
            if rest.strip():
                if self.agent.name_session(rest.strip()):
                    self.ui.info(f"session named: {rest.strip()}")
                else:
                    self.ui.error(self.agent._last_persist_error or "session rename failed")
            else:
                self.ui.info(f"current session: {self.agent.session_name or '(unnamed)'} — /name <name>")
        elif cmd == "worktree":
            self._worktree_cmd(rest)
        elif cmd == "tasks":
            self._tasks_cmd(rest)
        elif cmd == "update":
            run_update()
        elif cmd == "agents":
            defs = self.agent.agent_defs
            sm = cfg.get("subagent_model") or f"(inherit main: {cfg.model})"
            sh = cfg.get("subagent_base_url") or f"(inherit main: {cfg.base_url})"
            st = cfg.get("subagent_api_mode") or "(inherit/infer)"
            self.console.print(
                f"[bold]Sub-agent defaults[/bold]  model [{BRAND}]{_markup_literal(sm)}[/]  ·  "
                f"host [{BRAND}]{_markup_literal(sh)}[/]  ·  "
                f"transport [{BRAND}]{_markup_literal(st)}[/]")
            self.console.print("[dim]/subagent model NAME  ·  /subagent host URL  ·  "
                               "/subagent transport MODE  ·  /subagent clear[/dim]")
            if not defs:
                self.ui.info("no named agents — add .dgc/agents/<name>.md "
                             "(frontmatter: model, base_url, api_mode, api_key_env, effort)")
            else:
                table = Table("agent", "description", "model", "host", "transport")
                for a in defs.values():
                    table.add_row(*(_literal_cell(value) for value in (
                        a.name, a.description, a.model or "(default)",
                        a.base_url or "(default)", a.api_mode or "(inherit/infer)")))
                self.console.print(table)
        elif cmd == "subagent":
            args = rest.split()
            if not args:
                self.ui.info(f"sub-agent model: {cfg.get('subagent_model') or '(inherit main)'}  ·  "
                             f"host: {cfg.get('subagent_base_url') or '(inherit main)'}  ·  "
                             f"transport: {cfg.get('subagent_api_mode') or '(inherit/infer)'}")
            elif args[0] == "model" and len(args) > 1:
                cfg.set("subagent_model", args[1])
                self.ui.info(f"sub-agent model → {args[1]}")
            elif args[0] == "host" and len(args) > 1:
                if len(args) > 2:
                    self.ui.error("API keys are not accepted inline — use DGC_SUBAGENT_API_KEY")
                    return True
                cfg.set("subagent_base_url", args[1])
                self.ui.info(f"sub-agent host → {args[1]}")
            elif args[0] == "transport" and len(args) == 2:
                mode = args[1].lower()
                if mode not in ("auto", "ollama", "anthropic", "chat_completions", "responses"):
                    self.ui.error(
                        "transport must be auto, ollama, anthropic, chat_completions, or responses")
                    return True
                cfg.set("subagent_api_mode", mode)
                self.ui.info(f"sub-agent transport → {mode}")
            elif args[0] == "clear":
                for k in ("subagent_model", "subagent_base_url", "subagent_api_key",
                          "subagent_api_mode"):
                    cfg.set(k, "")
                self.ui.info("sub-agent overrides cleared — inherits the main model/host")
            else:
                self.ui.error("usage: /subagent [model NAME | host URL | transport MODE | clear]")
        else:
            from .commands import discover_commands, render_command
            custom = discover_commands(self.config.project_root)
            if cmd in custom:
                rendered = render_command(custom[cmd], rest, self.config.project_root)
                if rendered:
                    self.agent.run_turn(rendered)
            else:
                self.console.print(
                    f"[dim]unknown command /{_markup_literal(cmd)} — try /help[/dim]")
        return True

    def _search_cmd(self, rest: str) -> None:
        cfg = self.config
        args = rest.split()
        if not args:
            self.ui.info(f"web search: {cfg.get('search_provider', 'duckduckgo')}  ·  "
                         f"options: {', '.join(SEARCH_PROVIDERS)}")
            return
        p = args[0].lower()
        if p not in SEARCH_PROVIDERS:
            self.ui.error("providers: " + ", ".join(SEARCH_PROVIDERS))
            return
        meta = SEARCH_PROVIDERS[p]
        cfg.set("search_provider", p)
        if meta["needs_key"]:
            if len(args) > 1:
                self.ui.error("API keys are not accepted inline — use the masked prompt, dgc setup, or DGC_SEARCH_API_KEY")
                return
            from getpass import getpass
            key = getpass(f"  API key for {meta['label']} › ").strip()
            cfg.set("search_api_key", key)
        if meta["needs_url"]:
            url = args[1] if len(args) > 1 else input(f"  base URL for {meta['label']} › ").strip()
            cfg.set("search_url", url)
        self.ui.info(f"web search → {meta['label']}")

    def _resume_cmd(self) -> None:
        items = sessions_mod.listing(
            self.config.project_root, redact_secrets=secret_values(self.config))
        if not items:
            self.ui.info("no saved sessions in this directory")
            return
        from .menu import select
        labels = [f"{sessions_mod.when(ts)}  ({cnt} msgs)  {(nm + ' · ' if nm else '')}{prev}"
                  for (p, ts, prev, cnt, nm) in items[:20]]
        si = select("Resume a session", labels)
        if si is None:
            return
        n = self.agent.load_session(items[si][0])
        self.ui.info(f"resumed session ({n} messages)"
                     + (f" — {self.agent.session_name}" if self.agent.session_name else ""))

    def _set_model(self, model: str) -> None:
        self.config.set("model", model)
        self.agent.refresh_client()
        ctx = self.agent.recommended_context_size(model)
        if ctx and ctx != int(self.config.get("context_size", 32768)):
            self.config.set("context_size", ctx)
            self.ui.info(f"model → {model}  ·  context auto-set to {ctx // 1024}k (/context to change)")
        else:
            self.ui.info(f"model → {model}")

    def _worktree_cmd(self, rest: str) -> None:
        from . import worktree as wt
        root = self.config.project_root
        parts = rest.split()
        if not parts or parts[0] == "list":
            wts = wt.list_worktrees(root)
            if not wts:
                self.ui.info("not a git repo, or no worktrees — /worktree <name> to create one")
                return
            style_mod.section(self.console, "git worktrees")
            for w in wts:
                self.console.print(
                    f"  [{BRAND}]{_markup_literal(w.get('branch', '(detached)'))}[/]  "
                    f"[{DIM}]{_markup_literal(w['path'])}[/]", highlight=False)
            return
        if parts[0] == "remove" and len(parts) > 1:
            err = wt.remove(root, " ".join(parts[1:]))
            (self.ui.error if err else self.ui.info)(err or f"removed worktree '{parts[1]}'")
            return
        wt_path, branch, err = wt.create(root, rest.strip())
        if err:
            self.ui.error(err)
            return
        self.ui.info(f"created worktree on branch {branch}")
        self._reroot(wt_path, f"worktree {branch}")

    def _tasks_cmd(self, rest: str) -> None:
        try:
            parts = shlex.split(rest)
        except ValueError as exc:
            self.ui.error(f"invalid /tasks arguments: {exc}")
            return
        action = parts[0].lower() if parts else "list"
        tasks, errors = self.agent.retained_tasks()
        if action in ("list", "show"):
            selected = tasks
            if action == "show":
                if len(parts) != 2:
                    self.ui.error("usage: /tasks show ID")
                    return
                selected = [task for task in tasks if task.id == parts[1]]
                if not selected:
                    self.ui.error(f"no retained task matching {parts[1]!r}")
                    return
            if not selected:
                self.ui.info("no retained sub-agent work for this project")
            else:
                table = Table("id", "state", "paths", "reason", "worktree")
                for task in selected[:100]:
                    state = ("legacy/manual" if task.legacy else
                             ("ready" if task.available else "stale"))
                    paths = ", ".join(task.display_paths[:5]) or "(none)"
                    if len(task.display_paths) > 5:
                        paths += f" (+{len(task.display_paths) - 5})"
                    table.add_row(*(_literal_cell(value) for value in (
                        task.id, state, paths, task.reason or "(unspecified)", task.path)))
                self.console.print(table)
                if len(selected) > 100:
                    self.ui.info(f"showing 100 of {len(selected)} records — /tasks show ID for one record")
            for error in errors:
                self.ui.error(error)
            if selected:
                self.ui.info("/tasks apply ID  ·  /tasks drop ID --confirm")
            return
        if action not in ("apply", "drop") or len(parts) < 2:
            self.ui.error("usage: /tasks [list | show ID | apply ID | drop ID --confirm]")
            return
        task_id = parts[1]
        if action == "drop" and "--confirm" not in parts[2:]:
            self.ui.info(f"drop permanently deletes the retained checkout; repeat: "
                         f"/tasks drop {shlex.quote(task_id)} --confirm")
            return
        result = self.agent.resolve_retained_task(task_id, action)
        if result.status == "applied":
            warning = f" Cleanup warning: {result.cleanup_error}." if result.cleanup_error else ""
            self.ui.info(f"applied retained task {task_id}: {len(result.paths)} path(s).{warning} "
                         "Use /rewind to undo.")
        elif result.status == "clean":
            warning = f" Cleanup warning: {result.cleanup_error}." if result.cleanup_error else ""
            self.ui.info(f"retained task {task_id} had no remaining changes.{warning}")
        elif result.status == "dropped":
            self.ui.info(f"dropped retained task {task_id}")
        else:
            conflicts = f" Conflicts: {', '.join(result.conflicts[:12])}." if result.conflicts else ""
            self.ui.error(f"could not {action} retained task {task_id}: "
                          f"{result.error or result.status}.{conflicts}")

    def _reroot(self, new_root, label: str) -> None:
        import os as _os
        try:
            _os.chdir(new_root)
        except OSError:
            pass
        self.config.project_root = new_root
        self.agent.ctx.project_root = new_root
        self.agent.reset()
        self.agent.session_file = sessions_mod.new_path(new_root)
        self.agent.session_name = label
        self.ui.info(f"switched to {new_root} — fresh session")

    def _permissions_cmd(self, rest: str) -> None:
        if not rest:
            for action in ("allow", "ask", "deny"):
                rules = self.config.permissions[action]
                self.console.print(f"[bold]{action}[/bold] ({len(rules)})")
                for r in rules:
                    self.console.print(f"  {terminal_safe_text(r)}", markup=False, highlight=False)
            return
        m = re.match(r"(allow|ask|deny)\s+(.+)", rest, re.S)
        if not m:
            self.ui.error("usage: /permissions allow|ask|deny Tool(pattern)")
            return
        action, rule_text = m.group(1), m.group(2).strip()
        try:
            Rule.parse(rule_text, action)
        except ValueError as e:
            self.ui.error(str(e))
            return
        self.config.permissions[action].append(rule_text)
        self.config.save()
        self.ui.info(f"rule saved: {action} {rule_text}")

    def _memory_cmd(self, rest: str) -> None:
        if not rest or rest == "show":
            proj, user = memory_mod.load_memories(
                self.config.project_root,
                sanitizer=lambda value: redact_text(value, secret_values(self.config)))
            self.console.print(Panel(
                _literal_cell(memory_mod.bounded_memory_view(proj or "(none)", 8000)),
                title="project DGC.md", expand=False))
            self.console.print(Panel(
                _literal_cell(memory_mod.bounded_memory_view(user or "(none)", 8000)),
                title="~/.dgc/DGC.md", expand=False))
            return
        m = re.match(r"add\s+(user\s+)?(.+)", rest, re.S)
        if not m:
            self.ui.error("usage: /memory [show] | /memory add [user] TEXT")
            return
        scope = "user" if m.group(1) else "project"
        self.agent.cancelled.clear()
        path = memory_mod.add_memory(
            m.group(2), self.config.project_root, scope, cancelled=self.agent.cancelled)
        self.ui.info(f"memory saved to {path}")

    # ----------------------------------------------------------- input prep ---
    def expand_mentions(self, text: str) -> str:
        """Prepare @path attachments through the shared explicit-user disclosure boundary."""
        self.agent._pending_images = None
        result = attachments_mod.expand_attachments(
            text, self.config.project_root,
            sanitizer=lambda value: redact_text(value, secret_values(self.config)),
            cancelled=self.agent.cancelled)
        self.agent._pending_images = list(result.images) or None
        for notice in result.notices:
            self.ui.info(notice)
        return result.text

    def run_bang(self, command: str) -> None:
        from .tools import direct_bash
        self.agent.cancelled.clear()
        out = direct_bash(command, self.agent.ctx)
        # Shell output is data, never Rich markup. This also keeps terminal control text from being
        # interpreted as a DGC status/card even when a build dependency prints hostile diagnostics.
        self.console.print(terminal_safe_text(out), markup=False, highlight=False, soft_wrap=True)

    # ---------------------------------------------------------------- loop ---
    def repl(self) -> None:
        self.banner()
        USER_HOME.mkdir(parents=True, exist_ok=True)
        session: PromptSession = PromptSession(
            history=FileHistory(str(USER_HOME / "history")),
            completer=ClassicSlashCompleter(self.config.project_root),
            complete_while_typing=True)
        from prompt_toolkit.formatted_text import ANSI
        queue: list[str] = []
        while True:
            mode = self.agent.mode
            th = style_mod.theme()
            acc, dim, rst = style_mod.ansi_fg(th.accent), style_mod.ansi_fg(th.faint), style_mod.ANSI_RESET
            if queue:                                   # run a follow-up queued during the last turn
                line = queue.pop(0)
                self.console.print(
                    f"  [{DIM}]{glyphs.ARROW} {_markup_literal(line)}[/]", highlight=False)
            else:
                try:                                    # ❯ prefix + right-aligned `model · mode`
                    rp = ANSI(f"{dim}{terminal_safe_text(self.config.model)}  {glyphs.MIDDOT}  "
                              f"{terminal_safe_text(mode)}{rst}")
                    line = session.prompt(ANSI(f"{acc}{glyphs.ARROW}{rst} "), rprompt=rp).strip()
                except KeyboardInterrupt:
                    continue
                except EOFError:
                    break
            if not line:
                continue
            try:
                if line.startswith("/"):
                    self.handle_slash(line)
                elif line.startswith("#"):
                    self.agent.cancelled.clear()
                    path = memory_mod.add_memory(
                        line[1:], self.config.project_root, cancelled=self.agent.cancelled)
                    self.ui.info(f"memory saved to {path}")
                elif line.startswith("!"):
                    self.run_bang(line[1:])
                else:
                    self._run_turn_live(self.expand_mentions(line), queue)
            except EOFError:
                break
            except KeyboardInterrupt:
                self.ui.info("interrupted")
            except Exception as e:  # keep the REPL alive
                self.ui.error(f"{type(e).__name__}: {e}")
        self.console.print("[dim]bye[/dim]")

    def _run_turn_live(self, text: str, queue: list[str]) -> None:
        """Run a turn on a worker thread while the main thread watches the keyboard:
        Esc / Ctrl-C interrupts the turn; a line typed + Enter is queued to run next.
        The reader cleanly hands stdin back when a tool needs an approval prompt."""
        self.agent.cancelled.clear()
        self.ui._tool_count = 0
        t0 = time.time()
        self.ui.start_working()          # live spinner until the first token / tool
        done = threading.Event()
        outcome = {"failed": False}

        def work() -> None:
            try:
                # _run_turn_live cleared stale state before exposing the interruptible turn.
                # Preserve any Esc/Ctrl-C that arrives while this worker thread is starting.
                outcome["failed"] = self.agent.run_turn(text, reset_cancel=False) is False
            except Exception as e:
                outcome["failed"] = True
                self.ui.error(f"{type(e).__name__}: {e}")
            finally:
                self.ui.stop_working()
                done.set()

        threading.Thread(target=work, daemon=True).start()

        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            done.wait()
            self.ui.turn_complete(time.time() - t0, self.agent.cancelled.is_set(),
                                  failed=outcome["failed"])
            return

        import select as _sel
        import termios
        import tty
        fd = sys.stdin.fileno()
        live = {"active": threading.Event(), "stop": threading.Event(), "released": threading.Event()}
        live["active"].set()
        self.ui._live = live
        old = termios.tcgetattr(fd)
        buf = ""
        try:
            tty.setcbreak(fd)  # char-at-a-time, ECHO off, but keep \n->\r\n and signals
            while not done.is_set():
                if live["stop"].is_set():
                    break                       # an approval prompt needs stdin — hand it over
                try:
                    r, _, _ = _sel.select([fd], [], [], 0.12)
                except (OSError, ValueError):
                    break
                if not r:
                    continue
                try:
                    ch = os.read(fd, 1).decode("utf-8", "replace")
                except OSError:
                    break
                if ch in ("\x1b", "\x03"):       # Esc / Ctrl-C — interrupt this turn
                    self.agent.cancelled.set()
                    self.console.print("\n[dim]⎋ interrupting…[/dim]", highlight=False)
                    buf = ""
                elif ch in ("\r", "\n"):         # Enter — queue what was typed so far
                    if buf.strip():
                        queue.append(buf.strip())
                        self.console.print(
                            f"[dim]↵ queued: {_markup_literal(buf.strip()[:70])}[/dim]",
                            highlight=False)
                    buf = ""
                elif ch == "\x7f":               # backspace
                    buf = buf[:-1]
                elif ch.isprintable():
                    buf += ch
        except KeyboardInterrupt:
            self.agent.cancelled.set()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
            live["active"].clear()
            live["released"].set()               # let a waiting approval proceed
            self.ui._live = None
        done.wait()
        self.ui.turn_complete(time.time() - t0, self.agent.cancelled.is_set(),
                              failed=outcome["failed"])


def run_doctor(config: Config) -> None:
    """`dgc doctor` — verify the endpoint is reachable and the model is available."""
    from . import sandbox
    from .llm import LLMClient
    c = Console()
    sandbox_report = sandbox.capabilities(config)
    sandbox_requested = sandbox.requested(config)
    c.print("[bold]DGC doctor[/bold] — checking your setup\n")
    c.print(f"  endpoint      {terminal_safe_text(config.base_url)}", markup=False,
            highlight=False)
    c.print(f"  model         {terminal_safe_text(config.model)}", markup=False, highlight=False)
    c.print(f"  mode          {terminal_safe_text(config.data.get('mode', 'default'))}", markup=False,
            highlight=False)
    c.print(f"  context_size  {config.get('context_size')}", markup=False, highlight=False)
    c.print(f"  config file   {terminal_safe_text(USER_CONFIG)}", markup=False, highlight=False)
    c.print(f"  sandbox       {'on' if sandbox_requested else 'off'} — "
            f"{terminal_safe_text(sandbox.describe(config))}\n", markup=False, highlight=False)
    if sandbox_requested and sandbox_report.available:
        c.print(f"  sandbox fs    {terminal_safe_text(sandbox_report.filesystem)}", markup=False,
                highlight=False)
        c.print(f"  sandbox home  {terminal_safe_text(sandbox_report.home)}", markup=False,
                highlight=False)
        c.print(f"  sandbox temp  {terminal_safe_text(sandbox_report.temporary)}", markup=False,
                highlight=False)
        c.print(f"  sandbox proc  {terminal_safe_text(sandbox_report.process)}", markup=False,
                highlight=False)
        c.print(f"  sandbox net   {terminal_safe_text(sandbox_report.network)}\n", markup=False,
                highlight=False)
    if sandbox_requested and not sandbox_report.available:
        c.print("  [bold red]✗[/bold red] sandbox is enabled but this platform has no supported backend")
        c.print("    → install bubblewrap on Linux, use sandbox-exec on macOS, or run [bold]/sandbox off[/bold]")
    # subscription engines — run your own plan through the official first-party CLI
    from . import subscriptions as _subs
    active = str(config.get("subscription_engine", "")).strip().lower()
    active_problem = ""
    c.print("  [bold]subscription engines[/bold] — run your own plan via the official CLI")
    subscription_status = _subs.status()
    for s in subscription_status:
        if s["auth_state"] == "signed_in":
            state = "[green]✓ signed in[/green]"
        elif s["auth_state"] == "check_on_launch":
            state = "[cyan]? auth checked by CLI on launch[/cyan]"
        elif s["auth_state"] == "signed_out":
            state = "[yellow]! not signed in[/yellow]"
        else:
            state = "[dim]not installed[/dim]"
        star = "  [bold cyan]← active[/bold cyan]" if s["key"] == active else ""
        c.print(f"    {s['key']:6} {state}{star}")
    if active in _subs.ENGINES:
        eng = _subs.ENGINES[active]
        c.print(f"  [cyan]→ delegating each turn to {terminal_safe_text(eng.label)}[/cyan] "
                f"(the model endpoint below is only the fallback)\n")
        active_status = next(s for s in subscription_status if s["key"] == active)
        if not active_status["installed"]:
            active_problem = f"the active {eng.short_label} CLI is not installed"
            c.print(f"  [yellow]![/yellow] {terminal_safe_text(active_problem)}\n")
        elif active_status["auth_state"] == "signed_out":
            active_problem = f"the active {eng.short_label} CLI is not signed in"
            c.print(f"  [yellow]![/yellow] but you are not signed in — run "
                    f"[bold]{terminal_safe_text(eng.login_cmd)}[/bold] once\n")
        elif eng.key == "kimi" and str(config.data.get("mode", "default")) != "auto":
            active_problem = "Kimi prompt mode requires DGC auto mode"
            c.print("  [yellow]![/yellow] Kimi's prompt mode is inherently auto-approved; "
                    "select [bold]/mode auto[/bold] or another engine\n")
    else:
        c.print("")
    client = LLMClient(config.base_url, config.api_key, config.model,
                       api_mode=str(config.get("api_mode", "auto")))
    try:
        models = client.list_models()
    except Exception as e:
        c.print(f"  [bold red]✗[/bold red] cannot reach {_markup_literal(config.base_url)} — "
                f"{_markup_literal(type(e).__name__)}: {_markup_literal(e)}")
        c.print("    → start your server (ollama serve / llama-server / LM Studio) or fix the URL & key")
        c.print("    → run [bold]dgc setup[/bold] to reconfigure")
        return
    c.print(f"  [green]✓[/green] endpoint reachable — {len(models)} model(s) offered")
    if config.model in models:
        c.print(f"  [green]✓[/green] model '{_markup_literal(config.model)}' is available")
    else:
        c.print(f"  [yellow]![/yellow] model '{_markup_literal(config.model)}' not offered by this server")
        if models:
            shown = ", ".join(models[:12]) + ("…" if len(models) > 12 else "")
            c.print(f"    available: {terminal_safe_text(shown)}", markup=False, highlight=False)
        c.print("    → set one: [bold]dgc --model <name>[/bold]  or  [bold]dgc setup[/bold]")
    if active_problem:
        c.print(f"\n  [bold red]not ready[/bold red] — {terminal_safe_text(active_problem)}.\n")
    elif sandbox_requested and not sandbox_report.available:
        c.print("\n  [bold red]not ready[/bold red] — sandboxed shell commands will fail closed.\n")
    else:
        c.print("\n  [bold green]ready[/bold green] — run [bold]dgc[/bold] to start.\n")


def run_setup(config: Config) -> None:
    """`dgc setup` — interactive first-run wizard: pick a provider, key, model, context."""
    from .llm import LLMClient
    c = Console()
    c.print("\n[bold]DGC setup[/bold] — point DGC at a model you run\n")
    from .menu import select
    from . import subscriptions as _subs
    # Subscription engines first — run your own Claude/Codex/Qwen/Kimi plan via its official CLI.
    subs_status = _subs.status()
    sub_labels = [f"{s['label']} — your own subscription" for s in subs_status]
    sub_hints = [("✓ signed in" if s["auth_state"] == "signed_in"
                  else ("authentication checked securely by the CLI on launch"
                        if s["auth_state"] == "check_on_launch" else
                        f"not signed in · run: {s['login_cmd']}" if s["installed"]
                        else "CLI not installed")) for s in subs_status]
    keys = list(PROVIDERS)
    prov_labels = sub_labels + [PROVIDERS[k]["label"] for k in keys] + ["custom endpoint (enter your own URL)"]
    prov_hints = sub_hints + [PROVIDERS[k]["base_url"] for k in keys] + [""]
    idx = select("Provider", prov_labels, prov_hints)
    if idx is None:
        c.print("[dim]cancelled[/dim]"); return
    n_sub = len(subs_status)
    if idx < n_sub:
        s = subs_status[idx]
        config.set("subscription_engine", s["key"])
        c.print(f"\n  [bold green]selected[/bold green] {terminal_safe_text(s['label'])} — "
                f"DGC will run each turn through your subscription via the official CLI.")
        if s["auth_state"] == "signed_in":
            c.print("  [green]✓ already signed in.[/green]")
        elif s["auth_state"] == "check_on_launch":
            c.print("  [cyan]authentication will be verified by the official CLI on first run.[/cyan]")
        else:
            c.print(f"  [yellow]sign in first:[/yellow] run "
                    f"[bold]{terminal_safe_text(s['login_cmd'])}[/bold] once, then retry.")
        c.print('  try it:  [bold]dgc -p "list the files in this folder"[/bold]  ·  '
                "[bold]dgc doctor[/bold] to verify\n")
        return
    idx -= n_sub                          # shift back into the direct-model provider list
    if idx < len(keys):
        prov = PROVIDERS[keys[idx]]
        base_url, api_key = prov["base_url"], prov["api_key"]
        if prov["needs_key"]:
            from getpass import getpass
            api_key = getpass(f"  API key for {prov['label']} › ").strip() or api_key
    else:
        base_url = input("  base URL (…/v1) › ").strip()
        if not base_url:
            c.print("[dim]cancelled[/dim]"); return
        from getpass import getpass
        api_key = getpass("  API key (blank for local) › ").strip() or "sk-local"
    config.set("subscription_engine", "")     # a direct model turns delegation back off
    config.set("base_url", base_url)
    if idx < len(keys):
        config.set("api_mode", "auto")
    config.set("api_key", api_key)
    client = LLMClient(config.base_url, config.api_key, config.model,
                       api_mode=str(config.get("api_mode", "auto")))
    try:
        models = client.list_models()
    except Exception as e:
        c.print(f"  [yellow]couldn't list models[/yellow] ({type(e).__name__}) — set one by name below.")
        models = []
    model_changed = False
    if models:
        mi = select("Model", models[:60])
        if mi is not None:
            config.set("model", models[mi])
            model_changed = True
    else:
        m = input(f"  model name [{config.model}] › ").strip()
        if m:
            config.set("model", m)
            model_changed = True
    if model_changed:
        from .config import context_for_model
        selected_client = LLMClient(
            config.base_url, config.api_key, config.model,
            api_mode=str(config.get("api_mode", "auto")))
        discovered_context = (selected_client.model_context_limit()
                              if selected_client.api_mode == "anthropic" else 0)
        suggested_context = discovered_context or context_for_model(config.model)
        if suggested_context:
            config.set("context_size", suggested_context)
    cs = input(f"  context window in tokens [{config.get('context_size')}] › ").strip()
    if cs.isdigit():
        config.set("context_size", int(cs))
    skeys = list(SEARCH_PROVIDERS)
    si = select("Web search  (optional — powers the web_search tool)",
                [SEARCH_PROVIDERS[k]["label"] for k in skeys])
    sk = skeys[si] if si is not None else "duckduckgo"
    config.set("search_provider", sk)
    meta = SEARCH_PROVIDERS[sk]
    if meta["needs_key"]:
        from getpass import getpass
        config.set("search_api_key", getpass(f"  API key for {meta['label']} › ").strip())
    if meta["needs_url"]:
        config.set("search_url", input(f"  base URL for {meta['label']} › ").strip())
    c.print(f"\n  [bold green]saved[/bold green] → {_markup_literal(USER_CONFIG)}")
    c.print(f"  endpoint {terminal_safe_text(config.base_url)}  ·  "
            f"model {terminal_safe_text(config.model)}  ·  "
            f"context {config.get('context_size')}  ·  search {config.get('search_provider')}",
            markup=False, highlight=False)
    c.print("  run [bold]dgc[/bold] to start  ·  [bold]dgc doctor[/bold] to verify\n")


def run_help() -> None:
    """`dgc help` — CLI commands + in-REPL commands, for new users."""
    c = Console()
    c.print("\n[bold]DGC[/bold] — a coding-agent CLI for the models you run  [dim](Built by Mohit Kalra)[/dim]\n")
    c.print("[bold]command line[/bold]")
    c.print("  dgc                     start the interactive agent")
    c.print("  dgc setup               configure provider / model / context")
    c.print("  dgc doctor              check the endpoint + model are reachable")
    c.print("  dgc help                this help")
    c.print("  dgc -p \"<task>\"         run one task and exit  (add --mode auto for hands-off)")
    c.print("  dgc --mode MODE         default | acceptEdits | plan | auto")
    c.print("  dgc -c / --continue     resume the most recent session in this directory")
    c.print("  dgc --resume            pick a past session to resume")
    c.print("  dgc update              update DGC to the latest version")
    c.print("  dgc protocol describe  inspect the installed headless/editor contract as JSON")
    c.print("  dgc --model N --base-url URL --api-key-env NAME   configure without exposing a key\n")
    render_help(c)


def main(argv: list[str] | None = None) -> int | None:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    if raw_argv and raw_argv[0] in (
            "setup", "doctor", "help", "update", "serve", "acp", "protocol", "bug"):
        if raw_argv[0] == "help":
            run_help(); return
        if raw_argv[0] == "bug":
            print("\n  Report a bug or request a feature:\n"
                  "    https://github.com/OpenPeach-ai/dgc/issues\n")
            return
        if raw_argv[0] == "update":
            run_update(); return
        if raw_argv[0] == "serve":
            # headless JSON backend for editor front-ends — stdout is protocol-only,
            # so this returns before the banner / update-check ever run.
            from .headless import serve
            serve(Config()); return
        if raw_argv[0] == "acp":
            # Agent Client Protocol (JSON-RPC over stdio) for Zed/JetBrains/Neovim/Emacs.
            from .acp import serve as acp_serve
            acp_serve(); return
        if raw_argv[0] == "protocol":
            # Contract discovery/validation is intentionally side-effect-free: no Config, update
            # check, model endpoint, session, or user-state access.
            from .protocol_cli import main as protocol_main
            return protocol_main(raw_argv[1:])
        cfg = Config()
        (run_setup if raw_argv[0] == "setup" else run_doctor)(cfg)
        return

    parser = argparse.ArgumentParser(
        allow_abbrev=False,
        prog="dgc", description="DGC — a coding-agent CLI for the models you run",
        epilog="commands: dgc setup · dgc doctor · dgc help · dgc (interactive) · dgc -p '<task>' (one-shot)")
    parser.add_argument("-p", "--prompt", help="run a single prompt non-interactively and exit")
    parser.add_argument("--mode", choices=MODES, help="permission mode for this session")
    parser.add_argument("--think", choices=THINK_LEVELS, help="thinking level for this session")
    parser.add_argument("--model", help="model name (persisted)")
    parser.add_argument("--engine", metavar="NAME", default=None,
                        help="run this one turn through a subscription CLI "
                             "(claude|codex|qwen|kimi|copilot) via your own login, without changing config")
    parser.add_argument("--base-url", help="OpenAI-compatible endpoint URL (persisted)")
    parser.add_argument("--api-key-env", metavar="NAME",
                        help="read the endpoint API key from environment variable NAME without persisting it")
    parser.add_argument("--trust", action="store_true",
                        help="trust this workspace for a non-interactive acceptEdits/auto run")
    parser.add_argument("-c", "--continue", dest="cont", action="store_true",
                        help="resume the most recent session in this directory")
    parser.add_argument("--resume", nargs="?", const="", default=None, metavar="ID",
                        help="resume a past session by id (dgc --resume <id>), or pick one (dgc --resume)")
    parser.add_argument("--classic", action="store_true", help="use the classic inline REPL instead of the full-screen app")
    parser.add_argument("--version", action="version", version=f"dgc {__version__}")
    args = parser.parse_args(argv)
    if not args.prompt:          # one-shot `-p` has no banner to show an update in — skip the check
        refresh_update_async()

    config = Config()
    if args.base_url:
        config.set("base_url", args.base_url)
    if args.api_key_env:
        if args.api_key_env not in os.environ:
            parser.error(f"environment variable {args.api_key_env!r} is not set")
        config.data["api_key"] = os.environ[args.api_key_env]
        config._env_secret_keys.add("api_key")
    if args.model:
        config.set("model", args.model)
    if args.mode:
        config.data["mode"] = args.mode
    if args.think:
        config.data["thinking"] = args.think

    if args.prompt is not None:
        from .trust import is_trusted, mark_trusted
        if args.trust:
            mark_trusted(config, config.project_root)
        elif config.data.get("mode") in ("acceptEdits", "auto") and not is_trusted(config, config.project_root):
            parser.error("non-interactive acceptEdits/auto requires a trusted workspace; review it, then add --trust")

    cli = CLI(config)

    # session persistence (transcripts resume across runs)
    if args.cont:
        p = sessions_mod.latest(config.project_root)
        if p:
            n = cli.agent.load_session(p)
            cli.ui.info(f"resumed session ({n} messages) — {p.name}")
        else:
            cli.ui.info("no previous session here — starting fresh")
            cli.agent.session_file = sessions_mod.new_path(config.project_root)
    elif args.resume is not None and args.resume != "":     # `dgc --resume <id>` → load it directly
        p = sessions_mod.by_id(config.project_root, args.resume)
        if p:
            n = cli.agent.load_session(p)
            cli.ui.info(f"resumed session ({n} messages) — {p.stem}")
        else:
            cli.ui.info(f"no session '{args.resume}' in this project — starting fresh")
            cli.agent.session_file = sessions_mod.new_path(config.project_root)
    elif args.resume is not None:                           # `dgc --resume` → pick from a list
        items = sessions_mod.listing(
            config.project_root, redact_secrets=secret_values(config))
        if items:
            from .menu import select
            labels = [f"{sessions_mod.when(ts)}  ({cnt} msgs)  {(nm + ' · ' if nm else '')}{prev}"
                      for (pp, ts, prev, cnt, nm) in items[:20]]
            si = select("Resume a session", labels)
            if si is not None:
                cli.agent.load_session(items[si][0])
            else:
                cli.agent.session_file = sessions_mod.new_path(config.project_root)
        else:
            cli.agent.session_file = sessions_mod.new_path(config.project_root)
    else:
        cli.agent.session_file = sessions_mod.new_path(config.project_root)

    if args.prompt is not None:
        _sub_engine = str(args.engine if args.engine is not None
                          else config.get("subscription_engine", "")).strip().lower()
        if _sub_engine:
            return _run_subscription_oneshot(
                config, cli.agent, _sub_engine, cli.expand_mentions(args.prompt),
                bool(args.cont or args.resume is not None))
        if config.data.get("mode") == "auto":
            print("⚠ auto mode: DGC will run every command and file write with no approval.", file=sys.stderr)
        outcome = cli.agent.run_turn(cli.expand_mentions(args.prompt))
        cli.ui.end_stream()
        print()
        if outcome is False:
            return 1
    else:
        import atexit

        from . import termbg
        termbg.apply(config)                 # dark canvas on a light terminal, for the whole session
        atexit.register(termbg.reset)
        try:
            from .trust import confirm_trust
            if not confirm_trust(config, config.project_root):   # first-run trust gate
                return
            if config.get("artifact_autostart", True):   # bring saved artifact previews back up
                try:
                    from . import artifacts
                    artifacts.autostart_if_pending(
                        int(config.get("artifact_port", 45000)),
                        lan=(str(config.get("artifact_bind", "localhost")).lower() == "lan"))
                except Exception:
                    pass
            _se = str(config.get("subscription_engine", "")).strip().lower()
            if args.classic or not sys.stdout.isatty():
                if _se:
                    from . import subscriptions as _subs
                    _eng = _subs.get_engine(_se)
                    if _eng is not None:
                        Console().print(
                            f'  [yellow]note[/yellow] {terminal_safe_text(_eng.label)} (subscription) '
                            f'delegation runs in the full-screen app and one-shot ([bold]dgc -p[/bold]); '
                            f'the classic REPL uses your fallback model.\n')
                cli.repl()
            else:
                from .tui import TUI
                TUI(config, agent=cli.agent).run()
        finally:
            termbg.reset()
            _print_resume_hint(cli.agent, config)   # after the alt-screen is restored — no blank lines


def _run_subscription_oneshot(config, agent, engine_key: str, prompt: str, cont: bool) -> int:
    """One-shot turn delegated to the user's own logged-in first-party CLI (their
    subscription). DGC streams the vendor CLI's output; the vendor owns auth, the
    model call, its tools, and its ToS. Returns a process exit code."""
    from . import subscriptions as subs
    c = Console()
    engine = subs.get_engine(engine_key)
    if engine is None:
        c.print(f"  [red]unknown subscription engine "
                f"{_markup_literal(engine_key)}[/red] — one of: {', '.join(subs.ENGINE_KEYS)}")
        return 1
    if getattr(agent, "_pending_images", None):
        agent._pending_images = None
        c.print("  [yellow]subscription CLI delegation does not yet support DGC image "
                "attachments; no vendor process was started[/yellow]")
        return 1
    try:
        subs.preflight(engine)
    except subs.EngineError as e:
        c.print(f"  [yellow]{_markup_literal(str(e))}[/yellow]")
        return 1
    c.print(f"[dim]— running your turn through {terminal_safe_text(engine.label)} "
            f"(your subscription) —[/dim]")
    last = {"text": ""}

    def on_event(ev: dict) -> None:
        kind = ev.get("kind")
        if kind == "tool_call":
            name = terminal_safe_text(str(ev.get("name") or "tool"))
            args = ev.get("args") or {}
            summ = terminal_safe_text(str(args.get("command") or args.get("file_path")
                                          or args.get("path") or ""))[:120]
            c.print(f"[dim]· {name}{(' ' + summ) if summ else ''}[/dim]", highlight=False)
        elif kind == "thinking" and ev.get("text"):
            c.print(f"[dim]  {terminal_safe_text(ev['text'][:200])}[/dim]", highlight=False)
        elif kind == "status" and ev.get("text"):
            c.print(f"[dim]· {terminal_safe_text(ev['text'])}[/dim]", highlight=False)
        elif kind == "error" and ev.get("text"):
            # Render once after process exit, where it can be paired with the exit status.
            return
        elif kind == "text" and ev.get("text"):
            last["text"] = ev["text"]
            sys.stdout.write(ev["text"] if ev["text"].endswith("\n") else ev["text"] + "\n")
            sys.stdout.flush()
        elif kind == "result" and ev.get("text", "").strip() \
                and ev["text"].strip() != last["text"].strip():
            sys.stdout.write(ev["text"] if ev["text"].endswith("\n") else ev["text"] + "\n")
            sys.stdout.flush()

    budget = int(config.get("turn_budget_s") or 0) or 1800
    mode = str(config.data.get("mode", "default"))
    configured_engine = str(config.get("subscription_engine", "")).strip().lower()
    model = (str(config.get("subscription_model", "")).strip()
             if configured_engine == engine.key else "")
    effort = (str(config.get("subscription_effort", "")).strip()
              if configured_engine == engine.key else "")
    session_id = agent.subscription_session_id(engine.key, mode, model, effort) if cont else ""

    def delegate(safe_prompt: str) -> dict:
        result = subs.run_turn(engine, safe_prompt, config.project_root,
                               cont=bool(cont and session_id), session_id=session_id, mode=mode,
                               timeout=budget, on_event=on_event, model=model, effort=effort)
        if result.get("session_id") and not result.get("cancelled") and not result.get("timeout"):
            agent.remember_subscription_session(
                engine.key, result["session_id"], mode, model, effort)
        return result

    try:
        res = agent.run_external_turn(prompt, delegate)
    except subs.EngineError as e:
        c.print(f"  [yellow]{_markup_literal(str(e))}[/yellow]")
        return 1
    print()
    if res.get("timeout"):
        c.print("  [yellow]! the delegated turn hit the time budget and was stopped[/yellow]")
        return 1
    if res.get("cancelled"):
        c.print("  [yellow]! delegated turn was stopped[/yellow]")
        return 1
    if res.get("error"):
        c.print(f"  [red]{_markup_literal(res['error'])}[/red]")
    elif res.get("rc") not in (0, None):
        c.print(f"  [red]{terminal_safe_text(engine.short_label)} exited with status "
                f"{res['rc']}[/red]")
    return 0 if res.get("ok") else 1


def _print_resume_hint(agent, config) -> None:
    """The single epilogue printed to the normal screen after the full-screen app exits — ONE block
    offering both ways to come back (the quick `--continue` and the exact `--resume <id>`), so there
    aren't two separate 'Resume this session' notices. Only when a real conversation happened, so a
    glance-and-quit leaves nothing behind."""
    sf = getattr(agent, "session_file", None)
    if not sf or len([m for m in getattr(agent, "messages", []) if m.get("role") != "system"]) < 2:
        return
    name = None
    try:
        name = sessions_mod.name_of(sf, config.project_root)
    except Exception:
        pass
    tty = sys.stdout.isatty()
    dim, bold, rst = ("\x1b[2m", "\x1b[1m", "\x1b[0m") if tty else ("", "", "")
    cont = "dgc --continue"
    res = f"dgc --resume {terminal_safe_text(sf.stem)}"
    w = max(len(cont), len(res)) + 4                       # align the descriptions past the longer command
    safe_name = terminal_safe_text(name).replace("\n", " ") if name else ""
    nm = f" {dim}({safe_name}){rst}" if safe_name else ""
    sys.stdout.write(f"\n  Resume this session{nm}:\n")
    sys.stdout.write(f"    {bold}{cont}{rst}{' ' * (w - len(cont))}{dim}the most recent in this folder{rst}\n")
    sys.stdout.write(f"    {bold}{res}{rst}{' ' * (w - len(res))}{dim}this exact session{rst}\n\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
