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
import json
import os
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
    "read_file": "Read", "view_image": "ViewImage", "write_file": "Write", "edit_file": "Edit", "multi_edit": "MultiEdit",
    "apply_patch": "ApplyPatch", "repo_map": "RepoMap", "code_intel": "CodeIntel", "git_diff": "GitDiff",
    "bash": "Bash", "bash_output": "BashOutput", "bash_kill": "BashKill", "python": "Python",
    "monitor": "Monitor", "monitor_stop": "MonitorStop",
    "glob": "Glob", "grep": "Grep", "web_fetch": "WebFetch", "web_search": "WebSearch",
    "browser": "Browser",
    "todo": "Todo", "notes": "Notes", "skill": "Skill", "add_skill": "AddSkill", "save_memory": "SaveMemory",
    "mcp_search": "MCPSearch", "mcp_call": "MCPCall",
    "present_plan": "PresentPlan", "present_document": "PresentDocument", "propose_options": "ProposeOptions", "artifact": "Artifact",
    "task": "Task", "external_directory": "ExternalDirectory",
}
DISPLAY_TO_TOOL = {v.lower(): k for k, v in DISPLAY.items()}

# which argument a rule's pattern is matched against
RULE_ARG = {
    "bash": "command", "monitor": "command", "python": "code", "read_file": "path", "view_image": "path",
    "write_file": "path",
    "edit_file": "path", "multi_edit": "path", "apply_patch": "path",
    "glob": "pattern", "grep": "pattern", "repo_map": "path", "code_intel": "path", "git_diff": "path",
    "web_fetch": "url", "web_search": "query", "skill": "name", "add_skill": "url",
    "browser": "url",
    "mcp_search": "query", "mcp_call": "name",
    "save_memory": "scope", "artifact": "path", "task": "description", "notes": "query",
    "external_directory": "path",
}

READ_ONLY_TOOLS = {"read_file", "view_image", "glob", "grep", "repo_map", "code_intel", "git_diff", "web_fetch", "web_search", "todo", "notes", "skill",
                   "bash_output", "propose_options", "present_document", "mcp_search", "update_goal"}
EDIT_TOOLS = {"write_file", "edit_file", "multi_edit", "apply_patch"}
# Ending a process the agent itself started. Allowed in every mode, plan included; a deny rule
# still wins.
STOP_TOOLS = {"monitor_stop"}
# A tool whose policy is another tool's: a `monitor` runs a shell command, so every Bash rule, the
# compound-command matching, plan-mode denial and auto-mode allowance apply to it unchanged. Rules
# naming the tool itself (`Monitor`, `Monitor(tail *)`) apply too; see PermissionEngine.decide.
# `view_image` reads a file, so every Read rule (a `Read(secrets/**)` deny above all) covers it too.
POLICY_ALIASES = {"monitor": "bash", "view_image": "read_file"}

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
    note: str = ""     # why a rule DGC added itself exists; shown with the deny reason
    session: bool = False  # from the launching process's session policy (never saved)

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
        if tool in ("bash", "monitor"):
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


# ------------------------------------------------------------------ session policy ---
# A process that launches `dgc serve` for one session (the SDK) can fix permission rules and
# sandbox settings for that process only. They arrive in this environment variable as JSON, are
# never written to config.json, and every PermissionEngine adds them, so no command, mode or
# editor setting can drop them. A policy that does not parse denies every tool: a malformed
# policy must not quietly become no policy.
SESSION_POLICY_ENV = "DGC_SESSION_POLICY"
SESSION_POLICY_VERSION = 1
_SESSION_POLICY_KEYS = {"version", "deny", "ask", "auto_deny", "sandbox", "sandbox_network",
                        "sandbox_read_only", "shell_requires_sandbox", "project_allow"}
_SESSION_POLICY_MAX_RULES = 4096
# Shell tools the OS sandbox confines, and the persistent interpreter it never wraps.
SANDBOXED_SHELL_TOOLS = ("bash", "monitor")
UNSANDBOXED_CODE_TOOLS = ("python",)


