"""Work on a subscription with DGC's tools (Dev Mode: Settings > Dev Mode, "Work on a subscription uses DGC's tools").

Off by default, and only with Dev Mode on. Off, a Work turn on Claude Code or Codex is handed to that CLI whole: it runs
its own loop and its own tools, and DGC keeps the session around it (subscriptions.run_cli_turn). On, the turn is the
Agent's own and the CLI is its model and nothing more, as for a Personal Pip and ChatDGC on a subscription:

* The CLI runs with none of its own tools, none of the user's settings, hooks, skills or MCP servers, and only DGC's
  server, on a private socket opened by a token minted for the run (pip_brain's flags, ToolServer and relay, through
  the client ChatDGC uses, chatdgc/subscription_client.py). It runs in a private folder of its own, never the project.
* Work's tools reach it over MCP, and each call it makes becomes a tool call of the Agent's own turn, so the Agent's own
  handlers run it: permissions and Allow cards, auto mode and its safety check, the sandbox, checkpoints and the Edited
  card, redaction, the transcript rows, steering, goals, compaction and helpers on their own model.
* Stop ends the CLI's whole process group. DGC never reads, copies or refreshes the CLI's login, and never calls the
  provider with it: the CLI signs in for itself.

The providers' terms may not allow their CLI behind another tool's loop: that is why this is in Dev Mode, off unless
the user turns it on, with a warning the first time. Kimi Code, Qwen Code and Copilot CLI aren't offered (below); a
session on one of them runs as before.
"""
from __future__ import annotations

from . import dev_mode
from .chatdgc.subscription_client import SubscriptionChatClient

# Why a CLI isn't offered here, as a session on it is told once; it runs with its own tools, as before.
NOT_OFFERED = {
    "kimi": "Kimi Code always starts your own MCP servers, so it can't be held to DGC's tools alone. It runs this "
            "session with its own tools, as before.",
    "qwen": "Qwen Code runs this session with its own tools, as before: DGC hasn't checked that it runs with only "
            "DGC's tools.",
    "copilot": "Copilot CLI runs this session with its own tools, as before: DGC hasn't checked that it runs with only "
               "DGC's tools.",
}

# The window each CLI gives its models, for the context meter and compaction (its own catalog isn't read here: that
# would start the CLI just to count). A Claude Code model named with [1m] has the larger one.
WINDOWS = {"claude": 200_000, "codex": 272_000}

TOOLS_NOTE = ("\n\nYour tools are DGC's and nothing else. They reach you through DGC's MCP server as mcp__dgc__NAME "
              "(or dgc.NAME), where NAME is the tool these instructions name: read_file, edit_file, write_file, bash, "
              "grep, glob, task and the rest; a plugin's tool named mcp__SERVER__TOOL here reaches you as "
              "mcp__dgc__SERVER__TOOL. You have no shell, file, web or sub-agent tools of your own: never say you ran a "
              "command or read a file yourself. DGC runs each call, asking the user first where its rules say so, and "
              "gives you its answer. A message from the user may arrive with a tool's answer: read it and adjust.")


def window_for(engine: str, model: str = "") -> int:
    """The context window this CLI gives the chosen model (0 for a CLI that isn't offered)."""
    if engine == "claude" and str(model or "").lower().endswith("[1m]"):
        return 1_000_000
    return WINDOWS.get(engine, 0)


def not_offered(engine: str) -> str:
    """Why this CLI isn't a Work turn's model with DGC's tools ("" for Claude Code and Codex)."""
    return NOT_OFFERED.get(str(engine or "").strip().lower(), "")


class WorkCLIClient(SubscriptionChatClient):
    """The CLI as the model of one Work turn. Built per turn (Agent._cli_model_client): its run lives while the turn's
    tool calls go back and forth, and ends with the turn."""

    stop_raises = False
    keep_limits = True
    empty_raises = False              # the turn's own recovery asks again, as for any model that said nothing
    # DGC's own handlers bound each tool (a command's timeout, an Allow card's wait, a helper's turn): the CLI's own
    # wait must never end one first.
    tool_timeout_s = 24 * 3600
    tools_note = TOOLS_NOTE
    work_cli = True

    def __init__(self, engine: str, model: str = "", effort: str = ""):
        # Signed in and installed are checked when it starts, so a CLI that can't start is a model that didn't answer
        # (an LLMError): the session's fallback takes over, as for any model.
        super().__init__(engine, model, effort=effort, check=False)

    def effective_context_size(self, configured: int) -> int:
        return window_for(self.engine, self.selected_model) or configured

    def capability_snapshot(self) -> dict:
        return {}

    def fresh(self) -> "WorkCLIClient":
        """Another run of the same CLI, for a request of its own (a title, a summary, the safety check): never the
        turn's own run, which is waiting on a tool's answer."""
        return type(self)(self.engine, self.selected_model, self.fixed_effort)

    def other(self, engine: str) -> "WorkCLIClient | None":
        """The session's other CLI as its fallback (Claude Code for Codex, or the other way round), on its own default
        model: also with DGC's tools only."""
        engine = str(engine or "").strip().lower()
        if engine == self.engine or engine not in dev_mode.SUBSCRIPTION_TOOLS_ENGINES:
            return None
        return type(self)(engine)


def client_for(config) -> WorkCLIClient | None:
    """The client a top-level Work turn uses as its model when Dev Mode's switch is on, else None."""
    engine = dev_mode.subscription_tools(config)
    if not engine:
        return None
    from .subscriptions import get_engine
    from .ultra import delegated_effort
    model = str(config.get("subscription_model", "") or "").strip()
    effort = str(config.get("subscription_effort", "") or "").strip().lower()
    known = get_engine(engine)
    effort = delegated_effort(config, engine, effort, bool(known is not None and known.supports_effort()))
    return WorkCLIClient(engine, model, effort)
