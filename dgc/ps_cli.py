"""`dgc ps` and `dgc stop`: the DGC processes running on this computer, and how to stop one.

Both read the peer notes (``~/.dgc/peers``), so they see every `dgc serve` (an editor window's
backend, attached or running with no window), every terminal DGC, and nothing that left no note.
`dgc stop` asks a backend to save and stop over its own socket, then sends SIGTERM (which DGC
handles by saving too); SIGKILL only with --force.
"""
from __future__ import annotations

import argparse
import json
import sys


def _duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    if hours < 48:
        return f"{hours}h {minutes}m"
    return f"{hours // 24}d {hours % 24}h"


def _window(row: dict) -> str:
    if row["kind"] != "serve":
        return "terminal" if row["kind"] == "tui" else "-"
    if row["attached"]:
        return "window attached"
    return f"no window for {_duration(row['windowless_s'])}"


def format_rows(rows: list[dict]) -> str:
    if not rows:
        return "No DGC is running on this computer."
    lines = [f"{'PID':<8} {'KIND':<6} {'VERSION':<9} {'WINDOW':<24} {'UP':<8} WORK"]
    for row in rows:
        lines.append(f"{row['pid']:<8} {row['kind'] or '?':<6} {row['version'] or '?':<9} "
                     f"{_window(row):<24} {(_duration(row['uptime_s']) if row['uptime_s'] else '?'):<8} "
                     f"{row['work'] or ('idle' if row['status'] != 'working' else 'working')}")
        for session in row["sessions"]:
            name = f"\"{session['name']}\"" if session["name"] else session["session_id"]
            lines.append(f"{'':<8} session {name}  {session['cwd']}"
                         + ("  (working)" if session["status"] == "working" else ""))
    return "\n".join(lines)


def run_ps(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="dgc ps", description="List the DGC processes on this computer.")
    parser.add_argument("--json", action="store_true", help="print the list as JSON")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    from .serve_detach import live_processes
    rows = live_processes()
    print(json.dumps(rows, indent=2) if args.json else format_rows(rows))
    return 0


def run_stop(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="dgc stop", description="Save and stop a DGC process: by pid, by session id, or every "
                                     "backend running with no window.")
    parser.add_argument("target", nargs="?", help="a pid from `dgc ps`, or a session id")
    parser.add_argument("--windowless", action="store_true",
                        help="stop every editor backend that is running with no window")
    parser.add_argument("--force", action="store_true",
                        help="if it has not stopped after SIGTERM, end it with SIGKILL (unsaved work is lost)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    if not args.target and not args.windowless:
        parser.print_usage(sys.stderr)
        print("dgc stop: name a pid or a session id, or pass --windowless", file=sys.stderr)
        return 2
    from . import peers
    from .serve_detach import stop_process
    records = peers.others(here=False)
    if args.windowless:
        chosen = [r for r in records if r.get("kind") == "serve" and r.get("attached") is False]
    elif str(args.target).isdigit():
        chosen = [r for r in records if r.get("pid") == int(args.target)]
    else:
        target = str(args.target)
        chosen = [r for r in records if any(
            str(place.get("session") or "").rsplit("/", 1)[-1].removesuffix(".json") == target
            for place in peers._places(r))]
    if not chosen:
        print("dgc stop: no running DGC matches that." if not args.windowless
              else "No editor backend is running without a window.")
        return 0 if args.windowless else 1
    failed = 0
    for record in chosen:
        stopped, what = stop_process(record, reason="`dgc stop`", force=args.force)
        print(f"pid {record.get('pid')}: {'stopped' if stopped else 'not stopped'} -- {what}")
        failed += 0 if stopped else 1
    return 1 if failed else 0
