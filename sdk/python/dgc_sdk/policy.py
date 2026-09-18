"""Embedder policy: extra tool/path/network rules on top of cwd isolation."""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from .types import PermissionAction, PermissionRequest

NetworkMode = Literal["deny", "allow"]

_DISPLAY = {
    "read_file": "Read", "view_image": "ViewImage", "write_file": "Write", "edit_file": "Edit",
    "multi_edit": "MultiEdit", "apply_patch": "ApplyPatch", "bash": "Bash", "python": "Python",
    "web_fetch": "WebFetch", "web_search": "WebSearch", "browser": "Browser",
    "monitor": "Monitor", "glob": "Glob", "grep": "Grep", "task": "Task",
}

_WRITE_TOOLS = frozenset({"write_file", "edit_file", "multi_edit", "apply_patch"})

_NET_HINTS = (
    "curl ", "wget ", "nc ", "ncat ", "ssh ", "scp ", "sftp ",
    "http://", "https://", "ftp://", "invoke-webrequest", "fetch(",
)

# Engine globs. Deny matches ANY compound subcommand. `*>[!&]*` is `>`/`>>`
# except `>&fd` (so `ls 2>&1` still runs). `/dev/null` redirects are denied —
# fnmatch cannot carve them out.
_WRITE_BASH_PATTERNS = (
    "*>[!&]*",
    "cp *", "* cp *",
    "mv *", "* mv *",
    "tee *", "* tee *",
    "dd *", "* dd *",
    "touch *", "* touch *",
    "truncate *", "* truncate *",
    "sed -i*", "* sed -i*",
    "perl -i*", "* perl -i*",
    "perl -pi*",
    "*open(*",
    "*write_text(*",
    "*write_bytes(*",
    "*writeFile*",
    "*writeFileSync*",
)

_WRITE_ARGV_RE = re.compile(
    r"(?:^|[\s;|&])\s*(?:(?:sudo|command|env|nice|nohup)\s+)*"
    r"(?:cp|mv|tee|dd|touch|truncate)\b",
    re.I,
)
_INPLACE_RE = re.compile(r"(?:^|[\s;|&])\s*(?:sed|perl)\s+-\S*i", re.I)
_REDIRECT_RE = re.compile(r"(?:^|[^>&])(?:\d*)(?:>>|>\||>|&>>|&>)(?!&)")
_INTERPRETER_WRITE_RE = re.compile(
    r"open\s*\(|write_text\s*\(|write_bytes\s*\(|writefilesync|writefile\s*\(",
    re.I,
)


@dataclass(frozen=True)
class RuntimePolicy:
    """Fail-closed extras the embedder sets. Cwd containment still always applies.

    Denying any write-family tool (``write_file``, ``edit_file``, ``multi_edit``,
    ``apply_patch``) also denies bash file-writes — redirects, ``tee``, ``cp``/``mv``,
    inplace ``sed``/``perl``, interpreter ``open``/``write`` — the same way
    ``network="deny"`` inspects curl-shaped bash. Those rules are compiled into
    isolated ``permissions.deny`` so auto mode cannot skip them.
    """

    network: NetworkMode = "deny"
    extra_read_dirs: tuple[str, ...] = ()
    deny_path_prefixes: tuple[str, ...] = ()
    deny_tools: tuple[str, ...] = ()
    allow_tools: tuple[str, ...] | None = None
    redact_events: bool = True

    def _writes_denied(self) -> bool:
        if set(self.deny_tools) & _WRITE_TOOLS:
            return True
        if self.allow_tools is not None and not (set(self.allow_tools) & _WRITE_TOOLS):
            return True
        return False

    def engine_deny_rules(self) -> list[str]:
        """Rules for isolated ``permissions.deny``. Deny wins in every mode, including auto."""
        rules: list[str] = []
        for name in self.deny_tools:
            display = _DISPLAY.get(name, name)
            if display and display not in rules:
                rules.append(display)
        if self.allow_tools is not None:
            allowed = set(self.allow_tools) | {"propose_options"}
            for internal, display in _DISPLAY.items():
                if internal not in allowed and display not in rules:
                    rules.append(display)
        if self.network == "deny":
            for display in ("WebFetch", "WebSearch", "Browser"):
                if display not in rules:
                    rules.append(display)
            for pattern in ("*curl*", "*wget*", "*http://*", "*https://*"):
                bash = f"Bash({pattern})"
                if bash not in rules:
                    rules.append(bash)
        if self._writes_denied():
            for pattern in _WRITE_BASH_PATTERNS:
                bash = f"Bash({pattern})"
                if bash not in rules:
                    rules.append(bash)
        for prefix in self.deny_path_prefixes:
            text = str(prefix).rstrip("/")
            if not text:
                continue
            glob = text + "/**"
            for tool in ("Write", "Edit", "MultiEdit", "ApplyPatch"):
                rules.append(f"{tool}({glob})")
        return rules

    def decision(self, request: PermissionRequest, *, cwd: Path | None) -> PermissionAction | None:
        """Return ``deny`` when this policy forbids the call; ``None`` to defer to the callback."""
        name = request.name or ""
        if name in self.deny_tools:
            return "deny"
        if self.allow_tools is not None and name not in self.allow_tools:
            if name not in ("propose_options",):
                return "deny"
        args = request.args if isinstance(request.args, dict) else {}
        path = _tool_path(name, args)
        if path and self._path_denied(path, cwd):
            return "deny"
        command = str(args.get("command") or request.command or "")
        if self.network == "deny" and name in ("bash", "monitor"):
            if _looks_like_network(command):
                return "deny"
        if self._writes_denied() and name in ("bash", "monitor"):
            if _looks_like_write(command):
                return "deny"
        if self._writes_denied() and name == "python":
            code = str(args.get("code") or "")
            if _looks_like_write(code):
                return "deny"
        return None

    def _path_denied(self, raw: str, cwd: Path | None) -> bool:
        try:
            path = Path(raw)
            if not path.is_absolute():
                path = (cwd / path) if cwd is not None else path
            resolved = path.resolve()
        except (OSError, RuntimeError, ValueError):
            return True
        for prefix in self.deny_path_prefixes:
            try:
                base = Path(prefix).expanduser().resolve()
            except (OSError, RuntimeError, ValueError):
                continue
            try:
                resolved.relative_to(base)
                return True
            except ValueError:
                continue
        if cwd is not None:
            try:
                resolved.relative_to(cwd.resolve())
                return False
            except ValueError:
                extras = []
                for extra in self.extra_read_dirs:
                    try:
                        extras.append(Path(extra).expanduser().resolve())
                    except (OSError, RuntimeError, ValueError):
                        continue
                for extra in extras:
                    try:
                        resolved.relative_to(extra)
                        return False
                    except ValueError:
                        continue
                return True
        return False


def _tool_path(name: str, args: dict) -> str:
    if name in ("write_file", "edit_file", "read_file", "view_image"):
        return str(args.get("path") or "")
    if name == "apply_patch":
        return str(args.get("path") or "")
    return ""


def _looks_like_network(command: str) -> bool:
    low = command.lower()
    return any(hint in low for hint in _NET_HINTS) or bool(urlsplit(command).scheme in ("http", "https"))


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
