"""A turn's cost cap is counted in tokens, and the turn that asked for work pays for it.

Tokens rather than requests or wall-clock, because tokens are what the user is billed and what a
local GPU actually spends; `turn_budget_s` stays as the secondary control, for a turn that HANGS,
which no token count can see.

The property that needed building rather than measuring is attribution. A detached sub-agent
outlives the turn that started it: its generations arrive minutes later, and a ledger read at the
root when they land would charge them to whatever turn happens to be running then. The turn that
asked for the work would look free, and the cap would fire on an innocent later turn. So the turn id
travels UP with the usage rollup instead of being read at the top.

The cap is admission-only and never rolls anything back: tokens already spent bought the edits on
disk, and discarding them spends the budget for nothing.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.agent import Agent                                           # noqa: E402
from dgc.llm import ChatResult, ToolCall                              # noqa: E402
from dgc.config import Config, DEFAULTS                               # noqa: E402


class _UI:
    def __init__(self) -> None:
        self.denied: list[tuple] = []
        self.info_lines: list[str] = []

    def tool_denied(self, name, args, reason, call_id=None):
        self.denied.append((name, reason))

    def info(self, message):
        self.info_lines.append(str(message))

    def __getattr__(self, _name):
        return lambda *a, **kw: None


def agent(budget: int = 0, ui: _UI | None = None) -> Agent:
    config = Config(project_root=Path(tempfile.mkdtemp(prefix="dgc-budget-")))
    # In memory only, never persisted: constructing an Agent otherwise connects whatever MCP
    # servers the machine running the suite happens to have.
    config.data["mcp_servers"] = {}
    config.data["disabled_mcp_servers"] = []
    config.data["turn_token_budget"] = budget
    return Agent(config, ui or _UI())


def spend(target: Agent, tokens: int) -> None:
    """One generation's worth of usage, recorded the way a real provider reply records it."""
    target._record_usage({"prompt_tokens": tokens, "completion_tokens": 0}, "user_turn")


class TheDefaultIsNoCapTest(unittest.TestCase):
    def test_off_by_default(self) -> None:
        self.assertEqual(DEFAULTS["turn_token_budget"], 0)
        root = agent()
        spend(root, 10_000_000)
        self.assertFalse(root.turn_budget_exceeded(),
                         "a user who set no budget must never be stopped by one")

    def test_a_malformed_setting_is_not_a_cap(self) -> None:
        root = agent()
        root.config.data["turn_token_budget"] = "lots"
        self.assertEqual(root.turn_token_budget(), 0)
        spend(root, 5_000)
        self.assertFalse(root.turn_budget_exceeded())


class SpendIsCountedPerTurnTest(unittest.TestCase):
    def test_tokens_accumulate_within_a_turn(self) -> None:
        root = agent(1_000)
        spend(root, 400)
        self.assertEqual(root.turn_tokens_spent(), 400)
        spend(root, 400)
        self.assertEqual(root.turn_tokens_spent(), 800)
        self.assertFalse(root.turn_budget_exceeded())
        spend(root, 200)
        self.assertTrue(root.turn_budget_exceeded(), "at the budget, not past it")

    def test_a_new_turn_starts_from_zero(self) -> None:
        root = agent(1_000)
        spend(root, 1_500)
        self.assertTrue(root.turn_budget_exceeded())
        root._budget_turn += 1                      # what the start of a foreground turn does
        self.assertEqual(root.turn_tokens_spent(), 0)
        self.assertFalse(root.turn_budget_exceeded(),
                         "a cap is per turn; the previous turn's spend must not carry")

    def test_an_empty_usage_envelope_costs_nothing(self) -> None:
        root = agent(1_000)
        root._record_usage(None, "user_turn")
        root._record_usage({}, "user_turn")
        self.assertEqual(root.turn_tokens_spent(), 0)

    def test_the_ledger_does_not_grow_without_bound(self) -> None:
        """A session runs for as long as the user keeps the window open."""
        root = agent(1_000)
        for _ in range(200):
            root._budget_turn += 1
            spend(root, 10)
        self.assertLessEqual(len(root._turn_token_spend), Agent._TURN_LEDGER_KEEP)
        self.assertEqual(root.turn_tokens_spent(), 10, "the current turn is always one of the kept")


