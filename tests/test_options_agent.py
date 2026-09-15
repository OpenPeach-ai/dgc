"""propose_options through the agent, the editor backend and history replay (0.40, protocol v14).

No real model: an in-process OpenAI-compatible endpoint on 127.0.0.1 port 0 captures every request
body the real client sends, or the client's chat is scripted. Run with HOME=<tmp>.
"""
from __future__ import annotations

import copy
import io
import json
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import questions as Q
from dgc import sessions
from dgc.agent import Agent, _SUBAGENT_DECISION_LINE
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend, HeadlessUI, _MID_TURN_ITEMS
from dgc.llm import ChatResult, ToolCall
from dgc.protocol import Emitter, PendingRequests

import test_live_controls as fixtures

ASK = {"questions": [
    {"header": "Storage", "question": "Where should drafts be saved?",
     "options": [{"label": "Local (Recommended)", "description": "Saved on this machine"},
                 {"label": "Cloud", "description": "Synced to your account"}]}]}
ANSWER = {"answers": {"q1": {"selected": [0], "other": ""}}}


def fixture_config(root: Path, **settings) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False, notes=False)
    config.data.update(settings)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class StubUI:
    """Answers every question batch with a fixed decision; records what it was asked."""

    def __init__(self, decision):
        self.decision, self.asked, self.resolved, self.infos = decision, [], [], []

    def ask_questions(self, questions, call_id=None):
        self.asked.append((questions, call_id))
        return self.decision

    def options_resolved(self, call_id, outcome, questions, answers):
        self.resolved.append((call_id, outcome, answers))

    def info(self, message):
        self.infos.append(message)

    def __getattr__(self, name):
        return lambda *args, **kwargs: None


class Permissive:
    """A test fixture UI: every attribute is a no-op callable (not a -p run)."""

    def __getattr__(self, name):
        return lambda *args, **kwargs: None


def sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "choices": [
        {"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


def sse_text(text):
    return sse({"content": text}) + sse({}, "stop") + "data: [DONE]\n\n"


def sse_call(name, arguments, call_id="call_q"):
    return (sse({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                 "function": {"name": name, "arguments": json.dumps(arguments)}}]})
            + sse({}, "tool_calls") + "data: [DONE]\n\n")


class MockModel:
    def __init__(self, script):
        self.script, self.requests = script, []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, body, kind):
                data = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._send(json.dumps({"data": [{"id": "mock-model"}]}), "application/json")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                owner.requests.append(body)
                self._send(owner.script(body), "text/event-stream")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


