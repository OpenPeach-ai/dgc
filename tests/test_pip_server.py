"""Pips on a server (Pips for SDK apps, part 4, pip_server): `dgc pips health`, `dgc pips serve --server`, the guardrail
that refuses a personal Claude Code or Codex plan there, and one runner per DGC home.

Offline: no model, no network and no desktop. The desktop paths are patched to fail if anything calls them. One test
(RealRunnerTests) starts real `dgc pips serve --server` processes on a temporary home and stops them by their handles.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from dgc import pip_borrow, pip_chat, pip_cli, pip_daemon as daemon, pip_desktop, pip_server, pip_service, pips
from dgc.scheduler import named_process_lock
from dgc.workspace_registry import SCHEMA_VERSION, RegistryError, WorkspaceRegistry, state_directory
from tests import test_pip_cli as cli_tests, test_pip_service as service_tests
from tests.test_pip_daemon import ConfigFixture, ScriptedEvent

NOW = "2026-10-01T10:00:00.000Z"
ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


def run_cli(config, *argv):
    with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
        code = pip_cli.handle_command(config, list(argv))
    return code, out.getvalue(), err.getvalue()


class Home(unittest.TestCase):
    """A temporary DGC home whose registry is at the runner's own state directory."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-pip-server-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / "project"
        self.root.mkdir()
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home"), "HOME": str(self.base / "home")})
        env.start()
        self.addCleanup(env.stop)
        execute = patch.object(pips, "_execute_run", side_effect=AssertionError("No run starts in these tests"))
        execute.start()
        self.addCleanup(execute.stop)
        self.registry = WorkspaceRegistry(clock=lambda: NOW)
        self.addCleanup(self.registry.close)
        self.workspace = self.registry.resolve(self.root)
        self.config = ConfigFixture(self.root)
        clock = patch.object(pip_server, "utc_now", return_value=NOW)      # the CLI's "now"
        clock.start()
        self.addCleanup(clock.stop)

    def record(self, **changes):
        value = {"schema_version": 1, "instance_id": "instance", "pid": 999999, "status": "running",
                 "started_at": NOW, "heartbeat_at": NOW}
        value.update(changes)
        daemon._write(self.registry, daemon.SUPERVISOR_KEY, value)

    def hold(self):
        lease = named_process_lock("pips-supervisor", str(state_directory()))
        self.assertTrue(lease.acquire(blocking=False))
        self.addCleanup(lease.release)
        return lease

    def health(self):
        return pip_server.health(self.config, now=NOW)


