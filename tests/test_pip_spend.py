"""Spend control: what each Pip costs, and a daily limit that stops automatic runs only."""
import contextlib
import io
import json
import sqlite3
import unittest
from pathlib import Path

from dgc import pip_checkpoints as checkpoints, pip_cli, pip_schedules as schedules, pip_spend as spend, pip_usage
from dgc.workspace_registry import RegistryError

class SpendTests(unittest.TestCase):
    setUp = __import__("tests.test_pip_schedules", fromlist=["x"]).ScheduleStateTests.setUp

    def job(self):
        job = self.store.create(self.workspace["id"], "Auditor", "Inspect source", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 5}}, "user")
        return self.store.accept(job["id"], proposal["id"], 1, "user")

    def finish(self, run_id, tokens=None, error=None):
        row = self.store.claim_next()
        self.assertEqual(row["id"], run_id)
        if error:
            return self.store.finish(run_id, error=error)
        result = {"summary": "Checked", "findings": [], "limitations": ["Tests were not run."], "tests_executed": False,
                  "verification": checkpoints._SOURCE_VERIFICATION}
        if tokens is not None:
            result["usage"] = {"input_tokens": tokens - 100, "output_tokens": 100}
        return self.store.finish(run_id, result=result)

    def ledger(self, run_id, input_tokens, output_tokens):
        """What the runner records when it imports a run's usage."""
        path = Path(self.registry.directory).parent / "usage.sqlite"
        with contextlib.closing(sqlite3.connect(path)) as db:
            pip_usage._imports_table(db)
            db.execute("INSERT INTO pip_usage_imports(run_id,imported_at,input_tokens,output_tokens,requests) VALUES (?,?,?,?,?)",
                       (run_id, 0, input_tokens, output_tokens, 3))
            db.commit()

    def test_usage_counts_each_run_and_prefers_what_the_runner_imported(self):
        job = self.job()
        first = self.store.enqueue(job["id"], "one", "user", self.cfg)
        self.finish(first["id"], tokens=5_000)
        second = self.store.enqueue(job["id"], "two", "user", self.cfg)
        self.finish(second["id"], error={"code": "timeout", "message": "Ran out of time"})
        self.ledger(second["id"], 40_000, 2_000)        # a failed run reports nothing; the ledger has it
        value = spend.usage(self.registry, job["id"])
        self.assertEqual(value["today"]["tokens"], 47_000)
        self.assertEqual(value["today"]["runs"], 2)
        self.assertEqual(value["last_30_days"], {"tokens": 47_000, "runs": 2})
        self.assertIsNone(value["daily_cap"])
        self.assertFalse(value["capped_today"])
        self.ledger(first["id"], 6_000, 500)
        self.assertEqual(spend.usage(self.registry, job["id"])["today"]["tokens"], 48_500, "the imported total wins")

    def test_the_limit_stops_schedules_for_the_day_and_never_what_you_start(self):
        job = self.job()
        spend.set_cap(self.registry, job["id"], 10_000, "editor-user")
        self.now = "2026-10-01T10:05:00.000Z"
        self.assertEqual(schedules.tick(self.registry, self.cfg)["enqueued"], 1, "under the limit: it runs")
        self.finish(self.store.runs(job["id"])[0]["id"], tokens=12_000)
        self.assertTrue(spend.usage(self.registry, job["id"])["capped_today"])
        self.now = "2026-10-01T10:10:00.000Z"
        result = schedules.tick(self.registry, self.cfg)
        self.assertEqual((result["enqueued"], result["skipped"]), (0, 1))
        events = [json.loads(p[0])["reason"] for p in self.registry.db.execute(
            "SELECT payload FROM workspace_events WHERE event_type='pip_schedule_skipped'").fetchall()]
        self.assertIn("daily_cap_reached", events, "the skip says why")
        manual = self.store.enqueue(job["id"], "manual-one", "user", self.cfg)
        self.assertEqual(manual["status"], "queued", "a run you start still runs")
        spend.set_cap(self.registry, job["id"], None, "editor-user")
        self.assertFalse(spend.over_daily_cap(self.registry, job["id"]), "removing the limit lifts it at once")

    def test_the_limit_is_the_users_and_bounded(self):
        job = self.job()
        for actor in ("main-chat", "local-scheduler"):
            with self.assertRaises(RegistryError):
                spend.set_cap(self.registry, job["id"], 50_000, actor)
        for bad in (999, 1_000_000_001, 1.5, "50000", True):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                spend.set_cap(self.registry, job["id"], bad, "editor-user")
        with self.assertRaises(RegistryError):
            spend.set_cap(self.registry, "pip_" + "0" * 32, 50_000, "editor-user")
        value = spend.set_cap(self.registry, job["id"], 50_000, "local-console")
        self.assertEqual(value["daily_cap"], 50_000)
        self.assertEqual(self.store.get(job["id"])["current_version"], 2, "not part of the reviewed job")

    def test_the_cli_shows_and_sets_the_limit_in_plain_words(self):
        from unittest.mock import patch
        job = self.job()
        self.cfg.data["pips_enabled"] = True
        sent = []

        def control(config, request, actor, **kw):
            sent.append(request)
            if request["type"] == "set_pip_daily_cap":
                return {"ok": True, "result": {"usage": spend.set_cap(self.registry, job["id"], request["daily_tokens"], actor)}}
            return {"ok": True, "result": {"usage": spend.usage(self.registry, job["id"])}}
        run = lambda *argv: (lambda out: (pip_cli.handle_command(self.cfg, list(argv)), out.getvalue()))(io.StringIO())
        with patch("dgc.pips.handle_control", side_effect=control):
            for raw, tokens in (("200k", 200_000), ("1.5m", 1_500_000), ("250,000", 250_000), ("off", None)):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(pip_cli.handle_command(self.cfg, ["usage", job["id"], "--daily-limit", raw]), 0)
                self.assertEqual(sent[-1]["daily_tokens"], tokens, raw)
            self.assertIn("No daily limit.", out.getvalue())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                pip_cli.handle_command(self.cfg, ["usage", job["id"], "--daily-limit", "200k"])
            self.assertIn("Daily limit for automatic runs: 200,000 tokens.", out.getvalue())
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                self.assertNotEqual(pip_cli.handle_command(self.cfg, ["usage", job["id"], "--daily-limit", "lots"]), 0)


