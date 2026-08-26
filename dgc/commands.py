"""Custom user slash-commands — Markdown prompt templates the user drops in a directory
(project `.dgc/commands/*.md`).

Discovered from ~/.dgc/commands/*.md (personal) and <project>/.dgc/commands/*.md (project,
which overrides personal). `/name some args` runs the template with `$ARGUMENTS` (or
`{{args}}`) replaced by the rest of the line, as a normal prompt.
"""
from __future__ import annotations

import re
import stat
from dataclasses import dataclass
from pathlib import Path

from .config import USER_HOME
from .workspace import read_regular_bytes, scan_directory_entries


MAX_CUSTOM_COMMANDS = 256
MAX_COMMAND_DIRECTORY_ENTRIES = 1_024
MAX_COMMAND_TEMPLATE_BYTES = 64 * 1_024
_CUSTOM_COMMAND_FILE = re.compile(r"([a-z0-9][a-z0-9._-]{0,63})\.md\Z")


@dataclass(frozen=True)
class CommandSpec:
    """Authoritative metadata for one built-in command and its supported surfaces."""
    name: str
    description: str
    surfaces: frozenset[str]
    editor_action: str = ""
    accepts_args: bool = False
    usage: str = ""
    aliases: tuple[str, ...] = ()


_T = frozenset({"tui"})
_TC = frozenset({"tui", "classic"})
_TCE = frozenset({"tui", "classic", "editor"})

# Order is the terminal palette order. A surface only advertises entries whose route it implements.
BUILTIN_COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("help", "list every command", _TC, aliases=("?", "commands")),
    CommandSpec("keys", "keyboard shortcuts cheatsheet", _T,
                aliases=("shortcuts", "cheatsheet")),
    CommandSpec("docs", "in-app how-to guides", _T, aliases=("doc", "guide")),
    CommandSpec("new", "start a new session", _TCE, "new", aliases=("session",)),
    CommandSpec("resume", "reopen a past session · ^D deletes one", _TCE, "resume"),
    CommandSpec("history", "search & recall a past prompt", _T, aliases=("hist",)),
    CommandSpec("jump", "jump the transcript to a past turn", _T),
    CommandSpec("rewind", "restore code + conversation to a past turn", _TCE, "rewind"),
    CommandSpec("model", "switch the model", _TCE, "pickModel", usage="model [NAME]"),
    CommandSpec("models", "list models served by the endpoint", frozenset({"classic"})),
    CommandSpec("connect", "pick a provider or a custom LAN host", _TCE, "connect",
                usage="connect [PRESET|URL]"),
    CommandSpec("subagent", "configure sub-agent model, host, transport, or inheritance", _TCE,
                "subagent", usage="subagent [SETTING…]"),
    CommandSpec("mode", "permission mode: default · acceptEdits · plan · auto", _TCE, "pickMode",
                usage="mode [MODE]"),
    CommandSpec("plan", "toggle read-only plan mode", frozenset({"classic"})),
    CommandSpec("view-plan", "reopen the plan saved in plan mode", _TCE, "viewPlan",
                aliases=("plan-view", "viewplan")),
    CommandSpec("think", "how hard the model reasons: off · low · medium · high", _TCE,
                "pickThink", usage="think [LEVEL]"),
    CommandSpec("thoughts", "show or hide the model's thinking in the transcript", _T,
                aliases=("reasoning", "reason")),
    CommandSpec("expand", "expand the last collapsed tool output", _T),
    CommandSpec("expandall", "expand every collapsed tool output", _T),
    CommandSpec("copy", "select & copy text — releases the mouse to your terminal", _T,
                aliases=("select", "selection")),
    CommandSpec("worktree", "list or switch to a named git worktree", _TC,
                usage="worktree [NAME]"),
    CommandSpec("tasks", "list, show, apply, or drop retained sub-agent work", _TCE,
                "retainedTasks", usage="tasks [ACTION…]"),
    CommandSpec("sandbox", "confine bash with the supported host OS boundary", _T),
    CommandSpec("bg", "terminal background: auto · dark · inherit", _T,
                aliases=("background",)),
    CommandSpec("theme", "colour theme: auto · dark · light", _TC, usage="theme [NAME]"),
    CommandSpec("context", "context-window usage", _TC),
    CommandSpec("artifact", "open / stop localhost artifact previews", _TCE, "artifacts",
                usage="artifact [stop ID]", aliases=("artifacts",)),
    CommandSpec("compact", "summarise the older turns now", _TCE, "compact"),
    CommandSpec("status", "model · host · mode · context", _TCE, "status"),
    CommandSpec("dashboard", "session roster — open, switch, start, or delete sessions", _T,
                aliases=("dash", "home")),
    CommandSpec("name", "name this session", _TC, usage="name [NAME]"),
    CommandSpec("goal", "inspect, set, complete, block, resume, or clear the objective", _TCE,
                "goal", True, usage="goal [TEXT|STATE]"),
    CommandSpec("set", "tune a scalar setting live", _T, usage="set [KEY [VALUE]]"),
    CommandSpec("settings", "browse & edit all settings", frozenset({"tui", "editor"}),
                "settings", aliases=("config", "prefs", "preferences")),
    CommandSpec("handoff", "generate a complete continuation handoff", _TCE, "handoff",
                aliases=("handover",)),
    CommandSpec("hooks", "inspect configured lifecycle hooks", _TCE, "hooks",
                aliases=("hook",)),
    CommandSpec("mcp", "inspect and manage MCP servers", _TC),
    CommandSpec("agents", "sub-agent configuration", _TC),
    CommandSpec("skills", "installed skills", _TCE, "skills",
                aliases=("extensions", "ext")),
    CommandSpec("skill", "invoke an installed skill", frozenset({"classic"}),
                usage="skill NAME [ARGS]"),
    CommandSpec("memory", "show or add project/user memory", _TC,
                usage="memory [ACTION…]"),
    CommandSpec("permissions", "list or add allow · ask · deny rules", _TC,
                usage="permissions [RULE…]"),
    CommandSpec("init", "analyze the project and write DGC.md", frozenset({"classic"})),
    CommandSpec("search", "configure the web-search provider", frozenset({"classic"}),
                usage="search [PROVIDER [URL]]"),
    CommandSpec("bug", "report a bug / request a feature", frozenset({"tui", "editor"}), "bug",
                aliases=("feedback", "report", "issue")),
    CommandSpec("update", "update DGC to the latest version", _TC),
    CommandSpec("clear", "clear the transcript", _TCE, "clear"),
    CommandSpec("quit", "exit dgc", _TC, aliases=("exit", "q")),
)


