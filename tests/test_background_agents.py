"""Plan 3: background task children outlive the parent turn and notify when they land."""
from __future__ import annotations

import time
from unittest.mock import patch

from dgc.config import Config
from dgc.headless import HeadlessUI
from dgc.llm import ChatResult, LLMClient, ToolCall
from test_subagents import HarnessCase, Script, calls_then, child, clone_fixture


class BackgroundTaskTests(HarnessCase):
    # How long the scripted child takes; the timing assertions key off it.
    CHILD_SECONDS = 1.2

    def _go(self, h, prompt, routes):
        if isinstance(h.ui, HeadlessUI):
            h.ui.turn_id = "t1"
            h.ui.reset_turn_messages()
        return h.agent.run_turn(prompt)

    def test_background_task_returns_before_the_child_ends(self):
        h = self.make(git=True, mode="auto")
        notices = []
        h.agent.on_detached_ended = notices.append
        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned and done speaking")),
            # The parent is only "not waiting" relative to how long the child takes, so the two
            # numbers belong together: a parent that waited would take at least this long.
            ("look at pkg/auth.py", child("Auth is in pkg/auth.py.\nFILES: pkg/auth.py",
                                          sleep=self.CHILD_SECONDS)),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            started = time.monotonic()
            self._go(h, "parent: background map", routes)
            elapsed = time.monotonic() - started
            # The real property, and it needs no clock: the child had not reported yet.
            self.assertFalse(notices, "the parent turn returned only after the child finished")
            # A hard bound of 0.8s against a 1.2s child left 0.4s of slack and failed CI on a
            # loaded runner. A parent that actually waited cannot come in under the child's own
            # sleep, so that is the bound worth asserting.
            self.assertLess(elapsed, self.CHILD_SECONDS, "the parent turn must not wait for the child")
            started_frame = h.of("agent_started")[-1]
            self.assertTrue(started_frame.get("background"))
            self.assertIn("running in the background", h.of("tool_result")[-1]["output"])
            self.assertTrue(h.agent._detached_jobs)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not notices:
                time.sleep(0.05)
            self.assertTrue(notices, "the child must still finish and notify")
            self.assertIn("pkg/auth.py", notices[0]["message"])
            ended = [f for f in h.of("agent_ended") if f["id"] == started_frame["id"]]
            self.assertEqual(ended[-1]["state"], "finished")
            self.assertFalse(any("independent reads" in str(f.get("message") or "") for f in h.of("info")),
                             "child parallel-read banners stay off the parent transcript")

    def test_parent_stop_does_not_cancel_a_detached_child(self):
        h = self.make(git=True, mode="auto")
        notices = []
        h.agent.on_detached_ended = notices.append
        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned")),
            ("look at pkg/auth.py", child("Auth is in pkg/auth.py.", sleep=0.8)),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            self._go(h, "parent: background map", routes)
            h.agent.cancelled.set()
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not notices:
                time.sleep(0.05)
            self.assertTrue(notices)
            ended = h.of("agent_ended")[-1]
            self.assertEqual(ended["state"], "finished")

    def test_a_new_chat_stops_the_background_work_the_old_one_started(self):
        """`/new` and `/clear` used to leave a detached child running.

        It kept writing files, and finished into whatever CheckpointManager the agent held by
        then -- the new chat's. The new chat got a recovery point for edits nobody made there,
        and its rewind reached the previous chat's files.
        """
        h = self.make(git=True, mode="auto")

        # Long enough that only a real cancel ends it inside this test's patience: a child that
        # simply finishes on its own would let the test pass with the fix reverted.
        def stubborn(messages, results, cancel):
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if cancel is not None and cancel.is_set():
                    break
                time.sleep(0.05)
            return ChatResult(content="still going")

        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned")),
            ("look at pkg/auth.py", stubborn),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            try:
                self._go(h, "parent: background map", routes)
                agent_id = h.of("agent_started")[-1]["id"]
                self.assertIn(agent_id, getattr(h.agent, "_detached_jobs", None) or {})
                before = h.agent.checkpoints

                h.agent.reset()                    # what /new and /clear both do

                self.assertIsNot(h.agent.checkpoints, before,
                                 "reset replaces the checkpoint manager, which is the whole risk")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if agent_id not in (getattr(h.agent, "_detached_jobs", None) or {}):
                        break
                    time.sleep(0.05)
                else:
                    self.fail("a new chat left the previous chat's background sub-task running")
            finally:
                h.agent.stop_detached()            # never leave a 45s thread behind on failure

    def test_a_detached_child_integrates_into_the_chat_that_started_it(self):
        """Even if it wins the race with the cancel, it must not record into the new chat."""
        h = self.make(git=True, mode="auto")
        captured = {}
        original = h.agent._finalize_subagent

        def spy(*args, **kwargs):
            captured["keeper"] = kwargs.get("keeper")
            return original(*args, **kwargs)

        h.agent._finalize_subagent = spy
        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned")),
            ("look at pkg/auth.py", calls_then([], final="found it")),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            started = h.agent.checkpoints
            self._go(h, "parent: background map", routes)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and "keeper" not in captured:
                time.sleep(0.05)
            self.assertIn("keeper", captured, "the detached child never finalized")
            self.assertIs(captured["keeper"], started,
                          "the child integrates into the chat that asked for it, not whichever "
                          "one the agent holds when it happens to finish")

    def test_stop_detached_cancels_the_child(self):
        h = self.make(git=True, mode="auto")

        def stubborn(messages, results, cancel):
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                if cancel is not None and cancel.is_set():
                    break
                time.sleep(0.05)
            return ChatResult(content="still going")

        routes = [
            ("parent: background map", calls_then([
                ToolCall("t1", "task", {
                    "description": "map auth",
                    "prompt": "look at pkg/auth.py and say where login lives",
                    "agent": "explorer",
                    "background": True,
                }),
            ], final="spawned")),
            ("look at pkg/auth.py", stubborn),
        ]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            self._go(h, "parent: background map", routes)
            agent_id = h.of("agent_started")[-1]["id"]
            self.assertEqual(h.agent.stop_detached(agent_id), 1)
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                ended = [f for f in h.of("agent_ended") if f["id"] == agent_id]
                # "stopped" is announced before the child's checkout is cleaned up; the job leaves
                # the list only after that, and the fixture's folder must not vanish under it.
                if ended and agent_id not in (getattr(h.agent, "_detached_jobs", None) or {}):
                    self.assertEqual(ended[-1]["state"], "stopped")
                    return
                time.sleep(0.05)
            self.fail("detached child did not stop")


