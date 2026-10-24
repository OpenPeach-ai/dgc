"""One `task` call that starts several helpers together: the `tasks` form.

Measured on a real session (Ultra, deepseek-v4.1-flash:cloud): the lead wrote "six investigations in
one batch" and sent ONE `task` call per reply, so the six ran strictly one after another. DGC already
runs several calls of one reply side by side, and that model batches other tools; it never batched
`task`. A list in one call needs no second call in the same reply.

What is pinned here: the schema takes either form and refuses a call that is both, neither, or a bad
list; the helpers really overlap (a barrier only all of them together can pass -- no sleep stands in
for proof); max_parallel_tasks bounds them and the rest queue; one result, each helper under its own
description, in the listed order, failures included; Stop reaches every helper; edits integrate or
conflict exactly as two separate calls of one reply do; the single form is unchanged; a background
batch returns at once and queues past the cap; and the transcript replays, restores and rewinds
every helper as a child of its own.
"""
from __future__ import annotations

import json
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import subagents
from dgc.agent import Agent, _task_call_error
from dgc.config import Config
from dgc.headless import HeadlessUI
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine
from dgc.tools import TOOL_SCHEMAS
from test_subagents import HarnessCase, Script, calls_then, clone_fixture, fixture_config
from waiting import wait_until

PARENT = "parent: fan out"


def helper(n, prompt=None, **extra):
    return {"description": f"area {n}", "prompt": prompt or f"CHILD{n} map area {n}", **extra}


def batch(*items, background=False, call_id="p"):
    return ToolCall(call_id, "task", {"tasks": list(items), "background": background})


def says(text):
    """A child that answers at once with ``text``."""
    return lambda messages, results, cancel: ChatResult(content=text)


def writes(path, content, summary):
    """A child that writes one file in its checkout, then reports."""
    def route(messages, results, cancel):
        if not results:
            return ChatResult(tool_calls=[ToolCall("w1", "write_file", {"path": path, "content": content})])
        return ChatResult(content=summary)
    return route


class _UI:
    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


