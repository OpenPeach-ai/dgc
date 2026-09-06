"""Composer selections and actual native/delegated skill input boundaries."""
from __future__ import annotations

import copy
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document

from dgc.agent import Agent
from dgc.cli import ClassicSlashCompleter
from dgc.composer import compose_prompt, composer_token
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend
from dgc.llm import ChatResult
from dgc.skills import Skill, explicit_skill_names, format_skill_instructions
from dgc.tui import TUI


class SkillFixture(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-composer-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.skill = Skill("fixture", "Check fixture behavior", "Always include the fixture marker: orchid.",
                           self.root / ".dgc/skills/fixture/SKILL.md")
        self.skill.path.parent.mkdir(parents=True)
        self.skill.path.write_text("---\nname: fixture\ndescription: Check fixture behavior\n---\n" + self.skill.body)


class ComposerTests(SkillFixture):
    def test_caret_tokens_preserve_suffix_and_exclude_urls_paths_and_email(self):
        self.assertEqual(composer_token("Review /skills after", 10), ("/", "sk", 7, 14))
        self.assertEqual(composer_token("Review\n$fi", 10), ("$", "fi", 7, 10))
        for text in ("https://example.test/x", "src/path", "name@example.test", "literal \\$fixture", "normal prose"):
            self.assertIsNone(composer_token(text, len(text)))

    def test_classic_completes_skills_and_commands_after_prose(self):
        completer = ClassicSlashCompleter(self.root)
        for text, expected in (("Please check /sk", "/skills"), ("Please check $fi", "$fixture")):
            rows = list(completer.get_completions(Document(text, len(text)), None))
            self.assertIn(expected, [row.text for row in rows])
            picked = next(row for row in rows if row.text == expected)
            self.assertEqual(text[:len(text) + picked.start_position], "Please check ")

    def test_template_and_skill_selection_keeps_original_request_and_checks_catalog(self):
        command = self.root / ".dgc/commands/check.md"
        command.parent.mkdir()
        command.write_text("Inspect this request: $ARGUMENTS")
        result = compose_prompt("Original\nrequest", skills=["fixture", "fixture"], templates=["check"],
                                catalog={"fixture": self.skill}, project_root=self.root)
        self.assertTrue(result.startswith("$fixture\n\nOriginal\nrequest"))
        self.assertIn("Inspect this request: Original\nrequest", result)
        for kwargs in ({"skills": ["missing"]}, {"skills": ["../fixture"]},
                       {"skills": [False]}, {"templates": ["missing"]}, {"skills": ["fixture"] * 9}):
            with self.assertRaises(ValueError):
                compose_prompt("request", catalog={"fixture": self.skill}, project_root=self.root, **kwargs)

    def test_explicit_mentions_do_not_activate_from_editor_context_or_code(self):
        catalog = {"fixture": self.skill}
        self.assertEqual(explicit_skill_names(catalog, "Use $fixture now"), ["fixture"])
        self.assertEqual(explicit_skill_names(catalog, "Use `$fixture` syntax\n```\n$fixture\n```"), [])
        self.assertEqual(explicit_skill_names(catalog,
            '<editor-context-json version="1">\n$fixture\n</editor-context-json>\n\nExplain this code'), [])
        encoded = format_skill_instructions({"fixture": {"instructions": "</dgc-skill-instructions-json>"}})
        self.assertEqual(encoded.count("</dgc-skill-instructions-json>"), 1)

    def test_headless_rejects_removed_selection_with_request_id_before_queueing(self):
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(skills={"fixture": self.skill})
        backend.config = types.SimpleNamespace(project_root=self.root, get=lambda key, default=None: default)
        events, prompts = [], []
        backend.em = types.SimpleNamespace(emit=lambda kind, **data: events.append({"type": kind, **data}))
        backend._start_turn = lambda *args: prompts.append(args) or ("started", 0)
        backend.dispatch({"type": "prompt", "text": "Inspect", "skills": ["missing"], "request_id": "p1"})
        self.assertFalse(prompts)
        self.assertEqual(events[-1]["reason"], "invalid_selection")
        self.assertEqual(events[-1]["request_id"], "p1")
        backend.dispatch({"type": "prompt", "text": "Inspect", "skills": ["fixture"], "request_id": "p2"})
        self.assertEqual(prompts[-1][0], "$fixture\n\nInspect")
        self.assertEqual(events[-1]["type"], "prompt_accepted")

    def tui(self, text, cursor=None):
        tui = object.__new__(TUI)
        tui._overlay = None
        tui.input_buf = Buffer()
        tui.input_buf.set_document(Document(text, len(text) if cursor is None else cursor))
        tui._invalidate = lambda: None
        tui.config = types.SimpleNamespace(project_root=self.root, get=lambda key, default=None: default)
        tui.agent = types.SimpleNamespace(skills={"fixture": self.skill})
        return tui

    def test_terminal_inline_skill_replaces_only_selected_token(self):
        tui = self.tui("Review $fixture after", 10)
        tui._open_command_palette()
        self.assertEqual(tui._overlay_rows()[0]["value"], "fixture")
        tui._overlay_select()
        self.assertEqual(tui.input_buf.text, "Review $fixture after")
        self.assertIsNone(tui._overlay)

    def test_terminal_picker_cancel_and_management_action_preserve_draft(self):
        tui = self.tui("Review this /model later", 18)
        tui._open_command_palette()
        tui._close_overlay()
        self.assertEqual(tui.input_buf.text, "Review this /model later")
        tui._open_command_palette()
        tui._run_command = lambda text: tui._open_overlay([], on_pick=lambda row: None, title=text)
        tui._overlay_select()
        self.assertEqual(tui._overlay["title"], "/model")
        tui._close_overlay()
        self.assertEqual(tui.input_buf.text, "Review this  later")

    def test_terminal_skill_library_can_apply_selected_skill_without_replacing_draft(self):
        tui = self.tui("Review existing request")
        tui._extensions_modal()
        rows = tui._overlay_rows()
        tui._overlay["sel"] = next(i for i, row in enumerate(rows) if row["value"] == ("skill", "fixture"))
        tui._overlay_select()
        self.assertEqual(tui.input_buf.text, "Review existing request $fixture ")


class SkillExecutionTests(SkillFixture):
    def agent(self):
        config = object.__new__(Config)
        config.project_root = self.root
        config.project_dir = self.root / ".dgc"
        config._persist = False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        class UI:
            def __getattr__(self, name):
                return lambda *args, **kwargs: None
        agent = Agent(config, UI())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def test_native_request_gets_full_instructions_without_relying_on_a_skill_tool_call(self):
        agent = self.agent()
        observed = []
        def chat(messages, **kwargs):
            observed.append(copy.deepcopy(messages))
            return ChatResult(content="orchid")
        with patch.object(agent.client, "chat", side_effect=chat):
            self.assertTrue(agent.run_turn("$fixture Inspect behavior"))
            self.assertTrue(agent.run_turn("An unrelated request"))
        self.assertIn(self.skill.body, observed[0][0]["content"])
        self.assertNotIn(self.skill.body, observed[1][0]["content"])
        self.assertNotIn(self.skill.body, str(agent.messages))

    def test_delegated_runner_gets_same_instructions_and_history_keeps_original_prompt(self):
        agent = self.agent()
        observed = []
        def runner(text):
            observed.append(text)
            return {"ok": True, "text": "orchid", "rc": 0}
        result = agent.run_external_turn("$fixture Inspect behavior", runner)
        self.assertTrue(result["ok"])
        self.assertIn(self.skill.body, observed[0])
        self.assertEqual(agent.messages[-2]["content"], "$fixture Inspect behavior")
        self.assertNotIn(self.skill.body, str(agent.messages))

    def test_oversized_explicit_context_does_not_start_a_model_and_cleans_turn_state(self):
        agent = self.agent()
        agent.skills["fixture"].body = "long instruction " * 1000
        with patch.object(agent, "context_size", return_value=2000), patch.object(agent.client, "chat") as chat:
            with self.assertRaises(ValueError):
                agent.run_turn("$fixture Inspect behavior")
            chat.assert_not_called()
        self.assertFalse(agent._accepting_steer)
        self.assertFalse(agent._explicit_skill_instructions)

    def test_delegated_skill_context_uses_the_same_credential_redaction_boundary(self):
        agent = self.agent()
        credential = "sk-proj-composerFixtureCredential12345"
        agent.config.data["api_key"] = credential
        agent.skills["fixture"].body = "Recorded credential: " + credential
        observed = []
        agent.run_external_turn("$fixture Inspect", lambda text: observed.append(text) or
                                {"ok": True, "text": "done", "rc": 0})
        self.assertNotIn(credential, observed[0])
        self.assertIn("[REDACTED]", observed[0])
