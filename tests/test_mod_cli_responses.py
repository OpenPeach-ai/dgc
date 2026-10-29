"""The mod authoring commands must clean up and report malformed protocol replies."""
import contextlib
import io
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc.mods import cli as mod_cli
from dgc.mods.runtime import ModError


class FakeManifest:
    name = "sample"
    title = "Sample"
    version = "1.0.0"
    runtime = "python"
    entry = "main.py"
    events = ["tool.call"]
    commands = [{"name": "hello"}]
    draws = ["pane"]
    rewrites_prompt = False

    def capabilities(self):
        return {}


class FakeProcess:
    error = ""

    def __init__(self, answers):
        self.answers = answers
        self.stopped = False

    def request(self, method, params, timeout=0):
        answer = self.answers[method]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def stop(self):
        self.stopped = True


class ModCLIResponseTests(unittest.TestCase):
    def test_mod_text_cannot_inject_terminal_controls_or_lines(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            mod_cli._say("Bad\x1b[2J\n✓ valid\r\u202e")
        self.assertEqual(output.getvalue(), "Bad [2J ✓ valid  \n")

    def run_command(self, function, answers):
        process = FakeProcess(answers)
        with patch.object(mod_cli, "load", return_value=FakeManifest()), \
                patch.object(mod_cli, "describe", return_value=[]), \
                patch.object(mod_cli, "_process", return_value=process), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            result = function(Path("."))
        return result, process, output.getvalue()

    def test_validate_stops_after_initialize_failure(self):
        result, process, output = self.run_command(mod_cli._validate, {"initialize": ModError("broken")})
        self.assertEqual(result, 1)
        self.assertTrue(process.stopped)
        self.assertIn("broken", output)

    def test_validate_rejects_malformed_registration(self):
        for registration in ([], {"hooks": [None]}, {"commands": [[]]}, {"renders": "pane"}):
            with self.subTest(registration=registration):
                result, process, output = self.run_command(mod_cli._validate, {"initialize": registration})
                self.assertEqual(result, 1)
                self.assertTrue(process.stopped)
                self.assertIn("invalid", output.lower())

    def test_test_stops_after_initialize_failure(self):
        result, process, output = self.run_command(mod_cli._test, {"initialize": ModError("broken")})
        self.assertEqual(result, 1)
        self.assertTrue(process.stopped)
        self.assertIn("broken", output)

    def test_test_reports_malformed_event_and_continues(self):
        result, process, output = self.run_command(mod_cli._test, {
            "initialize": {}, "event": ["bad"], "command": {"tree": None}, "ui.render": {"tree": None},
        })
        self.assertEqual(result, 1)
        self.assertTrue(process.stopped)
        self.assertIn("tool.call", output)
        self.assertIn("/hello", output)
        self.assertIn("draws pane", output)

    def test_test_reports_malformed_command_and_render(self):
        for method in ("command", "ui.render"):
            answers = {"initialize": {}, "event": {}, "command": {}, "ui.render": {}}
            answers[method] = ["bad"]
            with self.subTest(method=method):
                result, process, output = self.run_command(mod_cli._test, answers)
                self.assertEqual(result, 1)
                self.assertTrue(process.stopped)
                self.assertIn("failed", output)


if __name__ == "__main__":
    unittest.main()
