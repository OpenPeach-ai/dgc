"""A model without vision gets a vision model's eyes (dgc/vision.py).

Everything runs against one fake Ollama on 127.0.0.1 (port 0): /api/show answers capabilities per
model name ("vis*" lists vision, "txt*" does not, anything else is 404) and /api/chat answers the
vision models with a fixed report and the chat's own model from a per-test script. Each test uses
its own URL prefix, so LLMClient's process-wide metadata cache never leaks between tests.
"""
import base64
import copy
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):        # no passwd database (Windows)
        # expanduser("~") reads USERPROFILE, which this suite redirects to a temporary
        # directory -- so on Windows it would report the isolated home as the real account and
        # make a correctly isolated run look like a contaminating one. HOMEDRIVE/HOMEPATH are
        # set by the OS at logon and nothing here rewrites them.
        drive, tail = os.environ.get("HOMEDRIVE", ""), os.environ.get("HOMEPATH", "")
        if drive and tail:
            return Path(drive + tail).resolve(strict=False)
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_vision_relay.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-vision-relay-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import agent as agent_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import sessions, tools, vision  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.agents import AgentDef  # noqa: E402
from dgc.config import Config, DEFAULTS  # noqa: E402
from dgc.headless import _history_vision_items  # noqa: E402
from dgc.llm import LLMClient, _strip_images_with_note  # noqa: E402