def _reserved_command_names() -> set[str]:
    return {name.casefold() for spec in BUILTIN_COMMANDS
            for name in (spec.name, *spec.aliases)}


def command_specs(surface: str) -> list[CommandSpec]:
    return [spec for spec in BUILTIN_COMMANDS if surface in spec.surfaces]


def resolve_command(name: str, surface: str) -> CommandSpec | None:
    """Resolve one primary name or declared alias on a surface to its canonical specification."""
    token = str(name or "").casefold()
    for spec in BUILTIN_COMMANDS:
        if (surface in spec.surfaces
                and (token == spec.name.casefold()
                     or any(token == alias.casefold() for alias in spec.aliases))):
            return spec
    return None


def canonical_command_name(name: str, surface: str) -> str:
    """Return the canonical built-in name, or the normalized input for custom/unknown commands."""
    token = str(name or "").casefold()
    resolved = resolve_command(token, surface)
    return resolved.name if resolved else token


def command_pairs(surface: str) -> list[tuple[str, str]]:
    return [(spec.name, spec.description) for spec in command_specs(surface)]


def custom_command_names(project_root) -> list[str]:
    """Return deterministic custom names; built-ins/aliases are reserved across surfaces."""
    return list(discover_commands(project_root))


def command_pairs_with_custom(surface: str, project_root) -> list[tuple[str, str]]:
    return [*command_pairs(surface),
            *((name, "custom prompt command")
              for name in custom_command_names(project_root))]


def editor_command_metadata() -> list[dict]:
    return [{"name": spec.name, "description": spec.description, "action": spec.editor_action,
             "accepts_args": spec.accepts_args, "aliases": list(spec.aliases), "kind": "builtin"}
            for spec in command_specs("editor")]


def discover_commands(project_root) -> dict[str, Path]:
    """Discover bounded, regular prompt templates without following directory/file symlinks.

    Project commands override personal commands with the same name.  All built-in names are
    reserved globally so a command cannot mean one thing in the terminal and another in an editor
    or ACP client.
    """
    reserved = _reserved_command_names()

    def scan(base: Path) -> dict[str, Path]:
        found: dict[str, Path] = {}
        try:
            rows, _truncated, _scanned = scan_directory_entries(
                base, maximum=MAX_COMMAND_DIRECTORY_ENTRIES)
        except (OSError, ValueError):
            return found
        for filename, info in rows:
            match = _CUSTOM_COMMAND_FILE.fullmatch(filename)
            if (not match or not stat.S_ISREG(info.st_mode)
                    or info.st_size > MAX_COMMAND_TEMPLATE_BYTES
                    or match.group(1).casefold() in reserved):
                continue
            found[match.group(1)] = base / filename
            if len(found) >= MAX_CUSTOM_COMMANDS:
                break
        return found

    personal = scan(USER_HOME / "commands")
    project = scan(Path(project_root) / ".dgc" / "commands")
    # Prefer project-local commands under the global cap, then fill with non-shadowed personal
    # commands.  Dict insertion order is the stable UI order returned by every frontend.
    commands: dict[str, Path] = {}
    for name, path in project.items():
        commands[name] = path
    for name, path in personal.items():
        if name not in commands and len(commands) < MAX_CUSTOM_COMMANDS:
            commands[name] = path
    return commands


def render_command(path: Path, args: str, project_root) -> str:
    """Render a discovered template while retaining its project/personal directory authority."""
    target = Path(path)
    allowed_parents = (USER_HOME / "commands", Path(project_root) / ".dgc" / "commands")
    match = _CUSTOM_COMMAND_FILE.fullmatch(target.name)
    if (not target.is_absolute() or ".." in target.parts or target.parent not in allowed_parents
            or not match or match.group(1).casefold() in _reserved_command_names()):
        return ""
    try:
        result = read_regular_bytes(target, maximum=MAX_COMMAND_TEMPLATE_BYTES)
        text = result[0].decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return ""
    return text.replace("$ARGUMENTS", args).replace("{{args}}", args).strip()
