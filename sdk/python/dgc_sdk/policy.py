"""Embedder policy: extra tool/path/network rules on top of cwd isolation."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from .types import PermissionAction, PermissionRequest

NetworkMode = Literal["deny", "allow"]

_NET_HINTS = (
    "curl ", "wget ", "nc ", "ncat ", "ssh ", "scp ", "sftp ",
    "http://", "https://", "ftp://", "invoke-webrequest", "fetch(",
)


@dataclass(frozen=True)
class RuntimePolicy:
    """Fail-closed extras the embedder sets. Cwd containment still always applies."""

    network: NetworkMode = "deny"
    extra_read_dirs: tuple[str, ...] = ()
    deny_path_prefixes: tuple[str, ...] = ()
    deny_tools: tuple[str, ...] = ()
    allow_tools: tuple[str, ...] | None = None
    redact_events: bool = True

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
        if self.network == "deny" and name in ("bash", "monitor"):
            command = str(args.get("command") or request.command or "")
            if _looks_like_network(command):
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


def sandbox_network_enabled(policy: RuntimePolicy | None) -> bool:
    return bool(policy and policy.network == "allow")
