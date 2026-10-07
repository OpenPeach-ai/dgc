"""How many Pips you can have: 100 unless you choose another number, and a list that pages and searches."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_limits, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class PipLimitTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def make(self, n, start=0):
        ws = self.registry.personal()["id"]
        return [self.store.create(ws, f"Helper {i:04d}", "Help", "local-console") for i in range(start, start + n)]

    def control(self, command, actor="editor-user", **fields):
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r", **fields}, actor, start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"], len(json.dumps(response).encode())

    def test_a_hundred_by_default_and_archived_pips_do_not_count(self):
        made = self.make(100)
        with self.assertRaises(RegistryError) as raised:
            self.make(1, 100)
        self.assertIn("100 Pips", str(raised.exception))
        self.assertIn("Pips settings", str(raised.exception))
        self.store.archive(made[0]["id"], "local-console", "Not needed") if hasattr(self.store, "archive") else \
            self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (made[0]["id"],))
        self.make(1, 100)

    def test_you_choose_the_number_on_this_computer(self):
        self.assertEqual(self.control("get_pips_limit")[0]["max_pips"], 100)
        with self.assertRaises(RegistryError):
            self.control("set_pips_limit", actor="device_1", max_pips=5000)
        for bad in (0, 100001, "5000", True, 2.5):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                self.control("set_pips_limit", max_pips=bad)
        self.assertEqual(self.control("set_pips_limit", max_pips=5000)[0]["max_pips"], 5000)
        self.make(103)
        self.assertEqual(pip_limits.live_count(self.registry.db, self.registry.personal()["id"]), 103)

    def test_the_list_pages_searches_and_shows_recent_first(self):
        pip_limits.set_limit(self.registry, 1000, "local-console")
        made = self.make(150)
        ws = self.registry.personal()["id"]
        first, size = self.control("list_pips", workspace_id=ws)
        self.assertEqual((len(first["pips"]), first["total"], first["next_offset"]), (100, 150, 100), "the first 100, as before")
        keys = [(p["created_at"], p["id"]) for p in first["pips"]]
        self.assertEqual(keys, sorted(keys), "oldest first by default, as before")
        self.assertLess(size, 128 * 1024, "a page fits the reply")
        rest, _ = self.control("list_pips", workspace_id=ws, offset=100)
        self.assertEqual((len(rest["pips"]), rest["next_offset"]), (50, None))
        self.registry.db.execute("UPDATE pips SET updated_at='2099-01-01T00:00:00.000Z' WHERE id=?", (made[42]["id"],))
        recent, _ = self.control("list_pips", workspace_id=ws, order="recent", limit=5)
        self.assertEqual(recent["pips"][0]["name"], "Helper 0042")
        core = self.store.create(ws, "Core", "", "local-console", pip_type="core")
        self.registry.db.execute("UPDATE pips SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?", (core["id"],))
        recent, _ = self.control("list_pips", workspace_id=ws, order="recent", limit=5)
        self.assertEqual([p["name"] for p in recent["pips"][:2]], ["Core", "Helper 0042"], "the Primary Pip stays on top")
        found, _ = self.control("list_pips", workspace_id=ws, query="helper 012")
        self.assertEqual(sorted(p["name"] for p in found["pips"]), [f"Helper {i:04d}" for i in range(120, 130)])
        self.assertEqual(found["total"], 10)
        literal, _ = self.control("list_pips", workspace_id=ws, query="100%")
        self.assertEqual(literal["total"], 0, "a % in the search is a %")
        for bad in ({"limit": 0}, {"limit": 101}, {"offset": -1}, {"order": "name"}, {"query": "x" * 121}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                self.control("list_pips", workspace_id=ws, **bad)

    def test_the_pip_picker_reads_past_a_hundred(self):
        from dgc import pip_references
        pip_limits.set_limit(self.registry, 1000, "local-console")
        self.make(130)
        rows = list(pip_references._rows(self.registry.db, self.registry.personal()["id"]))
        self.assertEqual(len(rows), 130)


if __name__ == "__main__":
    unittest.main()
