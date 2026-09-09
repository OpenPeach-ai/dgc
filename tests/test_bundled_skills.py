"""Bundled packages route deliberately and survive real composer/catalog boundaries."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prompt_toolkit.document import Document

from dgc.cli import ClassicSlashCompleter
from dgc.composer import completion_rows, compose_prompt
from dgc.skills import discover_skills, explicit_skill_instructions, matching_skill_names, skill_catalog


class BundledSkillsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-bundled-skills-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        # The developer's personal skills must not alter a shipped-package assertion.
        for name in ("USER_SKILLS", "PORTABLE_USER_SKILLS"):
            replacement = patch("dgc.skills." + name, self.root / name)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.catalog = discover_skills(self.root)

    def test_task_routing_and_nearby_nonmatching_requests(self):
        cases = {
            "browser-test": ("Add browser tests for failed checkout recovery", "Change a button label"),
            "fix-ci": ("Diagnose the CI failure on this branch", "Explain a local Python function"),
            "pr-feedback": ("Address review comments on this pull request", "Review the diff for correctness"),
            "skill-author": ("Create a portable skill for API migrations", "Implement an API endpoint"),
            "mcp-builder": ("Build an MCP server for project documentation", "Connect this MCP server"),
        }
        for name, (positive, negative) in cases.items():
            with self.subTest(skill=name):
                self.assertIn(name, matching_skill_names(self.catalog, positive))
                self.assertNotIn(name, matching_skill_names(self.catalog, negative))
                self.assertIn(name, matching_skill_names(self.catalog, "$" + name + " " + negative))
                self.assertEqual(self.catalog[name].diagnostics, ())
        self.assertEqual(matching_skill_names(self.catalog, "Fix an off-by-one in pagination"), set())

    def test_cli_and_editor_selection_keep_names_metadata_and_exact_instructions(self):
        names = ["browser-test", "fix-ci", "pr-feedback", "skill-author", "mcp-builder"]
        public = {row["name"]: row for row in skill_catalog(self.catalog, self.root)}
        completer = ClassicSlashCompleter(self.root)
        for name in names:
            self.assertEqual(public[name]["source"], "builtin")
            self.assertTrue(public[name]["display_name"])
            for surface in ("cli", "tui", "editor"):
                rows = completion_rows(surface, self.root, skills=self.catalog, trigger="$", query=name)
                self.assertEqual([row["value"] for row in rows], [name])
            draft = "Check the requested flow $" + name[:4]
            rows = list(completer.get_completions(Document(draft, len(draft)), None))
            self.assertIn("$" + name, [row.text for row in rows])
        text = compose_prompt("Keep the existing theme and tools.", skills=names,
                              catalog=self.catalog, project_root=self.root)
        loaded = explicit_skill_instructions(self.catalog, text)
        self.assertEqual(list(loaded), names)
        for name in names:
            self.assertEqual(loaded[name]["instructions"], self.catalog[name].render(text))
        disabled = discover_skills(self.root, disabled_names=["fix-ci"])
        with self.assertRaises(ValueError):
            compose_prompt("Run checks", skills=["fix-ci"], catalog=disabled, project_root=self.root)


if __name__ == "__main__":
    unittest.main()