class ASubAgentsTokensAreChargedToTheTurnThatAskedTest(unittest.TestCase):
    def child_of(self, root: Agent) -> Agent:
        """Wired the way `_execute_prepared_subagent` wires a delegated child."""
        sub = agent()
        sub._metrics_parent = root
        sub._budget_turn = root._budget_turn
        sub.depth = root.depth + 1
        return sub

    def test_a_childs_spend_counts_against_its_parents_turn(self) -> None:
        root = agent(1_000)
        sub = self.child_of(root)
        spend(sub, 900)
        self.assertEqual(root.turn_tokens_spent(), 900,
                         "delegating is not a way to spend outside the cap")
        self.assertFalse(root.turn_budget_exceeded())
        spend(sub, 100)
        self.assertTrue(root.turn_budget_exceeded())

    def test_a_grandchild_is_charged_too(self) -> None:
        root = agent(1_000)
        grandchild = self.child_of(self.child_of(root))
        spend(grandchild, 1_000)
        self.assertEqual(root.turn_tokens_spent(), 1_000,
                         "nesting must not launder a sub-agent's cost")

    def test_one_generation_is_charged_once(self) -> None:
        """The rollup visits every ancestor; only the root keeps the ledger."""
        root = agent(1_000)
        grandchild = self.child_of(self.child_of(root))
        spend(grandchild, 300)
        self.assertEqual(root.turn_tokens_spent(), 300,
                         "charging at each level would bill a three-deep tree three times")

    def test_a_detached_child_still_pays_into_the_turn_that_started_it(self) -> None:
        """THE attribution property. A detached child answers after its turn has ended."""
        root = agent(1_000)
        sub = self.child_of(root)
        root._budget_turn += 1                      # the user sent another prompt meanwhile
        spend(sub, 5_000)                           # ...and only now does the child report
        self.assertEqual(root.turn_tokens_spent(), 0,
                         "the new turn has spent nothing and must not be capped for old work")
        self.assertFalse(root.turn_budget_exceeded())
        self.assertEqual(root._turn_token_spend.get(sub._budget_turn), 5_000,
                         "the turn that asked for the work is the one charged")


