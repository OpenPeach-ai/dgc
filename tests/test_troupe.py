"""Troupe's work order and run (dgc/troupe.py), with a fake runner standing in for the sub-agents: the plan checks, the
result shapes, every stage kind (each, all, votes, keep, split), stopping, the token cap, resuming from the journal,
and running agents side by side."""
import json
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import troupe


class FakeRunner(troupe.Runner):
    """Answers each agent from ANSWER(stage, prompt) -> text; records every call and the events."""

    def __init__(self, answer, width=1, admit=lambda: "", delay=0.0):
        self.answer, self.width, self._admit, self.delay = answer, width, admit, delay
        self.calls, self.events, self.fixes = [], [], 0
        self.live = self.peak = 0
        self.lock = threading.Lock()

    def admit(self):
        return self._admit()

    def run(self, stage, prompt, label, cancel, check):
        with self.lock:
            self.calls.append((stage.name, label, prompt))
            self.live += 1
            self.peak = max(self.peak, self.live)
        try:
            if self.delay:
                time.sleep(self.delay)
            text = self.answer(stage, prompt)
            if isinstance(text, Exception):
                raise text
            if isinstance(text, tuple):
                return text
            problem = check(text)
            if problem and "FIXABLE" in text:
                self.fixes += 1
                text = text.replace("FIXABLE", "")
                text = '```json\n{"result": "fixed"}\n```'
            return text, ""
        finally:
            with self.lock:
                self.live -= 1

    def event(self, kind, fields):
        self.events.append((kind, json.loads(json.dumps(fields))))


def answer_json(value) -> str:
    return "Here is what I found.\n```json\n" + json.dumps(value) + "\n```"


class PlanTests(unittest.TestCase):
    def test_templates_need_items_and_a_goal(self):
        plan = troupe.plan_from_args({"title": "Security review", "items": ["a.py", "b.py"], "template": "review",
                                      "goal": "security problems"})
        self.assertEqual([s.name for s in plan.stages], ["Review", "Verify"])
        self.assertEqual((plan.stages[0].agent, plan.stages[0].split), ("explorer", "findings"))
        self.assertEqual((plan.stages[1].agent, plan.stages[1].votes, plan.stages[1].keep.field), ("verifier", 3, "real"))
        for template in troupe.TEMPLATES:
            troupe.plan_from_args({"title": "t", "items": ["x"], "template": template, "goal": "g"})
        for bad, words in (
            ({"title": "t", "items": ["x"], "template": "review"}, "goal"),
            ({"title": "t", "items": [], "template": "review", "goal": "g"}, "items"),
            ({"title": "t", "items": ["x"], "template": "nope", "goal": "g"}, "template"),
            ({"title": "", "items": ["x"], "template": "review", "goal": "g"}, "title"),
            ({"title": "t", "items": ["x"]}, "template"),
            ({"title": "t", "items": ["x"] * 201, "template": "review", "goal": "g"}, "200"),
            ({"title": "t", "items": ["x", 3], "template": "review", "goal": "g"}, "items[1]"),
            ({"title": "t", "items": ["x"], "template": "review", "goal": "g", "stages": []}, "not both"),
        ):
            with self.subTest(words=words), self.assertRaises(troupe.PlanError) as raised:
                troupe.plan_from_args(bad)
            self.assertIn(words, str(raised.exception))

    def test_stages_are_checked_with_what_to_change(self):
        good = {"name": "Check", "agent": "verifier", "prompt": "Is {item} right?", "returns": {"ok": "boolean"}}
        troupe.plan_from_args({"title": "t", "items": ["x"], "stages": [good]})
        for change, words in (
            ({"agent": "hacker"}, "not an agent"),
            ({"prompt": "no placeholder"}, "{item}"),
            ({"returns": {"ok": "bool"}}, "not a type"),
            ({"returns": {"ok": ["string", "string"]}}, "one element"),
            ({"returns": "string"}, "must be an object"),
            ({"votes": 6}, "votes"),
            ({"votes": True}, "votes"),
            ({"keep": {"field": "missing", "equals": True}}, "not in returns"),
            ({"keep": {"field": "ok"}}, "keep"),
            ({"keep": {"field": "ok", "equals": True, "at_least": 2}}, "at_least"),
            ({"over": "some"}, "over"),
            ({"over": "all"}, "{items}"),
            ({"split": "ok"}, "list field"),
        ):
            with self.subTest(words=words), self.assertRaises(troupe.PlanError) as raised:
                troupe.plan_from_args({"title": "t", "items": ["x"], "stages": [{**good, **change}]})
            self.assertIn(words, str(raised.exception))
        with self.assertRaises(troupe.PlanError) as raised:
            troupe.plan_from_args({"title": "t", "items": ["x"], "stages": [
                {**good, "returns": {"found": ["string"]}, "split": "found"}]})
        self.assertIn("before another stage", str(raised.exception))
        with self.assertRaises(troupe.PlanError) as raised:
            troupe.plan_from_args({"title": "t", "items": ["x"], "stages": [good] * 5})
        self.assertIn("at most 4 stages", str(raised.exception))
        named = troupe.plan_from_args({"title": "t", "items": ["x"], "stages": [{**good, "agent": "my-reviewer"}]},
                                      agent_names=["my-reviewer"])
        self.assertEqual(named.stages[0].agent, "my-reviewer")

    def test_too_many_agents_is_refused_before_anything_starts(self):
        with self.assertRaises(troupe.PlanError) as raised:
            troupe.plan_from_args({"title": "t", "items": [f"f{i}" for i in range(200)], "stages": [
                {"name": "A", "prompt": "{item}", "votes": 3}]})
        self.assertIn("600 agents", str(raised.exception))


