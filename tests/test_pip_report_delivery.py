"""Pip reports reach the chat: a finished run is a card in the chats it reports to, never a turn.

The founder's ERP chat (ERP_SESSION_REVIEW_2026-10-18 §7): no Pip could hand its findings to the chat,
so the model built a monitor that woke a 1,276-message chat on every run and applied "AUTO-OK" fixes
to a live database by itself. Agreed answer: the report appears in the chat as an item to act on
(Ask DGC to fix fills the composer, the user sends), and nothing changes unless the user says so.

Real registry, real runs finished through PipStore.finish, a real Backend whose frames go through
the protocol validator, and a real saved session file.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import pip_report_delivery as delivery
from dgc import pips
from dgc.headless import Backend
from dgc.llm import LLMClient
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import WorkspaceRegistry, identifier
from tests.test_pips_local import config as pips_config

NOW = "2026-10-18T10:00:00.000Z"


class Wire(io.TextIOBase):
    def __init__(self):
        self.frames = []

    def write(self, text):
        for line in str(text).splitlines():
            if line.strip():
                frame = json.loads(line)
                self.frames.append(frame)
        return len(text)

    def flush(self):
        pass

    def of(self, kind):
        return [frame for frame in self.frames if frame["type"] == kind]


def finding(title, severity="medium", path="app/billing.py", line=12):
    return {"title": title, "severity": severity, "path": path, "line": line, "evidence": "return total",
            "verification": "source_excerpt_only"}


class Scene(unittest.TestCase):
    """A project with Pips, a clock the test moves, and helpers to finish real runs."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-pip-report-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home")})
        env.start()
        self.addCleanup(env.stop)
        self.now = NOW
        self.registry = WorkspaceRegistry(clock=lambda: self.now)    # the default place: state_directory()
        self.addCleanup(self.registry.close)
        self.store = pips.PipStore(self.registry)
        self.workspace = self.registry.resolve(self.root)
        self.cfg = pips_config(self.root)
        self.pip = self.store.create(self.workspace["id"], "ERP daily audit", "Inspect billing.", "fixture",
                                     pip_type="scout")
        # pending() looks back a week from the real time; the scene's clock is in that week.
        clock = patch.object(delivery, "_now", lambda: delivery.datetime(2026, 10, 18, 12, tzinfo=delivery.timezone.utc))
        clock.start()
        self.addCleanup(clock.stop)

    def chat(self, session_id="chat-erp"):
        self.registry.associate_session(session_id, self.root)
        return session_id

    def attach(self, session_id, pip=None):
        pip = pip or self.pip
        self.registry.db.execute("INSERT INTO session_pip_attachments VALUES(?,?,?,?,?,?)",
                                 (session_id, pip["id"], self.workspace["id"], 1, self.now, "fixture"))

    def finished(self, *, pip=None, findings=None, error=None, requested_by="fixture", kind="audit"):
        pip = pip or self.pip
        binding = self.registry.binding(self.workspace["id"])
        run_id = identifier("run")
        manifest = {"pip_id": pip["id"], "workspace_id": self.workspace["id"], "job_version": pip["current_version"],
                    "source_revision": "a" * 40, "model": "fixture-model", "run_kind": kind,
                    "workspace_context": ContextStore(self.registry).snapshot(self.workspace["id"])}
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""", (run_id, pip["id"], self.workspace["id"], binding["id"], run_id,
                                              requested_by, json.dumps(manifest), "running", self.now, self.now))
        if error is not None:
            self.store.finish(run_id, error=error)
        else:
            self.store.finish(run_id, result={"summary": "Billing review", "findings": findings or [],
                                              "limitations": [], "tests_executed": False})
        return run_id

    def later(self, minutes):
        hour, minute = divmod(int(self.now[14:16]) + 60 * int(self.now[11:13]) + minutes, 60)
        self.now = f"2026-10-18T{hour:02d}:{minute:02d}:00.000Z"

    def pending(self, session_id, **kwargs):
        self.registry.db.execute("BEGIN")
        try:
            return delivery.pending(self.registry, session_id, **kwargs)
        finally:
            self.registry.db.rollback()

    def shown(self, session_id):
        return [entry["report"] for entry in self.pending(session_id) if entry["shown"]]

    def deliver(self, session_id):
        entries = self.pending(session_id)
        delivery.record(self.registry, session_id, entries)
        return [entry["report"] for entry in entries if entry["shown"]]


class WhichChatTests(Scene):
    def test_a_finished_report_reaches_the_chat_it_is_attached_to_with_its_findings(self):
        chat = self.chat()
        self.attach(chat)
        self.later(5)
        run = self.finished(findings=[finding("Rounding drops paise", "medium"),
                                 finding("GST total skips cess", "high", "app/gst.py", 88),
                                 finding("Typo in log", "low", "app/log.py", 3),
                                 finding("Invoice push retries forever", "high", "app/push.py", 40)])
        [card] = self.shown(chat)
        self.assertEqual((card["run_id"], card["pip_id"], card["name"], card["pip_type"]),
                         (run, self.pip["id"], "ERP daily audit", "scout"))
        self.assertEqual((card["outcome"], card["kind"], card["total"]), ("findings", "audit", 4))
        self.assertEqual(card["counts"], {"critical": 0, "high": 2, "medium": 1, "low": 1})
        self.assertEqual([f["severity"] for f in card["findings"]], ["high", "high", "medium"],
                         "the top findings, worst first")
        self.assertEqual(card["findings"][0], {"title": "GST total skips cess", "severity": "high",
                                               "path": "app/gst.py", "line": 88})
        self.assertIsNone(ep.event_error({"type": "pip_report", "seq": 1, "report": card}))

    def test_the_chat_a_pip_was_set_up_in_hears_from_it(self):
        chat = self.chat()
        receipt = {"setup_id": identifier("setup"), "pip_id": self.pip["id"], "job_version": 1, "run_id": None,
                   "next_run_at": None, "accepted": True, "actor": "editor-user", "resolved_at": self.now}
        self.registry.db.execute("""INSERT INTO pip_setup_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (receipt["setup_id"], self.workspace["id"], chat, "key", "digest", "{}", "digest", "accepted",
             json.dumps(receipt), self.now, self.now))
        self.later(1)
        run = self.finished(findings=[finding("Unchecked total")])
        self.assertEqual([card["run_id"] for card in self.shown(chat)], [run])
        self.assertEqual(delivery.report_chats(self.registry, self.pip["id"]), 1)

    def test_the_chat_that_ran_it_hears_about_that_run_only(self):
        chat = self.chat()
        asked = self.finished(findings=[], requested_by=delivery.chat_identity(chat))
        self.finished(findings=[finding("Someone else's run")])
        self.assertEqual([card["run_id"] for card in self.shown(chat)], [asked],
                         "run_pip_now's run comes back to the chat that started it, even when clean")

    def test_the_pip_page_learns_how_many_chats_it_reports_to(self):
        chat = self.chat()
        result = pips.handle_control(self.cfg, {"type": "get_pip", "request_id": "r1", "pip_id": self.pip["id"]},
                                     "device_1", start_worker=False)
        self.assertEqual(result["result"]["pip"]["report_chats"], 0, result)
        self.attach(chat)
        result = pips.handle_control(self.cfg, {"type": "get_pip", "request_id": "r2", "pip_id": self.pip["id"]},
                                     "device_1", start_worker=False)
        self.assertEqual(result["result"]["pip"]["report_chats"], 1)

    def test_a_pip_with_no_chat_reports_nowhere_new(self):
        chat = self.chat()
        self.finished(findings=[finding("Stays in Pips")])
        self.assertEqual(self.pending(chat), [])
        self.assertEqual(delivery.report_chats(self.registry, self.pip["id"]), 0)

    def test_runs_that_finished_before_the_chat_heard_from_the_pip_stay_history(self):
        chat = self.chat()
        self.finished(findings=[finding("Old news")])
        self.later(10)
        self.attach(chat)
        self.later(1)
        fresh = self.finished(findings=[finding("New since attaching")])
        self.assertEqual([card["run_id"] for card in self.shown(chat)], [fresh])

    def test_every_attached_chat_gets_it_once(self):
        first, second = self.chat("chat-a"), self.chat("chat-b")
        self.attach(first)
        self.attach(second)
        self.later(1)
        run = self.finished(findings=[finding("Shared")])
        self.assertEqual([c["run_id"] for c in self.deliver(first)], [run])
        self.assertEqual([c["run_id"] for c in self.deliver(second)], [run])
        self.assertEqual(self.deliver(first), [], "exactly once per chat")
        self.assertEqual(self.pending(second), [])
        self.assertEqual(delivery.record(self.registry, first, [{"run_id": run, "pip_id": self.pip["id"],
            "outcome": "findings", "signature": "x", "shown": True, "finished_at": self.now}]), 0,
            "a second entry for the same chat and run is refused by the ledger's key")

    def test_conversation_runs_and_drafts_are_not_reports(self):
        chat = self.chat()
        self.attach(chat)
        self.later(1)
        self.registry.db.execute("UPDATE pip_runs SET status='failed' WHERE 0")
        draft = self.finished(kind="draft", error={"code": "worker_failed", "message": "x"})
        entries = self.pending(chat)
        self.assertEqual([(e["run_id"], e["shown"]) for e in entries], [(draft, False)],
                         "entered in the ledger so it is never read again, but no card")