class TaskBatchSchemaTests(unittest.TestCase):
    def test_the_schema_offers_both_forms_and_says_how_to_fan_out(self):
        task = next(t for t in TOOL_SCHEMAS if t["function"]["name"] == "task")["function"]
        params = task["parameters"]
        self.assertEqual(params["required"], [], "the batch form has no top-level description or prompt")
        tasks = params["properties"]["tasks"]
        self.assertEqual((tasks["type"], tasks["minItems"], tasks["maxItems"]), ("array", 2, 32),
                         "as many helpers as may run at once (config.MAX_PARALLEL_TASKS)")
        self.assertEqual(tasks["items"]["required"], ["description", "prompt"])
        self.assertEqual(set(tasks["items"]["properties"]), {"description", "prompt", "agent"})
        for one in ("description", "prompt", "agent", "background"):
            self.assertIn(one, params["properties"])
        self.assertIn("to run several helpers at once, pass them all in ONE call as `tasks`",
                      task["description"])
        self.assertIn("With tasks it applies to every helper", params["properties"]["background"]["description"])

    def test_both_neither_and_bad_lists_are_refused_in_plain_words(self):
        two = [helper(1), helper(2)]
        cases = {
            "both": ({"description": "x", "prompt": "do x", "tasks": two}, "not both"),
            "neither": ({"description": "only a label"}, "needs a prompt"),
            "nothing": ({}, "needs a prompt"),
            "not a list": ({"tasks": "a, b"}, "must be a list"),
            "one": ({"tasks": [helper(1)]}, "at least 2"),
            "thirty-three": ({"tasks": [helper(n) for n in range(33)]}, "at most 32"),
            "no prompt": ({"tasks": [helper(1), {"description": "b"}]}, "tasks[2] needs prompt"),
            "no description": ({"tasks": [{"prompt": "a"}, helper(2)]}, "tasks[1] needs description"),
            "not an object": ({"tasks": [helper(1), "map b"]}, "tasks[2] must be an object"),
            "inner background": ({"tasks": [helper(1), helper(2, background=True)]},
                                 "applies to the whole call"),
            "unparsed": ({"_unparsed": "{tasks: ["}, "could not parse"),
        }
        for name, (args, needle) in cases.items():
            with self.subTest(name):
                error = _task_call_error(args)
                self.assertTrue(error.startswith("error: "), error)
                self.assertIn(needle, error)
        for ok in ({"description": "x", "prompt": "do x"}, {"prompt": "do x"},
                   {"tasks": two}, {"tasks": two, "background": True},
                   {"tasks": two, "description": "a label", "agent": "explorer"}):
            with self.subTest(ok=ok):
                self.assertEqual(_task_call_error(ok), "")

    def test_a_refused_batch_starts_nothing_and_asks_nothing(self):
        with __import__("tempfile").TemporaryDirectory(prefix="dgc-batch-refused-") as root:
            asked = []

            class UI(_UI):
                def approve(self, *args, **kwargs):
                    asked.append(args)
                    return "once"
            agent = Agent(fixture_config(Path(root), mode="default"), UI())
            try:
                out = agent._handle_call(ToolCall("p", "task", {"prompt": "x", "tasks": [helper(1), helper(2)]}))
                self.assertIn("not both", out)
                self.assertEqual(asked, [], "an invalid call must not reach an approval card")
                self.assertEqual(agent.subagents.snapshot()["items"], [])
            finally:
                agent.mcp.stop_all()

    def test_each_helper_is_decided_by_its_own_description(self):
        two = {"tasks": [{"description": "map auth", "prompt": "a"},
                         {"description": "deploy prod", "prompt": "b"}]}
        self.assertEqual(PermissionEngine("auto", {}).decide("task", two)[0], ALLOW)
        self.assertEqual(PermissionEngine("auto", {"deny": ["Task(deploy*)"]}).decide("task", two)[0], DENY,
                         "a deny written for one helper must hold inside a batch")
        self.assertEqual(PermissionEngine("auto", {"ask": ["Task(deploy*)"]}).decide("task", two)[0], ASK)
        self.assertEqual(PermissionEngine("default", {}).decide("task", two)[0], ASK)
        self.assertEqual(PermissionEngine("plan", {}).decide("task", two)[0], DENY)
        self.assertEqual(PermissionEngine("default", {"allow": ["Task"]}).decide("task", two)[0], ALLOW)

    def test_interactive_ultra_launches_an_omitted_background_batch_in_the_background(self):
        with __import__("tempfile").TemporaryDirectory(prefix="dgc-batch-ultra-") as root:
            agent = Agent(fixture_config(Path(root), ultra_mode=True), _UI())
            try:
                omitted = batch(helper(1), helper(2))
                del omitted.arguments["background"]
                explicit = batch(helper(1), helper(2), background=False, call_id="q")
                # Each alone in its reply: one call that lists its helpers is the whole fan-out.
                agent._normalize_ultra_task_batch([omitted])
                agent._normalize_ultra_task_batch([explicit])
                self.assertIs(omitted.arguments.get("background"), True)
                self.assertIs(explicit.arguments["background"], False, "an explicit choice is kept")
            finally:
                agent.mcp.stop_all()


