"""The agent loop: system prompt assembly, tool-use iterations, compaction,
thinking levels, and plan-mode orchestration."""
from __future__ import annotations

import json
import platform
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .checkpoints import CheckpointManager
from .config import Config
from .hooks import run_hooks
from .llm import LLMClient, LLMError, ToolCall
from .memory import load_memories
from .permissions import ALLOW, ASK, DENY, MODE_DESCRIPTIONS, PermissionEngine
from .agents import discover_agents
from .mcp import MCPManager
from .skills import discover_skills

_LOOP_SOFT = 3          # identical (name,args) calls before we refuse + warn the model
_LOOP_HARD = 6          # identical calls before we abort the turn outright
_MAX_CONTINUE = 3       # length-truncation auto-continues per turn
_MAX_TODO_GATE = 2      # times we push the model to finish open todos before letting it stop
_MAX_TOOL_OUT = 30000   # hard ceiling on any tool result fed back (esp. chatty MCP tools)


def _clamp(s: str, limit: int = _MAX_TOOL_OUT) -> str:
    """Head+tail truncation so a single huge tool result can't blow the context window."""
    if len(s) <= limit:
        return s
    head, tail = limit * 2 // 3, limit // 3
    return f"{s[:head]}\n… [output clamped: {len(s) - limit} chars omitted] …\n{s[-tail:]}"
from .tools import TOOL_SCHEMAS, execute

THINK_LEVELS = ("off", "low", "medium", "high")
THINK_INSTRUCTIONS = {
    "off": "",
    "low": "Think briefly before acting; keep your reasoning short and focused.",
    "medium": "Reason step by step before acting. Consider edge cases and how your changes affect the rest of the system.",
    "high": ("Engage maximum reasoning depth (ultrathink). Analyze the problem thoroughly, "
             "explore alternative approaches, verify assumptions against the actual code, "
             "and double-check every action before taking it."),
}
# prompt keywords bump the thinking level for that turn (Claude Code style)
THINK_KEYWORDS = [
    ("ultrathink", "high"), ("think harder", "high"),
    ("think hard", "medium"), ("think", "low"),
]

COMPACT_THRESHOLD = 0.85  # fraction of context_size (override per-config with compact_threshold)
KEEP_RECENT = 6           # messages preserved verbatim on compaction


@dataclass
class AgentContext:
    project_root: Path
    config: Config
    skills: dict = field(default_factory=dict)
    todos: list = field(default_factory=list)
    on_todo: object = None


class _SubUI:
    """Transparent UI wrapper for a sub-agent: forwards all I/O to the parent UI (so the
    user sees the sub-agent's work and answers its prompts) while capturing the sub-agent's
    final text as the task result."""

    def __init__(self, parent, label: str):
        self._parent = parent
        self._label = label
        self._buf: list[str] = []
        self._last = ""

    def on_text(self, chunk):
        self._buf.append(chunk)
        self._parent.on_text(chunk)

    def on_thinking(self, chunk):
        self._parent.on_thinking(chunk)

    def end_stream(self):
        if self._buf:
            self._last = "".join(self._buf)
            self._buf = []
        self._parent.end_stream()

    def tool_call(self, name, args):
        self._parent.tool_call(name, args)

    def tool_result(self, name, out):
        self._parent.tool_result(name, out)

    def tool_denied(self, name, args, reason):
        self._parent.tool_denied(name, args, reason)

    def approve(self, name, args):
        return self._parent.approve(name, args)

    def add_permission_rule(self, name, args):
        self._parent.add_permission_rule(name, args)

    def present_plan(self, plan):
        return self._parent.present_plan(plan)

    def propose_options(self, question, options):
        return self._parent.propose_options(question, options)

    def on_todo(self, todos):
        self._parent.on_todo(todos)

    def info(self, msg):
        self._parent.info(msg)

    def error(self, msg):
        self._parent.error(msg)

    @property
    def _live(self):
        return getattr(self._parent, "_live", None)

    def result(self) -> str:
        return (self._last or "".join(self._buf)).strip()


