"""Offline main-chat proposal drafting, permission and scope integration."""
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import config as config_module
from dgc import pip_context_tool, pip_proposal_tool, pips, sessions, tools, workspace_sessions
from dgc.agent import Agent
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine, READ_ONLY_TOOLS
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class PipProposalToolTests(unittest.TestCase):
    create = fixtures.LocalPipsTests.create

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        scope = patch.object(config_module, "USER_HOME", self.base / "home" / ".dgc")
        scope.start()
        self.addCleanup(scope.stop)

    def context(self, session_id="chat-one"):
        identity = self.registry.associate_session(session_id, self.root)
        return SimpleNamespace(config=self.cfg, project_root=self.root,
                               pip_proposal_origin=lambda: {"session_id": session_id,
                                                            "workspace_id": identity["workspace_id"]})

    def request(self, pip=None, **changes):
        pip = pip or self.create()
        return {"pip_id": pip["id"], "expected_version": 1, "changes": {"goal": "Inspect authorization checks."},
                "reason": "The project now has authenticated routes.", "request_key": "draft-1", **changes}

    def propose(self, args, ctx=None):
        ctx = ctx or self.context()
        with patch.object(pip_proposal_tool, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)):
            return json.loads(pip_proposal_tool.propose(args, ctx))

    def read(self, args):
        with patch.object(pip_context_tool, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)):
            return json.loads(pip_context_tool.read(args, self.context()))

    def agent(self):
        notes, approvals = [], []
        class UI:
            verdict = "no"
            deny_reason = ""
            def info(self, text):
                notes.append(text)
            def approve(self, name, args, call_id):
                approvals.append(name)
                return self.verdict
            def __getattr__(self, name):
                return lambda *a, **kw: None
        with patch("dgc.agent.discover_skills", return_value={}), patch("dgc.agent.load_memories", return_value=("", "")):
            agent = Agent(self.cfg, UI())
        # These tests exercise the Pips tools themselves; test_pips_tool_loading covers how a
        # chat loads them (use_pips).
        agent._pips_tools_loaded = True
        self.addCleanup(agent.mcp.stop_all)
        scope = patch.object(sessions, "SESSIONS_DIR", self.base / "session-files")
        scope.start()
        self.addCleanup(scope.stop)
        agent.session_file = sessions.new_path(self.root)
        return agent, approvals

    def test_the_tool_says_it_changes_a_model(self):
        # On a real project the model told the founder a Pip's model "isn't changeable through my tools" (2026-10-19,
        # and again 10-24). Since Pips API 66 this tool changes it itself, and says so first.
        from dgc import tools
        text = next(t["function"]["description"] for t in tools.TOOL_SCHEMAS if t["function"]["name"] == "pips_propose")
        self.assertIn("name, goal, model or context window", text.split(".")[0])
        self.assertIn("pips_context models", text)

    def test_an_allowed_change_is_applied_and_starts_no_work(self):
        # The tool call's permission (auto mode, an allow rule or the user's Allow) is the approval.
        pip = self.create()
        receipt = self.propose(self.request(pip))
        self.assertEqual(receipt["status"], "accepted")
        self.assertFalse(receipt["review_required"])
        self.assertTrue(receipt["job_changed_by_this_call"])
        self.assertFalse(receipt["execution_started"])
        self.assertEqual(self.store.get(pip["id"])["goal"], "Inspect authorization checks.")
        self.assertEqual(self.store.get(pip["id"])["current_version"], 2)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 0)
        author = self.registry.db.execute("SELECT actor FROM pip_proposals WHERE id=?", (receipt["proposal_id"],)).fetchone()[0]
        self.assertEqual(author, "core_proposal", "the chat drafted it")
        approval = self.registry.db.execute("SELECT status, resolved_by FROM pip_approvals WHERE proposal_id=?",
                                            (receipt["proposal_id"],)).fetchone()
        self.assertEqual(tuple(approval), ("approved", "chat-permission:default"), "the record says how it was approved")

    def test_a_providers_html_escaping_is_undone_in_a_name_or_goal(self):
        """ERP session review (2026-10-18): deepseek through Ollama sent "&amp;" in its tool call, and the Pip's name
        was saved with a literal &amp;."""
        pip = self.create()
        receipt = self.propose(self.request(pip, changes={"name": "GST watchdog &#8212; e-invoice &amp; e-way",
                                                          "goal": "Check IRN &amp; e-way bill numbers."}))
        self.assertEqual(receipt["status"], "accepted")
        saved = self.store.get(pip["id"])
        self.assertEqual(saved["name"], "GST watchdog — e-invoice & e-way")
        self.assertEqual(saved["goal"], "Check IRN & e-way bill numbers.")

    def test_a_change_that_cannot_be_applied_now_stays_a_proposal(self):
        pip = self.create()
        with patch.object(pips.PipStore, "accept", side_effect=RegistryError("pending_review", "Resolve the earlier review first.")):
            receipt = self.propose(self.request(pip))
        self.assertEqual(receipt["status"], "proposed")
        self.assertTrue(receipt["review_required"])
        self.assertFalse(receipt["job_changed_by_this_call"])
        self.assertIn("Resolve the earlier review first.", receipt["message"])
        self.assertEqual(self.store.get(pip["id"])["current_version"], 1)

    def test_request_replay_is_idempotent_and_changed_payload_conflicts(self):
        request = self.request()
        first, second = self.propose(request), self.propose(request)
        self.assertEqual((first["proposal_id"], first["status"]), (second["proposal_id"], second["status"]))
        self.assertFalse(second["job_changed_by_this_call"], "a replay changes nothing twice")
        self.assertIn("Already applied", second["message"])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_proposals").fetchone()[0], 1)
        self.assertEqual(self.store.get(request["pip_id"])["current_version"], 2)
        with self.assertRaises(RegistryError):
            self.propose({**request, "reason": "A different reason"})

    def test_retry_keys_are_scoped_to_the_owning_session(self):
        request = self.request()
        first = self.propose(request, self.context("chat-one"))
        second = self.propose({**request, "expected_version": 2, "changes": {"goal": "Inspect session handling."}},
                              self.context("chat-two"))
        self.assertNotEqual(first["proposal_id"], second["proposal_id"])

    def test_disabled_and_malformed_inputs_never_open_registry(self):
        self.cfg.data["pips_enabled"] = "true"
        with patch.object(pip_proposal_tool, "WorkspaceRegistry", side_effect=AssertionError("must not open")):
            with self.assertRaisesRegex(RegistryError, "disabled"):
                pip_proposal_tool.propose({}, SimpleNamespace(config=self.cfg))
        self.cfg.data["pips_enabled"] = True
        request = self.request()
        malformed = [None, {}, {**request, "expected_version": True}, {**request, "expected_version": 0},
                     {**request, "request_key": "../escape"}, {**request, "reason": ""},
                     {**request, "reason": "private\x00data"}, {**request, "changes": {}},
                     {**request, "changes": {"goal": "x" * 4001}},
                     {**request, "changes": {"goal": "\ud800"}},
                     {**request, "changes": {"source_ref": "HEAD;touch /tmp/x"}},
                     {**request, "changes": {"source_ref": "../main"}},
                     {**request, "changes": {"goal": "𝄞" * 4000}, "reason": "𝄞" * 1000}]
        for value in malformed:
            with self.subTest(value=type(value)), patch.object(pip_proposal_tool, "WorkspaceRegistry", side_effect=AssertionError("must not open")), \
                 self.assertRaises(RegistryError):
                pip_proposal_tool.propose(value, self.context())

    def test_forbidden_authority_fields_are_rejected(self):
        request = self.request()
        for key in ("workspace_id", "session_id", "model", "policy", "trigger", "schedule", "accept", "action", "root"):
            for value in ({**request, key: "injected"}, {**request, "changes": {key: "injected"}}):
                with self.subTest(key=key), self.assertRaises(RegistryError):
                    self.propose(value)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_proposals").fetchone()[0], 0)

    def test_cross_workspace_pips_and_origin_sessions_are_refused(self):
        other = self.base / "other"
        other.mkdir()
        workspace = self.registry.resolve(other)
        pip = self.store.create(workspace["id"], "Other", "PRIVATE_OTHER_GOAL", "user")
        with self.assertRaisesRegex(RegistryError, "not found"):
            self.propose(self.request(pip))
        own = self.create()
        self.registry.associate_session("other-chat", other)
        forged = SimpleNamespace(config=self.cfg, project_root=self.root,
                                 pip_proposal_origin=lambda: {"session_id": "other-chat", "workspace_id": self.workspace["id"]})
        with self.assertRaisesRegex(RegistryError, "authoritative"):
            self.propose(self.request(own), forged)

    def test_stale_version_is_refused(self):
        pip = self.create()
        first = self.store.propose(pip["id"], 1, {"goal": "New goal"}, "user")
        self.store.accept(pip["id"], first["id"], 1, "user")
        with self.assertRaisesRegex(RegistryError, "changed"):
            self.propose(self.request(pip))

    def test_secrets_are_redacted_before_storage_and_receipt(self):
        secret = "fixture-secret-value-abcdef"
        self.cfg.set("api_key", secret, persist=False)
        request = self.request(changes={"goal": "Never print " + secret}, reason="Remove " + secret)
        receipt = self.propose(request)
        stored = self.registry.db.execute("SELECT definition,reason FROM pip_proposals WHERE id=?", (receipt["proposal_id"],)).fetchone()
        self.assertNotIn(secret, str(tuple(stored)))
        self.assertNotIn(secret, json.dumps(receipt))
        with self.assertRaises(RegistryError):
            self.propose({**request, "request_key": secret})

    def test_draft_permission_preserves_plan_and_explicit_denials(self):
        self.assertNotIn("pips_propose", READ_ONLY_TOOLS)
        for mode, expected in (("default", ASK), ("acceptEdits", ASK), ("plan", DENY), ("auto", ALLOW)):
            with self.subTest(mode=mode):
                self.assertEqual(PermissionEngine(mode, {}, self.root).decide("pips_propose", {"pip_id": "x"})[0], expected)
                self.assertEqual(PermissionEngine(mode, {"deny": ["PipsPropose"], "allow": ["PipsPropose"]}, self.root)
                                 .decide("pips_propose", {"pip_id": "x"})[0], DENY)
        self.assertIn("PipsPropose", pips.native_policy()["deny"])

    def test_agent_catalog_and_execution_gate_main_chat_only(self):
        agent, _ = self.agent()
        for profile in ("standard", "adaptive", "full"):
            self.cfg.data["tool_profile"] = profile
            self.assertIn("pips_propose", {s["function"]["name"] for s in agent._tool_schemas()})
        request = self.request()
        agent.depth = 1
        self.assertNotIn("pips_propose", {s["function"]["name"] for s in agent._tool_schemas()})
        with patch.object(pip_proposal_tool, "WorkspaceRegistry", side_effect=AssertionError("child must not open registry")):
            self.assertIn("main user chat", agent._handle_call(ToolCall("child", "pips_propose", request)))
        with self.assertRaisesRegex(RegistryError, "main user chat"):
            agent.ctx.pip_proposal_origin()
        agent.depth = 0
        agent._monitor_turn = True
        self.assertNotIn("pips_propose", {s["function"]["name"] for s in agent._tool_schemas()})
        with patch.object(pip_proposal_tool, "WorkspaceRegistry", side_effect=AssertionError("monitor must not open registry")):
            self.assertIn("main user chat", agent._handle_call(ToolCall("monitor", "pips_propose", request)))
        agent._monitor_turn = False
        self.cfg.data["pips_enabled"] = False
        self.assertNotIn("pips_propose", {s["function"]["name"] for s in agent._tool_schemas()})

    def test_agent_denial_or_declined_prompt_never_drafts(self):
        agent, approvals = self.agent()
        request = self.request()
        with patch.object(pip_proposal_tool, "propose", side_effect=AssertionError("denied mutation executed")):
            self.cfg.permissions["deny"] = ["PipsPropose"]
            self.cfg.data["mode"] = "auto"
            self.assertIn("DENIED", agent._handle_call(ToolCall("d1", "pips_propose", request)))
            self.cfg.permissions["deny"] = []
            self.cfg.permissions["ask"] = ["PipsPropose"]
            self.cfg.data["mode"] = "default"
            self.assertIn("DENIED", agent._handle_call(ToolCall("d2", "pips_propose", request)))
            self.assertEqual(approvals, ["pips_propose"])

    def test_local_model_tool_roundtrip_asks_once_and_applies(self):
        agent, approvals = self.agent()
        agent.ui.verdict = "once"
        self.cfg.data.update(mode="default", api_mode="ollama")
        request = self.request()
        responses = iter([ChatResult(tool_calls=[ToolCall("draft", "pips_propose", request)]),
                          ChatResult(content="Done: its goal now covers authorization checks.")])
        sent = []
        def chat(client, messages, **kwargs):
            sent.append((copy.deepcopy(messages), copy.deepcopy(kwargs.get("tools", []))))
            return next(responses)
        with patch.object(pip_proposal_tool, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(workspace_sessions, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(LLMClient, "chat", chat), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            self.assertTrue(agent.run_turn("Propose a narrower goal for the existing audit Pip."))
        self.assertIn("pips_propose", str(sent[0][1]))
        self.assertEqual(approvals, ["pips_propose"], "asked once, like any tool call")
        self.assertIn('"job_changed_by_this_call":true', str(sent[-1][0]))
        self.assertEqual(self.store.get(request["pip_id"])["current_version"], 2)

    def test_definition_read_is_scoped_paginated_and_bounded(self):
        pip = self.create()
        for i in range(4):
            self.store.propose(pip["id"], 1, {"goal": "Draft " + str(i)}, "user", "Reason " + str(i))
        result = self.read({"action": "definition", "pip_id": pip["id"], "limit": 2})
        self.assertEqual(result["pip"]["goal"], pip["goal"])
        self.assertEqual(result["pip"]["adaptation_policy"], {"mode": "suggest_changes", "allowed_fields": []})
        self.assertEqual(len(result["proposals"]), 2)
        self.assertEqual(result["next_offset"], 2)
        self.assertLess(len(json.dumps(result).encode()), pip_context_tool.MAX_OUTPUT_BYTES)
        other = self.base / "other"
        other.mkdir()
        alien = self.store.create(self.registry.resolve(other)["id"], "Secret", "PRIVATE_OTHER_GOAL", "user")
        with self.assertRaisesRegex(RegistryError, "not found"):
            self.read({"action": "definition", "pip_id": alien["id"]})


if __name__ == "__main__":
    unittest.main()