class AgentTests(unittest.TestCase):
    def agent(self, ui, **settings):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-options-agent-")
        self.addCleanup(tmp.cleanup)
        agent = Agent(fixture_config(Path(tmp.name), **settings), ui)
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def names(self, agent):
        return {tool["function"]["name"] for tool in agent._tool_schemas()}

    def test_each_outcome_reaches_the_model_and_the_record(self):
        for decision, expected in (
                ({"outcome": "answered", "answers": ANSWER["answers"]},
                 'The user answered your question:\n- Where should drafts be saved? chose "Local" (your '
                 'recommendation)\nContinue with these decisions.'),
                ({"outcome": "dismissed"}, Q.DISMISSED_RESULT),
                ({"outcome": "cancelled"}, Q.CANCELLED_RESULT),
                ({"outcome": "unavailable"}, Q.UNAVAILABLE_RESULT),
                (None, Q.CANCELLED_RESULT),
                ({"outcome": "answered", "answers": {"q1": {"selected": [9], "other": ""}}}, Q.CANCELLED_RESULT)):
            with self.subTest(decision=decision):
                ui = StubUI(decision)
                agent = self.agent(ui)
                out = agent._handle_call(ToolCall("call_q", "propose_options", copy.deepcopy(ASK)))
                self.assertEqual(out, expected)
                questions, call_id = ui.asked[0]
                self.assertEqual(call_id, "call_q")
                self.assertTrue(questions[0]["options"][0]["recommended"])
                self.assertEqual(questions[0]["options"][0]["label"], "Local")
                record = agent._decision_records["call_q"]
                self.assertEqual(ui.resolved, [("call_q", record["outcome"], record["answers"])])
                self.assertEqual(agent._end_turn_after_batch, "dismissed" if record["outcome"] == "dismissed" else "")
        agent = self.agent(StubUI({"outcome": "answered"}))
        self.assertEqual(agent._handle_call(ToolCall("c", "propose_options", {"question": "x", "options": ["a"]})),
                         "error: " + Q.ERR_FEW)

    def test_offered_where_someone_can_answer(self):
        for mode in ("default", "acceptEdits", "plan"):
            self.assertIn("propose_options", self.names(self.agent(StubUI(None), mode=mode)), mode)
        self.assertIn("propose_options", self.names(self.agent(Permissive())),
                      "a __getattr__ fixture UI is not a -p run")
        child = self.agent(StubUI(None))
        child.depth = 1
        self.assertNotIn("propose_options", self.names(child))
        quiet = StubUI(None)
        quiet.non_interactive = True
        self.assertNotIn("propose_options", self.names(self.agent(quiet)))
        wake = self.agent(StubUI(None))
        wake._monitor_turn = True
        self.assertNotIn("propose_options", self.names(wake))

    def test_forced_calls_where_withheld(self):
        child = self.agent(StubUI({"outcome": "answered", "answers": ANSWER["answers"]}))
        child.depth = 1
        self.assertEqual(child._handle_call(ToolCall("c", "propose_options", copy.deepcopy(ASK))), Q.UNAVAILABLE_RESULT)
        self.assertEqual(child.ui.asked, [])
        wake = self.agent(StubUI({"outcome": "answered", "answers": ANSWER["answers"]}))
        wake._monitor_turn = True
        self.assertIn("started by a monitor event", wake._handle_call(ToolCall("c", "propose_options", copy.deepcopy(ASK))))
        from dgc.cli import _json_oneshot_ui
        json_ui = _json_oneshot_ui(fixture_config(Path(tempfile.gettempdir())))
        sink = io.StringIO()
        json_ui.em.fp = sink
        scripted = self.agent(json_ui)
        self.assertNotIn("propose_options", self.names(scripted))
        self.assertEqual(scripted._handle_call(ToolCall("c", "propose_options", copy.deepcopy(ASK))),
                         Q.NON_INTERACTIVE_RESULT, "`dgc -p` says why nobody answered")
        frames = [json.loads(line) for line in sink.getvalue().splitlines()]
        request = next(frame for frame in frames if frame["type"] == "options_request")
        self.assertEqual((request["id"], request["decision"], request["reason"], request["call_id"]),
                         (None, None, "non-interactive run", "c"))
        self.assertNotIn("options", request)
        self.assertEqual(next(f for f in frames if f["type"] == "options_resolved")["outcome"], "unavailable")

    def test_system_prompt_lines(self):
        top = self.agent(StubUI(None))
        self.assertNotIn(_SUBAGENT_DECISION_LINE, top.system_prompt())
        top.depth = 1
        self.assertIn(_SUBAGENT_DECISION_LINE, top.system_prompt())
        plan = self.agent(StubUI(None), mode="plan").system_prompt()
        self.assertIn("ask with propose_options", plan)
        self.assertIn("whether the plan is ready", plan)
        self.assertLess(plan.index("Do not present a plan before you understand the relevant code."),
                        plan.index("ask with propose_options"))
        self.assertNotIn("ask with propose_options", top.system_prompt())

    def test_dismissal_ends_the_turn_without_another_request(self):
        ui = StubUI({"outcome": "dismissed"})
        agent = self.agent(ui)
        requests = []

        def chat(messages, **kwargs):
            requests.append(copy.deepcopy(messages))
            return ChatResult(content="", tool_calls=[
                ToolCall("call_q", "propose_options", copy.deepcopy(ASK)), ToolCall("call_ls", "ls", {"path": "."})])
        with patch.object(agent.client, "chat", side_effect=chat):
            self.assertTrue(agent.run_turn("Set up drafts"))
        self.assertEqual(len(requests), 1, "no model request after the dismissed batch")
        tools = [m for m in agent.messages if m.get("role") == "tool"]
        self.assertEqual([m["tool_call_id"] for m in tools], ["call_q", "call_ls"], "the whole batch is saved")
        self.assertEqual(tools[0]["_dgc_decision"]["outcome"], "dismissed")
        self.assertNotIn("_dgc_decision", tools[1])
        self.assertFalse(agent.cancelled.is_set())

    def test_dismissal_stops_the_rest_of_the_batch(self):
        # acceptEdits: a write that depends on the unanswered decision would otherwise land, and a
        # second question would dock right after the user closed the first.
        ui = StubUI({"outcome": "dismissed"})
        agent = self.agent(ui, mode="acceptEdits")
        requests = []

        def chat(messages, **kwargs):
            requests.append(1)
            return ChatResult(content="", tool_calls=[
                ToolCall("c1", "propose_options", copy.deepcopy(ASK)),
                ToolCall("c2", "write_file", {"path": "decided.txt", "content": "Local\n"}),
                ToolCall("c3", "propose_options", copy.deepcopy(ASK))])
        with patch.object(agent.client, "chat", side_effect=chat):
            self.assertTrue(agent.run_turn("Set up drafts"))
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(ui.asked), 1, "the user is asked once")
        self.assertFalse((agent.config.project_root / "decided.txt").exists(), "the dependent write never ran")
        tools = [m for m in agent.messages if m.get("role") == "tool"]
        self.assertEqual([m["tool_call_id"] for m in tools], ["c1", "c2", "c3"], "every call still has a result")
        self.assertEqual([m["content"] for m in tools[1:]], [Q.NOT_RUN_AFTER_DISMISSAL] * 2)
        self.assertNotIn("_dgc_decision", tools[2])

    def test_dismissal_pauses_an_active_goal_and_starts_no_next_cycle(self):
        ui = StubUI({"outcome": "dismissed"})
        agent = self.agent(ui)
        agent.set_goal("set up drafts")
        requests = []

        def chat(messages, **kwargs):
            requests.append(1)
            return ChatResult(content="", tool_calls=[ToolCall(f"call_{len(requests)}", "propose_options", copy.deepcopy(ASK))])
        with patch.object(agent.client, "chat", side_effect=chat):
            agent.run_turn("Set up drafts")
        self.assertEqual(len(requests), 1)
        self.assertEqual(agent.goal_status, "paused")
        self.assertEqual(agent.goal_snapshot()["reason"], "You closed a question the goal needs answered")
        # a later goal cycle that asks nothing is not paused by the old dismissal
        agent._end_turn_after_batch = "dismissed"
        agent.set_goal("second goal", replace=True)
        cycles = []

        def step(text):
            cycles.append(text)
            agent._goal_progress.add("write_file", {"path": "f"}, str(len(cycles)))
            if len(cycles) == 2:
                agent._handle_call(ToolCall("r", "update_goal", {"status": "completed", "summary": "done",
                                                                  "evidence": ["checked"]}))
            return True
        agent._run_turn = step
        agent.run_turn("go")
        self.assertEqual(agent.goal_status, "completed")


