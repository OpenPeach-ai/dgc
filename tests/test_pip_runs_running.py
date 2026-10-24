"""A Pip that reports to a chat is seen running there: `pip_runs_running`, the chip above the box.

The founder (24 Oct): his Work chat said nothing while a Pip that reports to it ran, until its card arrived. Pip
runs happen in the Pips runner, not in the chat's session, so the chat reads which of ITS Pips are running from the
registry (dgc/pip_report_delivery.py running) and is told whenever that changes, once its client asks
(watch_pip_runs, ready.capabilities.pip_runs_running). An older editor, the SDK or ACP never asks and is sent none:
a new event, never a field on an existing one.

Real registry, real runs, a real Backend whose frames go through the protocol validator, and a real saved session.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import pip_report_delivery as delivery
from dgc.headless import Backend
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import identifier
from tests.test_pip_report_delivery import Scene, Wire, finding


class Runs(Scene):
    """A Scene with runs that are still going."""

    def started(self, *, pip=None, kind="audit", requested_by="fixture", trigger="manual", key=None,
                status="running", extra=None):
        pip = pip or self.pip
        binding = self.registry.binding(self.workspace["id"])
        run_id = identifier("run")
        manifest = {"pip_id": pip["id"], "workspace_id": self.workspace["id"], "job_version": pip["current_version"],
                    "source_revision": "a" * 40, "model": "fixture-model", "run_kind": kind, "trigger": trigger,
                    "workspace_context": ContextStore(self.registry).snapshot(self.workspace["id"]), **(extra or {})}
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""", (run_id, pip["id"], self.workspace["id"], binding["id"], key or run_id,
                                              requested_by, json.dumps(manifest), status, self.now,
                                              None if status == "queued" else self.now))
        return run_id

    def end(self, run_id, findings=()):
        self.store.finish(run_id, result={"summary": "Billing review", "findings": list(findings),
                                          "limitations": [], "tests_executed": False})

    def running(self, session_id):
        self.registry.db.execute("BEGIN")
        try:
            return delivery.running(self.registry, session_id)
        finally:
            self.registry.db.rollback()


class WhichRunsTests(Runs):
    def test_a_running_audit_of_a_pip_attached_here_is_named_with_when_and_how_it_started(self):
        chat = self.chat()
        self.attach(chat)
        self.later(1)
        run = self.started(trigger="schedule")
        self.assertEqual(self.running(chat), [{"run_id": run, "pip_id": self.pip["id"], "name": "ERP daily audit",
                                               "pip_type": "scout", "started_at": self.now, "trigger": "schedule"}])

    def test_a_pip_that_reports_to_another_chat_shows_nothing_here(self):
        here, there = self.chat("chat-here"), self.chat("chat-there")
        self.attach(there)
        self.started()
        self.assertEqual(self.running(here), [])
        self.assertEqual(len(self.running(there)), 1)

    def test_the_run_this_chat_started_is_listed_and_one_another_chat_started_is_not(self):
        here, there = self.chat("chat-here"), self.chat("chat-there")
        mine = self.started(requested_by=delivery.chat_identity(here), trigger="main_chat")
        self.started(requested_by=delivery.chat_identity(there), trigger="main_chat")
        self.assertEqual([(r["run_id"], r["trigger"]) for r in self.running(here)], [(mine, "chat")])

    def test_only_runs_whose_end_is_a_card_here_and_only_while_they_run(self):
        chat = self.chat()
        self.attach(chat)
        self.started(kind="conversation")                      # a reply in the Pip's own chat
        self.started(kind="draft")                             # a Quill draft stays in Pips
        self.started(kind="test")                              # a handoff's test run: reviewed where it was handed
        self.started(kind="patch")
        self.started(status="queued")                          # not started yet
        live = self.started(kind="live")
        checks = self.started(kind="test", extra={"pulse_verification": {"schema_version": 1}})
        audit = self.started()
        self.assertEqual({r["run_id"] for r in self.running(chat)}, {live, checks, audit})
        self.end(audit)
        self.assertEqual({r["run_id"] for r in self.running(chat)}, {live, checks}, "a finished run leaves")
        self.registry.db.execute("UPDATE pip_runs SET status='cancelling' WHERE id=?", (live,))
        self.assertIn(live, {r["run_id"] for r in self.running(chat)}, "still going while it stops")

    def test_how_it_started_in_the_words_the_editor_uses(self):
        chat = self.chat()
        self.attach(chat)
        cases = {"schedule": self.started(trigger="schedule"), "event": self.started(trigger="event"),
                 "you": self.started(trigger="manual"), "handoff": self.started(trigger="handoff"),
                 "setup": self.started(trigger="manual", key="setup-" + identifier("setup"))}
        said = {r["run_id"]: r["trigger"] for r in self.running(chat)}
        self.assertEqual({word: said[run] for word, run in cases.items()}, {word: word for word in cases})

    def test_an_archived_pip_and_a_chat_with_no_project_say_nothing(self):
        chat = self.chat()
        self.attach(chat)
        self.started()
        self.assertEqual(self.running("chat-never-opened"), [])
        self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (self.pip["id"],))
        self.assertEqual(self.running(chat), [])


