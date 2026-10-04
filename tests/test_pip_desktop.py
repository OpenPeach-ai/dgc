"""Desktop notifications from the runner: each new alert and review once, never a backlog."""
import io
import contextlib
import json
import sys
import unittest
from unittest.mock import patch

from dgc import pip_cli, pip_daemon, pip_desktop as desktop
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests.test_pip_digest import DigestTests


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class NotifierTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.shown, self.clock = [], Clock()
        self.notifier = desktop.Notifier(self.cfg, clock=self.clock, send=lambda t, b: self.shown.append((t, b)) or True)
        self.pip = self.store.create(self.workspace["id"], "Reviewer", "Review", "local-console")

    def propose(self, goal):
        version = self.store.get(self.pip["id"])["current_version"]
        return self.store.propose(self.pip["id"], version, {"goal": goal}, "local-console")

    def tick(self, minutes=1.0):
        self.clock.now += 60 * minutes
        return self.notifier.tick(self.registry)

    def test_a_new_review_is_announced_once(self):
        self.assertIsNone(self.tick(), "nothing waiting, nothing said")
        self.propose("Review more")
        self.assertEqual(self.tick(), "1 review waiting for you. Open the Pips view to decide.")
        self.assertEqual(self.shown, [("DGC Pips", "1 review waiting for you. Open the Pips view to decide.")])
        self.assertIsNone(self.tick(), "never twice")
        restarted = desktop.Notifier(self.cfg, clock=self.clock, send=lambda t, b: self.shown.append((t, b)) or True)
        self.assertIsNone(restarted.tick(self.registry), "a restarted runner remembers what it said")

    def test_at_most_once_a_minute(self):
        self.propose("One")
        self.tick()
        self.clock.now += 5
        self.propose_second = self.store.create(self.workspace["id"], "Other", "Other", "local-console")
        self.store.propose(self.propose_second["id"], 1, {"goal": "Two"}, "local-console")
        self.assertIsNone(self.notifier.tick(self.registry), "five seconds later: not yet")
        self.assertEqual(self.tick(), "2 reviews waiting for you. Open the Pips view to decide.")

    def test_off_says_nothing_and_turning_it_on_brings_no_backlog(self):
        desktop.set_enabled(self.registry, False, "editor-user")
        self.propose("Quietly")
        self.assertIsNone(self.tick())
        self.assertEqual(self.shown, [])
        desktop.set_enabled(self.registry, True, "editor-user")
        self.assertIsNone(self.tick(), "what arrived while off is not announced later")
        self.propose("Now")
        self.assertIsNotNone(self.tick())

    def test_the_setting_is_the_users(self):
        for actor in ("main-chat", "local-scheduler"):
            with self.assertRaises(RegistryError):
                desktop.set_enabled(self.registry, False, actor)
        with self.assertRaises(RegistryError):
            desktop.set_enabled(self.registry, "off", "editor-user")

    def test_a_failing_check_never_stops_the_runner(self):
        broken = desktop.Notifier(self.cfg, clock=self.clock, send=lambda t, b: True)
        err = io.StringIO()
        with patch.object(broken, "_reviews", side_effect=RuntimeError("boom")), contextlib.redirect_stderr(err):
            pip_daemon._notify(broken, self.registry)
            broken.last = None
            pip_daemon._notify(broken, self.registry)
        self.assertEqual(err.getvalue().count("desktop notification check failed"), 1, "logged once, not every beat")