class HealthTests(Home):
    def test_a_runner_online_running_and_holding_its_lease_is_healthy_exit_0(self):
        self.record(mode="server")
        self.hold()
        value = self.health()
        self.assertEqual((value["healthy"], value["state"], value["lease_held"]), (True, "running", True))
        self.assertTrue(value["server_mode"])
        self.assertEqual(value["heartbeat_age_seconds"], 0.0)
        self.assertEqual(value["counts"], {"queued": 0, "running": 0, "cancelling": 0})
        code, out, err = run_cli(self.config, "health")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, "dgc pips health: healthy: The Pips runner is running in server mode: heartbeat 0 s ago; "
                              "0 running, 0 queued.\n")
        code, out, _ = run_cli(self.config, "health", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), value)
        code, out, _ = run_cli(self.config, "--json", "health")
        self.assertEqual((code, json.loads(out)["state"]), (0, "running"))

    def test_each_unhealthy_state_exits_1_with_one_line_saying_why(self):
        lease = named_process_lock("pips-supervisor", str(state_directory()))
        failed = {"code": "runner_failed", "message": "The local Pips controller stopped."}
        cases = [
            ("off", "Pips are off in this DGC profile", lambda: self.config.data.update(pips_enabled=False), False),
            ("stopped", "the emergency stop is on", lambda: (self.record(), daemon.stop_all(self.config, "fixture")), True),
            ("heartbeat_stale", "last heartbeat was 60 s ago", lambda: self.record(heartbeat_at="2026-10-01T09:59:00.000Z"),
             True),
            ("no_runner", "No Pips runner has started with this DGC home", lambda: None, False),
            ("no_runner", "the last one stopped at 2026-10-01T10:00:00.000Z. It said: The local Pips controller stopped.",
             lambda: self.record(status="stopped", error=failed), False),
            ("no_runner", "No Pips runner holds the lease, though its heartbeat is recent", lambda: self.record(), False),
            ("state_unreadable", "saved state is damaged", lambda: self.registry.db.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)", (daemon.SUPERVISOR_KEY, "oops")), True),
        ]
        for state, words, arrange, held in cases:
            with self.subTest(state=state, words=words):
                self.registry.db.execute("DELETE FROM metadata WHERE key IN (?,?)",
                                         (daemon.SUPERVISOR_KEY, daemon.CONTROL_KEY))
                self.config.data["pips_enabled"] = True
                arrange()
                if held:
                    self.assertTrue(lease.acquire(blocking=False))
                try:
                    value = self.health()
                    self.assertEqual((value["healthy"], value["state"]), (False, state))
                    self.assertIn(words, value["message"])
                    code, out, err = run_cli(self.config, "health")
                    self.assertEqual((code, err), (1, ""))
                    self.assertEqual(out.count("\n"), 1, "one line")
                    self.assertEqual(out, "dgc pips health: unhealthy: " + value["message"] + "\n")
                    code, out, _ = run_cli(self.config, "health", "--json")
                    self.assertEqual((code, json.loads(out)), (1, value))
                finally:
                    if held:
                        lease.release()

    def test_a_home_with_no_runner_yet_is_no_runner_and_nothing_is_created(self):
        empty = self.base / "fresh"
        empty.mkdir()
        with patch.dict(os.environ, {"DGC_HOME": str(empty)}):
            value = self.health()
        self.assertEqual((value["healthy"], value["state"]), (False, "no_runner"))
        self.assertIn("No Pips runner has run with this DGC home yet", value["message"])
        self.assertEqual(list(empty.iterdir()), [], "health created nothing")

    def test_health_only_reads_it_never_opens_upgrades_or_writes_the_registry(self):
        self.record()
        self.hold()
        older = SCHEMA_VERSION - 1
        self.registry.db.execute(f"PRAGMA user_version={older}")
        self.addCleanup(self.registry.db.execute, f"PRAGMA user_version={SCHEMA_VERSION}")
        uris = []
        real = pip_server.sqlite3.connect

        def connect(database, *a, **kw):
            uris.append(database)
            return real(database, *a, **kw)
        before = self.registry.db.execute("SELECT key,value FROM metadata ORDER BY key").fetchall()
        with patch.object(WorkspaceRegistry, "__init__", side_effect=AssertionError("health must not open a registry")), \
                patch.object(pip_server.sqlite3, "connect", side_effect=connect):
            value = self.health()
        self.assertEqual(value["state"], "running", value["message"])
        self.assertEqual(len(uris), 1)
        self.assertTrue(uris[0].endswith("registry.sqlite3?mode=ro"), uris[0])
        self.assertEqual(self.registry.db.execute("PRAGMA user_version").fetchone()[0], older, "never upgraded")
        self.assertEqual(self.registry.db.execute("SELECT key,value FROM metadata ORDER BY key").fetchall(), before)

    def test_the_lease_is_looked_at_only_while_a_fresh_heartbeat_says_a_runner_holds_it(self):
        # A runner takes its lease before its first heartbeat, so a probe never meets one that is starting.
        for arrange in (lambda: None, lambda: self.record(heartbeat_at="2026-10-01T09:00:00.000Z"),
                        lambda: self.record(status="stopped")):
            with self.subTest(arrange=arrange):
                self.registry.db.execute("DELETE FROM metadata WHERE key=?", (daemon.SUPERVISOR_KEY,))
                arrange()
                with patch("dgc.scheduler.named_process_lock", side_effect=AssertionError("no lease probe")):
                    self.assertFalse(self.health()["healthy"])

    def test_health_is_a_read_a_chat_shell_may_run(self):
        self.assertTrue(pip_cli.agent_shell_allows(pip_cli.parser().parse_args(["health"])))
        self.assertTrue(pip_cli.agent_shell_allows(pip_cli.parser().parse_args(["health", "--json"])))


