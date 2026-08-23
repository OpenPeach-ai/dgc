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
_FAIL_SOFT = 4          # consecutive failing bash runs (no success) before we nudge a rethink
_FAIL_HARD = 7          # consecutive failing bash runs before we abort the turn (grind guard)
_EDIT_FAIL_SOFT = 3     # consecutive failing edit_file/multi_edit calls before we push write_file
_EDIT_FAIL_HARD = 6     # consecutive failing edits before we abort — a varied-arg edit grind that
#                         dodges the identical-call loop guard is DGC's #1 benchmark-timeout driver
# a passing command matching one of these = the work is likely verified → nudge the model to finish
# instead of re-running / refactoring working code (the "solved but kept going" waste)
_VERIFY_KWS = ("pytest", "go test", "cargo test", "npm test", "npm run test", "npx jest", "jest",
               "vitest", "gradlew test", "gradle test", "ctest", "make test", "unittest",
               "python -m pytest", "mocha", "rspec", "tox", "cmake --build", "cargo build")
_MAX_CONTINUE = 3       # length-truncation auto-continues per turn
_MAX_TODO_GATE = 2      # times we push the model to finish open todos before letting it stop
_MAX_TOOL_OUT = 30000   # hard ceiling on any tool result fed back (esp. chatty MCP tools)


def _sampling(cfg) -> dict:
    """Optional sampling knobs from config — only the ones the user actually set (else respect the
    server default). Lets a user tame a local model that loops/repeats. top_k is an int; the rest float."""
    out: dict = {}
    for k in ("temperature", "top_p", "top_k", "min_p"):
        v = cfg.get(k, "")
        if v == "" or v is None:
            continue
        try:
            out[k] = int(v) if k == "top_k" else float(v)
        except (TypeError, ValueError):
            pass
    return out


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
# prompt keywords bump the thinking level for that turn
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

    def __getattr__(self, name):
        # Forward anything not explicitly wrapped to the parent UI — so a sub-agent's deny reasons
        # (deny_reason), artifact cards (artifact_ready) and status flags behave like the main agent's,
        # instead of silently reading "" / None. (Only fires when normal lookup misses; the guard
        # below stops the instance's own attrs from recursing during partial init.)
        if name in ("_parent", "_label", "_buf", "_last"):
            raise AttributeError(name)
        return getattr(self._parent, name)

    def result(self) -> str:
        return (self._last or "".join(self._buf)).strip()


