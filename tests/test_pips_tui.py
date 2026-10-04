"""`/pips` in the full-screen terminal, and the welcome tip that carries today's Pips digest."""
import io
import unittest
from unittest.mock import patch

from tests import test_permissions_tui as hermetic   # redirects HOME before dgc is imported
from tests.pip_test_profile import pips_in_use


class PipsTuiTests(unittest.TestCase):
    setUp = hermetic.TuiPermissionsTest.setUp
    tui = hermetic.TuiPermissionsTest.tui

    def shown(self, ui, command):
        lines = []
        ui._rich = lambda text: text
        ui._append = lines.append
        ui._handle_slash(command)
        return "\n".join(lines)

    def test_pips_runs_the_pips_commands_in_the_transcript(self):
        ui = self.tui()
        self.config.data["pips_enabled"] = True
        self.assertIn("No Pips yet", self.shown(ui, "/pips"), "a profile without Pips gets no registry")
        self.assertIn("commit-review", self.shown(ui, "/pips starters"))

    def test_a_command_that_would_ask_is_refused_without_yes(self):
        pips_in_use(self)
        ui = self.tui()
        self.config.data["pips_enabled"] = True
        class Terminal(io.StringIO):           # the TUI's own stdin is a terminal
            def isatty(self):
                return True
        with patch("sys.stdin", Terminal("y\n")), \
                patch("dgc.pip_daemon.stop_all", side_effect=AssertionError("stopped without confirmation")):
            text = self.shown(ui, "/pips stop")
        self.assertIn("--yes", text)

    def test_the_welcome_tip_carries_a_due_digest_without_marking_it_seen(self):
        pips_in_use(self)
        ui = self.tui()
        self.config.data["pips_enabled"] = True
        due = {"due": True, "headline": "1 new finding from Commit reviewer (worst: high)"}
        with patch("dgc.pip_digest.build", return_value=due) as build, \
                patch("dgc.pip_digest.mark_seen", side_effect=AssertionError("the tip never marks it seen")):
            ui._load_pips_digest()
        build.assert_called_once()
        ui._rich = lambda text: text
        tip = str(ui._tip().value)
        self.assertIn("1 new finding from Commit reviewer", tip)
        self.assertIn("/pips", tip)
        with patch("dgc.pip_digest.build", return_value={**due, "due": False}):
            ui._pips_digest_tip = None
            ui._load_pips_digest()
        self.assertNotIn("Pips:", str(ui._tip().value), "nothing due: the ordinary tip")


if __name__ == "__main__":
    unittest.main()
