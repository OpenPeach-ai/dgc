"""Editor protocol v14 foundation: declarations, shared allowlists and shapes, and a live headless
turn whose every frame still validates under the transitional v14 declarations."""
import ast
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import glyphs, headless
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend, HeadlessUI
from dgc.llm import ChatResult, ToolCall
from dgc.protocol import Emitter, PendingRequests

ROOT = Path(__file__).resolve().parents[1]
PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
       "/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")


def valid(event):
    return ep.event_error({"seq": 0, **event}) is None


def fixture_config(root: Path) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class DeclarationTests(unittest.TestCase):
    def test_version_constants_and_imports(self):
        self.assertEqual(ep.PROTOCOL_VERSION, 14)
        self.assertEqual(ep.MODEL_FAILURE_KINDS, (
            "connect", "dns", "tls", "proxy", "reset", "connect_timeout", "http", "rate_limited",
            "overloaded", "stream_cut", "stall", "loading", "auth", "model_not_found", "engine", "other"))
        self.assertEqual(ep.REASONING_SOURCES, ("raw", "summarized", "narration", "withheld", "unknown"))
        self.assertEqual(ep.REASONING_PROVIDERS, ("anthropic", "openai"))
        self.assertEqual(ep.IMAGE_UNAVAILABLE_REASONS,
                         ("invalid_ref", "not_found", "changed", "too_large", "unreadable", "busy"))
        tree = ast.parse((ROOT / "dgc" / "editor_protocol.py").read_text())
        imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import)
                    for alias in node.names}
        imported |= {node.module for node in ast.walk(tree)
                     if isinstance(node, ast.ImportFrom) and node.module != "__future__"}
        self.assertEqual(imported, {"json", "math", "pathlib"},
                         "the generator loads this module; model_errors imports from it, never the reverse")

    def test_v13_schema_files_are_untouched(self):
        pinned = "sha256 of editor-protocol-v13.schema.json at 65cd0251"
        digests = {hashlib.sha256((ROOT / folder / "editor-protocol-v13.schema.json").read_bytes()).hexdigest()
                   for folder in ("schemas", "dgc/schemas")}
        self.assertEqual(digests, {V13_SCHEMA_SHA256}, pinned)
        for folder in ("schemas", "dgc/schemas"):
            schema = json.loads((ROOT / folder / "editor-protocol-v14.schema.json").read_text())
            self.assertEqual(schema["$id"], "urn:vibedgc:editor-protocol:v14")

    def test_thinking_events(self):
        self.assertTrue(valid({"type": "thinking_delta", "text": "hm"}), "transitional: text alone")
        self.assertTrue(valid({"type": "thinking_delta", "text": "hm", "block": "t1:think1",
                               "source": "summarized", "provider": "anthropic", "agent": "sub-0123456789ab"}))
        self.assertFalse(valid({"type": "thinking_delta", "text": "hm", "source": "made-up"}))
        self.assertFalse(valid({"type": "thinking_delta", "text": "hm", "provider": "google"}))
        end = {"type": "thinking_end", "block": "t1:think1", "source": "raw", "placement": "collapsed"}
        self.assertTrue(valid(end))
        self.assertTrue(valid({**end, "placement": "inline", "seconds": 2.5, "truncated": True,
                               "provider": "openai", "agent": "sub-0123456789ab"}))
        for missing in ("block", "source", "placement"):
            self.assertFalse(valid({k: v for k, v in end.items() if k != missing}), missing)
        config = ep.EVENT_FIELDS["config"]
        self.assertEqual((config["thinking_inline"]["types"], config["thinking_inline_max_chars"]["types"]),
                         (["boolean"], ["integer"]))

    def test_image_events_and_command(self):
        item = {"ref": "img_" + "0" * 32, "name": "shot.png", "mime": "image/png", "width": 1,
                "height": 1, "bytes": 68, "source": "browser", "host": "example.com"}
        self.assertTrue(valid({"type": "tool_images", "call_id": "c1", "images": [PNG], "caption": "x"}))
        self.assertTrue(valid({"type": "tool_images", "call_id": None, "images": [""], "items": [item],
                               "omitted": 3}))
        self.assertFalse(valid({"type": "tool_images", "call_id": "c1", "images": [], "items": {}}))
        answer = {"type": "image", "request_id": "r1", "ref": item["ref"], "image": PNG}
        self.assertTrue(valid({**answer, "mime": "image/png", "width": 1, "height": 1, "path": "a.png"}))
        self.assertTrue(valid({**answer, "image": "", "reason": "too_large"}))
        self.assertFalse(valid({**answer, "reason": "gone"}))
        self.assertIsNone(ep.command_error({"type": "get_image", "request_id": "r1", "ref": item["ref"]}))
        self.assertIsNotNone(ep.command_error({"type": "get_image", "ref": item["ref"]}))

    def test_reconnecting_events(self):
        run = {"type": "model_retry", "retry_id": "t1:retry1", "state": "retrying", "kind": "connect",
               "layer": "request", "attempt": 1, "summary": "Connection refused"}
        self.assertTrue(valid(run))
        self.assertTrue(valid({**run, "state": "gave_up", "max_attempts": 3, "endpoint": "http://h:1/v1",
                               "turn_id": "t1", "model": "m", "api_mode": "chat", "detail": "d",
                               "hint": "h", "http_status": 503, "delay_ms": 500, "origin": "subagent",
                               "agent": "sub-0123456789ab", "engine": "codex"}))
        for kind in ep.MODEL_FAILURE_KINDS:
            self.assertTrue(valid({**run, "kind": kind}), kind)
        self.assertFalse(valid({**run, "kind": "timeout"}))
        self.assertFalse(valid({**run, "layer": "transport"}))
        self.assertFalse(valid({**run, "seq_n": 1}))
        self.assertTrue(valid({"type": "error", "message": "failed", "cause": {"kind": "http"}}))
        self.assertFalse(valid({"type": "error", "message": "failed", "cause": "http"}))

    def test_options_events_and_response(self):
        question = {"id": "q1", "header": "Storage", "question": "Where?", "multi_select": False,
                    "options": [{"label": "Local (Recommended)", "description": "On disk", "recommended": True},
                                {"label": "Cloud", "description": "Synced", "recommended": False}]}
        self.assertTrue(valid({"type": "options_request", "id": "r1", "question": "Where?",
                               "options": ["Local", "Cloud"]}), "transitional legacy shape")
        self.assertTrue(valid({"type": "options_request", "id": "r1", "call_id": "c1", "questions": [question]}))
        resolved = {"type": "options_resolved", "id": None, "call_id": None, "outcome": "answered",
                    "questions": [question], "answers": {"q1": {"selected": [0], "other": ""}}}
        self.assertTrue(valid(resolved))
        self.assertTrue(valid({**resolved, "id": "r1", "outcome": "dismissed"}))
        self.assertFalse(valid({**resolved, "outcome": "skipped"}))
        self.assertFalse(valid({k: v for k, v in resolved.items() if k != "id"}), "id is required, null on replay")
        for response in ({"id": "r1", "answers": {"q1": {"selected": [0], "other": ""}}},
                         {"id": "r1", "dismissed": True}, {"id": "r1", "choice": 1}):
            self.assertIsNone(ep.command_error({"type": "options_response", **response}), response)
        self.assertIsNone(ep.command_error({"type": "set_workspace_roots", "roots": [], "question_forms": True}))

    def test_agents_events_and_command(self):
        started = {"type": "agent_started", "id": "sub-0123456789ab", "parent_id": None, "call_id": "c1",
                   "description": "Map the parser", "depth": 1, "state": "running", "started_at": 1.5,
                   "isolated": True, "parallel": False}
        self.assertTrue(valid(started))
        self.assertTrue(valid({**started, "state": "queued", "agent_type": "explorer", "model": "m",
                               "turn_id": "t1", "call_id": None}))
        self.assertFalse(valid({**started, "state": "waiting"}))
        updated = {"type": "agent_updated", "id": "sub-0123456789ab", "state": "waiting",
                   "waiting_for": "permission", "activity": "Running a command", "tool_calls": 2, "tokens": 10}
        self.assertTrue(valid(updated))
        self.assertFalse(valid({**updated, "waiting_for": "input"}))
        ended = {"type": "agent_ended", "id": "sub-0123456789ab", "state": "finished", "duration_ms": 10,
                 "tool_calls": 2}
        self.assertTrue(valid(ended))
        self.assertTrue(valid({**ended, "state": "stopped", "tokens": 5, "message": "stopped"}))
        self.assertTrue(valid({"type": "agents", "items": [], "total": 0, "active": 0}))
        self.assertTrue(valid({"type": "agents", "items": [], "total": 3, "active": 1, "request_id": "r"}))
        self.assertIsNone(ep.command_error({"type": "list_agents"}))
        self.assertIsNone(ep.command_error({"type": "list_agents", "request_id": "r"}))
        self.assertIsNotNone(ep.command_error({"type": "list_agents", "agents": True}))
        self.assertNotIn("agents", ep.COMMAND_FIELDS["set_workspace_roots"], "no client opt-in in v14")


