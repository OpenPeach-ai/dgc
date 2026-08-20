"""Interactive CLI for dgc — REPL, slash commands, streaming render,
approval prompts and plan-mode approval flow."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from . import __version__, glyphs, logo as logo_mod, memory as memory_mod, render, sessions as sessions_mod
from . import style as style_mod
from .agent import Agent
from .config import PROVIDERS, SEARCH_PROVIDERS, USER_CONFIG, USER_HOME, Config
from .llm import LLMError
from .menu import select as menu_select
from .permissions import DISPLAY, MODES, MODE_DESCRIPTIONS, Rule, rule_for
from .style import ANSI_DIM, ANSI_RESET, BRAND, BRAND_MAGENTA, DIM, section
from .tools import TOOL_SCHEMAS

from .update import (  # update-check lives in its own module so the TUI can share it
    UPDATE_CACHE, VERSION_URL, cached_update, refresh_update_async, run_update)


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

    # --------------------------------------------------- working indicator ---
    def start_working(self, label: str = "working") -> None:
        """Show a live spinner from submit until the first token/tool — so the user
        knows the model is loading/generating, not that the CLI hung."""
        if not sys.stdout.isatty():
            return
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

    def turn_complete(self, elapsed: float, cancelled: bool = False) -> None:
        """A clear end-of-turn delimiter so the user knows the model is done and it's
        their turn — not still working, not waiting on a follow-up."""
        self.stop_working()
        if self._streamed:                       # close off any mid-stream line
            self.console.print()
            self._streamed = False
        if not sys.stdout.isatty():              # scripts / pipes don't want a UX marker
            return
        verb = "stopped" if cancelled else "done"
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
        self.console.print(chunk, end="", markup=False, highlight=False, soft_wrap=True)
        self.console.file.flush()  # stream live — rich/stdout otherwise buffers until a newline
        self._streamed = True

    def on_thinking(self, chunk: str) -> None:
        self.stop_working()
        if not self._thinking:
            self.console.print("\n[dim italic]· thinking…[/] ", end="")
            self._thinking = True
        self.console.print(chunk, end="", markup=False, highlight=False, style="dim italic")
        self.console.file.flush()
        self._streamed = True

    def end_stream(self) -> None:
        if self._streamed:
            self.console.print()
            self._streamed = False
            self._thinking = False

    # ------------------------------------------------------ tool rendering ---
    def tool_call(self, name: str, args: dict) -> None:
        self.stop_working()
        self._tool_count += 1
        summary = self._arg_summary(name, args)
        self.console.print(f"\n[bold {BRAND}]{glyphs.tool_icon(name)} {name}[/] "
                           f"[{DIM}]{summary}[/]", highlight=False)

    def tool_result(self, name: str, out: str) -> None:
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

    def tool_denied(self, name: str, args: dict, reason: str) -> None:
        self.stop_working()
        self.console.print(f"[bold red]✗ {name} denied[/bold red] [{DIM}]{reason}[/]", highlight=False)

    @staticmethod
    def _arg_summary(name: str, args: dict) -> str:
        for key in ("path", "command", "pattern", "url", "name", "memory"):
            if key in args:
                value = str(args[key]).replace("\n", " ")
                return value[:120] + ("…" if len(value) > 120 else "")
        return ""

    # ---------------------------------------------------------- approvals ---
    def approve(self, name: str, args: dict) -> str:
        """Return 'once' | 'always' | 'no'."""
        self._yield_stdin()
        section(self.console, "permission requested", name)
        if name == "bash":
            self.console.print(render.mono_syntax(str(args.get("command", "")), "bash"))
        else:
            summary = self._arg_summary(name, args)
            if summary:
                self.console.print(f"  [{DIM}]{summary}[/]", highlight=False)
        rule = rule_for(name, args)
        idx = menu_select("Allow this?",
                          ["allow once", "always allow", "deny"],
                          ["just this time", f"add rule {rule}", "block it"])
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
        self.console.print(render.render_markdown(plan or "(empty plan)"))
        idx = menu_select("Approve this plan?",
                          ["build in full-auto", "build with acceptEdits", "build in default",
                           "keep planning"],
                          ["approve everything", "auto-approve edits", "ask per action",
                           "reject & refine"])
        target = {0: "auto", 1: "acceptEdits", 2: "default"}.get(idx)
        if target:
            return target
        feedback = input("  feedback for the plan (optional): ").strip()
        if feedback:
            self.console.print(f"  [{DIM}]feedback noted — the agent will see your denial[/]")
        return None

    def propose_options(self, question: str, options: list[str]) -> str:
        """Model-driven multiple choice — the agent asks, the user picks. Returns the chosen text."""
        self._yield_stdin()
        idx = menu_select(question or "Choose one",
                          list(options) + ["something else…"],
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

    # ---------------------------------------------------------------- misc ---
    def on_todo(self, todos: list) -> None:
        self.stop_working()
        if not todos:
            return
        marks = {"done": "[green]☑[/green]", "in_progress": f"[{BRAND}]◐[/]", "pending": f"[{DIM}]☐[/]"}
        section(self.console, "todos")
        for t in todos:
            self.console.print(f"  {marks.get(t['status'], '☐')} {t['content']}", highlight=False)

    def info(self, msg: str) -> None:
        self.stop_working()
        self.console.print(f"  [{DIM}]· {msg}[/]", highlight=False)

    def error(self, msg: str) -> None:
        self.stop_working()
        self.console.print(f"[bold red]error:[/bold red] {msg}")

    def add_permission_rule(self, name: str, args: dict) -> None:
        """Persist an allow-rule for this tool call — the 'always allow' path."""
        if self._rule_hook:
            self._rule_hook(str(rule_for(name, args)))


# ------------------------------------------------------------------- REPL ---

HELP = """\
[bold]chat[/bold]
  just type            ask dgc anything; it uses tools to act on your project
  #fact                quick-add a memory to DGC.md
  !cmd                 run a shell command directly
  @path/to/file        attach a file's contents to your message