class BackendTests(Runs):
    def make(self, *, watch=True):
        self.wire = Wire()
        with patch("dgc.trust.is_trusted", return_value=True), patch.object(sys, "stdout", self.wire):
            backend = Backend(self.cfg)
        self.addCleanup(lambda: backend.agent.mcp.stop_all())
        backend.agent.messages = [backend.agent.messages[0], {"role": "user", "content": "Set up a daily audit"},
                                  {"role": "assistant", "content": "Done."}]
        self.assertTrue(backend.agent._persist(), backend.agent._last_persist_error)
        self.session = backend.agent.session_file.stem
        self.attach(self.session)
        self.later(1)
        if watch:
            backend.dispatch({"type": "watch_pip_runs", "request_id": "w1"})
        return backend

    def told(self):
        frames = self.wire.of("pip_runs_running")
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        return frames

    def test_ready_offers_it_and_a_client_that_never_asks_is_sent_none(self):
        backend = self.make(watch=False)
        ready = backend._ready_payload()
        self.assertEqual(ready["capabilities"]["pip_runs_running"], 1)
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 0, **ready}))
        self.started()
        self.assertFalse(backend._look_for_pip_runs(force=True))
        self.assertEqual(self.told(), [], "an older editor, the SDK and ACP never see it")

    def test_asked_it_answers_at_once_then_says_when_a_run_starts_and_ends(self):
        backend = self.make()
        [first] = self.told()
        self.assertEqual((first["items"], first["request_id"]), ([], "w1"), "none running: an empty list, answered")
        run = self.started(trigger="schedule")
        self.assertTrue(backend._look_for_pip_runs())
        frame = self.told()[-1]
        self.assertNotIn("request_id", frame, "unasked, as it changed")
        self.assertEqual([(i["run_id"], i["name"], i["trigger"], i["started_at"]) for i in frame["items"]],
                         [(run, "ERP daily audit", "schedule", self.now)])
        self.assertFalse(backend._look_for_pip_runs(force=True), "nothing changed: nothing said again")
        self.end(run, [finding("Rounding drops paise")])
        self.assertTrue(backend._look_for_pip_runs())
        self.assertEqual(self.told()[-1]["items"], [], "it ended: the chip goes")
        self.assertEqual(len(self.told()), 3)

    def test_the_watch_loop_tells_it_beside_the_card(self):
        backend = self.make()
        backend.dispatch({"type": "watch_pip_reports"})
        run = self.started()
        backend._look_for_pip_reports(force=True)
        backend._look_for_pip_runs(force=True)
        self.assertEqual([i["run_id"] for i in self.told()[-1]["items"]], [run])
        self.end(run, [finding("GST total skips cess", "high")])
        backend._look_for_pip_reports(force=True)
        backend._look_for_pip_runs(force=True)
        self.assertEqual(self.told()[-1]["items"], [])
        self.assertEqual([f["report"]["run_id"] for f in self.wire.of("pip_report")], [run], "and the card arrives")

    def test_a_pip_attached_to_another_chat_is_not_this_chats_news(self):
        backend = self.make()
        other = self.store.create(self.workspace["id"], "Billing audit", "Inspect billing.", "fixture", pip_type="rook")
        self.attach(self.chat("chat-elsewhere"), other)
        self.started(pip=other)
        backend._look_for_pip_runs(force=True)
        self.assertEqual(self.told()[-1]["items"], [])

    def test_the_command_and_event_are_in_the_protocol_and_the_sdks(self):
        self.assertIsNone(ep.command_error({"type": "watch_pip_runs"}))
        self.assertIsNone(ep.command_error({"type": "watch_pip_runs", "request_id": "r"}))
        self.assertIsNone(ep.event_error({"type": "pip_runs_running", "seq": 1, "items": [{"run_id": "x", "later": 1}]}))
        self.assertIsNotNone(ep.event_error({"type": "pip_runs_running", "seq": 1}))
        self.assertIsNotNone(ep.event_error({"type": "pip_runs_running", "seq": 1, "items": [], "extra": 1}))
        project = Path(__file__).resolve().parents[1]
        self.assertEqual((project / "sdk/python/dgc_sdk/wire/editor_protocol.py").read_text(),
                         (project / "dgc/editor_protocol.py").read_text())
        known = (project / "sdk/typescript/src/transport.ts").read_text()
        self.assertIn('"pip_runs_running"', known.split("KNOWN_EVENTS", 1)[1].split("]);", 1)[0])


if __name__ == "__main__":
    unittest.main()