class HeadlessSharedTests(unittest.TestCase):
    def test_allowlists(self):
        self.assertTrue({"list_agents", "get_image"} <= headless._WAKE_NEUTRAL_COMMANDS)
        self.assertIn("list_agents", headless._OPTIONALLY_CORRELATED_COMMANDS)
        self.assertNotIn("get_image", headless._OPTIONALLY_CORRELATED_COMMANDS, "get_image always correlates")
        self.assertFalse({"list_agents", "get_image"} & set(headless._BUSY_MUTATIONS))

    def test_ready_advertises_the_v14_capabilities(self):
        with tempfile.TemporaryDirectory(prefix="dgc-v14-ready-") as directory:
            config = fixture_config(Path(directory))
            backend = Backend(config)
            try:
                events = []
                backend.em = types.SimpleNamespace(emit=lambda kind, **fields: events.append({"type": kind, **fields}))
                backend.start()
            finally:
                backend.agent.mcp.stop_all()
        ready = next(event for event in events if event["type"] == "ready")
        self.assertTrue(valid(ready), ep.event_error({"seq": 0, **ready}))
        self.assertEqual(ready["protocol_version"], 14)
        capabilities = ready["capabilities"]
        self.assertTrue(capabilities["agents"] and capabilities["image_views"] and capabilities["model_retry"])
        self.assertTrue(capabilities["question_forms"], "kept for one release")
        self.assertNotIn("anthropic_thinking_display", capabilities)