@dataclass(frozen=True)
class SessionPolicy:
    raw: str
    rules: tuple[Rule, ...] = ()
    auto_rules: tuple[Rule, ...] = ()     # deny rules that apply only in auto mode
    sandbox: str = "off"                  # off | preferred | required
    sandbox_network: bool | None = None   # None keeps the configured value
    sandbox_read_only: bool = False
    shell_requires_sandbox: bool = False
    project_allow: bool = True            # False: a project's allow rules are not loaded
    error: str = ""

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.raw.encode("utf-8", errors="replace")).hexdigest()


def _parse_session_policy(raw: str) -> SessionPolicy:
    def broken(message: str) -> SessionPolicy:
        return SessionPolicy(raw=raw, error=message[:500])

    try:
        data = json.loads(raw)
    except ValueError:
        return broken(f"{SESSION_POLICY_ENV} is not valid JSON")
    if not isinstance(data, dict):
        return broken(f"{SESSION_POLICY_ENV} must be a JSON object")
    if data.get("version") != SESSION_POLICY_VERSION:
        return broken(f"{SESSION_POLICY_ENV} version {data.get('version')!r} is not supported "
                      f"(this DGC reads version {SESSION_POLICY_VERSION})")
    unknown = sorted(set(data) - _SESSION_POLICY_KEYS)
    if unknown:
        return broken(f"{SESSION_POLICY_ENV} has an unknown field {unknown[0]!r}")
    parsed: dict[str, list[Rule]] = {}
    for key, action in (("deny", DENY), ("ask", ASK), ("auto_deny", DENY)):
        texts = data.get(key, [])
        if not isinstance(texts, list) or len(texts) > _SESSION_POLICY_MAX_RULES:
            return broken(f"{SESSION_POLICY_ENV}.{key} must be a list of rules")
        parsed[key] = []
        for text in texts:
            if not isinstance(text, str):
                return broken(f"{SESSION_POLICY_ENV}.{key} must contain only strings")
            try:
                rule = Rule.parse(text, action)
            except ValueError as exc:
                return broken(f"{SESSION_POLICY_ENV}.{key}: {exc}")
            rule.session = True
            rule.note = "a limit the application running this session set"
            parsed[key].append(rule)
    sandbox = data.get("sandbox", "off")
    if sandbox not in ("off", "preferred", "required"):
        return broken(f"{SESSION_POLICY_ENV}.sandbox must be off, preferred or required")
    network = data.get("sandbox_network")
    flags = {key: data.get(key, False) for key in ("sandbox_read_only", "shell_requires_sandbox")}
    flags["project_allow"] = data.get("project_allow", True)
    if (network is not None and not isinstance(network, bool)) or any(
            not isinstance(value, bool) for value in flags.values()):
        return broken(f"{SESSION_POLICY_ENV} sandbox flags must be true or false")
    return SessionPolicy(raw=raw, rules=(*parsed["deny"], *parsed["ask"]),
                         auto_rules=tuple(parsed["auto_deny"]), sandbox=sandbox,
                         sandbox_network=network, **flags)


_SESSION_POLICY_CACHE: tuple[str, SessionPolicy] | None = None


def session_policy() -> SessionPolicy | None:
    """The launching process's policy for this `dgc serve`, or None when it set none."""
    global _SESSION_POLICY_CACHE
    raw = os.environ.get(SESSION_POLICY_ENV)
    if raw is None:
        return None
    cached = _SESSION_POLICY_CACHE
    if cached is not None and cached[0] == raw:
        return cached[1]
    policy = _parse_session_policy(raw)
    _SESSION_POLICY_CACHE = (raw, policy)
    return policy


