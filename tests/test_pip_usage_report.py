"""The Pips tab of Token Usage: each Pip's share of a range, from the runs that finished in it."""
import contextlib
import sqlite3
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from dgc import pip_usage, pip_usage_report, usage_ledger
from dgc.editor_protocol import command_error, event_error
from tests import test_pip_spend as spend   # the module, not the class: importing a TestCase reruns its tests here

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc).timestamp()


class PipUsageReportTests(unittest.TestCase):
    setUp = spend.SpendTests.setUp
    finish = spend.SpendTests.finish
    ledger = spend.SpendTests.ledger

    def job(self, name="Auditor"):
        job = self.store.create(self.workspace["id"], name, "Inspect source", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 5}}, "user")
        return self.store.accept(job["id"], proposal["id"], 1, "user")

    def run_for(self, job, key, **finish):
        run = self.store.enqueue(job["id"], key, "user", self.cfg)
        self.finish(run["id"], **finish)
        return run

    def report(self, range_name="7d"):
        with patch("dgc.workspace_registry.WorkspaceRegistry", return_value=self.registry), \
                patch.object(self.registry, "close"), patch("dgc.workspace_registry.in_use", return_value=True):
            return pip_usage_report.report(range_name, now=NOW)

    def test_each_pip_gets_its_share_most_tokens_first(self):
        auditor, docs = self.job(), self.job("Docs writer")
        self.run_for(auditor, "a1", tokens=5_000)
        imported = self.run_for(auditor, "a2", tokens=100)
        self.ledger(imported["id"], 40_000, 2_000)        # the runner's imported totals win over the result's
        self.run_for(docs, "d1", tokens=1_000)
        value = self.report()
        self.assertEqual([p["name"] for p in value["by_pip"]], ["Auditor", "Docs writer"])
        first = value["by_pip"][0]
        self.assertEqual((first["input_tokens"] + first["output_tokens"], first["runs"]), (47_000, 2))
        self.assertEqual((first["scope"], first["pip_type"], first["status"]), ("project", "rook", "active"))
        self.assertEqual(value["totals"], {"input_tokens": sum(p["input_tokens"] for p in value["by_pip"]),
                                           "output_tokens": sum(p["output_tokens"] for p in value["by_pip"]), "runs": 3})
        self.assertEqual(value["omitted"], 0)

    def models(self, run_id, rows):
        """What the runner records with a run's import: its tokens by model."""
        path = Path(self.registry.directory).parent / "usage.sqlite"
        with contextlib.closing(sqlite3.connect(path)) as db:
            pip_usage._imports_table(db)
            db.executemany("INSERT INTO pip_usage_run_models(run_id,model,provider,host,input_tokens,output_tokens,requests) "
                           "VALUES (?,?,?,?,?,?,?)", [(run_id, *row) for row in rows])
            db.commit()

    def test_each_pip_lists_the_models_its_runs_used_most_tokens_first(self):
        auditor, docs = self.job(), self.job("Docs writer")
        one = self.run_for(auditor, "a1", tokens=5_000)
        two = self.run_for(auditor, "a2", tokens=100)
        self.run_for(docs, "d1", tokens=1_000)          # a run from before runs recorded models
        self.models(one["id"], [("glm-5.3:cloud", "ollama", "localhost", 1_000, 100, 2),
                                ("deepseek-v4.1-flash:cloud", "ollama", "localhost", 3_000, 300, 4)])
        self.models(two["id"], [("glm-5.3:cloud", "ollama", "localhost", 5_000, 500, 1)])
        value = self.report()
        auditor_row = next(p for p in value["by_pip"] if p["name"] == "Auditor")
        self.assertEqual([(m["model"], m["input_tokens"], m["output_tokens"], m["requests"]) for m in auditor_row["models"]],
                         [("glm-5.3:cloud", 6_000, 600, 3), ("deepseek-v4.1-flash:cloud", 3_000, 300, 4)])
        self.assertEqual(next(p for p in value["by_pip"] if p["name"] == "Docs writer")["models"], [],
                         "an older run has no models; its tokens still count above")

    def test_the_pips_requests_by_model_come_from_the_ledger(self):
        # A ledger of its own: the shared one would carry these rows into the next test's totals.
        own = Path(self.registry.directory).parent / "pips-models-ledger.sqlite"
        patcher = patch.object(usage_ledger, "ledger_path", return_value=own)
        patcher.start(); self.addCleanup(patcher.stop)
        with contextlib.suppress(Exception):
            usage_ledger._reset_for_tests()
        usage_ledger.record(provider="ollama", base_url="http://127.0.0.1:11434", model="glm-5.3:cloud", source="pip",
                            input_tokens=900, output_tokens=90, now=NOW - 60)
        usage_ledger.record(provider="ollama", base_url="http://127.0.0.1:11434", model="glm-5.3:cloud", source="pip",
                            input_tokens=100, output_tokens=10, now=NOW - 30)
        usage_ledger.record(provider="ollama", base_url="http://127.0.0.1:11434", model="main-chat-model", source="main",
                            input_tokens=7_000, output_tokens=500, now=NOW - 60)
        usage_ledger.record(provider="ollama", base_url="http://127.0.0.1:11434", model="old-model", source="pip",
                            input_tokens=5, output_tokens=5, now=NOW - 40 * 86400)
        rows = self.report("7d")["by_model"]
        self.assertEqual([(r["model"], r["input_tokens"], r["output_tokens"], r["requests"]) for r in rows],
                         [("glm-5.3:cloud", 1_000, 100, 2)], "only the Pips' requests, only in the range")
        self.assertEqual(self.report("all")["all_tokens"], 7_500 + 1_100 + 10, "the whole range is everything, as before")

    def test_a_run_outside_the_range_is_left_out(self):
        auditor = self.job()
        self.now = "2026-09-20T10:00:00.000Z"           # finished eleven days before NOW
        self.run_for(auditor, "old", tokens=9_000)
        self.now = "2026-10-01T10:00:00.000Z"
        self.run_for(auditor, "new", tokens=1_000)
        self.assertEqual(self.report("7d")["by_pip"][0]["runs"], 1)
        self.assertEqual(self.report("30d")["by_pip"][0]["runs"], 2)
        self.assertEqual(self.report("all")["totals"]["runs"], 2)

    def test_the_whole_range_comes_with_it_so_the_tab_can_say_how_much_of_it_pips_used(self):
        with contextlib.suppress(Exception):
            usage_ledger._reset_for_tests()
        usage_ledger.record(provider="ollama", base_url="http://127.0.0.1:11434", model="m",
                            input_tokens=7_000, output_tokens=500, now=NOW - 60)
        self.assertEqual(self.report()["all_tokens"], 7_500)

    def test_a_profile_that_never_used_pips_gets_an_empty_tab_and_no_registry(self):
        with patch("dgc.workspace_registry.in_use", return_value=False), \
                patch("dgc.workspace_registry.WorkspaceRegistry", side_effect=AssertionError("no registry is created")):
            value = pip_usage_report.report("today", now=NOW)
        self.assertEqual((value["by_pip"], value["totals"]["runs"]), ([], 0))

    def test_the_answer_matches_its_protocol_declaration(self):
        self.run_for(self.job(), "a1", tokens=1_000)
        value = self.report("month")
        self.assertIsNone(event_error({"type": "pip_usage_report", "seq": 4, "request_id": "u1", **value}))
        self.assertIsNotNone(event_error({"type": "pip_usage_report", "seq": 4, "request_id": "u1", **value, "prompt": "no"}))
        self.assertIsNone(command_error({"type": "get_pip_usage_report", "request_id": "u1", "range": "30d"}))
        self.assertIsNotNone(command_error({"type": "get_pip_usage_report", "request_id": "u1", "range": "year"}))

    def test_the_backend_answers_on_its_own_thread(self):
        from dgc.headless import Backend
        backend, sent, done = Backend.__new__(Backend), [], threading.Event()

        class Emitter:
            def emit(self, kind, **fields):
                sent.append((kind, fields))
                done.set()
        backend.em = Emitter()
        with patch.object(pip_usage_report, "report", return_value={
                "range": "7d", "generated_at": "2026-10-01T12:00:00Z", "timezone": "UTC", "all_tokens": 10,
                "totals": {"input_tokens": 1, "output_tokens": 2, "runs": 1}, "by_pip": [], "omitted": 0}):
            backend._emit_pip_usage("u9", "7d")
            self.assertTrue(done.wait(5))
        kind, fields = sent[0]
        self.assertEqual((kind, fields["request_id"], fields["all_tokens"]), ("pip_usage_report", "u9", 10))


if __name__ == "__main__":
    unittest.main()