class SharedShapeTests(unittest.TestCase):
    def test_chat_result_and_glyphs(self):
        result = ChatResult()
        self.assertIsNone(result.interruption)
        self.assertEqual(result.reasoning, [])
        self.assertIsNot(ChatResult().reasoning, result.reasoning)
        for name in ("AGENT_RUN", "AGENT_WAIT", "AGENT_IDLE", "AGENT_QUEUED", "RECONNECT", "IMAGE"):
            self.assertIsInstance(getattr(glyphs, name), str)
            self.assertTrue(getattr(glyphs, name))
        self.assertEqual(glyphs._g("●", "*"), glyphs.AGENT_RUN)

    def test_agent_ui_declares_the_optional_hooks(self):
        import inspect
        from dgc.ui import AgentUI
        signatures = {name: inspect.signature(getattr(AgentUI, name)) for name in (
            "on_thinking", "on_thinking_end", "tool_images", "model_retry", "ask_questions", "options_resolved")}
        self.assertEqual(signatures["on_thinking"].parameters["block"].default, None)
        self.assertEqual(list(signatures["tool_images"].parameters),
                         ["self", "call_id", "images", "caption", "items", "omitted", "meta"])
        self.assertEqual(signatures["ask_questions"].parameters["call_id"].default, None)
        self.assertEqual(list(signatures["options_resolved"].parameters),
                         ["self", "call_id", "outcome", "questions", "answers"])

    def test_agent_state_and_subagent_link(self):
        with tempfile.TemporaryDirectory(prefix="dgc-v14-agent-") as directory:
            root = Path(directory)
            class UI:
                def __getattr__(self, name):
                    return lambda *args, **kwargs: None
            agent = Agent(fixture_config(root), UI())
            try:
                expected = {"_subagent_id": None, "_parent_agent": None, "_parent_call_id": None,
                            "_image_batch_open": False, "image_views": [], "_retry_runs": {},
                            "_last_model_cause": None, "_reasoning_seq": 0, "_turn_reasoning_pending": [],
                            "_decision_records": {}, "_end_turn_after_batch": ""}
                self.assertEqual({key: getattr(agent, key) for key in expected}, expected)
                self.assertTrue(hasattr(agent._retry_lock, "acquire"))

                # _handle_call's task branch hands its call id to _run_subagent ...
                agent.config.data["mode"] = "auto"
                seen = []
                with patch.object(agent, "_run_subagent", side_effect=lambda *args: seen.append(args) or "ok"):
                    agent._handle_call(ToolCall("task-7", "task", {"description": "d", "prompt": "p"}))
                self.assertEqual(seen, [("d", "p", "", "task-7")])

                # ... which passes it on, and the child links back to its parent and that call.
                linked = []
                def child_turn(child, prompt, **kwargs):
                    linked.append((child._parent_agent, child._parent_call_id, child.depth))
                    return True
                from dgc.agent import _SubUI
                with patch.object(Agent, "run_turn", child_turn), \
                        patch.object(agent.config, "clone_for_root", lambda root: agent.config):
                    agent._execute_prepared_subagent("d", "p", "", None, _SubUI(agent.ui, "d"), "task-7")
                self.assertEqual(linked, [(agent, "task-7", 1)])

                # _run_subagent reaches _execute_prepared_subagent with the same id.
                forwarded = []
                with patch("dgc.worktree.repo_root", return_value=None), \
                        patch.object(agent, "_execute_prepared_subagent",
                                     side_effect=lambda *args: forwarded.append(args) or ("", "done", "")):
                    agent._run_subagent("d", "p", "", "task-8")
                self.assertEqual(forwarded[0][-1], "task-8")
            finally:
                agent.mcp.stop_all()

    def test_parallel_batch_threads_each_call_id(self):
        source = (ROOT / "dgc" / "agent.py").read_text()
        self.assertIn("agent_name, workspace, sub_uis[i], calls[i].id)", source)