class TaskBatchRunTests(HarnessCase):
    def tool_messages(self, h):
        return [m for m in h.agent.messages if m.get("role") == "tool"]

    def test_the_helpers_of_one_call_run_at_the_same_time(self):
        h = self.make(git=True, max_parallel_tasks=4)
        together = threading.Barrier(3)

        def concurrent(n):
            def route(messages, results, cancel):
                together.wait(15)      # BrokenBarrierError unless all three are in at once
                return ChatResult(content=f"finding {n}")
            return route
        call = batch(helper(0), helper(1), helper(2))
        h.run(PARENT, [(f"CHILD{n}", concurrent(n)) for n in range(3)]
              + [(PARENT, calls_then([call], final="Three areas mapped."))])
        started = h.of("agent_started")
        self.assertEqual([f["call_id"] for f in started], ["p#1", "p#2", "p#3"])
        self.assertTrue(all(f["parallel"] for f in started))
        self.assertEqual([f["state"] for f in h.of("agent_ended")], ["finished"] * 3)
        # One call, one result: the model asked once and is answered once.
        tools = self.tool_messages(h)
        self.assertEqual([m["tool_call_id"] for m in tools], ["p"])
        out = tools[0]["content"]
        self.assertTrue(out.startswith("All 3 helpers ran at the same time."), out)
        self.assertLess(out.index("[1] area 0\n"), out.index("[2] area 1\n"))
        self.assertLess(out.index("[2] area 1\n"), out.index("[3] area 2\n"))
        for n in range(3):
            self.assertIn(f"finding {n}", out)
        self.assertEqual(len(tools[0]["_dgc_task_batch"]), 3)
        # Each helper is a normal child on screen: its own spawn card, then the batch's own card.
        cards = [f["call_id"] for f in h.of("tool_call") if f["name"] == "task"]
        self.assertEqual(cards, ["p", "p#1", "p#2", "p#3"])
        self.assertEqual(h.of("tool_call")[0]["summary"], "3 helpers · area 0, area 1, area 2")
        results = [f["call_id"] for f in h.of("tool_result") if f["name"] == "task"]
        self.assertEqual(sorted(results[:-1]), ["p#1", "p#2", "p#3"])
        self.assertEqual(results[-1], "p", "the batch card closes after every helper")
        self.assertFramesValid(h)

    def test_max_parallel_tasks_bounds_them_and_the_rest_queue(self):
        h = self.make(git=True, max_parallel_tasks=2)
        lock, events = threading.Lock(), []
        active = {"now": 0, "peak": 0}
        pair = threading.Barrier(2)
        third_started = threading.Event()

        def route_for(n):
            def route(messages, results, cancel):
                with lock:
                    events.append(f"start{n}")
                    active["now"] += 1
                    active["peak"] = max(active["peak"], active["now"])
                try:
                    if n in (0, 1):
                        pair.wait(15)                 # the first two are in at once
                    if n == 1:
                        # Still working while the third starts: the third took the slot the first
                        # freed, not a third worker.
                        third_started.wait(15)
                    if n == 2:
                        third_started.set()
                    return ChatResult(content=f"finding {n}")
                finally:
                    with lock:
                        events.append(f"end{n}")
                        active["now"] -= 1
            return route
        call = batch(helper(0), helper(1), helper(2))
        h.run(PARENT, [(f"CHILD{n}", route_for(n)) for n in range(3)]
              + [(PARENT, calls_then([call], final="done"))])
        self.assertEqual(active["peak"], 2, events)
        self.assertGreater(events.index("start2"), events.index("end0"), events)
        self.assertLess(events.index("start2"), events.index("end1"), events)
        self.assertEqual([f["state"] for f in h.of("agent_started")], ["queued"] * 3,
                         "a helper waiting for a worker reads queued")
        out = self.tool_messages(h)[0]["content"]
        self.assertIn("3 helpers ran at the same time, at most 2 at once (max_parallel_tasks): "
                      "the other 1 started as slots freed.", out)
        self.assertEqual([f["state"] for f in h.of("agent_ended")], ["finished"] * 3)

    def test_one_result_in_the_listed_order_with_a_failure_in_its_place(self):
        h = self.make(git=True, max_parallel_tasks=4)
        third_done, finished = threading.Event(), []

        def first(messages, results, cancel):
            third_done.wait(15)              # finishes last, is still reported first
            finished.append(1)
            return ChatResult(content="first finding")

        def broken(messages, results, cancel):
            finished.append(2)
            return ChatResult(content="")    # no summary at all: that helper fails

        def third(messages, results, cancel):
            finished.append(3)
            third_done.set()
            return ChatResult(content="third finding")
        call = batch(helper(1), helper(2), helper(3))
        h.run(PARENT, [("CHILD1", first), ("CHILD2", broken), ("CHILD3", third),
                       (PARENT, calls_then([call], final="done"))])
        self.assertLess(finished.index(3), finished.index(1))
        out = self.tool_messages(h)[0]["content"]
        one, two, three = (out.index(f"[{n}] area {n}\n") for n in (1, 2, 3))
        self.assertLess(one, two)
        self.assertLess(two, three)
        self.assertIn("first finding", out[one:two])
        self.assertIn("did not complete", out[two:three], "the failure is reported, in its place")
        self.assertIn("third finding", out[three:])
        states = {f["id"]: f["state"] for f in h.of("agent_ended")}
        self.assertEqual(sorted(states.values()), ["failed", "finished", "finished"])

    def test_stop_reaches_every_helper(self):
        h = self.make(git=True, max_parallel_tasks=4)
        entered = threading.Barrier(4)        # three helpers and this test
        saw_stop = []

        def stubborn(n):
            def route(messages, results, cancel):
                entered.wait(15)
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline and not (cancel is not None and cancel.is_set()):
                    time.sleep(0.01)
                saw_stop.append(n if cancel is not None and cancel.is_set() else None)
                return ChatResult(content="still going")
            return route
        call = batch(helper(0), helper(1), helper(2))
        done = {}
        runner = threading.Thread(target=lambda: done.setdefault("ok", h.run(
            PARENT, [(f"CHILD{n}", stubborn(n)) for n in range(3)]
            + [(PARENT, calls_then([call], final="must not be asked"))])))
        runner.start()
        entered.wait(15)
        h.agent.cancelled.set()               # the turn's Stop
        runner.join(30)
        self.assertFalse(runner.is_alive())
        self.assertEqual(sorted(saw_stop), [0, 1, 2], "every helper's own token was set")
        self.assertEqual([f["state"] for f in h.of("agent_ended")], ["stopped"] * 3)
        out = self.tool_messages(h)[0]["content"]
        self.assertEqual(out.count("did not complete"), 3, out)

    def _scenario(self, routes, calls):
        h = self.make(git=True, max_parallel_tasks=4)
        h.run(PARENT, routes + [(PARENT, calls_then(calls, final="done"))])
        tools = self.tool_messages(h)
        outputs = (tools[0]["_dgc_task_batch"] if len(tools) == 1 and "_dgc_task_batch" in tools[0]
                   else [m["content"] for m in tools])
        landed = ["completed and integrated" in out for out in outputs]
        retained, errors = h.agent.retained_tasks()
        files = {path.name: path.read_text() for path in sorted(h.root.glob("*.txt"))}
        for task in retained:
            h.agent.resolve_retained_task(task.id, "drop")
        self.assertFalse(errors)
        return landed, len(retained), files

    def test_edits_integrate_or_conflict_exactly_as_two_calls_of_one_reply_do(self):
        def separate(*items):
            return [ToolCall(f"s{n}", "task", item) for n, item in enumerate(items)]
        disjoint = [("CHILD1", writes("one.txt", "one\n", "wrote one")),
                    ("CHILD2", writes("two.txt", "two\n", "wrote two"))]
        items = (helper(1), helper(2))
        as_batch = self._scenario(disjoint, [batch(*items)])
        as_calls = self._scenario(disjoint, separate(*items))
        self.assertEqual(as_batch, ([True, True], 0, {"one.txt": "one\n", "two.txt": "two\n"}))
        self.assertEqual(as_batch, as_calls)

        same = [("CHILD1", writes("shared.txt", "first\n", "wrote first")),
                ("CHILD2", writes("shared.txt", "second\n", "wrote second"))]
        as_batch = self._scenario(same, [batch(*items)])
        as_calls = self._scenario(same, separate(*items))
        self.assertEqual(as_batch, ([True, False], 1, {"shared.txt": "first\n"}),
                         "the first lands, the overlapping second is retained, never overwritten")
        self.assertEqual(as_batch, as_calls)

    def test_a_list_sent_as_a_json_string_is_repaired_before_it_is_recorded(self):
        h = self.make(git=True, max_parallel_tasks=4)
        call = ToolCall("p", "task", {"tasks": json.dumps([helper(1), helper(2)])})
        h.run(PARENT, [("CHILD1", says("finding one")), ("CHILD2", says("finding two")),
                       (PARENT, calls_then([call], final="done"))])
        self.assertEqual([f["call_id"] for f in h.of("agent_started")], ["p#1", "p#2"])
        recorded = next(m for m in h.agent.messages if m.get("role") == "assistant" and m.get("tool_calls"))
        saved = json.loads(recorded["tool_calls"][0]["function"]["arguments"])
        self.assertIsInstance(saved["tasks"], list, "the transcript holds the list that ran")
        self.assertIn("finding two", self.tool_messages(h)[0]["content"])

    def test_the_single_form_is_unchanged(self):
        h = self.make(git=True)
        h.run(PARENT, [("CHILD-ONE", says("one finding")),
                       (PARENT, calls_then([ToolCall("s1", "task", {
                           "description": "one thing", "prompt": "CHILD-ONE look"})], final="done"))])
        self.assertEqual([f["call_id"] for f in h.of("agent_started")], ["s1"])
        self.assertFalse(h.of("agent_started")[0]["parallel"])
        tool = self.tool_messages(h)[0]
        self.assertNotIn("_dgc_task_batch", tool)
        self.assertTrue(tool["content"].startswith("Sub-task 'one thing' completed"), tool["content"])
        self.assertEqual([f["call_id"] for f in h.of("tool_call") if f["name"] == "task"], ["s1"])

    def test_outside_a_git_project_they_run_one_after_another_and_say_why(self):
        h = self.make(git=False)
        order = []

        def record(n):
            def route(messages, results, cancel):
                order.append(n)
                return ChatResult(content=f"finding {n}")
            return route
        h.run(PARENT, [("CHILD1", record(1)), ("CHILD2", record(2)),
                       (PARENT, calls_then([batch(helper(1), helper(2))], final="done"))])
        out = self.tool_messages(h)[0]["content"]
        self.assertTrue(out.startswith("These 2 helpers ran one after another, not at the same time: "
                                       "this project is not a Git repository"), out)
        self.assertEqual(order, [1, 2])
        self.assertEqual([f["call_id"] for f in h.of("agent_started")], ["p#1", "p#2"])

    def test_a_background_batch_returns_at_once_and_queues_past_the_cap(self):
        h = self.make(git=True, mode="auto", max_parallel_tasks=2)
        notices = []
        h.agent.on_detached_ended = notices.append
        lock, events = threading.Lock(), []
        release = {n: threading.Event() for n in range(3)}

        def held(n):
            def route(messages, results, cancel):
                with lock:
                    events.append(f"start{n}")
                release[n].wait(20)
                with lock:
                    events.append(f"end{n}")
                return ChatResult(content=f"finding {n}")
            return route
        routes = [(f"CHILD{n}", held(n)) for n in range(3)] + [
            (PARENT, calls_then([batch(helper(0), helper(1), helper(2), background=True)],
                                final="launched"))]
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.ui.turn_id = "t1"
            h.ui.reset_turn_messages()
            h.agent.run_turn(PARENT)
            self.assertFalse(notices, "the batch call returned before any helper finished")
            out = self.tool_messages(h)[0]["content"]
            self.assertTrue(out.startswith("Started 3 helpers in the background; 2 run now and 1 waits "
                                           "for a free slot"), out)
            ids = [f["id"] for f in h.of("agent_started")]
            self.assertEqual(len(ids), 3)
            for agent_id in ids:
                self.assertIn(agent_id, out)
            self.assertIn("call wait_tasks with ids " + ", ".join(ids), out)
            self.assertEqual([f["state"] for f in h.of("agent_started")], ["running", "running", "queued"])
            wait_until(lambda: {"start0", "start1"} <= set(events), what="the first two to start")
            self.assertNotIn("start2", events, "the third waits while both slots are taken")
            release[0].set()
            wait_until(lambda: "start2" in events, what="the queued helper to start")
            self.assertGreater(events.index("start2"), events.index("end0"))
            release[1].set()
            release[2].set()
            wait_until(lambda: len(notices) == 3, timeout=20, what="all three to report")
            self.assertEqual(sorted(f["state"] for f in h.of("agent_ended")), ["finished"] * 3)


