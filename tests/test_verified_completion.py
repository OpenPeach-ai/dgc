"""Green checks must leave the model able to complete the rest of the request."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.llm import ChatResult, ToolCall


class VerifiedCompletionTests(unittest.TestCase):
    def agent(self, *, configured=False, opt_in=False):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-completion-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = root, root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                        hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                        turn_budget_s=60, max_turns=8, thinking="off", finish_on_verified=opt_in,
                        verify_before_done=configured, verify_command="test -f answer.txt" if configured else "")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        class UI:
            def __getattr__(self, _name):
                return lambda *args, **kwargs: None
        agent = Agent(cfg, UI())
        self.addCleanup(agent.mcp.stop_all)
        return agent, root

    def complete(self, agent, root, prompt, *, goal=False, deterministic=False):
        calls = []
        def chat(messages, **kwargs):
            calls.append(kwargs.get("tools"))
            if len(calls) == 1:
                return ChatResult(tool_calls=[
                    ToolCall("edit", "write_file", {"path": "answer.txt", "content": "answer\n"}),
                    ToolCall("test", "bash", {"command": "test -f answer.txt" if agent.config.get("verify_command")
                                             else "python3 -m unittest"})])
            if len(calls) == 2:
                return ChatResult(tool_calls=[ToolCall("notes", "write_file", {
                    "path": "NOTES.md", "content": "Required work after the passing check.\n"})])
            if goal and len(calls) == 3:
                return ChatResult(tool_calls=[ToolCall("goal", "update_goal", {
                    "status": "completed", "summary": "Answer and notes complete", "evidence": ["Observed passing check and saved notes"]})])
            kwargs["on_text"]("Completed the answer and the required notes.")
            return ChatResult(content="Completed the answer and the required notes.")
        with patch.object(agent.client, "chat", side_effect=chat):
            self.assertTrue(agent.run_turn(prompt))
        self.assertTrue(all(calls), "remaining work must retain tools")
        self.assertTrue((root / "NOTES.md").exists())
        if deterministic:
            self.assertIn("Implemented and verified", agent.messages[-1]["content"])
            self.assertEqual(len(calls), 2)
        else:
            self.assertEqual(agent.messages[-1]["content"], "Completed the answer and the required notes.")
            self.assertEqual(len(calls), 4 if goal else 3)

    def test_default_timed_turn_continues_after_ad_hoc_or_configured_green_check(self):
        for configured, opt_in in ((False, False), (True, False), (False, True), (True, "false")):
            with self.subTest(configured=configured, opt_in=opt_in):
                agent, root = self.agent(configured=configured, opt_in=opt_in)
                self.complete(agent, root, "Write an answer, test it, then add the required notes.")

    def test_selected_skill_and_active_goal_never_use_verifier_only_closeout(self):
        for goal, skill in ((False, True), (True, False), (True, True)):
            with self.subTest(goal=goal, skill=skill):
                agent, root = self.agent(configured=True, opt_in=True)
                selected = root / ".dgc/skills/contract-check/SKILL.md"
                selected.parent.mkdir(parents=True)
                selected.write_text("---\nname: contract-check\ndescription: Follow the selected verification contract\n---\nWrite NOTES.md after tests pass.\n")
                prompt = ("Write and test the answer, then follow $contract-check." if skill else
                          "Write and test the answer, then write the required notes.")
                agent.reload_skills()
                if goal:
                    self.assertTrue(agent.set_goal(prompt))
                self.complete(agent, root, prompt, goal=goal)
                if goal:
                    self.assertEqual(agent.goal_snapshot()["status"], "completed")
                    self.assertEqual(agent.goal_snapshot()["cycles"], 1)

    def test_pending_todos_prevent_opted_in_closeout(self):
        agent, root = self.agent(configured=True, opt_in=True)
        agent.ctx.todos = [{"content": "Required note", "status": "pending"}]
        # The scripted model explicitly satisfies the pending work before its final response.
        original = agent._handle_call
        def handle(call):
            result = original(call)
            if call.id == "notes":
                agent.ctx.todos[0]["status"] = "done"
            return result
        with patch.object(agent, "_handle_call", side_effect=handle):
            self.complete(agent, root, "Write and test the answer, then complete the pending note.", deterministic=True)

    def test_cancel_between_sequential_tools_is_failure_and_does_not_run_the_second(self):
        agent, root = self.agent()
        original = agent._handle_call
        def cancel_after_first(call):
            output = original(call)
            agent.cancelled.set()
            return output
        result = ChatResult(tool_calls=[ToolCall("first", "write_file", {"path": "first.txt", "content": "saved"}),
                                       ToolCall("second", "write_file", {"path": "second.txt", "content": "must not run"})])
        with patch.object(agent.client, "chat", return_value=result), \
                patch.object(agent, "_handle_call", side_effect=cancel_after_first):
            self.assertFalse(agent.run_turn("Write the two files"))
        self.assertTrue((root / "first.txt").exists())
        self.assertFalse((root / "second.txt").exists())


if __name__ == "__main__":
    unittest.main()
