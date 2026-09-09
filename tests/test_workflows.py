"""Workflow controllers preserve inputs and validate before changing mode or starting a turn."""
from __future__ import annotations

import copy
from pathlib import Path
import tempfile
import threading
import types
import unittest

from dgc.agent import Agent
from dgc.cli import CLI
from dgc.commands import editor_command_metadata, command_specs
from dgc.config import Config, DEFAULTS
from dgc.editor_context import _format_editor_context
from dgc.editor_protocol import command_error, event_error
from dgc.headless import Backend
from dgc.tui import TUI
from dgc.workflows import activate_workflow, display_prompt, expand_workflow_prompt, prepare_workflow


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-workflows-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        config = object.__new__(Config)
        config.project_root, config.project_dir = self.root, self.root / ".dgc"
        config._persist = False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys = {}, set()
        config._explicit_keys = set()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.messages = []
        class UI:
            def __getattr__(_self, name):
                return lambda *args, **kwargs: self.messages.append((name, args))
        self.agent = Agent(config, UI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.events, self.started = [], []
        self.backend = object.__new__(Backend)
        self.backend.agent, self.backend.config = self.agent, config
        self.backend.workspace_trusted = True
        self.backend.em = types.SimpleNamespace(emit=lambda kind, **kw: self.events.append({"type": kind, **kw}))
        self.backend._busy = lambda: False
        self.backend._start_turn = lambda text, images, context: (
            self.started.append((self.agent.mode, text, images, context)) or ("started", 0))

    def test_catalog_and_review_targets(self):
        for surface in ("classic", "tui", "editor"):
            self.assertTrue({"plan", "review", "init"} <= {row.name for row in command_specs(surface)})
        actions = {row["action"] for row in editor_command_metadata()}
        self.assertTrue({"workflow:plan", "workflow:review", "workflow:init"} <= actions)
        for args, view in (("", "uncommitted"), ("--base main focus", "base"),
                           ("--commit HEAD~1", "commit"), ("--staged focus", "staged"),
                           ("--working", "working")):
            workflow = prepare_workflow("review", args, self.agent)
            self.assertIn('"view": "' + view + '"', workflow.prompt)
            self.assertEqual(workflow.mode, "plan")
            self.assertIn("file and line", workflow.prompt)
            self.assertEqual(self.agent.mode, "auto", "preparation is not a state mutation")
        for args in ("--base", "--commit --output=oops", "--unknown", "--base " + "x" * 513):
            with self.assertRaises(ValueError):
                prepare_workflow("review", args, self.agent)

    def test_headless_complete_payload_and_rejections_before_mode_change(self):
        context = [{"type": "mcp_context", "server": "docs", "uri": "docs://item", "text": "inert $not-a-skill"}]
        request = {"type": "prompt", "workflow": "review", "text": "Focus on retry behavior",
                   "request_id": "review-1", "skills": ["verify"], "context": context}
        self.assertIsNone(command_error(request))
        self.backend.dispatch(request)
        self.assertEqual(len(self.started), 1)
        mode, text, _, sent_context = self.started[0]
        self.assertEqual(mode, "plan")
        self.assertIn("$verify", text)
        self.assertIn("Focus on retry behavior", text)
        self.assertEqual(sent_context, context)
        self.assertTrue(any(e["type"] == "prompt_accepted" and e["request_id"] == "review-1" for e in self.events))
        for event in self.events:
            self.assertIsNone(event_error({"seq": 1, **event}))
        for change in ({"skills": ["missing-skill"]}, {"text": "--base"}, {"images": ["invalid"]},
                       {"workflow": "plan", "text": ""}):
            self.agent.set_mode("auto")
            self.events.clear()
            self.backend.dispatch({**request, **change})
            self.assertEqual(self.agent.mode, "auto")
            self.assertEqual(len(self.started), 1)
            self.assertEqual(self.events[-1]["type"], "command_rejected")
        self.agent.goal, self.agent.goal_status = "Retain this goal", "active"
        self.backend.dispatch(request)
        self.assertIn("Pause the current goal", self.events[-1]["message"])
        self.assertEqual(self.agent.goal, "Retain this goal")
        self.agent.goal_status = "paused"
        self.backend._worker = object()
        self.backend.dispatch(request)
        self.assertEqual(self.events[-1]["reason"], "turn_in_progress")
        self.assertEqual(self.agent.mode, "auto")

    def test_removed_skill_is_rejected_from_fresh_catalog_before_workflow_activation(self):
        path = self.root / ".dgc/skills/review-fixture/SKILL.md"
        path.parent.mkdir(parents=True)
        path.write_text("---\nname: review-fixture\ndescription: Review fixture\n---\nRead the fixture.")
        self.agent.reload_skills()
        self.assertIn("review-fixture", self.agent.skills)
        path.unlink()
        self.backend.dispatch({"type": "prompt", "workflow": "review", "text": "Inspect",
                               "skills": ["review-fixture"], "request_id": "deleted-skill"})
        self.assertFalse(self.started)
        self.assertEqual(self.agent.mode, "auto")
        self.assertEqual(self.events[-1]["reason"], "invalid_selection")
        self.assertEqual(self.events[-1]["request_id"], "deleted-skill")

    def test_native_and_delegated_review_retain_read_only_mode_and_inert_context(self):
        self.agent.goal, self.agent.goal_status = "$removed-goal-skill\n\nResume later", "paused"
        workflow = prepare_workflow("review", "--base main", self.agent)
        activate_workflow(workflow, self.agent)
        schemas = {row["function"]["name"] for row in self.agent._tool_schemas()}
        self.assertIn("git_diff", schemas)
        self.assertTrue({"bash", "write_file", "python", "mcp_call"}.isdisjoint(schemas))
        observed = []
        self.agent._run_turn = lambda text: observed.append((text, self.agent.mode, dict(self.agent._explicit_skill_instructions))) or True
        reference = _format_editor_context([{"type": "mcp_context", "text": "$missing-private-skill", "server": "docs"}])
        self.assertTrue(self.agent.run_turn(reference + workflow.prompt))
        self.assertEqual(observed[0][1], "plan")
        self.assertIn("$missing-private-skill", observed[0][0])
        self.assertNotIn("missing-private-skill", observed[0][2])
        delegated = []
        result = self.agent.run_external_turn(reference + workflow.prompt,
            lambda prompt: delegated.append((prompt, self.agent.mode)) or {"ok": True, "text": "No findings"})
        self.assertTrue(result["ok"])
        self.assertIn("first-parent to commit", delegated[0][0])
        self.assertEqual(delegated[0][1], "plan")

    def test_subscription_restrictions_and_init_respect_current_permissions(self):
        self.agent.config.data["subscription_engine"] = "kimi"
        with self.assertRaisesRegex(ValueError, "Kimi"):
            prepare_workflow("review", "", self.agent)
        self.assertEqual(prepare_workflow("init", "", self.agent).mode, "auto")
        self.agent.config.data["subscription_engine"] = ""
        self.agent.set_mode("plan")
        existing = self.root / "DGC.md"
        existing.write_text("Keep human guidance")
        workflow = prepare_workflow("init", "Include deployment conventions", self.agent)
        activate_workflow(workflow, self.agent)
        self.assertIn("Preserve useful human-authored guidance", workflow.prompt)
        self.assertIn("normal plan approval", workflow.prompt)
        self.assertEqual(existing.read_text(), "Keep human guidance")
        self.assertEqual(self.agent.mode, "plan")

    def test_workflow_history_preserves_user_command_and_expands_mentions_once(self):
        request = '--base main Inspect @retry.py and $verify'
        prepared = prepare_workflow("review", request, self.agent).prompt
        calls = []
        expanded = expand_workflow_prompt(prepared, lambda body: calls.append(body) or body.replace("@retry.py", "CAPTURED_FILE"))
        self.assertEqual(len(calls), 1)
        self.assertNotIn("<dgc-workflow-json>", calls[0])
        self.assertEqual(expanded.count("CAPTURED_FILE"), 1)
        self.assertEqual(display_prompt(expanded), "/review " + request)
        self.agent.messages.append({"role": "user", "content": "$verify\n\n" + expanded})
        self.assertEqual(self.backend._history()[-1]["text"], "$verify\n\n/review " + request)
        self.assertIn("Return findings first", self.agent.messages[-1]["content"])
        self.assertEqual(display_prompt("ordinary prefix\n" + prepared), "ordinary prefix\n" + prepared)
        self.assertEqual(display_prompt("<dgc-workflow-json>\ninvalid\n</dgc-workflow-json>\n\nbody"),
                         "<dgc-workflow-json>\ninvalid\n</dgc-workflow-json>\n\nbody")

    def test_classic_and_tui_dispatch_use_shared_workflows_without_placeholder_writes(self):
        classic = object.__new__(CLI)
        classic.config, classic.agent, classic.ui = self.agent.config, self.agent, self.agent.ui
        classic.expand_mentions = lambda text: text
        prompts = []
        classic._run_turn_live = lambda text, queue: prompts.append(("classic", text, self.agent.mode))
        self.assertTrue(classic.handle_slash("/plan"))
        self.assertEqual(self.agent.mode, "plan")
        self.assertEqual(prompts, [])
        classic.handle_slash("/review --staged focus")
        classic.handle_slash("/init Keep existing conventions")
        self.assertEqual([p[0] for p in prompts], ["classic", "classic"])
        self.assertIn('"view": "staged"', prompts[0][1])
        self.assertFalse((self.root / "DGC.md").exists())
        tui = object.__new__(TUI)
        tui._sessions, tui._active_idx, tui._tls = [types.SimpleNamespace()], 0, threading.local()
        tui.config, tui.agent = self.agent.config, self.agent
        tui._flash = lambda *args: None
        tui.app = None
        tui._submit = lambda text: prompts.append(("tui", text, self.agent.mode))
        tui._turn = threading.Event()
        self.assertEqual(tui._dispatch_composer_text("Review retries /review"), "command")
        self.assertIn("Review retries", prompts[-1][1])
        self.assertTrue(tui._handle_slash("/init Include tests"))
        self.assertIn("Include tests", prompts[-1][1])
        self.assertFalse((self.root / "DGC.md").exists())


if __name__ == "__main__":
    unittest.main()
