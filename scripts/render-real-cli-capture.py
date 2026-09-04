#!/usr/bin/env python3
"""Record a real DGC full-screen coding turn in a disposable fixture.

It never changes ``HOME`` and never loads or persists the user's DGC configuration. The child
process constructs a real :class:`dgc.config.Config` with loading temporarily disabled, switches
persistence off, and then runs the current worktree's CLI/TUI behind an exact tool allowlist and
OS-confined verifier command.

Runtime requirements: Xvfb, GNOME Terminal, tmux, ffmpeg and an installed DGC Python
environment (``--python``).  The configured Ollama model must already be available locally.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import pwd
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener
from collections.abc import Callable


ROOT = Path(__file__).resolve().parents[1]
VIEWPORT = (1280, 720)
MIN_CAPTURE_SECONDS = 46.0
TARGET_LONG_CAPTURE_SECONDS = 56.0
MAX_RAW_SECONDS = 210.0
PROMPT = (
    "Use exactly four tool calls in this order, then stop: read_file path clamp.py; "
    "read_file path test_clamp.py; edit_file path clamp.py replacing only "
    "return min(lower, max(upper, value)) with return max(lower, min(upper, value)); "
    "bash command python3 -m unittest -v. Do not call any other tool."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path,
                        help="Python executable whose environment contains DGC dependencies "
                             "(default: the interpreter from the installed dgc entrypoint)")
    parser.add_argument("--model", default="qwen2.5:14b")
    parser.add_argument("--base-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "site" / "assets")
    parser.add_argument("--keep-work", action="store_true")
    parser.add_argument("--fixture-run", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--fixture", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--state-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--status", type=Path, help=argparse.SUPPRESS)
    return parser.parse_args()


def installed_dgc_python() -> Path:
    entrypoint = shutil.which("dgc")
    if entrypoint:
        try:
            first = Path(entrypoint).read_text(encoding="utf-8").splitlines()[0]
            if first.startswith("#!"):
                candidate = Path(first[2:].strip())
                if candidate.is_file():
                    return candidate
        except (OSError, UnicodeError):
            pass
    return Path(sys.executable)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def user_state_snapshot(root: Path) -> dict[str, tuple]:
    """Record each path's mode, size, mtime and content hash without following links."""
    manifest: dict[str, tuple] = {}
    if not root.exists():
        return {".": ("missing",)}
    for path in sorted((root, *root.rglob("*")), key=lambda item: item.as_posix()):
        relative = "." if path == root else path.relative_to(root).as_posix()
        try:
            stat = path.lstat()
        except FileNotFoundError:
            manifest[relative] = ("vanished",)
            continue
        content = ""
        if path.is_symlink():
            content = "link:" + os.readlink(path)
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            content = "sha256:" + digest.hexdigest()
        manifest[relative] = (stat.st_mode, stat.st_size, stat.st_mtime_ns, content)
    return manifest


def user_state_changes(before: dict[str, tuple], after: dict[str, tuple]) -> list[str]:
    return [path for path in sorted(set(before) | set(after)) if before.get(path) != after.get(path)]


def isolated_config(fixture: Path, state_dir: Path, model: str, base_url: str):
    """Construct the production Config class without consulting global DGC state."""
    from dgc import agents as agents_mod
    from dgc import artifacts as artifacts_mod
    from dgc import commands as commands_mod
    from dgc import config as config_mod
    from dgc import memory as memory_mod
    from dgc import scheduler as scheduler_mod
    from dgc import sessions as sessions_mod
    from dgc import skills as skills_mod
    from dgc import tui as tui_mod
    from dgc.config import DEFAULTS, Config

    # Every user-state discovery path is redirected inside this process only.  HOME itself is
    # never changed.  Built-in skills remain available from the current DGC worktree.
    config_mod.USER_HOME = state_dir
    config_mod.USER_CONFIG = state_dir / "config.json"
    config_mod.USER_SECRETS = state_dir / "secrets.json"
    config_mod.USER_MEMORY = state_dir / "DGC.md"
    config_mod.USER_SKILLS = state_dir / "skills"
    config_mod.USER_AGENTS = state_dir / "agents"
    skills_mod.USER_SKILLS = config_mod.USER_SKILLS
    agents_mod.USER_AGENTS = config_mod.USER_AGENTS
    memory_mod.USER_MEMORY = config_mod.USER_MEMORY
    commands_mod.USER_HOME = config_mod.USER_HOME
    sessions_mod.SESSIONS_DIR = config_mod.USER_HOME / "sessions"
    artifacts_mod.USER_HOME = config_mod.USER_HOME
    artifacts_mod.STATE_FILE = config_mod.USER_HOME / "artifacts.json"
    isolated_locks = config_mod.USER_HOME / "locks"

    def isolated_lock_directory() -> Path:
        isolated_locks.mkdir(parents=True, exist_ok=True, mode=0o700)
        isolated_locks.chmod(0o700)
        return isolated_locks

    scheduler_mod._lock_directory = isolated_lock_directory
    scheduler_mod._workspace_locks.clear()
    scheduler_mod._named_locks.clear()
    tui_mod.cached_update = lambda: None

    original_load = Config.load
    Config.load = lambda self: None
    try:
        config = Config(project_root=fixture)
    finally:
        Config.load = original_load

    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update({
        "base_url": base_url,
        "api_key": "ollama",
        "model": model,
        "api_mode": "auto",
        "mode": "default",
        "thinking": "off",
        "context_size": 8_192,
        "max_tokens": 2_048,
        "temperature": 0.0,
        "turn_budget_s": 180,
        "trusted_dirs": [str(fixture.resolve())],
        "suggest": False,
        "logo_animation": False,
        "artifact_autostart": False,
        "plan_artifact": False,
        "artifact_in_plan": False,
        "verify_before_done": True,
        "verify_command": "python3 -m unittest -v",
        "background": "dark",
        "theme": "dark",
        "mcp_servers": {},
        "language_servers": {},
        "hooks": {},
        "sandbox": True,
        "sandbox_network": False,
        "sandbox_env_allow": [],
        "subscription_engine": "",
    })
    config.permissions = {"allow": [], "ask": [], "deny": []}
    config._explicit_keys = set(config.data)
    config._stored_secrets = {}
    config._stored_provider_identity = {}
    config._provider_secret_identity = {}
    config._stored_mcp_env = {}
    config._stored_mcp_identity = {}
    config._env_secret_keys = set()
    config.credential_warnings = ()
    # Config deliberately binds provider credentials to their exact endpoint. Install the Ollama
    # dummy key through that same production path so this isolated instance is internally valid.
    config.set_runtime_secret("api_key", "ollama")
    return config


