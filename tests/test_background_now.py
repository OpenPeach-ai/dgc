"""Run in background: the person moves a helper or a command the turn is waiting on to the background.

The model chooses foreground or background per helper; the person can now override it for what the
turn is waiting on (a Run in background button, Ctrl+B in the terminal). The moved work goes on
untouched -- same worktree, transcript and step count -- and comes back the way background work
does: the agents pill counts it, its end integrates and wakes the chat with the hand-back line.
"""
from __future__ import annotations

import re
import threading
import time
import types
import unittest
from unittest.mock import patch

from dgc import tools
from dgc.config import Config
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_subagents import HarnessCase, Script, calls_then, clone_fixture


def until(predicate, timeout=10.0, step=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return predicate()


def held_child(rounds, inside, release, *, path="notes.md", content="notes\n",
               final="Wrote notes.md.\nFILES: notes.md"):
    """A child that writes a file, then works (blocks) until ``release`` -- or its own stop."""
    def route(messages, results, cancel):
        rounds.append(len(results))
        if not results:
            return ChatResult(tool_calls=[ToolCall("c1", "write_file", {"path": path, "content": content})],
                              usage={"prompt_tokens": 10, "completion_tokens": 5})
        inside.set()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not release.is_set():
            if cancel is not None and cancel.is_set():
                return ChatResult(content="stopped")
            time.sleep(0.02)
        return ChatResult(content=final, usage={"prompt_tokens": 10, "completion_tokens": 5})
    return route


class _Case(HarnessCase):
    def harness(self, **config):
        h = self.make(git=True, mode="auto", **config)
        h.ui.background_now_enabled = True        # what `dgc serve`, the TUI and the classic REPL set
        h.ui.monitor_wake_enabled = True
        h.ui.turn_id = "t1"
        h.ui.reset_turn_messages()
        return h

    def move_when_waiting(self, h, kind, gate=None, *, via_backend=True):
        """On a thread: once the turn waits on a ``kind`` (and ``gate`` is set), move it."""
        box = {}

        def mover():
            item = until(lambda: next((i for i in h.agent.waiting_now() if i["kind"] == kind), None))
            if gate is not None:
                gate.wait(10)
            box["item"] = item
            if item is None:
                return
            if via_backend:
                fields = {"agent_id": item["id"]} if kind == "agent" else {"call_id": item["call_id"]}
                h.backend._background_now({"type": "background_now", "request_id": "move-1", **fields})
            else:
                box["moved"] = h.agent.background_now(item["id"])
        thread = threading.Thread(target=mover, daemon=True)
        thread.start()
        return box, thread


class AForegroundHelperMovedTests(_Case):
    def test_the_waiting_call_returns_and_the_helper_finishes_as_a_background_helper(self):
        h = self.harness()
        notices = []
        h.agent.on_detached_ended = notices.append
        rounds, inside, release = [], threading.Event(), threading.Event()
        seen = {}

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {
                    "description": "write notes", "prompt": "WRITE-NOTES: create notes.md",
                    "agent": "worker"})])
            seen["result"] = str(results[-1].get("content") or "")
            seen["child_still_working"] = not release.is_set()
            return ChatResult(content="carrying on")

        routes = [("WRITE-NOTES", held_child(rounds, inside, release)), ("parent: write", parent)]
        box, mover = self.move_when_waiting(h, "agent", inside)
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            try:
                self.assertTrue(h.agent.run_turn("parent: write the notes"))
                mover.join(5)
                agent_id = box["item"]["id"]
                # The waiting call came back with the move, while the helper still worked.
                self.assertTrue(seen["child_still_working"])
                self.assertIn(f"The person moved 'write notes' to the background (id {agent_id}).",
                              seen["result"])
                self.assertIn("It keeps running in its own copy; its report will arrive on its own "
                              "when it finishes.", seen["result"])
                self.assertIn("Carry on without it: don't wait for it, and don't start it again.",
                              seen["result"])
                # It is a background helper now: a detached job, listed as background, still working.
                self.assertIn(agent_id, h.agent._detached_jobs)
                moved = [f for f in h.of("moved_to_background") if f["request_id"] == "move-1"]
                self.assertEqual(moved[-1]["kind"], "agent")
                self.assertEqual(moved[-1]["agent_id"], agent_id)
                item = next(i for i in h.agent.subagents.snapshot()["items"] if i["id"] == agent_id)
                self.assertTrue(item.get("background"))
                self.assertEqual(item["state"], "running", "the turn's end must not end a moved helper")
                self.assertFalse(notices, "nothing reported before it finished")
                self.assertFalse((h.root / "notes.md").exists())

                release.set()
                self.assertTrue(until(lambda: notices, 15), "a moved helper's end must wake the chat")
            finally:
                release.set()
        notice = notices[0]
        self.assertEqual(notice["id"], agent_id)
        self.assertTrue(notice["integrated"], notice)
        self.assertIn("completed and integrated", notice["message"])
        self.assertEqual((h.root / "notes.md").read_text(), "notes\n", "its integration lands")
        ended = [f for f in h.of("agent_ended") if f["id"] == agent_id]
        self.assertEqual(ended[-1]["state"], "finished")
        # Nothing was restarted: one first round, then the round after its write, and the step it
        # made before the move is still counted.
        self.assertEqual(rounds, [0, 1])
        self.assertEqual(ended[-1]["tool_calls"], 1)
        self.assertNotIn(agent_id, h.agent._detached_jobs)
        self.assertFramesValid(h)

    def test_stop_on_the_turn_after_a_move_leaves_the_helper_running(self):
        h = self.harness()
        notices = []
        h.agent.on_detached_ended = notices.append
        rounds, inside, release = [], threading.Event(), threading.Event()
        parent_waits = threading.Event()

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {
                    "description": "write notes", "prompt": "WRITE-NOTES: create notes.md",
                    "agent": "worker"})])
            parent_waits.set()              # the turn goes on to its next round; Stop lands here
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not cancel.is_set():
                time.sleep(0.02)
            return ChatResult(content="stopped")

        routes = [("WRITE-NOTES", held_child(rounds, inside, release)), ("parent: write", parent)]
        box, mover = self.move_when_waiting(h, "agent", inside)

        def stopper():
            parent_waits.wait(10)
            h.backend_stop = True
            h.agent.cancelled.set()         # the turn's Stop
        threading.Thread(target=stopper, daemon=True).start()
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            try:
                h.agent.run_turn("parent: write the notes")
                mover.join(5)
                agent_id = box["item"]["id"]
                self.assertTrue(h.agent.cancelled.is_set(), "the turn was stopped")
                job = h.agent._detached_jobs.get(agent_id)
                self.assertIsNotNone(job, "Stop on the turn must not end a helper moved out of it")
                self.assertFalse(job["cancel"].is_set())
                self.assertEqual(h.agent.subagents.state(agent_id), "running")
                h.agent.cancelled.clear()       # the next turn would clear it; the helper never read it
                release.set()
                self.assertTrue(until(lambda: notices, 15))
            finally:
                release.set()
        ended = [f for f in h.of("agent_ended") if f["id"] == agent_id]
        self.assertEqual(ended[-1]["state"], "finished")
        self.assertEqual((h.root / "notes.md").read_text(), "notes\n")

    def test_it_is_stopped_only_from_its_own_row_once_moved(self):
        h = self.harness()
        finished = threading.Event()
        h.agent.on_detached_ended = lambda notice: finished.set()
        rounds, inside, release = [], threading.Event(), threading.Event()
        routes = [("WRITE-NOTES", held_child(rounds, inside, release)),
                  ("parent: write", calls_then([ToolCall("t1", "task", {
                      "description": "write notes", "prompt": "WRITE-NOTES: create notes.md",
                      "agent": "worker"})], final="carrying on"))]
        box, mover = self.move_when_waiting(h, "agent", inside)
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            try:
                h.agent.run_turn("parent: write the notes")
                mover.join(5)
                agent_id = box["item"]["id"]
                # Its own Stop (the agent map, its row): agent_control close reaches the moved helper.
                self.assertEqual(h.agent.close_detached(agent_id), (True, "isolated"))
                self.assertTrue(finished.wait(15))
            finally:
                release.set()
        ended = [f for f in h.of("agent_ended") if f["id"] == agent_id]
        self.assertEqual(ended[-1]["state"], "stopped")
        self.assertFalse((h.root / "notes.md").exists(), "a stopped helper's work is kept aside")

    def test_a_batch_member_moved_says_so_in_its_slot_and_the_rest_finish_as_before(self):
        h = self.harness(max_parallel_tasks=4)
        notices = []
        h.agent.on_detached_ended = notices.append
        rounds, inside, release = [], threading.Event(), threading.Event()
        seen = {}

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {"tasks": [
                    {"description": "quick part", "prompt": "QUICK-PART: say hi", "agent": "worker"},
                    {"description": "slow part", "prompt": "SLOW-PART: create notes.md", "agent": "worker"},
                ]})])
            seen["result"] = str(results[-1].get("content") or "")
            seen["slow_working"] = not release.is_set()
            return ChatResult(content="carrying on")

        routes = [("QUICK-PART", calls_then([ToolCall("q1", "write_file", {
                      "path": "quick.md", "content": "quick\n"})], final="Wrote quick.md.\nFILES: quick.md")),
                  ("SLOW-PART", held_child(rounds, inside, release)),
                  ("parent: both", parent)]

        box = {}

        def mover():
            inside.wait(10)
            item = until(lambda: next((i for i in h.agent.waiting_now() if i["label"] == "slow part"), None))
            box["item"] = item
            box["moved"] = h.agent.background_now(item["id"])
        thread = threading.Thread(target=mover, daemon=True)
        thread.start()
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            try:
                self.assertTrue(h.agent.run_turn("parent: both parts"))
                thread.join(5)
                agent_id = box["item"]["id"]
                self.assertEqual(box["moved"][1], "")
                self.assertTrue(seen["slow_working"])
                result = seen["result"]
                quick = result.split("[2]")[0]
                self.assertIn("[1] quick part", quick)
                self.assertIn("completed and integrated", quick)
                self.assertRegex(result, r"\[2\] slow part\nThe person moved 'slow part' to the background "
                                         rf"\(id {agent_id}\)\.")
                self.assertEqual((h.root / "quick.md").read_text(), "quick\n", "the rest finish as before")
                self.assertIn(agent_id, h.agent._detached_jobs)
                release.set()
                self.assertTrue(until(lambda: notices, 15))
            finally:
                release.set()
        self.assertEqual(notices[0]["id"], agent_id)
        self.assertEqual((h.root / "notes.md").read_text(), "notes\n")
        self.assertEqual(rounds, [0, 1], "nothing restarted")
        self.assertFramesValid(h)

    def test_nothing_is_movable_where_nothing_could_wake_or_outlive_the_turn(self):
        for case in ("one_shot", "frontend_without_it"):
            with self.subTest(case=case):
                h = self.harness()
                if case == "one_shot":
                    h.ui.non_interactive = True
                else:
                    h.ui.background_now_enabled = False
                seen = []

                def child(messages, results, cancel, seen=seen, h=h):
                    seen.append(h.agent.waiting_now())
                    return ChatResult(content="done")
                routes = [("CHILD", child), ("parent: go", calls_then([ToolCall("t1", "task", {
                    "description": "look", "prompt": "CHILD: look", "agent": "explorer"})]))]
                with patch.object(LLMClient, "chat", Script(routes)), \
                        patch.object(Config, "clone_for_root", clone_fixture):
                    h.agent.run_turn("parent: go")
                self.assertEqual(seen, [[]])

    def test_a_move_for_something_that_already_ended_is_refused_by_name(self):
        h = self.harness()
        h.backend._background_now({"type": "background_now", "request_id": "r9",
                                   "agent_id": "sub-0123456789ab"})
        rejected = h.of("command_rejected")[-1]
        self.assertEqual((rejected["command"], rejected["reason"], rejected["request_id"]),
                         ("background_now", "not_waiting", "r9"))
        h.backend._background_now({"type": "background_now", "request_id": "r10"})
        self.assertEqual(h.of("command_rejected")[-1]["reason"], "invalid_command")
        self.assertFramesValid(h)


