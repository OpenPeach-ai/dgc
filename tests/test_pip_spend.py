"""What each Pip costs in tokens. There is no daily limit (founder, 2026-10-14)."""
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

    def test_no_daily_limit_stops_a_pip(self):
        """Founder, 2026-10-14: no daily budgets. A limit an older DGC stored is ignored, whatever was spent."""
        job = self.job()
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO metadata VALUES(?,?)", ("pip_daily_token_cap:" + job["id"], "10000"))
        self.now = "2026-10-01T10:05:00.000Z"
        self.assertEqual(schedules.tick(self.registry, self.cfg)["enqueued"], 1)
        self.finish(self.store.runs(job["id"])[0]["id"], tokens=1_200_000)
        value = spend.usage(self.registry, job["id"])
        self.assertEqual((value["today"]["tokens"], value["daily_cap"], value["capped_today"]), (1_200_000, None, False))
        self.now = "2026-10-01T10:10:00.000Z"
        schedules.tick(self.registry, self.cfg)
        reasons = [json.loads(p[0])["reason"] for p in self.registry.db.execute(
            "SELECT payload FROM workspace_events WHERE event_type='pip_schedule_skipped'").fetchall()]
        self.assertNotIn("daily_cap_reached", reasons, "never skipped for what it spent")
        self.assertFalse(hasattr(spend, "over_daily_cap"))

    def test_an_older_editor_or_sdk_cannot_set_one(self):
        job = self.job()
        with self.assertRaises(RegistryError) as caught:
            spend.set_cap(self.registry, job["id"], 50_000, "editor-user")
        self.assertIn("no daily token limit", str(caught.exception))
        self.assertEqual(set(spend.set_cap(self.registry, job["id"], None, "editor-user")),
                         {"pip_id", "today", "last_30_days", "days", "daily_cap", "capped_today"},
                         "removing one answers with the usage, in the shape editors since API 41 read")
        with self.assertRaises(RegistryError):
            spend.set_cap(self.registry, "pip_" + "0" * 32, None, "editor-user")

    def test_the_cli_shows_usage_and_has_no_limit_to_set(self):
        from unittest.mock import patch
        job = self.job()
        self.cfg.data["pips_enabled"] = True

        def control(config, request, actor, **kw):
            return {"ok": True, "result": {"usage": spend.usage(self.registry, job["id"])}}
        with patch("dgc.pips.handle_control", side_effect=control):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(pip_cli.handle_command(self.cfg, ["usage", job["id"]]), 0)
            self.assertIn("Today: 0 tokens (0 runs). Last 30 days: 0 tokens (0 runs).", out.getvalue())
            self.assertNotIn("limit", out.getvalue().lower())
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                self.assertNotEqual(pip_cli.handle_command(self.cfg, ["usage", job["id"], "--daily-limit", "200k"]), 0)


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