def validate_fixture(fixture: Path) -> tuple[bool, str]:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "-v"], cwd=fixture,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"},
    )
    output = result.stdout[-4000:]
    return result.returncode == 0 and "OK" in output, output


def validate_minimal_change(fixture: Path) -> tuple[bool, str]:
    status = subprocess.run(
        ["git", "status", "--short", "--untracked-files=all"], cwd=fixture,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=10, check=True,
    ).stdout.rstrip().splitlines()
    numstat = subprocess.run(
        ["git", "diff", "--numstat", "--", "clamp.py", "test_clamp.py"], cwd=fixture,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=10, check=True,
    ).stdout.strip()
    proof = f"status={status!r}; numstat={numstat!r}"
    return status == [" M clamp.py"] and numstat == "1\t1\tclamp.py", proof


def run_fixture_child(args: argparse.Namespace) -> int:
    if not args.fixture or not args.state_dir or not args.status:
        raise SystemExit("internal fixture mode requires --fixture, --state-dir and --status")
    fixture = args.fixture.resolve()
    state_dir = args.state_dir.resolve()
    status = args.status.resolve()

    # The child gets no PYTHONPATH. Insert this reviewed tree in-process, then prove the resolved
    # package below before constructing any DGC object.
    root_text = str(ROOT)
    sys.path[:] = [entry for entry in sys.path if entry != root_text]
    sys.path.insert(0, root_text)

    import dgc
    from dgc import agent as agent_mod
    from dgc import sandbox as sandbox_mod
    from dgc.permissions import ALLOW, DENY, PermissionEngine
    from dgc.workspace import WorkspaceBoundaryError, canonical_path
    imported_package = Path(dgc.__file__).resolve().parent
    expected_package = (ROOT / "dgc").resolve()
    if imported_package != expected_package:
        raise RuntimeError(
            f"capture imported DGC from {imported_package}, expected current tree {expected_package}")
    source_proof = {
        "worktree_import": True,
        "dgc_module": str(Path(dgc.__file__).resolve()),
        "dgc_version": str(getattr(dgc, "__version__", "unknown")),
    }

    def exact_capture_call(name: str, values: dict) -> bool:
        if not isinstance(values, dict):
            return False
        if name in {"read_file", "edit_file"}:
            allowed_keys = ({"path", "offset", "limit"} if name == "read_file" else
                            {"path", "old_string", "new_string", "replace_all"})
            required_keys = ({"path"} if name == "read_file" else
                             {"path", "old_string", "new_string"})
            if not required_keys.issubset(values) or not set(values).issubset(allowed_keys):
                return False
            try:
                target = canonical_path(str(values.get("path", "")), fixture)
            except (OSError, ValueError, WorkspaceBoundaryError):
                return False
            expected = fixture / ("clamp.py" if name == "edit_file" else target.name)
            if target != expected or target.name not in {"clamp.py", "test_clamp.py"}:
                return False
            if name == "edit_file":
                return (
                    str(values.get("old_string", "")).strip()
                    == "return min(lower, max(upper, value))"
                    and str(values.get("new_string", "")).strip()
                    == "return max(lower, min(upper, value))"
                    and ("replace_all" not in values or values["replace_all"] is False)
                )
            offset_ok = "offset" not in values or (
                type(values["offset"]) is int and values["offset"] == 1)
            limit_ok = "limit" not in values or (
                type(values["limit"]) is int and values["limit"] == 2_000)
            return offset_ok and limit_ok
        return (
            name == "bash"
            and set(values) == {"command"}
            and str(values.get("command", "")).strip() == "python3 -m unittest -v"
        )

    class CapturePermissionEngine(PermissionEngine):
        """Fail closed even if the session mode or configured rules drift."""

        def decide(self, tool: str, values: dict) -> tuple[str, str]:
            if exact_capture_call(tool, values):
                return ALLOW, "capture fixture exact allowlist"
            return DENY, "outside the capture fixture's exact tool allowlist"

    agent_mod.PermissionEngine = CapturePermissionEngine
    if sandbox_mod.available() != "bwrap":
        raise RuntimeError("the real CLI capture requires the reviewed bwrap confinement backend")
    sandbox_invocations: list[bool] = []
    original_sandbox_wrap = sandbox_mod.wrap

    def tracked_sandbox_wrap(command: str, project_root, sandbox_config=None):
        argv = original_sandbox_wrap(command, project_root, sandbox_config)
        proven = bool(
            argv and Path(argv[0]).name == "bwrap"
            and "--unshare-all" in argv and "--share-net" not in argv
            and ["--bind", str(fixture), "/mnt"]
            == argv[argv.index("--bind"):argv.index("--bind") + 3]
            and argv[-5:] == ["/bin/bash", "-o", "pipefail", "-c", command]
        ) if argv and "--bind" in argv else False
        sandbox_invocations.append(proven)
        return argv

    sandbox_mod.wrap = tracked_sandbox_wrap

    config = isolated_config(fixture, state_dir, args.model, args.base_url)
    from dgc.cli import CLI
    from dgc.tui import TUI

    cli = CLI(config)
    cli.agent.session_file = None
    cli.agent.session_name = "clamp regression"
    tui = TUI(config, agent=cli.agent)
    tui._autotitled = True
    tool_events: list[tuple[str, str, dict | str]] = []
    issued_calls: list[tuple[str, dict]] = []
    tool_lock = threading.Lock()
    status_lock = threading.Lock()
    original_tool_call = tui.tool_call
    original_tool_result = tui.tool_result
    original_handle_call = cli.agent._handle_call

    # Disable the internal parallel-read shortcut so every model-issued call crosses one stateful,
    # auditable allowlist boundary before execution.
    cli.agent._parallel_read_outputs = lambda _calls, _prior_counts=None: {}

    def capture_handle_call(call) -> str:
        values = copy.deepcopy(call.arguments) if isinstance(call.arguments, dict) else {}
        with tool_lock:
            prior = list(issued_calls)
            issued_calls.append((str(call.name), values))
        expected_names = ("read_file", "read_file", "edit_file", "bash")
        sequence_allowed = (
            len(prior) < len(expected_names)
            and str(call.name) == expected_names[len(prior)]
            and exact_capture_call(str(call.name), values)
        )
        if sequence_allowed and len(prior) == 1:
            first_path = Path(str(prior[0][1].get("path", ""))).name
            second_path = Path(str(values.get("path", ""))).name
            sequence_allowed = {first_path, second_path} == {"clamp.py", "test_clamp.py"}
        if not sequence_allowed:
            cli.agent.ui.tool_denied(
                str(call.name), values, "outside the capture fixture's exact ordered allowlist", call.id)
            return ("PERMISSION DENIED: outside the capture fixture's exact ordered allowlist. "
                    "Do not retry this action; finish with the available result.")
        return original_handle_call(call)

    cli.agent._handle_call = capture_handle_call

    def publish_status(value: dict) -> None:
        with status_lock:
            write_json(status, value)

    def tracked_tool_call(name: str, values: dict, call_id: str | None = None) -> None:
        with tool_lock:
            tool_events.append(("call", name, copy.deepcopy(values)))
            count = len(tool_events)
        publish_status({
            "state": "running", **source_proof,
            "visible_tool_events": count, "last_tool": name,
        })
        original_tool_call(name, values, call_id)

    def tracked_tool_result(name: str, output: str, call_id: str | None = None) -> None:
        with tool_lock:
            tool_events.append(("result", name, str(output)))
            count = len(tool_events)
        publish_status({
            "state": "running", **source_proof,
            "visible_tool_events": count, "last_tool": name,
        })
        original_tool_result(name, output, call_id)

    tui.tool_call = tracked_tool_call
    tui.tool_result = tracked_tool_result

    def observe_turn() -> None:
        while not (tui.app and tui.app.is_running):
            time.sleep(0.05)
        publish_status({"state": "ready", **source_proof})
        saw_turn = False
        while tui.app and tui.app.is_running:
            if tui._turn.is_set():
                if not saw_turn:
                    publish_status({"state": "running", **source_proof,
                                    "visible_tool_events": 0})
                saw_turn = True
            elif saw_turn:
                passed, output = validate_fixture(fixture)
                minimal, change_proof = validate_minimal_change(fixture)
                with tool_lock:
                    events = list(tool_events)
                    calls = list(issued_calls)
                read_names = {
                    Path(str(values.get("path", ""))).name
                    for name, values in calls[:2] if name == "read_file"
                }
                exact_sequence = (
                    len(calls) == 4
                    and [name for name, _values in calls] == [
                        "read_file", "read_file", "edit_file", "bash"]
                    and read_names == {"clamp.py", "test_clamp.py"}
                    and all(exact_capture_call(name, values) for name, values in calls)
                )
                visible_calls = [(name, value) for kind, name, value in events if kind == "call"]
                visible_results = [name for kind, name, _value in events if kind == "result"]
                visible_sequence = (
                    len(visible_calls) == 4
                    and [name for name, _value in visible_calls]
                    == ["read_file", "read_file", "edit_file", "bash"]
                    and visible_results == ["read_file", "read_file", "edit_file", "bash"]
                )
                used_edit = exact_sequence and visible_sequence
                used_test = (
                    exact_sequence
                    and str(calls[-1][1].get("command", "")).strip()
                    == "python3 -m unittest -v"
                )
                shown_test_passed = any(
                    kind == "result" and name == "bash" and isinstance(value, str)
                    and value.startswith("exit code: 0\n") and "Ran 3 tests" in value
                    and "OK" in value
                    for kind, name, value in events)
                forbidden = tuple(filter(None, {
                    str(Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()),
                    str(ROOT.resolve()),
                    str(state_dir),
                    str(state_dir.parent),
                }))
                transcript = json.dumps({
                    "calls": calls,
                    "events": events,
                    "messages": cli.agent.messages,
                }, default=str, ensure_ascii=False)
                leaked_paths = sorted(value for value in forbidden if value in transcript)
                transcript_paths_clean = not leaked_paths
                sandbox_proven = sandbox_invocations == [True]
                proven = (passed and minimal and exact_sequence and visible_sequence and used_edit
                          and used_test and shown_test_passed and transcript_paths_clean
                          and sandbox_proven)
                publish_status({
                    "state": "passed" if proven else "failed",
                    **source_proof,
                    "test_output": output,
                    "minimal_change": minimal,
                    "change_proof": change_proof,
                    "edit_tool_visible": used_edit,
                    "exact_tool_sequence": exact_sequence,
                    "visible_tool_sequence": visible_sequence,
                    "test_tool_visible": used_test,
                    "test_result_visible": shown_test_passed,
                    "transcript_paths_clean": transcript_paths_clean,
                    "forbidden_path_hits": leaked_paths,
                    "sandbox_backend": "bwrap" if sandbox_proven else "unproven",
                    "sandbox_command_proven": sandbox_proven,
                    "issued_calls": calls,
                    "visible_calls": [name for name, _value in visible_calls],
                    "visible_results": visible_results,
                })
                return
            time.sleep(0.1)

    threading.Thread(target=observe_turn, name="capture-observer", daemon=True).start()
    tui.run()
    return 0