class AForegroundCommandMovedTests(_Case):
    def _command_turn(self, h, go, command, seen, *, then=None):
        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("b1", "bash", {"command": command})])
            seen["result"] = str(results[-1].get("content") or "")
            seen["still_running"] = not go.exists()
            if then is not None:
                return then(cancel)
            return ChatResult(content="carrying on")
        return [("parent: run", parent)]

    def test_a_moved_command_becomes_a_background_shell_whose_exit_wakes_the_chat(self):
        h = self.harness()
        go = h.root / "go"
        seen = {}
        routes = self._command_turn(
            h, go, "echo before; while [ ! -f go ]; do sleep 0.05; done; echo after", seen)
        box, mover = self.move_when_waiting(h, "command")
        with patch.object(LLMClient, "chat", Script(routes)):
            started = time.monotonic()
            self.assertTrue(h.agent.run_turn("parent: run the build"))
            elapsed = time.monotonic() - started
        mover.join(5)
        self.assertTrue(seen["still_running"])
        self.assertLess(elapsed, 20)
        match = re.search(r"\((bg\d+)\)", seen["result"])
        self.assertIsNotNone(match, seen["result"])
        bid = match.group(1)
        self.assertTrue(seen["result"].startswith(
            "The person moved `echo before; while [ ! -f go ]; do sleep 0.05; done; echo after` "
            f"to the background ({bid}); its exit will wake this chat."), seen["result"])
        self.assertIn("Carry on without it: don't wait for it, and don't start it again.", seen["result"])
        moved = [f for f in h.of("moved_to_background") if f["request_id"] == "move-1"]
        self.assertEqual((moved[-1]["kind"], moved[-1]["call_id"]), ("command", "b1"))
        entry = tools._BG[bid]
        self.assertIsNone(entry["proc"].poll(), "it is still running, not restarted or killed")
        self.assertEqual(h.agent.monitors.pending_count(), 0)

        go.write_text("")
        self.assertTrue(until(lambda: entry.get("finished") is not None, 10))
        # Its exit is a background-command wake, with the tail of what it printed.
        self.assertTrue(until(lambda: h.agent.monitors.pending_count() > 0, 5))
        notification = h.agent.monitors.take_pending()
        self.assertEqual([b.kind for b in notification.batches], ["background_exit"])
        self.assertIn(f"background task {bid} exited 0", notification.text)
        self.assertIn("after", notification.text)
        # Its output is kept: what it printed before the move and after it.
        output = tools.bash_output({"id": bid}, h.agent.ctx)
        self.assertIn("before", output)
        self.assertIn("after", output)

    def test_stop_on_the_turn_after_a_move_leaves_the_command_running(self):
        h = self.harness()
        go = h.root / "go"
        seen = {}
        stopped = threading.Event()

        def then(cancel):
            h.agent.cancelled.set()                  # the person presses Stop on the turn
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not cancel.is_set():
                time.sleep(0.02)
            stopped.set()
            return ChatResult(content="stopped")
        routes = self._command_turn(h, go, "while [ ! -f go ]; do sleep 0.05; done; echo after", seen,
                                    then=then)
        box, mover = self.move_when_waiting(h, "command")
        with patch.object(LLMClient, "chat", Script(routes)):
            h.agent.run_turn("parent: run the build")
        mover.join(5)
        self.assertTrue(stopped.is_set())
        bid = re.search(r"\((bg\d+)\)", seen["result"]).group(1)
        entry = tools._BG[bid]
        time.sleep(0.3)
        self.assertIsNone(entry["proc"].poll(), "Stop on the turn must not kill a command moved out of it")
        self.assertFalse(entry["killed"])
        go.write_text("")
        self.assertTrue(until(lambda: entry.get("finished") is not None, 10))
        self.assertEqual(entry["proc"].returncode, 0)

    def test_a_command_that_finished_is_not_movable_and_a_quick_one_is_unchanged(self):
        h = self.harness()
        seen = {}
        routes = self._command_turn(h, h.root / "never", "echo quick", seen)
        with patch.object(LLMClient, "chat", Script(routes)):
            h.agent.run_turn("parent: run it")
        self.assertTrue(seen["result"].startswith("exit code: 0\nquick"), seen["result"])
        self.assertEqual(h.agent.waiting_now(), [])
        self.assertEqual(h.agent.background_now("b1"), ([], "not_waiting"))


