"""The agent loop: system prompt assembly, tool-use iterations, compaction,
thinking levels, and plan-mode orchestration."""
from __future__ import annotations

import json
import platform
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .config import Config
from .llm import LLMClient, LLMError, ToolCall
from .memory import load_memories
from .permissions import ALLOW, ASK, DENY, MODE_DESCRIPTIONS, PermissionEngine
from .skills import discover_skills
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


class Agent:
    def __init__(self, config: Config, ui):
        self.config = config
        self.ui = ui
        self.client = LLMClient(config.base_url, config.api_key, config.model)
        self.skills = discover_skills(config.project_root)
        self.todos: list = []
        self.plan_return_mode: str | None = None
        self.ctx = AgentContext(project_root=config.project_root, config=config,
                                skills=self.skills, todos=self.todos,
                                on_todo=getattr(ui, "on_todo", None))
        self.messages: list[dict] = []
        self.session_file = None  # set by the CLI for --continue/--resume/new-session persistence
        self.cancelled = threading.Event()  # a headless front-end sets this to interrupt the turn
        self.reset()

    # ------------------------------------------------------------ setup ---
    def refresh_client(self) -> None:
        self.client = LLMClient(self.config.base_url, self.config.api_key, self.config.model)

    @property
    def mode(self) -> str:
        return self.config.data.get("mode", "default")

    def set_mode(self, mode: str) -> None:
        if mode == "plan" and self.mode != "plan":
            self.plan_return_mode = self.mode
        self.config.data["mode"] = mode  # session-only; not persisted
        self._refresh_system()

    def exit_plan(self, to_mode: str | None = None) -> str:
        target = to_mode or self.plan_return_mode or "default"
        self.plan_return_mode = None
        self.set_mode(target)
        return target

    def reset(self) -> None:
        self.messages = [{"role": "system", "content": self.system_prompt()}]
        self.todos.clear()

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
            "- Be concise in text replies; the user sees your tool calls and results directly.",
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
                    "parameters": t["function"]["parameters"]} for t in TOOL_SCHEMAS]
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
        level = self.config.get("thinking", "off")
        order = {name: i for i, name in enumerate(THINK_LEVELS)}
        lower = user_text.lower()
        for keyword, bumped in THINK_KEYWORDS:
            if keyword in lower and order[bumped] > order.get(level, 0):
                level = bumped
        return level

    # ------------------------------------------------------------- main loop ---
    def run_turn(self, user_text: str) -> None:
        self.cancelled.clear()
        try:
            self._run_turn(user_text)
        finally:
            self._persist()

    def _persist(self) -> None:
        if self.session_file:
            from . import sessions
            sessions.save(self.session_file, self.messages, self.config.project_root)

    def load_session(self, path) -> int:
        """Restore a saved conversation, keeping a fresh system prompt. Returns restored msg count."""
        from . import sessions
        loaded = [m for m in sessions.load(path) if m.get("role") != "system"]
        self.messages = [{"role": "system", "content": self.system_prompt()}] + loaded
        self.session_file = path
        return len(loaded)

    def _run_turn(self, user_text: str) -> None:
        self._refresh_system()
        self.messages.append({"role": "user", "content": user_text})
        thinking = self._effective_thinking(user_text)
        effort = thinking if thinking != "off" else None
        max_turns = int(self.config.get("max_turns", 40))

        for _ in range(max_turns):
            if self.cancelled.is_set():
                self.ui.info("turn cancelled")
                return
            self.maybe_compact()
            tools = TOOL_SCHEMAS if self.client.tools_supported else None
            try:
                result = self.client.chat(self.messages, tools=tools, reasoning_effort=effort,
                                          on_text=self.ui.on_text, on_thinking=self.ui.on_thinking)
            except LLMError as e:
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
                return

            text_results: list[str] = []
            for call in result.tool_calls:
                out = self._handle_call(call)
                if native:
                    self.messages.append({"role": "tool", "tool_call_id": call.id, "content": out})
                else:
                    text_results.append(f"<result tool=\"{call.name}\">\n{out}\n</result>")
            if text_results:
                self.messages.append({"role": "user",
                                      "content": "<tool_results>\n" + "\n".join(text_results) + "\n</tool_results>"})
        self.ui.error(f"stopped after {max_turns} tool iterations (max_turns) — say 'continue' to keep going")

    def _handle_call(self, call: ToolCall) -> str:
        name, args = call.name, call.arguments

        if name == "present_plan":
            plan = str(args.get("plan", ""))
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

        perms = PermissionEngine(self.mode, self.config.permissions)  # fresh: mode may have just changed
        decision, reason = perms.decide(name, args)
        if decision == DENY:
            self.ui.tool_denied(name, args, reason)
            return f"PERMISSION DENIED: {reason}. Do not retry this exact action."
        if decision == ASK:
            verdict = self.ui.approve(name, args)
            if verdict == "no":
                return "The user DENIED this action. Do not retry it; ask how to proceed or move on."
            if verdict == "always":
                self.ui.add_permission_rule(name, args)

        self.ui.tool_call(name, args)
        out = execute(name, args, self.ctx)
        self.ui.tool_result(name, out)
        return out

    # ---------------------------------------------------------- compaction ---
    def estimate_tokens(self) -> int:
        return sum(len(json.dumps(m, default=str)) for m in self.messages) // 4

    def maybe_compact(self, force: bool = False) -> None:
        budget = int(self.config.get("context_size", 32768)) * float(self.config.get("compact_threshold", COMPACT_THRESHOLD))
        if not force and self.estimate_tokens() < budget:
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
