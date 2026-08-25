"""Custom user slash-commands — Markdown prompt templates the user drops in a directory
(project `.dgc/commands/*.md`).

Discovered from ~/.dgc/commands/*.md (personal) and <project>/.dgc/commands/*.md (project,
which overrides personal). `/name some args` runs the template with `$ARGUMENTS` (or
`{{args}}`) replaced by the rest of the line, as a normal prompt.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .config import USER_HOME


@dataclass(frozen=True)
class CommandSpec:
    """Authoritative metadata for one built-in command and its supported surfaces."""
    name: str
    description: str
    surfaces: frozenset[str]
    editor_action: str = ""
    accepts_args: bool = False


_T = frozenset({"tui"})
_TC = frozenset({"tui", "classic"})
_TCE = frozenset({"tui", "classic", "editor"})

# Order is the terminal palette order. A surface only advertises entries whose route it implements.
BUILTIN_COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("help", "list every command", _TC),
    CommandSpec("keys", "keyboard shortcuts cheatsheet", _T),
    CommandSpec("docs", "in-app how-to guides", _T),
    CommandSpec("new", "start a new session", _TCE, "new"),
    CommandSpec("resume", "reopen a past session · ^D deletes one", _TCE, "resume"),
    CommandSpec("history", "search & recall a past prompt", _T),
    CommandSpec("jump", "jump the transcript to a past turn", _T),
    CommandSpec("rewind", "restore code + conversation to a past turn", _TCE, "rewind"),
    CommandSpec("model", "switch the model", _TCE, "pickModel"),
    CommandSpec("models", "list models served by the endpoint", frozenset({"classic"})),
    CommandSpec("connect", "pick a provider or a custom LAN host", _TCE, "connect"),
    CommandSpec("subagent", "set the sub-agent model + host", _TCE, "subagent"),
    CommandSpec("mode", "permission mode: default · acceptEdits · plan · auto", _TCE, "pickMode"),
    CommandSpec("plan", "toggle read-only plan mode", frozenset({"classic"})),
    CommandSpec("view-plan", "reopen the plan saved in plan mode", _TCE, "viewPlan"),
    CommandSpec("think", "how hard the model reasons: off · low · medium · high", _TCE, "pickThink"),
    CommandSpec("thoughts", "show or hide the model's thinking in the transcript", _T),
    CommandSpec("expand", "expand the last collapsed tool output (/expandall for all)", _T),
    CommandSpec("copy", "select & copy text — releases the mouse to your terminal", _T),
    CommandSpec("worktree", "isolate edits in a git worktree", _TC),
    CommandSpec("sandbox", "confine bash to the project (private home/tmp, no network)", _T),
    CommandSpec("bg", "terminal background: auto · dark · inherit", _T),
    CommandSpec("theme", "colour theme: auto · dark · light", _TC),
    CommandSpec("context", "context-window usage", _TC),
    CommandSpec("artifact", "open / stop localhost artifact previews", _TCE, "artifacts"),
    CommandSpec("compact", "summarise the older turns now", _TCE, "compact"),
    CommandSpec("status", "model · host · mode · context", _TCE, "status"),
    CommandSpec("dashboard", "session roster — open, switch, start, or delete sessions", _T),
    CommandSpec("name", "name this session", _TC),
    CommandSpec("goal", "inspect/set/complete/block the standing objective", _TCE, "goal", True),
    CommandSpec("set", "tune a scalar setting live", _T),
    CommandSpec("settings", "browse & edit all settings", frozenset({"tui", "editor"}), "settings"),
    CommandSpec("handoff", "generate a complete continuation handoff", _TC),
    CommandSpec("mcp", "inspect and manage MCP servers", _TC),
    CommandSpec("agents", "sub-agent configuration", _TC),
    CommandSpec("skills", "installed skills", _TC),
    CommandSpec("skill", "invoke an installed skill", frozenset({"classic"})),
    CommandSpec("memory", "view or update project/user memory", _TC),
    CommandSpec("permissions", "allow · ask · deny rules", _TC),
    CommandSpec("init", "analyze the project and write DGC.md", frozenset({"classic"})),
    CommandSpec("search", "configure the web-search provider", frozenset({"classic"})),
    CommandSpec("bug", "report a bug / request a feature", frozenset({"tui", "editor"}), "bug"),
    CommandSpec("update", "update DGC to the latest version", _TC),
    CommandSpec("clear", "clear the transcript", _TCE, "clear"),
    CommandSpec("quit", "exit dgc", _TC),
)


def command_specs(surface: str) -> list[CommandSpec]:
    return [spec for spec in BUILTIN_COMMANDS if surface in spec.surfaces]


def command_pairs(surface: str) -> list[tuple[str, str]]:
    return [(spec.name, spec.description) for spec in command_specs(surface)]


def editor_command_metadata() -> list[dict]:
    return [{"name": spec.name, "description": spec.description, "action": spec.editor_action,
             "accepts_args": spec.accepts_args, "kind": "builtin"}
            for spec in command_specs("editor")]


def discover_commands(project_root) -> dict[str, Path]:
    cmds: dict[str, Path] = {}
    for base in (USER_HOME / "commands", Path(project_root) / ".dgc" / "commands"):
        if base.is_dir():
            for f in sorted(base.glob("*.md")):
                cmds[f.stem] = f          # project scanned last → overrides personal
    return cmds


def render_command(path: Path, args: str) -> str:
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return ""
    return text.replace("$ARGUMENTS", args).replace("{{args}}", args).strip()