class TheWaitingDecidesOnceTests(unittest.TestCase):
    def setUp(self):
        global background_now
        from dgc import background_now

    def test_a_move_after_the_work_ended_is_refused_and_the_value_is_kept(self):
        waiting = background_now.Waiting("agent", "sub-0123456789ab", "x")
        self.assertEqual(waiting.run(lambda: "value"), "value")
        self.assertFalse(waiting.move())

    def test_a_moved_run_hands_its_value_to_whoever_adopted_it(self):
        release = threading.Event()
        waiting = background_now.Waiting("agent", "sub-0123456789ab", "x")
        threading.Timer(0.2, waiting.move).start()
        self.assertIs(waiting.run(lambda: (release.wait(5), "late")[1]), background_now.MOVED)
        release.set()
        self.assertEqual(waiting.result(), "late")

    def test_a_refused_move_leaves_it_waiting(self):
        def refuse():
            raise RuntimeError("stopping")
        waiting = background_now.Waiting("agent", "sub-0123456789ab", "x", on_move=refuse)
        self.assertFalse(waiting.move())
        self.assertTrue(waiting.running)

    def test_a_command_is_movable_only_once_it_runs(self):
        waiting = background_now.Waiting("command", "b1", "sleep 9", armed=False)
        listing = background_now.WaitingList()
        listing.add(waiting)
        self.assertEqual(listing.find("b1"), [])
        self.assertFalse(waiting.move())
        waiting.arm()
        self.assertEqual(listing.find("b1"), [waiting])
        self.assertEqual(listing.find("b1", "agent"), [])
        self.assertTrue(waiting.move())