class ServerModeTests(Home):
    def serve_once(self, step, *, server=True):
        """One heartbeat of serve(), with `step` run inside it; returns (stdout, the result, what step saw)."""
        seen = {}

        def tick(event):
            seen["active"] = pip_server.active()
            seen["health"] = pip_server.health(self.config, now=NOW)
            seen["record"] = daemon._read(self.registry, daemon.SUPERVISOR_KEY)
            step()

        event = ScriptedEvent([tick, lambda event: event.set()])
        with patch.object(pips, "start_queued"), contextlib.redirect_stdout(io.StringIO()) as out:
            result = daemon.serve(self.config, stop_event=event, clock=lambda: NOW, server=server)
        return out.getvalue(), result, seen

    def test_server_mode_touches_no_desktop_path_and_logs_one_plain_line_per_event(self):
        job = pips.PipStore(self.registry).create(self.workspace["id"], "Auditor", "Read source", "fixture")

        def events():
            self.registry.event(self.workspace["id"], "pip_run_queued", pip_id=job["id"], run_id="pipr_1", payload={})
            self.registry.event(self.workspace["id"], "pip_run_progress", pip_id=job["id"], run_id="pipr_1",
                                payload={"kind": "text_delta", "text": "private words"})
            self.registry.event(self.workspace["id"], "pip_run_failed", pip_id=job["id"], run_id="pipr_1",
                                payload={"status": "failed", "error": {"code": "server_subscription",
                                                                       "message": "Not run: this Pip's model is\nyours."}})
        with patch.object(pip_desktop, "Notifier", side_effect=AssertionError("no desktop notifications on a server")), \
                patch.object(pip_desktop, "deliver", side_effect=AssertionError("nothing shown on a desktop")), \
                patch.object(pip_borrow, "reach_reason", side_effect=AssertionError("no Chrome looked for")), \
                patch.object(pip_borrow, "claim", side_effect=AssertionError("no borrow claimed")), \
                patch("dgc.pip_computer_box.capability", return_value={"available": False, "reason": "Install bubblewrap."}):
            out, result, seen = self.serve_once(events)
        self.assertTrue(seen["active"], "the runs it starts see server mode")
        self.assertFalse(pip_server.active(), "and it ends with the runner")
        self.assertEqual(seen["record"]["mode"], "server")
        self.assertEqual((seen["health"]["state"], seen["health"]["server_mode"]), ("running", True))
        self.assertEqual(result["status"], "stopped")
        lines = out.splitlines()
        self.assertTrue(all(line.startswith("20") for line in lines), lines)
        self.assertRegex(lines[0], r"^\S+ runner_started: server mode, DGC \S+, Pips state ")
        self.assertEqual(lines[1], f"{NOW} pip_computers: unavailable here: Install bubblewrap.")
        self.assertIn(f"{NOW} pip_run_queued pip={job['id']} run=pipr_1", lines)
        self.assertIn(f"{NOW} pip_run_failed pip={job['id']} run=pipr_1: server_subscription: Not run: this Pip's model "
                      "is yours.", lines)
        self.assertNotIn("private words", out, "a run's steps stay in its chat")
        self.assertRegex(lines[-1], r"^\S+ runner_stopped$")
        self.assertEqual(len([line for line in lines if "pip_run_" in line]), 2)

    def test_without_server_the_supervisor_is_as_before(self):
        notifier = Mock()
        with patch.object(pip_desktop, "Notifier", return_value=notifier):
            out, _, seen = self.serve_once(lambda: None, server=False)
        self.assertEqual(out, "")
        self.assertFalse(seen["active"])
        self.assertNotIn("mode", seen["record"])
        notifier.tick.assert_called()

    def test_an_emergency_stop_ends_a_server_runner_with_a_line_saying_so(self):
        out, result, _ = self.serve_once(lambda: daemon.stop_all(self.config, "local-console"))
        self.assertTrue(result["paused"])
        self.assertRegex(out, r"\n\S+Z pip_runtime_stopped by=local-console\n")
        self.assertRegex(out.splitlines()[-1], r" runner_stopped reason=emergency_stop$")

    def test_a_second_runner_on_the_same_home_is_refused(self):
        self.hold()                                     # a runner of this home is running
        with self.assertRaises(RegistryError) as refused:
            daemon.serve(self.config, server=True)
        self.assertEqual(refused.exception.code, "runner_running")
        self.assertFalse(pip_server.active())
        code, out, _ = run_cli(self.config, "serve", "--server")
        self.assertEqual(code, 1, "a refused second runner is a failure where nothing restarts it by itself")
        self.assertRegex(out, r"^\S+ runner_not_started reason=runner_running: A Pips supervisor is already running "
                              r"for this local state directory\.\n$")
        code, out, _ = run_cli(self.config, "serve", "--server", "--service")
        self.assertEqual(code, 0, "under systemd's Restart=on-failure, a clean exit that never loops")
        self.assertIn("runner_not_started reason=runner_running", out)

    def test_pips_off_or_stopped_say_so_on_stdout(self):
        self.config.data["pips_enabled"] = False
        code, out, _ = run_cli(self.config, "serve", "--server")
        self.assertEqual(code, 1)
        self.assertIn("runner_not_started reason=disabled: Pips are disabled in this profile.", out)
        self.config.data["pips_enabled"] = True
        daemon.stop_all(self.config, "fixture")
        code, out, _ = run_cli(self.config, "serve", "--server")
        self.assertEqual(code, 1)
        self.assertIn("runner_not_started reason=runtime_paused: Pips were stopped.", out)