[bold]slash commands[/bold]
  /help                this help
  /connect P|URL [KEY] connect a preset (ollama, llamacpp, openai, openrouter, groq…) or a raw URL
  /models              list models served by the endpoint
  /model [NAME]        show or set the model
  /mode [MODE]         default | acceptEdits | plan | auto   (no arg: cycle)
  /plan                toggle plan mode
  /think [LEVEL]       off | low | medium | high   (keywords 'think', 'think hard',
                       'ultrathink' in a prompt bump it for that turn; reasoning
                       models — o-series, DeepSeek-R1, qwen-thinking — do best on
                       hard tasks at 'high')
  /permissions         list rules;  /permissions allow|ask|deny Tool(pattern)
  /memory [show]       show memory files
  /memory add TEXT     add to project memory;  /memory add user TEXT → user memory
  /skills              list skills (bundled defaults + ~/.dgc/skills + .dgc/skills)
  /skill NAME [ARGS]   invoke a skill directly
  /agents              list named sub-agents (.dgc/agents/*.md) + sub-agent defaults
  /subagent …          set the sub-agent model/host: model NAME | host URL [KEY] | clear
  /init                have the agent analyze the project and write DGC.md
  /status              current config
  /context             show context-window usage
  /theme [NAME]        switch theme: dark | light
  /compact             compact conversation context now
  /clear               reset the conversation
  /rewind              restore code + conversation to an earlier turn
  /mcp                 list connected MCP servers and their tools
  /search [P [K|URL]]  web search provider: duckduckgo | brave | tavily | searxng
  /resume              resume a past conversation in this project
  /update              update DGC to the latest version
  /exit                quit
  (while a turn runs: type a follow-up + Enter to queue it · Esc to interrupt)
"""


def render_help(console) -> None:
    """Print HELP with brand-tinted command tokens + dim descriptions (one content source).

    Command tokens contain literal brackets (/memory [show], /think [LEVEL]) that would
    collide with rich markup — build styled Text so nothing is parsed as a tag.
    """
    from rich.text import Text
    for line in HELP.splitlines():
        if not line.strip():
            console.print()
        elif line.startswith("[bold]"):
            console.print(line, highlight=False)                       # section header (white)
        elif line[:2] == "  " and line[2:3] not in (" ", "(", ""):
            m = re.match(r"^(\S.*?)(\s{2,})(.*)$", line[2:])            # command  ·  description
            t = Text("  ")
            if m:
                cmd, gap, desc = m.groups()
                t.append(cmd, style=BRAND); t.append(gap); t.append(desc, style=DIM)
            else:
                t.append(line[2:], style=BRAND)
            console.print(t)
        else:
            console.print(Text(line, style=DIM))                       # continuation / footer hint


class CLI:
    def __init__(self, config: Config):
        self.config = config
        style_mod.set_theme(config.get("theme", "dark"))   # honour the saved theme
        self.ui = UI()
        self.ui._rule_hook = self._add_rule
        self.agent = Agent(config, self.ui)
        self.console = self.ui.console

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
            c.print(f"  [bold {BRAND_MAGENTA}]dgc[/] [{DIM}]v{__version__} · {cfg.model} · "
                    f"{cfg.data.get('mode', 'default')}[/]", highlight=False)
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
            c.print(f"  [{DIM}]{label:<8}[/]  {value}", highlight=False)
        row("endpoint", cfg.base_url)
        row("model", cfg.model)
        c.print(f"  [{DIM}]{'mode':<8}[/]  [{MODE_COLOR.get(mode, 'white')}]{mode}[/]  "
                f"[{DIM}]· {MODE_DESCRIPTIONS.get(mode, '')}[/]", highlight=False)
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
                int(cfg.get("context_size", 32768))), highlight=False)
        upd = cached_update()
        if upd:
            c.print(f"  [bold {BRAND_MAGENTA}]⬆ update available: v{upd}[/]  "
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
        cmd = parts[0].lower() if parts else ""
        rest = parts[1] if len(parts) > 1 else ""
        cfg = self.config

        if cmd in ("exit", "quit", "q"):
            raise EOFError
        if cmd == "help":
            render_help(self.console)
        elif cmd == "connect":
            args = rest.split()
            if not args:
                from .menu import select
                pk = list(PROVIDERS)
                idx = select("Connect a provider", [PROVIDERS[k]["label"] for k in pk],
                             [PROVIDERS[k]["base_url"] for k in pk])
                if idx is not None:
                    prov = PROVIDERS[pk[idx]]
                    cfg.set("base_url", prov["base_url"])
                    if prov["needs_key"]:
                        key = input(f"  API key for {prov['label']} › ").strip()
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
                    if len(args) > 1:
                        cfg.set("api_key", args[1])
                    elif prov["needs_key"]:
                        key = input(f"  API key for {prov['label']} › ").strip()
                        cfg.set("api_key", key or prov["api_key"])
                    else:
                        cfg.set("api_key", prov["api_key"])
                else:
                    cfg.set("base_url", target)
                    if len(args) > 1:
                        cfg.set("api_key", args[1])
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
                    self.ui.info(f"mode → [{MODE_COLOR['auto']}]auto[/] ({MODE_DESCRIPTIONS['auto']})")
                else:
                    self.ui.info(f"kept {self.agent.mode}")
            else:
                self.agent.set_mode(rest)
                self.ui.info(f"mode → [{MODE_COLOR[rest]}]{rest}[/] ({MODE_DESCRIPTIONS[rest]})")
        elif cmd == "plan":
            target = "default" if self.agent.mode == "plan" else "plan"
            self.agent.set_mode(target)
            self.ui.info(f"mode → [{MODE_COLOR[target]}]{target}[/] ({MODE_DESCRIPTIONS[target]})")
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
                table.add_row(s.name, s.description, str(s.path))
            self.console.print(table)
        elif cmd == "mcp":
            self.console.print("[bold]MCP servers[/bold] [dim](configure in ~/.dgc/config.json → mcp_servers)[/dim]")
            self.console.print(self.agent.mcp.summary())
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
            used, size = self.agent.estimate_tokens(), int(cfg.get("context_size", 32768))
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
            self.agent.maybe_compact(force=True)
            self.ui.info(f"~{self.agent.estimate_tokens()} tokens in context")
        elif cmd == "clear":
            self.agent.reset()
            self.ui.info("conversation cleared")
        elif cmd == "rewind":
            pts = self.agent.checkpoints.listing()
            if not pts:
                self.ui.info("no checkpoints yet — run a turn first")
            else:
                labels = [f"{prev}  [{nf} file{'' if nf == 1 else 's'}]" for (_i, prev, nf) in pts]
                mi = select("Rewind to (restores code + conversation)", labels)
                if mi is not None:
                    _, nfiles = self.agent.rewind(pts[mi][0])
                    self.ui.info(f"↩ rewound — restored {nfiles} file(s); conversation truncated")
        elif cmd == "search":
            self._search_cmd(rest)
        elif cmd == "resume":
            self._resume_cmd()
        elif cmd == "name":
            if rest.strip():
                self.agent.name_session(rest.strip())
                self.ui.info(f"session named: {rest.strip()}")
            else:
                self.ui.info(f"current session: {self.agent.session_name or '(unnamed)'} — /name <name>")
        elif cmd == "worktree":
            self._worktree_cmd(rest)
        elif cmd == "update":
            run_update()
        elif cmd == "agents":
            defs = self.agent.agent_defs
            sm = cfg.get("subagent_model") or f"(inherit main: {cfg.model})"
            sh = cfg.get("subagent_base_url") or f"(inherit main: {cfg.base_url})"
            self.console.print(f"[bold]Sub-agent defaults[/bold]  model [{BRAND}]{sm}[/]  ·  host [{BRAND}]{sh}[/]")
            self.console.print("[dim]/subagent model NAME  ·  /subagent host URL [KEY]  ·  /subagent clear[/dim]")
            if not defs:
                self.ui.info("no named agents — add .dgc/agents/<name>.md "
                             "(frontmatter: model, base_url, api_key, effort)")
            else:
                table = Table("agent", "description", "model", "host")
                for a in defs.values():
                    table.add_row(a.name, a.description, a.model or "(default)", a.base_url or "(default)")
                self.console.print(table)
        elif cmd == "subagent":
            args = rest.split()
            if not args:
                self.ui.info(f"sub-agent model: {cfg.get('subagent_model') or '(inherit main)'}  ·  "
                             f"host: {cfg.get('subagent_base_url') or '(inherit main)'}")
            elif args[0] == "model" and len(args) > 1:
                cfg.set("subagent_model", args[1])
                self.ui.info(f"sub-agent model → {args[1]}")
            elif args[0] == "host" and len(args) > 1:
                cfg.set("subagent_base_url", args[1])
                if len(args) > 2:
                    cfg.set("subagent_api_key", args[2])
                self.ui.info(f"sub-agent host → {args[1]}")
            elif args[0] == "clear":
                for k in ("subagent_model", "subagent_base_url", "subagent_api_key"):
                    cfg.set(k, "")
                self.ui.info("sub-agent overrides cleared — inherits the main model/host")
            else:
                self.ui.error("usage: /subagent [model NAME | host URL [KEY] | clear]")
        else:
            from .commands import discover_commands, render_command
            custom = discover_commands(self.config.project_root)
            if cmd in custom:
                rendered = render_command(custom[cmd], rest)
                if rendered:
                    self.agent.run_turn(rendered)
            else:
                self.console.print(f"[dim]unknown command /{cmd} — try /help[/dim]")
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
            key = args[1] if len(args) > 1 else input(f"  API key for {meta['label']} › ").strip()
            cfg.set("search_api_key", key)
        if meta["needs_url"]:
            url = args[1] if len(args) > 1 else input(f"  base URL for {meta['label']} › ").strip()
            cfg.set("search_url", url)
        self.ui.info(f"web search → {meta['label']}")

    def _resume_cmd(self) -> None:
        items = sessions_mod.listing(self.config.project_root)
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
        from .config import context_for_model
        self.config.set("model", model)
        self.agent.refresh_client()
        ctx = context_for_model(model)
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
                self.console.print(f"  [{BRAND}]{w.get('branch', '(detached)')}[/]  [{DIM}]{w['path']}[/]",
                                   highlight=False)
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
                    self.console.print(f"  {r}")
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
            proj, user = memory_mod.load_memories(self.config.project_root)
            self.console.print(Panel(proj or "(none)", title="project DGC.md", expand=False))
            self.console.print(Panel(user or "(none)", title="~/.dgc/DGC.md", expand=False))
            return
        m = re.match(r"add\s+(user\s+)?(.+)", rest, re.S)
        if not m:
            self.ui.error("usage: /memory [show] | /memory add [user] TEXT")
            return
        scope = "user" if m.group(1) else "project"
        path = memory_mod.add_memory(m.group(2), self.config.project_root, scope)
        self.ui.info(f"memory saved to {path}")

    # ----------------------------------------------------------- input prep ---
    _IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

    def expand_mentions(self, text: str) -> str:
        """Inline @path text files; attach @path image files to the next prompt (vision models)."""
        attachments, images = [], []
        for token in re.findall(r"@([\w./\-~]+)", text):
            p = Path(token).expanduser()
            if not p.is_absolute():
                p = self.config.project_root / p
            if not p.is_file():
                continue
            if p.suffix.lower() in self._IMG_EXT:
                try:
                    import base64
                    data = base64.b64encode(p.read_bytes()).decode()
                    ext = p.suffix.lower().lstrip(".")
                    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
                    images.append(f"data:{mime};base64,{data}")
                except OSError:
                    pass
            else:
                try:
                    content = p.read_text(errors="replace")[:20000]
                    attachments.append(f"<file path=\"{p}\">\n{content}\n</file>")
                except OSError:
                    pass
        if images:
            self.agent._pending_images = images
        if attachments:
            text += "\n\n" + "\n".join(attachments)
        return text

    def run_bang(self, command: str) -> None:
        try:
            proc = subprocess.run(command, shell=True, capture_output=True, text=True,
                                  timeout=int(self.config.get("bash_timeout", 120)),
                                  cwd=str(self.config.project_root), executable="/bin/bash")
            out = (proc.stdout + proc.stderr).strip()
            self.console.print(out or f"[dim](exit {proc.returncode}, no output)[/dim]")
        except subprocess.TimeoutExpired:
            self.ui.error("command timed out")

    # ---------------------------------------------------------------- loop ---
    def repl(self) -> None:
        self.banner()
        USER_HOME.mkdir(parents=True, exist_ok=True)
        session: PromptSession = PromptSession(history=FileHistory(str(USER_HOME / "history")))
        from prompt_toolkit.formatted_text import ANSI
        queue: list[str] = []
        while True:
            mode = self.agent.mode
            th = style_mod.theme()
            acc, dim, rst = style_mod.ansi_fg(th.accent), style_mod.ansi_fg(th.faint), style_mod.ANSI_RESET
            if queue:                                   # run a follow-up queued during the last turn
                line = queue.pop(0)
                self.console.print(f"  [{DIM}]{glyphs.ARROW} {line}[/]", highlight=False)
            else:
                try:                                    # ❯ prefix + right-aligned `model · mode`
                    rp = ANSI(f"{dim}{self.config.model}  {glyphs.MIDDOT}  {mode}{rst}")
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
                    path = memory_mod.add_memory(line[1:], self.config.project_root)
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

        def work() -> None:
            try:
                self.agent.run_turn(text)
            except Exception as e:
                self.ui.error(f"{type(e).__name__}: {e}")
            finally:
                self.ui.stop_working()
                done.set()

        threading.Thread(target=work, daemon=True).start()

        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            done.wait()
            self.ui.turn_complete(time.time() - t0, self.agent.cancelled.is_set())
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
                        self.console.print(f"[dim]↵ queued: {buf.strip()[:70]}[/dim]", highlight=False)
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
        self.ui.turn_complete(time.time() - t0, self.agent.cancelled.is_set())


def run_doctor(config: Config) -> None:
    """`dgc doctor` — verify the endpoint is reachable and the model is available."""
    from .llm import LLMClient
    c = Console()
    c.print("[bold]DGC doctor[/bold] — checking your setup\n")
    c.print(f"  endpoint      {config.base_url}")
    c.print(f"  model         {config.model}")
    c.print(f"  mode          {config.data.get('mode', 'default')}")
    c.print(f"  context_size  {config.get('context_size')}")
    c.print(f"  config file   {USER_CONFIG}\n")
    client = LLMClient(config.base_url, config.api_key, config.model)
    try:
        models = client.list_models()
    except Exception as e:
        c.print(f"  [bold red]✗[/bold red] cannot reach {config.base_url} — {type(e).__name__}: {e}")
        c.print("    → start your server (ollama serve / llama-server / LM Studio) or fix the URL & key")
        c.print("    → run [bold]dgc setup[/bold] to reconfigure")
        return
    c.print(f"  [green]✓[/green] endpoint reachable — {len(models)} model(s) offered")
    if config.model in models:
        c.print(f"  [green]✓[/green] model '{config.model}' is available")
    else:
        c.print(f"  [yellow]![/yellow] model '{config.model}' not offered by this server")
        if models:
            shown = ", ".join(models[:12]) + ("…" if len(models) > 12 else "")
            c.print(f"    available: {shown}")
        c.print("    → set one: [bold]dgc --model <name>[/bold]  or  [bold]dgc setup[/bold]")
    c.print("\n  [bold green]ready[/bold green] — run [bold]dgc[/bold] to start.\n")


def run_setup(config: Config) -> None:
    """`dgc setup` — interactive first-run wizard: pick a provider, key, model, context."""
    from .llm import LLMClient
    c = Console()
    c.print("\n[bold]DGC setup[/bold] — point DGC at a model you run\n")
    from .menu import select
    keys = list(PROVIDERS)
    prov_labels = [PROVIDERS[k]["label"] for k in keys] + ["custom endpoint (enter your own URL)"]
    prov_hints = [PROVIDERS[k]["base_url"] for k in keys] + [""]
    idx = select("Provider", prov_labels, prov_hints)
    if idx is None:
        c.print("[dim]cancelled[/dim]"); return
    if idx < len(keys):
        prov = PROVIDERS[keys[idx]]
        base_url, api_key = prov["base_url"], prov["api_key"]
        if prov["needs_key"]:
            api_key = input(f"  API key for {prov['label']} › ").strip() or api_key
    else:
        base_url = input("  base URL (…/v1) › ").strip()
        if not base_url:
            c.print("[dim]cancelled[/dim]"); return
        api_key = input("  API key (blank for local) › ").strip() or "sk-local"
    config.set("base_url", base_url)
    config.set("api_key", api_key)
    client = LLMClient(config.base_url, config.api_key, config.model)
    try:
        models = client.list_models()
    except Exception as e:
        c.print(f"  [yellow]couldn't list models[/yellow] ({type(e).__name__}) — set one by name below.")
        models = []
    if models:
        mi = select("Model", models[:60])
        if mi is not None:
            config.set("model", models[mi])
    else:
        m = input(f"  model name [{config.model}] › ").strip()
        if m:
            config.set("model", m)
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
        config.set("search_api_key", input(f"  API key for {meta['label']} › ").strip())
    if meta["needs_url"]:
        config.set("search_url", input(f"  base URL for {meta['label']} › ").strip())
    c.print(f"\n  [bold green]saved[/bold green] → {USER_CONFIG}")
    c.print(f"  endpoint {config.base_url}  ·  model {config.model}  ·  context {config.get('context_size')}  ·  search {config.get('search_provider')}")
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
    c.print("  dgc --model N --base-url URL --api-key KEY   set + persist a model\n")
    render_help(c)


def main(argv: list[str] | None = None) -> None:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    if raw_argv and raw_argv[0] in ("setup", "doctor", "help", "update", "serve", "acp", "bug"):
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
        cfg = Config()
        (run_setup if raw_argv[0] == "setup" else run_doctor)(cfg)
        return

    parser = argparse.ArgumentParser(
        prog="dgc", description="DGC — a coding-agent CLI for the models you run",
        epilog="commands: dgc setup · dgc doctor · dgc help · dgc (interactive) · dgc -p '<task>' (one-shot)")
    parser.add_argument("-p", "--prompt", help="run a single prompt non-interactively and exit")
    parser.add_argument("--mode", choices=MODES, help="permission mode for this session")
    parser.add_argument("--think", choices=THINK_LEVELS, help="thinking level for this session")
    parser.add_argument("--model", help="model name (persisted)")
    parser.add_argument("--base-url", help="OpenAI-compatible endpoint URL (persisted)")
    parser.add_argument("--api-key", help="API key for the endpoint (persisted)")
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
    if args.api_key:
        config.set("api_key", args.api_key)
    if args.model:
        config.set("model", args.model)
    if args.mode:
        config.data["mode"] = args.mode
    if args.think:
        config.data["thinking"] = args.think

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
        items = sessions_mod.listing(config.project_root)
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
        if config.data.get("mode") == "auto":
            print("⚠ auto mode: DGC will run every command and file write with no approval.", file=sys.stderr)
        cli.agent.run_turn(cli.expand_mentions(args.prompt))
        cli.ui.end_stream()
        print()
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
            if args.classic or not sys.stdout.isatty():
                cli.repl()
            else:
                from .tui import TUI
                TUI(config, agent=cli.agent).run()
        finally:
            termbg.reset()
            _print_resume_hint(cli.agent, config)   # after the alt-screen is restored — no blank lines


def _print_resume_hint(agent, config) -> None:
    """epilogue printed to the normal screen after the full-screen app exits:
        Resume this session with:
          dgc --resume <id>
    Only when a real conversation happened, so a glance-and-quit leaves nothing behind."""
    sf = getattr(agent, "session_file", None)
    if not sf or len([m for m in getattr(agent, "messages", []) if m.get("role") != "system"]) < 2:
        return
    name = None
    try:
        name = sessions_mod.name_of(sf)
    except Exception:
        pass
    sys.stdout.write("\nResume this session with:\n")
    sys.stdout.write(f"  dgc --resume {sf.stem}" + (f"   ({name})" if name else "") + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
