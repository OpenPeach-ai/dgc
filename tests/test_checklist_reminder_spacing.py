"""The "Checklist still open" reminder: after the first step with no checklist update, then every third one (live, 20
Nov: after every step, ~200 times in one session, it cost tokens and the model read past it). A `todo` call resets it."""
import tempfile
import unittest
from pathlib import Path

from dgc.llm import ChatResult, ToolCall
from tests.test_goal_turns import agent_in


def Call(n, name="read_file", arguments=None):
    return ToolCall(f"c{n}", name, arguments or {"path": f"f{n}.txt"})


def Result(calls=None, content=""):
    return ChatResult(content=content, tool_calls=calls or [])


class Steps:
    tools_supported = True

    def __init__(self, calls):
        self.calls, self.n, self.seen = calls, 0, []

    def chat(self, messages, *args, **kwargs):
        self.seen.append(sum("Checklist still open" in str(m.get("content", "")) for m in messages))
        self.n += 1
        return Result([self.calls[self.n - 1]]) if self.n <= len(self.calls) else Result(content="Done.")


class Spacing(unittest.TestCase):
    def run_steps(self, calls):
        directory = tempfile.TemporaryDirectory(prefix="dgc-checklist-spacing-")
        self.addCleanup(directory.cleanup)
        agent = agent_in(Path(directory.name))
        self.addCleanup(agent.mcp.stop_all)
        agent.ctx.todos = [{"content": "Build the overview", "status": "in_progress"}]
        agent._handle_call = lambda call: "ok"
        agent.client = Steps(calls)
        agent.run_turn("build the overview")
        return agent.client.seen

    def test_the_reminder_comes_after_the_first_step_then_every_third(self):
        seen = self.run_steps([Call(n) for n in range(1, 8)])
        added = [b - a for a, b in zip(seen, seen[1:])]
        self.assertEqual([i + 1 for i, d in enumerate(added) if d], [1, 3, 6], added)

    def test_a_checklist_update_starts_the_count_again(self):
        calls = [Call(1), Call(2), Call(3, "todo", {"todos": [{"content": "Build the overview", "status": "in_progress"}]}),
                 Call(4), Call(5), Call(6)]
        seen = self.run_steps(calls)
        added = [b - a for a, b in zip(seen, seen[1:])]
        self.assertEqual([i + 1 for i, d in enumerate(added) if d], [1, 4, 6], added)


if __name__ == "__main__":
    unittest.main()