class KeepRunningOnAServerTests(Home):
    def test_a_server_runner_needs_no_login_service_and_no_systemd_says_so(self):
        from dgc import pip_keep_running
        self.record(mode="server")
        with patch.object(pip_keep_running, "_account_home", return_value=True), \
                patch.object(pip_keep_running, "status", side_effect=AssertionError("no service manager asked")):
            self.assertIsNone(pip_keep_running.for_schedule(self.registry, runner_online=True))
        with patch.object(pip_keep_running, "_has_systemd", return_value=False), \
                patch.object(pip_keep_running.pip_service, "install", side_effect=AssertionError("no unit written")), \
                patch.object(pip_keep_running.wsl, "version", return_value=None), \
                patch.object(pip_keep_running.sys, "platform", "linux"):
            state = pip_keep_running.status()
            self.assertEqual((state["supported"], state["on"]), (False, False))
            self.assertIn("no systemd", state["reason"])
            with self.assertRaises(RegistryError) as refused:
                pip_keep_running.set_on(True, runner_online=False)
            self.assertEqual(refused.exception.code, "service_unsupported")


@unittest.skipUnless(sys.platform == "linux", "Linux user-systemd service lifecycle")
class ServerServiceTests(unittest.TestCase):
    """`dgc pips service install --server`: the same unit of this DGC home, running `pips serve --service --server`."""

    systemctl = service_tests.ServiceTests.systemctl

    def setUp(self):
        service_tests.ServiceTests.setUp(self)      # a temporary home and unit folder, systemctl stood in for
        self.server = pip_service.preview(self.home, server=True, **self.options)

    def test_the_server_unit_is_this_homes_unit_running_serve_server(self):
        self.assertEqual(self.server["unit_name"], self.spec["unit_name"], "one unit per DGC home, whichever kind")
        self.assertEqual(self.server["argv"][-4:], ["pips", "serve", "--service", "--server"])
        self.assertEqual(self.spec["argv"][-3:], ["pips", "serve", "--service"], "the desktop unit is as before")
        self.assertIn("Description=DGC Pips server runner\n", self.server["content"])
        self.assertIn("Restart=on-failure\n", self.server["content"])
        self.assertTrue(self.server["server"])
        self.assertFalse(self.spec["server"])
        self.assertIn("journalctl --user -u " + self.spec["unit_name"], self.server["notes"][-1])

    def test_install_server_writes_it_and_every_control_and_keep_running_keep_it(self):
        service = pip_service
        installed = service.install(self.home, server=True, **self.options)
        self.assertEqual((installed["changed"], installed["server"]), (True, True))
        self.assertEqual(self.file.read_text(), self.server["content"])
        self.assertTrue(service.status(self.home, **self.options)["server"])
        self.assertTrue(service.start(self.home, **self.options)["server"])
        self.assertTrue(service.enable(self.home, **self.options)["server"])
        # Keep Pips running (install with upgrade, no variant named) never turns it back into a desktop unit.
        kept = service.install(self.home, upgrade=True, **self.options)
        self.assertEqual((kept["changed"], kept["server"]), (False, True))
        self.assertEqual(self.file.read_text(), self.server["content"])
        service.stop(self.home, **self.options)
        self.assertFalse(service.uninstall(self.home, **self.options)["installed"])
        self.assertFalse(self.file.exists())

    def test_naming_a_kind_replaces_the_other_kind_of_this_unit_only(self):
        service = pip_service
        service.install(self.home, **self.options)
        self.assertEqual(self.file.read_text(), self.spec["content"])
        self.assertTrue(service.install(self.home, server=True, **self.options)["changed"])
        self.assertEqual(self.file.read_text(), self.server["content"])
        self.assertTrue(service.install(self.home, server=False, **self.options)["changed"])
        self.assertEqual(self.file.read_text(), self.spec["content"])
        self.file.write_text(self.server["content"] + "# edited\n")
        with self.assertRaises(RegistryError) as conflict:
            service.install(self.home, server=True, **self.options)
        self.assertEqual(conflict.exception.code, "service_conflict", "an edited unit is never overwritten")

    def test_the_cli_names_the_server_kind_only_when_asked(self):
        fixture = cli_tests.PipCliTests("test_disabled_explains_local_opt_in_without_opening_registry")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        for argv, expected in ((["service", "install", "--server"], {"server": True}), (["service", "install"], {}),
                               (["service", "preview", "--server"], {"server": True})):
            with self.subTest(argv=argv), patch.object(pip_service, argv[1], return_value={"ok": 1}) as operation:
                self.assertEqual(fixture.value(*argv, "--unit-directory", str(self.units)), {"ok": 1})
                operation.assert_called_once_with(unit_directory=str(self.units), **expected)
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                pip_cli.parser().parse_args(["service", "start", "--server"])


