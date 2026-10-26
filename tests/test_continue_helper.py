"""A finished helper continued with its memory (dgc/helper_memory.py).

The founder (25 Oct): the coordinator sent follow-up work to helpers that had FINISHED, and each one resumed with its
memory: a study, then six fixes, then a follow-up fix, then a feature, without re-learning the code. DGC could not:
`message_task` reaches only a background helper still running, so a follow-up was a fresh helper reading everything
again. Now the model (`continue_task`), the person ("Ask it to do more", the editor's `continue_agent`) and the
terminal (`/agents continue <id> <text>`) can give a finished helper more work. It resumes from its saved
conversation, in a fresh copy of the project as it is now, told what changed since its run ended; a long conversation
is compacted first; it keeps its one row in the agent map, with its runs.

Real git, a real Agent and its real isolation (worktrees, integration, recovery points), scripted models.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dgc import editor_protocol as ep                                # noqa: E402
from dgc import helper_memory, sessions                               # noqa: E402
from dgc.agent import Agent                                           # noqa: E402
from dgc.config import Config                                         # noqa: E402
from dgc.headless import Backend, HeadlessUI                          # noqa: E402
from dgc.llm import ChatResult, LLMClient, ToolCall                   # noqa: E402
from dgc.protocol import PendingRequests                              # noqa: E402
from test_subagents import Harness, HarnessCase, Script, clone_fixture, fixture_config, git_repo  # noqa: E402

BILLING = ('def total(lines):\n'
           '    result = 0\n'
           '    for quantity, unit_price in lines:\n'
           '        result += round(quantity * unit_price)\n'
           '    return result\n')
FIXED = BILLING.replace("result += round(quantity * unit_price)", "result += quantity * unit_price")
FINDING = "FINDING-1: total() rounds each line instead of rounding the sum once."


def git(root: Path, *args) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def commit(root: Path, files: dict) -> None:
    for name, text in files.items():
        (root / name).write_text(text)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "fixture")


def last_user(messages) -> tuple[int, str]:
    for index in range(len(messages) - 1, -1, -1):
        if messages[index].get("role") == "user":
            return index, re.sub(r"\n\n<dgc-now>.*?</dgc-now>$", "", str(messages[index].get("content") or ""),
                                 flags=re.S)
    return -1, ""


def system_root(messages) -> Path:
    found = re.search(r"Project root \(cwd for all tools\): (.+)", str(messages[0].get("content")))
    assert found, "no project root line in the system prompt"
    return Path(found.group(1).strip())


class Turns:
    """One scripted model for several turns: each turn's last user message picks its script, whose first reply
    makes `calls` (a list, or a function of the messages) and whose second ends with `final`. Keeps what each turn's
    request carried and the tool results it got."""

    def __init__(self):
        self.scripts: list[tuple[str, object, str]] = []
        self.seen: dict[str, list] = {}
        self.results: dict[str, list[str]] = {}

    def on(self, needle: str, calls, final: str = "done") -> "Turns":
        self.scripts.append((needle, calls, final))
        return self

    def __call__(self, messages, _results, cancel):
        index, text = last_user(messages)
        for needle, calls, final in self.scripts:
            if needle in text:
                break
        else:
            raise AssertionError(f"no script for {text[:120]!r}")
        done = [m for m in messages[index + 1:] if m.get("role") == "tool"]
        self.seen.setdefault(needle, []).append(list(messages))
        if not done:
            made = calls(messages) if callable(calls) else calls
            if made:
                return ChatResult(tool_calls=list(made))
            return ChatResult(content=final)
        self.results[needle] = [str(m.get("content") or "") for m in done]
        return ChatResult(content=final)


class Case(HarnessCase):
    def make_repo(self, **config):
        h = self.make(git=True, mode=config.pop("mode", "auto"), **config)
        self.addCleanup(shutil.rmtree, h.root.parent / (h.root.name + "-worktrees"), True)
        commit(h.root, {"billing.py": BILLING, "notes.txt": "one\n"})
        return h

    def turn(self, h, prompt, parent: Turns, helper: Turns):
        with patch.object(LLMClient, "chat", Script([("PARENT", parent), ("REVIEWER", helper)])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.ui.turn_id = f"t-{prompt[:8]}"
            h.ui.reset_turn_messages()
            return h.agent.run_turn(prompt)

    def review(self, h, parent: Turns, helper: Turns, *, background=False) -> str:
        """Turn 1: the parent delegates a review of billing.py; the helper reads it and reports FINDING-1."""
        parent.on("PARENT review", [ToolCall("t1", "task", {
            "description": "Review billing.py", "prompt": "REVIEWER: review billing.py for bugs",
            **({"background": True} if background else {})})], "reviewed")
        helper.on("REVIEWER: review", [ToolCall("r1", "read_file", {"path": "billing.py"})], FINDING)
        self.assertTrue(self.turn(h, "PARENT review", parent, helper))
        items = h.agent.subagents.snapshot()["items"]
        self.assertEqual(len(items), 1)
        return items[0]["id"]

    @staticmethod
    def fix(messages):
        return [ToolCall("w1", "edit_file", {"path": "billing.py",
                                             "old_string": "result += round(quantity * unit_price)",
                                             "new_string": "result += quantity * unit_price"})]


# --------------------------------------------------------------------------------------- the model ---
class TheModelContinuesAFinishedHelperTest(Case):
    def test_it_resumes_from_its_transcript_in_a_fresh_copy_told_what_changed_and_its_work_lands(self):
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        first = helper.seen["REVIEWER: review"][0]
        first_copy = system_root(first)
        self.assertFalse(first_copy.exists(), "its first copy was integrated (nothing to land) and removed")
        self.assertIn(f"This helper's id is {agent_id}", parent.results["PARENT review"][0],
                      "the parent is told the id it can continue")
        self.assertEqual(helper_memory.ids(h.agent), {agent_id})

        (h.root / "notes.txt").write_text("one\ntwo\n")          # the person works on, between the runs
        parent.on("PARENT fix", [ToolCall("t2", "continue_task", {"id": agent_id, "text": "Fix FINDING-1."})],
                  "fixed")
        helper.on("[Continued", self.fix, "Fixed FINDING-1: it rounds the sum once now.")
        self.assertTrue(self.turn(h, "PARENT fix", parent, helper))

        context = helper.seen["[Continued"][0]
        # Its earlier messages are in its context: what it was asked, the file it read, what it found.
        roles = [m.get("role") for m in context]
        self.assertEqual(roles[:5], ["system", "user", "assistant", "tool", "assistant"], roles)
        self.assertIn("REVIEWER: review billing.py for bugs", str(context[1]["content"]))
        self.assertIn("round(quantity * unit_price)", str(context[3]["content"]), "the file it read")
        self.assertEqual(context[4]["content"], FINDING)
        _, note = last_user(context)
        self.assertTrue(note.startswith("[Continued — the main agent asked you to do more.]"), note)
        self.assertIn("Changed in the project since you last worked on it (1 file): notes.txt.", note)
        self.assertIn("Your earlier view of the code may be stale: re-read a file before you edit it.", note)
        self.assertTrue(note.endswith("The request:\nFix FINDING-1."), note)
        # A fresh copy of the project as it is now, named by its brief and its system prompt.
        second_copy = system_root(context)
        self.assertNotEqual(second_copy, first_copy)
        self.assertNotEqual(second_copy, h.root.resolve())
        self.assertIn(f"Your copy of the project is new: {second_copy}.", note)
        self.assertNotIn(str(first_copy), json.dumps(context[1:]), "its old copy's paths moved to the new one")
        # Its report and integration land, as any helper's.
        result = parent.results["PARENT fix"][0]
        self.assertTrue(result.startswith("Sub-task 'Review billing.py' completed and integrated 1 path(s): "
                                          "billing.py."), result)
        self.assertIn("Fixed FINDING-1", result)
        self.assertEqual((h.root / "billing.py").read_text(), FIXED)
        self.assertEqual((h.root / "notes.txt").read_text(), "one\ntwo\n", "the person's own change is untouched")
        # One row, the same helper, two runs; it can be continued again.
        items = h.agent.subagents.snapshot()["items"]
        self.assertEqual([item["id"] for item in items], [agent_id])
        self.assertEqual(items[0]["state"], "finished")
        self.assertGreaterEqual(items[0]["tool_calls"], 2, "its steps are counted across its runs")
        runs = helper_memory.runs_items(h.agent)
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["runs"], 2)
        self.assertTrue(runs[0]["continuable"])
        self.assertEqual([run["by"] for run in runs[0]["history"]], ["model", "model"])
        self.assertEqual(runs[0]["history"][1]["request"], "Fix FINDING-1.")
        self.assertIn("completed and integrated 1 path(s)", runs[0]["history"][1]["note"])
        # Undo takes the continued run's change back, as for any helper's integration.
        points = h.agent.checkpoints.points
        self.assertTrue(any("billing.py" in str(point.get("files") or {}) for point in points), points)
        h.agent.rewind(len(points) - 1)
        self.assertEqual((h.root / "billing.py").read_text(), BILLING)

    def test_its_next_change_to_a_file_it_landed_lands_too_and_a_file_the_person_changed_since_stays_theirs(self):
        # Found in real VS Code: a third run's fix to billing.py was held back as "already dirty before delegation"
        # when the only uncommitted change in it was the helper's own second run.
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        parent.on("PARENT fix", [ToolCall("t2", "continue_task", {"id": agent_id, "text": "Fix FINDING-1."})], "ok")
        helper.on("[Continued — the main agent asked you to do more.]", self.fix, "Fixed FINDING-1.")
        self.turn(h, "PARENT fix", parent, helper)
        self.assertEqual((h.root / "billing.py").read_text(), FIXED, "run 2 landed (uncommitted)")
        again = lambda messages: [ToolCall("w3", "edit_file", {"path": "billing.py", "old_string": "result = 0",  # noqa: E731
                                                              "new_string": "result = 0.0"})]
        parent.on("PARENT more", [ToolCall("t3", "continue_task", {"id": agent_id, "text": "Start the sum at 0.0."})],
                  "ok")
        helper.scripts.insert(0, ("Start the sum at 0.0.", again, "Done."))
        self.turn(h, "PARENT more", parent, helper)
        self.assertIn("completed and integrated 1 path(s): billing.py", parent.results["PARENT more"][0])
        self.assertEqual((h.root / "billing.py").read_text(), FIXED.replace("result = 0\n", "result = 0.0\n"))
        # The person changes billing.py after that: it is their uncommitted work now, and the standing rule holds.
        (h.root / "billing.py").write_text((h.root / "billing.py").read_text() + "# reviewed by the person\n")
        once = lambda messages: [ToolCall("w4", "edit_file", {"path": "billing.py", "old_string": "return result",  # noqa: E731
                                                             "new_string": "return result  # once"})]
        parent.on("PARENT last", [ToolCall("t4", "continue_task", {"id": agent_id, "text": "Mark the return."})], "ok")
        helper.scripts.insert(0, ("Mark the return.", once, "Marked."))
        self.turn(h, "PARENT last", parent, helper)
        self.assertIn("sub-agent changed files that were already dirty before delegation", parent.results["PARENT last"][0])
        self.assertTrue((h.root / "billing.py").read_text().endswith("# reviewed by the person\n"))
        self.assertNotIn("# once", (h.root / "billing.py").read_text())

    def test_its_steps_carry_the_run_so_a_second_run_never_lands_on_the_first_runs_cards(self):
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        parent.on("PARENT fix", [ToolCall("t2", "continue_task", {"id": agent_id, "text": "Fix it."})], "fixed")
        helper.on("[Continued", self.fix, "Fixed.")
        self.turn(h, "PARENT fix", parent, helper)
        calls = [f.get("call_id") for f in h.of("tool_call") if str(f.get("call_id") or "").startswith(agent_id)]
        self.assertIn(f"{agent_id}:r1", calls)
        self.assertIn(f"{agent_id}:r2-w1", calls)
        self.assertEqual([e.get("call_id") for e in h.agent.subagents.log_of(agent_id) if e["type"] == "tool_call"],
                         [f"{agent_id}:r1", f"{agent_id}:r2-w1"], "its page's step log keeps both runs, in order")

    def test_the_tool_is_offered_only_when_a_helper_can_be_continued(self):
        h = self.make_repo()
        names = lambda: {t["function"]["name"] for t in h.agent._tool_schemas()}      # noqa: E731
        self.assertNotIn("continue_task", names())
        parent, helper = Turns(), Turns()
        self.review(h, parent, helper)
        self.assertIn("continue_task", names())
        h.agent.set_mode("plan")
        self.assertNotIn("continue_task", names(), "Plan mode changes nothing")

    def test_a_running_helper_is_refused_and_an_unknown_one_names_those_that_can_be(self):
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        with self.assertRaises(helper_memory.Refused) as unknown:
            helper_memory.continue_helper(h.agent, "sub-000000000000", "more")
        self.assertEqual(unknown.exception.reason, "unknown_agent")
        self.assertIn(f"Helpers that can be continued: {agent_id} (Review billing.py).", str(unknown.exception))
        h.agent.subagents.reopen(agent_id, background=True)
        with self.assertRaises(helper_memory.Refused) as running:
            helper_memory.continue_helper(h.agent, agent_id, "more")
        self.assertEqual(running.exception.reason, "still_running")
        self.assertIn("message_task", str(running.exception))

    def test_by_its_description_or_the_start_of_its_id(self):
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        self.assertEqual(helper_memory.find(h.agent, "review billing.py"), agent_id)
        self.assertEqual(helper_memory.find(h.agent, agent_id[4:12]), agent_id)
        self.assertEqual(helper_memory.find(h.agent, agent_id), agent_id)


class ItIsAskedForLikeATaskTest(Case):
    def test_default_mode_asks_as_it_would_for_the_task_and_a_deny_rule_for_task_refuses_it(self):
        h = self.make_repo(mode="default")
        h.answer("permission_request", {"decision": "once"})
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        parent.on("PARENT fix", [ToolCall("t2", "continue_task", {"id": agent_id, "text": "Fix it."})], "fixed")
        helper.on("[Continued", lambda m: [], "nothing to do")
        self.turn(h, "PARENT fix", parent, helper)
        asked = [f for f in h.of("permission_request") if f.get("tool") == "continue_task"
                 or f.get("name") == "continue_task"]
        self.assertEqual(len(asked), 1, h.of("permission_request"))
        h.config.permissions["deny"] = ["Task(Review*)"]
        parent.on("PARENT again", [ToolCall("t3", "continue_task", {"id": agent_id, "text": "More."})], "ok")
        self.turn(h, "PARENT again", parent, helper)
        self.assertIn("PERMISSION DENIED: blocked by deny rule: Task(Review*)", parent.results["PARENT again"][0])
        self.assertEqual(helper_memory.runs_items(h.agent)[0]["runs"], 2, "the refused one never ran")


# ------------------------------------------------------------------------------------ isolation ---
class TheIsolationRulesStillApplyTest(Case):
    def test_its_write_into_the_users_checkout_is_refused_naming_its_own_copy(self):
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        user_file = h.root.resolve() / "billing.py"

        def write_theirs(messages):
            return [ToolCall("w9", "write_file", {"path": str(user_file), "content": "oops\n"})]
        parent.on("PARENT fix", [ToolCall("t2", "continue_task", {"id": agent_id, "text": "Fix it."})], "ok")
        helper.on("[Continued", write_theirs, "tried")
        self.turn(h, "PARENT fix", parent, helper)
        context = helper.seen["[Continued"][0]
        own = system_root(context)
        system = str(context[0]["content"])
        self.assertIn(f"This is your own copy of the user's project: {own}.", system)
        self.assertIn(f"The user's checkout, {h.root.resolve()}, is not yours to change", system)
        refusal = helper.results["[Continued"][0]
        self.assertTrue(refusal.startswith("error:"), refusal)
        self.assertIn(str(own / "billing.py"), refusal)
        self.assertEqual(user_file.read_text(), BILLING)


# ------------------------------------------------------------------------------- held back work ---
class AHeldBackHelperIsContinuedTest(Case):
    def test_it_gets_a_fresh_copy_and_its_held_back_diff_and_its_kept_worktree_stays_in_review(self):
        from dgc.worktree import list_retained
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        user = h.root / "billing.py"

        def edit_while_the_person_does_too(messages):
            # The person changes the same line in their checkout while the helper works on its copy.
            user.write_text(BILLING.replace("round(quantity * unit_price)", "round(quantity * unit_price, 2)"))
            return self.fix(messages)
        parent.on("PARENT review", [ToolCall("t1", "task", {
            "description": "Review billing.py", "prompt": "REVIEWER: review and fix billing.py"})], "ok")
        helper.on("REVIEWER: review", edit_while_the_person_does_too, "Fixed the rounding.")
        self.turn(h, "PARENT review", parent, helper)
        agent_id = h.agent.subagents.snapshot()["items"][0]["id"]
        self.assertIn("NOT integrated", parent.results["PARENT review"][0])
        configured = Path(h.config.get("subagent_worktree_root"))
        kept, _ = list_retained(h.root, configured)
        self.assertEqual(len(kept), 1)
        self.assertTrue(helper_memory.runs_items(h.agent)[0]["history"][0]["held"])

        # The person commits their change (a file with uncommitted work of theirs is never written by a helper's
        # integration, continued or not), then asks for the fix again on top of it.
        git(h.root, "commit", "-qam", "the person's rounding")
        parent.on("PARENT redo", [ToolCall("t2", "continue_task", {
            "id": agent_id, "text": "Redo your fix on top of the person's change."})], "ok")

        seen_copy = []

        def redo(messages):
            seen_copy.append((system_root(messages) / "billing.py").read_text())
            return [ToolCall("w2", "edit_file", {"path": "billing.py",
                                                 "old_string": "round(quantity * unit_price, 2)",
                                                 "new_string": "quantity * unit_price"})]
        helper.on("[Continued", redo, "Redone.")
        self.turn(h, "PARENT redo", parent, helper)
        context = helper.seen["[Continued"][0]
        _, note = last_user(context)
        self.assertIn("Your earlier changes were NOT applied to the project (held back", note)
        self.assertIn("This new copy does not have them: redo what is still needed here.", note)
        self.assertIn("-        result += round(quantity * unit_price)\n+        result += quantity * unit_price", note,
                      "its held-back change, as a diff")
        self.assertIn("Changed in the project since you last worked on it (1 file): billing.py.", note)
        new_copy = system_root(context)
        self.assertNotEqual(new_copy, Path(kept[0].path), "a fresh copy, not the kept worktree")
        self.assertIn("round(quantity * unit_price, 2)", seen_copy[0], "its copy holds the person's change")
        self.assertFalse(new_copy.exists(), "its new copy was integrated and removed")
        self.assertEqual(user.read_text(), FIXED)
        result = parent.results["PARENT redo"][0]
        self.assertIn("completed and integrated 1 path(s): billing.py", result)
        self.assertIn("Its earlier held-back work is still waiting in Review", result)
        still, _ = list_retained(h.root, configured)
        self.assertEqual([task.path for task in still], [kept[0].path],
                         "DGC never throws away work nobody has looked at")
        self.assertIn("result += quantity * unit_price", (Path(kept[0].path) / "billing.py").read_text())


# ------------------------------------------------------------------------------- a long memory ---
class ALongTranscriptIsCompactedFirstTest(Case):
    def test_a_conversation_over_half_its_window_is_compacted_before_the_request_is_added(self):
        h = self.make_repo(subagent_context_size=4096)
        parent, helper = Turns(), Turns()
        long_read = "x = 1  # " + "padding " * 3000
        (h.root / "big.py").write_text(long_read)
        commit(h.root, {})
        parent.on("PARENT review", [ToolCall("t1", "task", {"description": "Review billing.py",
                                                             "prompt": "REVIEWER: review billing.py and big.py"})],
                  "ok")
        helper.on("REVIEWER: review", [ToolCall("r1", "read_file", {"path": "big.py"}),
                                       ToolCall("r2", "read_file", {"path": "billing.py"})], FINDING)
        self.turn(h, "PARENT review", parent, helper)
        agent_id = h.agent.subagents.snapshot()["items"][0]["id"]
        summaries = []
        real_compact = Agent.maybe_compact

        def compact(agent, *args, **kwargs):
            if kwargs.get("trigger") == "continue":
                summaries.append((agent.depth, agent.estimate_tokens(), agent.context_size()))
            return real_compact(agent, *args, **kwargs)
        parent.on("PARENT fix", [ToolCall("t2", "continue_task", {"id": agent_id, "text": "Fix FINDING-1."})], "ok")
        helper.on("[Continued", self.fix, "Fixed.")
        with patch.object(Agent, "maybe_compact", compact):
            self.turn(h, "PARENT fix", parent, helper)
        self.assertEqual(len(summaries), 1, summaries)
        depth, before, window = summaries[0]
        self.assertEqual((depth, window), (1, 4096), "the helper's own window")
        self.assertGreaterEqual(before, window // 2, "over half its window")
        context = helper.seen["[Continued"][0]
        flat = json.dumps(context)
        self.assertIn("REVIEWER: review billing.py and big.py", flat, "what it was asked carries through")
        self.assertIn(FINDING, flat, "and what it found")
        self.assertNotIn("padding " * 200, flat, "the long read is gone")
        sent = sum(len(json.dumps(m)) for m in context)
        self.assertLess(sent, len(long_read), "it fits its window again")
        _, note = last_user(context)
        self.assertTrue(note.endswith("The request:\nFix FINDING-1."), "the request itself is never summarised")
        self.assertEqual((h.root / "billing.py").read_text(), FIXED)


# ------------------------------------------------------------------------------- after a restart ---
class AfterARestartTest(Case):
    def test_a_reopened_chat_continues_its_helper_from_its_saved_conversation(self):
        h = self.make_repo()
        h.agent.session_file = sessions.new_path(h.root)
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        store = helper_memory.store_dir(h.agent.session_file)
        self.assertTrue((store / f"{agent_id}.json").is_file())
        self.assertEqual(oct((store / f"{agent_id}.json").stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(store.stat().st_mode & 0o777), "0o700")
        path = h.agent.session_file

        later = Harness(h.root, mode="auto", subagent_worktree_root=h.config.get("subagent_worktree_root"))
        self.addCleanup(later.close)
        later.agent.load_session(path)
        later.answer("permission_request", {"decision": "once"})   # a reopened chat asks as the mode it restores
        self.assertEqual(later.agent.subagents.state(agent_id), "finished", "the same id, restored")
        self.assertEqual(helper_memory.ids(later.agent), {agent_id})
        parent.on("PARENT fix", [ToolCall("t2", "continue_task", {"id": agent_id, "text": "Fix FINDING-1."})], "ok")
        helper.on("[Continued", self.fix, "Fixed after the restart.")
        self.turn(later, "PARENT fix", parent, helper)
        context = helper.seen["[Continued"][0]
        self.assertEqual(context[4]["content"], FINDING, "its memory came back from the saved conversation")
        self.assertEqual((h.root / "billing.py").read_text(), FIXED)
        self.assertEqual(helper_memory.runs_items(later.agent)[0]["runs"], 2)

    def test_a_deleted_session_takes_its_helpers_conversations_with_it(self):
        h = self.make_repo()
        h.agent.session_file = sessions.new_path(h.root)
        parent, helper = Turns(), Turns()
        self.review(h, parent, helper)
        store = helper_memory.store_dir(h.agent.session_file)
        self.assertTrue(store.is_dir())
        self.assertTrue(sessions.delete(h.agent.session_file, h.root))
        self.assertFalse(store.exists())

    def test_a_new_chat_has_none_of_the_last_ones_helpers(self):
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        self.review(h, parent, helper)
        self.assertTrue(helper_memory.ids(h.agent))
        h.agent.reset()
        self.assertEqual(helper_memory.ids(h.agent), set())

    def test_a_secret_in_its_conversation_is_not_kept(self):
        h = self.make_repo()
        h.agent.session_file = sessions.new_path(h.root)
        h.config._session_secret_values = ("sk-test-helper-secret-123456",)
        parent, helper = Turns(), Turns()
        parent.on("PARENT review", [ToolCall("t1", "task", {"description": "Review billing.py",
                                                             "prompt": "REVIEWER: review billing.py"})], "ok")
        helper.on("REVIEWER: review", [], "the key is sk-test-helper-secret-123456")
        self.turn(h, "PARENT review", parent, helper)
        agent_id = h.agent.subagents.snapshot()["items"][0]["id"]
        saved = (helper_memory.store_dir(h.agent.session_file) / f"{agent_id}.json").read_text()
        self.assertNotIn("sk-test-helper-secret-123456", saved)


# ---------------------------------------------------------------------------- the person's box ---
class ThePersonAsksItToDoMoreTest(unittest.TestCase):
    """continue_agent from the editor: a background run with no turn, reported back like a background helper."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-continue-")
        self.addCleanup(directory.cleanup)
        self.root = git_repo(Path(directory.name))
        self.worktrees = self.root.parent / (self.root.name + "-worktrees")
        self.addCleanup(shutil.rmtree, self.worktrees, True)
        commit(self.root, {"billing.py": BILLING})
        config = fixture_config(self.root, mode="auto", subagent_worktree_root=str(self.worktrees))
        self.events, self.condition = [], threading.Condition()

        def emit(_event_type, /, **fields):
            event = {"type": _event_type, **fields}
            self.assertIsNone(ep.event_error({"seq": 1, **event}), event)
            with self.condition:
                self.events.append(event)
                self.condition.notify_all()
        emitter = types.SimpleNamespace(emit=emit)
        backend = object.__new__(Backend)
        backend.config, backend.em, backend.pending = config, emitter, PendingRequests()
        backend.ui = HeadlessUI(emitter, backend.pending, approval_timeout_s=3)
        backend.agent = Agent(config, backend.ui)
        backend._queue, backend._steer_payloads = [], {}
        backend._worker, backend._foreground_worker, backend._turn_n = None, None, 0
        backend._turn_lock, backend.workspace_trusted = threading.RLock(), True
        backend._emit_context = lambda: None
        backend._agents_timer, backend._agents_timer_lock = None, threading.Lock()
        backend._agent_wakes = []
        backend.agent.subagents.listener = backend._on_subagent
        backend.agent.on_detached_ended = backend._on_detached_ended
        backend.agent.on_helper_runs = backend._on_helper_runs
        self.backend, self.agent = backend, backend.agent
        self.addCleanup(self.agent.mcp.stop_all)
        self.addCleanup(self.agent.stop_detached)
        self.parent, self.helper = Turns(), Turns()
        self.script = patch.object(LLMClient, "chat", Script([("PARENT", self.parent), ("REVIEWER", self.helper),
                                                              ("A background specialist", self.parent)]))
        self.script.start()
        self.addCleanup(self.script.stop)
        clone = patch.object(Config, "clone_for_root", clone_fixture)
        clone.start()
        self.addCleanup(clone.stop)

    def wait(self, predicate, timeout=20):
        with self.condition:
            self.assertTrue(self.condition.wait_for(lambda: predicate(self.events), timeout=timeout),
                            [e["type"] for e in self.events])

    def frames(self, kind):
        return [e for e in self.events if e["type"] == kind]

    def finished_review(self) -> str:
        self.parent.on("PARENT review", [ToolCall("t1", "task", {"description": "Review billing.py",
                                                                  "prompt": "REVIEWER: review billing.py"})], "ok")
        self.helper.on("REVIEWER: review", [ToolCall("r1", "read_file", {"path": "billing.py"})], FINDING)
        self.backend.ui.turn_id = "t1"
        self.assertTrue(self.agent.run_turn("PARENT review"))
        return self.agent.subagents.snapshot()["items"][0]["id"]

    def test_the_capability_and_the_contract_are_declared_and_no_existing_event_grew_a_field(self):
        caps = self.backend._ready_payload()["capabilities"]
        self.assertEqual(caps["continue_agent"], 1)
        self.assertIsNone(ep.command_error({"type": "continue_agent", "id": "sub-0123456789ab", "text": "x",
                                            "request_id": "c1"}))
        self.assertIsNotNone(ep.command_error({"type": "continue_agent", "id": "sub-0123456789ab", "text": "x"}),
                             "its answer is correlated: request_id is required")
        self.assertIsNone(ep.command_error({"type": "watch_agent_runs"}))
        self.assertEqual(set(ep.EVENT_FIELDS["agent_runs"]), {"items", "request_id"})
        for event in ("agent_started", "agent_updated", "agent_ended", "agents", "agent_report"):
            self.assertFalse({"runs", "continued", "continuable", "history"} & set(ep.EVENT_FIELDS[event]), event)

    def test_ask_it_to_do_more_runs_it_in_the_background_and_its_report_comes_back_as_a_wake(self):
        agent_id = self.finished_review()
        self.backend._dispatch_watch = None
        self.agent.ui._agent_runs_enabled = True
        self.agent.ui._agent_reports_enabled = True
        self.backend._emit_agent_runs(request_id="w1")
        answer = self.frames("agent_runs")[-1]
        self.assertEqual(answer["request_id"], "w1")
        self.assertEqual(answer["items"][0]["id"], agent_id)
        self.assertTrue(answer["items"][0]["continuable"], "the box may be offered")
        self.helper.on("[Continued", lambda m: [ToolCall("w1", "edit_file", {
            "path": "billing.py", "old_string": "result += round(quantity * unit_price)",
            "new_string": "result += quantity * unit_price"})], "Fixed FINDING-1 as you asked.")
        self.parent.on("A background specialist finished", [], "The reviewer fixed FINDING-1.")
        self.backend._continue_agent({"id": agent_id, "text": "Fix what you found."}, "c1")
        self.wait(lambda events: any(e["type"] == "agent_runs" and e.get("request_id") == "c1" for e in events))
        reply = next(e for e in self.events if e["type"] == "agent_runs" and e.get("request_id") == "c1")
        self.assertEqual(reply["items"][0]["runs"], 2)
        self.assertEqual(reply["items"][0]["history"][-1]["by"], "you")
        self.assertEqual(reply["items"][0]["history"][-1]["request"], "Fix what you found.")
        self.wait(lambda events: any(e["type"] == "agent_report" for e in events))
        report = self.frames("agent_report")[0]
        self.assertEqual(report["id"], agent_id)
        self.assertTrue(report["integrated"])
        self.assertIn("completed and integrated 1 path(s): billing.py", report["report"])
        self.assertIn("Fixed FINDING-1 as you asked.", report["report"])
        self.wait(lambda events: sum(e["type"] == "turn_end" for e in events) >= 1)
        self.assertEqual((self.root / "billing.py").read_text(), FIXED)
        context = self.helper.seen["[Continued"][0]
        _, note = last_user(context)
        self.assertTrue(note.startswith("[Continued — the user asked you to do more.]"), note)
        self.assertEqual(context[4]["content"], FINDING)
        # The same row went back to work: a snapshot says running before its new run's frames, once.
        snaps = [e for e in self.frames("agents") if any(i["id"] == agent_id and i["state"] == "running"
                                                          for i in e["items"])]
        self.assertTrue(snaps, "an older client sees the row working again from the snapshot")
        self.assertEqual(len(self.frames("agent_started")), 1, "never a second agent_started")

    def test_a_refusal_is_said_with_a_reason(self):
        agent_id = self.finished_review()
        self.agent.set_mode("plan")
        self.backend._continue_agent({"id": agent_id, "text": "Fix it."}, "c2")
        self.wait(lambda events: any(e["type"] == "command_rejected" for e in events))
        rejected = self.frames("command_rejected")[0]
        self.assertEqual((rejected["command"], rejected["reason"], rejected["request_id"]),
                         ("continue_agent", "plan_mode", "c2"))
        self.agent.set_mode("auto")
        self.agent.config.permissions["deny"] = ["Task"]
        self.backend._continue_agent({"id": agent_id, "text": "Fix it."}, "c3")
        self.wait(lambda events: sum(e["type"] == "command_rejected" for e in events) >= 2)
        self.assertEqual(self.frames("command_rejected")[1]["reason"], "denied")
        self.backend._continue_agent({"id": "not-an-id", "text": "x"}, "c4")
        self.assertEqual(self.frames("command_rejected")[2]["reason"], "unknown_agent")

    def test_a_client_that_never_asked_is_sent_no_agent_runs(self):
        self.finished_review()
        self.backend._emit_agents()
        self.assertEqual(self.frames("agent_runs"), [])