class TheCapRefusesNewWorkAndKeepsFinishedWorkTest(unittest.TestCase):
    def test_a_task_is_refused_once_the_budget_is_spent(self) -> None:
        ui = _UI()
        root = agent(1_000, ui)
        root._offered_tool_names = {"task"}
        spend(root, 1_000)
        answer = root._handle_call(
            ToolCall("c1", "task", {"description": "more work", "prompt": "go"}))
        self.assertIn("budget", answer)
        self.assertEqual([name for name, _ in ui.denied], ["task"],
                         "the refusal is shown to the user, not just returned to the model")

    def test_the_refusal_says_how_to_lift_it(self) -> None:
        root = agent(1_000)
        spend(root, 1_200)
        refusal = root.turn_budget_refusal()
        self.assertIn("turn_token_budget", refusal)
        self.assertIn("1,200", refusal)
        self.assertIn("1,000", refusal)

    def test_a_task_is_admitted_while_the_budget_holds(self) -> None:
        ui = _UI()
        root = agent(1_000, ui)
        root._offered_tool_names = {"task"}
        spend(root, 999)
        self.assertFalse(root.turn_budget_exceeded())
        self.assertEqual(ui.denied, [])

    def test_an_uncapped_turn_is_never_refused(self) -> None:
        root = agent(0)
        spend(root, 10_000_000)
        self.assertFalse(root.turn_budget_exceeded())

    def batch_agent(self, budget: int) -> Agent:
        """A root the parallel batch path will actually accept: Git-backed, auto mode, 2+ workers."""
        root = agent(budget)
        where = Path(root.config.project_root)
        for command in (["git", "init", "-q", "."], ["git", "config", "user.email", "t@t"],
                        ["git", "config", "user.name", "t"]):
            subprocess.run(command, cwd=where, check=True, capture_output=True)
        (where / "a.txt").write_text("a\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=where, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=where, check=True, capture_output=True)
        root.config.data["mode"] = "auto"
        return root

    BATCH = [ToolCall("a", "task", {"description": "one", "prompt": "go"}),
             ToolCall("b", "task", {"description": "two", "prompt": "go"})]

    def prepared_count(self, root: Agent) -> int:
        """How many worktrees the batch path got as far as asking for."""
        prepared = []
        from dgc import worktree

        def stub(cls, *args, **kwargs):
            prepared.append(1)
            return None, "stubbed"

        with mock.patch.object(worktree.TaskWorkspace, "prepare", classmethod(stub)):
            root._parallel_task_outputs(list(self.BATCH))
        return len(prepared)

    def test_the_premise_a_batch_is_admitted_while_the_budget_holds(self) -> None:
        """Without this the refusal below could be any of the batch path's other gates."""
        self.assertEqual(self.prepared_count(self.batch_agent(1_000)), 2)

    def test_a_parallel_task_batch_is_refused_past_the_budget(self) -> None:
        """The batch path never reaches `_handle_call`, so it needs its own check. Falling back
        to the serial path is what gives each call its own visible refusal row."""
        root = self.batch_agent(1_000)
        spend(root, 1_000)
        self.assertEqual(self.prepared_count(root), 0)


class ARealTurnStopsAtTheCapWithoutLosingWorkTest(unittest.TestCase):
    """Driven through `run_turn` itself, with only the provider call stubbed."""

    def turn(self, budget: int, per_request: int, rounds: int = 20):
        ui = _UI()
        root = agent(budget, ui)
        marker = Path(root.config.project_root) / "written-by-the-turn.txt"
        marker.write_text("kept\n", encoding="utf-8")
        seen = {"chat": 0, "restore": 0}

        def fake_chat(*_args, **_kwargs):
            seen["chat"] += 1
            spend(root, per_request)
            if seen["chat"] >= rounds:
                return ChatResult(content="done", tool_calls=[])
            return ChatResult(content="", tool_calls=[
                ToolCall(f"c{seen['chat']}", "bash", {"command": "true"})])

        def fake_restore(*_args, **_kwargs):
            seen["restore"] += 1
            return True

        root._chat = fake_chat
        root._restore_snapshot = fake_restore
        completed = root.run_turn("do the thing")
        return root, ui, seen, marker, completed

    def test_the_turn_stops_once_the_budget_is_spent(self) -> None:
        root, _ui, seen, _marker, completed = self.turn(1_000, 600)
        self.assertFalse(completed)
        self.assertEqual(seen["chat"], 2, "one more request past the budget is one too many")
        self.assertIn("1,000-token budget", root._last_turn_error)

    def test_nothing_the_turn_did_is_rolled_back(self) -> None:
        """The time limit restores the last green state; the token cap must NOT.

        Out of time a kill is coming and the restore is how the user keeps any credit. Out of
        tokens nothing is going to kill anything, and the edits on disk were already paid for.
        """
        _root, ui, seen, marker, _completed = self.turn(1_000, 600)
        self.assertEqual(seen["restore"], 0)
        self.assertEqual(marker.read_text(encoding="utf-8"), "kept\n")
        self.assertTrue(any("every change made is kept" in line for line in ui.info_lines),
                        ui.info_lines)

    def test_the_next_turn_starts_with_a_clean_budget(self) -> None:
        """Through `run_turn` twice, because advancing the turn is `run_turn`'s job."""
        ui = _UI()
        root = agent(1_000, ui)
        seen = {"chat": 0}

        def fake_chat(*_args, **_kwargs):
            seen["chat"] += 1
            spend(root, 1_200)
            return ChatResult(content="done", tool_calls=[])

        root._chat = fake_chat
        root.run_turn("first")
        self.assertTrue(root.turn_budget_exceeded())
        root.run_turn("second")
        self.assertEqual(seen["chat"], 2,
                         "the second turn must get its own budget, not inherit an exhausted one")

    def test_an_uncapped_turn_runs_to_its_own_end(self) -> None:
        """The premise: the stop above is the budget's doing, not the stub running out."""
        root, _ui, seen, _marker, completed = self.turn(0, 600, rounds=5)
        self.assertEqual(seen["chat"], 5)
        self.assertTrue(completed)
        self.assertEqual(root._last_turn_error, "")


if __name__ == "__main__":
    unittest.main()
