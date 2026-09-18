"""Embedder policy: tool, path, network and shell limits for every session of a DGC client."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import warnings
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .errors import DGCConfigError, DGCUnsupportedError
from .types import (
    PermissionAction, PermissionMode, PermissionPolicy, PermissionRequest, SandboxPolicy,
    SandboxRequirement, SandboxStatus, UnhandledPolicy,
)

NetworkMode = Literal["deny", "allow"]
ShellMode = Literal["sandboxed", "screened"]

# DGC's internal tool name -> the display name its permission rules use. Mirrors
# dgc.permissions.DISPLAY (a test keeps the two equal), minus the ExternalDirectory pseudo-tool.
_DISPLAY = {
    "read_file": "Read", "view_image": "ViewImage", "write_file": "Write", "edit_file": "Edit",
    "multi_edit": "MultiEdit", "apply_patch": "ApplyPatch", "repo_map": "RepoMap",
    "code_intel": "CodeIntel", "git_diff": "GitDiff", "bash": "Bash", "bash_output": "BashOutput",
    "bash_kill": "BashKill", "python": "Python", "monitor": "Monitor", "monitor_stop": "MonitorStop",
    "glob": "Glob", "grep": "Grep", "web_fetch": "WebFetch", "web_search": "WebSearch",
    "browser": "Browser", "todo": "Todo", "notes": "Notes", "skill": "Skill",
    "add_skill": "AddSkill", "save_memory": "SaveMemory", "mcp_search": "MCPSearch",
    "mcp_call": "MCPCall", "present_plan": "PresentPlan", "present_document": "PresentDocument",
    "propose_options": "ProposeOptions", "artifact": "Artifact", "task": "Task",
}
# Tools a rule cannot name (goal bookkeeping), and tools an allowlist keeps unless it is denied
# by name: the option picker is how the agent asks the application a question.
_UNRULED_TOOLS = frozenset({"update_goal"})
_ALWAYS_OFFERED = frozenset({"propose_options"})

_WRITE_TOOLS = frozenset({"write_file", "edit_file", "multi_edit", "apply_patch"})
_READ_PATH_TOOLS = frozenset({"read_file", "view_image", "code_intel", "git_diff", "repo_map",
                              "grep", "glob"})
_PATH_TOOLS = frozenset({*_READ_PATH_TOOLS, *_WRITE_TOOLS, "artifact"})
# Tools that search a tree rather than open one path. A rule cannot say "this search covers a
# denied path", so with a denied path inside a readable tree they become permission requests that
# the SDK answers from the search root.
_SEARCH_TOOLS = frozenset({"grep", "glob", "repo_map", "code_intel", "git_diff"})
# Rules match these tools' `path` argument, in absolute and project-relative spellings.
_PATH_RULE_TOOLS = ("Read", "ViewImage", "Write", "Edit", "MultiEdit", "ApplyPatch", "Artifact",
                    "CodeIntel", "GitDiff")
_NETWORK_TOOLS = ("WebFetch", "WebSearch", "Browser", "AddSkill")
_APP_SERVER = "app"

_MCP_EXACT_RE = re.compile(r"mcp__[A-Za-z0-9_-]{1,506}\Z")
_MCP_WILDCARD_RE = re.compile(r"mcp__[A-Za-z0-9_-]{0,505}\*\Z")

_NET_HINTS = (
    "curl ", "wget ", "nc ", "ncat ", "ssh ", "scp ", "sftp ", "telnet ", "ftp ", "rsync ",
    "http://", "https://", "ftp://", "invoke-webrequest", "fetch(", "socket", "urllib",
    "http.client", "requests.", "git push", "git fetch", "git pull", "git clone",
)
_NET_BASH_PATTERNS = (
    "*curl*", "*wget*", "*http://*", "*https://*", "*ftp://*", "nc *", "* nc *", "ncat *",
    "* ncat *", "ssh *", "* ssh *", "scp *", "* scp *", "sftp *", "rsync *", "* rsync *",
    "telnet *", "*socket*", "*urllib*", "*http.client*", "*requests.*", "git push*",
    "* git push*", "git fetch*", "git pull*", "git clone*",
)

# Command-screening globs (``shell="screened"`` only). Deny matches ANY compound subcommand.
# `*>[!&]*` is `>`/`>>` except `>&fd` (so `ls 2>&1` still runs); `/dev/null` redirects are
# denied too, because fnmatch cannot carve them out.
_WRITE_BASH_PATTERNS = (
    "*>[!&]*",
    "cp *", "* cp *",
    "mv *", "* mv *",
    "tee *", "* tee *",
    "dd *", "* dd *",
    "touch *", "* touch *",
    "truncate *", "* truncate *",
    "rm *", "* rm *", "rmdir *", "* rmdir *",
    "ln *", "* ln *",
    "install *", "* install *",
    "mkdir *", "* mkdir *",
    "chmod *", "* chmod *",
    "rsync *", "* rsync *",
    "patch *", "* patch *",
    "unlink *", "* unlink *",
    "git apply*", "git checkout*", "git restore*", "git rm*", "git reset*", "git clean*",
    "git mv*", "git stash*", "git commit*", "git init*", "git add*",
    "sed -i*", "* sed -i*",
    "perl -i*", "* perl -i*",
    "perl -pi*",
    "*open(*",
    "*write_text(*",
    "*write_bytes(*",
    "*writeFile*",
    "*writeFileSync*",
    "*shutil*",
    "*os.remove*", "*os.rename*", "*os.replace*", "*os.unlink*", "*os.mkdir*", "*os.makedirs*",
    "*.unlink(*", "*.rename(*", "*.touch(*", "*.mkdir(*",
)

_WRITE_ARGV_RE = re.compile(
    r"(?:^|[\s;|&])\s*(?:(?:sudo|command|env|nice|nohup)\s+)*"
    r"(?:cp|mv|tee|dd|touch|truncate|rm|rmdir|ln|install|mkdir|chmod|rsync|patch|unlink)\b"
    r"|(?:^|[\s;|&])\s*git\s+(?:apply|checkout|restore|rm|reset|clean|mv|stash|commit|init|add)\b",
    re.I,
)
_INPLACE_RE = re.compile(r"(?:^|[\s;|&])\s*(?:sed|perl)\s+-\S*i", re.I)
_REDIRECT_RE = re.compile(r"(?:^|[^>&])(?:\d*)(?:>>|>\||>|&>>|&>)(?!&)")
_INTERPRETER_WRITE_RE = re.compile(
    r"open\s*\(|write_text\s*\(|write_bytes\s*\(|writefilesync|writefile\s*\(|shutil|"
    r"os\.(?:remove|rename|replace|unlink|mkdir|makedirs)|\.(?:unlink|rename|touch|mkdir)\s*\(",
    re.I,
)

_SESSION_POLICY_ENV = "DGC_SESSION_POLICY"
_SESSION_POLICY_VERSION = 1


def _as_names(value: Any, field: str) -> tuple[str, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Iterable):
        raise DGCConfigError(f"RuntimePolicy.{field} must be a tuple of tool names, not {value!r}")
    names = tuple(value)
    for name in names:
        if not isinstance(name, str) or not name:
            raise DGCConfigError(f"RuntimePolicy.{field} must contain non-empty tool names")
        if name in _DISPLAY or (field == "allow_tools" and name in _UNRULED_TOOLS):
            continue
        if _MCP_EXACT_RE.fullmatch(name) or _MCP_WILDCARD_RE.fullmatch(name):
            continue
        hint = (" (update_goal cannot be denied)" if name in _UNRULED_TOOLS else
                "; known tools: " + ", ".join(sorted(_DISPLAY))
                + ", and MCP routes such as mcp__app__<tool> or mcp__app__*")
        raise DGCConfigError(f"RuntimePolicy.{field} names an unknown tool {name!r}{hint}")
    return names


def _as_paths(value: Any, field: str) -> tuple[str, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Iterable):
        raise DGCConfigError(f"RuntimePolicy.{field} must be a tuple of paths, not {value!r}")
    paths = tuple(str(item) for item in value)
    if any(not item.strip() for item in paths):
        raise DGCConfigError(f"RuntimePolicy.{field} must not contain empty paths")
    return paths


@dataclass(frozen=True)
class RuntimePolicy:
    """Limits an embedder puts on every session of a :class:`~dgc_sdk.DGC` client.

    DGC enforces these in every permission mode, ``auto`` included, and on the runtime side,
    so neither the model nor a mode switch can skip them:

    * **Tools.** ``deny_tools`` and ``allow_tools`` take DGC tool names (``read_file``,
      ``bash``, ``web_fetch``, ...) and MCP routes: ``mcp__app__issue_refund`` for a
      :func:`~dgc_sdk.define_tool` tool named ``issue_refund``, or ``mcp__app__*`` for all of
      them. An unknown name raises :class:`~dgc_sdk.DGCConfigError`, and so does an
      ``mcp__app__`` route that names none of the session's own tools. With ``allow_tools``,
      every other tool is refused (the option picker ``propose_options`` stays unless denied).
    * **Paths.** DGC's file tools (read, view, write, edit, patch, search, repo map, code
      intelligence, git diff, artifact) cannot reach outside the session's ``cwd``, except to
      read inside ``extra_read_dirs``, and cannot reach ``deny_path_prefixes`` at all. Relative
      prefixes are resolved against the session's ``cwd``. A search whose tree contains a
      denied prefix is refused (in ``plan`` mode too).
    * **Network.** ``network="deny"`` (the default) refuses web fetch, web search, the browser,
      skill downloads, and MCP servers other than the application's own tools.

    The shell (``bash``, ``monitor``) and the ``python`` tool run arbitrary programs, so no rule
    on command text can hold them to the limits above. ``shell`` picks what happens instead:

    * ``"sandboxed"`` (default). DGC turns the OS sandbox on for the session (at least
      ``"preferred"``). Inside it a command has no network unless ``network="allow"``, cannot
      write outside ``cwd`` except to a temporary directory (nor inside ``cwd`` when any write
      tool is denied), and cannot read the home directory; the rest of the host filesystem is
      readable. On Linux (bubblewrap) ``/tmp`` and ``/run`` are private too; on macOS
      (sandbox-exec) ``/tmp`` is shared. In ``auto`` mode, where nobody reviews a command, the
      shell runs only there: without a sandbox, or when ``deny_path_prefixes`` names a path the
      sandbox would still show, ``bash`` and ``monitor`` are refused, and ``python`` (never
      sandboxed) always is. In the other modes each shell command is a permission request that
      your ``on_permission`` callback decides (no callback means deny); an approved command runs
      in the sandbox when one is available and unconfined otherwise.
    * ``"screened"``. The shell runs unconfined. In ``auto`` mode, commands whose text looks
      like a network call or (with a write tool denied) a file write are refused. This is best
      effort: an agent can phrase a command so the screen misses it.

    ``redact_events`` redacts secrets in audit rows.
    """

    network: NetworkMode = "deny"
    extra_read_dirs: tuple[str, ...] = ()
    deny_path_prefixes: tuple[str, ...] = ()
    deny_tools: tuple[str, ...] = ()
    allow_tools: tuple[str, ...] | None = None
    redact_events: bool = True
    shell: ShellMode = "sandboxed"

    def __post_init__(self) -> None:
        if self.network not in ("deny", "allow"):
            raise DGCConfigError("RuntimePolicy.network must be 'deny' or 'allow'")
        if self.shell not in ("sandboxed", "screened"):
            raise DGCConfigError("RuntimePolicy.shell must be 'sandboxed' or 'screened'")
        object.__setattr__(self, "deny_tools", _as_names(self.deny_tools, "deny_tools"))
        if self.allow_tools is not None:
            object.__setattr__(self, "allow_tools", _as_names(self.allow_tools, "allow_tools"))
        object.__setattr__(self, "extra_read_dirs", _as_paths(self.extra_read_dirs, "extra_read_dirs"))
        object.__setattr__(self, "deny_path_prefixes",
                           _as_paths(self.deny_path_prefixes, "deny_path_prefixes"))

    # ------------------------------------------------------------------ names ---

    def _writes_denied(self) -> bool:
        if set(self.deny_tools) & _WRITE_TOOLS:
            return True
        if self.allow_tools is not None and not (set(self.allow_tools) & _WRITE_TOOLS):
            return True
        return False

    def named_tool_denied(self, name: str, args: Mapping[str, Any] | None = None) -> bool:
        """True when this policy forbids the tool by name, independent of command screening."""
        tool, route = _subject(name, args or {})
        if tool == "mcp_call":
            if "mcp_call" in self.deny_tools or any(
                    _route_matches(route, entry) for entry in self.deny_tools
                    if entry.startswith("mcp__")):
                return True
            if self.allow_tools is None or "mcp_call" in self.allow_tools:
                return False
            return not any(_route_matches(route, entry) for entry in self.allow_tools
                           if entry.startswith("mcp__"))
        if tool in self.deny_tools:
            return True
        if self.allow_tools is not None and tool not in self.allow_tools:
            return tool not in _ALWAYS_OFFERED and tool not in _UNRULED_TOOLS
        return False

    def check_session_tools(self, custom_tools: Iterable[str]) -> None:
        """Raise when an ``mcp__app__`` route names none of the session's own tools."""
        routes = {_app_route(name) for name in custom_tools}
        for field in ("deny_tools", "allow_tools"):
            for entry in getattr(self, field) or ():
                if not entry.startswith(f"mcp__{_APP_SERVER}__") or entry.endswith("*"):
                    continue
                if entry not in routes:
                    defined = ", ".join(sorted(routes)) or "none"
                    raise DGCConfigError(
                        f"RuntimePolicy.{field} names {entry!r}, which is not one of this "
                        f"session's tools (defined: {defined})")

    def _named_rules(self) -> list[str]:
        rules: list[str] = []
        mcp_denied: list[str] = []
        for name in self.deny_tools:
            if name.startswith("mcp__"):
                mcp_denied.append(name)
            else:
                rules.append(_DISPLAY[name])
        for name in mcp_denied:
            rules.append(f"MCPCall({_escape(name[:-1]) + '*' if name.endswith('*') else _escape(name)})")
        if self.allow_tools is not None:
            allowed = set(self.allow_tools)
            for internal, display in _DISPLAY.items():
                if internal in allowed or internal in _ALWAYS_OFFERED:
                    continue
                if internal == "mcp_call":
                    routes = [name for name in allowed if name.startswith("mcp__")]
                    if routes:
                        rules.extend(f"MCPCall({pattern})" for pattern in _complement_patterns(routes))
                        continue
                rules.append(display)
        return rules

    # --------------------------------------------------------------- screening ---

    def engine_deny_rules(self, *, inspect_bash: bool = True) -> list[str]:
        """Named-tool, network-tool and write-path rules, plus command-screening globs.

        The globs (``inspect_bash``) are best-effort command screening, not a boundary; they are
        what ``shell="screened"`` applies in ``auto`` mode. :func:`compile_session` builds what a
        session actually gets.
        """
        rules = _unique(self._named_rules())
        if self.network == "deny":
            rules = _unique(rules + list(_NETWORK_TOOLS))
            if inspect_bash:
                rules = _unique(rules + [f"Bash({pattern})" for pattern in _NET_BASH_PATTERNS])
        if self._writes_denied() and inspect_bash:
            rules = _unique(rules + [f"Bash({pattern})" for pattern in _WRITE_BASH_PATTERNS])
        for prefix in self.deny_path_prefixes:
            text = str(prefix).rstrip("/")
            if text:
                rules = _unique(rules + [f"{tool}({_escape(text)}/**)"
                                         for tool in ("Write", "Edit", "MultiEdit", "ApplyPatch")])
        return rules

    # -------------------------------------------------------------- decisions ---

    def evaluate(self, request: PermissionRequest, *, cwd: Path | None) -> str | None:
        """Classify one permission request.

        ``"deny"`` — the policy forbids it. ``"once"`` — the policy itself allows it (a read in
        ``extra_read_dirs``, or a search that stays clear of denied paths; the request exists
        only so the SDK can check it). ``"screen"`` — the command text looks like a network call
        or file write; a best-effort signal a reviewing callback may overrule. ``None`` — the
        policy has no opinion; the callback decides.
        """
        name = request.name or ""
        args = request.args if isinstance(request.args, Mapping) else {}
        if self.named_tool_denied(name, args):
            return "deny"
        if name in _PATH_TOOLS:
            verdict = self._path_verdict(name, args, cwd)
            if verdict is not None:
                return verdict
        command = str(args.get("command") or request.command or "")
        if name in ("bash", "monitor"):
            if self.network == "deny" and _looks_like_network(command):
                return "screen"
            if self._writes_denied() and _looks_like_write(command):
                return "screen"
        if name == "python" and self._writes_denied():
            if _looks_like_write(str(args.get("code") or "")):
                return "screen"
        return None

    def decision(self, request: PermissionRequest, *, cwd: Path | None) -> PermissionAction | None:
        """Return ``deny`` when this policy forbids the call; ``None`` to defer to the callback."""
        verdict = self.evaluate(request, cwd=cwd)
        if verdict in ("deny", "screen"):
            return "deny"
        if verdict == "once":
            return "once"
        return None

    def _path_verdict(self, name: str, args: Mapping[str, Any], cwd: Path | None) -> str | None:
        raw = str(args.get("path") or "")
        if not raw and name not in _SEARCH_TOOLS:
            return None
        target = _resolve(raw or ".", cwd)
        if target is None:
            return "deny"
        denied = self._denied_prefixes(cwd)
        if any(_within(target, prefix) for prefix in denied):
            return "deny"
        if name in _SEARCH_TOOLS and any(_within(prefix, target) for prefix in denied):
            return "deny"
        if cwd is not None and not _within(target, cwd.resolve()):
            if name in _READ_PATH_TOOLS and any(
                    _within(target, extra) for extra in self._extra_dirs(cwd)):
                return "once"
            return "deny"
        if name in _SEARCH_TOOLS and self._search_guard(cwd):
            return "once"
        return None

    def _denied_prefixes(self, cwd: Path | None) -> list[Path]:
        found: list[Path] = []
        for prefix in self.deny_path_prefixes:
            resolved = _resolve(str(prefix), cwd)
            if resolved is not None:
                found.append(resolved)
        return found

    def _extra_dirs(self, cwd: Path | None) -> list[Path]:
        found: list[Path] = []
        for extra in self.extra_read_dirs:
            resolved = _resolve(str(extra), cwd)
            if resolved is not None:
                found.append(resolved)
        return found

    def _search_guard(self, cwd: Path | None) -> bool:
        """True when a denied prefix sits inside a tree the agent may search."""
        roots = ([cwd.resolve()] if cwd is not None else []) + self._extra_dirs(cwd)
        return any(_within(prefix, root) for prefix in self._denied_prefixes(cwd) for root in roots)

    def _path_denied(self, raw: str, cwd: Path | None) -> bool:
        return self._path_verdict("read_file", {"path": raw}, cwd) == "deny"


