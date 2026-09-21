"""Several backends share ~/.dgc/config.json, and none of them may revert another.

This is not a future problem. Two VS Code windows are already two `dgc serve` processes against
one config file, and `save()` wrote this process's whole in-memory copy -- so the last writer won
and everything the other had changed since IT loaded was silently reverted.

The worst case is not a lost setting. `Config.save()` also writes `permissions`, so a `deny` rule
added in one chat was erased by an unrelated settings change in another. That fails OPEN.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class ConcurrentConfigTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        (self.home / ".dgc").mkdir(parents=True, exist_ok=True)
        self.path = self.home / ".dgc" / "config.json"
        self.path.write_text(json.dumps({"model": "start", "thinking": "off"}))
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        from dgc import config as C
        self.C = importlib.reload(C)

    def tearDown(self):
        if self._home is not None:
            os.environ["HOME"] = self._home
        from dgc import config as C
        importlib.reload(C)

    def disk(self) -> dict:
        return json.loads(self.path.read_text())

    # ---- settings ---------------------------------------------------------------------------

    def test_two_backends_changing_different_settings_keep_both(self):
        a, b = self.C.Config(), self.C.Config()      # both open, as two chats would be
        a.set("model", "qwen-A")
        b.set("thinking", "high")
        self.assertEqual(self.disk().get("model"), "qwen-A", "A's change was reverted")
        self.assertEqual(self.disk().get("thinking"), "high")

    def test_the_later_writer_adopts_what_it_did_not_change(self):
        a, b = self.C.Config(), self.C.Config()
        a.set("model", "qwen-A")
        b.set("thinking", "high")
        self.assertEqual(b.data.get("model"), "qwen-A",
                         "B should end up holding what A wrote, not its own stale value")

    def test_a_key_this_process_removes_is_removed(self):
        a = self.C.Config()
        a.data.pop("thinking", None)
        a.save()
        self.assertNotIn("thinking", self.disk())

    # ---- permissions ------------------------------------------------------------------------

    def test_a_deny_rule_is_not_erased_by_another_backend(self):
        # The fail-open case: a rule that narrows what may run must never be dropped by a save
        # that had nothing to do with it.
        a, b = self.C.Config(), self.C.Config()
        a.permissions.setdefault("deny", []).append("Bash(rm -rf /)")
        a.save()
        b.set("model", "qwen-B")
        self.assertEqual(self.disk()["permissions"]["deny"], ["Bash(rm -rf /)"])

    def test_two_backends_granting_different_rules_keep_both(self):
        a, b = self.C.Config(), self.C.Config()
        a.permissions.setdefault("allow", []).append("Bash(npm test)")
        a.save()
        b.permissions.setdefault("allow", []).append("Bash(git status)")
        b.save()
        self.assertEqual(sorted(self.disk()["permissions"]["allow"]),
                         ["Bash(git status)", "Bash(npm test)"])

    def test_a_rule_this_process_revokes_is_revoked(self):
        # Merging must not mean "additions only": a revoke has to survive the round trip.
        first = self.C.Config()
        first.permissions.setdefault("deny", []).append("Bash(curl evil)")
        first.save()
        second = self.C.Config()
        second.permissions["deny"].remove("Bash(curl evil)")
        second.save()
        self.assertEqual(self.disk()["permissions"]["deny"], [])

    def test_project_rules_are_still_never_persisted(self):
        # apply_project_permissions merges workspace rules into the live set. They must not read
        # as rules this process added, or the next save writes a cloned repo's rules into the
        # user's own config.
        project = self.home / "proj"
        (project / ".dgc").mkdir(parents=True)
        (project / ".dgc" / "permissions.json").write_text(json.dumps({"allow": ["Bash(make)"]}))
        cfg = self.C.Config(project_root=project)
        cfg._project_permissions_applied = False
        if cfg.apply_project_permissions():
            self.assertIn("Bash(make)", cfg.permissions["allow"], "the rule is live")
        cfg.set("model", "qwen-C")
        self.assertNotIn("Bash(make)", self.disk()["permissions"]["allow"],
                         "a workspace rule was written into the user's config")

    # ---- the file itself ----------------------------------------------------------------------

    def test_a_missing_config_is_written_whole(self):
        self.path.unlink()
        cfg = self.C.Config()
        cfg.set("model", "fresh")
        self.assertEqual(self.disk().get("model"), "fresh")

    def test_an_unreadable_config_does_not_lose_this_process_state(self):
        # Merging into {} would silently drop every key another backend had written; a corrupt
        # file means "write mine whole" instead.
        cfg = self.C.Config()
        cfg.set("model", "mine")
        self.path.write_text("{ this is not json")
        cfg.set("thinking", "high")
        self.assertEqual(self.disk().get("model"), "mine")
        self.assertEqual(self.disk().get("thinking"), "high")

    def test_secrets_never_reach_the_config_file(self):
        cfg = self.C.Config()
        for key in self.C.SECRET_KEYS:
            cfg.data[key] = "s3cret"
        cfg.set("model", "qwen")
        for key in self.C.SECRET_KEYS:
            self.assertNotIn(key, self.disk(), f"{key} was written to config.json")

    def test_writes_are_serialised_across_processes(self):
        import inspect
        source = inspect.getsource(self.C.Config.save)
        self.assertIn("_config_write_lock", source,
                      "concurrent saves must not interleave read and replace")


if __name__ == "__main__":
    unittest.main()
