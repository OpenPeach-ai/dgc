"""Installing a plugin while a turn runs.

Clicking Connect mid-turn answered "A turn or plugin install is already running; cancel or wait".
Codex draws the line this follows: it refuses a change to what a running turn is ALLOWED to do, and
permits a change to what it CAN do. A plugin adds tools and skills; the turn's next model request
sees them. Two things made that unsafe here, and both are pinned below: reloading skills emptied the
dict a turn iterates, and the install connected with the turn's own cancel flag.
"""
import sys
import threading
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import headless  # noqa: E402
from dgc.agent import Agent  # noqa: E402


class ReloadSkillsTest(unittest.TestCase):
    def test_a_reload_never_empties_the_catalog_a_turn_is_reading(self):
        agent = object.__new__(Agent)
        agent.config = SimpleNamespace(project_root=Path("/nonexistent-dgc-root"), get=lambda k, d=None: d)
        agent.skills = {"alpha": object(), "beta": object()}
        agent.ctx = SimpleNamespace(skills=agent.skills)
        reading = iter(agent.skills)
        next(reading)                                    # a turn is mid-way through the catalog
        fresh = {"gamma": object()}
        with unittest.mock.patch("dgc.agent.discover_skills", lambda *a, **k: dict(fresh)):
            agent.reload_skills()
        next(reading)                                    # RuntimeError: changed size during iteration
        self.assertEqual(set(agent.skills), {"gamma"})
        self.assertIs(agent.ctx.skills, agent.skills, "the skill tool reads the same catalog")


class PluginOperationsBesideATurnTest(unittest.TestCase):
    def backend(self):
        backend = object.__new__(headless.Backend)
        self.events = []
        backend.em = SimpleNamespace(emit=lambda kind, **fields: self.events.append({"type": kind, **fields}))
        backend.config = SimpleNamespace(project_root=Path("/tmp"), get=lambda k, d=None: d)
        busy = threading.Thread(target=lambda: None)
        backend._worker = busy                           # a turn is running
        backend._foreground_worker = None
        backend._package_reader = None
        backend._turn_lock = threading.RLock()
        backend.agent = SimpleNamespace(cancelled=threading.Event())
        return backend

    def run_and_wait(self, backend, cmd):
        backend._dispatch(cmd)
        worker = backend._package_reader
        if worker is not None:
            worker.join(5)

    def test_install_runs_while_a_turn_is_running(self):
        backend = self.backend()
        backend._install_plugin = lambda cmd: (lambda: self.events.append({"type": "installed"}))
        self.run_and_wait(backend, {"type": "install_plugin", "name": "demo", "request_id": "i1"})
        self.assertFalse([e for e in self.events if e["type"] == "command_rejected"], self.events)
        self.assertIn({"type": "installed"}, self.events)

    def test_uninstall_and_marketplace_changes_run_while_a_turn_is_running(self):
        for command in ({"type": "uninstall_plugin", "name": "demo", "request_id": "u1"},
                        {"type": "refresh_plugin_marketplace", "name": "m", "request_id": "r1"}):
            backend = self.backend()
            backend._plugin_operation = lambda cmd: (lambda: self.events.append({"type": "done", "cmd": cmd["type"]}))
            self.run_and_wait(backend, command)
            self.assertFalse([e for e in self.events if e["type"] == "command_rejected"],
                             (command["type"], self.events))
            self.assertIn({"type": "done", "cmd": command["type"]}, self.events)

    def test_two_package_operations_still_take_turns(self):
        backend = self.backend()
        gate = threading.Event()
        backend._plugin_operation = lambda cmd: gate.wait(5) and None
        backend._dispatch({"type": "uninstall_plugin", "name": "a", "request_id": "u1"})
        backend._install_plugin = lambda cmd: None
        backend._dispatch({"type": "install_plugin", "name": "b", "request_id": "i2"})
        gate.set()
        rejected = [e for e in self.events if e["type"] == "command_rejected"]
        self.assertEqual([e["command"] for e in rejected], ["install_plugin"])
        backend._package_reader.join(5)

    def test_an_install_is_not_cancelled_by_the_turns_stop(self):
        from dgc import plugins
        backend = self.backend()
        backend.agent.cancelled.set()                    # the user stopped the turn
        backend.agent.reload_skills = lambda: None
        backend.agent.mcp = SimpleNamespace(failures={}, servers={})
        backend.agent._handle_mcp_input = lambda *a, **k: None
        backend._editor_plugins = lambda **k: []
        backend._prepared_plugins = {"demo": {"name": "demo"}}
        seen = {}
        with unittest.mock.patch.object(plugins, "install", lambda item, **k: {"name": "demo", "servers": ["s"]}), \
                unittest.mock.patch.object(plugins, "_installed", lambda: []), \
                unittest.mock.patch.object(plugins, "record_servers", lambda record: ["s"]), \
                unittest.mock.patch.object(plugins, "connect",
                                           lambda config, manager, record, **k: seen.update(cancel=k.get("cancel"))):
            backend._install_plugin({"name": "demo", "request_id": "i1"})
        self.assertIsNot(seen["cancel"], backend.agent.cancelled)
        self.assertFalse(seen["cancel"].is_set(), "a Stop pressed for the turn aborted the install")