class WhatIsSaidTests(Scene):
    def setUp(self):
        super().setUp()
        self.session = self.chat()
        self.attach(self.session)
        self.later(1)

    def test_a_failed_run_says_it_failed_and_why_in_plain_words(self):
        run = self.finished(error={"code": "snapshot_limit",
                              "message": "Snapshot exceeds 10,000 entries, 4 MiB per file or 64 MiB total."})
        [card] = self.shown(self.session)
        self.assertEqual((card["run_id"], card["outcome"]), (run, "failed"))
        self.assertEqual(card["reason"], "The project is too big for it to copy for review.")
        self.assertIn("64 MiB", card["detail"])
        self.assertNotIn("findings", card)

    def test_an_unknown_failure_still_says_what_stopped_it(self):
        self.finished(error={"code": "mystery", "message": "the model endpoint returned 502"})
        [card] = self.shown(self.session)
        self.assertEqual(card["reason"], "It stopped: the model endpoint returned 502")

    def test_a_clean_run_is_a_quiet_line_the_first_time_and_silent_while_nothing_changes(self):
        first = self.finished(findings=[])
        [card] = self.deliver(self.session)
        self.assertEqual((card["run_id"], card["outcome"], card["total"]), (first, "clear", 0))
        self.later(30)
        quiet = self.finished(findings=[])
        entries = self.pending(self.session)
        self.assertEqual([(e["run_id"], e["shown"]) for e in entries], [(quiet, False)])
        delivery.record(self.registry, self.session, entries)
        self.later(30)
        broken = self.finished(findings=[finding("Now broken", "critical")])
        self.assertEqual([c["run_id"] for c in self.deliver(self.session)], [broken], "a change is said")
        self.later(30)
        fixed = self.finished(findings=[])
        [card] = self.deliver(self.session)
        self.assertEqual((card["run_id"], card["outcome"]), (fixed, "clear"), "and so is the all clear")

    def test_the_same_findings_again_are_not_said_twice_and_the_same_failure_neither(self):
        self.finished(findings=[finding("Same issue")])
        self.assertEqual(len(self.deliver(self.session)), 1)
        self.later(60)
        self.finished(findings=[finding("Same issue")])
        self.assertEqual(self.deliver(self.session), [])
        self.later(60)
        self.finished(error={"code": "invalid_report", "message": "bad JSON"})
        self.assertEqual(len(self.deliver(self.session)), 1)
        self.later(60)
        self.finished(error={"code": "invalid_report", "message": "bad JSON again"})
        self.assertEqual(self.deliver(self.session), [])

    def test_runs_that_waited_together_fold_into_the_newest(self):
        self.finished(findings=[finding("One")])
        self.later(30)
        self.finished(findings=[finding("One"), finding("Two", line=20)])
        self.later(30)
        newest = self.finished(findings=[finding("One"), finding("Two", line=20), finding("Three", line=30)])
        entries = self.pending(self.session)
        self.assertEqual([e["shown"] for e in entries], [False, False, True])
        self.assertEqual((entries[-1]["run_id"], entries[-1]["report"]["earlier"]), (newest, 2))

    def test_a_week_old_run_is_history_not_news(self):
        self.now = "2026-10-01T10:00:00.000Z"
        self.registry.db.execute("UPDATE session_pip_attachments SET created_at=?", (self.now,))
        self.finished(findings=[finding("Old")])
        self.assertEqual(self.pending(self.session), [])

    def test_a_pulse_check_says_which_checks_failed(self):
        saved = {"progress": {"phase": "terminal", "terminal_reason": "complete", "passed": 1, "failed": 1,
                              "stopped": 0, "unexecuted": 0, "unknown": 0, "total": 2},
                 "manifest": {"job": {"verification_plan": {"action": {"tests": [
                     {"argv": ["dgc-http-check", "http://127.0.0.1:8000/auth/me", "401"], "cwd": "."},
                     {"argv": ["dgc-http-check", "http://127.0.0.1:8000/", "200"], "cwd": "."}]}}}},
                 "receipt": {"commands": [
                     {"index": 0, "launch_state": "finished", "outcome": {"status": "passed"}},
                     {"index": 1, "launch_state": "finished", "outcome": {"status": "failed"}}]}}
        row = {"id": identifier("run"), "pip_id": self.pip["id"], "workspace_id": self.workspace["id"],
               "status": "succeeded", "finished_at": self.now, "manifest": json.dumps({"run_kind": "test"}),
               "result": None, "error": None}
        with patch("dgc.pip_pulse_results.stored", return_value=saved):
            made = delivery._candidate(self.registry, row, {"name": "ERP heartbeat", "pip_type": "pulse"})
        report = made["report"]
        self.assertEqual((report["outcome"], report["kind"]), ("checks_failed", "checks"))
        self.assertEqual(report["checks"], {"passed": 1, "failed": 1, "total": 2})
        self.assertEqual(report["failed_checks"], ["GET http://127.0.0.1:8000/ → 200"])
        self.assertEqual(made["signature"], "checks:1")

    def test_names_and_titles_are_redacted(self):
        secret = "sk-live-0123456789abcdefghij"
        self.finished(findings=[finding(f"Key {secret} in code")])
        [card] = [e["report"] for e in self.pending(self.session, secrets=(secret,)) if e["shown"]]
        self.assertNotIn(secret, json.dumps(card))