class ResultTests(unittest.TestCase):
    def test_the_last_json_object_with_the_right_shape(self):
        sketch = {"real": "boolean", "why": "string"}
        self.assertEqual(troupe.parse_result(answer_json({"real": True, "why": "x"}), sketch), ({"real": True, "why": "x"}, ""))
        text = 'First {"real": false, "why": "draft"} then\n{"real": true, "why": "final", "extra": 1}'
        self.assertEqual(troupe.parse_result(text, sketch)[0]["why"], "final", "the last one wins; extra fields are fine")
        for bad, words in (("no json here", "no JSON"), ('{"real": "yes", "why": "x"}', "boolean"),
                           ('{"why": "x"}', "missing 'real'"), ("```json\n{broken\n```", "does not parse"),
                           ("[1, 2]", "no JSON")):
            with self.subTest(bad=bad):
                value, problem = troupe.parse_result(bad, sketch)
                self.assertIsNone(value)
                self.assertIn(words, problem)
        nested = {"findings": [{"title": "string", "line": "integer"}]}
        self.assertEqual(troupe.parse_result(answer_json({"findings": [{"title": "a", "line": 3}]}), nested)[1], "")
        self.assertIn("integer", troupe.parse_result(answer_json({"findings": [{"title": "a", "line": "3"}]}), nested)[1])
        self.assertIn("integer", troupe.parse_result(answer_json({"findings": [{"title": "a", "line": True}]}), nested)[1])

    def test_each_agent_is_told_its_item_and_the_json_to_end_with(self):
        plan = troupe.plan_from_args({"title": "t", "items": ["src/a.py"], "template": "review", "goal": "bugs"})
        prompt = troupe.child_prompt(plan.stages[0], item="src/a.py")
        self.assertIn("src/a.py", prompt)
        self.assertIn('{"findings": [{"title": "string", "where": "string", "why": "string"}]}', prompt)
        vote = troupe.child_prompt(plan.stages[1], item={"title": "x"}, vote=1)
        self.assertIn("one of 3 agents checking this independently (number 2)", vote)
        self.assertIn('"title": "x"', vote)


class RunTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-troupe-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def review(self, items=("a.py", "b.py")):
        return troupe.plan_from_args({"title": "Security review", "items": list(items), "template": "review",
                                      "goal": "security problems"})

    @staticmethod
    def reviewer(stage, prompt):
        if stage.name == "Review":
            if "a.py" in prompt.split("security problems:")[1][:40]:
                return answer_json({"findings": [{"title": "SQL injection", "where": "a.py:3", "why": "string concat"},
                                                 {"title": "Weak hash", "where": "a.py:9", "why": "md5"}]})
            return answer_json({"findings": []})
        if "SQL injection" in prompt:
            return answer_json({"real": True, "why": "it is"})
        number = int(prompt.split("(number ")[1].split(")")[0])
        return answer_json({"real": number == 1, "why": "only one thinks so"})

    def test_review_keeps_only_what_most_verifiers_agree_is_real(self):
        runner = FakeRunner(self.reviewer)
        run = troupe.Run(self.review(), runner, self.root)
        run.run_here()
        self.assertEqual(run.state, "done")
        self.assertEqual([(s["name"], s["total"], s["done"], s["kept"]) for s in run.stages],
                         [("Review", 2, 2, 2), ("Verify", 6, 6, 1)])
        self.assertEqual(len(run.outputs), 1)
        kept = run.outputs[0]
        self.assertEqual((kept["item"]["title"], kept["item"]["from"], kept["agreed"]), ("SQL injection", "a.py", 3))
        self.assertEqual(len(kept["votes"]), 3)
        report = run.report()
        self.assertIn("Review: 2 of 2 agents finished, 2 kept", report)
        self.assertIn("Verify: 6 of 6 agents finished, 1 kept", report)
        self.assertIn("SQL injection", report)
        self.assertNotIn("Weak hash", report.split("Results of the last stage")[1])
        self.assertTrue((run.dir / "plan.json").is_file() and (run.dir / "report.md").is_file())
        self.assertEqual(len(json.loads((run.dir / "results.json").read_text())), 1)
        self.assertEqual(len((run.dir / "results.jsonl").read_text().splitlines()), 8, "every agent journaled")
        kinds = [k for k, _ in runner.events]
        self.assertEqual((kinds[0], kinds[-1]), ("started", "finished"))
        self.assertEqual(runner.events[-1][1]["state"], "done")

    def test_compare_has_every_option_judged_together(self):
        plan = troupe.plan_from_args({"title": "Cache", "items": ["Redis", "SQLite", "in memory"], "template": "compare",
                                      "goal": "a cache"})

        def answer(stage, prompt):
            if stage.name == "Explore":
                return answer_json({"option": "o", "how": "h", "pros": ["p"], "cons": ["c"]})
            self.assertIn("1. ", prompt)
            self.assertIn("3. ", prompt)
            return answer_json({"best": "SQLite", "why": "simple"})
        runner = FakeRunner(answer)
        run = troupe.Run(plan, runner, self.root)
        run.run_here()
        self.assertEqual([(s["total"], s["kept"]) for s in run.stages], [(3, 3), (3, 1)])
        self.assertEqual([v["best"] for v in run.outputs[0]["votes"]], ["SQLite"] * 3)

    def test_a_reply_without_its_json_is_fixed_once_or_counted_failed(self):
        plan = troupe.plan_from_args({"title": "t", "items": ["x", "y", "z"], "stages": [
            {"name": "A", "prompt": "{item}"}]})
        runner = FakeRunner(lambda stage, prompt: ("FIXABLE no json" if "\nx\n" in f"\n{prompt.split(chr(10))[0]}\n"
                                                   else (("", "the model went away") if "y" == prompt.split("\n")[0]
                                                         else RuntimeError("boom"))))
        run = troupe.Run(plan, runner, self.root)
        run.run_here()
        self.assertEqual(runner.fixes, 1)
        self.assertEqual((run.stages[0]["done"], run.stages[0]["failed"]), (1, 2))
        self.assertEqual(run.state, "done", "agents failing is not the run failing")
        rows = [json.loads(line) for line in (run.dir / "results.jsonl").read_text().splitlines()]
        self.assertEqual(sorted(r["failure"] for r in rows), ["", "RuntimeError: boom", "the model went away"])

    def test_stopping_starts_nothing_more_and_says_so(self):
        plan = troupe.plan_from_args({"title": "t", "items": [f"i{n}" for n in range(6)], "stages": [
            {"name": "A", "prompt": "{item}"}]})
        holder = {}

        def answer(stage, prompt):
            if len(runner.calls) == 2:
                holder["run"].stop("stopped by the user")
            return answer_json({"result": "ok"})
        runner = FakeRunner(answer)
        run = holder["run"] = troupe.Run(plan, runner, self.root)
        run.run_here()
        self.assertEqual(run.state, "stopped")
        self.assertEqual(run.stop_reason, "stopped by the user")
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual((run.stages[0]["done"], run.stages[0]["failed"]), (2, 0), "not started is not failed")
        self.assertIn("State: stopped (stopped by the user)", run.report())

    def test_the_token_cap_stops_it_before_the_next_agent(self):
        plan = troupe.plan_from_args({"title": "t", "items": ["a", "b", "c"], "stages": [{"name": "A", "prompt": "{item}"}]})
        spent = {"n": 0}

        def admit():
            spent["n"] += 1
            return "the turn's token cap was reached" if spent["n"] > 1 else ""
        runner = FakeRunner(lambda s, p: answer_json({"result": "ok"}), admit=admit)
        run = troupe.Run(plan, runner, self.root)
        run.run_here()
        self.assertEqual((run.state, run.stop_reason, len(runner.calls)),
                         ("stopped", "the turn's token cap was reached", 1))

    def test_a_resumed_run_redoes_only_what_it_had_not_finished(self):
        plan = self.review()
        first = FakeRunner(self.reviewer)
        holder = {}

        def stop_after_three(stage, prompt):
            if len(first.calls) == 4:
                holder["run"].stop()
            return self.reviewer(stage, prompt)
        first.answer = stop_after_three
        run = holder["run"] = troupe.Run(plan, first, self.root)
        run.run_here()
        self.assertEqual(run.state, "stopped")
        cached = troupe.Run.load_cached(run.dir)
        self.assertEqual(len(cached), 4)
        saved = troupe.load_plan(run.dir)
        again_plan = troupe.plan_from_args(saved)
        second = FakeRunner(self.reviewer)
        again = troupe.Run(again_plan, second, self.root, run_id=run.id, cached=cached)
        again.run_here()
        self.assertEqual(again.state, "done")
        self.assertEqual(again.reused, 4)
        self.assertEqual(len(second.calls), 4, "8 agents in all, 4 already done")
        self.assertEqual(len(again.outputs), 1)
        self.assertIn("Reused from the earlier attempt: 4", again.report())
        self.assertTrue(again.report().splitlines()[2].startswith("Journal: "), "near the top: a wake notice is trimmed")

    def test_agents_run_side_by_side_up_to_the_width(self):
        plan = troupe.plan_from_args({"title": "t", "items": [f"i{n}" for n in range(12)], "stages": [
            {"name": "A", "prompt": "{item}"}]})
        runner = FakeRunner(lambda s, p: answer_json({"result": "ok"}), width=4, delay=0.05)
        run = troupe.Run(plan, runner, self.root)
        run.run_here()
        self.assertEqual(run.stages[0]["done"], 12)
        self.assertEqual(runner.peak, 4)
        self.assertEqual([o["item"] for o in run.outputs], [f"i{n}" for n in range(12)], "results stay in item order")

    def test_a_split_that_multiplies_past_the_cap_is_cut_and_says_so(self):
        plan = troupe.plan_from_args({"title": "t", "items": ["a", "b"], "stages": [
            {"name": "Find", "prompt": "{item}", "returns": {"found": ["string"]}, "split": "found"},
            {"name": "Check", "prompt": "{item}", "returns": {"ok": "boolean"}}]})
        runner = FakeRunner(lambda s, p: answer_json({"found": [str(n) for n in range(10)]}) if s.name == "Find"
                            else answer_json({"ok": True}))
        with patch.object(troupe, "MAX_AGENTS", 7):
            run = troupe.Run(plan, runner, self.root)
            run.run_here()
            report = run.report()
        self.assertEqual(run.stages[1]["total"], 5)
        self.assertEqual(run.stages[1]["dropped"], 15)
        self.assertIn("15 not started (a troupe starts at most 7 agents)", report)

    def test_the_report_keeps_every_finding_on_one_line_however_long_the_votes(self):
        plan = troupe.plan_from_args({"title": "t", "items": [f"f{n}.py" for n in range(8)], "template": "review",
                                      "goal": "bugs"})
        long_why = "because " + "the code clearly shows it " * 60

        def answer(stage, prompt):
            if stage.name == "Review":
                return answer_json({"findings": [{"title": "Problem in " + prompt.split("bugs:")[1].split()[0],
                                                  "where": "x:1", "why": "w"}]})
            return answer_json({"real": True, "why": long_why})
        run = troupe.Run(plan, FakeRunner(answer), self.root)
        run.run_here()
        report = run.report()
        self.assertLess(len(report), troupe.REPORT_CHARS + 2000)
        lines = [line for line in report.splitlines() if line[:2].rstrip(".").isdigit()]
        self.assertEqual(len(lines), 8, "all eight kept findings, one line each")
        self.assertTrue(all("3 of 3 agreed" in line and len(line) < 1000 for line in lines))
        self.assertIn("8 kept", report)
        self.assertEqual(len(json.loads((run.dir / "results.json").read_text())[0]["votes"]), 3, "the full votes stay")

    def test_started_in_the_background_it_ends_and_says_who_to_tell(self):
        plan = troupe.plan_from_args({"title": "t", "items": ["a"], "stages": [{"name": "A", "prompt": "{item}"}]})
        ended = threading.Event()
        run = troupe.Run(plan, FakeRunner(lambda s, p: answer_json({"result": "ok"})), self.root)
        run.on_end = lambda finished: ended.set()
        run.start()
        self.assertTrue(ended.wait(10))
        run.join(5)
        self.assertEqual(run.state, "done")


if __name__ == "__main__":
    unittest.main()