class Agent:
    def __init__(self, config: Config, ui, mcp: MCPManager | None = None):
        self.config = config
        self.ui = ui
        self.client = LLMClient(config.base_url, config.api_key, config.model, read_timeout=int(config.get("request_timeout", 1800)))
        self.skills = discover_skills(config.project_root)
        if mcp is not None:                       # subagents share the parent's MCP servers
            self.mcp = mcp
        else:
            self.mcp = MCPManager()
            self.mcp.connect_all(config.get("mcp_servers"))
        self.todos: list = []
        self.plan_return_mode: str | None = None
        self.ctx = AgentContext(project_root=config.project_root, config=config,
                                skills=self.skills, todos=self.todos,
                                on_todo=getattr(ui, "on_todo", None))
        self.messages: list[dict] = []
        self.session_file = None  # set by the CLI for --continue/--resume/new-session persistence
        self.session_name = None  # optional user-given name for the current session
        self.cancelled = threading.Event()  # a headless front-end sets this to interrupt the turn
        from collections import deque
        self.steer_queue: deque = deque()    # mid-turn user messages, injected into the running turn
        self.depth = 0                       # sub-agent nesting depth (via the task tool)
        self.checkpoints = CheckpointManager()
        self._pending_images: list | None = None  # data: URIs attached to the next prompt
        self.agent_defs = discover_agents(config.project_root)  # named sub-agent personas/hosts
        self._effort_override: str | None = None  # a sub-agent may pin its own thinking level
        self.reset()

    # ------------------------------------------------------------ setup ---
    def refresh_client(self) -> None:
        self.client = LLMClient(self.config.base_url, self.config.api_key, self.config.model, read_timeout=int(self.config.get("request_timeout", 1800)))

    def _tool_schemas(self) -> list[dict]:
        """Built-in tools plus any tools from connected MCP servers."""
        return TOOL_SCHEMAS + self.mcp.tool_schemas()

    def _chat(self, tools, effort):
        return self.client.chat(self.messages, tools=tools, reasoning_effort=effort,
                                on_text=self.ui.on_text, on_thinking=self.ui.on_thinking,
                                cancel=self.cancelled)

    @property
    def mode(self) -> str:
        return self.config.data.get("mode", "default")

    def set_mode(self, mode: str) -> None:
        if mode == "plan" and self.mode != "plan":
            self.plan_return_mode = self.mode
        self.config.set("mode", mode)    # persisted — restarts keep your last mode
        self._refresh_system()

    def exit_plan(self, to_mode: str | None = None) -> str:
        target = to_mode or self.plan_return_mode or "default"
        self.plan_return_mode = None
        self.set_mode(target)
        return target

    def reset(self) -> None:
        self.messages = [{"role": "system", "content": self.system_prompt()}]
        self.todos.clear()
        self.session_name = None

    def _refresh_system(self) -> None:
        if self.messages and self.messages[0]["role"] == "system":
            self.messages[0]["content"] = self.system_prompt()

    # ------------------------------------------------------ system prompt ---
    def system_prompt(self) -> str:
        cfg = self.config
        parts = [
            "You are DGC, an interactive coding-agent CLI running on the user's machine, "
            "powered by a local LLM. You help with software engineering tasks by taking real "
            "action with your tools — reading, writing and editing files, running shell commands — "
            "not by just describing solutions.",
            "",
            "# Environment",
            f"- Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            f"- OS: {platform.system()} {platform.release()}",
            f"- Project root (cwd for all tools): {cfg.project_root}",
            f"- Model: {cfg.model} @ {cfg.base_url}",
            "",
            "# How to work",
            "- Use tools to act. Never print code in chat as a substitute for writing it to a file.",
            "- Read a file before editing it. Make minimal, focused changes.",
            "- For multi-step work, keep a todo list with the todo tool.",
            "- Verify changes: run tests/builds when they exist. Don't claim done what you didn't verify.",
            "- Keep the running commentary between tool calls short — the user sees your tool calls "
            "and results directly.",
            "- ALWAYS finish a turn with a clear final response (normal text, NOT the thinking channel): "
            "a short summary of what you did, the outcome, files you changed, and anything the user "
            "should know or do next. Never end a turn with only tool calls and no closing message.",
        ]

        mode = self.mode
        parts += ["", f"# Permission mode: {mode}", MODE_DESCRIPTIONS[mode]]
        if mode == "plan":
            parts += [
                "",
                "PLAN MODE IS ACTIVE — you are READ-ONLY.",
                "- You may only use read_file, glob, grep, web_fetch, todo and skill.",
                "- write_file, edit_file and bash will be DENIED.",
                "- Research the codebase thoroughly, then call present_plan with a concrete, "
                "step-by-step implementation plan (real files, functions, commands).",
                "- Do not present a plan before you understand the relevant code.",
            ]
        elif mode == "auto":
            parts += [
                "",
                "FULL-AUTO MODE: your tool calls are auto-approved. Work autonomously and keep "
                "going until the task is completely done and verified. Do not stop early to ask "
                "questions you can answer yourself with tools.",
            ]

        if mode != "plan":
            parts += [
                "",
                "# Building things to look at (artifacts)",
                "- When what you build is meant to be SEEN — a web page, a small web app, a chart, a "
                "visual report — finish by calling the `artifact` tool on the file or folder. It serves "
                "the result on a local URL and DGC offers to open it in the user's browser. Prefer this "
                "over telling the user to open a file by hand.",
                "- Hold artifact frontends to a high visual bar. Before you build one, load the "
                "`dgc-design` skill (via the skill tool) for DGC's design language and follow it: "
                "Inter + JetBrains Mono, a near-black canvas, a single purple accent, clean type "
                "hierarchy, generous spacing, no clutter.",
                "- Make artifacts self-contained — inline the CSS/JS, no build step, no CDN needed — "
                "so they run straight from disk.",
            ]

        think = THINK_INSTRUCTIONS.get(self._effective_thinking(""), "")
        if think:
            parts += ["", "# Reasoning", think]

        project_mem, user_mem = load_memories(cfg.project_root)
        agents_md = cfg.project_root / "AGENTS.md"
        # only adopt AGENTS.md as project memory in a real project dir — never the bare home dir,
        # where it may belong to a different agent (Codex, another assistant) and hijack the session.
        if not project_mem and agents_md.exists() and cfg.project_root != Path.home():
            try:
                project_mem = agents_md.read_text().strip()
            except OSError:
                pass
        if project_mem or user_mem:
            parts += ["", "# Memory"]
            if project_mem:
                parts += ["## Project memory (DGC.md)", project_mem]
            if user_mem:
                parts += ["## User memory (~/.dgc/DGC.md)", user_mem]

        if self.skills:
            parts += ["", "# Skills",
                      "Reusable instruction packages. Invoke with the skill tool when one matches the task:"]
            parts += [f"- {s.name}: {s.description}" for s in self.skills.values()]

        if not self.client.tools_supported:
            parts += ["", self._text_protocol_section()]
        return "\n".join(parts)

    def _text_protocol_section(self) -> str:
        schemas = [{"name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "parameters": t["function"]["parameters"]}
                   for t in (TOOL_SCHEMAS + self.mcp.tool_schemas())]
        return (
            "# Tool protocol (IMPORTANT)\n"
            "This model endpoint has no native tool calling. To use a tool, emit a fenced block "
            "exactly like this (one tool per block):\n\n"
            "```tool_call\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"src/main.py\"}}\n```\n\n"
            "After you emit tool_call blocks, STOP and wait — the harness executes them and gives "
            "you the results in the next message. Do not write tool results yourself.\n"
            "Available tools:\n" + json.dumps(schemas, indent=1))

    # ------------------------------------------------------------ thinking ---
    def _effective_thinking(self, user_text: str) -> str:
        level = self._effort_override or self.config.get("thinking", "off")
        order = {name: i for i, name in enumerate(THINK_LEVELS)}
        lower = user_text.lower()
        for keyword, bumped in THINK_KEYWORDS:
            if keyword in lower and order[bumped] > order.get(level, 0):
                level = bumped
        return level

    def steer(self, text: str) -> None:
        """Queue a message the user typed WHILE a turn is running; it's injected at the next
        tool-loop boundary so the model reads it and adjusts (not a separate later turn)."""
        self.steer_queue.append(text)

    def _drain_steer(self) -> bool:
        """Fold any mid-turn user messages into the conversation. Returns True if it added any."""
        msgs = []
        while self.steer_queue:
            try:
                msgs.append(self.steer_queue.popleft())
            except IndexError:
                break
        joined = "\n".join(m for m in msgs if m and m.strip())
        if not joined:
            return False
        self.messages.append({"role": "user", "content":
            "<user-interjection>\nThe user sent this WHILE you were working. Read it and adjust "
            f"course now if it changes anything:\n{joined}\n</user-interjection>"})
        self.ui.info(f"↳ steering: {joined[:80]}")
        return True

    # ------------------------------------------------------------- main loop ---
    def run_turn(self, user_text: str) -> None:
        self.cancelled.clear()
        self.steer_queue.clear()            # drop any stale interjections from a prior turn
        try:
            self._run_turn(user_text)
        finally:
            self._persist()

    def _persist(self) -> None:
        if self.session_file:
            from . import sessions
            sessions.save(self.session_file, self.messages, self.config.project_root,
                          name=self.session_name)

    def name_session(self, name: str) -> None:
        """Give the current session a human name (shown in --resume / the session picker)."""
        self.session_name = name.strip() or None
        if self.session_file:
            from . import sessions
            if not self.session_file.exists():   # a brand-new session with no turns yet
                sessions.save(self.session_file, self.messages, self.config.project_root,
                              name=self.session_name)
            elif self.session_name:
                sessions.set_name(self.session_file, self.session_name)

    def generate_title(self, prompt: str) -> str | None:
        """A short, distinctive 5-10 word session title derived from the first prompt (Grok's
        session_summary.rs). Best-effort, no tools/thinking; returns None on any failure."""
        import re as _re
        sysmsg = ("You generate a session title: a short, distinctive 5-10 word descriptive title "
                  "for a software-engineering session. Super info-dense, no filler, no quotes, no "
                  "trailing punctuation. Output ONLY the title.")
        msgs = [{"role": "system", "content": sysmsg},
                {"role": "user", "content": f"<user_query>{str(prompt)[:2000]}</user_query>"}]
        try:
            res = self.client.chat(msgs, tools=None, reasoning_effort="off")
        except Exception:
            return None
        title = (getattr(res, "content", "") or "").strip()
        title = (title.splitlines()[0] if title else "").strip().strip('"').strip("'")
        title = _re.sub(r"\s+", " ", title).strip()[:60]
        return title or None

    def suggest_next(self, user_prompt: str, assistant_response: str) -> str | None:
        """Predict ONE plausible next prompt the user might type (Grok's ghost-text). Best-effort,
        cheap (no tools/thinking); returns None on failure."""
        import re as _re
        sysmsg = ("Given the last exchange in a coding session, predict ONE short, natural next prompt "
                  "the user is likely to type next. Output ONLY that prompt — imperative, under 12 words, "
                  "no quotes, no trailing punctuation.")
        ctx = f"User: {str(user_prompt)[:600]}\nAssistant: {str(assistant_response)[:800]}"
        try:
            res = self.client.chat([{"role": "system", "content": sysmsg},
                                    {"role": "user", "content": ctx}], tools=None, reasoning_effort="off")
        except Exception:
            return None
        s = (getattr(res, "content", "") or "").strip().splitlines()
        s = (s[0] if s else "").strip().strip('"').strip("'").rstrip(".")
        s = _re.sub(r"\s+", " ", s)[:120]
        return s or None

    def load_session(self, path) -> int:
        """Restore a saved conversation, keeping a fresh system prompt. Returns restored msg count."""
        from . import sessions
        loaded = [m for m in sessions.load(path) if m.get("role") != "system"]
        self.messages = [{"role": "system", "content": self.system_prompt()}] + loaded
        self.session_file = path
        self.session_name = sessions.name_of(path)
        return len(loaded)

    def _run_turn(self, user_text: str) -> None:
        self._refresh_system()
        if self.depth == 0:                        # checkpoints + prompt hooks: top-level only
            blocked, hout = run_hooks("UserPromptSubmit", {"prompt": user_text},
                                      self.config, self.config.project_root)
            if blocked:
                self.ui.error(f"prompt blocked by a UserPromptSubmit hook: {hout}")
                return
            self.checkpoints.open(len(self.messages), user_text)
        images = self._pending_images
        self._pending_images = None
        if images:                                 # vision: OpenAI-style multimodal content
            content: object = ([{"type": "text", "text": user_text}] +
                               [{"type": "image_url", "image_url": {"url": u}} for u in images])
        else:
            content = user_text
        self.messages.append({"role": "user", "content": content})
        thinking = self._effective_thinking(user_text)
        effort = thinking if thinking != "off" else None
        max_turns = int(self.config.get("max_turns", 40))
        sig_count: dict = {}        # (name, args) → times seen this turn — doom-loop detection
        continues = 0               # length-truncation auto-continues used this turn
        mutating_total = 0          # edits/bash this turn — drives the TodoGate nudge
        todo_nudged = False         # so the "make a todo list" nudge fires at most once
        todo_gate = 0               # times we've refused to end the turn with open todos
        did_tools = False           # did the model actually call any tools this turn?
        summary_nudged = False      # so the "give a closing summary" nudge fires at most once

        for _ in range(max_turns):
            if self.cancelled.is_set():
                self.ui.info("turn cancelled")
                return
            self._drain_steer()             # inject anything the user typed mid-turn
            self.maybe_compact()
            tools = self._tool_schemas() if self.client.tools_supported else None
            try:
                result = self._chat(tools, effort)
            except LLMError as e:
                fb = str(self.config.get("fallback_model") or "")
                if fb and fb != self.client.model:      # retry the turn on a fallback model
                    self.ui.info(f"⤳ primary model failed; falling back to {fb}")
                    self.client = LLMClient(self.config.get("fallback_base_url") or self.config.base_url,
                                            self.config.api_key, fb)
                    try:
                        result = self._chat(tools, effort)
                    except LLMError as e2:
                        self.ui.end_stream()
                        self.ui.error(f"fallback model also failed: {e2}")
                        return
                else:
                    self.ui.end_stream()
                    self.ui.error(str(e))
                    return
            self.ui.end_stream()

            native = bool(result.tool_calls) and not result.tool_calls[0].id.startswith("textcall_")
            assistant: dict = {"role": "assistant", "content": result.content}
            if native:
                assistant["tool_calls"] = [
                    {"id": c.id, "type": "function",
                     "function": {"name": c.name, "arguments": json.dumps(c.arguments)}}
                    for c in result.tool_calls]
            self.messages.append(assistant)

            if not result.tool_calls:
                if result.finish_reason == "length" and continues < _MAX_CONTINUE:
                    continues += 1              # reply cut off at the token limit — continue it
                    self.messages.append({"role": "user", "content":
                        "Your previous response was cut off at the length limit. Continue exactly "
                        "where you left off — do not repeat what you already wrote."})
                    continue
                pending = [t for t in self.ctx.todos if t.get("status") != "done"]
                if pending and todo_gate < _MAX_TODO_GATE:     # TodoGate: don't stop mid-plan
                    todo_gate += 1
                    self.messages.append({"role": "user", "content":
                        "<system-reminder>\nYou're stopping but these todos are still open: "
                        + "; ".join(t["content"] for t in pending[:8]) + ". Finish them now (make the "
                        "edits / run the commands) and mark each done with the `todo` tool — or, if a "
                        "todo genuinely can't be done, say why. Do not stop with silent open todos.\n"
                        "</system-reminder>"})
                    continue
                if did_tools and not (result.content or "").strip() and not summary_nudged:
                    summary_nudged = True   # did real work but gave no closing message → ask for one
                    self.messages.append({"role": "user", "content":
                        "<system-reminder>\nYou did work this turn but ended without any message to the "
                        "user. Give a brief final summary now — what you changed, the outcome, and any "
                        "next step — as a normal reply, not in the thinking channel.\n</system-reminder>"})
                    continue
                if self._drain_steer():     # user interjected as we were about to finish → keep going
                    continue
                return

            did_tools = True                # the model called tools → expect a closing summary
            text_results: list[str] = []
            for call in result.tool_calls:
                if self.cancelled.is_set():     # honour a mid-batch cancel between tool calls
                    self.ui.info("turn cancelled")
                    return
                sig = (call.name, json.dumps(call.arguments, sort_keys=True, default=str))
                seen = sig_count[sig] = sig_count.get(sig, 0) + 1
                if seen > _LOOP_HARD:
                    self.ui.error("stopped — the model is stuck repeating the same tool call")
                    return
                if seen > _LOOP_SOFT:           # refuse the repeat and tell the model it's looping
                    out = ("error: you have already made this exact tool call "
                           f"{seen - 1} times with identical arguments and got the same result. "
                           "This is a loop — do NOT call it again. Take a different approach, or if "
                           "the task is done, give your final answer.")
                    self.ui.info(f"↻ loop guard: blocked a repeated {call.name} call")
                else:
                    out = self._handle_call(call)
                if native:
                    self.messages.append({"role": "tool", "tool_call_id": call.id, "content": out})
                else:
                    text_results.append(f"<result tool=\"{call.name}\">\n{out}\n</result>")
            if text_results:
                self.messages.append({"role": "user",
                                      "content": "<tool_results>\n" + "\n".join(text_results) + "\n</tool_results>"})

            # keep flaky local models on track: nudge a todo list on multi-step work, and
            # re-surface still-pending todos so they don't get dropped mid-task.
            mutating_total += sum(1 for c in result.tool_calls
                                  if c.name in ("write_file", "edit_file", "bash"))
            reminders: list[str] = []
            if mutating_total >= 3 and not self.ctx.todos and not todo_nudged:
                todo_nudged = True
                reminders.append("You've made several edits without a plan. For a multi-step task, "
                                 "use the `todo` tool to list the steps and mark each done as you go.")
            pending = [t for t in self.ctx.todos if t.get("status") != "done"]
            if pending and not any(c.name == "todo" for c in result.tool_calls):
                reminders.append("Still pending: " + "; ".join(t["content"] for t in pending[:6])
                                 + " — advance these and mark each done with the `todo` tool.")
            if reminders:
                note = "<system-reminder>\n" + "\n".join(reminders) + "\n</system-reminder>"
                if self.messages and self.messages[-1]["role"] == "user":   # fold into <tool_results>
                    self.messages[-1]["content"] = f"{self.messages[-1]['content']}\n{note}"
                else:                                                        # native: separate turn
                    self.messages.append({"role": "user", "content": note})
        self.ui.error(f"stopped after {max_turns} tool iterations (max_turns) — say 'continue' to keep going")

    def _handle_call(self, call: ToolCall) -> str:
        name, args = call.name, call.arguments

        if name == "present_plan":
            plan = str(args.get("plan", ""))
            if self.session_file and plan:              # persist it (Grok's plan.md) → /view-plan reopens
                from . import sessions
                sessions.save_plan(self.session_file, plan)
            choice = self.ui.present_plan(plan)
            if choice is None:
                return "Plan NOT approved — the user wants to keep planning. Address their feedback and revise."
            target = self.exit_plan(choice)
            return f"Plan APPROVED. Plan mode exited; permission mode is now '{target}'. Execute the plan now."

        if name == "propose_options":
            question = str(args.get("question", ""))
            options = [str(o) for o in (args.get("options") or [])]
            if not options:
                return "No options were provided. Ask a normal question or make the call yourself."
            choice = self.ui.propose_options(question, options)
            return f"The user chose: {choice!r}. Continue with that decision."

        if name == "task":
            if self.depth >= 3:
                return "Max sub-agent depth reached — handle this sub-task directly instead."
            return self._run_subagent(str(args.get("description", "")), str(args.get("prompt", "")),
                                      str(args.get("agent", "")))

        if name == "artifact":
            if self.mode == "plan":
                return "Plan mode is read-only — don't start a preview yet. Describe it in the plan instead."
            from . import artifacts
            try:
                art = artifacts.serve(str(args.get("path", "")), self.config.project_root,
                                      str(args.get("name", "") or ""))
            except Exception as e:
                return f"error: could not start the artifact preview: {type(e).__name__}: {e}"
            notify = getattr(self.ui, "artifact_ready", None)
            if notify:
                notify(art)                          # the TUI proposes opening it in the terminal
            return (f"Artifact '{art.name}' is live at {art.url} (serving {art.rel}). "
                    f"Tell the user they can open that URL in a browser; '/artifact' lists and stops "
                    f"running previews. Do NOT start another server for the same thing.")

        perms = PermissionEngine(self.mode, self.config.permissions)  # fresh: mode may have just changed
        decision, reason = perms.decide(name, args)
        if decision == DENY:
            self.ui.tool_denied(name, args, reason)
            return f"PERMISSION DENIED: {reason}. Do not retry this exact action."
        if decision == ASK and name == "bash":
            from . import sandbox
            if sandbox.active(self.config):      # confined to project + /tmp → auto-approve
                decision = ALLOW
        if decision == ASK:
            verdict = self.ui.approve(name, args)
            if verdict == "no":
                reason = getattr(self.ui, "deny_reason", "") or ""
                if hasattr(self.ui, "deny_reason"):
                    self.ui.deny_reason = ""          # consume it
                if reason:
                    return (f"The user DENIED this action and said: \"{reason}\". Follow that "
                            "guidance instead; do not retry the denied action.")
                return "The user DENIED this action. Do not retry it; ask how to proceed or move on."
            if verdict == "always":
                self.ui.add_permission_rule(name, args)

        if name in ("write_file", "edit_file") and args.get("path"):
            raw = str(args["path"])
            abs_path = raw if Path(raw).is_absolute() else str(self.config.project_root / raw)
            self.checkpoints.record_file(abs_path)     # snapshot before the edit, for rewind
        blocked, hout = run_hooks("PreToolUse", {"tool": name, "args": args},
                                  self.config, self.config.project_root)
        if blocked:
            self.ui.tool_denied(name, args, "PreToolUse hook")
            return f"BLOCKED by a PreToolUse hook: {hout or '(no output)'}. Do not retry this exact action."
        self.ui.tool_call(name, args)
        out = self.mcp.call(name, args) if name.startswith("mcp__") else execute(name, args, self.ctx)
        out = _clamp(out)                      # central ceiling — MCP + any future tool inherit it
        _, post = run_hooks("PostToolUse", {"tool": name, "args": args, "result": out[:2000]},
                            self.config, self.config.project_root)
        if post:
            out = f"{out}\n[hook] {post}"
        self.ui.tool_result(name, out)
        return out

    def rewind(self, idx: int) -> tuple[int, int]:
        """Restore code + conversation to checkpoint `idx`. Returns (msgs_kept, files_restored)."""
        msg_count, n_files = self.checkpoints.rewind(idx)
        if msg_count >= 0:
            self.messages = self.messages[:msg_count]
        return msg_count, n_files

    def _subagent_client(self, adef):
        """Resolve a sub-agent's (base_url, api_key, model): per-agent def → global
        subagent_* config → inherit the main loop. Returns None to reuse the parent client."""
        cfg = self.config
        base = (adef.base_url if adef else "") or cfg.get("subagent_base_url") or cfg.base_url
        key = (adef.api_key if adef else "") or cfg.get("subagent_api_key") or cfg.api_key
        model = (adef.model if adef else "") or cfg.get("subagent_model") or cfg.model
        base = base.rstrip("/")
        if (base, key, model) == (cfg.base_url, cfg.api_key, cfg.model):
            return None
        return LLMClient(base, key, model)

    def _run_subagent(self, description: str, prompt: str, agent_name: str = "") -> str:
        adef = self.agent_defs.get(agent_name) if agent_name else None
        tag = f" [{agent_name}]" if adef else (f" [{agent_name}?]" if agent_name else "")
        self.ui.info(f"⟳ sub-task: {description}{tag}")
        sub_ui = _SubUI(self.ui, description)
        sub = Agent(self.config, sub_ui, mcp=self.mcp)   # fresh context, shared config + MCP servers
        sub.depth = self.depth + 1
        override = self._subagent_client(adef)
        if override is not None:
            sub.client = override                         # its own model/host
        if adef and adef.effort:
            sub._effort_override = adef.effort
        task_prompt = (adef.body + "\n\n---\n\nTask: " + prompt) if (adef and adef.body) else prompt
        try:
            sub.run_turn(task_prompt)
        except Exception as e:
            return f"Sub-task '{description}' failed: {type(e).__name__}: {e}"
        result = sub_ui.result() or "(the sub-agent finished but produced no summary text)"
        return f"Sub-task '{description}' completed. Summary:\n{result}"

    # ---------------------------------------------------------- compaction ---
    def estimate_tokens(self) -> int:
        return sum(len(json.dumps(m, default=str)) for m in self.messages) // 4

    def _mechanical_prune(self) -> bool:
        """Tier-1 context relief (no LLM): cap stale tool-result bodies so a few huge outputs
        can't dominate the window. Protects the system message and the most-recent quarter of
        the transcript (always at least KEEP_RECENT messages), and never touches assistant text."""
        n = len(self.messages)
        protect_from = max(1, n - max(KEEP_RECENT, n // 4))
        cap = 2000
        changed = False
        for i in range(1, protect_from):
            m = self.messages[i]
            content = m.get("content")
            if not isinstance(content, str) or len(content) <= cap:
                continue
            if m.get("role") == "tool":
                m["content"] = content[:cap] + f"\n… [older tool output pruned: {len(content) - cap} chars]"
                changed = True
            elif m.get("role") == "user" and content.startswith("<tool_results>"):
                m["content"] = content[:cap] + "\n… [older tool output pruned] …\n</tool_results>"
                changed = True
        return changed

    def maybe_compact(self, force: bool = False) -> None:
        budget = int(self.config.get("context_size", 32768)) * float(self.config.get("compact_threshold", COMPACT_THRESHOLD))
        if not force and self.estimate_tokens() < budget:
            return
        # Tier 1: prune stale tool outputs first — often enough, and far cheaper than an LLM summary.
        if self._mechanical_prune() and not force and self.estimate_tokens() < budget:
            self.ui.info("context pruned")
            return
        if len(self.messages) < KEEP_RECENT + 3:
            return
        middle = self.messages[1:-KEEP_RECENT]
        transcript_lines = []
        for m in middle:
            role = m.get("role", "?")
            content = str(m.get("content", ""))[:1500]
            calls = ""
            if m.get("tool_calls"):
                calls = " [tools: " + ", ".join(c["function"]["name"] for c in m["tool_calls"]) + "]"
            transcript_lines.append(f"{role}{calls}: {content}")
        prompt = ("Summarize this coding-session transcript into a compact brief for the agent to "
                  "continue working: what was asked, what was done (files touched, commands run), "
                  "key decisions, and what remains. Be terse, use bullets.\n\n" + "\n\n".join(transcript_lines))
        try:
            result = self.client.chat([{"role": "user", "content": prompt}])
            summary = result.content or "(summary unavailable)"
        except LLMError:
            summary = "(compaction failed; earlier context dropped)"
        self.messages = (
            [self.messages[0],
             {"role": "user", "content": f"[Earlier conversation compacted to this summary]\n{summary}"},
             {"role": "assistant", "content": "Understood — I have the context summary and will continue from it."}]
            + self.messages[-KEEP_RECENT:])
        self.ui.info("context compacted")