class Agent:
    def __init__(self, config: Config, ui, mcp: MCPManager | None = None):
        self.config = config
        self.ui = ui
        self.client = LLMClient(config.base_url, config.api_key, config.model,
                                read_timeout=int(config.get("request_timeout", 1800)),
                                think_budget_tokens=int(config.get("think_budget_tokens", 8000)),
                                max_tokens=int(config.get("max_tokens", 16384)),
                                ollama_keep_alive=str(config.get("ollama_keep_alive", "30m")),
                                sampling=_sampling(config))
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
        self.goal = ""            # standing /goal objective, kept in context until met/cleared
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
        self.client = LLMClient(self.config.base_url, self.config.api_key, self.config.model,
                                read_timeout=int(self.config.get("request_timeout", 1800)),
                                think_budget_tokens=int(self.config.get("think_budget_tokens", 8000)),
                                max_tokens=int(self.config.get("max_tokens", 16384)),
                                ollama_keep_alive=str(self.config.get("ollama_keep_alive", "30m")),
                                sampling=_sampling(self.config))

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
        self.goal = ""                                   # clear BEFORE building the prompt (no stale goal)
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
            "- Read a file before editing it. Make minimal, focused changes to EXISTING content.",
            "- Implementing a stub or writing a new/near-empty file? Write the whole file with "
            "write_file in one call — don't edit_file into an almost-empty file (that fails to match). "
            "Reserve edit_file for changing content that's already there.",
            "- For multi-step work, keep a todo list with the todo tool.",
            "- Verify changes: run tests/builds when they exist. Don't claim done what you didn't verify.",
            "- Keep the running commentary between tool calls short — the user sees your tool calls "
            "and results directly.",
            "- ALWAYS finish a turn with a clear final response (normal text, NOT the thinking channel): "
            "a short summary of what you did, the outcome, files you changed, and anything the user "
            "should know or do next. Never end a turn with only tool calls and no closing message.",
        ]

        goal = getattr(self, "goal", "")
        if goal:                              # a standing /goal — keep it in view every turn until met
            parts += [
                "",
                "# Standing goal",
                f"The user has set an overarching goal for this session:\n\n    {goal}\n",
                "Keep this goal in view and keep making progress toward it every turn. Don't stop while "
                "it's clearly unmet — take the next concrete step. When you believe it is fully met, say "
                "so plainly and summarize how it was achieved. If it's genuinely blocked, say what's "
                "blocking it rather than stopping silently.",
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
                ("- You may also SERVE a visual: your approved plan is shown as a live page automatically, "
                 "and you can call the `artifact` tool on an EXISTING .html file in the repo to preview it. "
                 "You still cannot write or edit project files — describe anything new in the plan itself."
                 if self.config.get("artifact_in_plan", False) else
                 "- Plan mode canNOT build or serve anything (no writing files, no `artifact` tool). "
                 "If the user asks to SEE something live / as an artifact / on a URL, say so plainly and "
                 "tell them to switch to build mode (Shift+Tab) — then you'll build it and serve it."),
            ]
        elif mode == "auto":
            parts += [
                "",
                "FULL-AUTO MODE: your tool calls are auto-approved. Work autonomously and keep "
                "going until the task is completely done and verified. Do not stop early to ask "
                "questions you can answer yourself with tools.",
            ]

        # Only carry the (heavy ~450-tok) artifact instructions when the artifact surface is actually
        # live — i.e. the shared server is set to autostart. A headless/scripted run with artifacts off
        # (e.g. the benchmark) never reaches them, so this reclaims per-turn prefill instead of re-sending
        # instructions that can't fire. Plan-mode opt-in still shows them when enabled.
        artifacts_live = bool(self.config.get("artifact_autostart", True))
        if (mode != "plan" and artifacts_live) or self.config.get("artifact_in_plan", False):
            parts += [
                "",
                "# Artifacts — how to SHOW the user a page (READ THIS CAREFULLY)",
                "An \"artifact\" is a live local web page that becomes real ONLY when you call the "
                "`artifact` tool. It does not exist on disk yet — there is nothing to search for. YOU make it.",
                "Trigger: the user says \"artifact\", \"show me\", \"preview\", \"dashboard\", \"page\", "
                "\"chart\", \"report\", \"live\", \"on a URL\", \"in the browser\", or otherwise asks to SEE "
                "a result. When that happens, do EXACTLY these steps, in order, using tools — do not just talk:",
                "  1. write_file — create a single self-contained index.html (inline ALL css and js; no "
                "build step, no CDN, no external files).",
                "  2. artifact — call the `artifact` tool with the path to that file. This call is the ONLY "
                "thing that serves the page. Example: artifact(path=\"index.html\", name=\"weather dashboard\").",
                "  3. Only AFTER the tool returns, tell the user the URL it gave back.",
                "HARD RULES (small models break these — obey them literally):",
                "- Describing the page is NOT building it. Writing \"I'm building a live weather dashboard "
                "served on http://127.0.0.1:...\" serves NOTHING. The page is live only after the `artifact` "
                "tool returns a URL.",
                "- You do not run a web server and you do not know the URL. NEVER type a 127.0.0.1 address "
                "yourself. If you are about to mention a localhost URL, STOP — that means you must call the "
                "`artifact` tool instead; the tool invents the real URL and hands it to you.",
                "- Never end your turn having only talked about the artifact. If you said you'd show "
                "something, the write_file + artifact tool calls MUST appear in the same turn.",
                "- Do not tell the user to open a file by hand, and do not start your own server with bash — "
                "DGC runs one shared server via the `artifact` tool and offers to open it.",
                "- Before building a frontend, load the `dgc-design` skill (skill tool) and follow it: "
                "Inter + JetBrains Mono, near-black canvas, one purple accent, clean hierarchy, generous "
                "spacing, no clutter.",
            ]

        think = THINK_INSTRUCTIONS.get(self._effective_thinking(""), "")
        if think:
            parts += ["", "# Reasoning", think]

        project_mem, user_mem = load_memories(cfg.project_root)
        agents_md = cfg.project_root / "AGENTS.md"
        # only adopt AGENTS.md as project memory in a real project dir — never the bare home dir,
        # where it may belong to a different agent (another assistant) and hijack the session.
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
        if self.depth == 0:                 # only a fresh top-level turn clears the cancel flag — a
            self.cancelled.clear()          #   sub-agent SHARES the parent's Event, so clearing it here
            #                                   would wipe a cancel that arrived during sub construction.
        self.steer_queue.clear()            # drop any stale interjections from a prior turn
        try:
            self._run_turn(user_text)
        finally:
            self._persist()

    def _persist(self) -> None:
        if self.session_file:
            from . import sessions
            sessions.save(self.session_file, self.messages, self.config.project_root,
                          name=self.session_name, goal=self.goal)

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
        """A short, distinctive 5-10 word session title derived from the first prompt (
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
        """Predict ONE plausible next prompt the user might type . Best-effort,
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
        self.session_file = path
        self.session_name = sessions.name_of(path)
        self.goal = sessions.goal_of(path)              # restore BEFORE building the prompt so the
        self.messages = [{"role": "system", "content": self.system_prompt()}] + loaded  # # Goal is in it
        return len(loaded)

    def set_goal(self, text: str) -> None:
        """Set (or clear, with '') the standing objective. Kept in context every turn until met/cleared."""
        self.goal = text.strip()
        self._refresh_system()                          # re-emit the system prompt with the # Goal section
        self._persist()

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
        # Pass the raw level; the client maps it to the right per-provider reasoning
        # shape (llm._reasoning_payload). "off" is handled correctly there — e.g. on
        # Ollama it becomes reasoning_effort:"none" (omitting would force thinking ON).
        effort = thinking
        max_turns = int(self.config.get("max_turns", 40))
        sig_count: dict = {}        # (name, args) → times seen this turn — doom-loop detection
        fail_streak = 0             # consecutive non-zero bash exits (no success) — grind guard
        fail_nudged = False
        verify_runs = 0             # E: verify_before_done attempts this turn (bounded)
        last_fail_fp = None         # fingerprint of the last failing bash output
        same_fail = 0               # consecutive failures with the SAME fingerprint (stuck signal)
        edit_fail_streak = 0        # consecutive failing edit_file/multi_edit calls (write_file steer)
        edit_grind_nudged = False   # so the "just write the whole file" nudge fires at most once
        verified = False            # a test/build passed AND no edit since — finish-when-verified nudge
        verify_nudged = False
        continues = 0               # length-truncation auto-continues used this turn
        mutating_total = 0          # edits/bash this turn — drives the TodoGate nudge
        todo_nudged = False         # so the "make a todo list" nudge fires at most once
        todo_gate = 0               # times we've refused to end the turn with open todos
        did_tools = False           # did the model actually call any tools this turn?
        summary_nudged = False      # so the "give a closing summary" nudge fires at most once
        goal_nudged = False         # standing-goal check fires at most once per turn before stopping

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
                                            self.config.api_key, fb, sampling=_sampling(self.config))
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
                if not (result.content or "").strip() and not summary_nudged:
                    summary_nudged = True   # empty final reply (worked-but-silent, OR reasoning-only) → ask once
                    detail = ("You did work this turn but ended without any message to the user."
                              if did_tools else
                              "Your last response was empty — you produced only reasoning, with no reply "
                              "and no tool call.")
                    self.messages.append({"role": "user", "content":
                        "<system-reminder>\n" + detail + " Respond now in the normal channel — give a "
                        "brief final summary (what you did / the answer), or take the next action with a "
                        "tool. Do not answer only in the thinking channel.\n</system-reminder>"})
                    continue
                if self._drain_steer():     # user interjected as we were about to finish → keep going
                    continue
                if getattr(self, "goal", "") and not goal_nudged and did_tools:  # standing /goal gate:
                    goal_nudged = True       #   don't stop with the goal unmet if we actually did work
                    self.messages.append({"role": "user", "content":
                        "<system-reminder>\nStanding goal for this session:\n" + self.goal +
                        "\nBefore you stop: is that goal now FULLY met? If yes, say so and summarize how. "
                        "If not, take the next concrete step toward it now — don't stop with it unmet.\n"
                        "</system-reminder>"})
                    continue
                if (verify_runs < 2 and mutating_total > 0                       # E: verify-before-done gate
                        and self.config.get("verify_before_done") and self.config.get("verify_command")):
                    verify_runs += 1
                    cmd = str(self.config.get("verify_command"))
                    self.ui.info(f"⧗ verify: {cmd}")
                    import subprocess as _sp
                    try:
                        pr = _sp.run(["bash", "-lc", cmd], cwd=str(self.config.project_root),
                                     capture_output=True, text=True,
                                     timeout=int(self.config.get("bash_timeout", 120)))
                        if pr.returncode != 0:
                            tail = ((pr.stdout or "") + "\n" + (pr.stderr or ""))[-3000:]
                            self.messages.append({"role": "user", "content":
                                "<system-reminder>\nverify_before_done: your changes fail "
                                f"`{cmd}` (exit {pr.returncode}). Fix them, then finish:\n" + tail
                                + "\n</system-reminder>"})
                            continue
                    except Exception as e:
                        self.ui.info(f"verify skipped: {e}")
                return

            if result.finish_reason == "length" and result.tool_calls:
                # the message hit the OUTPUT-token cap while emitting tool calls → their arguments may be
                # silently truncated (a partial write_file/edit_file corrupts a file, or dies as opaque
                # JSON). NEVER run them — including the special-cased tools that skip the JSON-parse net.
                if continues >= _MAX_CONTINUE:      # kept hitting the cap → stop rather than run garbage
                    self.ui.error("stopped — the model keeps hitting the output-token limit mid tool "
                                  "call; raise max_tokens or ask for a smaller change")
                    return
                # answer each open call so the transcript stays valid + ask for a complete re-issue
                # (a large file → one full write_file). (pi does the same.)
                continues += 1
                self.ui.info("↳ response truncated at the token limit — asked the model to re-issue")
                reissue = ("error: your response was cut off at the output-token limit, so this tool "
                           "call's arguments are incomplete and were NOT run. Re-issue it with complete "
                           "arguments — for a large file, write the whole thing in one write_file call.")
                if native:
                    for call in result.tool_calls:      # every tool_call needs a matching result
                        self.messages.append({"role": "tool", "tool_call_id": call.id, "content": reissue})
                else:
                    self.messages.append({"role": "user", "content":
                        "<system-reminder>\n" + reissue + "\n</system-reminder>"})
                continue

            did_tools = True                # the model called tools → expect a closing summary
            text_results: list[str] = []
            batch_verified = False          # did a test/build command pass in THIS batch?
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
                if call.name == "bash" and out.startswith("exit code: "):   # grind guard
                    head, _, body = out.partition("\n")
                    if head[len("exit code: "):].strip() == "0":             # a pass = progress → reset
                        fail_streak, fail_nudged, same_fail, last_fail_fp = 0, False, 0, None
                        cmdstr = str(call.arguments.get("command", ""))
                        if any(k in cmdstr for k in _VERIFY_KWS):            # a test/build just passed
                            batch_verified = True
                    else:
                        fail_streak += 1
                        fp = "".join(c for c in body if not c.isdigit())[:400]  # ignore line #s / timings
                        same_fail = same_fail + 1 if fp == last_fail_fp else 1
                        last_fail_fp = fp
                if call.name in ("edit_file", "multi_edit"):     # F3: varied-arg edit grind (dodges the
                    if out.lstrip().lower().startswith("error"):  # identical-call loop guard) → count it
                        edit_fail_streak += 1
                    else:
                        edit_fail_streak = 0
                elif call.name == "write_file" and not out.lstrip().lower().startswith("error"):
                    edit_fail_streak, edit_grind_nudged = 0, False   # the recommended recovery landed
                if native:
                    self.messages.append({"role": "tool", "tool_call_id": call.id, "content": out})
                else:
                    text_results.append(f"<result tool=\"{call.name}\">\n{out}\n</result>")
            if text_results:
                self.messages.append({"role": "user",
                                      "content": "<tool_results>\n" + "\n".join(text_results) + "\n</tool_results>"})

            if same_fail >= _FAIL_HARD:         # grind guard: the SAME failure keeps repeating
                self.ui.error(f"stopped — the same command failure repeated {same_fail}× with no progress")
                return
            if edit_fail_streak >= _EDIT_FAIL_HARD:     # F3: an edit grind that never lands → abort
                self.ui.error(f"stopped — {edit_fail_streak} edits in a row failed to match; "
                              "rewrite the file with write_file and try again")
                return

            # keep flaky local models on track: nudge a todo list on multi-step work, and
            # re-surface still-pending todos so they don't get dropped mid-task.
            mutating_total += sum(1 for c in result.tool_calls
                                  if c.name in ("write_file", "edit_file", "multi_edit", "bash"))
            reminders: list[str] = []
            if fail_streak >= _FAIL_SOFT and not fail_nudged:   # grind guard: nudge a rethink
                fail_nudged = True
                reminders.append(f"The last {fail_streak} commands all failed with no success. Stop "
                                 "retrying variations — re-read the failing output carefully, reconsider "
                                 "the approach from scratch, or state plainly what is blocking you.")
            if edit_fail_streak >= _EDIT_FAIL_SOFT and not edit_grind_nudged:   # F3: steer to write_file
                edit_grind_nudged = True
                reminders.append(f"Your last {edit_fail_streak} edit_file calls failed to match the file. "
                                 "STOP editing — read the file once, then write the ENTIRE corrected file "
                                 "in ONE write_file call (it always succeeds). Don't keep tweaking old_string.")
            # finish-when-verified: a test/build passed and the model kept tooling without editing → nudge
            made_edit = any(c.name in ("write_file", "edit_file", "multi_edit") for c in result.tool_calls)
            if verified and not made_edit and not verify_nudged:
                verify_nudged = True
                reminders.append("A test/build command passed and you haven't changed the code since. If "
                                 "the task is complete, give a brief final summary and stop — don't re-run "
                                 "or refactor code that already works.")
            if made_edit:                       # new code invalidates the pass → must re-verify
                verified, verify_nudged = False, False
            if batch_verified:
                verified = True
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
            if self.session_file and plan:              # persist it  → /view-plan reopens
                from . import sessions
                sessions.save_plan(self.session_file, plan)
            if plan and self.config.get("artifact_in_plan", False):   # opt-in: render the plan as a page too
                try:
                    from . import artifacts
                    title = next((ln.lstrip("# ").strip() for ln in plan.splitlines()
                                  if ln.strip().startswith("# ")), "Plan")
                    art = artifacts.serve_plan(plan, self.config.project_root, name=title,
                                               preferred_port=int(self.config.get("artifact_port", 45000)),
                                               lan=(str(self.config.get("artifact_bind", "localhost")).lower() == "lan"))
                    notify = getattr(self.ui, "artifact_ready", None)
                    if notify:
                        notify(art)                     # the CLI proposes opening the plan in the browser
                except Exception:
                    pass
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
            if self.mode == "plan" and not self.config.get("artifact_in_plan", False):
                return "Plan mode is read-only — don't start a preview yet. Describe it in the plan instead."
            from . import artifacts
            try:
                art = artifacts.add(str(args.get("path", "")), self.config.project_root,
                                    str(args.get("name", "") or ""),
                                    preferred_port=int(self.config.get("artifact_port", 45000)),
                                    lan=(str(self.config.get("artifact_bind", "localhost")).lower() == "lan"))
            except Exception as e:
                return f"error: could not start the artifact preview: {type(e).__name__}: {e}"
            notify = getattr(self.ui, "artifact_ready", None)
            if notify:
                notify(art)                          # the TUI proposes opening it in the terminal
            return (f"Artifact '{art.name}' is live at {art.url} — all artifacts share ONE local server "
                    f"({artifacts.base_url()}) with a dropdown to switch between them. Tell the user they "
                    f"can open that URL in a browser; '/artifact' lists and stops previews. Do NOT start "
                    f"another server yourself.")

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

        if name in ("write_file", "edit_file", "multi_edit") and args.get("path"):
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
        return LLMClient(base, key, model, sampling=_sampling(cfg))

    def _run_subagent(self, description: str, prompt: str, agent_name: str = "") -> str:
        adef = self.agent_defs.get(agent_name) if agent_name else None
        tag = f" [{agent_name}]" if adef else (f" [{agent_name}?]" if agent_name else "")
        self.ui.info(f"⟳ sub-task: {description}{tag}")
        sub_ui = _SubUI(self.ui, description)
        sub = Agent(self.config, sub_ui, mcp=self.mcp)   # fresh context, shared config + MCP servers
        sub.depth = self.depth + 1
        sub.cancelled = self.cancelled                    # parent Esc/cancel reaches the sub-agent too
        #                                                   (else a long sub-task was uninterruptible)
        override = self._subagent_client(adef)
        if override is not None:
            sub.client = override                         # its own model/host
        if adef and adef.effort:
            sub._effort_override = adef.effort
        task_prompt = (adef.body + "\n\n---\n\nTask: " + prompt) if (adef and adef.body) else prompt
        if self.cancelled.is_set():                       # cancel arrived during sub construction → bail
            return f"Sub-task '{description}' cancelled before it started."
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
