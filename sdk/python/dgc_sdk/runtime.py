"""Launch an isolated ``dgc serve`` child. Host ~/.dgc is not used unless inherited."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Mapping

from .errors import DGCConfigError, DGCUnsupportedError

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SDK_ROOT = Path(__file__).resolve().parents[1]
_CACHED_ARGV: list[str] | None = None


def repo_root() -> Path:
    return _REPO_ROOT


def sdk_root() -> Path:
    return _SDK_ROOT


def _python_can_serve(python: str) -> bool:
    if not python or not Path(python).exists():
        return False
    if python == sys.executable:
        try:
            import prompt_toolkit  # noqa: F401
            import dgc.headless  # noqa: F401
        except ImportError:
            return False
        return True
    return os.access(python, os.X_OK)


def default_runtime_argv() -> list[str]:
    """Prefer this checkout's venv so local builds do not need a published CLI."""
    global _CACHED_ARGV
    if _CACHED_ARGV is not None:
        return list(_CACHED_ARGV)
    env_py = os.environ.get("DGC_PYTHON") or os.environ.get("DGC_RUNTIME_PYTHON")
    candidates: list[str] = []
    if env_py:
        candidates.append(env_py)
    candidates.append(sys.executable)
    venv = _REPO_ROOT / ".venv" / "bin" / "python"
    if venv.is_file():
        candidates.append(str(venv))
    for python in candidates:
        if _python_can_serve(python):
            _CACHED_ARGV = [python, "-m", "dgc", "serve"]
            return list(_CACHED_ARGV)
    raise DGCConfigError(
        "no DGC runtime found; set DGC_PYTHON to a Python that can import dgc "
        f"(looked at {candidates})"
    )


def isolated_env(state_dir: Path, *, extra: Mapping[str, str] | None = None,
                 inherit_user_state: bool = False,
                 project_root: Path | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if not inherit_user_state:
        for key in ("DGC_API_KEY", "DGC_SEARCH_API_KEY", "DGC_SUBAGENT_API_KEY",
                    "DGC_FALLBACK_API_KEY"):
            env.pop(key, None)
        home = state_dir / "home"
        (home / ".dgc").mkdir(parents=True, exist_ok=True)
        (home / ".config").mkdir(parents=True, exist_ok=True)
        (home / ".local" / "share").mkdir(parents=True, exist_ok=True)
        (home / ".local" / "state").mkdir(parents=True, exist_ok=True)
        env["HOME"] = str(home)
        env["USERPROFILE"] = str(home)
        env["DGC_HOME"] = str(home)
        env["DGC_SDK_ISOLATED"] = "1"
        if project_root is not None:
            env["DGC_PROJECT_ROOT"] = str(Path(project_root).resolve())
        env["XDG_CONFIG_HOME"] = str(home / ".config")
        env["XDG_DATA_HOME"] = str(home / ".local" / "share")
        env["XDG_STATE_HOME"] = str(home / ".local" / "state")
    if extra:
        env.update(extra)
    path_parts = [str(_REPO_ROOT), str(_SDK_ROOT)]
    if env.get("PYTHONPATH"):
        path_parts.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(path_parts)
    return env


def write_isolated_config(state_dir: Path, values: Mapping[str, object]) -> Path:
    home = state_dir / "home" / ".dgc"
    home.mkdir(parents=True, exist_ok=True)
    path = home / "config.json"
    current: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                current = loaded
        except json.JSONDecodeError as exc:
            raise DGCConfigError("isolated config.json is not valid JSON") from exc
    incoming = {key: value for key, value in values.items() if value is not None}
    if "trusted_dirs" in incoming or "trusted_dirs" in current:
        merged: list = []
        for item in list(current.get("trusted_dirs") or []) + list(incoming.get("trusted_dirs") or []):
            text = str(item)
            if text and text not in merged:
                merged.append(text)
        incoming["trusted_dirs"] = merged
    current.update(incoming)
    path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    return path


def require_sandbox(requirement: str) -> str | None:
    """Return the backend name, or raise if ``required`` isolation is unavailable."""
    if requirement not in ("required", "preferred", "off"):
        raise DGCConfigError("sandbox.requirement must be required, preferred, or off")
    if requirement == "off":
        return None
    try:
        from dgc.sandbox import available
    except ImportError as exc:
        if requirement == "required":
            raise DGCUnsupportedError("sandbox is required but dgc.sandbox could not be imported") from exc
        return None
    backend = available()
    if requirement == "required" and not backend:
        raise DGCUnsupportedError(
            "sandbox.requirement is 'required' but this host has no bwrap/sandbox-exec")
    return backend