class BackendTests(Scene):
    """The chat side: the card on the wire, in the saved transcript, and in the replay."""

    def make(self):
        self.wire = Wire()
        with patch("dgc.trust.is_trusted", return_value=True), patch.object(sys, "stdout", self.wire):
            backend = Backend(self.cfg)
        self.addCleanup(lambda: backend.agent.mcp.stop_all())
        backend.agent.messages = [backend.agent.messages[0],
                                  {"role": "user", "content": "Set up a daily audit of billing"},
                                  {"role": "assistant", "content": "Done: ERP daily audit runs at 18:30."}]
        self.assertTrue(backend.agent._persist(), backend.agent._last_persist_error)
        self.session = backend.agent.session_file.stem
        self.attach(self.session)
        self.later(1)
        backend.dispatch({"type": "watch_pip_reports"})          # the panel draws them
        return backend

    def emitted(self, kind):
        return self.wire.of(kind)

    def saved(self, backend):
        return json.loads(Path(backend.agent.session_file).read_text())["messages"]

    def test_a_report_for_a_closed_chat_arrives_when_it_opens_and_is_saved_with_it(self):
        backend = self.make()
        run = self.finished(findings=[finding("GST total skips cess", "high")])
        with patch.object(LLMClient, "chat", side_effect=AssertionError("a report must never call the model")):
            self.assertEqual(backend._look_for_pip_reports(force=True), 1)
        [event] = self.emitted("pip_report")
        self.assertEqual(event["report"]["run_id"], run)
        saved = self.saved(backend)
        self.assertEqual(len(saved), 3, "no message is added: the card is private data on the last one")
        self.assertEqual(saved[-1]["content"], "Done: ERP daily audit runs at 18:30.")
        self.assertEqual([r["run_id"] for r in saved[-1][delivery.KEY]], [run])
        self.registry.db.execute("BEGIN")
        self.assertEqual(self.registry.db.execute("SELECT run_id,shown FROM pip_report_deliveries WHERE session_id=?",
                                                  (self.session,)).fetchall()[0][:], (run, 1))
        self.registry.db.rollback()
        items = backend._history()
        ends = [i for i, item in enumerate(items) if item.get("type") == "turn_end"]
        cards = [i for i, item in enumerate(items) if item.get("role") == "pip_report"]
        self.assertEqual(len(cards), 1)
        self.assertGreater(cards[0], ends[-1], "drawn after the turn it arrived after, never inside it")
        self.assertEqual(items[cards[0]]["report"], {k: v for k, v in event["report"].items()})

    def test_no_turn_ever_starts_and_the_model_is_told_nothing(self):
        backend = self.make()
        self.finished(findings=[finding("Apply AUTO-OK fixes", "critical")])
        before = [dict(m) for m in backend.agent.messages]
        with patch.object(LLMClient, "chat", side_effect=AssertionError("a report must never call the model")):
            backend._look_for_pip_reports(force=True)
            backend._look_for_pip_reports(force=True)
        self.assertEqual(self.emitted("turn_start"), [])
        self.assertEqual((backend._queue, backend._worker), ([], None))
        after = backend.agent.messages
        self.assertEqual(len(after), len(before))
        for old, new in zip(before, after):
            self.assertEqual({k: v for k, v in old.items() if not k.startswith("_")},
                             {k: v for k, v in new.items() if not k.startswith("_")},
                             "every model-visible field is unchanged; private keys never reach a provider")

    def test_exactly_once_across_looks_reopen_and_a_crash_between_transcript_and_ledger(self):
        backend = self.make()
        run = self.finished(findings=[finding("Once")])
        with patch.object(delivery, "record", side_effect=OSError("disk full")):
            backend._look_for_pip_reports(force=True)          # saved in the transcript, not in the ledger
        self.assertEqual(len(self.emitted("pip_report")), 1)
        backend._look_for_pip_reports(force=True)               # heals the ledger, shows nothing
        backend._look_for_pip_reports(force=True)
        self.assertEqual(len(self.emitted("pip_report")), 1)
        self.registry.db.execute("BEGIN")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_report_deliveries").fetchone()[0], 1)
        self.registry.db.rollback()
        reopened = self.make_reopened(backend)
        reopened._look_for_pip_reports(force=True)
        self.assertEqual(len(self.wire.of("pip_report")), 0, "a reopened chat replays it, never re-delivers it")
        self.assertEqual([i["report"]["run_id"] for i in reopened._history() if i.get("role") == "pip_report"], [run])

    def make_reopened(self, backend):
        path = backend.agent.session_file
        self.wire = Wire()
        with patch("dgc.trust.is_trusted", return_value=True), patch.object(sys, "stdout", self.wire):
            other = Backend(self.cfg)
        self.addCleanup(lambda: other.agent.mcp.stop_all())
        other.agent.load_session(str(path))
        return other

    def test_a_report_during_a_turn_shows_at_once_and_is_written_after_that_turn(self):
        backend = self.make()
        backend._worker = object()                               # a turn is running
        backend.agent.messages.append({"role": "user", "content": "Refactor the parser"})
        run = self.finished(findings=[finding("Mid-turn")])
        backend._look_for_pip_reports(force=True)
        self.assertEqual(len(self.emitted("pip_report")), 1, "the card shows while the turn runs")
        self.assertEqual(delivery.transcript_runs(backend.agent.messages), set(), "not written mid-turn")
        self.assertEqual(self.emitted("turn_start"), [], "and it does not interrupt the turn")
        backend.agent.messages.append({"role": "assistant", "content": "Parser refactored."})
        backend._worker = threading.current_thread()            # the worker, between turns
        backend._flush_pip_reports()
        backend._worker = None
        items = backend._history()
        turns = [item for item in items if item.get("type") == "turn_start"]
        self.assertEqual([t["prompt"] for t in turns][-1], "Refactor the parser")
        last_end = max(i for i, item in enumerate(items) if item.get("type") == "turn_end")
        [card] = [i for i, item in enumerate(items) if item.get("role") == "pip_report"]
        self.assertEqual(items[card]["report"]["run_id"], run)
        self.assertGreater(card, last_end, "after the turn it arrived during, as it was drawn live")

    def test_dismiss_is_saved_and_the_replay_leaves_the_card_out(self):
        backend = self.make()
        run = self.finished(findings=[finding("Dismiss me")])
        backend._look_for_pip_reports(force=True)
        backend.dispatch({"type": "pip_report_dismiss", "run_id": run})
        self.assertEqual([i for i in backend._history() if i.get("role") == "pip_report"], [])
        self.assertIs(self.saved(backend)[-1][delivery.KEY][0]["dismissed"], True)
        self.assertIsNone(ep.command_error({"type": "pip_report_dismiss", "run_id": run}))

    def test_a_card_dismissed_before_it_is_written_is_written_dismissed(self):
        backend = self.make()
        backend._worker = object()
        run = self.finished(findings=[finding("Gone before the turn ends")])
        backend._look_for_pip_reports(force=True)
        backend.dispatch({"type": "pip_report_dismiss", "run_id": run})
        backend._worker = threading.current_thread()
        backend._flush_pip_reports()
        backend._worker = None
        self.assertIs(self.saved(backend)[-1][delivery.KEY][0]["dismissed"], True)

    def test_a_client_that_never_asked_is_sent_nothing_and_nothing_is_taken(self):
        backend = self.make()
        backend._pip_reports_on = False                          # an older editor, or an SDK client
        run = self.finished(findings=[finding("Waits for a client that draws it")])
        self.assertEqual(backend._look_for_pip_reports(force=True), 0)
        self.assertEqual(self.emitted("pip_report"), [])
        self.assertEqual(delivery.transcript_runs(backend.agent.messages), set())
        backend.dispatch({"type": "watch_pip_reports"})
        self.assertEqual(backend._look_for_pip_reports(force=True), 1)
        self.assertEqual(self.emitted("pip_report")[0]["report"]["run_id"], run)
        self.assertIsNone(ep.command_error({"type": "watch_pip_reports"}))

    def test_ready_advertises_it(self):
        backend = self.make()
        ready = backend._ready_payload()
        self.assertEqual(ready["capabilities"]["pip_reports"], 1)
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 0, **ready}))


