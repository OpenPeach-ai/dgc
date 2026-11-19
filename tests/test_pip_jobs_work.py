"""@ a Pip from a Work session: the tool is always offered while Pips are on, the job is asked from the session, and the
answer comes back to the session's model once, in DGC's own words, as a turn of its own (0.52, Pips API 111).

A real registry, a real Agent with a scripted model, a real Backend whose frames go through the protocol validator; the
Pip's run is claimed and finished through the store as the Pips runner does.
"""
from __future__ import annotations

import json
import threading
import types
import unittest
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import pip_jobs, pip_levels, sessions
from dgc.agent import Agent
from dgc.headless import Backend, HeadlessUI
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import ALLOW, PermissionEngine
from dgc.protocol import PendingRequests
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_pip_proposal_tool as agent_fixtures


class WorkWorld:
    agent = agent_fixtures.PipProposalToolTests.agent

    def setUp(self):
        agent_fixtures.PipProposalToolTests.setUp(self)
        self.pip = self.store.create(self.registry.personal()["id"], "Scout", "Look things up.", "editor-user",
                                     pip_type="scout")
        pip_levels.set_level(self.registry, self.pip["id"], pip_levels.APPROVE, "editor-user")
        directory = self.registry.directory
        for patcher in (patch("dgc.workspace_registry.WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(directory)),
                        patch("dgc.workspace_registry.in_use", return_value=True),
                        patch("dgc.pip_jobs.ensure_runner", return_value=None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def offered(self, agent):
        return {entry["function"]["name"] for entry in agent._tool_schemas()}


class TheToolIsAlwaysOffered(WorkWorld, unittest.TestCase):
    def test_offered_every_turn_while_pips_are_on_whatever_the_prompt_says(self):
        agent, _ = self.agent()
        agent._pips_tools_loaded = False                  # nothing loaded with use_pips, nothing in the prompt
        self.assertIn("ask_pip", self.offered(agent))
        self.assertNotIn("handoff_to_pip", self.offered(agent), "the older proposal tool is no longer offered")
        agent._pips_tools_loaded = True
        self.assertIn("ask_pip", self.offered(agent))
        self.assertNotIn("handoff_to_pip", self.offered(agent))

    def test_never_where_pips_are_off_in_a_helper_a_monitor_turn_or_plan_mode(self):
        agent, _ = self.agent()
        for kind in ("off", "child", "monitor", "plan"):
            with self.subTest(kind=kind):
                self.cfg.data["pips_enabled"] = kind != "off"
                agent.depth = 1 if kind == "child" else 0
                agent._monitor_turn = kind == "monitor"
                self.cfg.data["mode"] = "plan" if kind == "plan" else "default"
                self.assertNotIn("ask_pip", self.offered(agent))
        self.cfg.data["pips_enabled"], agent.depth, agent._monitor_turn, self.cfg.data["mode"] = True, 0, False, "default"
        self.assertIn("ask_pip", self.offered(agent))

    def test_it_needs_no_card_in_any_mode_but_plan(self):
        for mode in ("default", "acceptEdits", "auto"):
            self.assertEqual(PermissionEngine(mode, {}, self.root).decide("ask_pip", {"pip": "Scout", "job": "x"})[0], ALLOW)

    def test_a_named_pip_is_told_to_the_model_on_its_prompt(self):
        agent, _ = self.agent()
        agent._prompt_display_mentions = [{"start": 0, "kind": "pip", "label": "Scout", "identity": self.pip["id"],
                                           "pip_type": "scout"}]
        note = agent._named_pips_note()
        self.assertIn("Scout", note)
        self.assertIn("ask_pip", note)
        self.assertIn("Approve for me", note)
        agent._prompt_display_mentions = []
        self.assertEqual(agent._named_pips_note(), "")


class TheSessionAsks(WorkWorld, unittest.TestCase):
    def test_the_job_is_asked_from_the_session_with_its_title_and_folder(self):
        agent, _ = self.agent()
        agent.session_name = "Tidy the October invoices"
        out = agent._handle_call(ToolCall("j1", "ask_pip", {"pip": "@Scout", "job": "check the totals",
                                                             "about": "invoices.py"}))
        self.assertIn("Handed to Scout", out)
        [row] = self.registry.db.execute("SELECT * FROM pip_jobs").fetchall()
        self.assertEqual((row["asked_kind"], row["asked_id"], row["asked_title"]),
                         ("work", agent.session_file.stem, "Tidy the October invoices"))
        self.assertEqual(row["project_id"], self.workspace["id"], "about this session's folder")
        self.assertIn(row["id"], out, "the card in the transcript finds the job by its id")
        again = agent._handle_call(ToolCall("j2", "ask_pip", {"pip": "@Scout", "job": "check the totals",
                                                               "about": "invoices.py"}))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_jobs").fetchone()[0], 1,
                         "the same job twice in one turn is one job")
        self.assertIn(row["id"], again)

    def test_a_pip_that_isnt_there_is_said_plainly(self):
        agent, _ = self.agent()
        out = agent._handle_call(ToolCall("j1", "ask_pip", {"pip": "Nobody", "job": "x"}))
        self.assertIn("No Pip is named", out)
        self.assertIn("Scout", out)


class TheAnswerComesBack(WorkWorld, unittest.TestCase):
    def backend(self):
        events, condition = [], threading.Condition()

        def emit(_event_type, /, **fields):
            event = {"type": _event_type, **fields}
            self.assertIsNone(ep.event_error({"seq": 1, **event}), event)
            with condition:
                events.append(event)
                condition.notify_all()
        emitter = types.SimpleNamespace(emit=emit)
        backend = object.__new__(Backend)
        backend.config, backend.em, backend.pending = self.cfg, emitter, PendingRequests()
        backend.ui = HeadlessUI(emitter, backend.pending, approval_timeout_s=3)
        with patch("dgc.agent.discover_skills", return_value={}), patch("dgc.agent.load_memories", return_value=("", "")):
            backend.agent = Agent(self.cfg, backend.ui)
        self.addCleanup(backend.agent.mcp.stop_all)
        scope = patch.object(sessions, "SESSIONS_DIR", self.base / "session-files")
        scope.start()
        self.addCleanup(scope.stop)
        backend.agent.session_file = sessions.new_path(self.root)
        backend._queue, backend._steer_payloads = [], {}
        backend._worker, backend._foreground_worker, backend._turn_n = None, None, 0
        backend._turn_lock, backend.workspace_trusted = threading.RLock(), True
        backend._emit_context = lambda: None
        backend._agents_timer, backend._agents_timer_lock = None, threading.Lock()
        backend._agent_wakes = []
        return backend, events, condition

    def test_the_model_is_told_once_in_dgcs_words_with_a_turn_of_its_own(self):
        backend, events, condition = self.backend()
        seen = []

        def chat(client, messages, **kwargs):
            seen.append(json.loads(json.dumps(messages, default=str)))
            last = messages[-1]
            text = last.get("content") if isinstance(last.get("content"), str) else ""
            if pip_jobs.NOTICE_HEAD in text:
                return ChatResult(content="Scout says the totals are right.")
            if last.get("role") == "tool":
                return ChatResult(content="Scout has it.")
            return ChatResult(tool_calls=[ToolCall("a1", "ask_pip", {"pip": "Scout", "job": "check the totals"})])
        with patch.object(LLMClient, "chat", chat):
            self.assertTrue(backend.agent.run_turn("@Scout check the totals"))
            [row] = self.registry.db.execute("SELECT * FROM pip_jobs").fetchall()
            self.assertEqual(backend._look_for_pip_jobs(force=True), 0, "nothing to tell while it works")
            run = self.store.claim_next()
            self.store.finish(run["id"], result={"text": "The totals add up."})
            with patch.object(backend, "_maybe_wake"):          # (its turn is started below, once)
                self.assertEqual(backend._look_for_pip_jobs(force=True), 1)
                with backend._turn_state_lock():
                    taken = backend._take_pip_job_wake_locked()  # (as the turn worker takes it, before its turn runs)
                self.assertIsNotNone(taken)
                self.assertEqual(backend._look_for_pip_jobs(force=True), 0, "never queued twice while its turn runs")
            with backend._turn_state_lock():
                backend.__dict__["_pip_job_wakes"].insert(0, taken)
            backend._maybe_wake()
            with condition:
                self.assertTrue(condition.wait_for(lambda: any(e["type"] == "turn_end" for e in events), timeout=20),
                                [e["type"] for e in events])
            self.assertEqual(backend._look_for_pip_jobs(force=True), 0, "told once")
        [start] = [e for e in events if e["type"] == "turn_start"]
        self.assertEqual((start["kind"], start["prompt"]), ("monitor", "pip-job: Scout · answered"))
        told = seen[-1][-1]["content"]
        self.assertTrue(told.startswith(pip_jobs.NOTICE_HEAD))
        self.assertIn("The totals add up.", told)
        self.assertIsNotNone(self.registry.db.execute("SELECT delivered_at FROM pip_jobs WHERE id=?",
                                                      (row["id"],)).fetchone()[0])
        # A reload draws the same turn: DGC's note, never a prompt of the user's.
        replayed = [i for i in backend._history() if i.get("type") == "turn_start"]
        self.assertEqual([(i["kind"], i["prompt"]) for i in replayed],
                         [("prompt", "@Scout check the totals"), ("monitor", "pip-job: Scout · answered")])
        from dgc.agent import _real_user_turns
        self.assertEqual(len(_real_user_turns(backend.agent.messages)), 1, "the notice is never the user's own words")
        rows = sessions.display_rows(backend.agent.messages)
        self.assertEqual([r["who"] for r in rows if r["who"] != "assistant"], ["user", "pip_job"])


if __name__ == "__main__":
    unittest.main()
