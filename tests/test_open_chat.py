"""Sessions in other directories, in one backend: open_chat, the chat envelope, close_chat.

Codex's model: one process holds many sessions, each with its own directory, config, trust, MCP
servers and mode. A client opts in by sending open_chat; from then on every chat-scoped event and
command says which chat it belongs to. A client that never opts in never sees the field.
"""
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

# Hermetic like tests/test_todo_lifecycle.py: redirect HOME before any dgc module reads it.


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError(
            "tests/test_open_chat.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-open-chat-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.editor_protocol import command_error, event_error  # noqa: E402

_SECRET_B = "tvly-chat-b-only-secret-1a2b3c4d5e6f"


class OpenChatTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-open-chat-")).resolve()
        self.tmp = tmp
        user_dgc = tmp / "user-dgc"
        user_dgc.mkdir()
        for name, value in (("USER_HOME", user_dgc), ("USER_CONFIG", user_dgc / "config.json"),
                            ("USER_SECRETS", user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (user_dgc / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_PROJECT_ROOT", None)
        for name in ("a", "b"):
            (tmp / name).mkdir()
            (tmp / name / ".git").mkdir()             # a project marker: the root is the folder
        self.wire = io.StringIO()
        self.host = headless.Host(Config(project_root=tmp / "a"))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def wait_for(self, predicate, timeout=20.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = [frame for frame in self.frames() if predicate(frame)]
            if found:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no matching frame within {timeout}s: {self.frames()[-5:]}")

    def open_b(self, request_id="o1"):
        self.host.dispatch({"type": "open_chat", "request_id": request_id, "cwd": str(self.tmp / "b")})
        return self.wait_for(lambda f: f["type"] in ("chat_opened", "command_rejected")
                             and f.get("request_id") == request_id)

    def test_ready_offers_chats_and_names_the_default(self):
        self.host.start()
        ready = next(frame for frame in self.frames() if frame["type"] == "ready")
        self.assertEqual(ready["capabilities"]["chats"], {"version": 1, "max": headless._MAX_CHATS,
                                                          "default": self.host.default.chat_id})
        self.assertNotIn("chat_id", ready)

    def test_a_chat_opens_in_its_own_directory(self):
        opened = self.open_b()
        self.assertEqual(opened["type"], "chat_opened", opened)
        self.assertIsNone(event_error(opened), event_error(opened))
        self.assertNotEqual(opened["chat_id"], self.host.default.chat_id)
        self.assertEqual(Path(opened["project_root"]), self.tmp / "b")
        self.assertFalse(opened["workspace_trusted"])
        chat = self.host.chats[opened["chat_id"]]
        self.assertEqual(Path(chat.agent.config.project_root), self.tmp / "b",
                         "the chat's tools would run in the default chat's directory")
        self.assertIsNot(chat.config, self.host.default.config)

    def test_after_opting_in_every_chat_says_which_it_is(self):
        opened = self.open_b()
        self.host.dispatch({"type": "name_session", "request_id": "n1", "name": "in b",
                            "chat_id": opened["chat_id"]})
        self.host.dispatch({"type": "name_session", "request_id": "n2", "name": "in a"})
        named_b = self.wait_for(lambda f: f["type"] == "session_named" and f.get("request_id") == "n1")
        named_a = self.wait_for(lambda f: f["type"] == "session_named" and f.get("request_id") == "n2")
        self.assertEqual(named_b["chat_id"], opened["chat_id"])
        self.assertEqual(named_a["chat_id"], self.host.default.chat_id,
                         "an untagged command goes to the default chat, which now says so")
        self.assertEqual(self.host.chats[opened["chat_id"]].agent.session_name, "in b")
        self.assertEqual(self.host.default.agent.session_name, "in a")
        for frame in self.frames():
            self.assertIsNone(event_error(frame), event_error(frame))

    def test_opening_returns_at_once_while_the_chat_is_built(self):
        """Building a chat connects its MCP servers -- seconds each -- and the stdin thread is
        where every other chat's Stop and approvals arrive."""
        release = threading.Event()
        real = headless.Backend.__init__

        def slow_init(backend, *args, **kwargs):
            if kwargs.get("chat_id") not in ("", self.host.default.chat_id):
                release.wait(10)
            return real(backend, *args, **kwargs)
        with patch.object(headless.Backend, "__init__", slow_init):
            started = time.monotonic()
            self.host.dispatch({"type": "open_chat", "request_id": "slow", "cwd": str(self.tmp / "b")})
            self.assertLess(time.monotonic() - started, 1.0, "open_chat blocked the command thread")
            self.host.dispatch({"type": "name_session", "request_id": "n3", "name": "still served"})
            self.wait_for(lambda f: f.get("request_id") == "n3", timeout=2)
            release.set()
            self.wait_for(lambda f: f["type"] == "chat_opened" and f.get("request_id") == "slow")

    def test_a_bad_cwd_or_a_pinned_backend_is_refused(self):
        self.host.dispatch({"type": "open_chat", "request_id": "rel", "cwd": "relative/dir"})
        self.assertEqual(self.wait_for(lambda f: f.get("request_id") == "rel")["reason"], "invalid_cwd")
        os.environ["DGC_PROJECT_ROOT"] = str(self.tmp / "a")
        self.host.dispatch({"type": "open_chat", "request_id": "pin", "cwd": str(self.tmp / "b")})
        self.assertEqual(self.wait_for(lambda f: f.get("request_id") == "pin")["reason"], "pinned")
        self.assertEqual(self.host.default._chats_capability(), {}, "a pinned backend never offers chats")

    def test_a_command_for_an_unknown_chat_is_refused_by_name(self):
        self.open_b()
        self.host.dispatch({"type": "name_session", "request_id": "x1", "name": "z", "chat_id": "c99"})
        rejected = self.wait_for(lambda f: f.get("request_id") == "x1")
        self.assertEqual((rejected["type"], rejected["reason"], rejected["chat_id"]),
                         ("command_rejected", "unknown_chat", "c99"))

    def test_close_chat_ends_that_chat_and_keeps_its_secret_redacted(self):
        opened = self.open_b()
        chat_id = opened["chat_id"]
        self.host.chats[chat_id].config.data["search_api_key"] = _SECRET_B
        self.host.dispatch({"type": "close_chat", "request_id": "cl", "chat_id": chat_id})
        closed = self.wait_for(lambda f: f["type"] == "chat_closed")
        self.assertEqual((closed["chat_id"], closed["reason"], closed["request_id"]), (chat_id, "closed", "cl"))
        self.wait_for(lambda f: True)
        deadline = time.monotonic() + 5
        while chat_id in self.host.chats and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertNotIn(chat_id, self.host.chats)
        self.host.default.em.emit("info", message=f"echo {_SECRET_B}")
        self.assertNotIn(_SECRET_B, self.wire.getvalue(), "a closed chat's key crossed the wire raw")
        self.host.dispatch({"type": "name_session", "request_id": "after", "name": "z", "chat_id": chat_id})
        self.assertEqual(self.wait_for(lambda f: f.get("request_id") == "after")["reason"], "unknown_chat")

    def test_the_default_chat_cannot_be_closed(self):
        self.open_b()
        self.host.dispatch({"type": "close_chat", "request_id": "d", "chat_id": self.host.default.chat_id})
        self.assertEqual(self.wait_for(lambda f: f.get("request_id") == "d")["reason"], "default_chat")

    def test_a_chat_opened_later_has_the_launchers_key(self):
        """A DGC_*_FILE key is read once, by the first Config, and its file deleted."""
        default = self.host.default.config
        default.data["base_url"] = "https://provider.example/v1"
        default.set_runtime_secret("api_key", "sk-launcher-key-0123456789")
        later = Config(project_root=self.tmp / "b")
        later.data["base_url"] = "https://provider.example/v1"
        self.assertEqual(later.get("api_key"), "")
        later.adopt_runtime_secrets(default)
        self.assertEqual(later.get("api_key"), "sk-launcher-key-0123456789")
        later.data["base_url"] = "https://elsewhere.example/v1"
        self.assertEqual(later.get("api_key"), "", "a runtime key never follows the chat to another endpoint")

    def test_an_opened_chat_authenticates_with_the_launchers_key(self):
        default = self.host.default.config
        user_config = json.loads(config_module.USER_CONFIG.read_text())
        user_config["base_url"] = "https://provider.example/v1"
        config_module.USER_CONFIG.write_text(json.dumps(user_config))
        default.data["base_url"] = "https://provider.example/v1"
        default.set_runtime_secret("api_key", "sk-launcher-key-abcdef0123")
        opened = self.open_b("key")
        self.assertEqual(self.host.chats[opened["chat_id"]].config.get("api_key"),
                         "sk-launcher-key-abcdef0123", "the new chat would send every request with no key")

    def test_a_deny_added_in_one_chat_binds_every_open_chat_at_once(self):
        from dgc.permissions import PermissionEngine
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]

        def decide(chat):
            rules = {a: list(chat.config.permissions.get(a, [])) for a in ("allow", "ask", "deny")}
            return PermissionEngine("auto", rules, chat.config.project_root).decide(
                "bash", {"command": "rm -rf build"})[0]
        self.assertEqual(decide(other), "allow", "premise: nothing denies it yet")
        self.host.dispatch({"type": "add_permission_rule", "request_id": "deny", "action": "deny",
                            "rule": "Bash(rm -rf *)"})
        self.wait_for(lambda f: f["type"] == "permissions" and f.get("request_id") == "deny")
        self.assertEqual(decide(other), "deny", "the other chat ran what the user had just denied")

    def test_a_deny_added_in_an_opened_chat_binds_the_default_one(self):
        from dgc.permissions import PermissionEngine
        opened = self.open_b()
        self.host.dispatch({"type": "add_permission_rule", "request_id": "deny-b", "action": "deny",
                            "rule": "Bash(rm -rf *)", "chat_id": opened["chat_id"]})
        self.wait_for(lambda f: f["type"] == "permissions" and f.get("request_id") == "deny-b")
        default = self.host.default.config
        rules = {a: list(default.permissions.get(a, [])) for a in ("allow", "ask", "deny")}
        self.assertEqual(PermissionEngine("auto", rules, default.project_root).decide(
            "bash", {"command": "rm -rf build"})[0], "deny", "a chat opened later never told the others")

    def test_a_trust_grant_in_one_chat_reaches_another_in_that_folder(self):
        (self.tmp / "a" / ".dgc").mkdir(exist_ok=True)
        (self.tmp / "a" / ".dgc" / "permissions.json").write_text(json.dumps({"deny": ["Bash(curl *)"]}))
        self.host.dispatch({"type": "open_chat", "request_id": "same", "cwd": str(self.tmp / "a")})
        opened = self.wait_for(lambda f: f["type"] == "chat_opened" and f.get("request_id") == "same")
        sibling = self.host.chats[opened["chat_id"]]
        self.assertFalse(sibling.workspace_trusted)
        self.host.dispatch({"type": "set_mode", "request_id": "trust", "mode": "acceptEdits",
                            "acknowledge_workspace_trust": True})
        self.wait_for(lambda f: f["type"] == "mode_changed")
        self.assertTrue(sibling.workspace_trusted, "the same folder, trusted, still asked for trust")
        self.assertIn("Bash(curl *)", sibling.config.permissions["deny"],
                      "trusted without the project's own rules")

    def test_an_mcp_server_removed_in_one_chat_stops_in_the_others(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        stopped = []

        class Live:
            tools = []

            def __init__(self, name):
                self.name = name

            def stop(self):
                stopped.append(self.name)
        specs = {"kept": {"command": "kept-bin", "args": []}, "gone": {"command": "gone-bin", "args": []}}
        for chat in (self.host.default, other):          # both chats run both servers
            chat.config.data["mcp_servers"] = {name: dict(spec) for name, spec in specs.items()}
            chat.config._rebaseline()
        for name, spec in specs.items():
            other.agent.mcp.servers[name] = Live(name)
            other.agent.mcp._runtime_specs[name] = dict(spec)
        self.host.default.config.set("mcp_servers", {"kept": dict(specs["kept"])})   # the user removes one
        deadline = time.monotonic() + 5
        while "gone" in other.agent.mcp.servers and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertNotIn("gone", other.agent.mcp.servers, "a removed server kept running in another chat")
        self.assertEqual(stopped, ["gone"], "an unchanged server was restarted under a running turn")
        self.assertIn("kept", other.agent.mcp.servers)

    def test_a_chats_own_model_is_not_a_user_wide_change(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        self.host.default.config.set("model", "another-model")
        self.assertEqual(other.config.data["model"], "fixture", "one chat's model switch moved another's")

    def test_a_slow_command_in_one_chat_never_holds_another(self):
        """A compact is a model request; inline on the stdin thread it froze every chat."""
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        release, started = threading.Event(), threading.Event()

        def slow_compact(**kwargs):
            started.set()
            release.wait(10)
            return False
        other.agent.maybe_compact = slow_compact
        self.host.dispatch({"type": "compact", "request_id": "slow", "chat_id": opened["chat_id"]})
        self.assertTrue(started.wait(5), "premise: chat B's compact is running")
        self.host.dispatch({"type": "name_session", "request_id": "a-meanwhile", "name": "a"})
        self.wait_for(lambda f: f.get("request_id") == "a-meanwhile", timeout=2)
        self.host.dispatch({"type": "name_session", "request_id": "b-after", "name": "b",
                            "chat_id": opened["chat_id"]})
        time.sleep(0.2)
        self.assertFalse([f for f in self.frames() if f.get("request_id") == "b-after"],
                         "chat B's own commands keep their order behind its compact")
        rid, answered = other.pending.register()
        self.host.dispatch({"type": "permission_response", "id": rid, "decision": "once",
                            "chat_id": opened["chat_id"]})
        self.assertTrue(answered.wait(2), "an answer the turn waits on was queued behind the compact")
        release.set()
        self.wait_for(lambda f: f.get("request_id") == "b-after", timeout=5)

    def test_a_queued_command_that_raises_is_reported_and_the_queue_lives(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        failures = []
        self.host.command_failed = lambda cmd, exc: failures.append(cmd["type"])
        real = other.dispatch

        def explode(cmd):
            if cmd.get("type") == "get_goal":
                raise RuntimeError("boom")
            return real(cmd)
        other.dispatch = explode
        with patch("sys.stderr", io.StringIO()):
            self.host.dispatch({"type": "get_goal", "request_id": "g", "chat_id": opened["chat_id"]})
            error = self.wait_for(lambda f: f["type"] == "error" and "boom" in f.get("message", ""))
            self.assertEqual(error["chat_id"], opened["chat_id"])
            self.host.dispatch({"type": "name_session", "request_id": "next", "name": "x",
                                "chat_id": opened["chat_id"]})
            self.wait_for(lambda f: f.get("request_id") == "next")
        self.assertEqual(failures, ["get_goal"])

    def test_the_note_lists_every_chat_and_an_ask_for_any_of_them_is_answered(self):
        from dgc import peers
        with patch.object(peers, "peers_dir", lambda: self.tmp / "peers"):
            opened = self.open_b()
            other = self.host.chats[opened["chat_id"]]
            other.agent.session_file = self.tmp / "b" / ".dgc" / "sessions" / "second.json"
            self.host.announce_peers()
            note = json.loads((self.tmp / "peers" / f"{os.getpid()}.json").read_text())
            listed = [Path(item["session"]).name for item in note.get("sessions", [])]
            self.assertIn("second.json", listed, "the process's note named only its first chat")
            directory = peers.takeover_dir()
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f"{os.getpid()}.ask.json").write_text(json.dumps({
                "session": str(other.agent.session_file), "asker": 1, "holder": os.getpid(),
                "at": time.time()}))
            self.host.default._editor_liveness = None      # cannot tell: it must still ANSWER
            self.host.default._consider_release()
            answer = peers.release_answer(os.getpid())
            self.assertIsNotNone(answer, "an ask for the second chat's session was never answered")
            self.assertFalse(answer["granted"])

    def test_the_envelope_is_valid_only_as_a_short_string(self):
        self.assertIsNone(command_error({"type": "ping", "chat_id": "c1"}))
        self.assertIsNotNone(command_error({"type": "ping", "chat_id": ""}))
        self.assertIsNotNone(command_error({"type": "ping", "chat_id": 7}))
        self.assertIsNotNone(command_error({"type": "ping", "chat_id": "x" * 65}))

    def test_too_many_chats_is_refused(self):
        with patch.object(headless, "_MAX_CHATS", 1):
            self.host.dispatch({"type": "open_chat", "request_id": "full", "cwd": str(self.tmp / "b")})
            self.assertEqual(self.wait_for(lambda f: f.get("request_id") == "full")["reason"], "too_many_chats")

    def test_a_chat_still_being_built_at_shutdown_closes_itself(self):
        release = threading.Event()
        real = headless.Backend.__init__
        built = []

        def slow_init(backend, *args, **kwargs):
            if kwargs.get("chat_id") not in ("", self.host.default.chat_id):
                release.wait(10)
                built.append(backend)
            return real(backend, *args, **kwargs)
        with patch.object(headless.Backend, "__init__", slow_init), \
                patch("dgc.peers.withdraw", lambda: None):
            self.host.dispatch({"type": "open_chat", "request_id": "late", "cwd": str(self.tmp / "b")})
            self.host.close(grace_s=0)
            release.set()
            deadline = time.monotonic() + 10
            while not built and time.monotonic() < deadline:
                time.sleep(0.02)
            time.sleep(0.3)
        self.assertEqual(len(self.host.chats), 1, "a chat built after shutdown was left running")
        self.assertFalse([f for f in self.frames() if f["type"] == "chat_opened"])


    # ---- the user-wide MCP fan-out ---------------------------------------------------------------

    def fan_out(self, other, saved: dict, live: dict):
        """Both chats hold `saved`; `other` runs `live` ({name: (runtime spec, saved spec)})."""
        connected, stopped = [], []

        class Live:
            tools = []

            def __init__(self, name):
                self.name = name

            def stop(self):
                stopped.append(self.name)
        for chat in (self.host.default, other):
            chat.config.data["mcp_servers"] = {name: dict(spec) for name, spec in saved.items()}
            chat.config._rebaseline()
        manager = other.agent.mcp
        for name, (runtime, persisted) in live.items():
            manager.servers[name] = Live(name)
            manager._runtime_specs[name] = dict(runtime)
            manager.note_persisted(name, persisted)
        manager.connect_all = lambda servers, **kw: connected.extend(servers)
        return connected, stopped

    def settle_fan_out(self):
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if not [t for t in threading.enumerate() if t.name.startswith("dgc-refresh-")]:
                return
            time.sleep(0.02)

    def test_another_chats_change_never_restarts_a_credentialed_server(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        os.environ.pop("GH_TOKEN", None)
        persisted = {"command": "gh-mcp", "args": [], "env_names": ["GH_TOKEN"]}
        runtime = {**persisted, "env": {"GH_TOKEN": "ghp-chat-b-token-0123456789"}}
        connected, stopped = self.fan_out(other, {"gh": persisted}, {"gh": (runtime, persisted)})
        self.host.default.config.set("mcp_servers", {"gh": dict(persisted),
                                                     "plain": {"command": "plain-bin", "args": []}})
        self.settle_fan_out()
        self.assertEqual(stopped, [], "the authenticated server was stopped under the other chat")
        self.assertEqual(connected, ["plain"], "the server was restarted without its token")

    def test_another_chats_change_never_launches_a_setup_only_or_credentialed_server(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        os.environ.pop("NEEDS_TOKEN", None)
        connected, _ = self.fan_out(other, {}, {})
        self.host.default.config.set("mcp_servers", {
            "setup": {"command": "setup-bin", "args": [], "defer_until_setup": True},
            "cred": {"command": "cred-bin", "args": [], "env_names": ["NEEDS_TOKEN"]},
            "plain": {"command": "plain-bin", "args": []}})
        self.settle_fan_out()
        self.assertEqual(connected, ["plain"])

    def test_a_server_whose_saved_form_changed_is_reconnected(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        old = {"command": "srv-bin", "args": ["--old"]}
        connected, stopped = self.fan_out(other, {"srv": old}, {"srv": (old, old)})
        self.host.default.config.set("mcp_servers", {"srv": {"command": "srv-bin", "args": ["--new"]}})
        self.settle_fan_out()
        self.assertEqual(connected, ["srv"], "a changed server kept running its old configuration")

    def test_a_server_connected_with_credentials_remembers_its_saved_form(self):
        manager = self.host.default.agent.mcp
        class Live:
            tools = []

            def stop(self):
                pass
        manager.connect_all = lambda servers, **kw: manager.servers.update(
            {name: Live() for name in servers})
        persisted = {"command": "gh-mcp", "args": [], "env_names": ["GH_TOKEN"]}
        runtime = {**persisted, "env": {"GH_TOKEN": "ghp-default-token-0123456789"}}
        with patch.object(self.host.default, "_emit_mcp_servers", lambda *a, **k: None):
            self.host.dispatch({"type": "upsert_mcp_server", "request_id": "gh", "name": "gh",
                                "runtime": runtime, "persisted": persisted})
        saved = self.host.default.config.get("mcp_servers")["gh"]
        self.assertTrue(manager.unchanged("gh", saved, runtime),
                        "the next fan-out would restart it without its token")

    def test_a_chat_that_is_closing_takes_no_fan_out(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        connected, _ = self.fan_out(other, {}, {})
        self.host._closing.add(opened["chat_id"])
        self.host.default.config.set("mcp_servers", {"plain": {"command": "plain-bin", "args": []}})
        self.settle_fan_out()
        self.assertEqual(connected, [], "a closing chat connected a server nothing would ever stop")

    def test_a_connect_that_finishes_after_its_chat_closed_stops_its_server(self):
        from dgc import mcp as mcp_module
        manager = mcp_module.MCPManager(self.tmp / "a")
        stopped, started = [], []

        class Server:
            tools, error, remote_bridge = [], "", False

            def __init__(self, *args, **kwargs):
                pass

            def start(self, **kwargs):
                started.append(True)
                manager.close()                     # the chat closes while this connect runs
                return True

            def stop(self):
                stopped.append(True)
        with patch.object(mcp_module, "MCPServer", Server):
            manager.connect_all({"late": {"command": "late-bin", "args": []}})
            self.assertEqual(manager.servers, {}, "a server started after close was kept")
            self.assertEqual(stopped, [True], "and nothing would ever have stopped it")
            manager.connect_all({"later": {"command": "later-bin", "args": []}})
        self.assertEqual(started, [True], "a closed chat's manager started another server")

    # ---- a chat that closes, a chat still being built -------------------------------------------

    def test_a_closed_chat_takes_its_shells_kernel_and_browser_with_it(self):
        from dgc import tools as tools_module
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        owner = other.agent.ctx.tool_owner
        stopped = []
        with patch.object(tools_module, "shutdown_background", lambda o: stopped.append(("bash", o))), \
                patch.object(tools_module, "shutdown_python_kernels", lambda o=None: stopped.append(("python", o))), \
                patch.object(tools_module, "shutdown_browsers", lambda o=None: stopped.append(("browser", o))):
            self.host.dispatch({"type": "close_chat", "request_id": "bye", "chat_id": opened["chat_id"]})
            self.wait_for(lambda f: f["type"] == "chat_closed")
        self.assertEqual(sorted(stopped), [("bash", owner), ("browser", owner), ("python", owner)])
        self.assertTrue(other._package_cancel.is_set(), "a plugin connect in flight kept running")
        self.assertTrue(other.agent.mcp._closed, "a connect still running could add a server after close")

    def test_retiring_the_first_chat_takes_its_background_shells_with_it(self):
        # The process's first chat cannot be closed while others stay on it, so its tab's close
        # retires it with a new session (backend.ts close()). Its dev server kept its port until
        # the window closed; closing that tab used to end its own process, and the shells with it.
        from dgc import tools as tools_module
        self.open_b()
        owner = self.host.default.agent.ctx.tool_owner
        stopped = []
        with patch.object(tools_module, "shutdown_background", lambda o: stopped.append(o)):
            self.host.dispatch({"type": "new_session", "request_id": f"{headless.RETIRE_REQUEST_PREFIX}4242-1"})
            self.wait_for(lambda f: f["type"] == "session" and f.get("kind") == "new"
                          and str(f.get("request_id", "")).startswith(headless.RETIRE_REQUEST_PREFIX))
        self.assertEqual(stopped, [owner])

    def test_a_plain_new_chat_keeps_its_background_shells(self):
        from dgc import tools as tools_module
        stopped = []
        with patch.object(tools_module, "shutdown_background", lambda o: stopped.append(o)):
            self.host.dispatch({"type": "new_session", "request_id": "plain-new"})
            self.wait_for(lambda f: f["type"] == "session" and f.get("request_id") == "plain-new")
        self.assertEqual(stopped, [], "a new chat in the same tab stopped the previous one's dev server")

    def _child_with_background_shell(self, parent, *, entered=None, release=None):
        from dgc.agent import Agent, _SubUI
        from dgc import sandbox, tools
        processes = []

        def turn(child, prompt):
            # This fixture tests process ownership, independently of OS sandbox availability.
            # The config is boolean: the string "off" is truthy and requests a sandbox.
            child.config.data["sandbox"] = False
            result = tools._bash_background("sleep 120", child.ctx)
            self.assertNotIn("error:", result)
            with tools._BG_LOCK:
                entries = [e for e in tools._BG.values() if e["owner"] == child.ctx.tool_owner]
            processes.extend(e["proc"] for e in entries)
            self.addCleanup(tools.shutdown_background, child.ctx.tool_owner)
            if entered is not None:
                entered.set()
                release.wait(10)
            child.ui.on_text("Server started.")
            child.ui.end_stream()
            return True

        def run():
            with patch.object(Agent, "run_turn", turn), \
                    patch.object(sandbox, "_backend", return_value=None):
                failure, _, start_error = parent._execute_prepared_subagent(
                    "server", "start", "", None,
                    _SubUI(parent.ui, "server", cancel=parent.cancelled))
                self.assertEqual((failure, start_error), ("", ""))
        return run, processes

    def test_closing_a_chat_stops_a_finished_childs_shell_and_keeps_another_chats_shell(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        run, processes = self._child_with_background_shell(other.agent)
        run()
        sibling_run, sibling = self._child_with_background_shell(self.host.default.agent)
        sibling_run()
        self.assertEqual(len(processes), 1)
        self.assertIsNone(processes[0].poll(), "a finished sub-task's server must live until chat close")
        self.host.dispatch({"type": "close_chat", "request_id": "bye", "chat_id": opened["chat_id"]})
        self.wait_for(lambda f: f["type"] == "chat_closed")
        self.assertIsNotNone(processes[0].poll(), "the closed chat leaked its child's server")
        self.assertIsNone(sibling[0].poll(), "closing one chat stopped another chat's child")

    def test_retiring_the_first_chat_stops_its_finished_childs_shell(self):
        self.open_b()
        run, processes = self._child_with_background_shell(self.host.default.agent)
        run()
        request = headless.RETIRE_REQUEST_PREFIX + "child"
        self.host.dispatch({"type": "new_session", "request_id": request})
        self.wait_for(lambda f: f["type"] == "session" and f.get("request_id") == request)
        self.assertIsNotNone(processes[0].poll())
        again, next_processes = self._child_with_background_shell(self.host.default.agent)
        again()
        self.assertEqual(len(next_processes), 1, "the retired backend must support a new chat")
        self.assertIsNone(next_processes[0].poll())

    def test_closing_a_chat_stops_a_running_childs_shell(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        entered, release = threading.Event(), threading.Event()
        run, processes = self._child_with_background_shell(other.agent, entered=entered, release=release)
        worker = threading.Thread(target=run)
        worker.start()
        try:
            self.assertTrue(entered.wait(10))
            self.host.dispatch({"type": "close_chat", "request_id": "bye", "chat_id": opened["chat_id"]})
            self.wait_for(lambda f: f["type"] == "chat_closed")
            self.assertIsNotNone(processes[0].poll())
        finally:
            release.set()
            worker.join(10)
        self.assertFalse(worker.is_alive())

    def test_only_that_owners_background_shells_are_stopped(self):
        from dgc import tools as tools_module
        killed = []
        entries = {"b1": {"owner": "mine", "finished": None, "proc": "p-mine"},
                   "b2": {"owner": "theirs", "finished": None, "proc": "p-theirs"},
                   "b3": {"owner": "mine", "finished": 1.0, "proc": "p-done"}}
        with patch.dict(tools_module._BG, entries, clear=True), \
                patch.object(tools_module, "_terminate_background", lambda proc, **kw: killed.append(proc)), \
                patch.object(tools_module, "_join_background_reader", lambda entry: None):
            tools_module.shutdown_background("mine")
            self.assertEqual(killed, ["p-mine"])
            tools_module.shutdown_background("")
            self.assertEqual(killed, ["p-mine"], "an empty owner stopped everyone's")

    def test_a_chat_built_while_another_saved_a_deny_takes_it(self):
        from dgc.permissions import PermissionEngine
        release, entered = threading.Event(), threading.Event()
        real = headless.Backend.__init__

        def slow_init(backend, *args, **kwargs):
            if kwargs.get("chat_id") not in ("", self.host.default.chat_id):
                entered.set()
                release.wait(10)
            return real(backend, *args, **kwargs)
        with patch.object(headless.Backend, "__init__", slow_init):
            self.host.dispatch({"type": "open_chat", "request_id": "slow", "cwd": str(self.tmp / "b")})
            self.assertTrue(entered.wait(10))
            self.host.dispatch({"type": "add_permission_rule", "request_id": "deny", "action": "deny",
                                "rule": "Bash(rm -rf *)"})
            self.wait_for(lambda f: f["type"] == "permissions" and f.get("request_id") == "deny")
            release.set()
            opened = self.wait_for(lambda f: f["type"] == "chat_opened" and f.get("request_id") == "slow")
        chat = self.host.chats[opened["chat_id"]]
        rules = {a: list(chat.config.permissions.get(a, [])) for a in ("allow", "ask", "deny")}
        self.assertEqual(PermissionEngine("auto", rules, chat.config.project_root).decide(
            "bash", {"command": "rm -rf build"})[0], "deny",
            "a deny saved while the chat was being built did not bind it")

    def test_a_malformed_chat_id_is_refused_by_name(self):
        self.open_b()
        for bad in ([1], "c" * 65, ""):
            with self.subTest(bad=bad):
                self.host.dispatch({"type": "get_config", "request_id": "g1", "chat_id": bad})
                refused = self.wait_for(lambda f: f["type"] == "command_rejected"
                                        and f.get("request_id") == "g1")
                self.assertEqual(refused["reason"], "invalid_command")
                self.wire.truncate(0)
                self.wire.seek(0)

    def test_shutdown_finishes_a_running_chat_command_and_starts_no_queued_one(self):
        opened = self.open_b()
        other = self.host.chats[opened["chat_id"]]
        started, release, ran = threading.Event(), threading.Event(), []
        real = other.dispatch

        def dispatch(cmd):
            if cmd.get("type") == "rewind":
                started.set()
                release.wait(10)                 # a rewind writing the user's files
                ran.append("rewind")
                return None
            ran.append(cmd.get("type"))
            return real(cmd)
        other.dispatch = dispatch
        self.host.dispatch({"type": "rewind", "request_id": "r", "index": 0, "chat_id": opened["chat_id"]})
        self.host.dispatch({"type": "get_config", "request_id": "q", "chat_id": opened["chat_id"]})
        self.assertTrue(started.wait(5))
        threading.Timer(0.3, release.set).start()
        with patch("dgc.peers.withdraw", lambda: None):
            self.host.close(grace_s=0)
        self.assertEqual(ran, ["rewind"], "shutdown cut the rewind off, or started what was queued")

    def test_two_reloads_never_discover_at_once(self):
        import dgc.agent as agent_module
        agent = self.host.default.agent
        inside, peak, gate = [0], [0], threading.Event()
        real = agent_module.discover_skills

        def discover(*args, **kwargs):
            inside[0] += 1
            peak[0] = max(peak[0], inside[0])
            gate.wait(0.3)
            inside[0] -= 1
            return real(*args, **kwargs)
        with patch.object(agent_module, "discover_skills", discover):
            threads = [threading.Thread(target=agent.reload_skills) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(5)
        self.assertEqual(peak[0], 1, "an older discovery could finish last and drop the new skills")

    # ---- chats that share one checkout ------------------------------------------------------------

    def test_chats_in_one_checkout_know_about_each_other(self):
        self.host.dispatch({"type": "open_chat", "request_id": "same", "cwd": str(self.tmp / "a")})
        sibling = self.host.chats[self.wait_for(
            lambda f: f["type"] == "chat_opened" and f.get("request_id") == "same")["chat_id"]]
        self.open_b()
        with patch("dgc.peers.others", lambda **kw: []):
            seen = self.host.default.agent._peers_here()
            line = self.host.default.agent._attach_peer_line("hello")
        self.assertEqual([p["chat"] for p in seen], [sibling.chat_id],
                         "a chat in another folder counted, or the sibling did not")
        self.assertIn("<dgc-peers>1 other DGC agent", line)

    def test_a_session_open_in_another_chat_says_so(self):
        self.host.dispatch({"type": "open_chat", "request_id": "same", "cwd": str(self.tmp / "a")})
        sibling = self.host.chats[self.wait_for(
            lambda f: f["type"] == "chat_opened" and f.get("request_id") == "same")["chat_id"]]
        sibling.agent.session_file = self.host.default.agent.session_file
        message = sibling.agent._held_session_message("Start a new session.")
        self.assertIn("open in another chat in this window", message)
        self.assertNotIn("15 minutes", message)


if __name__ == "__main__":
    unittest.main()