def _unique(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _escape(text: str) -> str:
    """Quote fnmatch metacharacters so a literal path or route matches only itself."""
    return re.sub(r"([\[\]*?])", lambda m: "[[]" if m.group(1) == "[" else f"[{m.group(1)}]", text)


def _bracket(chars: Iterable[str]) -> str:
    items = sorted(set(chars))
    tail = ["-"] if "-" in items else []
    head = ["]"] if "]" in items else []
    body = [c for c in items if c not in ("-", "]", "!", "^")]
    bang = ["!"] if "!" in items else []
    caret = ["^"] if "^" in items else []
    return "".join(head + body + bang + caret + tail)


def _complement_patterns(allowed: Iterable[str]) -> list[str]:
    """fnmatch patterns that match every string except the allowed ones.

    An entry ending in ``*`` allows every string starting with the text before it. DGC rules can
    only deny, so an allowlist becomes denies of everything else: one pattern per branch point
    of the allowed strings (``[!...]*`` for "diverges here", the prefix itself when it is not an
    allowed string, ``?*`` for "continues past an allowed string").
    """
    root: dict = {}
    for entry in allowed:
        wildcard = entry.endswith("*")
        text = entry[:-1] if wildcard else entry
        node = root
        covered = False
        for char in text:
            if "$all" in node:
                covered = True
                break
            node = node.setdefault(char, {})
        if covered or "$all" in node:
            continue
        if wildcard:
            node.clear()
            node["$all"] = True
        else:
            node["$end"] = True
    patterns: list[str] = []

    def walk(prefix: str, node: dict) -> None:
        if "$all" in node:
            return
        if prefix and "$end" not in node:
            patterns.append(_escape(prefix))
        chars = sorted(key for key in node if len(key) == 1)
        patterns.append(_escape(prefix) + (f"[!{_bracket(chars)}]*" if chars else "?*"))
        for char in chars:
            walk(prefix + char, node[char])

    walk("", root)
    return patterns


def _app_route(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", str(name)).strip("_") or "unnamed"
    return f"mcp__{_APP_SERVER}__{safe}"


def _subject(name: str, args: Mapping[str, Any]) -> tuple[str, str]:
    """(tool, MCP route) the way DGC's permission engine sees a call."""
    if name.startswith("mcp__"):
        return "mcp_call", name
    if name == "mcp_call":
        return "mcp_call", str(args.get("name") or "")
    return name, ""


def _route_matches(route: str, entry: str) -> bool:
    if entry.endswith("*"):
        return route.startswith(entry[:-1])
    return route == entry


def _resolve(raw: str, cwd: Path | None) -> Path | None:
    try:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = (cwd / path) if cwd is not None else path
        return path.resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _looks_like_network(command: str) -> bool:
    low = command.lower()
    return any(hint in low for hint in _NET_HINTS)


def _looks_like_write(command: str) -> bool:
    """True when a shell/python snippet is a file-write, not merely a read or ``2>&1``."""
    if not command or not command.strip():
        return False
    if _REDIRECT_RE.search(command):
        return True
    if _WRITE_ARGV_RE.search(command) or _INPLACE_RE.search(command):
        return True
    return bool(_INTERPRETER_WRITE_RE.search(command))


def sandbox_network_enabled(policy: RuntimePolicy | None) -> bool:
    return bool(policy and policy.network == "allow")


def inspect_bash_for_engine(*, on_permission, permission_mode: str) -> bool:
    """Compile bash write/network globs only when nobody will answer a permission_request.

    Auto mode never raises ``permission_request``, so the engine must deny itself.
    An interactive staff callback must see every Bash ask, including redirects.
    """
    return on_permission is None or permission_mode == "auto"


# ---------------------------------------------------------------- settings ---

def permission_settings(value: PermissionPolicy | Mapping[str, Any] | None, *,
                        mode: PermissionMode | None, default_mode: PermissionMode,
                        on_permission: Any) -> tuple[PermissionMode, UnhandledPolicy]:
    """Normalise ``session(permissions=...)`` into ``(mode, unhandled)``.

    ``unhandled`` says what happens to a permission request your ``on_permission`` callback
    does not answer. ``"deny"``: it is denied and the agent carries on (no callback means every
    request is denied). ``"callback"``: every request must go to your callback, so ``session()``
    refuses to start without one; a request it still leaves unanswered (it raised, returned
    something else, or ran past ``decision_timeout``) is denied.
    """
    if value is None:
        data: dict[str, Any] = {}
    elif isinstance(value, PermissionPolicy):
        data = {"mode": value.mode, "unhandled": value.unhandled}
    elif isinstance(value, Mapping):
        data = dict(value)
        unknown = sorted(set(data) - {"mode", "unhandled"})
        if unknown:
            raise DGCConfigError(f"permissions has an unknown key {unknown[0]!r} "
                                 "(expected 'mode' and 'unhandled')")
    else:
        raise DGCConfigError("permissions must be a PermissionPolicy or a mapping, "
                             f"not {type(value).__name__}")
    unhandled = data.get("unhandled") or "deny"
    if unhandled not in ("deny", "callback"):
        raise DGCConfigError("permissions.unhandled must be 'deny' or 'callback'")
    chosen = mode or data.get("mode") or default_mode
    if chosen not in ("default", "acceptEdits", "plan", "auto"):
        raise DGCConfigError("invalid permission mode")
    if unhandled == "callback" and on_permission is None:
        raise DGCConfigError(
            "permissions.unhandled='callback' needs on_permission; pass a callback or use "
            "unhandled='deny' to deny every request")
    return chosen, unhandled


def sandbox_requirement(value: SandboxPolicy | Mapping[str, Any] | str | None) -> SandboxRequirement:
    """Normalise ``sandbox=...`` (a SandboxPolicy, ``{"requirement": ...}``, or the bare word)."""
    if value is None:
        return "off"
    if isinstance(value, SandboxPolicy):
        requirement = value.requirement
    elif isinstance(value, str):
        requirement = value
    elif isinstance(value, Mapping):
        unknown = sorted(set(value) - {"requirement"})
        if unknown:
            raise DGCConfigError(f"sandbox has an unknown key {unknown[0]!r} "
                                 "(expected 'requirement')")
        requirement = value.get("requirement") or "off"
    else:
        raise DGCConfigError(f"sandbox must be a SandboxPolicy or a mapping, not {type(value).__name__}")
    if requirement not in ("required", "preferred", "off"):
        raise DGCConfigError("sandbox.requirement must be required, preferred, or off")
    return requirement  # type: ignore[return-value]


def sandbox_precheck(requirement: SandboxRequirement) -> None:
    """Fail early for ``required`` when this host plainly has no backend.

    The runtime makes the final call when a session starts (it reports its sandbox in the ready
    handshake); this only catches the obvious case without starting a child.
    """
    if requirement != "required":
        return
    if sys.platform.startswith("linux"):
        names = ("bwrap",)
    elif sys.platform == "darwin":
        names = ("sandbox-exec",)
    else:
        raise DGCUnsupportedError(
            f"sandbox.requirement is 'required' but DGC has no sandbox backend on {sys.platform}")
    import shutil
    if not any(shutil.which(name) for name in names):
        raise DGCUnsupportedError(
            f"sandbox.requirement is 'required' but this host has no {names[0]}")


# ------------------------------------------------------------ per session ---

@dataclass(frozen=True)
class SessionPlan:
    """What one session's runtime is told, and how to confirm it took effect."""

    env: dict[str, str]
    requirement: SandboxRequirement
    policy: RuntimePolicy | None
    notes: tuple[str, ...] = ()

    @property
    def payload(self) -> str:
        return self.env.get(_SESSION_POLICY_ENV, "")

    def confirm(self, ready: Mapping[str, Any]) -> SandboxStatus:
        """Check the ready handshake: the runtime read this policy, and has the sandbox asked for.

        Raises :class:`~dgc_sdk.DGCUnsupportedError` when the runtime cannot honour it.
        """
        caps = ready.get("capabilities") if isinstance(ready.get("capabilities"), Mapping) else {}
        report = caps.get("session_policy") if isinstance(caps, Mapping) else None
        if not self.payload:
            return SandboxStatus(requirement=self.requirement, active=False)
        version = str(ready.get("version") or "unknown")
        if not isinstance(report, Mapping):
            raise DGCUnsupportedError(
                f"DGC runtime {version} cannot apply a session policy (RuntimePolicy or sandbox); "
                "CLI 0.41.6 or newer is required")
        if report.get("error"):
            raise DGCUnsupportedError(f"DGC runtime {version} rejected the session policy: "
                                      f"{report.get('error')}")
        digest = hashlib.sha256(self.payload.encode("utf-8")).hexdigest()
        if report.get("digest") != digest:
            raise DGCUnsupportedError(
                f"DGC runtime {version} did not confirm this session's policy")
        self._confirm_tools(ready)
        for note in self.notes:
            warnings.warn(f"DGC session policy: {note}", RuntimeWarning, stacklevel=3)
        backend = str(report.get("sandbox") or "")
        if self.requirement == "required" and not backend:
            raise DGCUnsupportedError(
                "sandbox.requirement is 'required' but the DGC runtime has no OS sandbox "
                "(bubblewrap on Linux, sandbox-exec on macOS)")
        if self.requirement == "preferred" and not backend:
            detail = ("; in auto mode the shell is refused, and in the other modes an approved "
                      "command runs unconfined" if self.policy is not None
                      and self.policy.shell == "sandboxed" else "; shell commands run unconfined")
            reason = "no OS sandbox is available to the DGC runtime" + detail
            warnings.warn(f"DGC sandbox 'preferred' fell back: {reason}", RuntimeWarning,
                          stacklevel=3)
            return SandboxStatus(requirement=self.requirement, active=False, reason=reason)
        return SandboxStatus(requirement=self.requirement, active=bool(backend), backend=backend)

    def _confirm_tools(self, ready: Mapping[str, Any]) -> None:
        policy = self.policy
        tools = ready.get("tools")
        if policy is None or not isinstance(tools, list):
            return
        runtime = {str(name) for name in tools}
        if policy.allow_tools is None:
            return
        allowed = set(policy.allow_tools) | _ALWAYS_OFFERED | _UNRULED_TOOLS
        unknown = sorted(name for name in runtime if name not in _DISPLAY
                         and name not in allowed and not name.startswith("mcp__"))
        if unknown:
            raise DGCUnsupportedError(
                f"RuntimePolicy.allow_tools cannot refuse the runtime's tool {unknown[0]!r}, "
                "which this dgc-sdk does not know; upgrade dgc-sdk or allow it")


def compile_session(policy: RuntimePolicy | None, *, cwd: Path, mode: PermissionMode,
                    on_permission: Any, sandbox: SandboxRequirement,
                    tools: Sequence[str] = ()) -> SessionPlan:
    """Turn a RuntimePolicy and sandbox choice into the runtime's per-session policy.

    The result travels to ``dgc serve`` in the ``DGC_SESSION_POLICY`` environment variable.
    Nothing is written to any config.json, so a policy never outlives its session and never
    touches the user's own ``~/.dgc`` (``inherit_user_state=True`` included).
    """
    requirement: SandboxRequirement = sandbox
    if policy is None:
        if requirement == "off":
            return SessionPlan(env={}, requirement="off", policy=None)
        payload = {"version": _SESSION_POLICY_VERSION, "sandbox": requirement}
        return SessionPlan(env={_SESSION_POLICY_ENV: _dump(payload)}, requirement=requirement,
                           policy=None)
    policy.check_session_tools(tools)
    workspace = cwd.resolve()
    deny = policy._named_rules()
    ask: list[str] = []
    auto_deny: list[str] = []
    notes: list[str] = []
    if policy.network == "deny":
        deny += list(_NETWORK_TOOLS)
        # MCP servers other than the application's own tools (inherit_user_state brings the
        # user's) run as unconfined processes, so they are refused.
        deny += [f"MCPCall({pattern})" for pattern in _complement_patterns([f"mcp__{_APP_SERVER}__*"])]
    denied = policy._denied_prefixes(workspace)
    for prefix in denied:
        text = _escape(str(prefix))
        for tool in _PATH_RULE_TOOLS:
            deny += [f"{tool}({text})", f"{tool}({text}/**)"]
    if policy._search_guard(workspace):
        ask += [_DISPLAY[name] for name in sorted(_SEARCH_TOOLS)]
    ask_external = bool(policy._extra_dirs(workspace))
    (ask if ask_external else deny).append("ExternalDirectory")
    sandbox_read_only = False
    shell_requires_sandbox = False
    if policy.shell == "sandboxed":
        shell_requires_sandbox = True
        if requirement == "off":
            requirement = "preferred"
        sandbox_read_only = policy._writes_denied()
        exposed = [prefix for prefix in denied if not _sandbox_hides(prefix, workspace)]
        if exposed:
            # The sandbox shows the rest of the host read-only, so it cannot keep the shell
            # away from these paths. Unattended, the shell is refused.
            auto_deny += ["Bash", "Monitor"]
            if mode == "auto":
                notes.append(f"RuntimePolicy.deny_path_prefixes names {exposed[0]}, which the OS "
                             "sandbox cannot hide, so bash and monitor are refused in auto mode")
    else:
        if policy.network == "deny":
            auto_deny += [f"Bash({pattern})" for pattern in _NET_BASH_PATTERNS]
        if policy._writes_denied():
            auto_deny += [f"Bash({pattern})" for pattern in _WRITE_BASH_PATTERNS]
    payload: dict[str, Any] = {
        "version": _SESSION_POLICY_VERSION,
        "deny": _unique(deny),
        "ask": _unique(ask),
        "auto_deny": _unique(auto_deny),
        "sandbox": requirement,
        "sandbox_network": policy.network == "allow",
        "sandbox_read_only": sandbox_read_only,
        "shell_requires_sandbox": shell_requires_sandbox,
    }
    return SessionPlan(env={_SESSION_POLICY_ENV: _dump(payload)}, requirement=requirement,
                       policy=policy, notes=tuple(notes))


def _dump(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _sandbox_hides(path: Path, workspace: Path) -> bool:
    """True when DGC's sandbox surely masks ``path``, which lies outside cwd.

    Both backends hide the account's home directory. Bubblewrap also gives the shell private
    ``/root``, ``/tmp`` and ``/run``. The runtime's own HOME can differ from this process's
    (a private one under state_dir), so only the account home counts.
    """
    if _within(path, workspace):
        return False
    hidden: list[Path] = []
    try:
        import pwd
        hidden.append(Path(pwd.getpwuid(os.getuid()).pw_dir))
    except (ImportError, KeyError, OSError, AttributeError):
        pass
    if sys.platform.startswith("linux"):
        hidden += [Path("/root"), Path("/tmp"), Path("/run")]
    for base in hidden:
        try:
            base = base.resolve()
        except (OSError, RuntimeError):
            continue
        # A workspace inside a masked tree is linked back in; nothing else under it is.
        if _within(path, base):
            return True
    return False


def resolve_permission(policy: RuntimePolicy | None, request: PermissionRequest, *,
                       cwd: Path | None, permission_mode: str, on_permission: Any,
                       ask: Callable[[], Any]) -> PermissionAction:
    """Answer one ``permission_request``: the policy first, then the callback.

    A policy deny is final. A request the policy raised only to check it (``"once"``) is
    answered without the callback. Command screening (``"screen"``) denies unless a reviewing
    callback is present outside auto mode; then the callback sees the request and decides.
    """
    if policy is not None:
        verdict = policy.evaluate(request, cwd=cwd)
        if verdict == "deny":
            return "deny"
        if verdict == "once":
            return "once"
        if verdict == "screen" and (on_permission is None or permission_mode == "auto"):
            return "deny"
    action = ask()
    return action if action in ("once", "always", "deny") else "deny"
