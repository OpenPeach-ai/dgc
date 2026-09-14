"""Checklist state must agree across tools, goal completion, session reset and display."""
import contextlib
import copy
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

# Run standalone (python -m unittest tests.test_todo_lifecycle) this module must be as hermetic as
# tests/run_tests.py: an Agent takes its workspace lease under HOME/.dgc/locks and the system
# prompt loads ~/.dgc memory and skills. Redirect HOME before any dgc module computes USER_HOME.
# When dgc is already imported (run_tests.py, or another test module loaded first) that
# redirection must already have happened: verify it against the account's real home, loudly,
# rather than assume whoever imported dgc did it.


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):        # no passwd database (Windows)
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError(
            "tests/test_todo_lifecycle.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-todo-tests-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config, DEFAULTS  # noqa: E402
from dgc.editor_protocol import event_error  # noqa: E402
from dgc.headless import Backend  # noqa: E402
from dgc.llm import ChatResult, ToolCall  # noqa: E402
from dgc.tools import MAX_TODO_CHARS, execute  # noqa: E402

_REMINDER = "You're stopping but these todos are still open"


class RecordingUI:
    """The AgentUI seam as a recorder: notices, errors and checklist pushes are kept, everything
    else is a no-op. It carries none of the markers the agent duck-types a terminal on (a Rich
    console, the TUI flash line, `non_interactive`) so a test opts into that shape explicitly."""
    non_interactive = False

    def __init__(self):
        self.infos, self.errors, self.todo_lists = [], [], []

    def info(self, message):
        self.infos.append(message)

    def error(self, message):
        self.errors.append(message)

    def on_todo(self, todos):
        self.todo_lists.append(list(todos))

    def notices(self):
        return [message for message in self.infos if message.startswith("finished with")]

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class TodoLifecycleTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-todo-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                        hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                        max_turns=8, thinking="off")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        self.ui = RecordingUI()
        self.agent = Agent(cfg, self.ui)
        self.agent.session_file = sessions.new_path(self.root)
        self.addCleanup(self.agent.mcp.stop_all)
        self.events = []
        self.backend = object.__new__(Backend)
        self.backend.agent, self.backend.config = self.agent, cfg
        self.backend.em = types.SimpleNamespace(emit=lambda event_type, **data: self.events.append({"type": event_type, **data}))
        self.backend._busy = lambda: False
        self.backend._emit_context = lambda *args: None
        self.backend._emit_goal = lambda *args: None

    def update(self, rows):
        return execute("todo", {"todos": rows}, self.agent.ctx)

    def reminders(self) -> int:
        return sum(1 for m in self.agent.messages if _REMINDER in str(m.get("content", "")))

    @staticmethod
    def script(*results):
        """A model that answers with `results` in order, then repeats the last one."""
        calls = []

        def chat(messages, **kwargs):
            calls.append(messages)
            return results[min(len(calls), len(results)) - 1]
        return chat, calls

    # --- one canonical list -------------------------------------------------------------------

    def test_goal_and_tool_use_the_same_current_checklist(self):
        self.update([{"content": "Check the result", "status": "pending"}])
        self.assertEqual(self.agent.todos, self.agent.ctx.todos)
        self.assertIs(self.agent.todos, self.agent.ctx.todos)
        self.update([{"content": "Check the result", "status": "done"}])
        self.assertEqual(self.agent.todos[0]["status"], "done")

    def test_new_and_cleared_chats_cannot_inherit_tasks(self):
        for command in ("new_session", "clear_session"):
            with self.subTest(command=command):
                self.update([{"content": "Previous chat only", "status": "pending"}])
                self.backend.dispatch({"type": command})
                self.assertEqual(self.agent.ctx.todos, [])
                self.assertEqual(self.agent.todos, [])

    def test_agent_clear_todos_empties_the_list_and_tells_the_frontend(self):
        self.update([{"content": "Stale", "status": "pending"}])
        held = self.agent.ctx.todos
        self.agent.clear_todos()
        self.assertEqual(self.agent.todos, [])
        self.assertIs(self.agent.ctx.todos, held)          # cleared in place: the context list is canonical
        self.assertEqual(self.ui.todo_lists[-1], [])

    def test_clear_todos_is_saved_so_a_resumed_session_stays_empty(self):
        self.update([{"content": "Stale", "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "Plan it"})
        self.assertTrue(self.agent._persist())
        saved = self.agent.session_file
        self.assertIs(self.agent.clear_todos(), True)
        self.assertEqual(self.ui.todo_lists[-1], [])
        self.agent.reset()
        self.agent.load_session(saved)
        self.assertEqual(self.agent.todos, [])
        self.assertEqual(self.agent.ctx.todos, [])

    def test_clear_todos_reports_a_failed_save_but_still_clears(self):
        self.update([{"content": "Stale", "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "Plan it"})
        with patch.object(self.agent, "_persist", return_value=False) as persist:
            self.assertIs(self.agent.clear_todos(), False)
        persist.assert_called_once()
        self.assertEqual(self.agent.todos, [])
        # Nothing saved yet (no turns): there is no record to update, so the clear is simply true.
        self.agent.messages.clear()
        self.update([{"content": "Again", "status": "pending"}])
        with patch.object(self.agent, "_persist") as persist:
            self.assertIs(self.agent.clear_todos(), True)
        persist.assert_not_called()
        self.assertEqual(self.agent.todos, [])

    # --- the user's clear: told to the model once, softly ------------------------------------

    def test_an_idle_clear_is_told_once_in_the_next_turn_and_lifts_after_it(self):
        from dgc.agent import Agent as AgentClass
        self.update([{"content": "Inspect", "status": "done"},
                     {"content": "Rotate the fixture key", "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "Plan it"})
        self.assertTrue(self.agent.clear_todos())
        self.assertTrue(self.agent.todo_clear_in_force())
        chat, calls = self.script(
            ChatResult(tool_calls=[ToolCall("w", "write_file", {"path": "a.txt", "content": "x\n"})]),
            ChatResult(content="Done."))
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Carry on"))
        self.assertEqual(len(calls), 2)
        for request in calls:                    # the system prompt carries it for this turn only
            self.assertIn("# Checklist cleared", request[0]["content"])
            self.assertIn(AgentClass.TODO_CLEARED_NOTE, request[0]["content"])
        transcript = " ".join(str(m.get("content", "")) for m in calls[-1][1:])
        self.assertNotIn(AgentClass.TODO_CLEARED_NOTE, transcript, "not repeated as a reminder")
        self.assertNotIn("Rotate the fixture key", request[0]["content"], "the dropped item text is kept nowhere")
        self.assertNotIn("# Checklist cleared", self.agent.messages[0]["content"],
                         "gone from the prompt once that turn ends")
        self.assertTrue(self.agent.todo_clear_in_force(), "still in force until the next turn starts")
        chat, calls = self.script(ChatResult(content="Hello."))
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Anything else?"))
        self.assertNotIn("# Checklist cleared", calls[0][0]["content"])
        self.assertFalse(self.agent.todo_clear_in_force())

    def test_a_mid_turn_clear_reaches_the_model_once_and_silences_the_make_a_list_nudge(self):
        from dgc.agent import Agent as AgentClass
        nudge = "use the `todo` tool to list the steps"
        edits = ChatResult(tool_calls=[
            ToolCall("a", "write_file", {"path": "a.txt", "content": "a\n"}),
            ToolCall("b", "write_file", {"path": "b.txt", "content": "b\n"}),
            ToolCall("c", "write_file", {"path": "c.txt", "content": "c\n"})])

        def run(clear: bool):
            self.agent.reset()
            self.agent.session_file = sessions.new_path(self.root)
            self.update([{"content": "Inspect", "status": "in_progress"}])
            calls = []

            def chat(messages, **kwargs):
                calls.append(copy.deepcopy(messages))
                if len(calls) == 1:
                    if clear:                    # the editor's Clear lands while this batch runs
                        self.agent.clear_todos(persist=False)
                    else:
                        self.update([])          # the model drops its own list: nothing to tell
                    return edits
                if len(calls) == 2:
                    return ChatResult(tool_calls=[ToolCall("r", "read_file", {"path": "a.txt"})])
                return ChatResult(content="Done.")
            with patch.object(self.agent.client, "chat", side_effect=chat):
                ok = self.agent.run_turn("Write the three files")
            self.assertTrue(ok, (self.agent._last_turn_error, self.ui.errors))
            return calls, " ".join(str(m.get("content", "")) for m in self.agent.messages)

        calls, transcript = run(clear=False)
        self.assertIn(nudge, transcript, "control: an empty list after multi-file edits draws the nudge")
        self.assertNotIn(AgentClass.TODO_CLEARED_NOTE, transcript)
        calls, transcript = run(clear=True)
        self.assertEqual(transcript.count(AgentClass.TODO_CLEARED_NOTE), 1, "told exactly once")
        self.assertIn(AgentClass.TODO_CLEARED_NOTE, " ".join(str(m.get("content", "")) for m in calls[1]))
        self.assertNotIn(nudge, transcript, "and never told to rebuild it in the same breath")
        self.assertTrue(all("# Checklist cleared" not in request[0]["content"] for request in calls))
        # Soft, not a refusal: a later list is accepted (a refused call could trip the loop guard).
        self.assertTrue(self.update([{"content": "Inspect", "status": "pending"}]).startswith("todo list updated:"))

    def test_resume_wording_drops_the_todos_while_a_clear_is_in_force(self):
        from dgc import goals
        from dgc.headless import _goal_scaffold
        plain, cleared = goals.resume_prompt(), goals.resume_prompt(checklist_cleared=True)
        self.assertEqual(plain, goals.RESUME_PROMPT)
        self.assertIn("Check the todos", plain)
        self.assertNotIn("todo", cleared.lower())
        self.assertEqual(_goal_scaffold(cleared), "Resumed the standing goal")
        self.assertIn("todos", goals.auto_resume_prompt("loop guard"))
        retry = goals.auto_resume_prompt("loop guard", checklist_cleared=True)
        self.assertNotIn("todo", retry.lower())
        self.assertEqual(_goal_scaffold(retry), "Retried the standing goal after the last attempt stopped")
        # The backend's automatic retry asks the agent, at the moment it queues the retry.
        self.assertTrue(self.agent.set_goal("Finish all required work"))
        self.backend._queue, self.backend.ui = [], self.ui
        self.update([{"content": "Inspect", "status": "pending"}])
        self.agent.clear_todos()
        self.assertTrue(self.backend._maybe_auto_resume_goal(True, False))
        self.assertNotIn("todo", self.backend._queue[-1][0].lower())
        self.agent._todo_clear_turns = None
        self.backend._queue.clear()
        self.backend._goal_auto_resumes = 0
        self.assertTrue(self.backend._maybe_auto_resume_goal(True, False))
        self.assertIn("Check the todos", self.backend._queue[-1][0])

    def test_reset_and_resume_start_without_a_clear_in_force(self):
        self.update([{"content": "Inspect", "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "Plan it"})
        self.assertTrue(self.agent._persist())
        saved = self.agent.session_file
        self.agent.clear_todos(persist=False)
        self.assertTrue(self.agent.todo_clear_in_force() and self.agent.todo_clear_unsaved)
        self.agent.reset()
        self.assertFalse(self.agent.todo_clear_in_force() or self.agent.todo_clear_unsaved)
        self.agent.clear_todos(persist=False)
        self.agent.load_session(saved)
        self.assertFalse(self.agent.todo_clear_in_force())
        self.assertFalse(self.agent.todo_clear_unsaved, "a pending flush must not land in another session")
        self.assertNotIn("# Checklist cleared", self.agent.system_prompt())

    def test_a_long_goal_turn_carries_the_cleared_note_in_one_cycle_not_every_cycle(self):
        from dgc.goals import CYCLE_MARKER
        self.update([{"content": "Inspect", "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "Plan it"})
        self.assertTrue(self.agent.clear_todos())           # an idle clear, before the goal starts
        self.assertTrue(self.agent.set_goal("Write the three files"))
        seen = []                                           # (cycle, note in the system prompt?)

        def chat(messages, **kwargs):
            cycle = sum(1 for m in messages if m.get("role") == "user"
                        and CYCLE_MARKER in str(m.get("content", "")))
            seen.append((cycle, "# Checklist cleared" in messages[0]["content"]))
            if messages[-1].get("role") == "tool":
                return ChatResult(content=f"Cycle {cycle + 1} done.")
            if cycle < 2:                                   # real, distinct progress each cycle
                name = "abc"[cycle]
                return ChatResult(tool_calls=[ToolCall(f"w{cycle}", "write_file",
                                                       {"path": f"{name}.txt", "content": "x\n"})])
            return ChatResult(tool_calls=[ToolCall("report", "update_goal", {
                "status": "completed", "summary": "Both files written",
                "evidence": ["a.txt and b.txt written"]})])
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Start the work"), (self.agent._last_turn_error, self.ui.errors))
        self.assertEqual(self.agent.goal_status, "completed", self.agent.goal_snapshot())
        cycles = sorted({cycle for cycle, _ in seen})
        self.assertEqual(cycles, [0, 1, 2], seen)
        self.assertTrue(all(noted for cycle, noted in seen if cycle == 0), seen)
        self.assertFalse(any(noted for cycle, noted in seen if cycle > 0),
                         f"told in the first cycle's prompt, not repeated in every later one: {seen}")
        self.assertNotIn("# Checklist cleared", self.agent.messages[0]["content"])
        self.assertTrue(self.agent.todo_clear_in_force(), "the nudge stays quiet through the next turn")

    def test_a_clear_landing_while_a_turn_counts_the_previous_one_down_is_not_lost(self):
        import threading
        from dgc.agent import Agent as AgentClass
        agent = self.agent
        self.update([{"content": "Inspect", "status": "pending"}])
        agent.clear_todos()                     # an earlier clear...
        agent._advance_todo_clear()             # ...one turn from lifting...
        self.assertEqual(agent._take_todo_clear_note(), AgentClass.TODO_CLEARED_NOTE)   # ...and told
        self.update([{"content": "Rebuilt by the model", "status": "pending"}])
        # The dispatcher's Clear lands exactly between the turn thread's read of the countdown and
        # its write. The countdown attribute is swapped for a property that starts that Clear on the
        # first read and gives it half a second to finish before the read returns.
        racing = threading.Thread(target=agent.clear_todos, daemon=True)
        state = {"turns": agent.__dict__.pop("_todo_clear_turns"), "raced": False}

        class Racing(AgentClass):
            @property
            def _todo_clear_turns(self):
                value = state["turns"]                  # the value the reader has already taken
                if not state["raced"]:
                    state["raced"] = True
                    racing.start()
                    racing.join(timeout=0.5)
                return value

            @_todo_clear_turns.setter
            def _todo_clear_turns(self, value):
                state["turns"] = value

        agent.__class__ = Racing
        try:
            agent._advance_todo_clear()
            racing.join(timeout=5)
        finally:
            agent.__class__ = AgentClass
            agent._todo_clear_turns = state["turns"]
        self.assertTrue(state["raced"])
        self.assertFalse(racing.is_alive())
        self.assertEqual(agent.todos, [])
        self.assertTrue(agent.todo_clear_in_force(), "the new clear is in force, not lifted with the old one")
        self.assertEqual(agent._todo_clear_turns, 0, "and it starts its own count")
        self.assertEqual(agent._take_todo_clear_note(), AgentClass.TODO_CLEARED_NOTE,
                         "its note is still owed to the model")

    # --- the tool: validation, normalisation, bounds ------------------------------------------

    def test_invalid_tool_payload_is_atomic_and_bounded(self):
        before = [{"content": "Keep this task", "status": "pending"}]
        for value in (None, "not a list", [None], [{"content": "", "status": "pending"}],
                      [{"status": "pending"}], [{"content": "Task", "status": "invented"}],
                      before * 101):
            with self.subTest(value=str(value)[:60]):
                self.update(before)
                self.assertTrue(self.update(value).startswith("error:"))
                self.assertEqual(self.agent.ctx.todos, before)
        self.assertEqual(self.update([]), "todo list cleared")

    def test_a_row_without_a_status_is_a_pending_step(self):
        # A local model often omits the field on a fresh step; only a non-empty, unrecognised
        # status is worth bouncing the whole list for.
        for rows in ([{"content": "Task"}], [{"content": "Task", "status": None}],
                     [{"content": "Task", "status": ""}], [{"content": "Task", "status": "  "}]):
            with self.subTest(rows=rows):
                self.assertTrue(self.update(rows).startswith("todo list updated:"))
                self.assertEqual(self.agent.ctx.todos, [{"content": "Task", "status": "pending"}])
        self.assertIn("unknown status 'invented'",
                      self.update([{"content": "Task", "status": "invented"}]))

    def test_todo_errors_name_the_row_and_preview_its_content(self):
        long_row = "Second row with a description that runs well past forty characters"
        error = self.update([{"content": "ok", "status": "pending"}, {"content": long_row, "status": "invented"}])
        self.assertIn("row 2", error)
        self.assertIn(repr(long_row[:40] + "…"), error)
        self.assertIn("'invented'", error)
        self.assertIn("pending, in_progress, done, blocked", error)
        self.assertIn("row 2", self.update([{"content": "ok", "status": "done"}, None]))
        self.assertIn("row 1", self.update([{"content": "   ", "status": "pending"}]))
        self.assertIn("101 rows", self.update([{"content": "x", "status": "done"}] * 101))
        self.assertEqual(self.agent.ctx.todos, [])         # every rejection left the list untouched

    def test_todo_statuses_normalise_common_synonyms(self):
        result = self.update([
            {"content": "A", "status": "Completed"}, {"content": "B", "status": "in progress"},
            {"content": "C", "status": " TODO "}, {"content": "D", "status": "stuck"},
            {"content": "E", "status": "finished"}, {"content": "F", "status": "doing"},
            {"content": "G", "status": "not started"}, {"content": "H", "status": "blocked"}])
        self.assertEqual([t["status"] for t in self.agent.ctx.todos],
                         ["done", "in_progress", "pending", "blocked", "done", "in_progress", "pending", "blocked"])
        self.assertEqual(result.splitlines()[1:5], ["[x] A", "[~] B", "[ ] C", "[!] D"])
        self.assertEqual(self.ui.todo_lists[-1], self.agent.ctx.todos)

    def test_overlong_todo_content_is_truncated_not_rejected(self):
        result = self.update([{"content": "  " + "x" * (MAX_TODO_CHARS + 100), "status": "pending"}])
        self.assertTrue(result.startswith("todo list updated:"))
        self.assertEqual(self.agent.ctx.todos[0]["content"], "x" * MAX_TODO_CHARS)

    # --- persistence --------------------------------------------------------------------------

    def test_saved_checklist_redacts_credentials_like_the_transcript(self):
        token = "sk-proj-todo-secret-fixture-0123456789"
        self.agent.config.data["api_key"] = token
        self.update([{"content": "Validate credential " + token, "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "Validate the configuration"})
        self.assertTrue(self.agent._persist())
        self.assertNotIn(token, self.agent.session_file.read_text())

    def test_resume_and_webview_history_snapshot_include_saved_tasks(self):
        rows = [{"content": "Inspect", "status": "done"}, {"content": "Verify", "status": "in_progress"}]
        self.update(rows)
        self.agent.messages.append({"role": "user", "content": "Finish the work"})
        self.assertTrue(self.agent._persist())
        saved = self.agent.session_file
        self.agent.reset()
        self.backend.dispatch({"type": "resume_session", "path": saved.name, "request_id": "resume"})
        history = next(event for event in self.events if event["type"] == "history")
        self.assertEqual(history.get("todos"), rows)
        self.assertIsNone(event_error({"seq": 0, **history}))
        self.assertEqual(self.agent.todos, rows)
        self.backend.dispatch({"type": "get_history", "request_id": "reload"})
        self.assertEqual(self.events[-1].get("todos"), rows)
        self.assertEqual(self.events[-1]["request_id"], "reload")

    def test_blocked_status_survives_save_and_resume(self):
        # A blocked item is parked deliberately; a save that flattens it to pending would make it
        # draw reminders again after every resume. (sessions.TODO_STATUSES must carry "blocked".)
        rows = [{"content": "Needs the upstream fix", "status": "blocked"}]
        self.update(rows)
        self.agent.messages.append({"role": "user", "content": "Park it"})
        self.assertTrue(self.agent._persist())
        saved = self.agent.session_file
        self.agent.reset()
        self.agent.load_session(saved)
        self.assertEqual(self.agent.todos, rows)

    def test_acp_resume_replays_the_current_plan(self):
        from dgc.acp import ACPServer
        # ACP plan entries know pending | in_progress | completed: a blocked step shows as pending.
        self.update([{"content": "Inspect", "status": "done"},
                     {"content": "Verify", "status": "in_progress"},
                     {"content": "Wait for the upstream fix", "status": "blocked"}])
        self.agent.messages.append({"role": "user", "content": "Finish the work"})
        self.assertTrue(self.agent._persist())
        server, wire = ACPServer(), []
        server._write = wire.append
        with patch("dgc.acp.Config", return_value=self.agent.config), \
                patch.object(server, "_session_inputs", return_value={}):
            server._dispatch({"id": 1, "method": "initialize", "params": {"protocolVersion": 1}})
            server._dispatch({"id": 2, "method": "session/load", "params": {
                "cwd": str(self.root), "sessionId": self.agent.session_file.stem}})
        for state in server._sessions.values():
            self.addCleanup(state.agent.mcp.stop_all)
        plans = [row["params"]["update"] for row in wire
                 if row.get("method") == "session/update"
                 and row["params"]["update"].get("sessionUpdate") == "plan"]
        self.assertEqual(plans, [{"sessionUpdate": "plan", "entries": [
            {"content": "Inspect", "priority": "medium", "status": "completed"},
            {"content": "Verify", "priority": "medium", "status": "in_progress"},
            {"content": "Wait for the upstream fix", "priority": "medium", "status": "pending"}]}])

    # --- completion semantics -----------------------------------------------------------------

    def test_two_ignored_reminders_then_the_turn_completes_with_a_notice(self):
        chat, calls = self.script(
            ChatResult(tool_calls=[ToolCall("plan", "todo", {"todos": [
                {"content": "Run the required check", "status": "pending"}]})]),
            ChatResult(content="All done."))
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Finish the checklist"))
        self.assertEqual(len(calls), 4)                    # tool call, two reminders, the accepted final
        self.assertEqual(self.reminders(), 2)
        self.assertEqual(self.agent._last_turn_error, "")
        self.assertEqual(self.ui.errors, [])
        self.assertEqual(self.ui.notices(), ["finished with 1 open todo: Run the required check"])
        self.assertEqual(self.agent.ctx.todos[0]["status"], "pending")   # kept, never cleared for the model

    def test_a_turn_that_did_no_work_gets_no_reminder_but_still_the_notice(self):
        # Restored on resume or left by an earlier turn: a one-line question must not cost two
        # extra model round-trips, and must not fail.
        self.update([{"content": "Run the required check", "status": "pending"}])
        chat, calls = self.script(ChatResult(content="The answer is 42."))
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Quick question: what is 6 × 7?"))
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.reminders(), 0)
        self.assertEqual(self.ui.notices(), ["finished with 1 open todo: Run the required check"])
        self.assertEqual(self.ui.errors, [])

    def test_blocked_items_draw_no_reminder_and_no_notice(self):
        self.update([{"content": "Wait for the upstream fix", "status": "blocked"}])
        chat, calls = self.script(
            ChatResult(tool_calls=[ToolCall("w", "write_file", {"path": "a.txt", "content": "x\n"})]),
            ChatResult(content="Done."))
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Write the file"))
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.reminders(), 0)
        self.assertFalse(any("Still pending" in str(m.get("content", "")) for m in self.agent.messages))
        self.assertEqual(self.ui.notices(), [])
        self.assertEqual(self.agent.ctx.todos[0]["status"], "blocked")

    def test_terminal_notice_points_at_todo_clear(self):
        import inspect
        import dgc.cli
        import dgc.tui
        # The markers below are the real classes' own attributes; a rename there must fail here.
        self.assertIn("self._flash_msg", inspect.getsource(dgc.tui.TUI.__init__))
        self.assertIn("self.console", inspect.getsource(dgc.cli.UI.__init__))
        self.update([{"content": "Run the required check", "status": "pending"}])
        chat, _ = self.script(ChatResult(content="All done."))
        cases = (("classic REPL", {"console": object()}, True),
                 ("dgc -p", {"console": object(), "non_interactive": True}, False),
                 ("TUI", {"_flash_msg": ""}, True),
                 ("editor/ACP", {}, False))
        for label, markers, expected in cases:
            with self.subTest(surface=label):
                for name in ("console", "_flash_msg", "non_interactive"):
                    self.ui.__dict__.pop(name, None)
                self.ui.__dict__.update(markers)
                self.ui.infos.clear()
                with patch.object(self.agent.client, "chat", side_effect=chat):
                    self.assertTrue(self.agent.run_turn("Anything else?"))
                notice, = self.ui.notices()
                self.assertEqual(notice.endswith(" · /todo clear to drop them"), expected, notice)

    def test_notice_names_at_most_three_items_each_capped(self):
        first = "A" * 80
        self.update([{"content": c, "status": s} for c, s in (
            (first, "pending"), ("Second", "in_progress"), ("Third", "pending"),
            ("Parked", "blocked"), ("Fourth", "pending"), ("Finished", "done"))])
        chat, _ = self.script(ChatResult(content="All done."))
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Wrap up"))
        self.assertEqual(self.ui.notices(),
                         ["finished with 4 open todos: " + "A" * 59 + "…, Second, Third, …"])

    # --- standing goals -----------------------------------------------------------------------

    def test_goal_refuses_a_completion_report_while_items_are_open(self):
        self.assertTrue(self.agent.set_goal("Finish all required work"))
        self.update([{"content": "Required check", "status": "pending"},
                     {"content": "Parked", "status": "blocked"}])

        prompts = []

        def step(prompt):
            prompts.append(prompt)
            self.agent._handle_call(ToolCall("report", "update_goal", {
                "status": "completed", "summary": "Claimed complete", "evidence": ["Claim"]}))
            return True
        self.agent._run_turn = step
        self.agent.run_turn("Continue")
        # The report is refused every cycle and the NEXT cycle's prompt says which step refused it
        # (never a second user turn in a row); with no tool progress the stall guard then ends the
        # goal on its own terms.
        self.assertEqual(self.agent.goal_status, "blocked")
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["cycles"], 3)
        self.assertTrue(snapshot["reason"].startswith("Three consecutive goal cycles"), snapshot["reason"])
        self.assertEqual(len(prompts), 3)
        self.assertNotIn("not accepted", prompts[0])
        refusals = [text for text in prompts[1:] if "completion report for the goal was not accepted" in text]
        self.assertEqual(len(refusals), 2, prompts)
        for message in refusals:
            self.assertIn("Required check", message)
            self.assertNotIn("Parked", message)             # a blocked step is not what refused it
            self.assertIn("Continue the active goal", message, "the note rides in the cycle prompt")
        self.assertNotIn("not accepted", " ".join(str(m.get("content", "")) for m in self.agent.messages),
                         "the refusal is never appended as a message of its own")
        self.assertEqual([t["status"] for t in self.agent.ctx.todos], ["pending", "blocked"])

    def test_goal_ends_blocked_naming_the_steps_when_only_blocked_items_remain(self):
        self.assertTrue(self.agent.set_goal("Finish all required work"))
        self.update([{"content": "Inspect", "status": "done"},
                     {"content": "Needs the upstream fix", "status": "blocked"},
                     {"content": "Needs a credential", "status": "blocked"}])

        def step(_prompt):
            self.agent._handle_call(ToolCall("report", "update_goal", {
                "status": "completed", "summary": "Everything I could do is done", "evidence": ["a.txt"]}))
            return True
        self.agent._run_turn = step
        self.agent.run_turn("Continue")
        # Not the stall guard's "no distinct tool progress": the real cause, on the first cycle.
        self.assertEqual(self.agent.goal_status, "blocked")
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["cycles"], 1)
        self.assertIn("steps the model marked blocked: Needs the upstream fix; Needs a credential",
                      snapshot["reason"])
        # This recorder carries no terminal marker and no editor hint (an ACP-like surface), so the
        # reason says it in words instead of naming a command that surface cannot run.
        self.assertIn("or clear the checklist to drop them.", snapshot["reason"])
        self.assertNotIn("/todo clear", snapshot["reason"])
        self.assertEqual(snapshot["evidence"], ["a.txt"])
        self.assertTrue(any("steps the model marked blocked" in message for message in self.ui.infos))
        self.assertFalse(any("completion report for the goal was not accepted" in str(m.get("content", ""))
                             for m in self.agent.messages))
        self.assertEqual([t["status"] for t in self.agent.ctx.todos], ["done", "blocked", "blocked"])

    def test_standing_goal_continues_past_open_items_at_a_cycle_boundary(self):
        self.assertTrue(self.agent.set_goal("Finish all required work"))
        self.update([{"content": "Required check", "status": "pending"}])
        status_at_cycle_two, calls = [], []

        def chat(messages, **kwargs):
            calls.append(messages)
            last = str(messages[-1].get("content", ""))
            if "Continue the active goal" in last:      # cycle 2 opens with the item still open
                status_at_cycle_two.append(self.agent.goal_status)
                return ChatResult(tool_calls=[
                    ToolCall("mark", "todo", {"todos": [{"content": "Required check", "status": "done"}]}),
                    ToolCall("report", "update_goal", {"status": "completed", "summary": "All steps done",
                                                       "evidence": ["a.txt written and checked"]})])
            if len(calls) == 1:                         # cycle 1 does real work…
                return ChatResult(tool_calls=[ToolCall("w", "write_file", {"path": "a.txt", "content": "x\n"})])
            return ChatResult(content="All done.")      # …then ignores the reminders and the goal nudge
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Start the work"))
        self.assertEqual(status_at_cycle_two, ["active"])  # open items did not pause the goal
        self.assertEqual(self.agent.goal_status, "completed")
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 2)
        self.assertEqual(self.reminders(), 2)
        self.assertEqual(self.ui.notices(), ["finished with 1 open todo: Required check"])
        self.assertEqual(self.ui.errors, [])


class ChecklistProtocolTests(unittest.TestCase):
    """The checklist on the wire and in the terminals: `clear_todos`, history snapshots, replays."""

    def setUp(self):
        from dgc.headless import HeadlessUI
        from dgc.protocol import PendingRequests
        directory = tempfile.TemporaryDirectory(prefix="dgc-todo-protocol-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                        hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                        max_turns=8, thinking="off")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        self.config = cfg
        # A real HeadlessUI, so whatever the agent's own todo callback does reaches the wire the
        # way `dgc serve` sends it, rather than a stub that swallows the call.
        self.events = []
        emitter = types.SimpleNamespace(
            emit=lambda event_type, **data: self.events.append({"type": event_type, **data}))
        self.ui = HeadlessUI(emitter, PendingRequests(), 300.0)
        self.agent = Agent(cfg, self.ui)
        self.agent.session_file = sessions.new_path(self.root)
        self.addCleanup(self.agent.mcp.stop_all)
        self.backend = object.__new__(Backend)
        self.backend.agent, self.backend.config, self.backend.em = self.agent, cfg, emitter
        self.backend._busy = lambda: False
        self.backend._emit_context = lambda *args: None
        self.backend._emit_goal = lambda *args: None

    def update(self, rows):
        return execute("todo", {"todos": rows}, self.agent.ctx)

    def saved_session_with(self, rows):
        """Persist a session holding `rows`, then leave the agent empty and pointing elsewhere."""
        self.agent.session_file = sessions.new_path(self.root)
        self.update(rows)
        self.agent.messages.append({"role": "user", "content": "Finish the work"})
        self.assertTrue(self.agent._persist())
        saved = self.agent.session_file
        self.agent.reset()
        self.agent.session_file = sessions.new_path(self.root)
        self.events.clear()
        return saved

    def tui(self):
        """A real TUI over this agent, built the way the /diff smoke test builds one: pipe input
        and a dummy output under create_app_session, without running the application loop. The
        agent keeps the UI it was built with (as `TUI(config, agent=cli.agent)` does in `dgc`)."""
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=120)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        return TUI(self.config, agent=self.agent)

    def recording_cli(self, calls):
        from dgc.cli import CLI

        class Recorder:
            def __getattr__(self, name):
                return lambda *args, **kwargs: calls.append((name, args))

        cli = object.__new__(CLI)
        cli.agent, cli.config, cli.ui = self.agent, self.config, Recorder()
        return cli

    def test_clear_todos_empties_the_checklist_and_answers_with_the_todos_event(self):
        from dgc.editor_protocol import command_error
        self.update([{"content": "Left behind", "status": "pending"},
                     {"content": "Half done", "status": "in_progress"}])
        self.events.clear()
        self.assertIsNone(command_error({"type": "clear_todos"}))
        self.assertIsNone(command_error({"type": "clear_todos", "request_id": "drop"}))
        self.backend.dispatch({"type": "clear_todos", "request_id": "drop"})
        self.assertEqual(self.agent.todos, [])
        self.assertEqual(self.agent.ctx.todos, [])
        self.assertEqual(self.events, [{"type": "todos", "todos": []}])
        self.assertIsNone(event_error({"seq": 0, **self.events[0]}))

    def test_clear_todos_while_a_turn_runs_empties_the_list_now_and_the_worker_saves_it(self):
        from dgc.headless import _BUSY_MUTATIONS
        self.assertNotIn("clear_todos", _BUSY_MUTATIONS)
        self.update([{"content": "Mid-turn", "status": "in_progress"}])
        self.agent.messages.append({"role": "user", "content": "Work"})
        self.assertTrue(self.agent._persist())
        self.events.clear()
        self.backend._busy = lambda: True
        with patch.object(self.agent, "_persist", wraps=self.agent._persist) as persist:
            self.backend.dispatch({"type": "clear_todos", "request_id": "mid"})
            # The turn thread owns the session lease: nothing is saved from the dispatcher.
            persist.assert_not_called()
        self.assertEqual(self.events, [{"type": "todos", "todos": []}])
        self.assertEqual(self.agent.todos, [])
        self.assertIs(self.agent.todo_clear_unsaved, True)
        self.assertIn("Mid-turn", self.agent.session_file.read_text(), "not yet on disk")
        self.backend._flush_unsaved_todo_clear()
        self.assertNotIn('"todos"', self.agent.session_file.read_text())
        self.assertIs(self.agent.todo_clear_unsaved, False)
        self.backend._flush_unsaved_todo_clear()          # nothing left: no second save, no event
        self.assertEqual(self.events, [{"type": "todos", "todos": []}])

    def test_a_clear_that_lands_after_the_turns_final_save_is_still_saved(self):
        # The real queue worker and the real dispatcher: the turn saves its list, then Clear arrives
        # while the worker is still registered. The retiring worker must write the empty list
        # before turn_end, so a reload or resume cannot bring it back.
        del self.backend.__dict__["_busy"]
        backend = self.backend
        backend._queue, backend._turn_n, backend._worker = [], 0, None
        backend.ui = self.ui
        backend._start_eta_ticker = lambda tid: __import__("threading").Event()
        backend._finish_steering = lambda cancelled, failed: None
        self.agent.session_name = "fixture"
        order = []

        def run_turn(text, reset_cancel=False):
            self.update([{"content": "Inspect", "status": "done"}, {"content": "Verify", "status": "pending"}])
            self.agent.messages += [{"role": "user", "content": text}, {"role": "assistant", "content": "ok"}]
            self.assertTrue(self.agent._persist())
            order.append("turn saved")
            backend.dispatch({"type": "clear_todos", "request_id": "late"})
            order.append("clear dispatched")
            return True
        self.agent.run_turn = run_turn
        self.assertEqual(backend._start_turn("go")[0], "started")
        worker = backend._worker
        worker.join(30)
        self.assertFalse(worker.is_alive())
        types_seen = [event["type"] for event in self.events]
        self.assertNotIn("command_rejected", types_seen)
        self.assertLess(max(i for i, e in enumerate(self.events) if e["type"] == "todos" and e["todos"] == []),
                        types_seen.index("turn_end"), "the list empties before the turn ends")
        self.assertNotIn('"todos"', self.agent.session_file.read_text())
        self.assertIs(self.agent.todo_clear_unsaved, False)
        self.assertEqual(order, ["turn saved", "clear dispatched"])
        backend.dispatch({"type": "get_history", "request_id": "after"})
        self.assertEqual(self.events[-1].get("todos"), [])

    def test_a_mid_turn_clear_whose_save_fails_says_so_when_the_worker_retires(self):
        self.update([{"content": "Mid-turn", "status": "in_progress"}])
        self.agent.messages.append({"role": "user", "content": "Work"})
        self.backend._busy = lambda: True
        self.backend.dispatch({"type": "clear_todos"})
        self.events.clear()
        with patch("dgc.sessions.save", return_value=False):
            self.backend._flush_unsaved_todo_clear()
        self.assertEqual([event["type"] for event in self.events], ["error"])
        self.assertIs(self.agent.todo_clear_unsaved, True, "a failed save leaves the clear to save later")
        self.assertEqual(self.agent.todos, [])

    def test_the_editor_is_told_the_command_it_can_type_to_drop_a_blocked_checklist(self):
        self.assertTrue(self.agent.set_goal("Finish all required work"))
        self.update([{"content": "Needs a credential", "status": "blocked"}])
        report = {"status": "completed", "summary": "done", "evidence": ["x"]}
        reason = self.agent._gate_completion_report(report)["summary"]
        self.assertIn("or /todo clear to drop them.", reason)
        # `dgc -p --output-format json` streams the same events but nobody can type a command.
        from dgc.cli import _json_oneshot_ui
        self.agent.ui = _json_oneshot_ui(self.config)
        reason = self.agent._gate_completion_report(report)["summary"]
        self.assertIn("or clear the checklist to drop them.", reason)

    def test_tui_todo_clear_mid_turn_is_refused_visibly_and_the_list_is_kept(self):
        # The terminal keeps its visible refusal while a turn runs; only the editor clears mid-turn.
        ui = self.tui()
        self.update([{"content": "Stale", "status": "pending"}])
        ui._todos = list(self.agent.todos)
        ui._turn.set()
        try:
            self.assertEqual(ui._dispatch_composer_text("/todo clear"), "local-command")
            self.assertIn("/todo waits for this turn to finish", ui._flash_msg)
            self.assertEqual(self.agent.todos, [{"content": "Stale", "status": "pending"}])
        finally:
            ui._turn.clear()
        self.assertEqual(ui._dispatch_composer_text("/todo clear"), "command")
        self.assertEqual(self.agent.todos, [])
        self.assertEqual(ui.active._todos, [])

    def test_every_history_snapshot_carries_the_redacted_checklist(self):
        # The token becomes a known secret only AFTER the session was saved, so the file holds it
        # in clear text and the redaction under test is the one on the outgoing frame.
        token = "fixture-passphrase-history-ab12cd34ef56"
        saved = self.saved_session_with([{"content": "Rotate " + token, "status": "in_progress"}])
        self.config.data["api_key"] = token
        self.backend.dispatch({"type": "resume_session", "path": saved.name, "request_id": "resume"})
        self.backend.dispatch({"type": "get_history", "request_id": "reload"})
        with patch.object(self.agent, "rewind", return_value=(1, 0)):
            self.backend.dispatch({"type": "rewind", "index": 0, "request_id": "rewind"})
        self.assertIn(token, self.agent.todos[0]["content"])
        snapshots = [event for event in self.events if event["type"] == "history"]
        self.assertEqual(len(snapshots), 3)
        for snapshot in snapshots:
            self.assertIsNone(event_error({"seq": 0, **snapshot}))
            self.assertEqual([t["status"] for t in snapshot["todos"]], ["in_progress"])
            self.assertIn("Rotate", snapshot["todos"][0]["content"])
            self.assertNotIn(token, snapshot["todos"][0]["content"])
        self.assertNotIn("request_id", snapshots[0])
        self.assertEqual(snapshots[1]["request_id"], "reload")
        self.assertEqual([event["type"] for event in self.events][-2:], ["rewound", "history"])
        # The TUI's pinned rail is another frontend view of the same list: seeded from the
        # restored agent when the session is built, repainted by _render_history — both redacted.
        from dgc.tui import AgentSession
        seeded = list(AgentSession(self.config, self.ui, agent=self.agent)._todos)
        ui = self.tui()
        ui._render_history()
        for label, rail in (("seeded", seeded), ("rendered", ui.active._todos)):
            with self.subTest(rail=label):
                self.assertEqual([t["status"] for t in rail], ["in_progress"])
                self.assertIn("Rotate", rail[0]["content"])
                self.assertNotIn(token, rail[0]["content"])

    def test_clear_todos_reports_a_failed_save_over_the_wire_but_the_list_is_empty(self):
        self.update([{"content": "Left behind", "status": "pending"}])
        self.agent.messages.append({"role": "user", "content": "hi"})     # a session worth saving
        self.events.clear()
        with patch.object(self.agent, "_persist", return_value=False):
            self.agent._last_persist_error = "session file: disk full"
            self.backend.dispatch({"type": "clear_todos", "request_id": "clear-1"})
        self.assertEqual(self.agent.todos, [])
        self.assertEqual([e["type"] for e in self.events], ["todos", "error"])
        self.assertEqual(self.events[0]["todos"], [])
        self.assertEqual(self.events[1]["request_id"], "clear-1")
        self.assertIn("disk full", self.events[1]["message"])

    def test_the_todo_tool_paints_the_tui_rail_when_the_agent_was_built_for_another_ui(self):
        # `dgc` builds the Agent against the classic UI, then hands it to the TUI, which only
        # reassigns agent.ui. The callback must follow that reassignment or the Tasks rail never
        # moves while the classic console gets painted behind the full-screen app.
        ui = self.tui()
        before = len(self.events)
        self.update([{"content": "Live", "status": "in_progress"}])
        self.assertEqual([t["content"] for t in ui.active._todos], ["Live"])
        self.assertEqual(self.events[before:], [], "the UI the agent was built with is no longer painted")

    def test_classic_resume_prints_the_checklist_after_the_resumed_line_and_only_when_present(self):
        token = "fixture-passphrase-classic-ab12cd34ef56"
        self.saved_session_with([{"content": "Ship " + token, "status": "pending"}])
        self.config.data["api_key"] = token
        calls = []
        cli = self.recording_cli(calls)
        with patch("dgc.menu.select", return_value=0):
            cli._resume_cmd()
        names = [name for name, _ in calls]
        self.assertIn("on_todo", names)
        resumed = next(i for i, (name, args) in enumerate(calls)
                       if name == "info" and "resumed session" in str(args[0]))
        self.assertLess(resumed, names.index("on_todo"))
        replayed = next(args for name, args in calls if name == "on_todo")[0]
        self.assertEqual(replayed[0]["status"], "pending")
        self.assertIn("Ship", replayed[0]["content"])
        self.assertNotIn(token, replayed[0]["content"])
        self.agent.reset()
        calls.clear()
        cli._show_restored_todos()
        self.assertEqual(calls, [])

    def test_todo_clear_slash_command_empties_the_terminal_checklist(self):
        from dgc.commands import resolve_command
        spec = resolve_command("todo", "tui")
        self.assertEqual(spec.surfaces, {"tui", "classic"})
        self.assertFalse(spec.available_while_running)
        self.assertEqual(spec.usage, "todo clear")
        self.assertIsNone(resolve_command("todo", "editor"))
        self.update([{"content": "Stale", "status": "pending"}])
        self.events.clear()
        calls = []
        cli = self.recording_cli(calls)
        self.assertTrue(cli.handle_slash("/todo clear"))
        self.assertEqual(self.agent.todos, [])
        # The clear goes through the agent's own callback (in the real REPL its UI is the CLI's),
        # so the frontend seam receives the empty list exactly once.
        self.assertEqual(self.events, [{"type": "todos", "todos": []}])
        self.assertIn(("info", ("todo list cleared",)), calls)
        calls.clear()
        cli.handle_slash("/todo")
        self.assertEqual(calls, [("error", ("usage: /todo clear",))])
        cli.handle_slash("/todo everything")
        self.assertEqual(calls[-1], ("error", ("usage: /todo clear",)))

    def test_tui_session_seeds_its_pinned_checklist_from_the_restored_agent(self):
        from dgc.tui import AgentSession
        rows = [{"content": "Inspect", "status": "done"}, {"content": "Verify", "status": "pending"}]
        saved = self.saved_session_with(rows)
        self.assertEqual(AgentSession(self.config, self.ui, agent=self.agent)._todos, [])
        self.agent.load_session(saved)
        session = AgentSession(self.config, self.ui, agent=self.agent)
        self.assertEqual(session._todos, rows)
        self.assertIsNot(session._todos, self.agent.todos)   # the pane copies, never aliases

    def test_tui_todo_clear_empties_the_agent_list_and_the_pinned_rail(self):
        ui = self.tui()
        self.update([{"content": "Stale", "status": "pending"}])
        ui._todos = list(self.agent.todos)
        self.events.clear()
        self.assertTrue(ui._handle_slash("/todo clear"))
        self.assertEqual(self.agent.todos, [])
        self.assertEqual(self.agent.ctx.todos, [])
        self.assertEqual(ui.active._todos, [])
        self.assertEqual(ui._flash_msg, "todo list cleared")
        # The checklist callback follows agent.ui, so the TUI rail — not the UI the agent was
        # built with — is what gets painted; nothing reaches the old emitter.
        self.assertEqual(self.events, [])
        self.update([{"content": "Kept", "status": "pending"}])
        ui._todos = list(self.agent.todos)
        ui._handle_slash("/todo nonsense")
        self.assertEqual(self.agent.todos, [{"content": "Kept", "status": "pending"}])
        self.assertEqual(ui.active._todos, [{"content": "Kept", "status": "pending"}])
        self.assertEqual(ui._flash_msg, "usage: /todo clear")

    def test_tui_render_history_restores_a_copy_of_the_saved_checklist(self):
        rows = [{"content": "Inspect", "status": "done"}, {"content": "Verify", "status": "pending"}]
        saved = self.saved_session_with(rows)
        ui = self.tui()
        self.assertEqual(ui.active._todos, [])
        self.agent.load_session(saved)
        ui._render_history()
        self.assertEqual(ui.active._todos, rows)
        self.assertIsNot(ui.active._todos, self.agent.todos)
        ui.active._todos[1]["status"] = "done"               # the rail never writes through
        self.assertEqual(self.agent.todos[1]["status"], "pending")

    def test_acp_load_replays_only_a_non_empty_checklist_and_redacts_it(self):
        from dgc.acp import ACPServer
        token = "fixture-passphrase-acp-ab12cd34ef56"

        def plans_after_loading(sid):
            server, wire = ACPServer(), []
            server._write = wire.append
            with patch("dgc.acp.Config", return_value=self.config), \
                    patch.object(server, "_session_inputs", return_value={}):
                server._dispatch({"id": 1, "method": "initialize", "params": {"protocolVersion": 1}})
                server._dispatch({"id": 2, "method": "session/load", "params": {
                    "cwd": str(self.root), "sessionId": sid}})
            for state in server._sessions.values():
                self.addCleanup(state.agent.mcp.stop_all)
            return [row["params"]["update"] for row in wire
                    if row.get("method") == "session/update"
                    and row["params"]["update"].get("sessionUpdate") == "plan"]

        self.assertEqual(plans_after_loading(self.saved_session_with([]).stem), [])
        with_list = self.saved_session_with([{"content": "Rotate " + token, "status": "pending"}])
        self.config.data["api_key"] = token
        plans = plans_after_loading(with_list.stem)
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["entries"][0]["status"], "pending")
        self.assertIn("Rotate", plans[0]["entries"][0]["content"])
        self.assertNotIn(token, plans[0]["entries"][0]["content"])


if __name__ == "__main__":
    unittest.main()
