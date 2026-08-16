"""Permission engine — modes and rules modelled on Claude Code / Kimi Code.

Modes:
  default        read-only tools auto-allowed; writes & bash ask
  acceptEdits    file edits auto-allowed; bash still asks
  plan           read-only; all mutations denied (plan-then-approve workflow)
  auto           full-auto: everything allowed unless a deny rule matches

Rules use Claude Code syntax:  Tool  or  Tool(pattern)
  Bash(npm run *)   Write(src/**)   Edit   Read
Actions: allow | ask | deny.  Deny rules always win.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass

MODES = ("default", "acceptEdits", "plan", "auto")
MODE_DESCRIPTIONS = {
    "default": "ask before writes and shell commands",
    "acceptEdits": "auto-approve file edits, ask before shell commands",
    "plan": "read-only — research and present a plan before any change",
    "auto": "full auto — approve everything (deny rules still apply)",
}

# internal tool name -> display name used in rules
DISPLAY = {
    "read_file": "Read", "write_file": "Write", "edit_file": "Edit",
    "bash": "Bash", "glob": "Glob", "grep": "Grep", "web_fetch": "WebFetch",
    "todo": "Todo", "skill": "Skill", "save_memory": "SaveMemory",
    "present_plan": "PresentPlan",
}
DISPLAY_TO_TOOL = {v.lower(): k for k, v in DISPLAY.items()}

# which argument a rule's pattern is matched against
RULE_ARG = {
    "bash": "command", "read_file": "path", "write_file": "path",
    "edit_file": "path", "glob": "pattern", "grep": "pattern",
    "web_fetch": "url", "skill": "name", "save_memory": "scope",
}

READ_ONLY_TOOLS = {"read_file", "glob", "grep", "web_fetch", "todo", "skill",
                   "bash_output", "bash_kill"}
EDIT_TOOLS = {"write_file", "edit_file"}

# bash commands that never mutate state — auto-allowed in every mode (Claude Code style)
READ_ONLY_BASH = {
    "ls", "cat", "echo", "pwd", "head", "tail", "grep", "find", "wc", "which",
    "diff", "stat", "du", "df", "file", "tree", "date", "uname", "whoami", "env",
    "ps", "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "less", "more",
}
READ_ONLY_GIT = {"status", "log", "diff", "show", "branch", "blame", "ls-files", "rev-parse", "describe"}
BASH_WRAPPERS = {"timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "xargs", "sudo"}

ALLOW, ASK, DENY = "allow", "ask", "deny"


def _split_compound(command: str) -> list[str]:
    """Split a shell command on &&, ||, ; and | into subcommands."""
    parts = re.split(r"&&|\|\||[;|]", command)
    return [p.strip() for p in parts if p.strip()]


def _is_readonly_bash(command: str) -> bool:
    """True only if EVERY subcommand is a known read-only command."""
    for sub in _split_compound(command):
        words = sub.split()
        while words and words[0] in BASH_WRAPPERS:
            words = words[1:]
            # skip the wrapper's own arguments (e.g. "timeout 10", "nice -n 5")
            while words and (words[0].startswith("-") or words[0].isdigit()):
                words = words[1:]
        if not words:
            return False
        prog = words[0].rsplit("/", 1)[-1]
        if prog in READ_ONLY_BASH:
            continue
        if prog == "git" and len(words) > 1 and words[1] in READ_ONLY_GIT:
            continue
        return False
    return True


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


def rule_for(tool: str, args: dict) -> str:
    """Build a 'don't ask again' rule string for a specific invocation."""
    value = str(args.get(RULE_ARG.get(tool, ""), ""))
    name = DISPLAY.get(tool, tool)
    if value and len(value) <= 80:
        return f"{name}({value})"
    return name


class PermissionEngine:
    def __init__(self, mode: str, rules: dict[str, list[str]]):
        self.mode = mode if mode in MODES else "default"
        self.rules = parse_rules(rules)

    def decide(self, tool: str, args: dict) -> tuple[str, str]:
        """Return (allow|ask|deny, reason)."""
        for r in self.rules:
            if r.action == DENY and r.matches(tool, args):
                return DENY, f"blocked by deny rule: {r.render()}"

        if self.mode == "plan":
            if tool in READ_ONLY_TOOLS or tool == "present_plan":
                return ALLOW, "plan mode (read-only)"
            if tool == "bash" and _is_readonly_bash(str(args.get("command", ""))):
                return ALLOW, "plan mode (read-only command)"
            return DENY, "plan mode is active — no changes allowed; present a plan and get it approved first"

        for action in (ALLOW, ASK):
            for r in self.rules:
                if r.action == action and r.matches(tool, args):
                    return action, f"rule: {r.render()}"

        if self.mode == "auto":
            return ALLOW, "auto mode"
        if tool == "bash" and _is_readonly_bash(str(args.get("command", ""))):
            return ALLOW, "read-only command"
        if self.mode == "acceptEdits":
            if tool in READ_ONLY_TOOLS or tool in EDIT_TOOLS:
                return ALLOW, "acceptEdits mode"
            return ASK, "acceptEdits: shell commands need approval"
        # default
        if tool in READ_ONLY_TOOLS:
            return ALLOW, "read-only tool"
        return ASK, "default mode requires approval"