def require_tools(python: Path) -> None:
    if not python.is_file():
        raise RuntimeError(f"DGC Python environment is missing: {python}")
    missing = [name for name in ("Xvfb", "dbus-run-session", "gnome-terminal", "tmux",
                                 "ffmpeg", "ffprobe", "xwininfo", "bwrap")
               if not shutil.which(name)]
    if missing:
        raise RuntimeError("missing capture tools: " + ", ".join(missing))


def require_loaded_ollama_model(base_url: str, model: str) -> None:
    """Fail before capture unless the requested model is already resident on local Ollama."""
    parsed = urlsplit(base_url)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username or parsed.password):
        raise RuntimeError("the real CLI capture requires a credential-free loopback Ollama URL")
    root_path = parsed.path.rstrip("/")
    if root_path.endswith("/v1"):
        root_path = root_path[:-3]
    endpoint = urlunsplit((parsed.scheme, parsed.netloc, root_path + "/api/ps", "", ""))
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(Request(endpoint, headers={"Accept": "application/json"}), timeout=4) as response:
            payload = json.loads(response.read(1024 * 1024))
    except Exception as exc:
        raise RuntimeError(f"could not verify the already-running local Ollama model: {exc}") from exc
    loaded = {
        str(item.get(key, ""))
        for item in payload.get("models", []) if isinstance(item, dict)
        for key in ("name", "model")
        if item.get(key)
    } if isinstance(payload, dict) else set()
    normalize = lambda value: str(value).removesuffix(":latest")
    if normalize(model) not in {normalize(value) for value in loaded}:
        available = ", ".join(sorted(loaded)) or "none"
        raise RuntimeError(
            f"capture model {model!r} is not already loaded in Ollama (resident: {available})")


