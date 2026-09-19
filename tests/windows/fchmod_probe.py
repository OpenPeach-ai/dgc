"""M0 diagnostic: do DGC's config and session saves survive a Python without ``os.fchmod``?

``dgc/config.py`` (``_write_private_json``) and ``dgc/sessions.py`` (``_atomic_write``) call
``os.fchmod`` and catch only ``OSError``. CPython added ``os.fchmod`` on Windows in 3.13, so on
older Windows interpreters the call raises ``AttributeError``. This probe runs both real save
paths under a throwaway HOME and prints what happened. Always exits 0 (diagnostic only).

    python tests/windows/fchmod_probe.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import traceback
from pathlib import Path

# Isolate every user-state location BEFORE dgc computes its paths at import time.
_HOME = Path(tempfile.mkdtemp(prefix="dgc-fchmod-home-")).resolve()
for _name in ("HOME", "USERPROFILE", "DGC_HOME"):
    os.environ[_name] = str(_HOME)
os.environ.pop("XDG_CONFIG_HOME", None)
os.environ.pop("XDG_DATA_HOME", None)

ROOT = Path(__file__).resolve().parents[2]
if os.environ.get("DGC_SDK_TEST_INSTALLED") != "1":
    sys.path.insert(0, str(ROOT))


def _attempt(label: str, fn) -> str:
    try:
        fn()
        return "OK"
    except Exception as exc:  # noqa: BLE001 - a diagnostic records every failure shape
        print(f"--- {label} traceback ---", flush=True)
        print("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)[-4:]).rstrip(),
              flush=True)
        return f"{type(exc).__name__}"


def _safe_stdio() -> None:
    """Never let this diagnostic die printing non-ASCII to a cp1252 console (Windows, no UTF-8
    mode): the encoding is left alone, unencodable characters become escapes."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except (AttributeError, ValueError):
            pass


def main() -> int:
    _safe_stdio()
    from dgc import config as dgc_config
    from dgc import sessions

    project = Path(tempfile.mkdtemp(prefix="dgc-fchmod-project-")).resolve()

    def config_save():
        dgc_config._write_private_json(_HOME / ".dgc" / "probe-config.json", {"probe": True})

    def session_save():
        path = sessions.new_path(project)
        sessions.save(path, [{"role": "user", "content": "hello"}], project)

    config_result = _attempt("config save", config_save)
    session_result = _attempt("session save", session_save)
    print(f"M0-RESULT fchmod platform={sys.platform} python={sys.version.split()[0]} "
          f"has_os_fchmod={'yes' if hasattr(os, 'fchmod') else 'no'} "
          f"config_save={config_result} session_save={session_result}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
