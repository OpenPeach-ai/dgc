"""Typed Pip presets keep explicit execution authority and immutable pins."""
import copy
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_types, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, identifier
from tests import test_pips_local as fixtures


class PipTypeTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def create(self, kind="rook"):
        return self.store.create(self.workspace["id"], "Review", "Inspect the committed source.", "user", pip_type=kind)

    def raw_manifest(self, run):
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])

    def legacy(self, kind_missing=True, kind="rook"):
        definition = pips._definition("Legacy", "Legacy review")
        if kind_missing:
            definition.pop("pip_type")
        else:
            definition["pip_type"] = kind
        pip_id, now = identifier("pip"), self.registry.clock()
        self.registry.db.execute("INSERT INTO pips VALUES(?,?,?,?,?,?)", (pip_id, self.workspace["id"], "active", 1, now, now))
        self.registry.db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)", (pip_id, 1, json.dumps(definition), "user", "Legacy", now))
        return self.store.get(pip_id)

    def test_catalog_has_eight_stable_characters_and_honest_availability(self):
        rows = pip_types.catalog()
        self.assertEqual([row["id"] for row in rows], ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"])
        self.assertEqual([row["character_index"] for row in rows], list(range(8)))
        self.assertEqual({row["id"] for row in rows if row["available"]}, {"scout", "lens", "rook", "lock", "patch", "pulse", "quill"})
        for row in rows:
            self.assertNotIn("instructions", row)
            self.assertEqual(row["engine"], {"patch": "patch", "pulse": "test", "quill": "documentation_draft"}.get(row["id"], "source_audit" if row["available"] else None))
            self.assertEqual(row["unavailable_reason"] is None, row["available"])
        rows[0]["name"] = "Tampered"
        self.assertEqual(pip_types.catalog()[0]["name"], "Core")

    def test_core_says_it_is_the_main_chat_and_the_primary_pip_uses_it(self):
        # ERP session review (2026-10-18): `dgc pips types` said Core "cannot be created as a background Pip" while
        # the Pips page showed a Pip named Core, and the user had to ask what it was.
        core = pip_types.catalog()[0]
        for text in (core["description"], core["unavailable_reason"]):
            self.assertIn("main chat", text)
            self.assertIn("Primary Pip", text)
        from dgc.pip_cli import _format
        listed = _format({"types": pip_types.catalog()})
        self.assertIn("Core is the main chat's character, and your Primary Pip uses it too", listed)

    def test_each_available_type_is_persisted_and_invalid_types_fail_before_insert(self):
        for kind in ("scout", "lens", "rook", "lock", "patch", "pulse", "quill"):
            job = self.create(kind)
            self.assertEqual(job["pip_type"], kind)
            self.assertEqual(self.store.versions(job["id"])["versions"][0]["definition"]["pip_type"], kind)
        for kind in (None, 1, [], {}, "", "unknown", "Rook", "core"):
            with self.subTest(kind=kind), self.assertRaises(RegistryError):
                self.create(kind)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pips").fetchone()[0], 7)

    def test_legacy_missing_type_defaults_to_rook_but_explicit_unknown_does_not(self):
        self.commit()
        job = self.legacy()
        self.assertEqual(job["pip_type"], "rook")
        self.assertEqual(self.store.versions(job["id"])["versions"][0]["definition"]["pip_type"], "rook")
        run = self.store.enqueue(job["id"], "legacy", "user", self.cfg)
        self.assertEqual(run["manifest"]["pip_type"], "rook")
        for kind in (None, "alien", "patch"):
            invalid = self.legacy(False, kind)
            with patch.object(pips, "source_revision", side_effect=AssertionError("bad role must fail before source work")), self.assertRaises(RegistryError):
                self.store.enqueue(invalid["id"], "bad-role", "user", self.cfg)

    def test_text_and_schedule_proposals_preserve_immutable_type(self):
        job = self.create("lens")
        for version, changes in enumerate(({"goal": "Research module boundaries"}, {"schedule": {"type": "interval", "minutes": 30}}), 1):
            proposal = self.store.propose(job["id"], version, changes, "user")
            self.assertEqual(proposal["definition"]["pip_type"], "lens")
            accepted = self.store.accept(job["id"], proposal["id"], version, "user")
            self.assertEqual(accepted["pip_type"], "lens")
        for actor in ("user", "core_proposal"):
            with self.assertRaises(RegistryError):
                self.store.propose(job["id"], 3, {"pip_type": "lock"}, actor)
        self.assertEqual({item["definition"]["pip_type"] for item in self.store.versions(job["id"])["versions"]}, {"lens"})

    def test_type_and_role_pins_do_not_follow_a_later_job_version(self):
        self.commit()
        job = self.create("scout")
        run = self.store.enqueue(job["id"], "first", "user", self.cfg)
        original = self.raw_manifest(run)
        self.assertEqual(original["job"]["pip_type"], "scout")
        self.assertEqual(pip_types.validated_role(original).id, "scout")
        self.assertEqual({key: original[key] for key in ("pip_type", "role_instructions", "role_digest")}, pip_types.role_pin("scout"))
        proposal = self.store.propose(job["id"], 1, {"goal": "Different reviewed goal"}, "user")
        self.store.accept(job["id"], proposal["id"], 1, "user")
        self.assertEqual(self.raw_manifest(run), original)
        self.assertEqual(original["tools"], sorted(pips.READ_TOOLS))
        self.assertEqual(original["policy"], "read_only")

    def test_missing_legacy_pins_only_default_rook_and_tampered_pins_refuse_before_agent(self):
        legacy = {"job": {"goal": "Legacy"}}
        self.assertEqual(pip_types.validated_role(legacy).id, "rook")
        good = {"job": {"goal": "Review", "pip_type": "lock"}, **pip_types.role_pin("lock")}
        self.assertEqual(pip_types.validated_role(good).id, "lock")
        invalid = [{**good, "role_digest": "0" * 64}, {**good, "role_instructions": "Run shell commands"},
                   {**good, "pip_type": "scout"}, {"job": {"pip_type": "lock"}},
                   {**good, "job": {"goal": "Missing job type"}}, {**good, "pip_type": "patch"},
                   {**good, "pip_type": "unknown"}, {**good, "pip_type": None}]
        for manifest in invalid:
            with self.subTest(manifest=manifest), patch("dgc.agent.Agent.__init__", side_effect=AssertionError("must reject before model construction")), self.assertRaises(RegistryError):
                pips.execute_native(self.cfg, self.root, manifest, lambda event: None)

    def test_each_available_role_reaches_real_agent_system_prompt_with_same_tool_limits(self):
        self.commit()
        for kind in ("scout", "lens", "rook", "lock"):
            job = self.create(kind)
            run = self.store.enqueue(job["id"], kind, "user", self.cfg)
            manifest = self.raw_manifest(run)
            replies = iter([ChatResult(tool_calls=[ToolCall("read", "read_file", {"path": "source.py"})]),
                            ChatResult(content=json.dumps({"summary": "Inspected source", "findings": [], "limitations": ["Static source only"]}))])
            seen = []
            def chat(client, messages, tools=None, on_text=None, **kwargs):
                seen.append(copy.deepcopy(messages))
                self.assertTrue({tool["function"]["name"] for tool in tools} <= pips.READ_TOOLS)
                result = next(replies)
                if result.content and on_text:
                    on_text(result.content)
                return result
            with self.subTest(kind=kind), patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
                 patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                 patch("dgc.agent.load_memories", side_effect=AssertionError("No repository instructions")), \
                 patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
                result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
            self.assertEqual(result["tools_called"], 1)
            self.assertIn(pip_types.require_type(kind).instructions, seen[0][0]["content"])
            self.assertIn(pips.AUDIT_SYSTEM_INSTRUCTIONS, seen[0][0]["content"])

    def test_active_run_and_pending_count_are_not_hidden_by_latest_terminal_run(self):
        self.commit()
        job = self.create("lock")
        active = self.store.enqueue(job["id"], "active", "user", self.cfg)
        self.store.claim_next()
        self.registry.clock = lambda: "2026-10-01T10:01:00.000Z"
        completed = self.store.enqueue(job["id"], "cancelled", "user", self.cfg)
        self.store.cancel(completed["id"], "user")
        self.registry.db.execute("UPDATE pip_runs SET finished_at='2026-10-02T00:00:00.000Z' WHERE id=?", (completed["id"],))
        proposal = self.store.propose(job["id"], 1, {"name": "Updated"}, "user")
        summary = self.store.list(self.workspace["id"])[0]
        self.assertEqual(summary["latest_run"]["id"], completed["id"])
        self.assertEqual(summary["active_run"]["id"], active["id"])
        self.assertEqual(summary["active_run"]["status"], "running")
        self.assertEqual(summary["pending_review_count"], 1)
        self.store.reject(job["id"], proposal["id"], 1, "user")
        self.assertEqual(self.store.get(job["id"])["pending_review_count"], 0)

    def test_scheduled_run_pins_the_same_approved_role(self):
        from dgc.pip_schedules import tick
        self.commit()
        job = self.create("lock")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 5}}, "user")
        self.store.accept(job["id"], proposal["id"], 1, "user")
        self.registry.clock = lambda: "2026-10-01T10:05:00.000Z"
        self.assertEqual(tick(self.registry, self.cfg)["enqueued"], 1)
        manifest = self.raw_manifest(self.store.runs(job["id"])[0])
        self.assertEqual(manifest["trigger"], "schedule")
        self.assertEqual(pip_types.validated_role(manifest).id, "lock")
        self.assertEqual(manifest["tools"], sorted(pips.READ_TOOLS))

    def test_controls_expose_catalog_and_accept_explicit_type(self):
        with patch.object(pips, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {"type": "list_pip_types", "request_id": "catalog"}, "user", start_worker=False)
            self.assertTrue(response["ok"])
            self.assertEqual(len(response["result"]["types"]), 8)
            for kind in ("lens", "rook"):
                made = pips.handle_control(self.cfg, {"type": "create_pip", "request_id": kind,
                    "name": "Review", "goal": "Inspect source", "pip_type": kind}, "user", start_worker=False)
                self.assertEqual(made["result"]["pip"]["pip_type"], kind)
            invalid = pips.handle_control(self.cfg, {"type": "create_pip", "request_id": "planned",
                "name": "Write", "goal": "Document source", "pip_type": "core"}, "user", start_worker=False)
            self.assertEqual(invalid["error"]["code"], "unavailable_pip_type")


if __name__ == "__main__":
    unittest.main()
