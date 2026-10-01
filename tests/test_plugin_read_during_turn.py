"""Reading a package is not changing one, so it does not wait for the model.

Reported live: mid-turn, clicking "Connect Composio" in the settings panel answered

    Wait for the current turn or plugin operation before changing packages.

The button sends `inspectPlugin` (editors/vscode/src/settingsClient.js:253) — it opens the review
dialog that shows what the package contains, BEFORE anything is installed. Nothing had been changed
and nothing had been asked to change.

`inspect_plugin` shared a branch with uninstall, the three marketplace commands and create, all of
which go through `_start_foreground_worker` — which refuses while a chat turn holds `_worker`. It is
also the one command in that branch its author never added to `_BUSY_MUTATIONS`, so the refusal came
from the worker gate alone.

Codex draws the same line: its analog of this command is its least-serialized RPC, and the only
thing it refuses during a turn is a change to what that turn is ALLOWED to do
(`codex-rs/.../config_persistence.rs`: "Wait for the current turn to finish before changing
permissions."). Reading a package changes neither.
"""
import copy
import threading
import types
import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.editor_protocol import event_error
from dgc.headless import Backend, HeadlessUI
from dgc.llm import ChatResult
from dgc.protocol import PendingRequests


class PluginReadDuringTurnTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-plugin-read-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.events, self.condition = [], threading.Condition()

        def emit(_event_type, /, **fields):
            event = {"type": _event_type, **fields}
            self.assertIsNone(event_error({"seq": 1, **event}), event)
            with self.condition:
                self.events.append(event)
                self.condition.notify_all()

        emitter = types.SimpleNamespace(emit=emit)
        backend = object.__new__(Backend)
        backend.config, backend.em, backend.pending = config, emitter, PendingRequests()
        backend.ui = HeadlessUI(emitter, backend.pending, approval_timeout_s=3)
        backend.agent = Agent(config, backend.ui)
        backend.ui._steering_hook = backend._steering_applied
        backend._queue, backend._steer_payloads = [], {}
        backend._worker, backend._foreground_worker, backend._turn_n = None, None, 0
        backend._package_reader = None
        backend._turn_lock, backend.workspace_trusted = threading.RLock(), True
        backend._emit_context = lambda: None
        self.backend, self.agent = backend, backend.agent
        self.addCleanup(self.agent.mcp.stop_all)
        self.release = threading.Event()

        def stop():
            backend.dispatch({"type": "cancel"})
            self.release.set()
            worker = backend._worker
            if worker and worker is not threading.current_thread():
                worker.join(5)
        self.addCleanup(stop)

    def wait(self, kind, **fields):
        with self.condition:
            self.assertTrue(self.condition.wait_for(lambda: any(
                event["type"] == kind and all(event.get(k) == v for k, v in fields.items())
                for event in self.events), timeout=5), (kind, fields, self.events))
            return next(event for event in self.events if event["type"] == kind
                        and all(event.get(k) == v for k, v in fields.items()))

    def rejected(self, **fields):
        with self.condition:
            return [e for e in self.events if e["type"] == "command_rejected"
                    and all(e.get(k) == v for k, v in fields.items())]

    def in_a_turn(self, body):
        """Run `body()` while a real turn is parked inside its first model request."""
        entered = threading.Event()

        def chat(_messages, **_kwargs):
            entered.set()
            self.release.wait(30)          # held open for the whole test, not asserted on
            return ChatResult(content="Completed")

        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.backend.dispatch({"type": "prompt", "text": "work", "request_id": "turn"})
            self.assertTrue(entered.wait(5), "the turn never reached the model")
            self.assertIsNotNone(self.backend._worker, "a turn must really be running")
            body()

    # ------------------------------------------------------------------ the report ---

    def test_a_package_can_be_read_while_the_model_is_working(self):
        started = threading.Event()
        with patch.object(self.backend, "_plugin_operation",
                          side_effect=lambda cmd: started.set()):
            self.in_a_turn(lambda: None)
            self.backend.dispatch({"type": "inspect_plugin", "name": "composio", "request_id": "r"})
            self.assertTrue(started.wait(5), "the read never ran")
        self.assertEqual(self.rejected(request_id="r"), [],
                         "this is the refusal the user hit")

    def test_reading_does_not_swallow_a_stop_the_user_just_pressed(self):
        """`_start_foreground_worker` clears `agent.cancelled` before it starts. On this path that
        would discard a cancel the user pressed a moment earlier."""
        gate = threading.Event()
        with patch.object(self.backend, "_plugin_operation", side_effect=lambda cmd: gate.wait(5)):
            self.in_a_turn(lambda: None)
            self.agent.cancelled.set()
            self.backend.dispatch({"type": "inspect_plugin", "name": "composio", "request_id": "r"})
            self.assertTrue(self.agent.cancelled.is_set(),
                            "reading a package cleared the turn's cancel flag")
            gate.set()

    def test_reading_does_not_occupy_the_slot_prompts_are_refused_against(self):
        """A package read can take two 25-second downloads. Holding `_foreground_worker` for that
        long would make the composer reject what the user typed (headless.py:3750)."""
        gate = threading.Event()
        with patch.object(self.backend, "_plugin_operation", side_effect=lambda cmd: gate.wait(5)):
            self.backend.dispatch({"type": "inspect_plugin", "name": "composio", "request_id": "r"})
            self.assertIsNone(self.backend._foreground_worker,
                              "a read must not take the foreground slot")
            self.assertIsNotNone(self.backend._package_reader, "but it does take its own")
            gate.set()

    def test_two_reads_at_once_are_still_refused(self):
        """Mutual exclusion is kept — against another READ, which is what could race the same
        `_prepared_plugins` entry. It is no longer borrowed from the chat turn."""
        gate = threading.Event()
        with patch.object(self.backend, "_plugin_operation", side_effect=lambda cmd: gate.wait(5)):
            self.backend.dispatch({"type": "inspect_plugin", "name": "composio", "request_id": "a"})
            self.backend.dispatch({"type": "inspect_plugin", "name": "composio", "request_id": "b"})
            second = self.wait("command_rejected", request_id="b")
            self.assertEqual(second["reason"], "busy")
            self.assertIn("read", second["message"])
            self.assertNotIn("changing packages", second["message"],
                             "the user is reading one, not changing one")
            gate.set()

    def test_the_slot_is_released_even_when_the_read_fails(self):
        def boom(_cmd):
            raise RuntimeError("the marketplace was unreachable")
        with patch.object(self.backend, "_plugin_operation", side_effect=boom):
            self.backend.dispatch({"type": "inspect_plugin", "name": "composio", "request_id": "a"})
            for _ in range(200):
                if self.backend._package_reader is None:
                    break
                threading.Event().wait(0.02)
        self.assertIsNone(self.backend._package_reader,
                          "a failed read must not wedge every later review")

    # ------------------------------------------------- changing packages, beside the turn ---

    def test_package_changes_run_beside_the_turn(self):
        """These change what the model CAN run, not what it is ALLOWED to do -- Codex's line. They
        used to wait because `reload_skills()` emptied the dict the turn iterates; it swaps it now,
        so they run on the package slot while the turn carries on."""
        self.in_a_turn(lambda: None)
        ran = []
        # Each command's own declared fields: the schema refuses an undeclared one before any gate.
        for command, fields in (("uninstall_plugin", {"name": "fixture"}),
                                ("add_plugin_marketplace", {"source": "https://example.invalid/m"}),
                                ("remove_plugin_marketplace", {"name": "fixture"}),
                                ("refresh_plugin_marketplace", {"name": "fixture"}),
                                ("create_plugin", {"name": "fixture", "display_name": "Fixture",
                                                   "description": "a fixture"})):
            with self.subTest(command=command), \
                    patch.object(self.backend, "_plugin_operation",
                                 side_effect=lambda cmd: ran.append(cmd["type"])):
                self.backend.dispatch({"type": command, **fields, "request_id": command})
                for _ in range(200):
                    if self.backend._package_reader is None:
                        break
                    threading.Event().wait(0.02)
                refused = [e for e in self.events if e.get("type") == "command_rejected"
                           and e.get("request_id") == command]
                self.assertEqual(refused, [], f"{command} still waited for the turn")
                self.assertIn(command, ran)

    def test_nothing_still_tells_anyone_they_are_changing_packages(self):
        """The sentence the user was shown named an action they had not taken. It is gone, and so
        is the refusal behind it: a package change during a turn simply runs."""
        self.in_a_turn(lambda: None)
        with patch.object(self.backend, "_plugin_operation", side_effect=lambda cmd: None):
            self.backend.dispatch({"type": "uninstall_plugin", "name": "fixture", "request_id": "u"})
            for _ in range(200):
                if self.backend._package_reader is None:
                    break
                threading.Event().wait(0.02)
        for event in self.events:
            self.assertNotIn("before changing packages", str(event.get("message", "")),
                             f"the reported wording is still reachable: {event}")
            self.assertNotEqual(event.get("reason"), "turn_in_progress", event)


if __name__ == "__main__":
    unittest.main()
