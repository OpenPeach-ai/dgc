"""Monitors that come back when their chat is opened again (dgc/monitor_restart.py).

Hub tests drive real processes and read the journal; agent tests reopen a saved session in a second
Agent; serve tests run two real `dgc serve` processes over stdio against a local mock model, the
first ended by end of input exactly as a window reload ends it.
"""
from __future__ import annotations

import contextlib
import json
import os
import pwd
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_monitor_restart.py needs HOME redirected before dgc is imported")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-monitor-restart-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc import monitor_restart, monitors as monitors_mod, sessions  # noqa: E402
from dgc.agent import Agent                                        # noqa: E402
from dgc.config import Config                                      # noqa: E402
from dgc.editor_protocol import event_error                        # noqa: E402
from dgc.monitors import MonitorHub                                # noqa: E402
from dgc.workflows import notice_kind                              # noqa: E402

PROJECT = Path(__file__).resolve().parents[1]


def wait_for(predicate, timeout: float = 10.0, interval: float = 0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return predicate()


def gone_owner() -> dict:
    """An owner process that has ended: what a reopen after a reload or a restart finds."""
    proc = subprocess.Popen(["true"])
    proc.wait()
    return {"pid": proc.pid, "stamp": "ended"}


def make_config(root: Path, **settings) -> Config:
    cfg = Config()
    cfg.project_root = root
    cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default",
                     "notes": False, "suggest": False})
    cfg.data.update(settings)
    return cfg


class Ctx:
    def __init__(self, root: Path, config: Config, hub=None):
        self.project_root = root
        self.config = config
        self.cancelled = None
        self.tool_owner = f"owner-{id(self)}"
        self.monitors = hub


class FrontendUI:
    """A UI that delivers monitor events, like the TUI and the editor backend."""

    def __init__(self):
        self.monitor_wake_enabled = True
        self.infos, self.errors = [], []

    def info(self, message):
        self.infos.append(message)

    def error(self, message):
        self.errors.append(message)

    def __getattr__(self, name):
        return lambda *a, **k: None