class BackendDismissTests(unittest.TestCase):
    setUp = fixtures.LiveControlTests.setUp
    wait = fixtures.LiveControlTests.wait

    def test_dismissed_turn_completes_keeps_the_queue_and_monitors(self):
        requests = []

        def chat(messages, **kwargs):
            requests.append(copy.deepcopy(messages))
            if len(requests) == 1:
                return ChatResult(content="", tool_calls=[ToolCall("call_q", "propose_options", copy.deepcopy(ASK))])
            return ChatResult(content="Second prompt handled.")
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.backend.dispatch({"type": "prompt", "text": "Set up drafts", "request_id": "first"})
            request = self.wait("options_request")
            self.backend.dispatch({"type": "prompt", "text": "Use the defaults instead", "request_id": "second",
                                   "delivery": "queue"})
            self.wait("prompt_accepted", request_id="second")
            self.backend.dispatch({"type": "options_response", "id": request["id"], "dismissed": True})
            first_end = self.wait("turn_end", turn_id="t1")
            self.assertEqual(first_end["reason"], "completed")
            self.assertIsNone(first_end["final_message_id"])
            self.wait("turn_end", turn_id="t2")
        kinds = [e["type"] for e in self.events]
        self.assertNotIn("request_expired", kinds)
        self.assertEqual(len(requests), 2, "t1 made one request; the queued prompt ran as t2")
        self.assertIn("Use the defaults instead", str(requests[1]))
        self.assertIn(Q.DISMISSED_RESULT, str(requests[1]))
        order = [e["type"] for e in self.events if e["type"] in ("options_resolved", "tool_result")]
        self.assertEqual(order[:2], ["options_resolved", "tool_result"])
        self.assertEqual(sum(e["type"] == "options_resolved" for e in self.events), 1)
        self.assertFalse(self.agent.monitors.policy.paused)
        waiting = [e for e in self.events if e["type"] == "turn_activity" and e.get("label") == "Waiting for your answer"]
        self.assertTrue(waiting)
        history = self.backend._history()
        ends = [item for item in history if item.get("type") == "turn_end"]
        self.assertEqual(ends[0]["reason"], "completed", "a dismissed turn replays as completed")


