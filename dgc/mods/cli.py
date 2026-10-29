"""``dgc mods``: the user's mods from the terminal, and the tools for writing one.

    dgc mods                        every mod, on or not and why
    dgc mods allow NAME             show what it can do, then allow it (it asks first)
    dgc mods on|off NAME            turn an allowed mod on or off
    dgc mods install FOLDER|URL     install (or update) a mod; https:// or git@ addresses too (--subdir PATH)
    dgc mods remove NAME            uninstall one (DGC's own can only be turned off)
    dgc mods validate [FOLDER]      check a mod: its manifest, in plain words, and the hooks it really registers
    dgc mods test [FOLDER]          run it against every event, command and slot it declares, and check its answers
    dgc mods dev [FOLDER]           run DGC with this mod loaded; it reloads when a file in it changes
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from . import catalog, consent
from .manifest import ManifestError, describe, load
from .runtime import ModError, ModProcess

SAMPLES = {
    "session.start": {"surface": "work"}, "session.end": {},
    "prompt.submit": {"text": "Add a test for the upload limit"},
    "tool.call": {"tool": "bash", "args": {"command": "ls -la"}},
    "tool.result": {"tool": "bash", "is_error": False, "output": "README.md"},
    "turn.start": {"source": "prompt"}, "turn.complete": {"usage": {"input_tokens": 1200, "output_tokens": 300},
                                                          "used": 4200},
}


def _say(line: str = "") -> None:
    print("".join(char if char.isprintable() else " " for char in line))


def _list() -> int:
    from .host import ModHost
    host = ModHost(project_root=Path.cwd(), session_id="cli")
    words = {"running": "on", "needs_allow": "needs your allow", "off": "off", "stopped": "allowed",
             "crashed": "stopped with an error"}
    for e in host.mods():
        tag = "DGC's own" if e["builtin"] else "installed"
        _say(f"{e['title']:<16} {words.get(e['state'], e['state']):<18} {tag:<10} {e['description'][:70]}")
    if not host.on:
        _say()
        _say("Mods are off (safe mode or the mods_enabled setting).")
    return 0


def _allow(name: str) -> int:
    m = catalog.find(name)
    if m is None:
        _say(f"There's no mod named {name}. `dgc mods` lists them.")
        return 1
    _say(f"{m.title} {m.version}")
    for line in describe(m):
        _say(f"  · {line}")
    if not sys.stdin.isatty():
        _say("Run this in a terminal to allow it.")
        return 1
    answer = input("Allow it? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        _say("Not allowed.")
        return 1
    consent.allow(m)
    _say(f"{m.title} is on; it starts with your next session.")
    return 0


def _process(m, on_request=None) -> ModProcess:
    from .. import sandbox
    proc = ModProcess(m, on_request=on_request or (lambda method, params: {}),
                      sandboxed=sandbox._backend() is not None)
    proc.start()
    if proc.state != "running":
        reason = proc.error or "It didn't start."
        proc.stop()
        raise ModError(reason)
    return proc


def _reply(got, method: str) -> dict:
    if not isinstance(got, dict):
        raise ModError(f"{method} returned an invalid response (expected an object).")
    return got


def _registered(got: dict, field: str) -> set[str]:
    names = got.get(field, [])
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ModError(f"initialize returned invalid {field} (expected a list of names).")
    return set(names)


def _validate(folder: Path) -> int:
    try:
        m = load(folder)
    except ManifestError as error:
        _say(f"✗ {error}")
        return 1
    _say(f"✓ {m.title} {m.version} ({m.runtime}, {m.entry})")
    for line in describe(m):
        _say(f"  · {line}")
    try:
        proc = _process(m)
    except ModError as error:
        _say(f"✗ It didn't start: {error}")
        return 1
    try:
        got = _reply(proc.request("initialize", {"api": 1, "mod": m.name, "surface": "test", "session": "validate",
                                                 "project": str(Path.cwd()), "capabilities": m.capabilities()}, timeout=15),
                     "initialize")
        hooks, commands = _registered(got, "hooks"), _registered(got, "commands")
        renders = _registered(got, "renders")
    except ModError as error:
        _say(f"✗ Invalid mod response: {error}")
        return 1
    finally:
        proc.stop()
    problems = 0
    for event in sorted(hooks - set(m.events)):
        _say(f"✗ It handles {event}, which its manifest doesn't declare: DGC won't send it.")
        problems += 1
    for event in sorted(set(m.events) - hooks):
        _say(f"! It declares {event} but handles none: drop it from the manifest, or add a handler.")
    declared = {c["name"] for c in m.commands}
    for name in sorted(commands - declared):
        _say(f"✗ It handles /{name}, which its manifest doesn't declare.")
        problems += 1
    for name in sorted(declared - commands):
        _say(f"✗ It declares /{name} but handles none.")
        problems += 1
    for slot in sorted(renders - set(m.draws)):
        _say(f"✗ It draws in {slot}, which its manifest doesn't declare.")
        problems += 1
    _say(f"hooks: {', '.join(sorted(hooks)) or 'none'} · commands: {', '.join('/' + c for c in sorted(commands)) or 'none'}"
         f" · draws: {', '.join(sorted(renders)) or 'none'}")
    _say("✓ valid" if not problems else f"✗ {problems} problem{'s' if problems != 1 else ''}")
    return 1 if problems else 0


def _test(folder: Path) -> int:
    """Every declared event with sample data, every command, every slot: each answer checked as DGC checks it."""
    from . import ui
    try:
        m = load(folder)
    except ManifestError as error:
        _say(f"✗ {error}")
        return 1
    calls = []

    def answer(method, params):
        calls.append(method)
        if method in ("ui.set",):
            ui.clean(params.get("tree")) if params.get("tree") is not None else None
            return {}
        if method in ("store.get", "state.get"):
            return {"value": None}
        if method in ("store.set", "state.set", "ui.toast", "log"):
            return {}
        if method == "usage.get":
            return {"window": 65536, "used": 4200, "breakdown": {"window": 65536, "categories": [
                {"id": "messages", "label": "Messages", "tokens": 3000}, {"id": "system_tools", "label": "Tools",
                                                                         "tokens": 1200}], "buffer": 9830,
                "free": 51506}}
        if method == "git.status":
            return {"status": "## main\n M a.py\n", "diffstat": " a.py | 2 +-\n"}
        raise ModError(f"(in a test) {method} isn't simulated")
    try:
        proc = _process(m, answer)
    except ModError as error:
        _say(f"✗ It didn't start: {error}")
        return 1
    try:
        _reply(proc.request("initialize", {"api": 1, "mod": m.name, "surface": "test", "session": "test",
                                           "project": str(Path.cwd()), "capabilities": m.capabilities()}, timeout=15),
               "initialize")
        return _test_running(m, proc)
    except ModError as error:
        _say(f"✗ It didn't start: {error}")
        return 1
    finally:
        proc.stop()


def _test_running(m, proc: ModProcess) -> int:
    from . import ui
    failures = 0
    for event in m.events:
        started = time.monotonic()
        try:
            got = _reply(proc.request("event", {"name": event, "data": SAMPLES[event]}, timeout=5) or {}, "event")
        except ModError as error:
            _say(f"✗ {event}: {error}")
            failures += 1
            continue
        seconds = time.monotonic() - started
        bad = ""
        if event == "tool.call" and got.get("decision") not in (None, "observe", "ask", "deny"):
            bad = f"decision {got.get('decision')!r} isn't one DGC takes (observe, ask, deny); DGC ignores it"
        if event == "prompt.submit" and got.get("rewrite") is not None and not m.rewrites_prompt:
            bad = "it rewrites the prompt without declaring rewrites_prompt; DGC ignores it"
        if seconds > 1.5 and event in ("tool.call", "prompt.submit"):
            bad = f"it took {seconds:.1f} s; DGC waits 1.5 s at most, then goes on without it"
        _say(f"{'✗' if bad else '✓'} {event}" + (f": {bad}" if bad else f" ({seconds * 1000:.0f} ms)"))
        failures += bool(bad)
    for c in m.commands:
        try:
            got = _reply(proc.request("command", {"name": c["name"], "args": ""}, timeout=10) or {}, "command")
            if got.get("tree") is not None:
                ui.clean(got["tree"])
            _say(f"✓ /{c['name']}")
        except (ModError, ui.UIError) as error:
            _say(f"✗ /{c['name']}: {error}")
            failures += 1
    for slot in m.draws:
        if slot == "toast":
            continue
        try:
            tree = _reply(proc.request("ui.render", {"slot": slot}, timeout=5) or {}, "ui.render").get("tree")
            if tree is not None:
                ui.clean(tree)
            _say(f"✓ draws {slot}" + ("" if tree is not None else " (nothing yet)"))
        except (ModError, ui.UIError) as error:
            _say(f"✗ draws {slot}: {error}")
            failures += 1
    proc.stop()
    if proc.error:
        _say(f"✗ it stopped with: {proc.error}")
        failures += 1
    _say("✓ all passed" if not failures else f"✗ {failures} failed")
    return 1 if failures else 0


def _dev(folder: Path, argv: list[str]) -> int:
    """DGC itself, with this folder as a mod for this session (asked once, then reloaded on every change)."""
    try:
        load(folder)
    except ManifestError as error:
        _say(f"✗ {error}")
        return 1
    os.environ["DGC_MODS_DEV"] = str(folder)
    from ..cli import main
    return main(argv)


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("list", "ls"):
        return _list()
    command, rest = argv[0], argv[1:]
    here = Path(rest[0]).expanduser() if rest and not rest[0].startswith("-") else Path.cwd()
    try:
        if command == "allow" and rest:
            return _allow(rest[0])
        if command in ("on", "off") and rest:
            if command == "off":
                consent.set_enabled(rest[0], False)
                _say(f"{rest[0]} is off.")
                return 0
            m = catalog.find(rest[0])
            if m is None or consent.set_enabled(rest[0], True) is None:
                return _allow(rest[0])
            _say(f"{m.title} is on." if consent.allowed(m) else f"{m.title} asks for more now: dgc mods allow {m.name}")
            return 0
        if command == "install" and rest:
            target = rest[0]
            subdir = rest[rest.index("--subdir") + 1] if "--subdir" in rest[:-1] else ""
            m = catalog.install_git(target, subdir) if target.startswith(("https://", "git@")) \
                else catalog.install_folder(target)
            missing = consent.missing(m)
            _say(f"Installed {m.title} {m.version}." + (f" Allow it: dgc mods allow {m.name}" if missing else ""))
            return 0
        if command == "remove" and rest:
            if catalog.remove(rest[0]):
                consent.forget(rest[0])
                _say(f"Removed {rest[0]}.")
                return 0
            _say(f"{rest[0]} isn't an installed mod.")
            return 1
        if command == "validate":
            return _validate(here)
        if command == "test":
            return _test(here)
        if command == "dev":
            return _dev(here, [a for a in rest[1:] if a])
    except (ManifestError, ModError) as error:
        _say(f"✗ {error}")
        return 1
    _say(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