# ------------------------------------------------------------------------------------- journal ---
class JournalTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-monitor-journal-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.config = make_config(self.root, api_key="sk-fixture-0123456789abcdefSECRET")
        self.session = sessions.new_path(self.root)
        self.target = (self.session, self.root)
        self.hub = MonitorHub("owner", self.config, self.root)
        self.hub.journal = lambda: self.target
        self.addCleanup(lambda: self.hub.shutdown(wait=3.0))
        self.ctx = Ctx(self.root, self.config, self.hub)

    def start(self, command: str, **args) -> str:
        out = self.hub.start({"command": command, "description": args.pop("description", "fixture"),
                              **args}, self.ctx)
        self.assertTrue(out.startswith("started monitor"), out)
        return out.split()[2]

    def record(self, mid: str) -> dict:
        return next(r for r in monitor_restart.read(*self.target) if r["id"] == mid)

    def ended(self, mid: str, end: str) -> dict:
        found = wait_for(lambda: (self.record(mid).get("end") == end and self.record(mid)), 15)
        self.assertTrue(found, self.record(mid))
        return found

    def test_the_record_says_how_the_monitor_was_started(self):
        mid = self.start("sleep 30", description="  erp   sync ", timeout_ms=90_000,
                         _dgc_permission={"mode": "auto", "allowed_by": "policy"})
        record = self.record(mid)
        self.assertEqual(record["state"], "running")
        self.assertEqual(record["command"], "sleep 30")
        self.assertEqual(record["description"], "erp sync")
        self.assertEqual(record["cwd"], str(self.root))
        self.assertEqual((record["persistent"], record["timeout_ms"]), (False, 90_000))
        self.assertAlmostEqual(record["deadline"] - record["started_at"], 90.0, places=3)
        self.assertEqual(record["permission"], {"mode": "auto", "allowed_by": "policy"})
        self.assertEqual(record["owner"]["pid"], os.getpid())
        self.assertFalse(record["sandboxed"])
        path = monitor_restart.journal_path(*self.target)
        self.assertEqual(path.suffix, ".monitors")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertTrue(monitor_restart.due({**record, "owner": {"pid": 0}}))

    def test_each_way_a_monitor_ends_is_written_down(self):
        stopped = self.start("sleep 30", description="stopped")
        exited = self.start("true", description="exited")
        timed = self.start("sleep 30", description="timed", timeout_ms=1000)
        self.assertTrue(self.hub.stop(stopped, "stopped"))
        self.ended(stopped, "stopped")
        self.ended(exited, "exited")
        self.ended(timed, "timeout")
        dgc_stopped = self.start("sleep 30", description="dgc")
        self.hub.shutdown(wait=3.0)
        self.assertEqual(self.record(dgc_stopped)["end"], "dgc_stopped", "written before the process is gone")
        rewound = self.start("sleep 30", description="rewound")
        self.hub.new_epoch("shutdown", journal_end="rewound")
        self.assertEqual(self.record(rewound)["end"], "rewound")
        self.assertEqual([r["id"] for r in monitor_restart.read(*self.target) if monitor_restart._stopped_by_dgc(r)],
                         [dgc_stopped], "only DGC's stopping brings a monitor back")
        me = monitor_restart.owner()
        self.assertFalse(any(monitor_restart.due(r, me) for r in monitor_restart.read(*self.target)),
                         "and only once the process that ran it has ended: this one still runs")

    def test_a_stop_right_before_dgc_stops_is_still_a_stop(self):
        mid = self.start("trap '' TERM; sleep 30", description="slow to die")
        self.hub.stop(mid, "stopped")
        self.hub.shutdown(wait=0.0)                 # the window reloads a moment after Stop
        self.assertEqual(self.record(mid)["end"], "stopped")
        self.ended(mid, "stopped")

    def test_a_command_carrying_a_credential_is_not_written_down(self):
        mid = self.start("curl -H 'Authorization: Bearer sk-fixture-0123456789abcdefSECRET' http://x; sleep 30")
        record = self.record(mid)
        self.assertEqual(record["command"], "")
        self.assertTrue(record["secret"])
        self.assertNotIn("SECRET", monitor_restart.journal_path(*self.target).read_text())

    def test_another_live_dgc_keeps_its_monitor_and_a_dead_one_gives_it_back(self):
        mid = self.start("sleep 30")
        record = self.record(mid)
        self.assertFalse(monitor_restart.due(record), "running here")
        other = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (other.kill(), other.wait()))
        alive = {**record, "owner": {"pid": other.pid, "stamp": monitors_mod._probes["starttime"](other.pid)}}
        self.assertFalse(monitor_restart.due(alive), "another DGC's monitor is left alone")
        self.assertTrue(monitor_restart.due({**alive, "owner": {"pid": other.pid, "stamp": "recycled"}}))
        self.assertTrue(monitor_restart.due({**record, "owner": {"pid": 2 ** 22 + 11, "stamp": "x"}}))

    def test_the_heartbeat_dates_a_dgc_that_died_without_its_cleanup(self):
        with mock.patch.object(monitor_restart, "HEARTBEAT_S", 0.2):
            mid = self.start("sleep 30")
            first = self.record(mid)["alive_at"]
            self.assertTrue(wait_for(lambda: self.record(mid)["alive_at"] > first + 0.3, 5))

    def test_the_journal_stays_small(self):
        for n in range(monitor_restart.MAX_RECORDS + 4):
            mid = self.start("true", description=f"quick {n}")
            self.ended(mid, "exited")
        self.assertLessEqual(len(monitor_restart.read(*self.target)), monitor_restart.MAX_RECORDS)

    def test_a_restarted_monitor_keeps_its_id_when_it_is_free(self):
        self.assertEqual(monitors_mod._take_id("mon777"), "mon777")
        self.assertGreater(int(monitors_mod._take_id()[3:]), 777)
        mid = self.start("sleep 30")
        self.assertNotEqual(monitors_mod._take_id(mid), mid, "an id in use is never handed out twice")