class TerminalTests(Scene):
    """The TUI: one line in the open chat's transcript, written into the session between turns."""

    def test_a_report_is_one_line_in_the_terminal_chat_and_is_saved_with_it(self):
        import contextlib
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.agent import Agent
        from dgc.tui import TUI

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=160)

        class Quiet:
            def __getattr__(self, name):
                if name.startswith("_") or name == "console":
                    raise AttributeError(name)
                return lambda *args, **kwargs: None

        agent = Agent(self.cfg, Quiet())
        self.addCleanup(agent.mcp.stop_all)
        from dgc import sessions
        agent.session_file = sessions.new_path(self.root)
        agent.messages += [{"role": "user", "content": "Set up the audit"}, {"role": "assistant", "content": "Done."}]
        self.assertTrue(agent._persist(), agent._last_persist_error)
        self.attach(agent.session_file.stem)
        self.later(1)
        run = self.finished(findings=[finding("GST total skips cess", "high"), finding("Typo", "low", line=2)])
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        ui = TUI(self.cfg, agent=agent)
        before = list(ui.active.blocks)
        with patch.object(LLMClient, "chat", side_effect=AssertionError("never a turn")):
            self.assertEqual(ui._look_for_pip_reports(force=True), 1)
            self.assertEqual(ui.active.blocks, before, "drawn on the UI loop, not from the reader thread")
            self.assertTrue(ui._service_pip_reports())
        text = "\n".join(str(block) for block in ui.active.blocks)
        self.assertIn("Pip 'ERP daily audit' finished: 2 findings (1 high, 1 low)", text)
        self.assertIn("/pips to open", text)
        saved = json.loads(Path(agent.session_file).read_text())["messages"]
        self.assertEqual([r["run_id"] for r in saved[-1][delivery.KEY]], [run], "the editor shows its card too")
        self.assertEqual(ui._look_for_pip_reports(force=True), 0, "once")

    def test_the_line_says_what_the_card_says(self):
        self.assertEqual(delivery.summary_line({"name": "GST watchdog", "outcome": "failed",
                                                "reason": "The project is too big for it to copy for review."}),
                         "Pip 'GST watchdog' failed: The project is too big for it to copy for review.")
        self.assertEqual(delivery.summary_line({"name": "Heartbeat", "outcome": "checks_failed",
                                                "checks": {"passed": 1, "failed": 1, "total": 2}}),
                         "Pip 'Heartbeat' finished: 1 of 2 checks failed")
        self.assertEqual(delivery.summary_line({"name": "Audit", "outcome": "clear"}), "Pip 'Audit' finished: nothing found")