def png(width: int = 40, height: int = 30) -> bytes:
    return (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + width.to_bytes(4, "big")
            + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00" + b"\x00" * 16)


PNG = png()
PNG_URI = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")
REPORT = "VISION REPORT: the total reads $54.00 but the items add to $45.00; the button reads 'Place or'."


class FakeOllama:
    """One Ollama-shaped endpoint: capabilities per model name, scripted chat replies."""

    def __init__(self):
        self.shows: list[str] = []
        self.chats: list[dict] = []
        self.script: list[dict] = []          # the chat's own model's replies, in order
        self.refuse_images = False
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, status, payload, kind="application/json"):
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                model = str(body.get("model") or "")
                if self.path.endswith("/api/show"):
                    owner.shows.append(model)
                    if model.startswith("vis"):
                        return self._json(200, {"capabilities": ["completion", "vision", "tools"],
                                                "details": {"family": "fixture"}})
                    if model.startswith("txt"):
                        return self._json(200, {"capabilities": ["completion", "tools"],
                                                "details": {"family": "fixture"}})
                    return self._json(404, {"error": f"model '{model}' not found"})
                if self.path.endswith("/api/chat"):
                    owner.chats.append(body)
                    images = any(m.get("images") for m in body.get("messages") or [])
                    if model.startswith("vis") and owner.refuse_images and images:
                        return self._json(400, {"error": "this model does not support image input"})
                    if model.startswith("vis"):
                        message = {"role": "assistant", "content": f"{REPORT} ({model})"}
                    else:
                        message = (owner.script.pop(0) if owner.script
                                   else {"role": "assistant", "content": "done"})
                    event = {"message": message, "done": True, "done_reason": "stop",
                             "prompt_eval_count": 12, "eval_count": 6}
                    return self._json(200, (json.dumps(event) + "\n").encode(), "application/x-ndjson")
                self._json(404, {"error": "no route"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    def chats_for(self, prefix: str) -> list[dict]:
        return [body for body in self.chats if str(body.get("model") or "").startswith(prefix)]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class RecordingUI:
    non_interactive = False

    def __init__(self):
        self.calls: list = []

    def tool_images(self, call_id, images, caption="", *, items=None, omitted=0, meta=None):
        self.calls.append(("tool_images", (call_id, len(images), caption), {}))

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)

        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return "once" if name == "approve" else None
        return record

    def named(self, name):
        return [call for call in self.calls if call[0] == name]


class VisionRelayTests(unittest.TestCase):
    _prefix = 0

    @classmethod
    def setUpClass(cls):
        cls.ollama = FakeOllama()

    @classmethod
    def tearDownClass(cls):
        cls.ollama.close()

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-vision-relay-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        self.ollama.shows.clear()
        self.ollama.chats.clear()
        self.ollama.script = []
        self.ollama.refuse_images = False
        VisionRelayTests._prefix += 1
        self.base = f"http://127.0.0.1:{self.ollama.port}/t{VisionRelayTests._prefix}"

    def agent(self, model: str, *, defs: dict | None = None, **data) -> Agent:
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url=self.base, model=model, mode="auto", api_mode="ollama", hooks={},
                        mcp_servers={}, suggest=False, artifact_autostart=False, max_turns=6,
                        thinking="off", notes=False)
        cfg.data.update(data)
        cfg._stored_secrets, cfg._env_secret_keys, cfg._explicit_keys = {}, set(), set()
        cfg.credential_warnings = ()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        self.ui = RecordingUI()
        if defs is not None:
            scoped = patch.object(agent_module, "discover_agents",
                                  lambda root, config=None: dict(defs))
            scoped.start()
            self.addCleanup(scoped.stop)
        agent = Agent(cfg, self.ui)
        agent.session_file = sessions.new_path(self.root)
        self.addCleanup(agent.mcp.stop_all)
        return agent

    # --- capability detection ---------------------------------------------------------------

    def test_capability_detection_needs_positive_evidence(self):
        vis = LLMClient(self.base, "", "vis-a", api_mode="ollama")
        txt = LLMClient(self.base, "", "txt-a", api_mode="ollama")
        gone = LLMClient(self.base, "", "missing", api_mode="ollama")
        self.assertTrue(vision.has_vision(vis))
        self.assertFalse(vision.has_vision(txt))
        self.assertTrue(gone.vision_supported, "the optimistic default the main path keeps")
        self.assertFalse(vision.has_vision(gone), "no /api/show capabilities is no evidence of vision")
        pinned = LLMClient(self.base, "", "missing", api_mode="ollama",
                           provider_capabilities={"vision": True})
        self.assertTrue(vision.has_vision(pinned), "an explicit provider_capabilities.vision wins")
        compat = LLMClient("http://127.0.0.1:9/v1", "", "gpt-x", api_mode="chat_completions")
        self.assertTrue(vision.has_vision(compat), "an endpoint without discovery is tried optimistically")

    # --- the routing decision ---------------------------------------------------------------

    def test_the_sub_agent_model_is_chosen_when_it_has_vision(self):
        agent = self.agent("txt-main", subagent_model="vis-sub")
        route = agent._vision_route(probe=True)
        self.assertIsNotNone(route)
        self.assertEqual((route.model, route.origin), ("vis-sub", "sub-agent model"))
        self.assertEqual(route.label, "vis-sub (sub-agent model)")

    def test_a_named_agent_with_vision_is_the_fallback_and_viewer_is_preferred(self):
        defs = {"alpha": AgentDef(name="alpha", description="", body="", model="vis-alpha"),
                "viewer": AgentDef(name="viewer", description="", body="", model="vis-viewer"),
                "plain": AgentDef(name="plain", description="", body="")}
        agent = self.agent("txt-main", subagent_model="txt-sub", defs=defs)
        route = agent._vision_route(probe=True)
        self.assertEqual((route.model, route.origin), ("vis-viewer", "agent viewer"))
        self.assertIn("txt-sub", self.ollama.shows, "the sub-agent model was checked first")
        del defs["viewer"]
        agent = self.agent("txt-main", subagent_model="txt-sub", defs=defs)
        self.assertEqual(agent._vision_route(probe=True).origin, "agent alpha")

    def test_no_routing_when_the_main_model_can_see(self):
        agent = self.agent("vis-main", subagent_model="vis-sub")
        agent.client.prepare_model()
        self.assertIsNone(agent._vision_route(probe=True))
        self.assertNotIn("vis-sub", self.ollama.shows, "nothing is probed for a model that sees")
        agent._active_tool_intents.add("image")
        schema = next(tool for tool in agent._tool_schemas() if tool["function"]["name"] == "view_image")
        self.assertNotIn("question", schema["function"]["parameters"]["properties"],
                         "a model that sees keeps the plain view_image")

    def test_nothing_configured_resolves_to_no_route(self):
        agent = self.agent("txt-main")
        self.assertIsNone(agent._vision_route(probe=True))

    def test_a_sub_agent_on_a_blind_model_can_use_the_main_model(self):
        agent = self.agent("vis-main", subagent_model="txt-sub")
        child = self.agent("vis-main", subagent_model="txt-sub")
        child.client = agent._subagent_client(None)             # how a task child gets its route
        route = child._vision_route(probe=True)
        self.assertEqual((route.model, route.origin, route.kind), ("vis-main", "main model", "main"))

    def test_the_route_is_cached_and_a_config_change_resolves_again(self):
        agent = self.agent("txt-main", subagent_model="vis-sub")
        agent._vision_route(probe=True)
        probes = len(self.ollama.shows)
        for _ in range(5):
            self.assertEqual(agent._vision_route(probe=True).model, "vis-sub")
            agent._tool_schemas()
        self.assertEqual(len(self.ollama.shows), probes, "no capability probe per request")
        agent.config.data["subagent_model"] = "vis-other"
        self.assertIsNone(agent._vision_route(probe=False), "a stale key never answers from cache")
        self.assertEqual(agent._vision_route(probe=True).model, "vis-other")

    def test_an_endpoint_that_refuses_the_image_is_forgotten(self):
        agent = self.agent("txt-main", subagent_model="vis-sub")
        route = agent._vision_route(probe=True)
        self.assertEqual(route.model, "vis-sub")
        self.ollama.refuse_images = True            # it said vision, then refuses the pixels
        ok, why = vision.look(agent, route, [(PNG_URI, "x")], "what is it?")
        self.assertFalse(ok)
        self.assertIn("vis-sub refused the image", why)
        self.assertIsNone(agent.__dict__["_vision_route_cache"].route, "the route is forgotten")
        self.assertIsNone(agent._vision_route(probe=True),
                          "the refusal is remembered: the model no longer counts as a vision model")

    # --- attachments ------------------------------------------------------------------------

    def test_an_attached_image_is_looked_at_by_the_vision_model_and_its_report_reaches_the_main_model(self):
        agent = self.agent("txt-main", subagent_model="vis-sub")
        agent._pending_images = [PNG_URI]
        self.assertTrue(agent.run_turn("What is wrong with this checkout card?"))
        calls = self.ui.named("tool_call")
        self.assertEqual(len(calls), 1)
        name, args, call_id = calls[0][1]
        self.assertEqual(name, "view_image")
        self.assertEqual(args["via"], "vis-sub (sub-agent model)")
        self.assertEqual(args["path"], "attached image")
        self.assertIn("checkout card", args["question"])
        result = self.ui.named("tool_result")[0][1]
        self.assertEqual(result[2], call_id)
        self.assertTrue(result[1].startswith(
            "vis-sub (sub-agent model) looked at the attached image because txt-main cannot read images."))
        self.assertIn(REPORT, result[1])
        # The vision model received the pixels and the user's words.
        looked = self.ollama.chats_for("vis-sub")
        self.assertEqual(len(looked), 1)
        self.assertTrue(any(m.get("images") for m in looked[0]["messages"]))
        self.assertIn("checkout card", json.dumps(looked[0]["messages"]))
        # The chat's model received the report in place of the pixels.
        main = self.ollama.chats_for("txt-main")
        self.assertTrue(main)
        self.assertFalse(any(m.get("images") for m in main[0]["messages"]))
        wire = json.dumps(main[0]["messages"])
        self.assertIn("vision-report", wire)
        self.assertIn("$45.00", wire)
        self.assertNotIn("_dgc_vision", wire, "private transcript keys never reach a request")
        # The transcript keeps the pixels and records the look for replay.
        prompt = next(m for m in agent.messages if m.get("role") == "user" and isinstance(m.get("content"), list))
        self.assertTrue(any(p.get("type") == "image_url" for p in prompt["content"]))
        self.assertEqual(prompt["_dgc_vision"]["model"], "vis-sub")
        self.assertEqual(prompt["_dgc_vision"]["call_id"], call_id)

    def test_without_a_vision_model_the_user_is_told_how_to_get_one(self):
        agent = self.agent("txt-main")
        agent._pending_images = [PNG_URI]
        self.assertTrue(agent.run_turn("What is wrong with this?"))
        self.assertFalse(self.ui.named("tool_call"), "no card claims a look that never happened")
        infos = [call[1][0] for call in self.ui.named("info")]
        self.assertTrue(any("txt-main cannot read images and no vision model is set up" in line
                            and "/subagent model NAME" in line for line in infos), infos)
        main = self.ollama.chats_for("txt-main")
        wire = json.dumps(main[0]["messages"])
        self.assertIn("cannot read images", wire)
        self.assertIn("/subagent model NAME", wire)
        self.assertFalse(any(m.get("images") for m in main[0]["messages"]))

    def test_a_main_model_with_vision_gets_the_pixels_and_no_relay(self):
        agent = self.agent("vis-main", subagent_model="vis-sub")
        agent._pending_images = [PNG_URI]
        self.assertTrue(agent.run_turn("What is wrong with this?"))
        self.assertFalse(self.ui.named("tool_call"))
        self.assertFalse(self.ollama.chats_for("vis-sub"), "the vision sub-agent was not asked")
        self.assertTrue(any(m.get("images") for m in self.ollama.chats_for("vis-main")[0]["messages"]))

    # --- view_image and read_file -----------------------------------------------------------

    def test_view_image_asks_the_vision_model_with_the_models_question(self):
        (self.root / "docs").mkdir()
        (self.root / "docs" / "mock.png").write_bytes(PNG)
        agent = self.agent("txt-main", subagent_model="vis-sub")
        self.ollama.script = [
            {"role": "assistant", "content": "", "tool_calls": [{"function": {
                "name": "view_image", "arguments": {"path": "docs/mock.png",
                                                   "question": "What is the header colour?"}}}]},
            {"role": "assistant", "content": "The mockup's total is wrong."}]
        self.assertTrue(agent.run_turn("Match the header in docs/mock.png"))
        first = self.ollama.chats_for("txt-main")[0]
        offered = [tool for tool in first.get("tools") or [] if tool["function"]["name"] == "view_image"]
        self.assertEqual(len(offered), 1, "the text-only model is offered view_image once")
        self.assertIn("question", offered[0]["function"]["parameters"]["properties"])
        results = [call[1] for call in self.ui.named("tool_result") if call[1][0] == "view_image"]
        self.assertEqual(len(results), 1)
        out = results[0][1]
        self.assertTrue(out.startswith("viewed docs/mock.png (image/png, 40×30, "), out)
        self.assertIn("through vis-sub (sub-agent model)", out)
        self.assertIn("Question: What is the header colour?", out)
        self.assertIn(REPORT, out)
        self.assertTrue(self.ui.named("tool_images"), "the user still gets the image chip")
        asked = self.ollama.chats_for("vis-sub")[0]
        self.assertIn("What is the header colour?", json.dumps(asked["messages"]))
        second = self.ollama.chats_for("txt-main")[1]
        self.assertFalse(any(m.get("images") for m in second["messages"]))
        self.assertIn("$45.00", json.dumps(second["messages"]))

    def test_view_image_is_not_offered_to_a_blind_model_without_a_vision_model(self):
        agent = self.agent("txt-main")
        agent.client.prepare_model()
        agent._vision_route(probe=True)
        agent._active_tool_intents.add("image")
        self.assertNotIn("view_image", [tool["function"]["name"] for tool in agent._tool_schemas()])
        (self.root / "shot.png").write_bytes(PNG)
        out = tools.execute("read_file", {"path": "shot.png"}, agent.ctx)
        self.assertIn("cannot read images", out)
        self.assertIn("/subagent model NAME", out)

    def test_read_file_on_an_image_is_looked_at_with_a_default_question(self):
        (self.root / "shot.png").write_bytes(PNG)
        agent = self.agent("txt-main", subagent_model="vis-sub")
        agent.client.prepare_model()
        agent._vision_route(probe=True)
        out = tools.execute("read_file", {"path": "shot.png"}, agent.ctx)
        self.assertTrue(out.startswith("viewed shot.png"), out)
        self.assertIn(vision.DEFAULT_QUESTION, out)
        self.assertIn(REPORT, out)

    def test_a_screenshot_tells_a_blind_model_how_the_vision_model_can_look(self):
        agent = self.agent("txt-main", subagent_model="vis-sub")
        agent.client.prepare_model()
        agent._vision_route(probe=True)

        class Session:
            current_url = "http://127.0.0.1:1/page"

            def navigate(self, url):
                return "load"

            def screenshot_png(self):
                return PNG
        with patch.object(tools, "_browser_session", return_value=Session()):
            out = tools.browser_tool({"operation": "screenshot"}, agent.ctx)
        tools.take_pending_images(agent.ctx.tool_owner)
        self.assertIn("To have vis-sub (sub-agent model) look at it, call view_image with path "
                      ".dgc/screenshots/page-", out)
        agent._after_image_call("browser", out)
        self.assertIn("image", agent._active_tool_intents)

    # --- the wire note and replay -----------------------------------------------------------

    def test_the_request_carries_the_report_in_place_of_the_pixels(self):
        seen = {"model": "vis-sub", "text": "The button is clipped."}
        messages = [{"role": "user", "content": [{"type": "text", "text": "what is wrong?"},
                                                 {"type": "image_url", "image_url": {"url": PNG_URI}}],
                     "_dgc_vision": seen}]
        stripped, dropped = _strip_images_with_note(messages, "txt-main")
        self.assertEqual(dropped, 1)
        note = stripped[0]["content"][-1]["text"]
        self.assertIn("txt-main cannot read images, so DGC showed it to vis-sub", note)
        self.assertIn("<vision-report model=\"vis-sub\">\nThe button is clipped.\n</vision-report>", note)
        self.assertIs(messages[0]["content"][1]["type"], "image_url", "the transcript is never changed")

    def test_history_replays_the_card_with_valid_v14_events(self):
        items = _history_vision_items({"call_id": "vision-0123456789ab", "model": "vis-sub",
                                       "origin": "sub-agent model", "images": 2,
                                       "question": "what is wrong?", "text": REPORT,
                                       "output": "vis-sub (sub-agent model) looked at the 2 attached images"})
        self.assertEqual([item["type"] for item in items], ["tool_call", "tool_result"])
        self.assertEqual(items[0]["summary"], "2 attached images · via vis-sub (sub-agent model)")
        for item in items:
            self.assertIsNone(ep.event_error({**item, "seq": 0}), item)
        self.assertEqual(_history_vision_items(None), [])
        self.assertEqual(_history_vision_items({"text": ""}), [])


if __name__ == "__main__":
    unittest.main()