# --------------------------------------------------------------------------------- reopen (agent) ---
class ReopenTests(unittest.TestCase):
    """A second Agent opening the saved session is what a new `dgc serve` (or `dgc --resume`) does."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-monitor-reopen-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.log = self.root / "erp.log"
        self.log.write_text("")

    def agent(self, mode="default") -> Agent:
        agent = Agent(make_config(self.root, mode=mode), FrontendUI())
        agent.config.data["mode"] = mode
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        return agent

    def first_run(self, *, mode="auto", allowed_by="policy", **args) -> tuple[Path, str]:
        agent = self.agent(mode)
        agent.session_file = sessions.new_path(self.root)
        agent.messages.append({"role": "user", "content": "watch the ERP log"})
        agent.messages.append({"role": "assistant", "content": "Watching it."})
        spec = {"command": f"tail -n0 -F {self.log}", "description": "ERP sync", "timeout_ms": 600_000,
                **args, "_dgc_permission": {"mode": mode, "allowed_by": allowed_by}}
        with mock.patch.object(monitor_restart, "owner", return_value=gone_owner()):   # that DGC has ended
            out = agent.monitors.start(spec, agent.ctx)
        self.assertTrue(out.startswith("started monitor"), out)
        self.assertTrue(agent._persist(), agent._last_persist_error)
        agent.monitors.new_epoch("shutdown")     # DGC stops: the editor went away
        return agent.session_file, out.split()[2]

    def reopen(self, path: Path, *, mode="default") -> tuple[Agent, list]:
        agent = self.agent(mode)
        agent.load_session(path)
        agent.config.data["mode"] = mode            # the mode in force now
        return agent, agent.restart_monitors()

    def test_a_monitor_dgc_stopped_comes_back_once_with_the_time_it_has_left(self):
        path, mid = self.first_run()
        record = monitor_restart.read(path, self.root)[0]
        agent, outcomes = self.reopen(path, mode="auto")
        self.assertEqual([o.state for o in outcomes], ["restarted"])
        outcome = outcomes[0]
        self.assertEqual(outcome.key, record["key"])
        running = agent.monitors.running()
        self.assertEqual(len(running), 1)
        monitor = running[0]
        self.assertEqual(monitor.id, outcome.id)
        self.assertEqual(monitor.command_label, f"tail -n0 -F {self.log}")
        self.assertEqual(monitor.description, "ERP sync")
        self.assertFalse(monitor.persistent)
        left = record["deadline"] - time.time()
        self.assertLessEqual(monitor.timeout_ms, 600_000)
        self.assertAlmostEqual(monitor.timeout_ms / 1000, left, delta=5)
        self.assertRegex(outcome.message, r'^Monitor "ERP sync" restarted after DGC reopened this chat; '
                                          r"nothing was watched between \d\d:\d\d(:\d\d)? and \d\d:\d\d(:\d\d)?\.$")
        # The model reads the same fact at its next turn.
        note = agent.messages[-1]
        self.assertEqual(notice_kind(note), "monitor_restart")
        self.assertIn("Nothing was watched between", note["content"])
        self.assertIn('"ERP sync" was restarted at', note["content"])
        # Saved with the chat, so a replay shows it too.
        saved = sessions.load_record(path, self.root)["messages"]
        self.assertEqual(saved[-1]["_dgc_notice"]["kind"], "monitor_restart")
        self.assertEqual(agent.restart_monitors(), [], "once per reopen")
        self.assertEqual(monitor_restart.read(path, self.root)[0]["restarts"], 1)
        # It watches again.
        with self.log.open("a") as handle:
            handle.write("order 42 synced\n")
        self.assertTrue(wait_for(lambda: agent.monitors.pending_count(), 10))
        self.assertIn("order 42 synced", agent.monitors.take_pending().text)

    def test_persistent_has_no_limit(self):
        path, _ = self.first_run(persistent=True)
        agent, outcomes = self.reopen(path, mode="auto")
        self.assertEqual([o.state for o in outcomes], ["restarted"])
        self.assertTrue(agent.monitors.running()[0].persistent)
        self.assertIn("runs until monitor_stop", agent.messages[-1]["content"])

    def test_one_the_user_approved_stays_approved(self):
        path, _ = self.first_run(mode="default", allowed_by="approval")
        _, outcomes = self.reopen(path, mode="default")
        self.assertEqual([o.state for o in outcomes], ["restarted"])

    def test_stricter_permissions_now_mean_a_restart_the_user_presses(self):
        path, _ = self.first_run(mode="auto", allowed_by="policy")
        agent, outcomes = self.reopen(path, mode="default")
        self.assertEqual([(o.state, o.restart) for o in outcomes], [("stopped", True)])
        self.assertIn("stopped when DGC restarted: it would need your approval now", outcomes[0].message)
        self.assertEqual(agent.monitors.running(), [])
        self.assertIn("was NOT restarted", agent.messages[-1]["content"])
        # Their press is the approval.
        pressed = agent.restart_monitor(outcomes[0].key)
        self.assertEqual((pressed.state, pressed.by_user), ("restarted", True))
        self.assertEqual(len(agent.monitors.running()), 1)
        self.assertIn("the user restarted it", agent.messages[-1]["content"])
        self.assertIsNone(agent.restart_monitor(outcomes[0].key), "a running one has nothing to restart")

    def test_plan_mode_is_a_deny_even_for_the_users_press(self):
        path, _ = self.first_run(mode="auto")
        agent, outcomes = self.reopen(path, mode="plan")
        self.assertEqual([o.state for o in outcomes], ["stopped"])
        self.assertIn("plan mode is on", outcomes[0].message)
        pressed = agent.restart_monitor(outcomes[0].key)
        self.assertEqual((pressed.state, pressed.restart), ("stopped", True))
        self.assertEqual(agent.monitors.running(), [])

    def test_a_deny_rule_or_a_hook_blocks_it(self):
        path, _ = self.first_run(mode="auto")
        agent = self.agent("auto")
        agent.config.permissions = {"allow": [], "ask": [], "deny": ["Bash(tail *)"]}
        agent.load_session(path)
        agent.config.data["mode"] = "auto"
        outcomes = agent.restart_monitors()
        self.assertEqual([o.state for o in outcomes], ["stopped"])
        self.assertIn("a deny rule blocks it", outcomes[0].message)
        hooked = self.agent("auto")
        hooked.load_session(path)
        hooked.config.data["mode"] = "auto"
        with mock.patch.object(hooked, "_run_lifecycle_hooks", return_value=(True, "no watchers on Fridays")):
            outcomes = hooked.restart_monitors()
        self.assertEqual([o.state for o in outcomes], ["stopped"])
        self.assertIn("a PreToolUse hook blocked it (no watchers on Fridays)", outcomes[0].message)

    def test_time_that_ran_out_while_dgc_was_closed_is_said_and_not_restarted(self):
        path, _ = self.first_run(timeout_ms=1500)
        time.sleep(1.6)
        agent, outcomes = self.reopen(path, mode="auto")
        self.assertEqual([o.state for o in outcomes], ["expired"])
        self.assertIn("its time limit ran out at", outcomes[0].message)
        self.assertEqual(agent.monitors.running(), [])
        _, again = self.reopen(path, mode="auto")
        self.assertEqual(again, [], "said once")

    def test_a_start_failure_is_reported_once(self):
        path, _ = self.first_run()

        def move(records):
            records[0]["cwd"] = str(self.root / "gone")
        monitor_restart.update(path, self.root, move)
        agent, outcomes = self.reopen(path, mode="auto")
        self.assertEqual([o.state for o in outcomes], ["failed"])
        self.assertIn("could not be restarted: its folder", outcomes[0].message)
        self.assertEqual(agent.monitors.running(), [])
        _, again = self.reopen(path, mode="auto")
        self.assertEqual(again, [], "no retry loop")

    def test_stopped_timed_out_or_exited_monitors_stay_ended(self):
        agent = self.agent("auto")
        agent.session_file = sessions.new_path(self.root)
        agent.messages.append({"role": "user", "content": "watch"})
        ids = []
        with mock.patch.object(monitor_restart, "owner", return_value=gone_owner()):
            for spec in ({"command": "sleep 30", "description": "stopped"},
                         {"command": "true", "description": "exited"},
                         {"command": "sleep 30", "description": "timed", "timeout_ms": 1000}):
                ids.append(agent.monitors.start(spec, agent.ctx).split()[2])
        agent.monitors.stop(ids[0], "stopped")
        self.assertTrue(wait_for(lambda: all(r.get("state") == "ended"
                                             for r in monitor_restart.read(agent.session_file, self.root)), 15))
        self.assertTrue(agent._persist())
        agent.monitors.new_epoch("shutdown")
        _, outcomes = self.reopen(agent.session_file, mode="auto")
        self.assertEqual(outcomes, [])

    def test_a_frontend_that_cannot_deliver_events_restarts_nothing(self):
        path, _ = self.first_run()
        agent = Agent(make_config(self.root, mode="auto"), mock.MagicMock(monitor_wake_enabled=False))
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        agent.load_session(path)
        self.assertEqual(agent.restart_monitors(), [])
        self.assertTrue(monitor_restart.has_due(path, self.root), "left for a frontend that can")

    def test_a_branch_takes_its_running_monitors_with_it(self):
        agent = self.agent("auto")
        agent.session_file = sessions.new_path(self.root)
        agent.messages.append({"role": "user", "content": "watch"})
        agent.monitors.start({"command": "sleep 30", "description": "branch me"}, agent.ctx)
        self.assertTrue(agent._persist())
        parent = agent.session_file
        self.assertTrue(agent.fork_session("b"))
        self.assertEqual(monitor_restart.read(parent, self.root), [])
        self.assertEqual([r["description"] for r in monitor_restart.read(agent.session_file, self.root)],
                         ["branch me"])

    def test_the_stale_line_gives_way_to_the_restart_note(self):
        path, _ = self.first_run()
        record = sessions.load_record(path, self.root)
        messages = record["messages"] + [{"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "monitor", "arguments": "{}"}}]}]
        sessions.save(path, [m for m in messages if m.get("role") != "system"], self.root)
        agent = self.agent("auto")
        agent.load_session(path)
        self.assertEqual(agent.take_stale_monitor_note(), "")

    def test_a_monitor_whose_process_still_runs_is_left_alone_then_brought_back_once_it_ends(self):
        owner = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (owner.kill(), owner.wait()))
        alive = {"pid": owner.pid, "stamp": monitors_mod._probes["starttime"](owner.pid)}
        agent = self.agent("auto")
        agent.session_file = sessions.new_path(self.root)
        agent.messages.append({"role": "user", "content": "watch"})
        with mock.patch.object(monitor_restart, "owner", return_value=alive):
            agent.monitors.start({"command": "sleep 60", "description": "ERP sync", "persistent": True,
                                  "_dgc_permission": {"mode": "auto", "allowed_by": "policy"}}, agent.ctx)
        self.assertTrue(agent._persist())
        agent.monitors.new_epoch("shutdown")
        reopened, outcomes = self.reopen(agent.session_file, mode="auto")
        self.assertEqual(outcomes, [], "its DGC still has the session (a window that kept it, or still exiting)")
        self.assertEqual(reopened.monitor_restart_awaiting(), "wait")
        owner.kill()
        owner.wait()
        self.assertEqual(reopened.monitor_restart_awaiting(), "ready")
        later = reopened.restart_awaited_monitors()
        self.assertEqual([o.state for o in later], ["restarted"])
        self.assertEqual(len(reopened.monitors.running()), 1)
        self.assertEqual(reopened.monitor_restart_awaiting(), "")
        self.assertEqual(reopened.restart_awaited_monitors(), [], "once")

    def test_one_that_keeps_running_is_given_up_on(self):
        owner = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (owner.kill(), owner.wait()))
        alive = {"pid": owner.pid, "stamp": monitors_mod._probes["starttime"](owner.pid)}
        agent = self.agent("auto")
        agent.session_file = sessions.new_path(self.root)
        agent.messages.append({"role": "user", "content": "watch"})
        with mock.patch.object(monitor_restart, "owner", return_value=alive):
            agent.monitors.start({"command": "sleep 60", "description": "kept", "persistent": True}, agent.ctx)
        self.assertTrue(agent._persist())
        agent.monitors.new_epoch("shutdown")
        with mock.patch.object(monitor_restart, "WAIT_FOR_OWNER_S", 0.0):
            reopened, outcomes = self.reopen(agent.session_file, mode="auto")
        self.assertEqual(outcomes, [])
        self.assertEqual(reopened.monitor_restart_awaiting(), "", "its DGC kept it: never restarted here")
        self.assertEqual(reopened.monitors.running(), [])

    def test_a_monitor_of_this_very_process_is_never_restarted_by_a_reopen_here(self):
        agent = self.agent("auto")
        agent.session_file = sessions.new_path(self.root)
        agent.messages.append({"role": "user", "content": "watch"})
        agent.monitors.start({"command": "sleep 60", "description": "here", "persistent": True}, agent.ctx)
        self.assertTrue(agent._persist())
        agent.monitors.new_epoch("shutdown")          # the chat was switched away in this same process
        reopened, outcomes = self.reopen(agent.session_file, mode="auto")
        self.assertEqual(outcomes, [])
        self.assertEqual(reopened.monitor_restart_awaiting(), "")

    def test_deleting_the_session_deletes_its_journal(self):
        path, _ = self.first_run()
        journal = monitor_restart.journal_path(path, self.root)
        self.assertTrue(journal.exists())
        self.assertTrue(sessions.delete(path, self.root))
        self.assertFalse(journal.exists())


# -------------------------------------------------------------------------------------------- TUI ---
def tui_config(root: Path, mode: str) -> Config:
    import copy
    from dgc.config import DEFAULTS
    cfg = object.__new__(Config)
    cfg.project_root, cfg.project_dir, cfg._persist = root, root / ".dgc", False
    cfg.data = copy.deepcopy(DEFAULTS)
    cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode=mode, hooks={},
                    mcp_servers={}, suggest=False, artifact_autostart=False, thinking="off", notes=False)
    cfg._stored_secrets, cfg._env_secret_keys, cfg._explicit_keys = {}, set(), set()
    cfg.permissions = {"allow": [], "ask": [], "deny": []}
    return cfg


class TuiReopenTests(unittest.TestCase):
    """`dgc --resume` loads the session, then the TUI shows it: the restart happens there, once."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-monitor-restart-tui-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def saved_session(self) -> Path:
        agent = Agent(tui_config(self.root, "auto"), FrontendUI())
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        agent.session_file = sessions.new_path(self.root)
        agent.messages += [{"role": "user", "content": "watch the ERP log"},
                           {"role": "assistant", "content": "Watching it."}]
        with mock.patch.object(monitor_restart, "owner", return_value=gone_owner()):
            out = agent.monitors.start({"command": "sleep 60", "description": "ERP sync", "timeout_ms": 600_000,
                                        "_dgc_permission": {"mode": "auto", "allowed_by": "policy"}}, agent.ctx)
        self.assertTrue(out.startswith("started monitor"), out)
        self.assertTrue(agent._persist())
        agent.monitors.new_epoch("shutdown")
        return agent.session_file

    def tui(self, path: Path, mode: str):
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=160)

        config = tui_config(self.root, mode)
        agent = Agent(config, mock.MagicMock())        # the CLI loads the session before the TUI exists
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        agent.load_session(path)
        config.data["mode"] = mode
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        return TUI(config, agent=agent), agent

    @staticmethod
    def lines(ui) -> list:
        from prompt_toolkit.formatted_text import fragment_list_to_text, to_formatted_text
        out = []
        for block in ui.blocks:
            if isinstance(block, dict):
                out.append(str(block.get("text", "")))
            else:
                try:
                    text = fragment_list_to_text(to_formatted_text(block))
                except Exception:
                    text = str(block)
                import re
                out.append(" ".join(re.sub(r"\x1b\[[0-9;]*m", "", text).split()))   # unwrapped, plain
        return out

    def test_resuming_in_the_terminal_restarts_it_with_one_line(self):
        ui, agent = self.tui(self.saved_session(), "auto")
        notes = [line for line in self.lines(ui) if "restarted after DGC reopened this chat" in line]
        self.assertEqual(len(notes), 1, self.lines(ui))
        self.assertTrue(notes[0].startswith('◉ Monitor "ERP sync" restarted'))
        self.assertEqual(len(agent.monitors.running()), 1)
        ui._service_monitors()
        self.assertFalse([line for line in self.lines(ui) if " started · ERP sync" in line],
                         "the restart line is its only line")
        self.assertEqual(agent.restart_monitors(), [])

    def test_a_stricter_mode_shows_the_way_to_restart_it(self):
        ui, agent = self.tui(self.saved_session(), "default")
        notes = [line for line in self.lines(ui) if "stopped when DGC restarted" in line]
        self.assertEqual(len(notes), 1, self.lines(ui))
        mid = agent.messages[-1]["_dgc_notice"]["items"][0]["id"]
        self.assertIn(f"/monitors restart {mid}", notes[0])
        self.assertEqual(agent.monitors.running(), [])
        ui._tui_monitors(f"restart {mid}")
        self.assertEqual(len(agent.monitors.running()), 1)
        self.assertTrue([line for line in self.lines(ui) if 'Monitor "ERP sync" restarted; nothing' in line])