class AlertTests(unittest.TestCase):
    """A new finding at a Pip's alert level is announced with the digest's own headline."""
    _fixture = DigestTests._fixture
    new_pip, finding, report = DigestTests.new_pip, DigestTests.finding, DigestTests.report
    source_run, complete, at = DigestTests.source_run, DigestTests.complete, DigestTests.at
    setUp = DigestTests.setUp

    def test_an_alert_uses_the_digest_headline(self):
        shown, clock = [], Clock()
        notifier = desktop.Notifier(None, clock=clock, send=lambda t, b: shown.append(b) or True)
        self.complete([self.finding("Unchecked user id", severity="high")])
        clock.now += 60
        body = notifier.tick(self.registry)
        self.assertIsNotNone(body)
        self.assertIn("new finding", body)
        self.assertIn("(worst: high)", body)
        clock.now += 60
        self.assertIsNone(notifier.tick(self.registry), "the same alert is not repeated")


class DeliveryTests(unittest.TestCase):
    def run_with(self, platform, code=0):
        calls = []

        def fake(argv, **kwargs):
            calls.append((argv, kwargs["env"]))
            return type("Done", (), {"returncode": code})()
        with patch.object(sys, "platform", platform), patch("subprocess.run", side_effect=fake), \
                patch.object(desktop, "_which", return_value="/usr/bin/notify-send"):
            shown = desktop.deliver("DGC Pips", 'Rook said "hi"\x1b[31m\nand left')
        return shown, calls

    def test_linux_uses_notify_send_on_the_session_bus(self):
        shown, [(argv, env)] = self.run_with("linux")
        self.assertTrue(shown)
        self.assertEqual(argv, ["/usr/bin/notify-send", "--app-name=DGC", "DGC Pips", 'Rook said "hi" [31m and left'])
        self.assertTrue(env.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:") or "DBUS_SESSION_BUS_ADDRESS" not in env)

    def test_macos_passes_the_text_as_arguments_never_as_script(self):
        shown, [(argv, _)] = self.run_with("darwin")
        self.assertEqual(argv[:7], ["/usr/bin/osascript", "-e", "on run argv", "-e",
                                    "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"])
        self.assertEqual(argv[7:], ["DGC Pips", 'Rook said "hi" [31m and left'])

    def test_a_failure_or_another_platform_is_just_not_shown(self):
        self.assertFalse(self.run_with("linux", code=1)[0])
        self.assertFalse(self.run_with("win32")[0])


class CommandTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True

    def cli(self, *argv, shell=False):
        import os
        from dgc import sandbox
        out, err = io.StringIO(), io.StringIO()
        env = {sandbox.AGENT_SHELL: "1"} if shell else {}
        with patch.dict(os.environ, env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pip_cli.handle_command(self.cfg, list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_on_off_and_status_from_the_terminal_but_not_from_a_chats_shell(self):
        code, text, err = self.cli("desktop-notifications", "--json")
        self.assertEqual(code, 0, err)
        self.assertIs(json.loads(text)["desktop_notifications"]["on"], True, "on by default")
        code, text, _ = self.cli("desktop-notifications", "off", "--json")
        self.assertIs(json.loads(text)["desktop_notifications"]["on"], False)
        code, _, err = self.cli("desktop-notifications", "on", shell=True)
        self.assertEqual(code, 2)
        code, text, _ = self.cli("desktop-notifications", "--json", shell=True)
        self.assertIs(json.loads(text)["desktop_notifications"]["on"], False, "reading works; the change was refused")


if __name__ == "__main__":
    unittest.main()


class EvidenceTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()

    def test_the_status_says_whether_the_last_one_actually_showed(self):
        self.assertIsNone(desktop.status(self.registry)["last"])
        clock = Clock()
        notifier = desktop.Notifier(self.cfg, clock=clock, send=lambda t, b: False)
        pip = self.store.create(self.workspace["id"], "Reviewer", "Review", "local-console")
        self.store.propose(pip["id"], 1, {"goal": "More"}, "local-console")
        clock.now += 60
        self.assertIsNone(notifier.tick(self.registry), "not shown, so not reported as shown")
        self.assertIs(desktop.status(self.registry)["last"]["shown"], False)
        self.assertIn("The last one did not show", pip_cli._format({"desktop_notifications": desktop.status(self.registry)}))
