"""One `dgc serve` process, several chats: what the Host owns and what each chat keeps.

The Host holds the process's one wire and one request registry, routes commands, answers the
liveness watchdog for every chat, and closes them all. Each chat is a Backend with its own config.
"""
import io
import json
import os
import sys
import tempfile
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
            "tests/test_host.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-host-tests-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import Config  # noqa: E402

_SECRET_B = "tvly-chat-b-only-secret-9f8e7d6c5b4a"


class HostTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-host-")).resolve()
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
        for name in ("a", "b"):
            (tmp / name).mkdir()
        self.host = headless.Host(Config(project_root=tmp / "a"))
        self.wire = io.StringIO()
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def second_chat(self):
        config = Config(project_root=self.tmp / "b")
        config.data["search_api_key"] = _SECRET_B          # a credential only chat B holds
        return self.host.add_chat(config)

    def test_with_one_chat_the_wire_is_the_old_one(self):
        self.host.dispatch({"type": "name_session", "request_id": "n1", "name": "renamed"})
        frame = self.frames()[-1]
        self.assertEqual(frame["type"], "session_named")
        self.assertNotIn("chat_id", frame, "a client that never opted in must never see chat_id")
        self.assertEqual(self.host.default.agent.session_name, "renamed")

    def test_a_one_chat_backend_leaves_exactly_the_old_note(self):
        from dgc import peers
        with patch.object(peers, "peers_dir", lambda: self.tmp / "peers"):
            self.host.announce_peers()
            note = json.loads((self.tmp / "peers" / f"{os.getpid()}.json").read_text())
        self.assertNotIn("sessions", note, "a single chat must leave the note every DGC version reads")
        self.assertEqual(note["project_root"], str(self.tmp / "a"))

    def test_each_chat_has_its_own_directory_and_config(self):
        second = self.second_chat()
        self.assertNotEqual(second.config.project_root, self.host.default.config.project_root)
        self.assertIsNot(second.agent, self.host.default.agent)
        self.assertEqual(Path(second.agent.config.project_root), self.tmp / "b")

    def test_the_shared_wire_redacts_every_chats_secrets(self):
        """Chat A's event carrying chat B's key -- a tool printing the environment -- went out raw
        when the wire redacted with one config's secrets."""
        self.second_chat()
        self.host.default.em.emit("info", message=f"env says SEARCH_KEY={_SECRET_B}")
        self.assertNotIn(_SECRET_B, self.wire.getvalue(), "chat B's credential crossed the shared wire")

    def test_ids_are_unique_and_a_stop_stays_in_its_chat(self):
        second = self.second_chat()
        a_id, a_event = self.host.default.pending.register()
        b_id, b_event = second.pending.register()
        self.assertNotEqual(a_id, b_id)
        self.host.default.pending.cancel_all({"decision": "no"})
        self.assertTrue(a_event.is_set())
        self.assertFalse(b_event.is_set(), "a Stop in one chat denied another chat's approval")

    def test_any_working_chat_keeps_the_process_alive(self):
        second = self.second_chat()
        self.assertEqual(self.host.keepalive_reason(), "")
        second.agent.goal = "ship the parser"
        self.assertEqual(self.host.keepalive_reason(), "a goal is still open")
        self.assertFalse(self.host._busy())

    def test_close_reports_the_worst_chat_and_withdraws_the_note_once(self):
        second = self.second_chat()
        withdrawn = []
        with patch.object(headless.Backend, "_busy", lambda backend: backend is second), \
                patch("dgc.peers.withdraw", lambda: withdrawn.append(1)):
            outcome = self.host.close(grace_s=0)
        self.assertEqual(outcome, "cancelled", "one chat's cancelled turn is the process's outcome")
        self.assertEqual(withdrawn, [1], "the process note is withdrawn once, by the process")

    def test_stopping_reaches_every_chat(self):
        second = self.second_chat()
        self.host.stopping()
        self.assertTrue(self.host.default.agent.stopping and second.agent.stopping)


if __name__ == "__main__":
    unittest.main()
