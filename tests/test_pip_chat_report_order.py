"""Report references never invent finish order from random run identifiers."""
import json
import sqlite3
import unittest
from types import SimpleNamespace

from dgc.pip_chat import _last_report
from dgc.workspace_registry import RegistryError


class ReportOrderTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE pip_runs (
                id TEXT PRIMARY KEY, pip_id TEXT, workspace_id TEXT,
                status TEXT, finished_at TEXT, result TEXT, manifest TEXT,
                binding_id TEXT, requested_by TEXT, idempotency_key TEXT
            );
            CREATE TABLE pips (id TEXT PRIMARY KEY, workspace_id TEXT);
            CREATE TABLE pip_chat_messages (run_id TEXT);
        """)
        self.store = SimpleNamespace(db=self.db, registry=SimpleNamespace(db=self.db))
        self.stamp = "2026-10-02T00:00:00.001Z"
        self.later = "2026-10-02T00:00:00.002Z"

    def add(self, suffix, stamp=None, *, pip="pip_subject", status="succeeded", chat=False, raw=None):
        run = "run_" + suffix * 32
        result = json.dumps({"summary": "Recorded " + suffix, "findings": []}) if raw is None else raw
        manifest = json.dumps({"source_revision": "a" * 40, "job_version": 1})
        self.db.execute("INSERT OR IGNORE INTO pips VALUES(?,?)", (pip, "ws_subject"))
        self.db.execute("INSERT INTO pip_runs VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (run, pip, "ws_subject", status, stamp or self.stamp, result, manifest,
                         "binding_subject", "fixture", run))
        if chat:
            self.db.execute("INSERT INTO pip_chat_messages VALUES(?)", (run,))
        return run

    def test_empty_history_returns_no_reference(self):
        self.assertIsNone(_last_report(self.store, "pip_subject"))

    def test_one_successful_report_remains_available(self):
        run = self.add("1")
        self.assertEqual(_last_report(self.store, "pip_subject")["run_id"], run)

    def test_equal_finishes_do_not_choose_either_uuid_order(self):
        for old, new in (("f", "0"), ("0", "f")):
            with self.subTest(old=old, new=new):
                self.db.execute("DELETE FROM pip_runs")
                self.add(old)
                self.add(new)
                self.assertIsNone(_last_report(self.store, "pip_subject"))
                self.assertEqual(self.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 2)

    def test_unique_newest_report_survives_older_tie_and_uuid_order(self):
        self.add("e")
        self.add("f")
        run = self.add("0", self.later)
        self.assertEqual(_last_report(self.store, "pip_subject")["run_id"], run)

    def test_newest_tie_does_not_fall_back_to_old_report(self):
        self.add("0")
        self.add("1", self.later)
        self.add("2", self.later)
        self.assertIsNone(_last_report(self.store, "pip_subject"))

    def test_conversations_failures_and_other_pips_cannot_create_a_tie(self):
        run = self.add("0")
        self.add("f", chat=True, raw="not a report")
        self.add("e", self.later, chat=True, raw="not a report")
        self.add("d", self.later, status="failed", raw="not a report")
        self.add("c", self.later, pip="pip_other", raw="not a report")
        self.assertEqual(_last_report(self.store, "pip_subject")["run_id"], run)

    def test_ambiguous_metadata_does_not_fetch_or_decode_bodies(self):
        self.add("0", raw="not JSON")
        self.add("f", raw="x" * 70000)
        queries = []
        self.db.set_trace_callback(queries.append)
        self.assertIsNone(_last_report(self.store, "pip_subject"))
        self.assertEqual(len(queries), 1)
        self.assertIn("LIMIT 2", queries[0])
        self.assertNotIn("SELECT result,manifest", queries[0])

    def test_unique_oversize_report_keeps_existing_bound(self):
        self.add("0", raw="x" * 70000)
        with self.assertRaisesRegex(RegistryError, "bounded reference budget"):
            _last_report(self.store, "pip_subject")


if __name__ == "__main__":
    unittest.main()
