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


if __name__ == "__main__":
    unittest.main()