class TerminalWakeTests(HarnessCase):
    """A detached task's result must reach a frontend that has no `on_detached_ended` callback.

    The editor backend sets one; the terminal never has. Its model was told a sub-task was running
    and would be continued, and then nothing ever woke it -- so it either waited for a result that
    could not arrive or reported delegated work it had never seen. The hub's pending queue is the
    path the terminal already polls for a background command's exit, so the result goes there.
    """

    ROUTES = [
        ("parent: background map", calls_then([
            ToolCall("t1", "task", {
                "description": "map auth",
                "prompt": "look at pkg/auth.py and say where login lives",
                "agent": "explorer",
                "background": True,
            }),
        ], final="spawned")),
        ("look at pkg/auth.py", child("Auth lives in pkg/auth.py, in login().")),
    ]

    @staticmethod
    def _task_result(h):
        """The parent's own `task` result, not whatever the child's last tool printed."""
        outputs = [str(frame.get("output") or "") for frame in h.of("tool_result")
                   if "is running in the background" in str(frame.get("output") or "")]
        assert len(outputs) == 1, outputs
        return outputs[0]

    def _run(self, h):
        h.ui.turn_id = "t1"
        h.ui.reset_turn_messages()
        with patch.object(LLMClient, "chat", Script(self.ROUTES)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.agent.run_turn("parent: background map")
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and h.agent._detached_jobs:
                time.sleep(0.05)
            self.assertFalse(h.agent._detached_jobs, "the detached child never finished")
            time.sleep(0.05)               # the notify runs in the same `finally`, just after

    def test_a_frontend_without_a_callback_is_woken_through_the_pending_queue(self):
        h = self.make(git=True, mode="auto")
        hub = h.agent.monitors
        self.assertFalse(callable(getattr(h.agent, "on_detached_ended", None)))
        self._run(h)
        self.assertEqual(hub.pending_count(), 1, "the result must be queued for the frontend")
        notification = hub.take_pending()
        batch = notification.batches[0]
        self.assertEqual(batch.kind, "subtask_ended")
        self.assertEqual(batch.description, "map auth")
        self.assertIn("pkg/auth.py", notification.text, "the child's own result must be carried")
        self.assertIn("map auth", notification.label)
        self.assertIn("finished", notification.label)

    def test_the_wake_is_labelled_a_sub_task_not_a_monitor(self):
        from dgc.monitors import wake_tag
        h = self.make(git=True, mode="auto")
        hub = h.agent.monitors
        self._run(h)
        notification = hub.take_pending()
        self.assertEqual(wake_tag(notification.batches), "sub-task · woke on its result")
        # The shared notice envelope tells the model what it is reading. Calling a sub-task's own
        # report "command output" is a lie it acts on: it discounts its own delegated work.
        self.assertNotIn("the lines below are command output", notification.text)
        self.assertIn("sub-task's report", notification.text)

    def test_a_frontend_with_a_callback_is_not_notified_twice(self):
        h = self.make(git=True, mode="auto")
        hub = h.agent.monitors
        notices = []
        h.agent.on_detached_ended = notices.append
        self._run(h)
        self.assertEqual(len(notices), 1, "the editor backend's callback still fires")
        self.assertEqual(hub.pending_count(), 0,
                         "a frontend that delivers the result itself must not also get a wake")

    def test_the_promise_matches_the_delivery_that_will_happen(self):
        h = self.make(git=True, mode="auto")
        h.ui.monitor_wake_enabled = True        # the flag the TUI and the editor backend set
        self._run(h)
        self.assertIn("I will continue when it finishes.", self._task_result(h))

    def test_with_wakes_off_the_model_is_told_the_result_follows_the_next_message(self):
        """`monitor_wake: false` means no turn starts on its own -- but the queued result still
        reaches the model with the user's next prompt, so say that rather than promising a wake."""
        h = self.make(git=True, mode="auto", monitor_wake=False)
        h.ui.monitor_wake_enabled = True        # a frontend that COULD wake, with wakes turned off
        hub = h.agent.monitors
        self._run(h)
        output = self._task_result(h)
        self.assertNotIn("I will continue when it finishes.", output)
        self.assertIn("with the user's next message", output)
        self.assertEqual(hub.pending_count(), 1, "it is still queued for that next message")

    def test_a_result_for_a_replaced_chat_is_dropped(self):
        h = self.make(git=True, mode="auto")
        hub = h.agent.monitors
        h.ui.turn_id = "t1"
        h.ui.reset_turn_messages()
        with patch.object(LLMClient, "chat", Script(self.ROUTES)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.agent.run_turn("parent: background map")
            hub.new_epoch("new chat")          # `/new` while the child is still running
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and h.agent._detached_jobs:
                time.sleep(0.05)
            time.sleep(0.05)
        self.assertEqual(hub.pending_count(), 0,
                         "a child's result must not land in the chat that replaced its own")


class PromiseOnlyWhatThisFrontendDeliversTests(HarnessCase):
    """Every Agent builds a MonitorHub, so a hub is not evidence that anything watches it.

    Keying the promise on "a hub exists" told `dgc -p` and the classic REPL that the turn would be
    continued when the child landed. `dgc -p` then exits with the child still running, and the
    classic REPL never starts a turn of its own -- which is the very failure this batch set out to
    fix, re-introduced for the two frontends that cannot wake.
    """

    ROUTES = TerminalWakeTests.ROUTES

    def _output(self, h):
        h.ui.turn_id = "t1"
        h.ui.reset_turn_messages()
        with patch.object(LLMClient, "chat", Script(self.ROUTES)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.agent.run_turn("parent: background map")
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and h.agent._detached_jobs:
                time.sleep(0.05)
            time.sleep(0.05)
        return TerminalWakeTests._task_result(h)

    def test_a_frontend_that_wakes_is_promised_a_wake(self):
        h = self.make(git=True, mode="auto")
        h.ui.monitor_wake_enabled = True           # what the TUI and the editor backend set
        self.assertIn("I will continue when it finishes.", self._output(h))

    def test_a_frontend_that_never_wakes_is_not(self):
        h = self.make(git=True, mode="auto")       # no monitor_wake_enabled: the classic REPL
        output = self._output(h)
        self.assertNotIn("I will continue when it finishes.", output)
        self.assertIn("with the user's next message", output,
                      "it still arrives with the next prompt (_drain_monitors with_prompt)")

    def test_a_one_shot_run_is_told_nothing_is_coming(self):
        h = self.make(git=True, mode="auto")
        h.ui.non_interactive = True                # `dgc -p`: the process exits after this turn
        output = self._output(h)
        self.assertNotIn("I will continue when it finishes.", output)
        self.assertNotIn("next message", output, "there is no next message in a one-shot run")
        self.assertIn("do not wait for it", output)


class AResultForAReplacedChatIsDroppedTests(HarnessCase):
    """`/new` and `/clear` replace the conversation; a child that lands afterwards belongs to the
    one that asked. The queue was pinned to the spawning conversation in this batch; the editor's
    callback was not, so the editor started an unprompted billed turn in a brand-new empty chat
    reporting work the user had just cleared."""

    def test_the_callback_does_not_fire_for_a_cleared_chat(self):
        h = self.make(git=True, mode="auto")
        notices = []
        h.agent.on_detached_ended = notices.append
        h.ui.turn_id = "t1"
        h.ui.reset_turn_messages()
        with patch.object(LLMClient, "chat", Script(TerminalWakeTests.ROUTES)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.agent.run_turn("parent: background map")
            h.agent.monitors.new_epoch("new chat")      # what reset() does on /new and /clear
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and h.agent._detached_jobs:
                time.sleep(0.05)
            time.sleep(0.1)
        self.assertEqual(notices, [],
                         "the cleared chat's sub-task must not wake the chat that replaced it")