class CancelOnAnOpenedSignInTest(unittest.TestCase):
    """Cancel on a plugin sign-in the browser already opened.

    The editor's Cancel sent the turn's Stop. With installs running beside a turn, that Stop no
    longer reached the install -- the plugin went on connecting when sign-in finished -- and it
    ended the turn on screen instead: queued messages handed back, approval cards expired. Cancel
    now names the sign-in, and the chat stops what waits on it."""

    def backend(self, *, servers=("s",)):
        backend = PluginOperationsBesideATurnTest.backend(self)
        backend.ui = SimpleNamespace(mcp_input_servers={})
        backend._queue = []
        backend.pending = SimpleNamespace(resolve=lambda rid, value: False,   # already answered
                                          cancel_all=lambda value: [])
        backend._install_cancel = threading.Event()
        backend._installing_servers = set(servers)
        return backend

    def test_it_cancels_the_install_and_leaves_the_turn_alone(self):
        backend = self.backend()
        backend.ui.mcp_input_servers["r7"] = "s"
        backend._dispatch({"type": "mcp_input_response", "id": "r7", "action": "cancel"})
        self.assertTrue(backend._install_cancel.is_set(), "the install went on connecting")
        self.assertFalse(backend.agent.cancelled.is_set(), "Cancel on a sign-in stopped the running turn")

    def test_a_sign_in_for_another_connection_still_stops_the_turn(self):
        backend = self.backend()
        backend.ui.mcp_input_servers["r8"] = "other"
        backend._dispatch({"type": "mcp_input_response", "id": "r8", "action": "cancel"})
        self.assertTrue(backend.agent.cancelled.is_set(), "what Cancel did before, outside an install")
        self.assertFalse(backend._install_cancel.is_set())

    def test_a_request_this_chat_never_made_changes_nothing(self):
        backend = self.backend()
        backend._dispatch({"type": "mcp_input_response", "id": "r404", "action": "cancel"})
        backend._dispatch({"type": "mcp_input_response", "id": "r404", "action": "accept"})
        self.assertFalse(backend._install_cancel.is_set())
        self.assertFalse(backend.agent.cancelled.is_set())

    def test_the_install_connect_sees_the_cancel_and_ends(self):
        import time
        from dgc import plugins
        backend = PluginOperationsBesideATurnTest.backend(self)
        backend.ui = SimpleNamespace(mcp_input_servers={})
        backend._queue = []
        backend.pending = SimpleNamespace(resolve=lambda rid, value: False, cancel_all=lambda value: [])
        backend.agent.reload_skills = lambda: None
        backend.agent.mcp = SimpleNamespace(failures={}, servers={})
        backend.agent._handle_mcp_input = lambda *a, **k: None
        backend._editor_plugins = lambda **k: []
        backend._prepared_plugins = {"demo": {"name": "demo"}}
        asked, outcome = threading.Event(), {}

        def connect(config, manager, record, *, input_handler, cancel):
            backend.ui.mcp_input_servers["r9"] = "s"     # its sign-in, as HeadlessUI.mcp_input records it
            asked.set()
            deadline = time.monotonic() + 5
            while not cancel.is_set() and time.monotonic() < deadline:
                time.sleep(0.01)
            outcome["cancelled"] = cancel.is_set()

        with unittest.mock.patch.object(plugins, "install", lambda item, **k: {"name": "demo", "servers": ["s"]}), \
                unittest.mock.patch.object(plugins, "_installed", lambda: []), \
                unittest.mock.patch.object(plugins, "record_servers", lambda record: ["s"]), \
                unittest.mock.patch.object(plugins, "connect", connect):
            worker = threading.Thread(target=backend._install_plugin, args=({"name": "demo", "request_id": "i1"},))
            worker.start()
            self.assertTrue(asked.wait(5))
            backend._dispatch({"type": "mcp_input_response", "id": "r9", "action": "cancel"})
            worker.join(5)
        self.assertTrue(outcome.get("cancelled"), "the install's connect never saw the Cancel")
        self.assertFalse(backend.agent.cancelled.is_set())
        self.assertIsNone(backend._install_cancel, "the next install would start already cancelled")

    def test_the_ui_remembers_which_server_each_request_was_for(self):
        from dgc.protocol import PendingRequests
        emitted = []
        pending = PendingRequests()
        ui = headless.HeadlessUI(SimpleNamespace(emit=lambda event, /, **f: emitted.append({"type": event, **f})),
                                 pending, approval_timeout_s=5)
        answer = {}
        asking = threading.Thread(target=lambda: answer.update(ui.mcp_input("make", "elicitation", {"mode": "url"})))
        asking.start()
        for _ in range(500):
            if emitted:
                break
            threading.Event().wait(0.01)
        rid = emitted[0]["id"]
        self.assertTrue(pending.resolve(rid, {"action": "accept"}))
        asking.join(5)
        self.assertEqual(ui.mcp_input_servers.get(rid), "make")


if __name__ == "__main__":
    unittest.main()