def write_fixture(path: Path) -> None:
    (path / "clamp.py").write_text(
        'def clamp(value, lower, upper):\n'
        '    """Keep value inside the inclusive lower/upper bounds."""\n'
        '    return min(lower, max(upper, value))\n',
        encoding="utf-8",
    )
    (path / "test_clamp.py").write_text(
        "import unittest\n\n"
        "from clamp import clamp\n\n\n"
        "class ClampTests(unittest.TestCase):\n"
        "    def test_inside_range_is_unchanged(self):\n"
        "        self.assertEqual(clamp(4, 0, 10), 4)\n\n"
        "    def test_values_below_lower_bound(self):\n"
        "        self.assertEqual(clamp(-3, 0, 10), 0)\n\n"
        "    def test_values_above_upper_bound(self):\n"
        "        self.assertEqual(clamp(18, 0, 10), 10)\n\n\n"
        "if __name__ == '__main__':\n"
        "    unittest.main()\n",
        encoding="utf-8",
    )
    (path / ".gitignore").write_text("__pycache__/\n*.py[cod]\n", encoding="utf-8")
    (path / "DGC.md").write_text(
        "# Fixture constraints\n\n"
        "- Treat `test_clamp.py` as an immutable specification; never edit it.\n"
        "- Change exactly one line in `clamp.py`: the faulty return expression.\n"
        "- Use exactly four tool calls in order: read both files once each with path-only "
        "`read_file` calls, one `edit_file` call for the return expression, then one command-only "
        "`bash` call whose command is `python3 -m unittest -v`.\n"
        "- After that bash result, call no tool again; immediately summarize and stop.\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "add", ".gitignore", "DGC.md", "clamp.py", "test_clamp.py"],
                   cwd=path, check=True)
    subprocess.run(
        ["git", "-c", "user.name=DGC Capture", "-c", "user.email=capture@invalid",
         "commit", "-qm", "fixture"], cwd=path, check=True,
    )


