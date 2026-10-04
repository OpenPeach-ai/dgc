"""Local workspace repair and identity contracts. No network or timing assertions."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_cli, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.test_pips_local import config


class WorkspaceIdentityCommands(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="workspace-identity-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "project"
        self.root.mkdir()
        environment = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home")})
        environment.start(); self.addCleanup(environment.stop)
        self.cfg = config(self.root)
        self.registry = WorkspaceRegistry(clock=lambda: "2026-10-01T12:00:00.000Z")
        self.addCleanup(self.registry.close)
        network = patch("requests.sessions.Session.request", side_effect=AssertionError("No network"))
        network.start(); self.addCleanup(network.stop)

    def cli(self, *args, expected=0):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            code = pip_cli.handle_command(self.cfg, [*args, "--json"])
        self.assertEqual(code, expected, out.getvalue() + err.getvalue())
        return json.loads(out.getvalue() if code == 0 else err.getvalue())

    def test_lookup_does_not_create_workspace(self):
        self.assertIsNone(self.registry.lookup(self.root))
        self.assertEqual(self.registry.list(), [])
        self.assertIsNone(self.cli("workspace", "show")["workspace"])
        self.assertEqual(self.registry.list(), [])

    def test_association_is_idempotent_and_lookup_has_no_paths(self):
        first = self.registry.associate_session("session-one", self.root)
        before = self.registry.db.execute("SELECT * FROM session_workspaces").fetchall()
        event_count = self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0]
        self.registry.clock = lambda: "2026-10-02T12:00:00.000Z"
        self.assertEqual(self.registry.associate_session("session-one", self.root), first)
        self.assertEqual(self.registry.session_identity("session-one"), first)
        self.assertEqual(self.registry.db.execute("SELECT * FROM session_workspaces").fetchall(), before)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0], event_count)
        self.assertEqual(set(first), {"workspace_id", "workspace_binding_id", "runner_id"})

    def test_conflicting_session_does_not_create_an_unused_workspace(self):
        first = self.registry.associate_session("collision", self.root)
        other = self.base / "copy"; other.mkdir()
        with self.assertRaisesRegex(RegistryError, "another workspace"):
            self.registry.associate_session("collision", other)
        self.assertEqual(len(self.registry.list()), 1)
        self.assertEqual(self.registry.session_identity("collision"), first)

    def test_failure_rolls_back_workspace_binding_and_association(self):
        with patch.object(self.registry, "event", side_effect=OSError("disk failure")), self.assertRaises(OSError):
            self.registry.associate_session("new", self.root)
        self.assertEqual(self.registry.list(), [])
        self.assertIsNone(self.registry.session_identity("new"))

    def test_association_capacity_checked_before_new_workspace(self):
        with patch("dgc.workspace_registry.MAX_SESSION_ASSOCIATIONS", 0), self.assertRaisesRegex(RegistryError, "full"):
            self.registry.associate_session("new", self.root)
        self.assertEqual(self.registry.list(), [])

    def test_session_pages_are_workspace_scoped(self):
        identity = self.registry.associate_session("b", self.root)
        self.registry.associate_session("a", self.root)
        self.registry.associate_session("c", self.root)
        other = self.base / "other"; other.mkdir()
        self.registry.associate_session("elsewhere", other)
        page = self.cli("workspace", "sessions", "--limit", "2")
        self.assertEqual([r["session_id"] for r in page["sessions"]], ["a", "b"])
        self.assertTrue(page["has_more"])
        self.assertEqual(page["workspace_id"], identity["workspace_id"])
        tail = self.cli("workspace", "sessions", "--limit", "2", "--after", page["next_cursor"])
        self.assertEqual([r["session_id"] for r in tail["sessions"]], ["c"])
        self.assertFalse(tail["has_more"])
        self.assertNotIn(str(self.root), json.dumps(page))

    def test_empty_workspace_validates_limit_and_cursor(self):
        self.assertEqual(self.cli("workspace", "sessions", "--limit", "0", expected=1)["error"]["code"], "invalid_limit")
        self.assertEqual(self.cli("workspace", "sessions", "--after", "x" * 257, expected=1)["error"]["code"], "invalid_cursor")

    def test_rebind_preview_then_apply_keeps_pips_and_session_identity(self):
        identity = self.registry.associate_session("existing", self.root)
        workspace_id = identity["workspace_id"]
        job = pips.PipStore(self.registry).create(workspace_id, "Reviewer", "Inspect committed source", "user")
        moved = self.base / "renamed"
        self.root.rename(moved)
        event_count = self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0]
        args = ("workspace", "rebind", workspace_id, str(moved), "--expected-root", str(self.root))
        preview = self.cli(*args)["rebind"]
        self.assertFalse(preview["applied"])
        self.assertEqual(self.registry.binding(workspace_id)["canonical_root"], str(self.root))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events").fetchone()[0], event_count)
        result = self.cli(*args, "--apply")["rebind"]
        self.assertTrue(result["applied"])
        self.assertIn("does not migrate", result["transcript_notice"])
        self.assertEqual(self.registry.resolve(moved)["id"], workspace_id)
        self.assertEqual(self.registry.associate_session("existing", moved), identity)
        self.assertEqual(pips.PipStore(self.registry).get(job["id"])["workspace_id"], workspace_id)
        stale = self.cli(*args, "--apply", expected=1)
        self.assertEqual(stale["error"]["code"], "conflict")

    def test_rebind_rejects_copy_while_old_directory_exists(self):
        workspace = self.registry.resolve(self.root)
        other = self.base / "copy"; other.mkdir()
        error = self.cli("workspace", "rebind", workspace["id"], str(other),
                         "--expected-root", str(self.root), "--apply", expected=1)
        self.assertEqual(error["error"]["code"], "source_exists")
        self.assertEqual(self.registry.binding(workspace["id"])["canonical_root"], str(self.root))

    def test_cli_backfill_is_preview_by_default(self):
        with patch("dgc.workspace_sessions.backfill_sessions", return_value={"fixture": True}) as backfill:
            self.cli("workspace", "backfill")
            self.assertEqual(backfill.call_args.kwargs, {"dry_run": True, "limit": 50, "cursor": None})
            self.cli("workspace", "backfill", "--apply", "--after", "cursor", "--limit", "12")
            self.assertEqual(backfill.call_args.kwargs, {"dry_run": False, "limit": 12, "cursor": "cursor"})

    def test_path_commands_are_not_remote_controls(self):
        for command in ("rebind_workspace", "backfill_sessions", "workspace"):
            result = pips.handle_control(self.cfg, {"type": command, "request_id": "r", "root": str(self.root)},
                                         "remote-device", start_worker=False)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "unsupported_command")
        self.assertEqual(self.registry.list(), [])

    def test_disabled_cli_does_not_open_registry(self):
        self.cfg.set("pips_enabled", False, persist=False)
        with patch.object(pip_cli, "WorkspaceRegistry", side_effect=AssertionError("disabled must not open state")):
            self.assertEqual(self.cli("workspace", "show", expected=1)["error"]["code"], "disabled")


if __name__ == "__main__":
    unittest.main()