# ------------------------------------------------------------------------------------- terminal ---
class TheTerminalCommandTest(Case):
    def tui(self, agent):
        import contextlib
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=DummyOutput()))
        return TUI(agent.config, agent=agent)

    def test_agents_continue_gives_a_finished_helper_more_work_and_agents_lists_its_runs(self):
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        with patch.object(Config, "clone_for_root", clone_fixture):
            ui = self.tui(h.agent)
        listing = re.sub(r"\x1b\[[0-9;]*m", "", ui._rich(ui._agents_listing()))
        self.assertIn(f"continue {agent_id[4:12]}", listing)
        self.assertIn("/agents continue <id> <what to do> gives a finished helper more work", listing)
        helper.on("[Continued", self.fix, "Fixed from the terminal.")
        delivered = threading.Event()
        h.agent.monitors.queue_subtask_ended = lambda *a, **k: delivered.set()
        with patch.object(LLMClient, "chat", Script([("REVIEWER", helper)])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            ui._run_command(f"/agents continue {agent_id[4:12]} Fix FINDING-1.")
            self.assertTrue(delivered.wait(20), "its report is delivered like a background helper's")
        _, note = last_user(helper.seen["[Continued"][0])
        self.assertTrue(note.startswith("[Continued — the user asked you to do more.]"))
        self.assertTrue(note.endswith("The request:\nFix FINDING-1."))
        self.assertEqual((h.root / "billing.py").read_text(), FIXED)
        shown = "\n".join(re.sub(r"\x1b\[[0-9;]*m", "", str(block)) for block in ui.blocks)
        self.assertIn("Review billing.py · continued in the background, with its memory.", shown)
        listing = re.sub(r"\x1b\[[0-9;]*m", "", ui._rich(ui._agents_listing()))
        self.assertIn("continued · 2 runs", listing)

    def test_the_classic_terminal_does_the_same(self):
        import io
        from types import SimpleNamespace
        from rich.console import Console
        from dgc import cli
        h = self.make_repo()
        parent, helper = Turns(), Turns()
        agent_id = self.review(h, parent, helper)
        repl = object.__new__(cli.CLI)
        buf = io.StringIO()
        repl.console = Console(file=buf, force_terminal=False, width=140)
        repl.config, repl.agent = h.config, h.agent
        said = []
        repl.ui = SimpleNamespace(info=said.append, error=lambda text: said.append("ERROR " + text))
        repl.handle_slash("/agents")
        self.assertIn(f"continue {agent_id[4:12]}", buf.getvalue())
        helper.on("[Continued", self.fix, "Fixed from the classic prompt.")
        delivered = threading.Event()
        h.agent.monitors.queue_subtask_ended = lambda *a, **k: delivered.set()
        with patch.object(LLMClient, "chat", Script([("REVIEWER", helper)])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            repl.handle_slash(f"/agents continue {agent_id} Fix FINDING-1.")
            self.assertTrue(delivered.wait(20))
        self.assertIn("Review billing.py · continued in the background, with its memory. Its report comes back here.",
                      said)
        self.assertEqual((h.root / "billing.py").read_text(), FIXED)
        repl.handle_slash("/agents continue nothing-here do it")
        self.assertTrue(any(line.startswith("ERROR This chat has no helper") for line in said), said)

    def test_a_refusal_is_shown(self):
        h = self.make_repo()
        with patch.object(Config, "clone_for_root", clone_fixture):
            ui = self.tui(h.agent)
        ui._run_command("/agents continue sub-000000000000 do more")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any("has no helper" in str(b) for b in ui.blocks):
            time.sleep(0.02)
        self.assertTrue(any("This chat has no helper sub-000000000000" in str(b) for b in ui.blocks), ui.blocks)


if __name__ == "__main__":
    unittest.main()
