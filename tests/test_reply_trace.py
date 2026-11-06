"""Trace for ChatDGC and a Pip's chat: what a reply did, step by step, measured as it happens and kept with the reply.
A number nobody measured is never written; a reply with a step that never ended has no Trace. Also: the app's notes in a
chat's history never come back in a reply (a live answer ended with "[You edited the canvas The Last Lamp (cv_...) here.]")."""
import json
import unittest
from types import SimpleNamespace

from dgc import pip_chat, pips, reply_trace
from dgc.chatdgc.engine import _EchoedNotes, _without_notes
from dgc.chatdgc.prompt import system_prompt
from dgc.chatdgc.service import fit
from tests import test_chatdgc_plugins as chat_fixtures
from tests import test_pips_local as pip_fixtures


def clock_at(*marks):
    values = iter(marks)
    return lambda: next(values)


class Recorder(unittest.TestCase):
    def test_a_round_a_tool_and_a_round_in_whole_milliseconds_from_the_first_step(self):
        trace = reply_trace.ReplyTrace(clock=clock_at(1000.0, 1900.4, 1900.4, 1909.6, 1910.0, 2703.0))
        trace.model_start()
        trace.model_end(13537)
        step = trace.tool_start("c1", "read_file", "README.md")
        trace.tool_end(step)
        trace.model_start()
        trace.model_end(13596)
        self.assertEqual(trace.saved(), {"v": 1, "ms": 1703, "steps": [
            {"kind": "model", "label": "model.response", "tokens": 13537, "start": 0, "end": 900},
            {"kind": "tool", "label": "read_file", "detail": "README.md", "start": 900, "end": 910},
            {"kind": "model", "label": "model.response", "tokens": 13596, "start": 910, "end": 1703}]})

    def test_a_tool_starting_ends_the_round_with_no_tokens_rather_than_a_guess(self):
        trace = reply_trace.ReplyTrace(clock=clock_at(0.0, 50.0, 50.0, 60.0))
        trace.model_start()
        step = trace.tool_start("c1", "grep", "todo")
        trace.tool_end(step, hits=2)
        [model, tool] = trace.saved()["steps"]
        self.assertNotIn("tokens", model)
        self.assertEqual((model["end"], tool["hits"]), (50, 2))

    def test_a_step_that_never_ended_means_no_trace(self):
        running = reply_trace.ReplyTrace(clock=clock_at(0.0, 5.0))
        running.model_start()
        self.assertIsNone(running.saved(), "a model round with no end")
        tool = reply_trace.ReplyTrace(clock=clock_at(0.0, 5.0))
        tool.tool_start("c1", "bash")
        self.assertIsNone(tool.saved(), "a tool with no result")
        self.assertIsNone(reply_trace.ReplyTrace().saved(), "nothing measured")

    def test_a_trace_that_outgrew_its_bound_is_none_not_a_part(self):
        marks = iter(range(10_000))
        trace = reply_trace.ReplyTrace(clock=lambda: float(next(marks)))
        for n in range(reply_trace.MAX_STEPS + 1):
            trace.tool_end(trace.tool_start(f"c{n}", "bash"))
        self.assertIsNone(trace.saved())

    def test_hits_come_from_the_search_s_own_answer(self):
        self.assertEqual(reply_trace.hits_in("grep", "a.py:1: x\nb.py:2: y\n"), 2)
        self.assertEqual(reply_trace.hits_in("grep", "no matches"), 0)
        self.assertIsNone(reply_trace.hits_in("grep", "error: grep search cancelled"))
        self.assertEqual(reply_trace.hits_in("web_search", "Untrusted:\n[1] One\nhttps://a\n[2] Two\nhttps://b"), 2)
        self.assertEqual(reply_trace.hits_in("web_search", 'Web results for "x":\n\n1. One\n   https://a\n   A snippet\n2. Two\n   https://b'), 2)
        self.assertEqual(reply_trace.hits_in("web_search", 'No web results for "x".'), 0)
        self.assertIsNone(reply_trace.hits_in("read_file", "a\nb"))

    def test_validated_refuses_what_the_module_would_not_write(self):
        good = {"v": 1, "ms": 10, "steps": [{"kind": "tool", "label": "x", "start": 0, "end": 10}]}
        self.assertEqual(reply_trace.validated(good), good)
        for bad in (None, [], {"v": 2, "ms": 1, "steps": good["steps"]}, {"v": 1, "ms": 0, "steps": good["steps"]},
                    {"v": 1, "ms": 10, "steps": []},
                    {"v": 1, "ms": 5, "steps": good["steps"]},
                    {"v": 1, "ms": 10, "steps": [{**good["steps"][0], "kind": "other"}]},
                    {"v": 1, "ms": 10, "steps": [{**good["steps"][0], "tokens": -1}]},
                    {"v": 1, "ms": 10, "steps": [{**good["steps"][0], "error": "yes"}]},
                    {"v": 1, "ms": 10, "steps": [{**good["steps"][0], "start": "0"}]}):
            with self.subTest(bad=bad):
                self.assertIsNone(reply_trace.validated(bad))

    def test_a_carried_on_reply_joins_without_the_user_s_wait(self):
        before = {"v": 1, "ms": 100, "steps": [{"kind": "model", "label": "m", "start": 0, "end": 100}]}
        after = {"v": 1, "ms": 40, "steps": [{"kind": "model", "label": "m", "start": 0, "end": 40}]}
        joined = reply_trace.joined(before, after)
        self.assertEqual(joined["ms"], 140)
        self.assertEqual((joined["steps"][1]["start"], joined["steps"][1]["end"]), (100, 140))
        self.assertIsNone(reply_trace.joined(None, after), "part of a reply is not what it did")
        self.assertIsNone(reply_trace.joined(before, None))


