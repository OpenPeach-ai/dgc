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


if __name__ == "__main__":
    unittest.main()
