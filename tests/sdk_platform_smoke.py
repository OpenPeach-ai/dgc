"""Hermetic per-OS proof of the Python SDK: a real `dgc serve` against the scripted mock model.

    python tests/sdk_platform_smoke.py            # run from outside the checkout, like sdk_installed.py

Covers: a run, a custom tool (or, where the platform has no tool transport, a typed refusal),
a policy denial, cancellation, and cleanup (no `dgc serve` or tool-bridge process outlives
close()). No network, no secrets: the model is tests/test_dgc_sdk.py's loopback mock.
Proposed location: tests/sdk_platform_smoke.py (draft; validated on Linux only).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_dgc_sdk as base  # noqa: E402  (the shared mock model)
from dgc_sdk import DGC, DGCUnsupportedError, RuntimePolicy, define_tool  # noqa: E402

WINDOWS = os.name == "nt"
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"  -- {detail}" if detail and not ok else ""), flush=True)


def _process_table() -> dict[int, int]:
    """pid -> ppid for every process, without psutil."""
    if WINDOWS:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=60).stdout
        rows = json.loads(out or "[]")
        return {int(r["ProcessId"]): int(r["ParentProcessId"]) for r in rows}
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=30).stdout
    table = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2:
            table[int(parts[0])] = int(parts[1])
    return table


def _descendants(root: int) -> set[int]:
    table = _process_table()
    found, frontier = set(), {root}
    while frontier:
        nxt = {pid for pid, ppid in table.items() if ppid in frontier and pid not in found}
        found |= nxt
        frontier = nxt
    return found


def _alive(pids: set[int]) -> set[int]:
    table = _process_table()
    return {pid for pid in pids if pid in table}


def main() -> int:
    home = Path(tempfile.mkdtemp(prefix="dgc-smoke-home-"))
    os.environ["HOME"] = str(home)
    os.environ["USERPROFILE"] = str(home)
    state = Path(tempfile.mkdtemp(prefix="dgc-smoke-state-"))
    work = Path(tempfile.mkdtemp(prefix="dgc-smoke-work-"))
    (work / "README.md").write_text("empty cart checkout\n", encoding="utf-8")
    server, base_url = base._start_model()
    perms = {"mode": "auto", "unhandled": "deny"}
    tracked: set[int] = set()

    def client(**kw):
        if kw.get("policy") is not None:
            kw.setdefault("sandbox", {"requirement": "preferred"})
        return DGC(state_dir=state, model="sdk-model", base_url=base_url, api_key="sk-local", **kw)

    try:
        # 1. a plain run
        base._Model.behavior = "text"
        with client() as dgc:
            session = dgc.session(cwd=work, permissions=perms)
            result = session.run("Summarize README. Do not edit files.", timeout=120)
            check("run completes", result.status == "completed", result.status)
            check("run returns the model text", "checkout" in result.final_text.lower(), result.final_text)
            if session.raw.pid:
                tracked |= {session.raw.pid} | _descendants(session.raw.pid)

        # 2. a custom tool (host-process handler over the MCP bridge)
        base._Model.behavior = "mcp"
        seen: list[dict] = []
        tool = define_tool("sku_lookup", "Look up a SKU",
                           {"type": "object", "properties": {"sku": {"type": "string"}}, "required": ["sku"]},
                           lambda args: seen.append(dict(args)) or {"name": "Widget", "sku": args.get("sku")})
        try:
            with client() as dgc:
                session = dgc.session(cwd=work, permissions=perms, tools=[tool])
                if session.raw.pid:
                    tracked |= {session.raw.pid}
                result = session.run("look up sku A-1", timeout=120)
                if session.raw.pid:
                    tracked |= _descendants(session.raw.pid)
            check("custom tool handler ran", bool(seen) and seen[0].get("sku") == "A-1", repr(seen))
            check("custom tool result reached the model", "widget" in result.final_text.lower(), result.final_text)
        except DGCUnsupportedError as exc:
            # Honest outcome on a platform without a tool transport: a typed refusal, not a hang.
            check("custom tools refuse with DGCUnsupportedError on this platform", WINDOWS, str(exc))

        # 3. a policy denial: the write tool is denied even though the callback would allow it
        base._Model.behavior = "edit"
        policy = RuntimePolicy(deny_tools=("write_file", "edit_file", "apply_patch"))
        with client(policy=policy) as dgc:
            session = dgc.session(cwd=work, permissions={"mode": "default", "unhandled": "deny"},
                                  on_permission=lambda _req: "once")
            result = session.run("edit the checkout guard", timeout=120)
            if session.raw.pid:
                tracked |= {session.raw.pid}
        check("policy denial leaves the workspace untouched", not (work / "guard.py").exists())
        check("policy denial is reported, run still completes", result.status == "completed", result.status)

        # 4. cancellation settles promptly and the session is reusable
        base._Model.behavior = "stall"
        with client() as dgc:
            session = dgc.session(cwd=work, permissions=perms)
            if session.raw.pid:
                tracked |= {session.raw.pid}
            handle = session.stream("Summarize README.", timeout=30)
            time.sleep(1.0)
            started = time.monotonic()
            handle.cancel()
            cancelled = handle.result()
            elapsed = time.monotonic() - started
            check("cancel ends the run", cancelled.status in ("cancelled", "failed"), cancelled.status)
            check("cancel settles within 10s", elapsed < 10.0, f"{elapsed:.1f}s")
            base._Model.behavior = "text"
            again = session.run("Summarize README. Do not edit files.", timeout=120)
            check("session is reusable after cancel", again.status == "completed", again.status)

        # 5. cleanup: nothing we saw start outlives close()
        deadline = time.monotonic() + 10
        survivors = _alive(tracked)
        while survivors and time.monotonic() < deadline:
            time.sleep(0.5)
            survivors = _alive(tracked)
        check("no dgc serve / bridge process outlives close()", not survivors and bool(tracked),
              f"tracked={sorted(tracked)} survivors={sorted(survivors)}")
    finally:
        server.shutdown()
        server.server_close()

    failed = [name for name, ok, _ in RESULTS if not ok]
    print(json.dumps({"platform": sys.platform, "python": sys.version.split()[0],
                      "passed": len(RESULTS) - len(failed), "failed": failed}))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