class TaskBatchReplayTests(HarnessCase):
    def ran(self):
        h = self.make(git=True, max_parallel_tasks=4)
        h.run(PARENT, [("CHILD1", says("finding one")), ("CHILD2", says("finding two")),
                       (PARENT, calls_then([batch(helper(1), helper(2))], final="done"))])
        return h

    def test_a_reload_draws_every_helper_as_it_ran(self):
        h = self.ran()
        items = h.backend._history()
        calls = [i["call_id"] for i in items if i.get("type") == "tool_call" and i.get("name") == "task"]
        self.assertEqual(calls, ["p", "p#1", "p#2"])
        child = next(i for i in items if i.get("type") == "tool_call" and i.get("call_id") == "p#2")
        self.assertEqual(child["args"]["description"], "area 2")
        self.assertEqual(child["args"]["prompt"], "CHILD2 map area 2")
        results = [i for i in items if i.get("type") == "tool_result" and i.get("name") == "task"]
        self.assertEqual([i["call_id"] for i in results], ["p#1", "p#2", "p"])
        self.assertIn("finding two", results[1]["output"])
        live = {f["call_id"] for f in h.of("agent_started")}
        self.assertEqual(live, {"p#1", "p#2"}, "the records name the cards a reload draws")

    def test_a_reopened_chat_and_a_rewind_keep_every_helper(self):
        h = self.ran()
        records = subagents.restore_records(h.agent.messages, "session")
        self.assertEqual([(r["call_id"], r["description"], r["state"]) for r in records],
                         [("p#1", "area 1", "finished"), ("p#2", "area 2", "finished")])
        self.assertEqual(len({r["id"] for r in records}), 2)
        before = {item["id"] for item in h.agent.subagents.snapshot()["items"]}
        h.agent.subagents.prune_to(h.agent.messages)
        self.assertEqual({item["id"] for item in h.agent.subagents.snapshot()["items"]}, before,
                         "a rewind that keeps the batch call keeps its helpers")
        h.agent.subagents.prune_to([m for m in h.agent.messages if m.get("role") != "assistant"])
        self.assertEqual(h.agent.subagents.snapshot()["items"], [])

    def test_a_refused_batch_restores_no_agents(self):
        messages = [
            {"role": "assistant", "content": "", "tool_calls": [{"id": "p", "type": "function", "function": {
                "name": "task", "arguments": json.dumps({"tasks": [helper(1), helper(2)]})}}]},
            {"role": "tool", "tool_call_id": "p", "content": "PERMISSION DENIED: blocked by deny rule: Task"}]
        self.assertEqual(subagents.restore_records(messages, "s"), [])


if __name__ == "__main__":
    unittest.main()