class ChatReply(chat_fixtures.PluginChat):
    def steps(self, reply):
        return [(s["kind"], s["label"]) for s in reply["trace"]["steps"]]

    def test_model_rounds_and_a_plugin_read_with_their_own_tokens(self):
        chat, reply = self.say("What's on Friday?",
                               {"calls": [("call_plugin", {"plugin": "gcal", "tool": "list_events", "arguments": {"day": "Fri"}})]},
                               {"parts": ["Lunch at one."]})
        self.assertEqual(self.steps(reply), [("model", "model.lookup"), ("model", "model.response"),
                                             ("tool", "list_events"), ("model", "model.response")])
        lookup, first, plugin, last = reply["trace"]["steps"]
        self.assertNotIn("tokens", lookup, "that call reported none, so it says none")
        self.assertEqual((first["tokens"], last["tokens"]), (15, 15))
        self.assertNotIn("tokens", plugin)
        self.assertEqual(reply_trace.validated(reply["trace"]), reply["trace"])
        self.assertEqual(self.store.get(chat["id"])["messages"][-1]["trace"], reply["trace"], "saved, so a reload has it")

    def test_a_card_says_so_and_sending_it_is_a_step_of_the_same_reply(self):
        chat, reply = self.say("Put lunch on Friday in my calendar.",
                               {"calls": [("call_plugin", {"plugin": "gcal", "tool": "create_event",
                                                           "arguments": {"title": "Lunch", "when": "Fri 13:00"}})]},
                               {"parts": ["Send it and I'll confirm."]})
        offered = next(s for s in reply["trace"]["steps"] if s["label"] == "create_event")
        self.assertEqual(offered["detail"], "Google Calendar · Card")
        length = reply["trace"]["ms"]
        card = reply["actions"][0]
        self.world["answers"]["create_event"] = json.dumps({"id": "evt_9"})
        self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.world["script"].append({"parts": ["Added."]})
        carried = self.engine.continue_action(chat["id"], reply["id"], card["id"])
        labels = [s["label"] for s in carried["trace"]["steps"]]
        self.assertEqual(labels[-2:], ["create_event", "model.response"])
        sent = carried["trace"]["steps"][-2]
        self.assertEqual((sent["detail"], sent["start"]), ("Google Calendar · Sent", length),
                         "the wait for the click isn't the reply's")
        self.assertGreaterEqual(carried["trace"]["ms"], length)

    def test_a_card_that_failed_is_marked_failed(self):
        chat, reply = self.say("Put lunch on Friday in my calendar.",
                               {"calls": [("call_plugin", {"plugin": "gcal", "tool": "create_event",
                                                           "arguments": {"title": "Lunch"}})]}, {"parts": ["Send it."]})
        self.world["answers"]["create_event"] = json.dumps({"isError": True, "content": "read-only"})
        self.engine.act(chat["id"], reply["id"], reply["actions"][0]["id"], "run")
        kept = self.store.get(chat["id"])["messages"][-1]
        self.assertTrue(kept["trace"]["steps"][-1].get("error"))

    def test_a_plugin_s_error_answer_and_a_refused_call_are_failures(self):
        self.world["answers"]["list_events"] = json.dumps({"isError": True, "content": "no calendar"})
        _, reply = self.say("What's on Friday?",
                            {"calls": [("call_plugin", {"plugin": "gcal", "tool": "list_events", "arguments": {}})]},
                            {"parts": ["It didn't answer."]})
        step = next(s for s in reply["trace"]["steps"] if s["label"] == "list_events")
        self.assertTrue(step.get("error"))

    def test_asking_what_a_tool_takes_is_not_running_it(self):
        _, reply = self.say("What can it do?",
                            {"calls": [("plugin_tools", {"plugin": "gcal", "tool": "list_events"})]}, {"parts": ["It lists."]})
        step = next(s for s in reply["trace"]["steps"] if s["kind"] == "tool")
        self.assertEqual((step["label"], step["detail"]), ("plugin_tools", "Google Calendar"))

    def test_a_search_counts_its_hits(self):
        self.engine._searcher = lambda q: [{"url": "https://a.example", "title": "A"}, {"url": "https://b.example", "title": "B"}]
        _, reply = self.say("Latest?", {"calls": [("web_search", {"query": "kings of france"})]}, {"parts": ["Answer."]})
        step = next(s for s in reply["trace"]["steps"] if s["label"] == "web_search")
        self.assertEqual((step["detail"], step["hits"]), ("kings of france", 2))

    def test_a_stopped_or_failed_reply_has_no_trace(self):
        real = self.engine.client

        class Stops:
            model, context_size = "chat-model", 0
            def prepare_model(self, **_): pass
            def model_context_limit(self): return 32768
            def chat(self, messages, tools=None, on_text=None, **_):
                if tools is not None and not any(t["function"]["name"] == "search_first" for t in tools):
                    on_text("Half a")
                    raise RuntimeError("the socket went")
                return SimpleNamespace(content="", tool_calls=[], finish_reason="stop", thinking="", usage={})
        self.engine.client = lambda model=None: Stops()
        chat = self.engine.open()
        reply = self.engine.send(chat["id"], "Hello", search="off")
        self.engine.client = real
        self.assertEqual(reply["finish"], "error")
        self.assertNotIn("trace", reply)

    def test_an_old_reply_with_no_trace_has_none_when_it_carries_on(self):
        chat, reply = self.say("Put lunch on Friday in my calendar.",
                               {"calls": [("call_plugin", {"plugin": "gcal", "tool": "create_event", "arguments": {"title": "L"}})]},
                               {"parts": ["Send it."]})
        kept = self.store.get(chat["id"])
        kept["messages"][-1].pop("trace")
        self.store.save(kept)
        self.engine._cache = {} if hasattr(self.engine, "_cache") else None
        self.engine.act(chat["id"], reply["id"], reply["actions"][0]["id"], "run")
        self.world["script"].append({"parts": ["Added."]})
        carried = self.engine.continue_action(chat["id"], reply["id"], reply["actions"][0]["id"])
        self.assertNotIn("trace", carried)

    def test_the_model_never_reads_a_trace(self):
        chat, _ = self.say("Hello", {"parts": ["Hi."]})
        self.say("Again", {"parts": ["Hi again."]}, chat=chat)
        told = json.dumps(self.world["read"][-1]["messages"])
        self.assertNotIn('"steps"', told)
        self.assertNotIn("model.response", told)

    def test_a_trace_is_the_first_thing_a_full_frame_gives_up(self):
        message = {"id": "m", "role": "assistant", "text": "x" * 500, "trace": {"steps": ["y" * 500]}}
        cut = fit(message, budget=600)
        self.assertNotIn("trace", cut)
        self.assertEqual(cut["text"], "x" * 500)