class ReadToolTests(Scene):
    """The prepared prompt names the run; pips_context reads the whole report from it."""

    def test_the_report_the_card_names_reads_in_full_with_pips_context(self):
        from dgc import pip_context_tool
        run = self.finished(findings=[finding(f"Finding {n}", line=n) for n in range(1, 6)])
        ctx = SimpleNamespace(config=self.cfg, project_root=self.root)
        with patch("dgc.pip_access.require_unrestricted"):
            page = json.loads(pip_context_tool.read({"action": "report", "run_id": run}, ctx))
            rest = json.loads(pip_context_tool.read({"action": "report", "run_id": run, "offset": 3}, ctx))
        self.assertEqual((page["total_findings"], page["next_offset"]), (5, 3))
        self.assertEqual([f["title"] for f in page["findings"] + rest["findings"]],
                         [f"Finding {n}" for n in range(1, 6)])

    def test_the_tools_say_reports_come_by_themselves_and_are_not_requests(self):
        from dgc.tools import TOOL_SCHEMAS
        described = {tool["function"]["name"]: tool["function"]["description"] for tool in TOOL_SCHEMAS}
        self.assertIn("appears in this chat by itself", described["run_pip_now"])
        self.assertIn("never poll", described["run_pip_now"])
        self.assertIn("finished reports appear in this chat", described["attach_pip_to_session"])
        self.assertIn("not a request", described["pips_context"])
        self.assertIn("Do not use a monitor to watch Pips", described["monitor"])