if __name__ == "__main__":
    unittest.main()


class ImportTotalsTests(unittest.TestCase):
    """The runner's import records each run's own totals, which is where a failed run's cost lives."""

    def test_importing_a_run_records_its_totals_once(self):
        import tempfile
        import time
        from dgc import usage_ledger as ledger
        temp = tempfile.TemporaryDirectory(prefix="dgc-spend-")
        self.addCleanup(temp.cleanup)
        home = Path(temp.name) / ".dgc"
        run_id = "run_" + "a" * 32
        worker = home / "pips" / "runs" / run_id / "worker-home" / ".dgc"
        worker.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(worker / ledger.LEDGER_NAME)) as db:
            db.execute(ledger._SCHEMA)
            now = int(time.time())
            db.executemany("INSERT INTO requests(ts,provider,host,model,source,input_tokens,output_tokens,cached_input_tokens,metered) VALUES (?,?,?,?,?,?,?,?,?)",
                           [(now, "ollama", "local", "qwen", "chat", 1000, 50, 0, 0), (now, "ollama", "local", "qwen", "chat", 2000, 70, 0, 0)])
            db.commit()
        self.assertTrue(pip_usage.import_run(run_id, home=home))
        self.assertFalse(pip_usage.import_run(run_id, home=home), "once")
        self.assertEqual(pip_usage.run_totals([run_id, "not-a-run"], home=home), {run_id: (3000, 120)})