class GuardrailTests(unittest.TestCase):
    """A Pip on the user's own Claude Code or Codex plan is refused by a server-mode runner, in words, and marked."""

    def setUp(self):
        from tests.test_pip_brain import install_clis
        from tests.test_pip_eyes import catalog_setup
        catalog_setup(self)
        install_clis(self)

    def refused(self, choice):
        pip = self.store.create(self.registry.personal()["id"], "Tees", None, "editor-user", pip_type="lens",
                                model_choice=choice)
        run = pip_chat.send(self.store, pip["id"], "hi", "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        row = self.store.claim_next()
        self.assertEqual(row["id"], run["id"])
        with pip_server.server_mode(), \
                patch.object(pips.subprocess, "Popen", side_effect=AssertionError("nothing starts")), \
                patch("dgc.pip_models.validate_pinned_connection", side_effect=AssertionError("refused before this")):
            pips._run_claimed(self.registry, self.store, row, self.cfg, self.registry.directory)
        return pip, self.store.run(run["id"])

    def test_a_pip_on_a_personal_plan_is_refused_with_words_and_its_run_is_marked_not_switched(self):
        pip, run = self.refused({"mode": "subscription", "engine": "claude"})
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["error"]["code"], "server_subscription")
        message = run["error"]["message"]
        self.assertTrue(message.startswith("Not run: this Pip's model is your Claude Code plan, and Pips on a server run "
                                           "only on an API key or a self-hosted model."), message)
        self.assertIn(f"dgc pips propose {pip['id']} --expected-version 1 --model MODEL", message)
        self.assertIn("doesn't switch this Pip to another model by itself", message)
        self.assertNotRegex(message, r"\bAI\b")
        self.assertEqual(self.store.get(pip["id"])["model_choice"], {"mode": "subscription", "engine": "claude"},
                         "its model is unchanged")

    def test_same_as_dgc_on_a_plan_is_refused_and_says_where_to_change_it(self):
        self.cfg.data["subscription_engine"] = "codex"
        pip, run = self.refused({"mode": "default"})
        self.assertEqual(run["error"]["code"], "server_subscription")
        self.assertIn("this Pip follows DGC's default model, which here is your Codex plan", run["error"]["message"])
        self.assertIn("Set DGC's own model to an API key or a self-hosted model (dgc setup)", run["error"]["message"])

    def test_off_a_server_the_guardrail_does_nothing(self):
        row = {"pip_id": "pip_x", "id": "pipr_x"}
        self.assertIsNone(pip_server.refuse_subscription(self.registry, row, {"brain": {"engine": "claude"}}))
        with pip_server.server_mode():
            self.assertIsNone(pip_server.refuse_subscription(self.registry, row, {"model": "qwen3:32b",
                                                                                 "base_url": "http://ollama:11434/v1"}))