class SdkTests(unittest.TestCase):
    """Both SDKs keep the new event and know the new commands, so an SDK client neither drops a report
    nor fails on one (the vendored copy is byte-identical: test_sdk_vendored_protocol)."""

    def test_the_vendored_protocol_accepts_the_event_and_commands_exactly(self):
        project = Path(__file__).resolve().parents[1]
        sys.path.insert(0, str(project / "sdk" / "python"))
        from dgc_sdk.wire import editor_protocol as sdk
        report = {"run_id": "run_" + "a" * 32, "pip_id": "pip_" + "b" * 32, "name": "Audit", "pip_type": "scout",
                  "outcome": "findings", "anything_later": True}
        self.assertIsNone(sdk.event_error({"type": "pip_report", "seq": 3, "report": report}))
        self.assertIsNotNone(sdk.event_error({"type": "pip_report", "seq": 3, "report": report, "extra": 1}))
        self.assertIsNotNone(sdk.event_error({"type": "pip_report", "seq": 3}))
        self.assertIsNone(sdk.command_error({"type": "watch_pip_reports"}))
        self.assertIsNone(sdk.command_error({"type": "pip_report_dismiss", "run_id": report["run_id"]}))
        self.assertIsNotNone(sdk.command_error({"type": "pip_report_dismiss"}))
        known = (project / "sdk" / "typescript" / "src" / "transport.ts").read_text()
        self.assertIn('"pip_report"', known.split("KNOWN_EVENTS", 1)[1].split("]);", 1)[0])


if __name__ == "__main__":
    unittest.main()