def choose_display() -> tuple[str, Path]:
    socket_root = Path("/tmp/.X11-unix")
    for number in range(91, 120):
        socket = socket_root / f"X{number}"
        lock = Path(f"/tmp/.X{number}-lock")
        if not socket.exists() and not lock.exists():
            return f":{number}", socket
    raise RuntimeError("no free X display in :91..:119")


def wait_for(predicate, message: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise RuntimeError(message)


def terminal_surface_size(display: str) -> tuple[int, int]:
    result = subprocess.run(
        ["xwininfo", "-display", display, "-root", "-tree"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=3,
        env={"PATH": "/usr/bin:/bin", "DISPLAY": display},
    )
    windows = []
    for line in result.stdout.splitlines():
        match = re.match(r'^\s+0x[0-9a-f]+\s+".*?".*?(\d+)x(\d+)\+', line, re.IGNORECASE)
        if match:
            windows.append((int(match.group(1)), int(match.group(2))))
    return max(windows, key=lambda item: item[0] * item[1], default=(0, 0))


def terminal_surface_fits(display: str) -> bool:
    width, height = terminal_surface_size(display)
    return (VIEWPORT[0] - 12 <= width <= VIEWPORT[0] + 24
            and VIEWPORT[1] - 16 <= height <= VIEWPORT[1] + 24)


def status_state(path: Path) -> str:
    try:
        return str(json.loads(path.read_text(encoding="utf-8")).get("state", ""))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return ""


def tmux(socket: str, *arguments: str, check: bool = True,
         env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["tmux", "-L", socket, *arguments], check=check,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
    )


def type_prompt(socket: str, text: str) -> None:
    # tmux transmits literal text into the real terminal.  Small chunks make the composer visibly
    # type without routing the prompt through a hidden DGC API.
    for index in range(0, len(text), 3):
        # `--` is required because prompt chunks can begin with a tmux option-like hyphen.
        tmux(socket, "send-keys", "-t", "capture", "-l", "--", text[index:index + 3])
        time.sleep(0.035)
    tmux(socket, "send-keys", "-t", "capture", "Enter")


def stop_process(process: subprocess.Popen | None, *, timeout: float = 4.0) -> None:
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)


def probe_media(path: Path) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=codec_name,width,height", "-of", "json", str(path),
    ], check=True, stdout=subprocess.PIPE, text=True, timeout=30)
    return json.loads(result.stdout)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def media_manifest_record(output_dir: Path, name: str) -> dict:
    path = output_dir / name
    metadata = probe_media(path)
    stream = (metadata.get("streams") or [{}])[0]
    record = {
        "path": f"assets/{name}",
        "sha256": file_sha256(path),
        "bytes": path.stat().st_size,
        "codec": str(stream.get("codec_name", "")),
        "width": int(stream.get("width", 0)),
        "height": int(stream.get("height", 0)),
    }
    duration = float((metadata.get("format") or {}).get("duration", 0))
    if not name.endswith(".jpg"):
        record["duration_seconds"] = round(duration, 6)
    return record


