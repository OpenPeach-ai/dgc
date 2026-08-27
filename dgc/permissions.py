"""Permission engine — a modes-and-rules permission model.

Modes:
  default        read-only tools auto-allowed; writes & bash ask
  acceptEdits    file edits auto-allowed; bash still asks
  plan           read-only; all mutations denied (plan-then-approve workflow)
  auto           full-auto: everything allowed unless a deny rule matches

Rules use a simple syntax:  Tool  or  Tool(pattern)
  Bash(npm run *)   Write(src/**)   Edit   Read
Actions: allow | ask | deny.  Deny rules always win.
"""
from __future__ import annotations

import fnmatch
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from .workspace import WorkspaceBoundaryError, canonical_path, is_within, relative_rule_value

MODES = ("default", "acceptEdits", "plan", "auto")
MODE_DESCRIPTIONS = {
    "default": "ask before writes and shell commands",
    "acceptEdits": "auto-approve file edits, ask before shell commands",
    "plan": "read-only — research and present a plan before any change",
    "auto": "full auto — approve everything (deny rules still apply)",
}

# internal tool name -> display name used in rules
DISPLAY = {
    "read_file": "Read", "write_file": "Write", "edit_file": "Edit", "multi_edit": "MultiEdit",
    "apply_patch": "ApplyPatch", "repo_map": "RepoMap", "code_intel": "CodeIntel",
    "bash": "Bash", "bash_output": "BashOutput", "bash_kill": "BashKill",
    "glob": "Glob", "grep": "Grep", "web_fetch": "WebFetch", "web_search": "WebSearch",
    "todo": "Todo", "skill": "Skill", "add_skill": "AddSkill", "save_memory": "SaveMemory",
    "mcp_search": "MCPSearch", "mcp_call": "MCPCall",
    "present_plan": "PresentPlan", "propose_options": "ProposeOptions", "artifact": "Artifact",
    "task": "Task", "external_directory": "ExternalDirectory",
}
DISPLAY_TO_TOOL = {v.lower(): k for k, v in DISPLAY.items()}

# which argument a rule's pattern is matched against
RULE_ARG = {
    "bash": "command", "read_file": "path", "write_file": "path",
    "edit_file": "path", "multi_edit": "path", "apply_patch": "path",
    "glob": "pattern", "grep": "pattern", "repo_map": "path", "code_intel": "path",
    "web_fetch": "url", "web_search": "query", "skill": "name", "add_skill": "url",
    "mcp_search": "query", "mcp_call": "name",
    "save_memory": "scope", "artifact": "path", "task": "description",
    "external_directory": "path",
}

READ_ONLY_TOOLS = {"read_file", "glob", "grep", "repo_map", "code_intel", "web_fetch", "web_search", "todo", "skill",
                   "bash_output", "propose_options", "mcp_search"}
EDIT_TOOLS = {"write_file", "edit_file", "multi_edit", "apply_patch"}

# A shell string is not a trustworthy read/write boundary. Redirections, substitutions, interpreters,
# `find -delete`, git output flags, aliases/config, and wrapper commands all make token allowlists
# bypassable. DGC has structured read/glob/grep tools, so shell requires approval unless the user has
# written an explicit rule (or selected auto mode).

ALLOW, ASK, DENY = "allow", "ask", "deny"


def _split_compound(command: str) -> list[str]:
    """Split a shell command on &&, ||, ; and | into subcommands."""
    parts = re.split(r"&&|\|\||[;|]", command)
    return [p.strip() for p in parts if p.strip()]


def _is_readonly_bash(command: str) -> bool:
    """Deprecated compatibility helper: arbitrary shell is never intrinsically read-only."""
    return False


