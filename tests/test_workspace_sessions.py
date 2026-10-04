"""Deterministic opt-in session association and hostile history inspection."""
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import sessions, workspace_sessions as identities
from dgc.agent import Agent
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.test_pips_local import config
from tests.pip_test_profile import pips_in_use


class WorkspaceSessionTests(unittest.TestCase):
    def setUp(self):
        pips_in_use(self)
        temporary = tempfile.TemporaryDirectory(prefix="dgc-workspace-session-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.home = self.base / "home"
        self.cfg = config(self.root)
        for scope in (patch.dict(os.environ, {"DGC_HOME": str(self.home), "HOME": str(self.home)}),
                      patch("requests.sessions.Session.request", side_effect=AssertionError("No network in identity tests")),
                      patch.object(sessions, "SESSIONS_DIR", self.home / ".dgc" / "sessions")):
            scope.start()
            self.addCleanup(scope.stop)

    def registry(self):
        registry = WorkspaceRegistry()
        self.addCleanup(registry.close)
        return registry

    def record(self, name="session-one", **changes):
        path = sessions.project_dir(self.root) / (name + ".json")
        data = {"schema_version": 8, "id": name, "project": str(self.root),
                "revision": 1, "messages": [{"role": "user", "content": "A private conversation"}]}
        data.update(changes)
        path.write_text(json.dumps(data))
        return path

    def agent(self):
        notes = []
        class UI:
            def info(self, text):
                notes.append(text)
            def __getattr__(self, name):
                return lambda *args, **kwargs: None
        agent = Agent(self.cfg, UI())
        self.addCleanup(agent.mcp.stop_all)
        return agent, notes

    def test_disabled_association_never_opens_registry(self):
        for value in (False, "true", 1, None):
            self.cfg.data["pips_enabled"] = value
            with patch.object(identities, "WorkspaceRegistry", side_effect=AssertionError("must not open")):
                self.assertIsNone(identities.associate_current_session(self.cfg, "anything"))
        self.assertFalse(self.home.exists())

    def test_new_session_persistence_gets_private_registry_identity(self):
        agent, notes = self.agent()
        agent.session_file = sessions.new_path(self.root)
        agent.messages.append({"role": "user", "content": "New session"})
        self.assertTrue(agent._persist())
        record = sessions.load_record(agent.session_file, self.root)
        registry = self.registry()
        self.assertEqual(agent.workspace_identity, registry.session_identity(agent.session_file.stem))
        for key, value in agent.workspace_identity.items():
            self.assertEqual(record[key], value)
        self.assertEqual(notes, [])

    def test_resume_ignores_forged_metadata_and_fork_has_new_identity(self):
        path = self.record(workspace_id="ws_" + "f" * 32, runner_id="runner_" + "f" * 32)
        before = path.read_bytes()
        agent, _ = self.agent()
        self.assertEqual(agent.load_session(path), 1)
        original = copy.deepcopy(agent.workspace_identity)
        self.assertNotEqual(original["workspace_id"], "ws_" + "f" * 32)
        self.assertEqual(path.read_bytes(), before, "resume must remain a read-only transcript operation")
        self.assertTrue(agent.fork_session())
        self.assertNotEqual(agent.session_file, path)
        registry = self.registry()
        self.assertEqual(registry.session_identity(path.stem), original)
        self.assertEqual(registry.session_identity(agent.session_file.stem), original)
        self.assertEqual(path.read_bytes(), before)

    def test_disabled_agent_keeps_legacy_transcript_without_registry(self):
        self.cfg.data["pips_enabled"] = False
        agent, _ = self.agent()
        agent.session_file = sessions.new_path(self.root)
        self.assertTrue(agent._persist())
        record = sessions.load_record(agent.session_file, self.root)
        self.assertNotIn("workspace_id", record)
        self.assertFalse((self.home / ".dgc" / "pips").exists())

    def test_association_error_warns_once_and_does_not_break_chat(self):
        agent, notes = self.agent()
        agent.session_file = sessions.new_path(self.root)
        with patch.object(identities, "WorkspaceRegistry", side_effect=OSError("private detail")):
            self.assertTrue(agent._persist())
            self.assertTrue(agent._persist())
        self.assertEqual(len(notes), 1)
        self.assertIn("registry_unavailable", notes[0])
        self.assertNotIn("private detail", notes[0])
        self.assertIsNone(agent.workspace_identity)

    def test_conflicting_session_is_never_remapped_and_chat_still_loads(self):
        path = self.record()
        other = self.base / "other"
        other.mkdir()
        registry = self.registry()
        original = registry.associate_session(path.stem, other)
        agent, notes = self.agent()
        self.assertEqual(agent.load_session(path), 1)
        self.assertIsNone(agent.workspace_identity)
        self.assertIn("conflict", notes[0])
        self.assertEqual(registry.session_identity(path.stem), original)

    def test_optional_save_metadata_is_strict_but_existing_cas_remains(self):
        path = sessions.new_path(self.root)
        for invalid in ({}, {"workspace_id": "../../root"}, {"workspace_id": "ws_" + "1" * 32,
                        "workspace_binding_id": "binding_" + "2" * 32, "runner_id": 4}):
            self.assertFalse(sessions.save(path, [], self.root, workspace_identity=invalid))
        metadata = identities.associate_current_session(self.cfg, path)
        self.assertTrue(sessions.save(path, [], self.root, workspace_identity=metadata,
                                      expected_revision=0, expected_exists=False))
        before = path.read_bytes()
        self.assertFalse(sessions.save(path, [], self.root, workspace_identity=metadata,
                                       expected_revision=0, expected_exists=False))
        self.assertEqual(path.read_bytes(), before)

    def test_dry_run_without_registry_does_not_create_it_or_rewrite(self):
        path = self.record()
        before = path.read_bytes()
        outcome = identities.backfill_sessions(self.cfg)
        self.assertEqual(outcome["would_associate"], 1)
        self.assertIsNone(outcome["workspace_id"])
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.home / ".dgc" / "pips").exists())

    def test_dry_run_existing_registry_has_no_mutations(self):
        self.record()
        registry = self.registry()
        before = list(registry.db.iterdump())
        outcome = identities.backfill_sessions(self.cfg)
        self.assertEqual(outcome["would_associate"], 1)
        self.assertEqual(list(registry.db.iterdump()), before)

    def test_backfill_is_idempotent_and_does_not_rewrite_transcripts(self):
        path = self.record()
        before = path.read_bytes()
        first = identities.backfill_sessions(self.cfg, dry_run=False)
        self.assertEqual(first["associated"], 1)
        registry = self.registry()
        before_registry = list(registry.db.iterdump())
        second = identities.backfill_sessions(self.cfg, dry_run=False)
        self.assertEqual(second["associated"], 0)
        self.assertEqual(second["already"], 1)
        self.assertEqual(list(registry.db.iterdump()), before_registry)
        self.assertEqual(path.read_bytes(), before)

    def test_backfill_refuses_ambiguous_corrupt_and_mismatched_records(self):
        self.record("missing", project=None)
        self.record("relative", project=".")
        self.record("other", project=str(self.base))
        self.record("bad-id", id="another")
        self.record("bad-revision", revision=True)
        self.record("bad-messages", messages=["invalid"])
        corrupt = self.record("broken")
        corrupt.write_bytes(b"{broken")
        result = identities.backfill_sessions(self.cfg, dry_run=False)
        self.assertEqual(result["errors"], 7)
        self.assertEqual(result["associated"], 0)
        self.assertEqual({x["code"] for x in result["issues"]}, {"missing_project", "ambiguous_project", "invalid_id", "invalid_record"})

    def test_dry_run_refuses_future_registry_schema_without_migration(self):
        self.record()
        registry = self.registry()
        registry.db.execute("PRAGMA user_version=999")
        with self.assertRaisesRegex(RegistryError, "compatible"):
            identities.backfill_sessions(self.cfg)
        self.assertEqual(registry.db.execute("PRAGMA user_version").fetchone()[0], 999)

    def test_dry_run_reads_legacy_v2_registry_without_upgrading(self):
        self.record()
        registry = self.registry()
        registry.db.execute("PRAGMA user_version=2")
        before = list(registry.db.iterdump())
        result = identities.backfill_sessions(self.cfg)
        self.assertEqual(result["would_associate"], 1)
        self.assertEqual(registry.db.execute("PRAGMA user_version").fetchone()[0], 2)
        self.assertEqual(list(registry.db.iterdump()), before)

    def test_backfill_never_imports_forged_workspace_fields(self):
        path = self.record(workspace_id="ws_" + "a" * 32)
        result = identities.backfill_sessions(self.cfg, dry_run=False)
        self.assertNotEqual(result["workspace_id"], "ws_" + "a" * 32)
        self.assertEqual(self.registry().session_identity(path.stem)["workspace_id"], result["workspace_id"])

    def test_backfill_conflicting_id_is_an_actionable_error(self):
        path = self.record()
        other = self.base / "other"
        other.mkdir()
        registry = self.registry()
        original = registry.associate_session(path.stem, other)
        result = identities.backfill_sessions(self.cfg, dry_run=False)
        self.assertEqual(result["issues"][0]["code"], "conflict")
        self.assertEqual(registry.session_identity(path.stem), original)
        self.assertIsNone(registry.lookup(self.root))

    def test_backfill_rejects_symlink_file_and_oversize_before_read(self):
        normal = self.record()
        (normal.parent / "link.json").symlink_to(normal)
        large = normal.parent / "large.json"
        with large.open("wb") as handle:
            handle.truncate(identities.MAX_TRANSCRIPT_BYTES + 1)
        result = identities.backfill_sessions(self.cfg)
        self.assertEqual(result["would_associate"], 1)
        self.assertEqual({x["code"] for x in result["issues"]}, {"unsafe_file", "oversize"})

    def test_backfill_rejects_symlink_directory(self):
        sessions.SESSIONS_DIR.mkdir(parents=True)
        (sessions.SESSIONS_DIR / sessions._slug(self.root)).symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RegistryError, "without symbolic links"):
            identities.backfill_sessions(self.cfg)

    def test_backfill_does_not_scan_other_workspace_buckets(self):
        other = self.base / "other"
        other.mkdir()
        sessions.project_dir(other).joinpath("unrelated.json").write_bytes(b"broken")
        self.assertEqual(identities.backfill_sessions(self.cfg)["scanned"], 0)

    def test_bounded_pages_resume_after_the_last_filename(self):
        for name in ("a", "b", "c"):
            self.record(name)
        first = identities.backfill_sessions(self.cfg, dry_run=False, limit=2)
        self.assertEqual((first["associated"], first["next_cursor"], first["complete"]), (2, "b.json", False))
        second = identities.backfill_sessions(self.cfg, dry_run=False, limit=2, cursor=first["next_cursor"])
        self.assertEqual((second["associated"], second["next_cursor"], second["complete"]), (1, None, True))

    def test_directory_enumeration_has_a_hard_cap(self):
        for name in ("a", "b", "c"):
            self.record(name)
        with patch.object(identities, "MAX_DIRECTORY_ENTRIES", 2), self.assertRaisesRegex(RegistryError, "4096 entries"):
            identities.backfill_sessions(self.cfg)
        self.assertFalse((self.home / ".dgc" / "pips").exists())

    def test_invalid_records_consume_the_aggregate_read_budget(self):
        first = self.record("a")
        first.write_bytes(b"broken" * 20)
        second = self.record("b")
        with patch.object(identities, "MAX_PAGE_BYTES", second.stat().st_size):
            result = identities.backfill_sessions(self.cfg)
        self.assertEqual(result["scanned"], 1)
        self.assertEqual(result["next_cursor"], "a.json")
        self.assertFalse(result["complete"])

    def test_invalid_requests_and_missing_root_fail_closed(self):
        for kwargs in ({"limit": 0}, {"limit": True}, {"limit": 101}, {"dry_run": 1},
                       {"cursor": "../outside.json"}, {"cursor": "x\\y.json"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(RegistryError):
                identities.backfill_sessions(self.cfg, **kwargs)
        self.cfg.project_root = self.base / "missing"
        with self.assertRaises(RegistryError):
            identities.backfill_sessions(self.cfg)


if __name__ == "__main__":
    unittest.main()