def update_cli_manifest(output_dir: Path, *, model: str, dgc_version: str,
                        factor: float) -> None:
    if output_dir != (ROOT / "site" / "assets").resolve():
        return
    manifest_path = ROOT / "site-src" / "data" / "capture-media.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1 or not isinstance(payload.get("captures"), dict):
        raise RuntimeError("capture media manifest has an unsupported schema")
    files = {
        kind: media_manifest_record(output_dir, name)
        for kind, name in {
            "webm": "cli-capture.webm",
            "mp4": "cli-capture.mp4",
            "poster": "cli-capture-poster.jpg",
        }.items()
    }
    duration = float(files["webm"]["duration_seconds"])
    rounded = int(duration + 0.5)
    timing = ("real time, no speed adjustment" if abs(factor - 1.0) < 0.0001 else
              f"{factor:.2f}× time-compressed")
    payload["captures"]["cli"] = {
        "kind": "real_cli_local_model",
        "live_model": True,
        "controlled_fixture": True,
        "real_time": abs(factor - 1.0) < 0.0001,
        "tool_sequence": ["read_file", "read_file", "edit_file", "bash"],
        "duration_seconds": round(duration, 6),
        "duration_label": f"{rounded // 60}:{rounded % 60:02d}",
        "provenance": (
            f"Actual current DGC {dgc_version} full-screen TUI · real local Ollama run · "
            f"{model} · disposable controlled fixture · one-line code edit · "
            f"python3 -m unittest -v passed 3/3 · {timing} · no user config or session persisted."
        ),
        "model_route": f"local Ollama · {model}",
        "time_compression": round(factor, 6),
        "sandbox_backend": "bwrap",
        "files": files,
    }
    temporary = manifest_path.with_name(manifest_path.name + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)


def validate_staged_media(staged: Path, published_seconds: float) -> None:
    for name, codec in (("cli-capture.webm", "vp9"), ("cli-capture.mp4", "h264")):
        path = staged / name
        metadata = probe_media(path)
        stream = (metadata.get("streams") or [{}])[0]
        duration = float((metadata.get("format") or {}).get("duration", 0))
        if (stream.get("codec_name") != codec
                or (stream.get("width"), stream.get("height")) != VIEWPORT
                or abs(duration - published_seconds) > 1.25):
            raise RuntimeError(f"staged {name} failed its codec, geometry or duration gate")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-f", "null", "-",
        ], check=True, timeout=300)
    poster = (probe_media(staged / "cli-capture-poster.jpg").get("streams") or [{}])[0]
    if (poster.get("codec_name") != "mjpeg"
            or (poster.get("width"), poster.get("height")) != VIEWPORT):
        raise RuntimeError("staged CLI poster failed its codec or geometry gate")
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i",
        str(staged / "cli-capture-poster.jpg"), "-frames:v", "1", "-f", "null", "-",
    ], check=True, timeout=30)


def promote_media(staged: Path, output_dir: Path) -> None:
    names = ("cli-capture.webm", "cli-capture.mp4", "cli-capture-poster.jpg")
    backup = staged / "previous-media"
    backup.mkdir()
    previous: list[str] = []
    promoted: list[str] = []
    try:
        for name in names:
            destination = output_dir / name
            if destination.exists():
                os.replace(destination, backup / name)
                previous.append(name)
        for name in names:
            os.replace(staged / name, output_dir / name)
            promoted.append(name)
    except Exception:
        for name in reversed(promoted):
            destination = output_dir / name
            if destination.exists():
                os.replace(destination, staged / f"{name}.rejected")
        for name in previous:
            saved = backup / name
            if saved.exists():
                os.replace(saved, output_dir / name)
        raise


def rollback_media(staged: Path, output_dir: Path) -> None:
    """Restore the pre-capture bytes after a post-promotion commit failure."""
    names = ("cli-capture.webm", "cli-capture.mp4", "cli-capture-poster.jpg")
    backup = staged / "previous-media"
    for name in names:
        destination = output_dir / name
        if destination.exists():
            os.replace(destination, staged / f"{name}.rejected")
    for name in names:
        saved = backup / name
        if saved.exists():
            os.replace(saved, output_dir / name)


def encode_capture(raw: Path, output_dir: Path, raw_seconds: float,
                   manifest_update: Callable[[float], None] | None = None) -> float:
    factor = max(1.0, raw_seconds / TARGET_LONG_CAPTURE_SECONDS)
    vf = f"setpts=PTS/{factor:.8f}"
    output_dir.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=".cli-capture-stage-", dir=output_dir))
    common = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw),
              "-an", "-vf", vf]
    subprocess.run(common + ["-c:v", "libvpx-vp9", "-crf", "35", "-b:v", "0",
                             "-row-mt", "1", str(staged / "cli-capture.webm")], check=True)
    subprocess.run(common + ["-c:v", "libx264", "-preset", "slow", "-crf", "27",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                             str(staged / "cli-capture.mp4")], check=True)
    poster_at = max(0.0, raw_seconds - 3.0)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{poster_at:.3f}",
        "-i", str(raw), "-frames:v", "1", "-q:v", "3",
        str(staged / "cli-capture-poster.jpg"),
    ], check=True)
    try:
        validate_staged_media(staged, raw_seconds / factor)
        promote_media(staged, output_dir)
        if manifest_update is not None:
            try:
                # The manifest is deliberately the final publication step. If it fails, restore
                # the old media set before allowing the exception to escape.
                manifest_update(factor)
            except Exception:
                rollback_media(staged, output_dir)
                raise
        return factor
    finally:
        shutil.rmtree(staged, ignore_errors=True)