# ------------------------------------------------------------------------------------------ serve ---
def sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "choices": [
        {"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


def sse_text(text):
    return sse({"content": text}) + sse({}, "stop") + "data: [DONE]\n\n"


def sse_call(name, arguments, call_id="c1"):
    return (sse({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                 "function": {"name": name, "arguments": json.dumps(arguments)}}]})
            + sse({}, "tool_calls") + "data: [DONE]\n\n")


class MockModel:
    def __init__(self, script):
        self.script = script
        self.requests: list = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, body, kind):
                data = body.encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", kind)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

            def do_GET(self):
                self._send(json.dumps({"data": [{"id": "mock-model"}]}), "application/json")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                owner.requests.append(body)
                self._send(owner.script(body), "text/event-stream")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


def tool_results(body) -> list:
    return [m for m in body.get("messages") or [] if m.get("role") == "tool"]


def last_user(body) -> str:
    users = [m for m in body.get("messages") or [] if m.get("role") == "user"]
    return str(users[-1].get("content", "")) if users else ""


class Serve:
    """One `dgc serve` over a HOME and a project folder that outlive it."""

    def __init__(self, test, model, home: Path, work: Path):
        env = dict(os.environ, HOME=str(home), PYTHONPATH=str(PROJECT), PYTHONDONTWRITEBYTECODE="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(home)
        self.proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(work), env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True)
        test.addCleanup(self.close)
        self.events: list = []
        self.arrived: queue.Queue = queue.Queue()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.wait(lambda e: e["type"] == "ready")

    def _read(self):
        for line in self.proc.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                event = {"type": "__invalid__", "line": line}
            self.events.append(event)
            self.arrived.put(event)

    def send(self, command):
        self.proc.stdin.write(json.dumps(command) + "\n")
        self.proc.stdin.flush()

    def wait(self, predicate, timeout=60.0):
        seen = 0
        deadline = time.monotonic() + timeout
        while True:
            for event in self.events[seen:]:
                if predicate(event):
                    return event
            seen = len(self.events)
            if time.monotonic() >= deadline:
                return None
            try:
                self.arrived.get(timeout=min(0.2, max(0.01, deadline - time.monotonic())))
            except queue.Empty:
                pass

    def mode(self, mode):
        self.send({"type": "set_mode", "mode": mode, "acknowledge_workspace_trust": True,
                   "request_id": f"mode-{mode}"})
        self.wait(lambda e: e["type"] == "mode_changed" and e.get("request_id") == f"mode-{mode}")

    def resume(self):
        self.send({"type": "resume_session", "latest": True, "request_id": "resume"})
        return self.wait(lambda e: e["type"] == "session" and e.get("kind") == "resumed")

    def close(self):
        """End of input: what a window reload or a lost connection does to the backend."""
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self.reader.join(timeout=10)

    def of(self, kind):
        return [e for e in self.events if e["type"] == kind]

    def assert_valid_stream(self, test):
        for event in self.events:
            test.assertIsNone(event_error(event), event)


class ServeReopenTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-monitor-restart-serve-home-"))
        self.work = Path(tempfile.mkdtemp(prefix="dgc-monitor-restart-serve-work-"))
        self.log = self.work / "erp.log"
        self.log.write_text("")
        (self.home / ".dgc").mkdir()

    def configure(self, model):
        (self.home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": model.url, "model": "mock-model", "api_mode": "chat_completions",
            "suggest": False, "notes": False, "monitor_wake_delay_s": 1, "monitor_wake_cooldown_s": 1}))

    def journal(self) -> list:
        """The serve's own journal, under ITS HOME (this process's sessions module has another)."""
        found = sorted((self.home / ".dgc").rglob("*.monitors"), key=lambda p: p.stat().st_mtime)
        if not found:
            return []
        return json.loads(found[-1].read_text())["records"]

    def first_run(self, model, calls: list, *, mode="auto"):
        """Ask for `calls` (monitor tool arguments, one per round), then end by end of input."""
        serve = Serve(self, model, self.home, self.work)
        serve.mode(mode)
        serve.send({"type": "prompt", "text": "set up the watchers", "request_id": "p1"})
        self.assertTrue(serve.wait(lambda e: e["type"] == "turn_end", 90), [e["type"] for e in serve.events])
        self.assertEqual(len(serve.of("monitor_started")), len(calls))
        return serve

    @staticmethod
    def script_for(calls, reply="noted"):
        def script(body):
            done = len(tool_results(body))
            if done < len(calls):
                return sse_call(calls[done][0], calls[done][1], f"c{done + 1}")
            if "<monitor-events" in last_user(body) or "<dgc-note>" in last_user(body):
                return sse_text(reply)
            return sse_text("watching")
        return script

    def test_a_reload_brings_the_watcher_back_with_the_same_command_and_the_time_left(self):
        watch = {"command": f"tail -n0 -F {self.log}", "description": "ERP sync", "timeout_ms": 600_000}
        with MockModel(self.script_for([("monitor", watch)])) as model:
            self.configure(model)
            first = self.first_run(model, [watch])
            started = first.of("monitor_started")[0]
            first.close()                                          # the window reloads
            self.assertEqual([(r["state"], r.get("end")) for r in self.journal()], [("ended", "dgc_stopped")])

            second = Serve(self, model, self.home, self.work)
            second.mode("auto")
            second.resume()
            note = second.wait(lambda e: e["type"] == "monitor_restart", 30)
            self.assertTrue(note, [e["type"] for e in second.events])
            self.assertEqual((note["state"], note["id"], note["restart"]), ("restarted", started["id"], False))
            self.assertRegex(note["message"], r'^Monitor "ERP sync" restarted after DGC reopened this chat; '
                                              r"nothing was watched between \S+ and \S+\.$")
            again = second.wait(lambda e: e["type"] == "monitor_started", 10)
            self.assertEqual((again["id"], again["command"], again["description"]),
                             (started["id"], started["command"], "ERP sync"))
            self.assertLess(again["timeout_ms"], 600_000)
            self.assertGreater(again["timeout_ms"], 540_000)
            order = [e["type"] for e in second.events]
            self.assertLess(order.index("history"), order.index("monitor_restart"))
            self.assertLess(order.index("monitor_restart"), order.index("monitor_started"))
            listed = second.wait(lambda e: e["type"] == "monitors" and any(
                i["id"] == started["id"] and i["state"] == "running" for i in e["items"]), 10)
            self.assertTrue(listed, "the monitors row (and the agent map) shows it with Stop")

            # A line appended to the log reaches the model, which has read the gap note first.
            with self.log.open("a") as handle:
                handle.write("order 42 synced\n")
            woke = second.wait(lambda e: e["type"] == "monitor_event" and "order 42 synced" in e["lines"], 30)
            self.assertTrue(woke, [e["type"] for e in second.events][-20:])
            self.assertTrue(second.wait(lambda e: e["type"] == "turn_end", 60))
            sent = model.requests[-1]["messages"]
            notes = [m for m in sent if m.get("role") == "user" and "<dgc-note>" in str(m.get("content"))]
            self.assertEqual(len(notes), 1)
            self.assertIn("Nothing was watched between", notes[0]["content"])
            self.assertFalse(any("_dgc_notice" in m for m in sent), "private keys never reach a provider")

            # Replayed from the saved chat, and only once for this opening.
            second.send({"type": "get_history", "request_id": "h2"})
            history = second.wait(lambda e: e["type"] == "history" and e.get("request_id") == "h2", 20)
            markers = [i for i in history["items"] if i.get("role") == "monitor_restart"]
            self.assertEqual([(m["state"], m["id"], m["message"], m["restart"]) for m in markers],
                             [("restarted", started["id"], note["message"], False)])
            self.assertEqual(len(second.of("monitor_restart")), 1, "exactly once per reopen")
            second.close()
            second.assert_valid_stream(self)
            first.assert_valid_stream(self)

    def test_only_watchers_dgc_stopped_come_back_and_persistent_has_no_limit(self):
        calls = [("monitor", {"command": "sleep 60", "description": "user stops this", "timeout_ms": 600_000}),
                 ("monitor", {"command": "echo once", "description": "exits"}),
                 ("monitor", {"command": "sleep 60", "description": "times out", "timeout_ms": 1000}),
                 ("monitor", {"command": "sleep 600", "description": "forever", "persistent": True})]
        with MockModel(self.script_for(calls)) as model:
            self.configure(model)
            first = self.first_run(model, calls)
            ids = {e["description"]: e["id"] for e in first.of("monitor_started")}
            first.send({"type": "stop_monitor", "id": ids["user stops this"], "request_id": "stop"})
            self.assertTrue(first.wait(lambda e: e["type"] == "monitor_ended" and e["reason"] == "timeout", 30))
            self.assertTrue(first.wait(lambda e: e["type"] == "monitor_ended" and e["reason"] == "stopped", 30))
            first.close()
            ends = {r["description"]: r.get("end") for r in self.journal()}
            self.assertEqual(ends, {"user stops this": "stopped", "exits": "exited", "times out": "timeout",
                                    "forever": "dgc_stopped"})

            second = Serve(self, model, self.home, self.work)
            second.mode("auto")
            second.resume()
            note = second.wait(lambda e: e["type"] == "monitor_restart", 30)
            self.assertEqual((note["description"], note["state"]), ("forever", "restarted"))
            back = second.wait(lambda e: e["type"] == "monitor_started", 10)
            self.assertTrue(back["persistent"])
            second.send({"type": "list_monitors", "request_id": "after"})
            self.assertTrue(second.wait(lambda e: e.get("request_id") == "after", 10))
            self.assertEqual(len(second.of("monitor_restart")), 1)
            second.close()
            second.assert_valid_stream(self)

    def test_a_stricter_mode_now_offers_restart_and_the_press_starts_it(self):
        watch = {"command": f"tail -n0 -F {self.log}", "description": "ERP sync", "timeout_ms": 600_000}
        with MockModel(self.script_for([("monitor", watch)])) as model:
            self.configure(model)
            first = self.first_run(model, [watch], mode="auto")
            first.close()
            second = Serve(self, model, self.home, self.work)
            second.mode("default")                                   # no auto any more
            second.resume()
            note = second.wait(lambda e: e["type"] == "monitor_restart", 30)
            self.assertEqual((note["state"], note["restart"]), ("stopped", True))
            self.assertIn("Stopped when DGC restarted".lower(), note["message"].lower())
            self.assertFalse(second.of("monitor_started"))
            second.send({"type": "restart_monitor", "key": note["key"], "request_id": "press"})
            pressed = second.wait(lambda e: e["type"] == "monitor_restart" and e.get("request_id") == "press", 30)
            self.assertEqual((pressed["state"], pressed["by_user"]), ("restarted", True))
            self.assertTrue(second.wait(lambda e: e["type"] == "monitor_started", 10))
            second.send({"type": "restart_monitor", "key": note["key"], "request_id": "twice"})
            refused = second.wait(lambda e: e["type"] == "command_rejected" and e.get("request_id") == "twice", 10)
            self.assertEqual(refused["reason"], "unknown_monitor")
            ready = second.of("ready")[0]
            self.assertIs(ready["capabilities"].get("monitor_restart"), True)
            second.close()
            second.assert_valid_stream(self)

    def test_a_killed_backend_gives_its_watcher_back_too(self):
        watch = {"command": f"tail -n0 -F {self.log}", "description": "ERP sync", "persistent": True}
        with MockModel(self.script_for([("monitor", watch)])) as model:
            self.configure(model)
            first = self.first_run(model, [watch])
            first.proc.kill()                                     # no cleanup at all
            first.proc.wait(timeout=10)
            self.assertEqual([r["state"] for r in self.journal()], ["running"])
            second = Serve(self, model, self.home, self.work)
            second.mode("auto")
            second.resume()
            note = second.wait(lambda e: e["type"] == "monitor_restart", 30)
            self.assertEqual(note["state"], "restarted")
            self.assertIn("between about", note["message"], "the heartbeat only dates it roughly")
            second.close()


if __name__ == "__main__":
    unittest.main()