def session_policy_rules(mode: str) -> list[Rule]:
    """Rules every PermissionEngine adds on top of the configured ones, for its current mode.

    Auto mode has nobody to review a command, so the policy's auto-only denies apply there, and
    with ``shell_requires_sandbox`` shell code runs only inside the OS sandbox: bash and monitor
    are refused when it is off, and the python tool (a persistent interpreter the sandbox never
    wraps) is always refused. In the other modes each shell call is still a permission request.
    """
    policy = session_policy()
    if policy is None:
        return []
    if policy.error:
        return [Rule("*", None, DENY, note=f"the session policy is invalid: {policy.error}",
                     session=True)]
    rules = list(policy.rules)
    if mode == "auto":
        rules.extend(policy.auto_rules)
        if policy.shell_requires_sandbox:
            from . import sandbox
            confined = sandbox.session_confined()
            for tool in (*(() if confined else SANDBOXED_SHELL_TOOLS), *UNSANDBOXED_CODE_TOOLS):
                why = ("the python tool is never sandboxed" if tool in UNSANDBOXED_CODE_TOOLS
                       else "no OS sandbox is available")
                rules.append(Rule(tool, None, DENY, session=True, note=(
                    f"this session's policy runs unattended shell code only inside the OS sandbox, "
                    f"and {why}")))
    return rules


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
    if tool in POLICY_ALIASES:
        return POLICY_ALIASES[tool], {RULE_ARG[tool]: args.get(RULE_ARG[tool], "")}
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


_PATH_TOOLS = {"read_file", "view_image", "write_file", "edit_file", "multi_edit", "apply_patch", "artifact",
               "code_intel", "git_diff"}
_SEARCH_PATH_TOOLS = {"glob", "grep", "repo_map"}


class PermissionEngine:
    def __init__(self, mode: str, rules: dict[str, list[str]], project_root: Path | None = None):
        self.mode = mode if mode in MODES else "default"
        # Session-policy rules come last: deny still wins wherever it sits, and an ask added by
        # the launching process is not skipped by a broader configured allow.
        self.rules = parse_rules(rules) + session_policy_rules(self.mode)
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

    def deny_reason(self, tool: str, args: dict) -> str:
        """The reason a deny rule blocks this call (including an ExternalDirectory deny), or ""."""
        decision, reason = self.decide(tool, args)
        return reason if decision == DENY and reason.startswith("blocked by deny rule") else ""

    def decide(self, tool: str, args: dict) -> tuple[str, str]:
        """Return (allow|ask|deny, reason)."""
        external = self.external_paths(tool, args)
        ext_args = {"path": external[0]} if external else {}
        policy_tool, policy_args = _permission_subject(tool, args)
        # An aliased tool is matched as itself AND as the tool whose policy it shares; within each
        # action a match on either counts, and deny from either wins over everything below.
        subjects = [(policy_tool, policy_args)]
        if tool in POLICY_ALIASES:
            subjects.append((tool, dict(args)))

        def rule_for_action(action: str):
            return next((r for subject, subject_args in subjects
                         if (r := self._rule_action(subject, subject_args, action))), None)

        deny = rule_for_action(DENY)
        ext_deny = self._rule_action("external_directory", ext_args, DENY) if external else None
        if deny or ext_deny:
            r = deny or ext_deny
            return DENY, f"blocked by deny rule: {r.render()}" + (f" ({r.note})" if r.note else "")

        if policy_tool in STOP_TOOLS:
            return ALLOW, "stopping a process this agent started"

        if self.mode == "plan":
            if external:
                return DENY, f"plan mode cannot access paths outside the project: {external[0]}"
            if policy_tool in ("mcp_search", "mcp_call"):
                return DENY, "plan mode does not expose MCP discovery or execution"
            if policy_tool in READ_ONLY_TOOLS or policy_tool == "present_plan":
                # A session policy's ask still goes to the process that set it (an SDK checks a
                # search against its denied paths), even for a read-only tool in plan mode.
                session_ask = next((r for subject, subject_args in subjects for r in self.rules
                                    if r.session and r.action == ASK
                                    and self._matches(r, subject, subject_args)), None)
                if session_ask:
                    return ASK, f"rule: {session_ask.render()}"
                return ALLOW, "plan mode (read-only)"
            return DENY, "plan mode is active — no changes allowed; present a plan and get it approved first"

        # Security precedence is deny -> ask -> allow. A narrow ask must beat a broad allow.
        for action in (ASK, ALLOW):
            r = rule_for_action(action)
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