class ContainerReasonTests(unittest.TestCase):
    """In a container, bubblewrap's missing namespaces are the container's doing: no Ubuntu sudo fix is offered, and the
    reason names the Docker options and the host's service instead (what pip_computers logs at start)."""

    def test_a_container_is_known_by_its_marker_or_variable(self):
        from dgc import browser_setup
        with patch.dict(os.environ, {"container": "podman"}):
            self.assertTrue(browser_setup.in_container())
        with patch.dict(os.environ, {}, clear=False), patch.object(browser_setup.os.path, "exists",
                                                                    side_effect=lambda path: path == "/.dockerenv"):
            os.environ.pop("container", None)
            self.assertTrue(browser_setup.in_container())

    def test_pip_computers_and_commands_say_why_in_a_container(self):
        from dgc import pip_computer_box, pip_execution
        with patch("dgc.browser_setup.in_container", return_value=True), \
                patch("dgc.browser_setup.userns_restricted", return_value=True):
            said = pip_computer_box.box_refused_reason("")
            self.assertIn("This runs in a container that doesn't let bubblewrap make the namespaces it needs, so a "
                          "Pip's computer can't run here.", said)
            self.assertIn("--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt "
                          "systempaths=unconfined", said)
            self.assertIn("dgc pips service install --server", said)
            self.assertNotIn("sudo", said)
            self.assertIsNone(pip_execution.machine_fix(), "no sudo inside a container fixes it")
            if pip_execution._backend() == "bwrap":
                pip_execution._PROBE_CACHE.clear()
                self.addCleanup(pip_execution._PROBE_CACHE.clear)
                with patch.object(pip_execution, "_probe_bwrap", return_value=False):
                    found = pip_execution.capability()
                self.assertFalse(found["available"])
                self.assertIn("so Pulse and Patch commands can't run here", found["reason"])
                self.assertNotIn("fix", found)
                self.assertTrue(found["local_http_checks"])