class WireAndHistoryTests(unittest.TestCase):
    """Real client, real request bodies: the sidecar is saved, never sent, and replayed in live order."""

    def run_turn(self, script, *, text_protocol=False, answer=ANSWER):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-options-wire-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        with MockModel(script) as model:
            config = fixture_config(root, base_url=model.url, model="mock-model", api_mode="chat_completions",
                                    api_key="fixture-placeholder")
            stream = io.StringIO()
            emitter = Emitter(stream, validator=ep.event_error)
            pending = PendingRequests()
            ui = HeadlessUI(emitter, pending, approval_timeout_s=5)
            backend = object.__new__(Backend)
            backend.config, backend.em, backend.pending, backend.ui = config, emitter, pending, ui
            backend.agent = agent = Agent(config, ui)
            ui.cancelled = agent.cancelled
            self.addCleanup(agent.mcp.stop_all)
            if text_protocol:
                agent.client._mark_rejected("tools")
            agent.session_file = sessions.new_path(root)
            done = threading.Event()

            def responder():
                answered = set()
                while not done.wait(0.01):
                    for line in stream.getvalue().splitlines():
                        frame = json.loads(line)
                        if frame["type"] == "options_request" and frame["id"] not in answered:
                            answered.add(frame["id"])
                            backend.dispatch({"type": "options_response", "id": frame["id"], **answer})
            thread = threading.Thread(target=responder, daemon=True)
            thread.start()
            ui.turn_id = "t1"
            ui.reset_turn_messages()
            try:
                self.assertTrue(agent.run_turn("Set up drafts"))
            finally:
                done.set()
                thread.join(5)
            frames = [json.loads(line) for line in stream.getvalue().splitlines()]
            saved = Path(agent.session_file).read_text()
            history = backend._history()
            return model.requests, frames, saved, history, agent

    def test_native_sidecar_saved_never_sent_and_replayed_in_order(self):
        def script(body):
            last = body["messages"][-1]
            return sse_text("Saved locally.") if last.get("role") == "tool" else sse_call("propose_options", ASK)
        requests, frames, saved, history, agent = self.run_turn(script)
        self.assertEqual(len(requests), 2)
        self.assertNotIn("_dgc_decision", json.dumps(requests))
        self.assertIn('chose \\"Local\\" (your recommendation)', json.dumps(requests[1]))
        self.assertIn("_dgc_decision", saved)
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        kinds = [f["type"] for f in frames]
        self.assertLess(kinds.index("tool_call"), kinds.index("options_request"))
        self.assertLess(kinds.index("options_request"), kinds.index("options_resolved"))
        self.assertLess(kinds.index("options_resolved"), kinds.index("tool_result"))
        self.assertEqual(kinds.count("options_resolved"), 1)
        live = next(f for f in frames if f["type"] == "options_resolved")
        self.assertEqual((live["call_id"], live["outcome"]), ("call_q", "answered"))
        self.assertEqual(live["id"], next(f for f in frames if f["type"] == "options_request")["id"])
        typed = [item["type"] for item in history if isinstance(item.get("type"), str)]
        self.assertEqual([t for t in typed if t in ("tool_call", "options_resolved", "tool_result")],
                         ["tool_call", "options_resolved", "tool_result"])
        replayed = next(item for item in history if item.get("type") == "options_resolved")
        self.assertEqual({k: replayed[k] for k in ("id", "call_id", "outcome", "answers")},
                         {"id": None, "call_id": "call_q", "outcome": "answered", "answers": live["answers"]})
        self.assertEqual(replayed["questions"], live["questions"])
        for item in history:
            if isinstance(item.get("type"), str):
                self.assertIsNone(ep.event_error({**item, "seq": 0}), item)

    def test_text_protocol_sidecar_on_tool_results_message(self):
        fence = "```tool_call\n" + json.dumps({"name": "propose_options", "arguments": ASK}) + "\n```"

        def script(body):
            last = str(body["messages"][-1].get("content"))
            self.assertNotIn("tools", body)
            return sse_text("Saved locally.") if last.startswith("<tool_results>") else sse_text("Let me ask.\n" + fence)
        requests, frames, saved, history, agent = self.run_turn(
            script, text_protocol=True, answer={"answers": {"q1": {"selected": [], "other": "Both"}}})
        self.assertEqual(len(requests), 2)
        self.assertNotIn("_dgc_decision", json.dumps(requests))
        results = next(m for m in agent.messages if str(m.get("content")).startswith("<tool_results>"))
        self.assertIsInstance(results["_dgc_decision"], list)
        self.assertIsNone(results["_dgc_decision"][0]["call_id"])
        self.assertIn("_dgc_decision", saved)
        replayed = [item for item in history if item.get("type") == "options_resolved"]
        self.assertEqual(len(replayed), 1)
        self.assertEqual((replayed[0]["call_id"], replayed[0]["outcome"]), (None, "answered"))
        self.assertEqual(replayed[0]["answers"]["q1"]["other"], "Both")
        for item in history:
            if isinstance(item.get("type"), str):
                self.assertIsNone(ep.event_error({**item, "seq": 0}), item)