class NotesStayOut(chat_fixtures.PluginChat):
    NOTE = "[You edited the canvas The Last Lamp (cv_0123456789abcdef) here.]"

    def test_the_note_reaches_the_model_in_its_own_reply_and_the_prompt_says_never_to_write_one(self):
        chat, reply = self.say("Hello", {"parts": ["Hi."]})
        kept = self.store.get(chat["id"])
        kept["messages"][-1]["canvases"] = [{"op": "edited", "title": "The Last Lamp", "id": "cv_0123456789abcdef"}]
        self.store.save(kept)
        self.say("Again", {"parts": ["Hi again."]}, chat=chat)
        earlier = [m["content"] for m in self.world["read"][-1]["messages"] if m["role"] == "assistant"]
        self.assertIn(self.NOTE, earlier[0], "how it reaches the model: appended to its own earlier reply")
        self.assertIn("you never write one", " ".join(system_prompt().split()))

    def test_a_note_at_the_end_of_a_reply_never_shows_however_it_streams(self):
        for size in (1, 2, 5, 13, 1000):
            with self.subTest(size=size):
                words = "The story is ready.\n\n" + self.NOTE
                parts = [words[i:i + size] for i in range(0, len(words), size)]
                shown = []
                _, reply = self.say("Change the ending", {"parts": parts}, on_text=shown.append)
                self.assertEqual(reply["text"], "The story is ready.")
                self.assertEqual("".join(shown).rstrip(), "The story is ready.")

    def test_the_real_notes_are_all_caught(self):
        for note in (self.NOTE, "[You made a card for create_event in Google Calendar in this reply; the user hasn't sent it.]",
                     "[You made notes.md here; the user has since deleted it.]",
                     "[You queried the chat's data here: select 1]",
                     "[You showed an interactive widget here, Timer; the user has deleted it.]",
                     "[You asked the user, as a card with choices: Which? Options: a; b; or their own answer.]",
                     "[The user chose not to send create_event in Google Calendar.]",
                     "[The user edited the draft in this reply themselves: the words above are theirs now. Work from their version, keeping what they changed.]",
                     '[Shown above this reply: pictures from a web image search for "lamps".]'):
            with self.subTest(note=note):
                self.assertEqual(_without_notes("Done.\n\n" + note), "Done.")
                self.assertEqual(_without_notes("Before.\n\n" + note + "\n\nAfter."), "Before.\n\nAfter.")

    def test_what_only_looks_like_one_is_left_as_it_was(self):
        for words in ("[1] A source\n[2] Another", "[You can do this]", "See [You made it] above.",
                      "[You made a good point, and here is why", "A\n\n\nB\n", "  indented\n\n- list\n",
                      "```\n[You made x here; the user has since deleted it.] in code\n```"):
            with self.subTest(words=words):
                self.assertEqual(_without_notes(words), words)

    def test_words_with_no_note_come_through_exactly_however_they_stream(self):
        import random
        pieces = ["Hello", " ", "\n", "\n\n", "  ", "\t", "[", "]", "[You", "[You ", "[You can", "[The user", "[Shown", "- a", "```",
                  "\r\n", "[1] x", "é", "[You made", " it"]
        rng = random.Random(51)
        for _ in range(400):
            words = "".join(rng.choice(pieces) for _ in range(rng.randint(0, 14)))
            filtered, out, at = _EchoedNotes(), [], 0
            while at < len(words):
                size = rng.randint(1, 6)
                out.append(filtered.feed(words[at:at + size]))
                at += size
            out.append(filtered.flush())
            self.assertEqual("".join(out), words)
            self.assertEqual(_without_notes(words), words)

    def test_it_holds_only_what_might_be_a_note(self):
        filtered = _EchoedNotes()
        self.assertEqual(filtered.feed("Hello "), "Hello ")
        self.assertEqual(filtered.feed("there\n"), "there\n", "a line's end goes out with it")
        self.assertEqual(filtered.feed("\n"), "", "a blank line could be before a note")
        self.assertEqual(filtered.feed("[You"), "", "this could still be one")
        self.assertEqual(filtered.feed(" can do it"), "", "and still could")
        self.assertEqual(filtered.feed("\nNext"), "\n[You can do it\nNext")
        self.assertEqual(filtered.flush(), "")


