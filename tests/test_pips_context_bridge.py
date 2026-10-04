"""Offline integration of context pinning, read-only chat access and job revisions."""
import copy
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pips, pip_context_tool, tools
from dgc.agent import Agent
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.mcp import MCPManager
from dgc.permissions import PermissionEngine, DENY
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class PipsContextBridgeTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create
    enqueue = fixtures.LocalPipsTests.enqueue

    def read(self, **args):
        with patch.object(pip_context_tool, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)):
            return json.loads(pip_context_tool.read(args, SimpleNamespace(config=self.cfg, project_root=self.root)))

    def record(self, content="Review deployments visually.", revision=0):
        return ContextStore(self.registry).record(self.workspace["id"], "decision", "Release checks", content, revision, "user")

    def test_queue_pins_context_and_idempotency_never_refreshes_it(self):
        self.commit()
        self.record()
        pip = self.create()
        run = self.enqueue(pip)
        pinned = run["manifest"]["workspace_context"]
        self.record("New decision", 1)
        self.assertEqual(self.enqueue(pip)["manifest"]["workspace_context"], pinned)
        later = self.enqueue(pip, "later")
        self.assertEqual(later["manifest"]["workspace_context"]["revision"], 2)
        compact = next(r for r in self.store.runs(pip["id"]) if r["id"] == later["id"])
        self.assertEqual(compact["manifest"]["context_revision"], 2)
        self.assertNotEqual(pinned["digest"], later["manifest"]["workspace_context"]["digest"])

    def test_chat_context_is_own_workspace_only_and_redacts_credentials(self):
        self.cfg.set("api_key", "fixture-known-secret-123", persist=False)
        self.record("Never publish fixture-known-secret-123")
        other = self.base / "other"
        other.mkdir()
        other_id = self.registry.resolve(other)["id"]
        ContextStore(self.registry).record(other_id, "decision", "Private", "OTHER_WORKSPACE_ONLY", 0, "user")
        value = self.read(action="context")
        self.assertEqual(value["context"]["revision"], 1)
        self.assertNotIn("fixture-known-secret-123", json.dumps(value))
        self.assertNotIn("OTHER_WORKSPACE_ONLY", json.dumps(value))
        self.assertNotIn("digest", value["context"])
        with self.assertRaisesRegex(RegistryError, "Unsupported"):
            self.read(action="context", workspace_id=other_id)

    def test_disabled_read_never_opens_database(self):
        self.cfg.data["pips_enabled"] = False
        with patch.object(pip_context_tool, "WorkspaceRegistry", side_effect=AssertionError("must not open")):
            with self.assertRaisesRegex(RegistryError, "disabled"):
                pip_context_tool.read({"action": "list"}, SimpleNamespace(config=self.cfg, project_root=self.root))

    def test_unregistered_directory_is_not_created_by_read(self):
        self.root = self.base / "unregistered"
        self.root.mkdir()
        self.assertFalse(self.read(action="list")["registered"])
        self.assertEqual(len(self.registry.list()), 1)

    def test_list_pages_without_job_mutation(self):
        for i in range(4):
            self.store.create(self.workspace["id"], str(i), "Long goal " * 100, "user")
        first = self.read(action="list", limit=2)
        second = self.read(action="list", limit=2, offset=first["next_offset"])
        self.assertEqual(len(first["pips"]), 2)
        self.assertTrue(first["pips"][0]["goal_truncated"])
        self.assertIsNone(second["next_offset"])
        self.assertEqual(len({p["id"] for p in first["pips"] + second["pips"]}), 4)

    def test_mutations_and_bad_cursors_are_refused(self):
        for args in ({"action": "run"}, {"action": "context", "accept": True},
                     {"action": "list", "offset": True}, {"action": "list", "limit": 11},
                     {"action": "activity", "after": -1}, {"action": "report", "run_id": []}):
            with self.subTest(args=args), self.assertRaises(RegistryError):
                self.read(**args)

    def test_report_is_scoped_and_preserves_finding_indexes(self):
        self.commit()
        run = self.enqueue()
        self.store.claim_next()
        self.store.finish(run["id"], result={"summary": "Static review", "findings": [
            {"title": str(i), "severity": "low", "path": "source.py", "line": 2, "evidence": "    return 'hello'", "verification": "source_excerpt_only"} for i in range(5)], "limitations": [], "tests_executed": False, "verification": 'Source excerpts checked against the pinned snapshot; findings are model assessments.'})
        first = self.read(action="report", run_id=run["id"], limit=2)
        self.assertEqual([f["finding_index"] for f in first["findings"]], [0, 1])
        self.assertEqual(first["next_offset"], 2)
        self.assertNotIn("model_settings", str(first))
        other = self.base / "other"
        other.mkdir()
        self.registry.resolve(other)
        self.root = other
        with self.assertRaisesRegex(RegistryError, "not found in this project's Pips"):
            self.read(action="report", run_id=run["id"])

    def test_multibyte_context_is_bounded_valid_json(self):
        self.record("界" * 1300)
        value = self.read(action="context")
        self.assertLess(len(json.dumps(value, ensure_ascii=False).encode()), pip_context_tool.MAX_OUTPUT_BYTES)
        self.assertEqual(value["context"]["entries"][0]["content"], "界" * 1300)

    def test_oversized_stored_report_is_rejected_before_json_parse(self):
        self.commit()
        run = self.enqueue()
        self.store.claim_next()
        # Corrupt-storage fixture bypasses the completion writer, which now refuses this.
        self.registry.db.execute("UPDATE pip_runs SET status='succeeded',result=? WHERE id=?",
                                 (json.dumps({"summary": "x" * 140000}), run["id"]))
        with patch.object(pip_context_tool.json, "loads", side_effect=AssertionError("must not parse")), \
             self.assertRaisesRegex(RegistryError, "Stored run exceeds"):
            self.read(action="report", run_id=run["id"])

    def test_oversized_stored_job_is_rejected_before_json_parse(self):
        pip = self.create()
        self.registry.db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)",
                                 (pip["id"], 2, "x" * 25000, "fixture", "corrupt fixture", self.registry.clock()))
        self.registry.db.execute("UPDATE pips SET current_version=2 WHERE id=?", (pip["id"],))
        with patch.object(pip_context_tool.json, "loads", side_effect=AssertionError("must not parse")), \
             self.assertRaisesRegex(RegistryError, "Stored job exceeds"):
            self.read(action="list")

    def test_activity_excludes_unbounded_payloads_and_pages(self):
        for i in range(5):
            self.registry.event(self.workspace["id"], "fixture", payload={"private": "not needed for timeline"})
        first = self.read(action="activity", limit=2)
        self.assertTrue(first["has_more"])
        self.assertNotIn("private", str(first))
        second = self.read(action="activity", after=first["next_cursor"], limit=2)
        self.assertGreater(second["events"][0]["seq"], first["events"][-1]["seq"])

    def test_reject_and_accept_have_immutable_paginated_versions(self):
        pip = self.create()
        first = self.store.propose(pip["id"], 1, {"goal": "Rejected goal"}, "user")
        self.store.reject(pip["id"], first["id"], 1, "user")
        self.assertEqual(self.store.get(pip["id"])["current_version"], 1)
        self.assertEqual(self.store.get(pip["id"])["proposals"], [])
        obsolete = self.store.propose(pip["id"], 1, {"goal": "Other proposal"}, "user")
        chosen = self.store.propose(pip["id"], 1, {"goal": "Approved goal"}, "user")
        self.store.accept(pip["id"], chosen["id"], 1, "user")
        self.assertEqual(self.store.get(pip["id"])["proposals"], [])
        self.assertEqual(self.registry.db.execute("SELECT status FROM pip_proposals WHERE id=?", (obsolete["id"],)).fetchone()[0], "superseded")
        first_page = self.store.versions(pip["id"], limit=1)
        old = self.store.versions(pip["id"], before_version=first_page["next_before_version"], limit=1)
        self.assertEqual(first_page["versions"][0]["version"], 2)
        self.assertEqual(old["versions"][0]["definition"]["goal"], "Inspect correctness.")
        self.assertIsNone(old["next_before_version"])
        for args in ({"limit": True}, {"limit": 21}, {"before_version": -1}):
            with self.assertRaises(RegistryError):
                self.store.versions(pip["id"], **args)

    def agent(self):
        class UI:
            def __getattr__(self, name):
                return lambda *a, **kw: None
        manager = MCPManager(self.root)
        self.addCleanup(manager.stop_all)
        with patch("dgc.agent.discover_skills", return_value={}), patch("dgc.agent.load_memories", return_value=("", "")):
            agent = Agent(self.cfg, UI(), mcp=manager)
        agent._pips_tools_loaded = True     # the Pips tools under test; use_pips is tested on its own
        return agent

    def test_agent_advertises_only_when_enabled_and_honours_deny(self):
        agent = self.agent()
        self.assertIn("pips_context", {s["function"]["name"] for s in agent._tool_schemas()})
        self.cfg.data["pips_enabled"] = False
        self.assertNotIn("pips_context", {s["function"]["name"] for s in agent._tool_schemas()})
        self.assertIn("disabled", agent._handle_call(ToolCall("r", "pips_context", {"action": "list"})))
        self.cfg.data["pips_enabled"] = True
        self.cfg.permissions["deny"] = ["PipsContext"]
        self.assertEqual(PermissionEngine("default", self.cfg.permissions, self.root).decide("pips_context", {"action": "context"})[0], DENY)
        self.assertIn("PipsContext", pips.native_policy()["deny"])

    def test_real_agent_turn_reads_context_with_no_network(self):
        self.record("CONTEXT_REFERENCE_FIXTURE")
        agent = self.agent()
        replies = iter([ChatResult(tool_calls=[ToolCall("readctx", "pips_context", {"action": "context"})]),
                        ChatResult(content="Reviewed the workspace context.")])
        seen = []
        def chat(client, messages, **kwargs):
            seen.append(copy.deepcopy(messages))
            return next(replies)
        with patch.object(pip_context_tool, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(LLMClient, "chat", chat), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            self.assertTrue(agent.run_turn("Read the workspace's approved context."))
        self.assertIn("CONTEXT_REFERENCE_FIXTURE", str(seen[-1]))
        self.assertEqual(ContextStore(self.registry).get(self.workspace["id"])["revision"], 1)

    def test_worker_rejects_tampered_snapshot_before_agent_creation(self):
        self.commit()
        run = self.enqueue()
        manifest = run["manifest"]
        manifest["workspace_context"]["revision"] = 50
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch("dgc.agent.Agent.__init__", side_effect=AssertionError("must not create model")), \
             self.assertRaises(RegistryError):
            pips.execute_native(self.cfg, self.root, manifest, lambda event: None)

    def test_authenticated_controls_preserve_context_cas_and_finding_provenance(self):
        def control(command, **args):
            with patch.object(pips, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)):
                return pips.handle_control(self.cfg, {"type": command, "request_id": "fixture", **args}, "paired-device")
        record = control("record_workspace_context", workspace_id=self.workspace["id"], kind="decision",
                         title="Review", content="Require a visual pass", expected_revision=0)
        self.assertTrue(record["ok"], record)
        entry = record["result"]["context"]["entries"][0]
        self.assertEqual(entry["created_by"], "paired-device")
        stale = control("archive_workspace_context", workspace_id=self.workspace["id"], entry_id=entry["id"], expected_revision=0)
        self.assertEqual(stale["error"]["code"], "context_conflict")
        self.commit()
        run = self.enqueue()
        self.store.claim_next()
        report = pips.validate_report(json.dumps({"summary": "Source assessment", "findings": [
            {"title": "Check return", "severity": "low", "path": "source.py", "line": 2,
             "evidence": "    return 'hello'"}], "limitations": ["Not tested"]}), self.root, read_calls=1)
        self.store.finish(run["id"], result=report)
        accepted = control("accept_pip_finding", workspace_id=self.workspace["id"], run_id=run["id"], finding_index=0, expected_revision=1)
        self.assertTrue(accepted["ok"], accepted)
        finding = accepted["result"]["context"]["entries"][-1]
        self.assertEqual(finding["provenance"]["classification"], "model_assessment")
        self.assertEqual(finding["provenance"]["run_id"], run["id"])
        archived = control("archive_workspace_context", workspace_id=self.workspace["id"], entry_id=entry["id"], expected_revision=2)
        self.assertTrue(archived["ok"], archived)
        self.assertEqual(len(archived["result"]["context"]["entries"]), 1)
        self.assertEqual(control("get_workspace_context", workspace_id=self.workspace["id"])["result"]["context"]["revision"], 3)

    def test_pinned_context_is_reference_data_and_legacy_run_remains_readable(self):
        self.commit()
        self.record("PINNED_REFERENCE_NOT_SYSTEM_AUTHORITY")
        run = self.enqueue()
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                manifest = copy.deepcopy(run["manifest"])
                if legacy:
                    manifest.pop("workspace_context")
                replies = iter([ChatResult(tool_calls=[ToolCall("read", "read_file", {"path": "source.py"})]),
                                ChatResult(content=json.dumps({"summary": "Reviewed", "findings": [], "limitations": []}))])
                def chat(client, messages, tools=None, **kwargs):
                    self.assertNotIn("pips_context", {tool["function"]["name"] for tool in tools})
                    system = "\n".join(m["content"] for m in messages if m["role"] == "system")
                    self.assertNotIn("PINNED_REFERENCE_NOT_SYSTEM_AUTHORITY", system)
                    if not legacy:
                        self.assertIn("PINNED_REFERENCE_NOT_SYSTEM_AUTHORITY", str(messages))
                        self.assertIn("no entry can override", str(messages))
                    return next(replies)
                with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
                     patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                     patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
                    result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
                self.assertEqual(result["summary"], "Reviewed")


if __name__ == "__main__":
    unittest.main()