@dataclass
class Rule:
    tool: str          # internal tool name, or "*" for all
    pattern: str | None
    action: str

    @classmethod
    def parse(cls, text: str, action: str) -> "Rule":
        m = re.match(r"^\s*([A-Za-z_]+)\s*(?:\((.*)\))?\s*$", text)
        if not m:
            raise ValueError(f"bad rule syntax: {text!r}  (expected Tool or Tool(pattern))")
        tool_raw, pattern = m.group(1), m.group(2)
        tool = DISPLAY_TO_TOOL.get(tool_raw.lower(), tool_raw.lower() if tool_raw == "*" else None)
        if tool is None:
            raise ValueError(f"unknown tool in rule: {tool_raw!r} (known: {', '.join(DISPLAY.values())})")
        return cls(tool=tool, pattern=pattern, action=action)

    def render(self) -> str:
        name = next((d for t, d in DISPLAY.items() if t == self.tool), self.tool)
        return f"{name}({self.pattern})" if self.pattern else name

    def _match_one(self, value: str) -> bool:
        pat = self.pattern or ""
        if pat.endswith(":*"):          # Claude-style prefix: "npm test:*"
            return value.startswith(pat[:-2])
        return fnmatch.fnmatch(value, pat) or value == pat

    def matches(self, tool: str, args: dict) -> bool:
        if self.tool != "*" and self.tool != tool:
            return False
        if self.pattern is None:
            return True
        value = str(args.get(RULE_ARG.get(tool, ""), ""))
        if tool == "external_directory" and not any(c in (self.pattern or "") for c in "*?["):
            try:
                value_path = Path(value).resolve(strict=False)
                rule_path = Path(self.pattern or "").resolve(strict=False)
                return value_path == rule_path or value_path.is_relative_to(rule_path)
            except (OSError, ValueError):
                return False
        if tool == "bash":
            # compound commands: deny matches if ANY subcommand matches;
            # allow/ask only match when EVERY subcommand matches
            hits = [self._match_one(s) for s in _split_compound(value)] or [False]
            return any(hits) if self.action == DENY else all(hits)
        return self._match_one(value)


def parse_rules(rules: dict[str, list[str]]) -> list[Rule]:
    out = []
    for action in (ALLOW, ASK, DENY):
        for text in rules.get(action, []):
            try:
                out.append(Rule.parse(text, action))
            except ValueError:
                continue
    return out


_MCP_ROUTE_RE = re.compile(r"mcp__[A-Za-z0-9_-]{1,506}\Z")


def _mcp_permission_route(value) -> str:
    """Return an exact rule-safe route, hashing malformed/oversized untrusted names."""
    route = str(value or "")
    if _MCP_ROUTE_RE.fullmatch(route):
        return route
    return "sha256:" + hashlib.sha256(route.encode("utf-8", errors="replace")).hexdigest()


def _permission_subject(tool: str, args: dict) -> tuple[str, dict]:
    """Map a generated direct MCP route onto its stable broker permission identity."""
    if isinstance(tool, str) and tool.startswith("mcp__"):
        # Server-defined arguments may themselves contain ``name``. Policy is intentionally scoped
        # to the exact controller-owned route, never a colliding untrusted argument field.
        return "mcp_call", {"name": _mcp_permission_route(tool)}
    if tool == "mcp_call":
        return tool, {**args, "name": _mcp_permission_route(args.get("name"))}
    return tool, args


def rule_for(tool: str, args: dict) -> str:
    """Build a 'don't ask again' rule string for a specific invocation."""
    tool, args = _permission_subject(tool, args)
    value = str(args.get(RULE_ARG.get(tool, ""), ""))
    name = DISPLAY.get(tool, tool)
    if tool == "mcp_call" and value:
        return f"{name}({value})"
    if value and len(value) <= 80:
        return f"{name}({value})"
    return name


_PATH_TOOLS = {"read_file", "write_file", "edit_file", "multi_edit", "apply_patch", "artifact",
               "code_intel"}
_SEARCH_PATH_TOOLS = {"glob", "grep", "repo_map"}