SERVER_CHAT_WORKER = r'''
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult
from dgc.pips import _worker_main
def chat(self, messages, tools=None, on_text=None, **kwargs):
    names = [t["function"]["name"] for t in (tools or [])]
    system = messages[0]["content"] if messages and messages[0].get("role") == "system" else ""
    assert "borrow_chrome" not in names and "borrowed_chrome" not in names, names
    assert "borrow_chrome" not in system, "a server-mode Pip is not told about borrowing a Chrome"
    return ChatResult(content="Your order 1001 is paid.")
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''


class ServerRunTests(unittest.TestCase):
    """A Personal Pip on a self-hosted model runs in server mode, and no desktop or signed-in Chrome path is touched."""

    def setUp(self):
        from tests.test_pip_levels import Store
        Store.setUp(self)
        self.pip = self.store.create(self.registry.personal()["id"], "Order desk", "Check my orders", "editor-user")

    def test_a_self_hosted_pip_runs_and_no_desktop_or_chrome_path_is_touched(self):
        pip_chat.send(self.store, self.pip["id"], "Is order 1001 paid?", "k-1", "editor-user", self.cfg)
        row = self.store.claim_next()
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [PYTHON, "-c", SERVER_CHAT_WORKER]
            return popen(argv, *a, **kw)
        with pip_server.server_mode(), patch.object(pips.subprocess, "Popen", side_effect=process), \
                patch.object(pip_borrow, "claim", side_effect=AssertionError("no borrow claimed")), \
                patch.object(pip_borrow, "reach_reason", side_effect=AssertionError("no Chrome looked for")), \
                patch.object(pip_borrow.BorrowedTab, "connect", side_effect=AssertionError("no Chrome reached")), \
                patch.object(pip_desktop, "deliver", side_effect=AssertionError("no desktop")):
            result = pips._execute_run(self.registry, row, self.cfg)
        run = self.store.finish(row["id"], result=result)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(result["text"], "Your order 1001 is paid.")
        self.assertEqual(pip_borrow.listing(self.registry, self.pip["id"])["borrows"], [])

    def test_a_borrow_asked_on_a_server_is_refused_in_words_with_no_card(self):
        session = pip_borrow.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"],
                                     "pipr_1", refused=pip_server.NO_CHROME)
        self.addCleanup(session.close)
        self.assertEqual(session.pin(), {"refused": True})
        for op in (pip_borrow.ASK, pip_borrow.USE):
            said = session.call(op, {"sites": ["shop.example"], "why": "orders", "op": "open"})
            self.assertEqual(said, "error: " + pip_server.NO_CHROME)
        self.assertEqual(pip_borrow.listing(self.registry, self.pip["id"])["borrows"], [])


@unittest.skipUnless(sys.platform.startswith("linux"), "the runner's lease and signals, on Linux")
class RealRunnerTests(unittest.TestCase):
    """Real `dgc pips serve --server` processes on one temporary home: healthy, a second one refused, stopped."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-pip-server-real-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        (self.home / ".dgc").mkdir(mode=0o700)
        (self.home / ".dgc" / "config.json").write_text(json.dumps({
            "pips_enabled": True, "model": "fixture", "base_url": "http://127.0.0.1:9/v1", "api_mode": "chat_completions"}))
        self.env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "HOME": str(self.home),
                    "DGC_HOME": str(self.home), "PYTHONPATH": str(ROOT), "PYTHONDONTWRITEBYTECODE": "1"}

    def dgc(self, *argv, **kw):
        return subprocess.run([PYTHON, "-m", "dgc", "pips", *argv], cwd=self.home, env=self.env, capture_output=True,
                              text=True, timeout=60, **kw)

    def start(self):
        process = subprocess.Popen([PYTHON, "-m", "dgc", "pips", "serve", "--server"], cwd=self.home, env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)

        def stop():
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)     # this test's own process, by its handle
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
        self.addCleanup(stop)
        return process, stop

    def test_healthy_then_a_second_runner_is_refused_then_stopped_is_unhealthy(self):
        self.assertEqual(self.dgc("health").returncode, 1, "nothing runs yet")
        first, stop = self.start()
        deadline = time.monotonic() + 40
        while True:
            probe = self.dgc("health", "--json")
            if probe.returncode == 0 or time.monotonic() > deadline or first.poll() is not None:
                break
            time.sleep(0.5)
        self.assertEqual(probe.returncode, 0, probe.stdout + probe.stderr)
        self.assertEqual(json.loads(probe.stdout)["state"], "running")
        second = self.dgc("serve", "--server")
        self.assertEqual(second.returncode, 1, second.stdout + second.stderr)
        self.assertRegex(second.stdout, r"runner_not_started reason=runner_running: A Pips supervisor is already running")
        self.assertIsNone(first.poll(), "the first runner keeps running")
        self.assertEqual(self.dgc("health").returncode, 0, "and stays healthy")
        stop()
        self.assertEqual(first.returncode, 0)
        after = self.dgc("health")
        self.assertEqual(after.returncode, 1)
        self.assertIn("No Pips runner is running: the last one stopped", after.stdout)


if __name__ == "__main__":
    unittest.main()