class TheModelIsToldTests(HarnessCase):
    def test_the_prompt_says_what_a_moved_result_means_where_the_person_can_move_work(self):
        from dgc import background_now
        h = self.make(git=True, mode="auto")
        h.ui.background_now_enabled = True
        h.agent._refresh_system()
        self.assertIn(background_now.guidance(), h.agent.messages[0]["content"])
        h.ui.background_now_enabled = False
        h.agent._refresh_system()
        self.assertNotIn(background_now.guidance(), h.agent.messages[0]["content"])


class TerminalCtrlBTests(unittest.TestCase):
    """Ctrl+B in the full-screen terminal: the one thing waited on moves; several ask which, or all."""

    def tui(self, items):
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        moved, flashes, pickers = [], [], []
        tui.agent = types.SimpleNamespace(
            waiting_now=lambda: list(items),
            background_now=lambda target: (moved.append(target) or
                                           ([i for i in items if target in (i["id"], "all")], "")))
        tui._flash = flashes.append
        tui._show_picker = lambda title, labels, cb: pickers.append((title, labels, cb))
        return tui, moved, flashes, pickers

    ITEMS = [{"kind": "agent", "id": "sub-0123456789ab", "call_id": "t1", "label": "map auth"},
             {"kind": "command", "id": "b1", "call_id": "b1", "label": "npm test"}]

    def test_one_thing_waited_on_moves_at_once(self):
        tui, moved, flashes, pickers = self.tui(self.ITEMS[:1])
        tui._background_now_key()
        self.assertEqual(moved, ["sub-0123456789ab"])
        self.assertEqual(flashes, ["moved to the background: map auth"])
        self.assertEqual(pickers, [])

    def test_several_ask_which_with_all_as_an_option(self):
        tui, moved, flashes, pickers = self.tui(self.ITEMS)
        tui._background_now_key()
        self.assertEqual(moved, [])
        title, labels, pick = pickers[0]
        self.assertEqual(title, "Run in background")
        self.assertEqual(labels, ["helper: map auth", "command: npm test", "All of them"])
        pick(1)
        self.assertEqual(moved, ["b1"])
        pick(2)
        self.assertEqual(moved, ["b1", "all"])
        self.assertEqual(flashes[-1], "moved 2 to the background")

    def test_the_key_bar_offers_it_only_while_something_is_waited_on(self):
        from dgc.tui import TUI
        tui, *_ = self.tui(self.ITEMS[:1])
        self.assertEqual(TUI._background_now_items(tui), self.ITEMS[:1])
        tui.agent = types.SimpleNamespace(waiting_now=lambda: [])
        self.assertEqual(TUI._background_now_items(tui), [])

    def test_the_real_tui_binds_ctrl_b_and_shows_the_chip(self):
        import tempfile
        from pathlib import Path
        from dgc.tui import TUI
        from test_subagents import fixture_config
        with tempfile.TemporaryDirectory() as root:
            tui = TUI(fixture_config(Path(root)))
            keys = [binding.keys for binding in tui.app.key_bindings.bindings]
            self.assertIn(("c-b",), [tuple(getattr(k, "value", k) for k in key) for key in keys])
            tui._turn.set()
            tui.agent.waiting_now = lambda: self.ITEMS[:1]
            self.assertIn("Ctrl+B", str(tui._shortcut_bar().value))
            self.assertIn("run in background", str(tui._shortcut_bar().value))
            tui.agent.waiting_now = lambda: []
            self.assertNotIn("Ctrl+B", str(tui._shortcut_bar().value))