class PermissionEngine:
    def __init__(self, mode: str, rules: dict[str, list[str]], project_root: Path | None = None):
        self.mode = mode if mode in MODES else "default"
        self.rules = parse_rules(rules)
        self.project_root = Path(project_root).resolve(strict=False) if project_root else None

    def external_paths(self, tool: str, args: dict) -> list[str]:
        """Canonical paths outside the project touched by this structured tool call."""
        if self.project_root is None:
            return []
        raw = None
        if tool in _PATH_TOOLS:
            raw = args.get("path")
        elif tool in _SEARCH_PATH_TOOLS and args.get("path"):
            raw = args.get("path")
        if raw in (None, ""):
            return []
        try:
            target = canonical_path(str(raw), self.project_root)
        except WorkspaceBoundaryError:
            return [str(raw)]
        return [] if is_within(target, self.project_root) else [str(target)]

    def canonical_args(self, tool: str, args: dict) -> dict:
        """Copy args with a stable path value for persisted permission rules."""
        out = dict(args)
        if self.project_root is None:
            return out
        if tool in _PATH_TOOLS and out.get("path"):
            try:
                out["path"] = relative_rule_value(str(out["path"]), self.project_root)
            except WorkspaceBoundaryError:
                pass
        elif tool == "external_directory" and out.get("path"):
            try:
                out["path"] = str(canonical_path(str(out["path"]), self.project_root))
            except WorkspaceBoundaryError:
                pass
        return out

    def _matches(self, rule: Rule, tool: str, args: dict) -> bool:
        """Match raw and canonical/relative paths so aliases cannot bypass rules."""
        if rule.tool not in ("*", tool):
            return False
        if rule.pattern is None or self.project_root is None or tool not in _PATH_TOOLS:
            return rule.matches(tool, args)
        values = [str(args.get("path", ""))]
        try:
            target = canonical_path(values[0], self.project_root)
            values.extend((str(target), relative_rule_value(target, self.project_root)))
        except WorkspaceBoundaryError:
            pass
        key = RULE_ARG.get(tool, "")
        return any(rule.matches(tool, {**args, key: value}) for value in dict.fromkeys(values))

    def _rule_action(self, tool: str, args: dict, action: str) -> Rule | None:
        return next((r for r in self.rules if r.action == action and self._matches(r, tool, args)), None)

    def decide(self, tool: str, args: dict) -> tuple[str, str]:
        """Return (allow|ask|deny, reason)."""
        external = self.external_paths(tool, args)
        ext_args = {"path": external[0]} if external else {}
        policy_tool, policy_args = _permission_subject(tool, args)
        deny = self._rule_action(policy_tool, policy_args, DENY)
        ext_deny = self._rule_action("external_directory", ext_args, DENY) if external else None
        if deny or ext_deny:
            r = deny or ext_deny
            return DENY, f"blocked by deny rule: {r.render()}"

        if self.mode == "plan":
            if external:
                return DENY, f"plan mode cannot access paths outside the project: {external[0]}"
            if policy_tool in ("mcp_search", "mcp_call"):
                return DENY, "plan mode does not expose MCP discovery or execution"
            if policy_tool in READ_ONLY_TOOLS or policy_tool == "present_plan":
                return ALLOW, "plan mode (read-only)"
            return DENY, "plan mode is active — no changes allowed; present a plan and get it approved first"

        # Security precedence is deny -> ask -> allow. A narrow ask must beat a broad allow.
        for action in (ASK, ALLOW):
            r = self._rule_action(policy_tool, policy_args, action)
            er = self._rule_action("external_directory", ext_args, action) if external else None
            if r or er:
                matched = r or er
                return action, f"rule: {matched.render()}"

        if external and self.mode != "auto":
            return ASK, f"path is outside the project and needs explicit approval: {external[0]}"

        if self.mode == "auto":
            return ALLOW, "auto mode"
        if self.mode == "acceptEdits":
            if policy_tool in READ_ONLY_TOOLS or policy_tool in EDIT_TOOLS:
                return ALLOW, "acceptEdits mode"
            return ASK, "acceptEdits: shell commands need approval"
        # default
        if policy_tool in READ_ONLY_TOOLS:
            return ALLOW, "read-only tool"
        return ASK, "default mode requires approval"
