"""Trusted frontend scopes classify calls without a model, registry, or saved session.

These tests execute the actual frontend entrypoints against in-memory facades. Agent
completion/persistence integration is covered separately in test_session_turn_agent.
"""
import contextlib
import contextvars
import io
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from dgc import cli, tui
from dgc.headless import Backend
from dgc.session_turn_events import current_origin, foreground_turn


def noop(*args, **kwargs):
    return None


def config(engine=""):
    data = {"mode": "default", "suggest": False, "subscription_engine": engine}
    return SimpleNamespace(data=data, get=data.get, project_root=Path("/unused-origin-fixture"))


def agent(turn):
    return SimpleNamespace(run_turn=turn, cancelled=threading.Event(), stopping=False,
                           messages=[], session_name="fixture", monitors=None,
                           estimate_tokens=lambda: 0, expire_open_asks=noop,
                           take_deferred_steers=lambda: [])


class FrontendOriginTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNone(current_origin())
        self.calls = []

    def tearDown(self):
        self.assertIsNone(current_origin(), "frontend origin escaped its owning call")

    def observe(self, *args, **kwargs):
        self.calls.append((current_origin(), args, kwargs))
        return True

    def failing(self, *args, **kwargs):
        self.observe(*args, **kwargs)
        raise RuntimeError("fixture turn failed")

    def headless(self, kind="prompt", *, engine="", turn=None):
        backend = object.__new__(Backend)
        backend.config = config(engine)
        backend.agent = agent(turn or self.observe)
        backend.ui = SimpleNamespace(error=noop, info=noop)
        backend.events = []
        backend.em = SimpleNamespace(emit=lambda event, **fields:
                                     backend.events.append({"type": event, **fields}))
        backend._queue = [("Fixture prompt", None, [], kind)]
        backend._turn_n = 0
        backend._worker = threading.current_thread()
        for name in ("_finish_steering", "_maybe_auto_resume_goal",
                     "_flush_unsaved_todo_clear", "_emit_context", "_maybe_wake"):
            setattr(backend, name, noop)
        backend._start_eta_ticker = lambda _: threading.Event()
        backend._run_subscription_turn = turn or self.observe
        backend._take_agent_wake_locked = lambda: {
            "id": "fixture-child", "description": "Read-only child", "message": "Complete",
            "integrated": False,
        }
        return backend

    def drain(self, backend):
        # No real config or ambient credential discovery is needed by this classification test.
        with patch("dgc.headless.secret_values", return_value=()), \
                contextlib.redirect_stderr(io.StringIO()):
            backend._run_turn_queue()
        self.assertIsNone(backend._worker)
        self.assertEqual(backend._queue, [])

    def test_headless_prompt_and_explicit_continue_mark_native_calls(self):
        for kind, expected in (("prompt", "foreground_prompt"),
                               ("continue", "foreground_continue")):
            with self.subTest(kind=kind):
                backend = self.headless(kind)
                with foreground_turn("foreground_continue"):
                    self.drain(backend)
                    self.assertEqual(current_origin(), "foreground_continue")
                self.assertEqual(self.calls[-1][0], expected)
                self.assertEqual(self.calls[-1][2], {"reset_cancel": False})
                self.assertEqual(backend.events[-1]["reason"], "completed")

    def test_headless_resume_and_child_wake_mask_an_outer_foreground_origin(self):
        for kind in ("resume", "wake"):
            with self.subTest(kind=kind):
                backend = self.headless(kind)
                with foreground_turn("foreground_prompt"):
                    self.drain(backend)
                    self.assertEqual(current_origin(), "foreground_prompt")
                self.assertIsNone(self.calls[-1][0])
                self.assertEqual(self.calls[-1][2], {"reset_cancel": False})

    def test_headless_actual_auto_resume_queue_stays_excluded(self):
        backend = self.headless()
        backend._queue.clear()
        backend.agent.goal = "Complete fixture"
        backend.agent.goal_status = "active"
        backend.agent._last_turn_error = "Recoverable fixture interruption"
        backend._checklist_cleared = lambda: False
        # Exercise the real producer of the automatic-resume queue item as well as its consumer.
        self.assertTrue(Backend._maybe_auto_resume_goal(backend, failed=True, cancelled=False))
        self.assertEqual(backend._queue[0][3], "resume")
        with foreground_turn("foreground_prompt"):
            self.drain(backend)
            self.assertEqual(current_origin(), "foreground_prompt")
        self.assertIsNone(self.calls[-1][0])

    def test_headless_vendor_and_failure_restore_nested_context(self):
        for engine in ("", "fixture-vendor"):
            with self.subTest(engine=engine):
                backend = self.headless(engine=engine, turn=self.failing)
                with foreground_turn("foreground_continue"):
                    self.drain(backend)
                    self.assertEqual(current_origin(), "foreground_continue")
                self.assertEqual(self.calls[-1][0], None if engine else "foreground_prompt")
                self.assertEqual(backend.events[-1]["reason"], "error")

    def cli_facade(self, engine="", turn=None):
        return SimpleNamespace(config=config(engine), agent=agent(turn or self.observe),
                               ui=SimpleNamespace(end_stream=noop, stop_working=noop), expand_mentions=lambda text: text,
                               _run_delegated_turn=turn or self.observe)

    def test_classic_cli_native_and_vendor_calls_restore_context_on_every_exit(self):
        for engine in ("", "fixture-vendor"):
            for fails in (False, True):
                with self.subTest(engine=engine, fails=fails):
                    facade = self.cli_facade(engine, self.failing if fails else self.observe)
                    with foreground_turn("foreground_continue"):
                        if fails:
                            with self.assertRaisesRegex(RuntimeError, "fixture turn failed"):
                                cli.CLI._run_turn_body(facade, "Fixture prompt")
                        else:
                            self.assertTrue(cli.CLI._run_turn_body(facade, "Fixture prompt"))
                        self.assertEqual(current_origin(), "foreground_continue")
                    self.assertEqual(self.calls[-1][0], None if engine else "foreground_prompt")

    def test_classic_skill_and_custom_commands_enter_native_foreground_scope(self):
        facade = self.cli_facade()
        facade.agent.reload_skills = noop
        facade.agent.skills = {"fixture": SimpleNamespace(name="fixture", enabled=True)}
        for command in ("/skill fixture Inspect this", "/fixture-custom Inspect this"):
            with self.subTest(command=command):
                with patch("dgc.commands.discover_commands", return_value={"fixture-custom": object()}), \
                        patch("dgc.commands.render_command", return_value="Rendered fixture prompt"), \
                        foreground_turn("foreground_continue"):
                    self.assertTrue(cli.CLI.handle_slash(facade, command))
                    self.assertEqual(current_origin(), "foreground_continue")
                self.assertEqual(self.calls[-1][0], "foreground_prompt")

    def oneshot(self, *, engine="", cont=False, resume=None, fails=False):
        facade = self.cli_facade(engine, self.failing if fails else self.observe)
        args = SimpleNamespace(output_format="text", prompt="Fixture prompt", cont=cont,
                               resume=resume, model=None, think=None, output=None,
                               print_session_id=False)

        def vendor(*args, **kwargs):
            (self.failing if fails else self.observe)(*args, **kwargs)
            return 0

        with patch.object(cli, "_run_subscription_oneshot", side_effect=vendor), \
                contextlib.redirect_stdout(io.StringIO()):
            return cli._run_oneshot(facade, facade.config, args, SimpleNamespace(), engine)

    def test_oneshot_explicit_prompt_continue_and_resumed_session_are_foreground(self):
        # Selecting an old session is a user action, unlike the headless automatic goal retry.
        for cont, resume, expected in ((False, None, "foreground_prompt"),
                                       (True, None, "foreground_continue"),
                                       (False, "saved-fixture", "foreground_prompt")):
            with self.subTest(cont=cont, resume=resume):
                with foreground_turn("foreground_continue"):
                    self.assertEqual(self.oneshot(cont=cont, resume=resume), 0)
                    self.assertEqual(current_origin(), "foreground_continue")
                self.assertEqual(self.calls[-1][0], expected)

    def test_oneshot_vendor_and_exceptions_do_not_leak_foreground_scope(self):
        for engine in ("", "fixture-vendor"):
            for fails in (False, True):
                with self.subTest(engine=engine, fails=fails):
                    with foreground_turn("foreground_continue"):
                        if fails:
                            with self.assertRaisesRegex(RuntimeError, "fixture turn failed"):
                                self.oneshot(engine=engine, fails=True)
                        else:
                            self.assertEqual(self.oneshot(engine=engine), 0)
                        self.assertEqual(current_origin(), "foreground_continue")
                    self.assertEqual(self.calls[-1][0], None if engine else "foreground_prompt")

    def tui_facade(self, engine="", fails=False):
        fake_agent = agent(self.failing if fails else self.observe)
        sess = SimpleNamespace(agent=fake_agent, id="fixture", name="fixture", _closing=False,
                               _queue=[], _autotitle_pending=False, _worker_thread=None)
        facade = SimpleNamespace(agent=fake_agent, config=config(engine), active=sess,
                                 _tls=threading.local(), _cancel=fake_agent.cancelled,
                                 _turn=threading.Event(), _autotitled=True, blocks=[],
                                 _turn_marks=[], _prompt_history=[], _cur_session=lambda: sess,
                                 _remote_for=lambda _: None, _pop_followup=lambda _: None,
                                 _rich=lambda text: text, _append=noop, errors=[])
        facade.error = facade.errors.append
        facade._run_delegated_turn = self.failing if fails else self.observe
        for name in ("_cancel_auxiliary", "_foreground_aux_barrier", "_flush_text",
                     "_settle_running_tools", "_flush_unsaved_todo_clear", "_invalidate",
                     "_pause_pane", "_maybe_notify", "_schedule_auxiliary"):
            setattr(facade, name, noop)
        return facade, sess

    def submit_tui(self, facade, *, nested=False, submit=None):
        workers = []

        class CapturedThread:
            def __init__(self, *, target, name, daemon):
                self.target = target
                self.name, self.daemon = name, daemon

            def start(self):
                workers.append(self.target)

        with patch.object(tui.threading, "Thread", CapturedThread):
            if submit is None:
                tui.TUI._submit(facade, "Fixture prompt", expand_mentions=False)
            else:
                submit()
        self.assertEqual(len(workers), 1)
        self.assertEqual(self.calls, [], "origin should be set in the worker, not when it is scheduled")
        if nested:
            with foreground_turn("foreground_continue"):
                workers[0]()
                self.assertEqual(current_origin(), "foreground_continue")
        else:
            # A fresh context models the native worker thread without a real background thread.
            contextvars.Context().run(workers[0])

    def test_tui_sets_native_origin_inside_worker_and_resets_after_completion(self):
        facade, sess = self.tui_facade()
        self.submit_tui(facade)
        self.assertEqual(self.calls[0][0], "foreground_prompt")
        self.assertEqual(self.calls[0][2], {"reset_cancel": False})
        self.assertFalse(facade._turn.is_set())
        self.assertIsNone(sess._worker_thread)
        self.assertEqual(facade.errors, [])

    def test_tui_explicit_goal_resume_is_a_user_foreground_turn(self):
        facade, sess = self.tui_facade()
        facade.agent.update_goal = lambda state: state == "active"
        facade.agent.todo_clear_in_force = lambda: False
        facade._submit = lambda text, **kwargs: tui.TUI._submit(facade, text, **kwargs)
        self.submit_tui(facade, submit=lambda: tui.TUI._handle_slash(facade, "/goal resume"))
        self.assertEqual(self.calls[0][0], "foreground_prompt")
        self.assertEqual(facade.errors, [])
        self.assertIsNone(sess._worker_thread)

    def test_tui_vendor_and_failure_mask_then_restore_worker_context(self):
        for engine in ("", "fixture-vendor"):
            for fails in (False, True):
                with self.subTest(engine=engine, fails=fails):
                    self.calls.clear()
                    facade, sess = self.tui_facade(engine, fails)
                    self.submit_tui(facade, nested=True)
                    self.assertEqual(self.calls[0][0], None if engine else "foreground_prompt")
                    self.assertEqual(bool(facade.errors), fails)
                    self.assertFalse(facade._turn.is_set())
                    self.assertIsNone(sess._worker_thread)


if __name__ == "__main__":
    unittest.main()
