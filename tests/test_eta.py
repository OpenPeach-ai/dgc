"""Turn ETA: prompt classification, priors, structure blending, smoothing, calibration records,
and the agent-facing hooks. No model is contacted."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from dgc.eta import (CHECKPOINT_S, SHOW_AFTER_S, Eta, EtaStats, TurnEstimator, classify_prompt,
                     format_stats, _span)


class ClassifyTests(unittest.TestCase):
    def test_verbs_and_length(self):
        self.assertEqual(classify_prompt("fix the failing login test").bucket, "test/short")
        self.assertEqual(classify_prompt("why does the build fail?").verb, "fix")
        self.assertEqual(classify_prompt("explain how sessions are stored").verb, "explain")
        self.assertEqual(classify_prompt("what is this file for?").verb, "explain")
        self.assertEqual(classify_prompt("refactor the auth module into a package").verb, "refactor")
        self.assertEqual(classify_prompt("add a --json flag to the export command").verb, "add")
        self.assertEqual(classify_prompt("ok").verb, "other")
        self.assertEqual(classify_prompt(" ".join(["word"] * 70)).length, "long")


class SpanTests(unittest.TestCase):
    def test_ranges_read_naturally(self):
        self.assertEqual(_span(12, 40), "10–40 s")
        self.assertEqual(_span(70, 200), "1–4 min")
        self.assertEqual(_span(100, 110), "2 min")
        self.assertEqual(_span(4000, 5000), "1h+")


class EstimatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-eta-")
        self.stats = EtaStats(Path(self.tmp.name) / "eta.json", project="/proj")

    def tearDown(self):
        self.tmp.cleanup()

    def test_hidden_early_then_prior_then_structure(self):
        est = TurnEstimator(self.stats, classify_prompt("fix the bug in parser"), now=0.0)
        early = est.estimate(now=5)
        self.assertFalse(early.visible)
        self.assertEqual(early.basis, "prior")
        shown = est.estimate(now=SHOW_AFTER_S + 1)
        self.assertTrue(shown.visible)
        self.assertGreater(shown.high, shown.low)
        est.on_todos([{"status": "done"}, {"status": "in_progress"}, {"status": "pending"}], now=60)
        structured = est.estimate(now=60)
        self.assertEqual(structured.basis, "structure")
        self.assertEqual((structured.tasks_done, structured.tasks_total), (1, 3))
        self.assertIn("1/3 tasks", structured.label)
        self.assertGreater(structured.confidence, shown.confidence)

    def test_range_shrinks_over_time_but_never_grows_without_reason(self):
        est = TurnEstimator(self.stats, classify_prompt("add a feature flag"), now=0.0)
        first = est.estimate(now=25)
        later = est.estimate(now=40)
        self.assertLessEqual(later.high, first.high + 1e-6)
        est.on_retry("tests failed")
        widened = est.estimate(now=41)
        self.assertGreater(widened.high, later.high)
        self.assertLess(widened.confidence, later.confidence)

    def test_prior_learns_from_recorded_turns(self):
        features = classify_prompt("write tests for the parser")
        for actual in (30, 40, 50, 60, 70):
            TurnEstimator(self.stats, features, now=0.0).finish(now=actual)
        p50, p80, samples = self.stats.prior(features)
        self.assertEqual(samples, 5)
        self.assertAlmostEqual(p50, 50.0)
        self.assertGreater(p80, p50)
        reloaded = EtaStats(self.stats.path, project="/proj")
        self.assertEqual(reloaded.prior(features)[2], 5, "history persists across processes")
        other = EtaStats(self.stats.path, project="/elsewhere")
        self.assertEqual(other.prior(features)[2], 0, "history is per project")

    def test_calibration_records_and_summary(self):
        features = classify_prompt("fix flaky login")
        est = TurnEstimator(self.stats, features, now=0.0)
        est.estimate(now=CHECKPOINT_S + 0.5)          # the range shown at the checkpoint is scored
        est.finish(now=90)
        summary = self.stats.summary()
        self.assertEqual(summary["turns"], 1)
        self.assertEqual(summary["scored"], 1)
        self.assertIn(summary["coverage"], (0.0, 1.0))
        text = format_stats(summary)
        self.assertIn("Range held", text)
        self.assertIn("fix/short", text)
        self.assertIn("No finished turns", format_stats(EtaStats(Path(self.tmp.name) / "x.json", project="p").summary()))

    def test_cancelled_or_tiny_turns_do_not_pollute_history(self):
        features = classify_prompt("explain this")
        TurnEstimator(self.stats, features, now=0.0).finish(now=40, completed=False)
        TurnEstimator(self.stats, features, now=0.0).finish(now=1.0)
        self.assertEqual(self.stats.summary()["turns"], 0)

    def test_corrupt_or_oversized_stats_file_is_ignored(self):
        path = Path(self.tmp.name) / "bad.json"
        path.write_text("{not json")
        stats = EtaStats(path, project="p")
        self.assertEqual(stats.summary()["turns"], 0)
        self.assertTrue(stats.save())
        self.assertEqual(json.loads(path.read_text())["version"], 1)

    def test_label_hedges_when_confidence_is_low(self):
        eta = Eta(elapsed=30, low=100, high=400, confidence=0.1, basis="prior")
        self.assertIn("a few min", eta.label)
        eta = Eta(elapsed=30, low=100, high=400, confidence=0.5, basis="prior", tasks_done=2, tasks_total=5)
        self.assertEqual(eta.label, "~2–7 min left · 2/5 tasks")


class AgentHookTests(unittest.TestCase):
    def test_agent_exposes_a_snapshot_only_while_a_turn_runs(self):
        from dgc.agent import Agent

        class Bare(Agent):           # `mode` is a read-only property on the real class
            mode = "default"
        agent = object.__new__(Bare)
        agent.eta = None
        agent._eta_stats_cache = False
        agent.depth = 0
        agent.goal = ""
        agent.session_root = Path("/proj")

        class Cfg:
            def get(self, key, default=None):
                return {"eta": True, "model": "qwen"}.get(key, default)
        agent.config = Cfg()
        import threading
        agent.cancelled = threading.Event()
        self.assertIsNone(agent.eta_snapshot())
        agent._eta_begin("fix the failing test")
        self.assertIsNotNone(agent.eta)
        agent._eta_request({"output_tokens": 120})
        agent._eta_tool("bash", 2_500_000)
        agent._eta_todos([{"status": "done"}, {"status": "pending"}])
        snapshot = agent.eta_snapshot()
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot.tasks_total, 2)
        agent._eta_end(True)
        self.assertIsNone(agent.eta)
        self.assertIsNone(agent.eta_snapshot())
        agent.depth = 1
        agent._eta_begin("nested")
        self.assertIsNone(agent.eta, "sub-agents never estimate")

    def test_commands_and_defaults(self):
        from dgc.commands import resolve_command
        from dgc.config import DEFAULTS
        self.assertTrue(resolve_command("eta", "tui").available_while_running)
        self.assertIsNotNone(resolve_command("eta", "classic"))
        self.assertTrue(resolve_command("notify", "tui").accepts_args)
        self.assertEqual(DEFAULTS["eta"], True)
        self.assertEqual(DEFAULTS["notify"], "off")


if __name__ == "__main__":
    unittest.main()