class ClassicCtrlBTests(unittest.TestCase):
    """The classic terminal reads Ctrl+B in its live key loop, and asks with a number for several."""

    def cli(self, items):
        from dgc.cli import CLI
        cli = object.__new__(CLI)
        moved, said = [], []
        cli.agent = types.SimpleNamespace(
            waiting_now=lambda: list(items), cancelled=threading.Event(),
            background_now=lambda target: (moved.append(target) or
                                           ([i for i in items if target in (i["id"], "all")], "")))
        cli._background_now_say = said.append
        return cli, moved, said

    def test_one_moves_several_ask_by_number_or_all(self):
        items = TerminalCtrlBTests.ITEMS
        cli, moved, said = self.cli(items[:1])
        self.assertIsNone(cli._background_now_key())
        self.assertEqual(moved, ["sub-0123456789ab"])
        self.assertEqual(said, ["↳ moved to the background (helper): map auth"])

        cli, moved, said = self.cli(items)
        choosing = cli._background_now_key()
        self.assertEqual(said, ["Run in background: 1 map auth  2 npm test  a all  (Esc: cancel)"])
        self.assertIsNone(cli._background_now_choice(choosing, "2"))
        self.assertEqual(moved, ["b1"])
        cli._background_now_choice(choosing, "a")
        self.assertEqual(moved, ["b1", "sub-0123456789ab", "b1"])
        cli._background_now_choice(choosing, "\x1b")
        self.assertEqual(said[-1], "↳ not moved")


if __name__ == "__main__":
    unittest.main()