class PipRun(unittest.TestCase):
    setUp = pip_fixtures.LocalPipsTests.setUp

    def finished(self, steps=None):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        run = pip_chat.send(self.store, pip["id"], "Plan my week", "first", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        result = {"text": "Done.", "usage": {"input_tokens": 12, "output_tokens": 3, "requests": 1,
                                             "cached_input_tokens": 0, "reasoning_tokens": 0}}
        if steps is not None:
            result[pips.RUN_TRACE_KEY] = steps
        self.store.finish(run["id"], result=result)
        return pip, run

    STEPS = {"v": 1, "ms": 2000, "steps": [{"kind": "model", "label": "model.response", "tokens": 15, "start": 0, "end": 2000}]}

    def test_a_finished_run_keeps_its_steps_beside_its_result(self):
        pip, run = self.finished(self.STEPS)
        self.assertEqual(self.store.run(run["id"])["status"], "succeeded")
        self.assertNotIn(pips.RUN_TRACE_KEY, json.loads(self.registry.db.execute(
            "SELECT result FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0]))
        [one] = pip_chat.reply_stats(self.store, pip["id"], [run["id"]])["stats"]
        self.assertIs(one["has_trace"], True)
        self.assertEqual(one["trace"], self.STEPS)

    def test_a_page_of_replies_says_which_have_one_and_does_not_carry_them(self):
        pip, run = self.finished(self.STEPS)
        other = pip_chat.send(self.store, pip["id"], "And next week", "second", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(other["id"], result={"text": "Done too."})
        stats = {s["run_id"]: s for s in pip_chat.reply_stats(self.store, pip["id"], [run["id"], other["id"]])["stats"]}
        self.assertIs(stats[run["id"]]["has_trace"], True)
        self.assertNotIn("trace", stats[run["id"]])
        self.assertNotIn("has_trace", stats[other["id"]], "a reply with no steps recorded has no Trace")

    def test_an_old_registry_with_no_table_has_no_trace_and_no_error(self):
        pip, run = self.finished()
        [one] = pip_chat.reply_stats(self.store, pip["id"], [run["id"]])["stats"]
        self.assertNotIn("has_trace", one)

    def test_a_broken_trace_is_dropped_and_never_costs_the_run(self):
        pip, run = self.finished({"v": 9})
        self.assertEqual(self.store.run(run["id"])["status"], "succeeded")
        [one] = pip_chat.reply_stats(self.store, pip["id"], [run["id"]])["stats"]
        self.assertNotIn("has_trace", one)

    def test_deleting_a_pip_takes_its_traces(self):
        from dgc.pip_purge import _selected_rows
        pip, run = self.finished(self.STEPS)
        chosen = _selected_rows(self.registry.db, pip["id"], [run["id"]])
        self.assertIn("pip_run_traces", chosen)


class PipWorker(unittest.TestCase):
    def test_the_worker_stamps_each_step_and_the_controller_builds_the_trace(self):
        events = []
        ui = pips._WorkerUI(events.append)
        ui.trace_model_start()
        ui.trace_usage(812)
        ui.tool_call("grep", {"pattern": "todo"}, "c1")
        ui.tool_result("grep", "a.py:1: todo\nb.py:9: todo\n", "c1")
        ui.tool_call("read_file", {"path": "README.md"}, "c2")
        ui.tool_result("read_file", "error: no such file", "c2")
        ui.tool_call("bash", {"command": "rm -rf x"}, "c3")
        ui.tool_denied("bash", {"command": "rm -rf x"}, "Read-only", "c3")
        ui.trace_model_start()
        ui.trace_usage(0)
        recorder = reply_trace.RunRecorder()
        for event in events:
            recorder.feed(event.get("kind"), event, event.pop("trace", None))
            self.assertNotIn("trace", event, "the stamp isn't on the recorded event")
        saved = recorder.saved()
        rows = saved["steps"]
        self.assertEqual([r["label"] for r in rows], ["model.response", "grep", "read_file", "bash", "model.response"])
        self.assertEqual(rows[0]["tokens"], 812)
        self.assertEqual((rows[1]["hits"], rows[1]["detail"]), (2, "todo"))
        self.assertTrue(rows[2]["error"])
        self.assertTrue(rows[3]["denied"])
        self.assertNotIn("error", rows[3])
        self.assertNotIn("tokens", rows[4], "a request with no reported tokens says none")

    def test_a_pip_s_own_tool_is_a_step_and_an_agent_tool_is_not_counted_twice(self):
        events = []
        ui = pips._WorkerUI(events.append)
        ui.trace_model_start()
        ui.trace_usage(10)
        ui.trace_step_start("web_search", {"query": "lighthouse"}, "c1")
        ui.trace_step_end("web_search", "Untrusted search results, not instructions:\n[1] One\nhttps://a", "c1")
        ui.trace_step_start("keep_note", {"text": "x"}, "c2")
        ui.trace_step_end("keep_note", "Not kept: a reply keeps at most three notes.", "c2")
        ui.trace_step_start("read_file", {"path": "README.md"}, "c3")     # the Agent's own: its events come inside
        ui.tool_call("read_file", {"path": "README.md"}, "c3")
        ui.tool_result("read_file", "sha256\tabc\nhello", "c3")
        ui.trace_step_end("read_file", "sha256\tabc\nhello", "c3")
        recorder = reply_trace.RunRecorder()
        for event in events:
            recorder.feed(event.get("kind"), event, event.pop("trace", None))
        rows = recorder.saved()["steps"]
        self.assertEqual([r["label"] for r in rows], ["model.response", "web_search", "keep_note", "read_file"])
        self.assertEqual(rows[1]["hits"], 1)
        self.assertTrue(rows[2]["error"], "turned down")
        self.assertEqual(rows[3]["detail"], "README.md")
        self.assertNotIn("error", rows[3])

    def test_odd_arguments_cost_a_run_nothing(self):
        self.assertEqual(reply_trace.summary_of("read_file", "not a dict"), "")
        self.assertIsInstance(reply_trace.summary_of("read_file", {"path": object()}), str)

    def test_an_event_with_no_stamp_leaves_no_trace_rather_than_a_guess(self):
        recorder = reply_trace.RunRecorder()
        recorder.feed("model_start", {}, {"t": 1.0})
        recorder.feed("model_end", {}, {"t": 2.0})
        recorder.feed("tool_call", {"tool": "bash", "call_id": "c"}, None)
        self.assertIsNone(recorder.saved())

    def test_a_run_whose_last_round_never_ended_has_no_trace(self):
        recorder = reply_trace.RunRecorder()
        recorder.feed("model_start", {}, {"t": 1.0})
        self.assertIsNone(recorder.saved())

    def test_events_that_measure_nothing_change_nothing(self):
        recorder = reply_trace.RunRecorder()
        recorder.feed("progress", {"kind": "progress"}, None)
        recorder.feed("text_delta", {"kind": "text_delta"}, None)
        recorder.feed("model_start", {}, {"t": 1.0})
        recorder.feed("model_end", {}, {"t": 2500.0, "tokens": 9})
        self.assertEqual(recorder.saved()["ms"], 2499)

    def test_a_helper_s_model_rounds_stay_on_its_own_page(self):
        from dgc.agent import _SubUI
        self.assertTrue(callable(_SubUI.__dict__.get("trace_model_start")))
        self.assertTrue(callable(_SubUI.__dict__.get("trace_usage")))


if __name__ == "__main__":
    unittest.main()
