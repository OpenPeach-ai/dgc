"""Parallel sub-agents up to 32 (max_parallel_tasks), and 32 really at once.

The cap was 8 by choice, not for a technical reason; it is 32 now wherever it is enforced: set_config's range,
ultra.worker_limit (the one width the prose, the batch pool and the background gate read), the batch bound
(agent._MAX_PARALLEL_TASK_BATCH: a private checkout each) and the `tasks` list of one call. The default stays 4 and
Ultra's own width 8. The proof that 32 run at once is a barrier only all 32 together can pass, with a stub model:
no sleep stands in for it.
"""
from __future__ import annotations

import threading
import unittest

from dgc import agent as agent_module, headless, subagents
from dgc.config import DEFAULTS, MAX_PARALLEL_TASKS
from dgc.llm import ChatResult, ToolCall
from dgc.tools import TOOL_SCHEMAS
from dgc.ultra import ULTRA_WORKERS, summary, worker_limit
from test_subagents import HarnessCase, calls_then


class Cfg:
    def __init__(self, **data):
        self.data = data

    def get(self, key, default=None):
        return self.data.get(key, default)


class TheCapIs32(unittest.TestCase):
    def test_one_ceiling_everywhere_it_is_enforced(self):
        self.assertEqual(MAX_PARALLEL_TASKS, 32)
        self.assertEqual(headless._CONFIG_INTEGER_RANGES["max_parallel_tasks"], (1, 32))
        self.assertEqual(agent_module._MAX_PARALLEL_TASK_BATCH, 32, "a checkout each for 32 at once")
        self.assertEqual(subagents.TASK_BATCH_MAX, 32, "one call can list as many as may run")
        task = next(t for t in TOOL_SCHEMAS if t["function"]["name"] == "task")["function"]
        self.assertEqual(task["parameters"]["properties"]["tasks"]["maxItems"], 32)
        self.assertIn("(2-32,", task["description"])

    def test_set_config_takes_1_to_32(self):
        for width in (1, 9, 16, 32):
            values, error = headless._validated_config_values({"max_parallel_tasks": width}, set())
            self.assertIsNone(error, width)
            self.assertEqual(values, {"max_parallel_tasks": width})
        for width in (0, 33, 64):
            _values, error = headless._validated_config_values({"max_parallel_tasks": width}, set())
            self.assertEqual(error, "max_parallel_tasks must be an integer from 1 to 32", width)

    def test_the_width_reaches_32_and_the_defaults_stay(self):
        self.assertEqual(DEFAULTS["max_parallel_tasks"], 4)
        self.assertEqual(ULTRA_WORKERS, 8)
        self.assertEqual(worker_limit(Cfg()), 4)
        self.assertEqual(worker_limit(Cfg(ultra_mode=True)), 8, "Ultra with no width chosen: 8")
        for chosen, runs in ((9, 9), (20, 20), (32, 32), (40, 32), (1000, 32)):
            with self.subTest(chosen=chosen):
                self.assertEqual(worker_limit(Cfg(max_parallel_tasks=chosen)), runs)
                self.assertEqual(worker_limit(Cfg(ultra_mode=True, max_parallel_tasks=chosen)), runs,
                                 "a chosen width is honoured under Ultra, wider than its 8 too")
        self.assertIn("up to 32 parallel agents", summary(Cfg(ultra_mode=True, max_subagent_depth=1, max_parallel_tasks=32)))


class ThirtyTwoReallyRunAtOnce(HarnessCase):
    def run_together(self, width, helpers, *, batch_form=True):
        h = self.make(git=True, max_parallel_tasks=width)
        together = threading.Barrier(helpers)
        lock, active = threading.Lock(), {"now": 0, "peak": 0}

        def child(n):
            def route(messages, results, cancel):
                with lock:
                    active["now"] += 1
                    active["peak"] = max(active["peak"], active["now"])
                try:
                    together.wait(60)      # BrokenBarrierError unless every helper is in at once
                    return ChatResult(content=f"finding {n}")
                finally:
                    with lock:
                        active["now"] -= 1
            return route
        items = [{"description": f"area {n}", "prompt": f"CHILD{n:02d} map area {n}"} for n in range(helpers)]
        calls = ([ToolCall("p", "task", {"tasks": items})] if batch_form
                 else [ToolCall(f"c{n}", "task", item) for n, item in enumerate(items)])
        h.run("parent: fan out", [(f"CHILD{n:02d}", child(n)) for n in range(helpers)]
              + [("parent: fan out", calls_then(calls, final="Mapped."))])
        return h, active["peak"]

    def test_one_call_listing_32_helpers_runs_all_32_at_once(self):
        h, peak = self.run_together(32, 32)
        self.assertEqual(peak, 32, "every helper was running at the same moment")
        self.assertEqual([f["state"] for f in h.of("agent_ended")], ["finished"] * 32)
        out = [m for m in h.agent.messages if m.get("role") == "tool"][0]["content"]
        self.assertTrue(out.startswith("All 32 helpers ran at the same time."), out[:200])

    def test_32_task_calls_in_one_reply_run_at_once(self):
        h, peak = self.run_together(32, 32, batch_form=False)
        self.assertEqual(peak, 32)
        self.assertEqual(sorted(f["state"] for f in h.of("agent_ended")), ["finished"] * 32)


if __name__ == "__main__":
    unittest.main()