class HistoryShapeTests(unittest.TestCase):
    def history(self, messages):
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(messages=messages)
        return backend._history()

    def call(self, call_id="call_q", args=None):
        return {"role": "assistant", "content": "", "tool_calls": [{"id": call_id, "type": "function", "function": {
            "name": "propose_options", "arguments": json.dumps(args or ASK)}}]}

    def test_a_039_session_replays_unchanged(self):
        items = self.history([{"role": "user", "content": "Set up drafts"}, self.call(),
                              {"role": "tool", "tool_call_id": "call_q", "content": "The user chose: 'Local'."},
                              {"role": "assistant", "content": "Saved locally."}])
        self.assertEqual([i["type"] for i in items],
                         ["turn_start", "tool_call", "tool_result", "text_delta", "stream_end", "turn_end"])

    def test_interruption_text_replays_as_cancelled(self):
        items = self.history([{"role": "user", "content": "Set up drafts"}, self.call(),
                              {"role": "tool", "tool_call_id": "call_q",
                               "content": "error: tool result unavailable after session interruption"}])
        resolved = [i for i in items if i["type"] == "options_resolved"]
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0]["outcome"], "cancelled")
        self.assertEqual(resolved[0]["questions"][0]["header"], "Storage")
        self.assertIsNone(ep.event_error({**resolved[0], "seq": 0}))
        self.assertEqual(items[-1]["reason"], "cancelled")

    def interrupted(self, call_id="call_0"):
        return {"role": "tool", "tool_call_id": call_id,
                "content": "error: tool result unavailable after session interruption"}

    def read_call(self, call_id="call_0"):
        return {"role": "assistant", "content": "", "tool_calls": [{"id": call_id, "type": "function", "function": {
            "name": "read_file", "arguments": json.dumps({"path": "a.txt"})}}]}

    def test_interrupted_call_ids_reused_across_turns_resolve_to_their_own_call(self):
        # call_0 style ids repeat per turn: an interrupted read_file must not replay as a question
        items = self.history([{"role": "user", "content": "Read it"}, self.read_call(), self.interrupted(),
                              {"role": "user", "content": "Now ask"}, self.call("call_0"),
                              {"role": "tool", "tool_call_id": "call_0", "content": "The user answered your question: ..."}])
        self.assertEqual([i["type"] for i in items if i["type"] in ("tool_call", "tool_result", "options_resolved")],
                         ["tool_call", "tool_call", "tool_result"])
        # The interrupted read is a stopped card; its model-only repair text is not a result.
        self.assertEqual(next(i["reason"] for i in items if i["type"] == "turn_end"),
                         "cancelled")
        self.assertEqual([i["name"] for i in items if i["type"] == "tool_result"],
                         ["propose_options"])
        # ...and an interrupted question followed by a read_file with the same id still replays as cancelled
        items = self.history([{"role": "user", "content": "Ask"}, self.call("call_0"), self.interrupted(),
                              {"role": "user", "content": "Read it"}, self.read_call(),
                              {"role": "tool", "tool_call_id": "call_0", "content": "hello"}])
        kinds = [(i["type"], i.get("name")) for i in items if i["type"] in ("tool_call", "tool_result", "options_resolved")]
        # (the repair text is the model's; the replayed question is a stopped step, as the reconnect drew it)
        self.assertEqual(kinds, [("tool_call", "propose_options"), ("options_resolved", None),
                                 ("tool_call", "read_file"), ("tool_result", "read_file")])
        self.assertEqual(next(i for i in items if i["type"] == "options_resolved")["outcome"], "cancelled")

    def test_dismissed_turn_replays_as_completed(self):
        questions = Q.normalize_questions(ASK)
        record = Q.decision_record("call_q", questions, {"outcome": "dismissed"})
        items = self.history([{"role": "user", "content": "Set up drafts"}, self.call(),
                              {"role": "tool", "tool_call_id": "call_q", "content": Q.DISMISSED_RESULT,
                               "_dgc_decision": record}])
        self.assertEqual(items[-1], {"type": "turn_end", "turn_id": "h1", "reason": "completed",
                                     "token_estimate": 0, "final_message_id": None})
        undismissed = self.history([{"role": "user", "content": "Set up drafts"}, self.call(),
                                    {"role": "tool", "tool_call_id": "call_q", "content": Q.CANCELLED_RESULT,
                                     "_dgc_decision": {**record, "outcome": "cancelled"}}])
        self.assertEqual(undismissed[-1]["reason"], "cancelled")

    def test_a_trimmed_page_never_starts_on_options_resolved(self):
        self.assertIn("options_resolved", _MID_TURN_ITEMS)
        questions = Q.normalize_questions(ASK)
        big = [{**questions[0], "question": "x" * 1_000_500}]
        record = {"call_id": "call_q", "outcome": "answered", "questions": big,
                  "answers": {"q1": {"selected": [0], "other": ""}}}
        messages = [{"role": "user", "content": "Earlier " + "y" * 40000}, {"role": "assistant", "content": "ok"},
                    {"role": "user", "content": "Set up drafts"}, self.call(),
                    {"role": "tool", "tool_call_id": "call_q", "content": "answered", "_dgc_decision": record}]
        items = self.history(messages)
        typed = [i for i in items if isinstance(i.get("type"), str)]
        self.assertTrue(all(i["type"] != "options_resolved" for i in typed[:1]))
        self.assertEqual(items[0].get("role"), "notice")


if __name__ == "__main__":
    unittest.main()