def sanitized_environment(display: str) -> dict[str, str]:
    keep = ("XDG_RUNTIME_DIR",)
    env = {name: os.environ[name] for name in keep if name in os.environ}
    env.update({
        "PATH": "/usr/bin:/bin",
        "DISPLAY": display,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "PYTHONUNBUFFERED": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return env


def render(args: argparse.Namespace) -> int:
    # Keep a virtualenv interpreter path intact: resolving its symlink to /usr/bin/python would
    # silently discard the environment that supplies prompt_toolkit/rich and other DGC dependencies.
    python = (args.python or installed_dgc_python()).expanduser().absolute()
    require_tools(python)
    require_loaded_ollama_model(args.base_url, args.model)
    user_state = Path(pwd.getpwuid(os.getuid()).pw_dir) / ".dgc"
    before = user_state_snapshot(user_state)
    work = Path(tempfile.mkdtemp(prefix="dgc-real-cli-capture-"))
    fixture = Path(tempfile.gettempdir()) / "clamp-demo-worktree"
    fixture_owned = False
    state_dir = work / "isolated-state"
    status = work / "status.json"
    raw = work / "capture.mkv"
    display, display_socket = choose_display()
    socket_name = "dgc-capture-" + work.name[-8:]
    xvfb = terminal = recorder = None
    started = 0.0
    surface_size = (0, 0)
    user_state_verified = False
    try:
        # Use a deterministic, neutral public-safe project path. mkdir is atomic: if anything
        # already owns this exact location, abort rather than reading, overwriting or deleting it.
        fixture.mkdir(mode=0o700)
        fixture_owned = True
        write_fixture(fixture)
        state_dir.mkdir(mode=0o700)
        xvfb = subprocess.Popen([
            "Xvfb", display, "-screen", "0", f"{VIEWPORT[0]}x{VIEWPORT[1]}x24",
            "-nolisten", "tcp", "-noreset",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        wait_for(lambda: display_socket.exists(), "Xvfb did not become ready", 10)
        env = sanitized_environment(display)

        child = [
            str(python), str(Path(__file__).resolve()), "--fixture-run",
            "--fixture", str(fixture), "--state-dir", str(state_dir), "--status", str(status),
            "--model", args.model, "--base-url", args.base_url,
        ]
        tmux(socket_name, "new-session", "-d", "-s", "capture", "-x", "126", "-y", "32",
             shlex.join(child), env=env)
        # Xvfb has no window manager, so EWMH fullscreen requests are ignored. Use the measured cell
        # geometry that fits the 1280×720 capture surface. Hide tmux's
        # status line so a machine hostname never enters public pixels.
        tmux(socket_name, "set-option", "-g", "status", "off", env=env)
        terminal = subprocess.Popen([
            "dbus-run-session", "--", "gnome-terminal", "--wait", "--geometry=126x32+0+0",
            "--hide-menubar", "--", "tmux", "-L", socket_name, "attach-session", "-t", "capture",
        ], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        wait_for(lambda: status_state(status) in {"ready", "bootstrap_failed"},
                 "DGC TUI did not become ready", 30)
        if status_state(status) == "bootstrap_failed":
            detail = json.loads(status.read_text(encoding="utf-8")).get("error", "")
            raise RuntimeError("isolated DGC TUI bootstrap failed:\n" + str(detail)[-6000:])
        wait_for(
            lambda: terminal_surface_fits(display),
            "the real terminal window did not fill the capture surface", 8,
        )
        surface_size = terminal_surface_size(display)
        time.sleep(1.5)

        recorder = subprocess.Popen([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "x11grab",
            "-draw_mouse", "0", "-framerate", "30", "-video_size",
            f"{VIEWPORT[0]}x{VIEWPORT[1]}", "-i", f"{display}.0", "-an", "-c:v", "ffv1",
            str(raw),
        ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        started = time.monotonic()
        time.sleep(1.2)
        type_prompt(socket_name, PROMPT)
        try:
            wait_for(lambda: status_state(status) in {"passed", "failed"},
                     "the real DGC turn did not finish in time", MAX_RAW_SECONDS)
        except RuntimeError as exc:
            try:
                detail = json.loads(status.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                detail = {"state": "missing"}
            raise RuntimeError(f"{exc}; private status: {detail}") from exc
        if status_state(status) != "passed":
            detail = json.loads(status.read_text(encoding="utf-8"))
            raise RuntimeError(
                "DGC finished without a proven visible edit/test flow:\n"
                + json.dumps(detail, indent=2)[-6000:])
        remaining = MIN_CAPTURE_SECONDS - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(remaining)
        time.sleep(1.5)
        raw_seconds = time.monotonic() - started

        if recorder.stdin:
            recorder.stdin.write(b"q\n")
            recorder.stdin.flush()
        recorder.wait(timeout=15)
        if recorder.returncode != 0 or not raw.is_file():
            error = (recorder.stderr.read().decode("utf-8", "replace") if recorder.stderr else "")
            raise RuntimeError("ffmpeg screen recording failed: " + error[-1000:])

        passed, output = validate_fixture(fixture)
        if not passed:
            raise RuntimeError("final fixture verification failed:\n" + output)
        minimal, change_proof = validate_minimal_change(fixture)
        if not minimal:
            raise RuntimeError("final fixture change was not the required one-line scope: " + change_proof)
        tmux(socket_name, "send-keys", "-t", "capture", "C-c")
        time.sleep(0.25)
        tmux(socket_name, "send-keys", "-t", "capture", "C-c", check=False)
        wait_for(
            lambda: tmux(socket_name, "has-session", "-t", "capture", check=False).returncode != 0,
            "the isolated DGC TUI did not exit cleanly", 10,
        )
        changed = user_state_changes(before, user_state_snapshot(user_state))
        if changed:
            raise RuntimeError(
                "capture aborted: the real ~/.dgc tree changed during the run: "
                + ", ".join(changed[:20]))
        user_state_verified = True

        evidence = json.loads(status.read_text(encoding="utf-8"))
        required_evidence = (
            "worktree_import", "minimal_change", "edit_tool_visible", "exact_tool_sequence",
            "visible_tool_sequence", "test_tool_visible", "test_result_visible",
            "transcript_paths_clean", "sandbox_command_proven",
        )
        missing_evidence = [name for name in required_evidence if evidence.get(name) is not True]
        if missing_evidence:
            raise RuntimeError(
                "capture failed required pre-promotion evidence: " + ", ".join(missing_evidence))
        def commit_manifest(capture_factor: float) -> None:
            update_cli_manifest(
                args.output_dir.resolve(), model=args.model,
                dgc_version=str(evidence.get("dgc_version", "unknown")), factor=capture_factor)

        factor = encode_capture(
            raw, args.output_dir.resolve(), raw_seconds, manifest_update=commit_manifest)
        shown_seconds = raw_seconds / factor
        print(json.dumps({
            "model_route": f"local Ollama · {args.model}",
            "raw_seconds": round(raw_seconds, 3),
            "published_seconds": round(shown_seconds, 3),
            "time_compression": round(factor, 4),
            "user_dgc_unchanged": True,
            "fixture_tests": "passed",
            "current_worktree_import": True,
            "dgc_version": evidence.get("dgc_version", "unknown"),
            "minimal_change": evidence.get("minimal_change") is True,
            "edit_tool_visible": evidence.get("edit_tool_visible") is True,
            "exact_tool_sequence": evidence.get("exact_tool_sequence") is True,
            "visible_tool_sequence": evidence.get("visible_tool_sequence") is True,
            "test_tool_visible": evidence.get("test_tool_visible") is True,
            "test_result_visible": evidence.get("test_result_visible") is True,
            "transcript_paths_clean": evidence.get("transcript_paths_clean") is True,
            "sandbox_backend": evidence.get("sandbox_backend", "unproven"),
            "sandbox_command_proven": evidence.get("sandbox_command_proven") is True,
            "terminal_surface": surface_size,
        }, indent=2))
        return 0
    finally:
        if recorder and recorder.poll() is None:
            if recorder.stdin:
                try:
                    recorder.stdin.write(b"q\n")
                    recorder.stdin.flush()
                except OSError:
                    pass
            stop_process(recorder)
        tmux(socket_name, "kill-server", check=False)
        stop_process(terminal)
        stop_process(xvfb)
        user_state_changed = (
            user_state_changes(before, user_state_snapshot(user_state))
            if not user_state_verified else [])
        if args.keep_work:
            print(f"capture workspace retained at {work}; fixture at {fixture}", file=sys.stderr)
        else:
            shutil.rmtree(work, ignore_errors=True)
            if fixture_owned and fixture == Path(tempfile.gettempdir()) / "clamp-demo-worktree":
                shutil.rmtree(fixture, ignore_errors=True)
        if user_state_changed:
            raise RuntimeError(
                "capture aborted: the real ~/.dgc tree changed during the run: "
                + ", ".join(user_state_changed[:20]))


def main() -> int:
    args = parse_args()
    if args.fixture_run:
        try:
            return run_fixture_child(args)
        except Exception:
            if args.status:
                write_json(args.status.resolve(), {
                    "state": "bootstrap_failed",
                    "error": traceback.format_exc(),
                })
            raise
    return render(args)


if __name__ == "__main__":
    raise SystemExit(main())