class LiveTurnFrameTests(unittest.TestCase):
    """A headless turn with thinking, a propose_options question and a screenshot: every frame and
    every replayed history item validates against the (transitional) v14 contract."""

    def test_live_and_replayed_frames_validate(self):
        with tempfile.TemporaryDirectory(prefix="dgc-v14-live-") as directory:
            config = fixture_config(Path(directory))
            stream = io.StringIO()
            emitter = Emitter(stream, validator=ep.event_error)
            pending = PendingRequests()
            ui = HeadlessUI(emitter, pending, approval_timeout_s=5)
            backend = object.__new__(Backend)
            backend.config, backend.em, backend.pending, backend.ui = config, emitter, pending, ui
            backend.agent = agent = Agent(config, ui)
            ui.cancelled = agent.cancelled
            try:
                calls = []
                def chat(messages, *, on_thinking=None, on_text=None, **kwargs):
                    calls.append(len(calls))
                    if len(calls) == 1:
                        on_thinking("Weighing the storage choice. ")
                        on_text("Let me ask first.")
                        return ChatResult(content="Let me ask first.", tool_calls=[
                            ToolCall("call_q", "propose_options",
                                     {"question": "Where should drafts live?", "options": ["Local", "Cloud"]}),
                            ToolCall("call_ls", "ls", {"path": "."})])
                    on_thinking("Local it is.")
                    on_text("Drafts will be saved locally.")
                    return ChatResult(content="Drafts will be saved locally.")
                agent.client.chat = chat
                agent.client.stall_listener = None

                done = threading.Event()
                def answer():
                    answered = set()
                    replies = {"options_request": {"choice": 1}, "permission_request": {"decision": "once"}}
                    while not done.wait(0.01):
                        for line in stream.getvalue().splitlines():
                            frame = json.loads(line)
                            if frame["type"] in replies and frame["id"] not in answered:
                                answered.add(frame["id"])
                                pending.resolve(frame["id"], replies[frame["type"]])
                responder = threading.Thread(target=answer, daemon=True)
                responder.start()
                shots = iter([[PNG]])
                with patch("dgc.agent.take_pending_images", side_effect=lambda owner: next(shots, [])):
                    ui.turn_id = "t1"
                    ui.reset_turn_messages()
                    agent.run_turn("Set up drafts")
                done.set()
                responder.join(5)
                frames = [json.loads(line) for line in stream.getvalue().splitlines()]
                history = backend._history()
            finally:
                agent.mcp.stop_all()
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        kinds = [frame["type"] for frame in frames]
        for expected in ("thinking_delta", "options_request", "tool_call", "tool_result", "tool_images",
                         "text_delta", "stream_end"):
            self.assertIn(expected, kinds)
        self.assertEqual(len(calls), 2, kinds)
        typed = [item for item in history if isinstance(item.get("type"), str)]
        self.assertTrue(typed)
        for item in typed:
            self.assertIsNone(ep.event_error({**item, "seq": 0}), item)


V13_SCHEMA_SHA256 = "47c74a8b535ade3bd2249840e11f499d521895795ab80f4781f0fe42ee704b85"


if __name__ == "__main__":
    unittest.main()
