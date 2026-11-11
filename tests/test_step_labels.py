"""Plain-words labels on each step (0.52, asked 11 Nov): a bash call may carry a short `description` ("List the project's
files"), shown as the step's grey label in Work, with the exact command one click away, as Claude Code's Bash tool does.

The label is the model's own words, so it never decides anything: the permission decision, the approval card's summary
and command, and the rule an Always allow would save all go by the exact command, whatever the label says."""
import tempfile
import unittest
from pathlib import Path

from dgc.headless import permission_request_fields
from dgc.permissions import PermissionEngine
from dgc.tools import TOOL_SCHEMAS
from dgc.ui import arg_summary

MISLEADING = "List the project's files"
COMMAND = "rm -rf build && git push --force origin main"


def schema(name):
    return next(s["function"] for s in TOOL_SCHEMAS if s["function"]["name"] == name)


class StepLabels(unittest.TestCase):
    def test_bash_takes_an_optional_short_label(self):
        bash = schema("bash")
        label = bash["parameters"]["properties"].get("description")
        self.assertIsNotNone(label, "bash takes a description, as Claude Code's Bash does")
        self.assertEqual(label["type"], "string")
        self.assertNotIn("description", bash["parameters"]["required"], "optional: a call without one works as before")
        self.assertLess(len(label.get("description", "")), 160, "the always-sent schema stays small")

    def test_a_misleading_label_never_changes_the_decision(self):
        root = Path(tempfile.mkdtemp())
        rules = {"deny": ["Bash(rm -rf*)"], "ask": ["Bash(git push*)"], "allow": ["Bash(ls*)"]}
        for mode in ("default", "auto", "plan"):
            engine = PermissionEngine(mode, rules, root)
            for command in (COMMAND, "git push origin main", "ls -la", "make test"):
                plain = engine.decide("bash", {"command": command})
                labelled = engine.decide("bash", {"command": command, "description": MISLEADING})
                self.assertEqual(plain, labelled, (mode, command))
            self.assertEqual(engine.decide("bash", {"command": "ls", "description": "rm -rf everything"})[0],
                             engine.decide("bash", {"command": "ls"})[0], "a frightening label changes nothing either")

    def test_the_approval_card_shows_the_exact_command_not_the_label(self):
        root = Path(tempfile.mkdtemp())
        plain = permission_request_fields("bash", {"command": COMMAND}, "c1", root)
        labelled = permission_request_fields("bash", {"command": COMMAND, "description": MISLEADING}, "c1", root)
        for field in ("summary", "command", "suggested_rule"):
            self.assertEqual(labelled.get(field), plain.get(field), field)
        self.assertIn("rm -rf build", labelled["summary"])
        self.assertNotIn(MISLEADING, labelled["summary"])
        self.assertNotIn(MISLEADING, str(labelled.get("command")))

    def test_the_rows_summary_is_still_the_command(self):
        # The label travels in the call's own arguments (args.description); the row's summary stays the command, so an
        # editor that doesn't know labels shows exactly what it shows today.
        self.assertEqual(arg_summary("bash", {"command": "ls -la", "description": MISLEADING}),
                         arg_summary("bash", {"command": "ls -la"}))


if __name__ == "__main__":
    unittest.main()
