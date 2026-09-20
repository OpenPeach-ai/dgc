"""Model-viewed images: vision availability, the image-rejection downgrade, the private image store,
view_image, MCP images, headless frames, get_image and history replay."""
import base64
import copy
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import types
import unittest

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from waiting import RUNNER_SLACK                          # noqa: E402  (same module name discovery uses)
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import image_views, sessions, tools
from dgc.agent import Agent, _SubUI
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend, HeadlessUI, _WAKE_NEUTRAL_COMMANDS, _BUSY_MUTATIONS
from dgc.llm import LLMClient, ToolCall, ToolsUnsupportedError
from dgc.permissions import DISPLAY, DISPLAY_TO_TOOL, PermissionEngine, Rule
from dgc.protocol import Emitter, PendingRequests
from dgc.tools import _vision_available, execute


# ---- fixtures -----------------------------------------------------------------------------------
def png(width: int = 1280, height: int = 757, extra: bytes = b"") -> bytes:
    return (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + width.to_bytes(4, "big")
            + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00" + b"\x00" * 16 + extra)


def jpeg(width: int, height: int, progressive: bool = False) -> bytes:
    app0 = b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof = (b"\xff" + (b"\xc2" if progressive else b"\xc0") + b"\x00\x11\x08"
           + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03" + b"\x01\x22\x00" * 3)
    return b"\xff\xd8" + app0 + sof + b"\xff\xd9"


def gif(width: int, height: int) -> bytes:
    return b"GIF89a" + width.to_bytes(2, "little") + height.to_bytes(2, "little") + b"\x00" * 8


def bmp(width: int, height: int) -> bytes:
    body = b"\x00" * 8
    return (b"BM" + (54 + len(body)).to_bytes(4, "little") + b"\x00" * 4 + (54).to_bytes(4, "little")
            + (40).to_bytes(4, "little") + width.to_bytes(4, "little", signed=True)
            + (-height).to_bytes(4, "little", signed=True) + b"\x01\x00\x18\x00" + b"\x00" * 24 + body)


def webp(kind: str, width: int, height: int) -> bytes:
    if kind == "VP8X":
        chunk = b"VP8X" + (10).to_bytes(4, "little") + b"\x00" * 4 + (width - 1).to_bytes(3, "little") \
            + (height - 1).to_bytes(3, "little")
    elif kind == "VP8L":
        bits = (width - 1) | ((height - 1) << 14)
        chunk = b"VP8L" + (5).to_bytes(4, "little") + b"\x2f" + bits.to_bytes(4, "little") + b"\x00" * 5
    else:
        chunk = (b"VP8 " + (10).to_bytes(4, "little") + b"\x00\x00\x00\x9d\x01\x2a"
                 + width.to_bytes(2, "little") + height.to_bytes(2, "little") + b"\x00" * 4)
    return b"RIFF" + (4 + len(chunk)).to_bytes(4, "little") + b"WEBP" + chunk


def fixture_config(root: Path, **data) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
    config.data.update(data)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class QuietUI:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


class RecordingUI:
    """Records every UI call in order; answers approvals with 'once'."""
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return "once" if name == "approve" else None
        return record

    def named(self, name):
        return [call for call in self.calls if call[0] == name]


def fake_client(vision: bool) -> LLMClient:
    """A real client object whose vision answer is pinned (no network is ever touched)."""
    class _Client(LLMClient):
        vision_supported = vision
    return _Client("http://localhost.invalid/v1", "", "fixture")


def make_agent(root: Path, *, vision: bool = True, ui=None, **data) -> Agent:
    with patch.object(Agent, "_new_client", lambda self, *args, **kwargs: fake_client(vision)):
        return Agent(fixture_config(root, **data), ui or QuietUI())


def uri_of(data: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


# ---- a fake model endpoint (port 0) ---------------------------------------------------------------
class FakeModel:
    """An OpenAI-compatible (and Responses and Anthropic) endpoint scripted per request."""

    def __init__(self, script):
        self.script = script
        self.requests: list[tuple[str, dict]] = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                owner.requests.append((self.path, body))
                status, payload = owner.script(self.path, body, len(owner.requests))
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def image_parts(self, index: int) -> int:
        body = self.requests[index][1]
        count = 0
        for message in body.get("messages") or body.get("input") or []:
            content = message.get("content") if isinstance(message, dict) else None
            if isinstance(content, list):
                count += sum(1 for part in content if isinstance(part, dict)
                             and part.get("type") in ("image_url", "input_image", "image"))
        return count


def chat_answer(text="ok", tool_calls=None):
    message = {"role": "assistant", "content": text}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {"choices": [{"index": 0, "message": message,
                         "finish_reason": "tool_calls" if tool_calls else "stop"}]}


def refuses_images(status: int, body: str = "this model does not support image input (image_url)"):
    def script(path, request, n):
        if any(isinstance(m.get("content"), list) and any(
                isinstance(p, dict) and p.get("type") in ("image_url", "input_image", "image")
                for p in m["content"]) for m in (request.get("messages") or request.get("input") or [])
               if isinstance(m, dict)):
            return status, {"error": {"message": body}}
        if path.endswith("/responses"):
            return 200, {"id": "r1", "status": "completed", "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]}
        if path.endswith("/messages"):
            return 200, {"id": "m1", "type": "message", "stop_reason": "end_turn",
                         "content": [{"type": "text", "text": "ok"}]}
        return 200, chat_answer("ok")
    return script


TOOLS = [{"type": "function", "function": {"name": "ls", "description": "list",
                                             "parameters": {"type": "object", "properties": {}}}}]
IMAGE_MESSAGES = [{"role": "user", "content": [
    {"type": "text", "text": "what is on this page?"},
    {"type": "image_url", "image_url": {"url": uri_of(png(2, 2))}}]}]


# ---- vision availability ----------------------------------------------------------------------------
class VisionAtInitTests(unittest.TestCase):
    def test_vision_is_available_right_after_init(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-init-") as directory:
            agent = make_agent(Path(directory), vision=True)
            try:
                self.assertTrue(_vision_available(agent.ctx))
                agent.client = fake_client(False)      # a fallback or sub-agent client swap
                self.assertFalse(_vision_available(agent.ctx), "no refresh_client needed")
                agent.client = fake_client(True)
                self.assertTrue(_vision_available(agent.ctx))
            finally:
                agent.mcp.stop_all()

    def test_vision_available_accepts_bools_and_callables(self):
        self.assertTrue(_vision_available(types.SimpleNamespace(vision=True)))
        self.assertFalse(_vision_available(types.SimpleNamespace(vision=lambda: False)))
        self.assertFalse(_vision_available(types.SimpleNamespace()))
        def broken():
            raise RuntimeError("boom")
        self.assertFalse(_vision_available(types.SimpleNamespace(vision=broken)))


# ---- the image-rejection downgrade (llm.py) --------------------------------------------------------
class DowngradeTests(unittest.TestCase):
    def chat_twice(self, status, body="this model does not support image input (image_url)"):
        server = FakeModel(refuses_images(status, body))
        try:
            client = LLMClient(server.base_url, "", f"text-only-{status}", api_mode="chat_completions")
            self.assertTrue(client.vision_supported and client.tools_supported)
            result = client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS)
            self.assertEqual(result.content, "ok")
            self.assertEqual(len(server.requests), 2, "one refused request, one retry")
            self.assertEqual(server.image_parts(0), 1)
            self.assertEqual(server.image_parts(1), 0)
            retried = json.dumps(server.requests[1][1])
            self.assertIn("cannot read images", retried)
            self.assertIn("tools", server.requests[1][1], "native tools stay on")
            self.assertTrue(client.tools_supported)
            self.assertFalse(client.vision_supported)
            self.assertEqual(client.dropped_images, 1)
            client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS)
            self.assertEqual(len(server.requests), 3, "the next chat skips the failed try")
            self.assertEqual(server.image_parts(2), 0)
            self.assertIn("image_url", json.dumps(IMAGE_MESSAGES), "the transcript is untouched")
        finally:
            server.close()

    def test_400_image_refusal_downgrades_vision_not_tools(self):
        self.chat_twice(400)

    def test_422_image_refusal_takes_the_same_branch(self):
        self.chat_twice(422, "Input should be a valid string [type=string_type, input_value={'type': 'image_url'}]")

    def test_500_image_refusal_is_not_a_transient_retry(self):
        self.chat_twice(500, "image input is not supported: the server has no mmproj loaded")

    def test_vision_rejection_lasts_at_least_an_hour(self):
        client = LLMClient("http://127.0.0.1:9/v1", "", "ttl", api_mode="chat_completions",
                           capability_cache_ttl_s=5)
        with patch("dgc.llm.time.monotonic", return_value=1000.0):
            client._without_images(copy.deepcopy(IMAGE_MESSAGES), refused=True)
        with patch("dgc.llm.time.monotonic", return_value=1000.0 + 3599):
            self.assertFalse(client.vision_supported)

    def test_unrelated_400_about_tools_still_takes_the_tools_branch(self):
        def script(path, request, n):
            return 400, {"error": {"message": "tool_choice auto requires --enable-auto-tool-choice"}}
        server = FakeModel(script)
        try:
            client = LLMClient(server.base_url, "", "no-tools", api_mode="chat_completions")
            with self.assertRaises(ToolsUnsupportedError):
                client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS)
            self.assertFalse(client.tools_supported)
            self.assertTrue(client.vision_supported, "an image in the request is not blamed")
        finally:
            server.close()

    def test_text_only_request_is_never_matched(self):
        def script(path, request, n):
            return 400, {"error": {"message": "vision encoder busy"}}
        server = FakeModel(script)
        try:
            client = LLMClient(server.base_url, "", "no-image", api_mode="chat_completions")
            with self.assertRaises(Exception):
                client.chat([{"role": "user", "content": "hi"}])
            self.assertTrue(client.vision_supported)
            self.assertEqual(len(server.requests), 1)
        finally:
            server.close()

    def test_responses_path_downgrades(self):
        for status in (400, 422, 500):
            server = FakeModel(refuses_images(status))
            try:
                client = LLMClient(server.base_url, "", f"resp-{status}", api_mode="responses")
                result = client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS)
                self.assertEqual(result.content, "ok")
                self.assertEqual(len(server.requests), 2, status)
                self.assertEqual((server.image_parts(0), server.image_parts(1)), (1, 0), status)
                self.assertTrue(client.tools_supported, status)
                self.assertFalse(client.vision_supported, status)
                client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS)
                self.assertEqual((len(server.requests), server.image_parts(2)), (3, 0), status)
            finally:
                server.close()

    def test_anthropic_path_downgrades(self):
        for status in (400, 422, 500):
            server = FakeModel(refuses_images(status, "image input is not supported by this model"))
            try:
                client = LLMClient(server.base_url, "k", f"claude-text-{status}", api_mode="anthropic")
                result = client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS)
                self.assertEqual(result.content, "ok")
                self.assertEqual(len(server.requests), 2, status)
                self.assertEqual((server.image_parts(0), server.image_parts(1)), (1, 0), status)
                self.assertTrue(client.tools_supported, status)
                self.assertFalse(client.vision_supported, status)
            finally:
                server.close()

    def test_native_ollama_refusal_downgrades_when_show_is_silent(self):
        # The body a real text-only Ollama model (qwen2.5:14b) returns for /api/chat with images.
        refusal = json.dumps({"error": {"code": 400, "type": "invalid_request_error", "message":
                              "Multimodal data provided, but model does not support multimodal requests."}})
        for status in (400, 500):
            def script(path, body, n):
                if path.endswith("/api/show"):     # no capabilities array: vision stays optimistic
                    return 200, {"details": {"family": "qwen2"},
                                 "model_info": {"general.architecture": "qwen2", "qwen2.context_length": 32768}}
                if any(m.get("images") for m in body.get("messages", [])):
                    return status, {"error": refusal}
                return 200, {"model": "m", "message": {"role": "assistant", "content": "ok"},
                             "done": True, "done_reason": "stop"}
            server = FakeModel(script)
            try:
                client = LLMClient(server.base_url[:-3], "", "qwen2.5:14b", api_mode="ollama")
                self.assertTrue(client.vision_supported, status)
                self.assertEqual(client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS).content, "ok")
                chats = [body for path, body in server.requests if path.endswith("/api/chat")]
                self.assertEqual([sum(1 for m in b["messages"] if m.get("images")) for b in chats], [1, 0], status)
                self.assertIn("cannot read images", json.dumps(chats[1]))
                self.assertIn("tools", chats[1], "native tools stay on")
                self.assertTrue(client.tools_supported, status)
                self.assertFalse(client.vision_supported, status)
                client.chat(copy.deepcopy(IMAGE_MESSAGES), tools=TOOLS)
                chats = [body for path, body in server.requests if path.endswith("/api/chat")]
                self.assertEqual((len(chats), sum(1 for m in chats[2]["messages"] if m.get("images"))), (3, 0))
            finally:
                server.close()

    def test_anthropic_leaves_a_note_for_an_image_it_cannot_take(self):
        def script(path, body, n):
            return 200, {"id": "m1", "type": "message", "stop_reason": "end_turn",
                         "content": [{"type": "text", "text": "ok"}]}
        server = FakeModel(script)
        try:
            client = LLMClient(server.base_url, "k", "claude-bmp", api_mode="anthropic")
            messages = [{"role": "user", "content": [{"type": "text", "text": "look"},
                                                     {"type": "image_url", "image_url": {"url": uri_of(bmp(4, 4), "image/bmp")}}]}]
            for _ in range(2):
                self.assertEqual(client.chat(copy.deepcopy(messages), tools=TOOLS).content, "ok")
            self.assertEqual(len(server.requests), 2, "every request reaches the endpoint")
            self.assertEqual(server.image_parts(1), 0)
            self.assertIn("only JPEG, PNG, GIF and WebP images can be sent", json.dumps(server.requests[1][1]))
            self.assertTrue(client.vision_supported and client.tools_supported)
        finally:
            server.close()

    def test_ollama_still_strips_for_a_text_only_model(self):
        stripped, dropped = __import__("dgc.llm", fromlist=["_strip_images_with_note"])._strip_images_with_note(
            copy.deepcopy(IMAGE_MESSAGES), "tiny")
        self.assertEqual(dropped, 1)
        self.assertEqual([part["type"] for part in stripped[0]["content"]], ["text", "text"])
        self.assertIn("tiny cannot read images", stripped[0]["content"][1]["text"])


# ---- end to end through a real Agent -----------------------------------------------------------------
class FakeBrowser:
    current_url = "https://user:secret@vibedgc.com/login?token=abc"

    def __init__(self, data):
        self.data = data

    def screenshot_png(self):
        return self.data


class AgentImageRunTests(unittest.TestCase):
    def run_agent(self, *, refuse: bool, vision_config: bool = True):
        shot = png(1280, 757)
        calls = {"n": 0}

        def script(path, request, n):
            has_image = any(isinstance(m.get("content"), list) and any(
                p.get("type") == "image_url" for p in m["content"] if isinstance(p, dict))
                for m in request.get("messages", []))
            if refuse and has_image:
                return 400, {"error": {"message": "image input is not supported for this model"}}
            calls["n"] += 1
            if calls["n"] == 1:
                return 200, chat_answer("", [{"id": "call_shot", "type": "function", "function": {
                    "name": "browser", "arguments": json.dumps({"operation": "screenshot"})}}])
            return 200, chat_answer("The page shows a login form.")

        server = FakeModel(script)
        directory = tempfile.TemporaryDirectory(prefix="dgc-images-e2e-")
        root = Path(directory.name)
        ui = RecordingUI()
        capabilities = {} if vision_config else {"vision": False}
        config = fixture_config(root, base_url=server.base_url, model="e2e-model", mode="auto",
                                api_mode="chat_completions", provider_capabilities=capabilities)
        agent = Agent(config, ui)
        try:
            with patch("dgc.tools._browser_session", return_value=FakeBrowser(shot)):
                self.assertTrue(agent.run_turn("take a screenshot of the login page"))
                agent.run_turn("thanks, what else is on it?")
            return server, agent, ui, shot
        finally:
            agent.mcp.stop_all()
            server.close()
            directory.cleanup()

    def test_refusing_endpoint_completes_and_stops_receiving_images(self):
        server, agent, ui, shot = self.run_agent(refuse=True)
        images = ui.named("tool_images")
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0][1][0], "call_shot")
        self.assertEqual(images[0][1][1], [uri_of(shot)])
        meta = images[0][2]["meta"][0]
        self.assertTrue(meta["name"].startswith("page-") and meta["name"].endswith(".png"), meta["name"])
        self.assertEqual(meta["host"], "vibedgc.com", "host only: no userinfo, path or query")
        self.assertEqual((meta["width"], meta["height"]), (1280, 757))
        with_images = [i for i in range(len(server.requests)) if server.image_parts(i)]
        self.assertEqual(len(with_images), 1, "exactly one request carried the image")
        second_turn_first = next(i for i, (_, body) in enumerate(server.requests)
                                 if "thanks, what else" in json.dumps(body))
        self.assertEqual(server.image_parts(second_turn_first), 0)
        self.assertTrue(all("tools" in body for _, body in server.requests), "native tools stayed on")
        self.assertFalse(agent.client.vision_supported)

    def test_text_only_model_gets_no_pixels_but_the_chat_shows_them(self):
        server, agent, ui, shot = self.run_agent(refuse=False, vision_config=False)
        self.assertEqual(len(ui.named("tool_images")), 1)
        self.assertFalse(any(server.image_parts(i) for i in range(len(server.requests))))
        self.assertFalse(any(isinstance(m.get("content"), list) for m in agent.messages
                             if m.get("role") == "user"), "no image part reaches self.messages")
        result = next(m["content"] for m in agent.messages if m.get("role") == "tool")
        self.assertIn("The user can see the screenshot in the chat.", result)
        self.assertNotIn("user:secret", json.dumps(ui.named("tool_images")[0][2]["meta"]))


class NoImagesUI(QuietUI):
    """A front end with no tool_images (ACP)."""
    def __getattr__(self, name):
        if name == "tool_images" or name.startswith("__"):
            raise AttributeError(name)
        return super().__getattr__(name)


class ModelFormatTests(unittest.TestCase):
    """A BMP is shown in the chat but never queued for the model: OpenAI and Anthropic refuse it."""

    def test_bmp_is_shown_but_not_sent(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-bmp-") as directory:
            root = Path(directory)
            (root / "icon.bmp").write_bytes(bmp(16, 16))
            (root / "icon.png").write_bytes(png(16, 16))
            calls = {"n": 0}

            def script(path, request, n):
                calls["n"] += 1
                if calls["n"] == 1:
                    return 200, chat_answer("", [{"id": "call_bmp", "type": "function", "function": {
                        "name": "view_image", "arguments": json.dumps({"path": "icon.bmp"})}}])
                return 200, chat_answer("A small icon.")

            server = FakeModel(script)
            ui = RecordingUI()
            agent = Agent(fixture_config(root, base_url=server.base_url, model="vision-model", mode="auto",
                                         api_mode="chat_completions",
                                         provider_capabilities={"vision": True}), ui)
            try:
                self.assertTrue(agent.run_turn("what does icon.bmp look like?"))
                result = next(m["content"] for m in agent.messages if m.get("role") == "tool")
                self.assertIn("viewed icon.bmp (image/bmp, 16×16, 1 KB). BMP cannot be sent to the model, so "
                              "it is shown in the chat only; convert it to PNG to look at it.", result)
                self.assertEqual(len(ui.named("tool_images")), 1, "the chat still shows it")
                self.assertFalse(any(server.image_parts(i) for i in range(len(server.requests))))
                self.assertTrue(agent.client.tools_supported and agent.client.vision_supported)

                agent._image_batch_open = True
                agent._handle_call(ToolCall("call_png", "view_image", {"path": "icon.png"}))
                self.assertEqual([shot["source"] for shot in agent._turn_images], ["view_image"])
                agent._turn_images = []
                agent._handle_call(ToolCall("call_bmp2", "view_image", {"path": "icon.bmp"}))
                self.assertEqual(agent._turn_images, [])
            finally:
                agent.mcp.stop_all()
                server.close()

    def test_read_file_on_an_image_is_a_viewing_step(self):
        """Founder decision 4: with vision, read_file on an image shows it (chat and model, source
        read_file) instead of an error; without vision the error stays and nothing is shown."""
        for vision in (True, False):
            with self.subTest(vision=vision), tempfile.TemporaryDirectory(prefix="dgc-images-read-") as directory:
                root = Path(directory).resolve()
                (root / "shapes.png").write_bytes(png(32, 24))
                calls = {"n": 0}

                def script(path, request, n):
                    calls["n"] += 1
                    if calls["n"] == 1:
                        return 200, chat_answer("", [{"id": "call_read", "type": "function", "function": {
                            "name": "read_file", "arguments": json.dumps({"path": "shapes.png"})}}])
                    return 200, chat_answer("A red circle.")

                server = FakeModel(script)
                ui = RecordingUI()
                agent = Agent(fixture_config(root, base_url=server.base_url, model="vision-model", mode="auto",
                                             api_mode="chat_completions",
                                             provider_capabilities={"vision": vision}), ui)
                agent.session_file = sessions.new_path(root)
                try:
                    self.assertTrue(agent.run_turn("read shapes.png and tell me what is on it"))
                    result = next(m["content"] for m in agent.messages if m.get("role") == "tool")
                    images = ui.named("tool_images")
                    if vision:
                        self.assertTrue(result.startswith("viewed shapes.png (image/png, 32×24, "), result)
                        self.assertEqual(len(images), 1)
                        self.assertEqual(images[0][1][0], "call_read", "the image sits under the read_file step")
                        self.assertEqual([m["source"] for m in images[0][2]["meta"]], ["read_file"])
                        self.assertEqual([i["source"] for i in images[0][2]["items"] or []], ["read_file"])
                        self.assertEqual(sum(server.image_parts(i) for i in range(len(server.requests))), 1,
                                         "the model got the picture after the batch")
                        self.assertEqual([r.source for r in agent.image_views], ["read_file"])
                    else:
                        self.assertIn("cannot read images", result)
                        self.assertEqual(len(images), 1, "the chat still gets a clickable chip")
                        self.assertEqual(images[0][1][0], "call_read")
                        self.assertFalse(any(server.image_parts(i) for i in range(len(server.requests))))
                finally:
                    agent.mcp.stop_all()
                    server.close()

    def test_mcp_words_follow_what_really_happens(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-mcp-words-") as directory:
            root = Path(directory)
            for ui, shown in ((RecordingUI(), True), (NoImagesUI(), False)):
                agent = make_agent(root, ui=ui, mode="auto")
                try:
                    seen = []
                    def call(target, arguments, cancel=None, *, on_image=None, **kwargs):
                        seen.append(on_image("image/png", png(8, 8), name="a.png"))
                        seen.append(on_image("image/bmp", bmp(8, 8), name="b.bmp"))
                        return "ok"
                    agent.mcp.call = call
                    agent.execute_mcp_tool("mcp__srv__chart", {}, "editor-1")
                    agent._image_batch_open = True
                    agent.execute_mcp_tool("mcp__srv__chart", {}, "call-2")
                    agent.client.__class__.vision_supported = False
                    agent.execute_mcp_tool("mcp__srv__chart", {}, "call-3")
                    where = "; the user can see it in the chat" if shown else ""
                    self.assertEqual(seen, [
                        "shown in the chat only" if shown else "not sent to the model",
                        f"image/bmp cannot be sent to the model{where}",
                        True, f"image/bmp cannot be sent to the model{where}",
                        f"this model cannot read images{where}", f"this model cannot read images{where}"])
                    self.assertEqual(len(agent._turn_images), 1, "only the PNG of the open batch")
                finally:
                    agent.mcp.stop_all()

    def test_screenshot_words_for_a_front_end_without_images(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-acp-") as directory:
            root = Path(directory)
            for ui, shown in ((RecordingUI(), True), (NoImagesUI(), False)):
                agent = make_agent(root, ui=ui, mode="auto", vision=False)
                try:
                    with patch("dgc.tools._browser_session", return_value=FakeBrowser(png(20, 20))):
                        out = execute("browser", {"operation": "screenshot"}, agent.ctx)
                    self.assertEqual("The user can see the screenshot in the chat." in out, shown, out)
                    tools.take_pending_images(agent.ctx.tool_owner, "")
                finally:
                    agent.mcp.stop_all()

    def test_workspace_images_are_labelled_as_data(self):
        from dgc.agent import _IMAGE_BATCH_TEXT
        self.assertIn("not instructions", _IMAGE_BATCH_TEXT["view_image"])


class SubAgentAndMcpTests(unittest.TestCase):
    def test_buffered_child_replays_tool_images_after_its_tool_result(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-child-") as directory:
            root_dir = Path(directory)
            (root_dir / "shot.png").write_bytes(png(40, 30))
            parent_ui = RecordingUI()
            root = make_agent(root_dir, ui=parent_ui, mode="auto")
            root.session_file = sessions.new_path(root_dir)
            try:
                sub_ui = _SubUI(parent_ui, "look", buffered=True)
                with patch.object(Agent, "_new_client", lambda self, *a, **k: fake_client(True)):
                    child = Agent(root.config, sub_ui, mcp=root.mcp)
                child._parent_agent, child._parent_call_id, child.depth = root, "task-1", 1
                child._image_batch_open = True
                child._handle_call(ToolCall("call_0", "view_image", {"path": "shot.png"}))
                trace = ("tool_call", "tool_result", "tool_images")
                self.assertEqual([c for c in parent_ui.calls if c[0] in trace], [],
                                 "buffered until the child finishes")
                self.assertEqual(sub_ui.replay(), [])
                names = [call[0] for call in parent_ui.calls if call[0] in ("tool_call", "tool_result", "tool_images")]
                self.assertEqual(names, ["tool_call", "tool_result", "tool_images"])
                live_id = parent_ui.named("tool_images")[0][1][0]
                self.assertRegex(live_id, r"^sub-[0-9a-f]{12}:call_0$")
                self.assertEqual(parent_ui.named("tool_result")[0][1][2], live_id)
                self.assertEqual(len(child._turn_images), 1, "the child's model sees it")
                self.assertEqual([r.call_id for r in root.image_views], ["task-1"], "under the task call")
                self.assertEqual(root.image_views[0].live_call_id, live_id)
            finally:
                root.mcp.stop_all()

    def test_editor_initiated_mcp_image_is_display_only(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-mcp-") as directory:
            ui = RecordingUI()
            agent = make_agent(Path(directory), ui=ui, mode="auto")
            try:
                def call(target, arguments, cancel=None, *, on_progress=None, on_log=None,
                         input_handler=None, on_image=None):
                    seen = on_image("image/png", png(8, 8), name="srv-chart-1.png")
                    return f"chart ready (model sees it: {seen})"
                agent.mcp.call = call
                out = agent.execute_mcp_tool("mcp__srv__chart", {}, "editor-1")
                self.assertIn("model sees it: shown in the chat only", out, "an idle editor call is display-only")
                images = ui.named("tool_images")
                self.assertEqual(len(images), 1)
                self.assertEqual(images[0][1][0], "editor-1")
                self.assertEqual(agent._turn_images, [])
            finally:
                agent.mcp.stop_all()

    def test_mcp_manager_hands_images_to_on_image(self):
        from dgc import mcp as mcp_mod
        manager = mcp_mod.MCPManager(Path(tempfile.gettempdir()))
        server = object.__new__(mcp_mod.MCPServer)
        server.name = "srv"
        manager.servers["srv"] = server
        manager._routes["mcp__srv__shots"] = ("srv", "shots")
        good = base64.b64encode(png(16, 9)).decode()
        blocks = ([{"type": "image", "mimeType": "image/png", "data": good}] * 9
                  + [{"type": "image", "mimeType": "image/jpeg", "data": good},
                     {"type": "image", "mimeType": "image/png", "data": "not base64!!"},
                     {"type": "text", "text": "done"}])
        for vision in (True, False):
            received = []
            def on_image(mime, data, *, name=""):  # noqa: E306
                received.append((mime, data, name))
                if data is None or sum(1 for r in received if r[1] is not None) > 8:
                    return None
                return vision
            with patch("dgc.mcp_context.request_complete", return_value={"content": blocks}):
                out = manager.call("mcp__srv__shots", {}, on_image=on_image)
            kept = [r for r in received if r[1] is not None]
            self.assertEqual(len(kept), 9)
            self.assertEqual(kept[0][2], "srv-shots-1.png")
            refused = [r for r in received if r[1] is None]
            self.assertEqual([r[0] for r in refused], ["image/jpeg", "image/png"])
            self.assertIn("not shown: the data is not image/jpeg", out)
            self.assertIn("not shown: not valid base64", out)
            self.assertEqual(out.count("not kept: DGC keeps up to 8 images per step"), 1)
            if vision:
                self.assertIn("16×9 · 1 KB — attached after this batch", out)
            else:
                self.assertIn("this model cannot read images; the user can see it in the chat", out)
            self.assertIn("done", out)
        manager.servers.clear()                  # the stub server was never started

    def test_agent_sink_caps_images_per_step(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-cap-") as directory:
            ui = RecordingUI()
            agent = make_agent(Path(directory), ui=ui, mode="auto")
            agent.session_file = sessions.new_path(Path(directory))
            try:
                def call(target, arguments, cancel=None, *, on_image=None, **kwargs):
                    for n in range(10):
                        on_image("image/png", png(10 + n, 10), name=f"srv-t-{n}.png")
                    on_image("image/png", None, name="bad.png")
                    return "ten charts"
                agent.mcp.call = call
                agent.execute_mcp_tool("mcp__srv__t", {}, "c9")
                _, args, kwargs = ui.named("tool_images")[0]
                self.assertEqual(len(args[1]), 8)
                self.assertEqual(kwargs["omitted"], 3)
                self.assertEqual(len(kwargs["items"]), 8)
                self.assertEqual({item["source"] for item in kwargs["items"]}, {"mcp"})
            finally:
                agent.mcp.stop_all()


# ---- headless frames ----------------------------------------------------------------------------------
class HeadlessFrameTests(unittest.TestCase):
    def frames(self, *args, **kwargs):
        stream = io.StringIO()
        ui = HeadlessUI(Emitter(stream, validator=ep.event_error), PendingRequests(), approval_timeout_s=1)
        ui.tool_images(*args, **kwargs)
        lines = [line for line in stream.getvalue().splitlines() if line]
        for line in lines:
            self.assertLessEqual(len(line.encode("utf-8")), ep.MAX_EVENT_BYTES)
            self.assertIsNone(ep.event_error(json.loads(line)))
        return [json.loads(line) for line in lines]

    def test_single_over_budget_image_is_an_empty_frame(self):
        huge = "data:image/png;base64," + "A" * (4 * 1024 * 1024)
        frames = self.frames("call_7", [huge], "browser screenshot")
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["call_id"], "call_7")
        self.assertEqual(frames[0]["images"], [])

    def test_stored_over_budget_image_is_an_empty_slot_with_its_item(self):
        huge = "data:image/png;base64," + "A" * (4 * 1024 * 1024)
        small = uri_of(png(2, 2))
        item = {"ref": "img_" + "a" * 32, "name": "big.png", "mime": "image/png", "width": 9000,
                "height": 9000, "bytes": 3_000_000, "source": "view_image", "host": ""}
        frames = self.frames("c1", [small, huge], "viewed image",
                             items=[{**item, "name": "small.png"}, item], omitted=2)
        self.assertEqual(sum(len(f["images"]) for f in frames), 2)
        for frame in frames:
            self.assertEqual(len(frame["images"]), len(frame["items"]))
        slots = [(image, it["name"]) for f in frames for image, it in zip(f["images"], f["items"])]
        self.assertEqual(slots, [(small, "small.png"), ("", "big.png")])
        self.assertEqual(sum(f.get("omitted", 0) for f in frames), 2)

    def test_budget_counts_items(self):
        image = "data:image/png;base64," + "B" * 1_700_000
        items = [{"ref": "img_" + "b" * 32, "name": "n" * 300_000, "mime": "image/png", "width": 1,
                  "height": 1, "bytes": 1, "source": "browser", "host": ""}] * 2
        stream = io.StringIO()
        emitted = []
        ui = HeadlessUI.__new__(HeadlessUI)
        ui.em = types.SimpleNamespace(emit=lambda kind, **fields: emitted.append(fields))
        HeadlessUI.tool_images(ui, "c1", [image, image], "x", items=items)
        self.assertEqual(len(emitted), 2, "without the items the two images would share one frame")
        HeadlessUI.tool_images(ui, "c2", [image, image], "x")
        self.assertEqual(len(emitted), 3)


# ---- image_views -----------------------------------------------------------------------------------
class DimensionsAndSniffTests(unittest.TestCase):
    def test_dimensions(self):
        self.assertEqual(image_views.dimensions(png(1280, 757)), (1280, 757))
        self.assertEqual(image_views.dimensions(jpeg(640, 480)), (640, 480))
        self.assertEqual(image_views.dimensions(jpeg(801, 601, progressive=True)), (801, 601))
        self.assertEqual(image_views.dimensions(gif(31, 17)), (31, 17))
        self.assertEqual(image_views.dimensions(webp("VP8X", 1920, 1080)), (1920, 1080))
        self.assertEqual(image_views.dimensions(webp("VP8L", 400, 300)), (400, 300))
        self.assertEqual(image_views.dimensions(webp("VP8 ", 320, 240)), (320, 240))
        self.assertEqual(image_views.dimensions(bmp(50, 60)), (50, 60))
        self.assertEqual(image_views.dimensions(png(1280, 757)[:12]), (0, 0), "truncated")
        from dgc import llm
        self.assertIs(llm._image_dimensions, image_views.parse_dimensions, "one parser")

    def test_sniff(self):
        self.assertEqual(image_views.sniff(png()), "image/png")
        self.assertEqual(image_views.sniff(jpeg(1, 1)), "image/jpeg")
        self.assertEqual(image_views.sniff(gif(1, 1)), "image/gif")
        self.assertEqual(image_views.sniff(webp("VP8X", 1, 1)), "image/webp")
        self.assertEqual(image_views.sniff(bmp(1, 1)), "image/bmp")
        self.assertIsNone(image_views.sniff(b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
        self.assertIsNone(image_views.sniff(b"BMW service notes, 2026"))

    def test_names_and_hosts(self):
        self.assertEqual(image_views.safe_name("https://user:pw@host/x.png"), "image.png")
        self.assertEqual(image_views.safe_name("../a/b\x07c.png"), "bc.png")
        self.assertEqual(image_views.safe_host("https://user:pw@VibeDGC.com:8443/p?q=1"), "vibedgc.com")
        self.assertEqual(image_views.safe_host("not a host"), "")
        self.assertEqual(image_views.human_size(310 * 1024), "310 KB")
        self.assertEqual(image_views.human_size(int(2.4 * 1024 * 1024)), "2.4 MB")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-image-store-")
        self.session = Path(self.tmp.name) / "20260915-000000-abcd0001.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_store_and_resolve(self):
        data = png(3, 4)
        record = image_views.store(self.session, data, name="a.png", source="view_image")
        again = image_views.store(self.session, data, name="b.png", source="view_image")
        self.assertEqual(record.ref, again.ref)
        self.assertEqual(record.ref, "img_" + hashlib.sha256(data).hexdigest()[:32])
        directory = image_views.store_dir(self.session)
        self.assertEqual(directory.name, "20260915-000000-abcd0001.images")
        self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)
        self.assertEqual(len(list(directory.iterdir())), 1, "identical bytes are one file")
        got, reason, path = image_views.resolve(self.session, record)
        self.assertEqual((got, reason), (data, ""))
        self.assertEqual(Path(path).parent, directory.resolve())

        Path(path).write_bytes(png(9, 9))
        self.assertEqual(image_views.resolve(self.session, record)[1], "changed")
        Path(path).unlink()
        self.assertEqual(image_views.resolve(self.session, record)[:2], (None, "not_found"))

    def test_refusals(self):
        with self.assertRaises(ValueError):
            image_views.store(self.session, b"<svg/>", name="x.svg", source="view_image")
        with self.assertRaises(ValueError):
            image_views.store(self.session, png(extra=b"\0" * image_views.MAX_VIEW_BYTES), name="x", source="mcp")
        record = image_views.store(self.session, png(5, 5), name="x.png", source="mcp")
        target = image_views.store_dir(self.session) / f"{record.ref[4:]}.png"
        outside = Path(self.tmp.name) / "outside.png"
        outside.write_bytes(png(5, 5))
        target.unlink()
        target.symlink_to(outside)
        self.assertEqual(image_views.resolve(self.session, record)[:2], (None, "unreadable"), "symlink")
        target.unlink()
        big = png(5, 5, extra=b"\0" * (image_views.MAX_VIEW_BYTES + 1))
        target.write_bytes(big)
        self.assertEqual(image_views.resolve(self.session, record)[1], "too_large")
        forged = image_views.ImageRecord(ref="img_" + "0" * 32, name="x", mime="image/png")
        self.assertEqual(image_views.resolve(self.session, forged)[1], "not_found")

    def test_prune_keeps_indexed_refs(self):
        kept = image_views.store(self.session, png(1, 1, extra=b"k" * 4000), name="k", source="mcp")
        old = image_views.store(self.session, png(2, 2, extra=b"o" * 4000), name="o", source="mcp")
        os.utime(image_views.store_dir(self.session) / f"{kept.ref[4:]}.png", (1, 1))
        removed = image_views.prune(self.session, {kept.ref}, budget=5000)
        self.assertEqual(removed, {old.ref})
        self.assertEqual(image_views.resolve(self.session, kept)[1], "")

    def test_copy_and_remove_store(self):
        record = image_views.store(self.session, png(6, 6), name="x.png", source="browser")
        fork = self.session.with_name("fork.json")
        self.assertEqual(image_views.copy_store(self.session, fork), 1)
        self.assertEqual(image_views.resolve(fork, record)[1], "")
        image_views.remove_store(self.session)
        self.assertFalse(image_views.store_dir(self.session).exists())

    def test_index_validation(self):
        good = image_views.store(self.session, png(), name="x.png", source="browser",
                                 host="https://a:b@example.com/x", call_id="c1", anchor=4).to_record()
        self.assertEqual(good["host"], "example.com")
        rows = image_views.load_index([good, {**good, "ref": "img_nope"}, {**good, "mime": "image/svg+xml"},
                                       {**good, "source": "web"}, "junk"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].to_item(), {"ref": good["ref"], "name": "x.png", "mime": "image/png",
                                             "width": 1280, "height": 757, "bytes": len(png()),
                                             "source": "browser", "host": "example.com"})


class LifecycleTests(unittest.TestCase):
    def test_delete_fork_new_and_rewind(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-life-") as directory:
            root = Path(directory)
            (root / "logo.png").write_bytes(png(64, 64))
            ui = RecordingUI()
            agent = make_agent(root, ui=ui, mode="auto")
            try:
                agent.session_file = sessions.new_path(root)
                agent.messages.append({"role": "user", "content": "look at logo.png"})
                agent._handle_call(ToolCall("call_1", "view_image", {"path": "logo.png"}))
                self.assertEqual(len(agent.image_views), 1)
                record = agent.image_views[0]
                self.assertEqual(record.anchor, 2)
                self.assertTrue(agent._persist())
                saved = sessions.load_record(agent.session_file, agent.session_root)
                self.assertEqual(saved["images"][0]["ref"], record.ref)
                original = agent.session_file

                self.assertTrue(agent.fork_session("branch"))
                self.assertNotEqual(agent.session_file, original)
                self.assertEqual(image_views.resolve(agent.session_file, record)[1], "", "fork copies")

                loaded = make_agent(root)
                try:
                    loaded.load_session(original)
                    self.assertEqual([r.ref for r in loaded.image_views], [record.ref])
                finally:
                    loaded.mcp.stop_all()

                agent.messages = agent.messages[:1]
                agent.checkpoints.rewind_state = lambda idx, transactional=True: (1, 0, None)
                agent.checkpoints.commit_rewind = lambda: None
                agent.checkpoints.rollback_rewind = lambda: None
                agent.messages.extend([{"role": "user", "content": "x"}] * 3)
                self.assertEqual(agent.rewind(0)[0], 1)
                self.assertEqual(agent.image_views, [], "rewind drops images past the kept messages")

                agent.image_views = [record]
                agent.reset()
                self.assertEqual(agent.image_views, [], "a new session has viewed nothing")

                self.assertTrue(sessions.delete(original, root))
                self.assertFalse(image_views.store_dir(original).exists(), "delete removes the store")
                self.assertEqual(sessions._session_family(image_views.store_dir(original)), original.resolve())
                self.assertEqual(sessions._session_family(image_views.store_dir(original) / "a.png"),
                                 original.resolve())
            finally:
                agent.mcp.stop_all()

    def test_save_redacts_names(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-redact-") as directory:
            root = Path(directory)
            path = sessions.new_path(root)
            record = image_views.ImageRecord(ref="img_" + "c" * 32, name="token-sk-live-hunter2-0123456789abcdef.png",
                                             mime="image/png", source="view_image", call_id="c1")
            self.assertTrue(sessions.save(path, [{"role": "user", "content": "hi"}], root,
                                          images=[record.to_record()],
                                          redact_secrets=("sk-live-hunter2-0123456789abcdef",)))
            loaded = image_views.load_index(sessions.load_record(path, root)["images"])
            self.assertEqual(len(loaded), 1)
            self.assertNotIn("hunter2", loaded[0].name)
            self.assertEqual(loaded[0].ref, record.ref)


# ---- view_image, read_file and permissions ------------------------------------------------------------
class ViewImageToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-view-image-")
        self.root = Path(self.tmp.name).resolve() / "project"
        self.root.mkdir()
        self.ctx = types.SimpleNamespace(project_root=self.root, config=fixture_config(self.root),
                                         vision=True, tool_owner="view-image-test")

    def tearDown(self):
        tools.take_pending_images("view-image-test", "")
        self.tmp.cleanup()

    def test_results_and_errors(self):
        (self.root / "logo.png").write_bytes(png(1280, 757))
        out = execute("view_image", {"path": "logo.png"}, self.ctx)
        size = image_views.human_size(len(png(1280, 757)))
        self.assertEqual(out, f"viewed logo.png (image/png, 1280×757, {size}). "
                              "The image follows this batch, so you can look at it directly.")
        queued = tools.take_pending_images("view-image-test", "")
        self.assertEqual([(q["name"], q["source"], q["width"]) for q in queued], [("logo.png", "view_image", 1280)])

        missing = self.root / "nope.png"
        self.assertEqual(execute("view_image", {"path": "nope.png"}, self.ctx), f"error: no such file: {missing}")
        (self.root / "notes.txt").write_text("hello")
        self.assertEqual(execute("view_image", {"path": "notes.txt"}, self.ctx),
                         f"error: {self.root / 'notes.txt'} is not an image DGC can show (PNG, JPEG, GIF, WebP or BMP)")
        (self.root / "huge.png").write_bytes(png(extra=b"\0" * image_views.MAX_VIEW_BYTES))
        self.assertEqual(execute("view_image", {"path": "huge.png"}, self.ctx),
                         f"error: {self.root / 'huge.png'} is 8.0 MB; view_image reads images up to 8 MB")
        outside = Path(self.tmp.name) / "secret.png"
        outside.write_bytes(png())
        self.assertRegex(execute("view_image", {"path": str(outside)}, self.ctx),
                         r"^error: path is outside the project: ")
        self.ctx.vision = lambda: False
        self.assertIn("does not accept images", execute("view_image", {"path": "logo.png"}, self.ctx))
        self.assertEqual(len(tools.take_pending_images("view-image-test", "")), 1,
                         "the chat still gets the chip when the model cannot see")

    def test_read_file_views_an_image_when_the_model_can_see(self):
        data = png(64, 48)
        (self.root / "logo.png").write_bytes(data)
        size = image_views.human_size(len(data))
        self.assertEqual(execute("read_file", {"path": "logo.png"}, self.ctx),
                         f"viewed logo.png (image/png, 64×48, {size}). "
                         "The image follows this batch, so you can look at it directly.")
        queued = tools.take_pending_images("view-image-test", "")
        self.assertEqual([(q["name"], q["source"], q["width"], q["height"]) for q in queued],
                         [("logo.png", "read_file", 64, 48)], "queued exactly as view_image queues it")
        (self.root / "icon.bmp").write_bytes(bmp(16, 16))
        self.assertIn("BMP cannot be sent to the model", execute("read_file", {"path": "icon.bmp"}, self.ctx))
        self.assertEqual([q["source"] for q in tools.take_pending_images("view-image-test", "")], ["read_file"])
        (self.root / "huge.png").write_bytes(png(extra=b"\0" * image_views.MAX_VIEW_BYTES))
        self.assertEqual(execute("read_file", {"path": "huge.png"}, self.ctx),
                         f"error: {self.root / 'huge.png'} is an image of 8.0 MB; images up to 8 MB can be viewed")
        self.assertEqual(tools.take_pending_images("view-image-test", ""), [])
        self.ctx.vision = False
        self.assertIn("cannot read images", execute("read_file", {"path": "logo.png"}, self.ctx))
        self.assertEqual(len(tools.take_pending_images("view-image-test", "")), 1,
                         "the chat still gets the chip when the model cannot see")
        (self.root / "bmw.txt").write_text("BMW service notes " * 4)
        self.assertIn("BMW service notes", execute("read_file", {"path": "bmw.txt"}, self.ctx))
        self.assertEqual(tools.take_pending_images("view-image-test", ""), [], "a text file is not queued as an image")

    def test_offered_only_with_vision_and_intent(self):
        # Vision is the hard gate on every profile. The wording gate is the adaptive profile's
        # alone: the shipped default offers view_image to any vision model, asked or not.
        (self.root / "logo.png").write_bytes(png())
        agent = make_agent(self.root, vision=True, tool_profile="adaptive")
        text_only = make_agent(self.root, vision=False, tool_profile="adaptive")
        default = make_agent(self.root, vision=True)
        default_text_only = make_agent(self.root, vision=False)
        try:
            names = lambda a: {t["function"]["name"] for t in a._tool_schemas()}
            self.assertNotIn("view_image", names(agent))
            agent._activate_tool_intents("what does logo.png look like?", replace=True)
            self.assertIn("view_image", names(agent))
            text_only._activate_tool_intents("what does logo.png look like?", replace=True)
            self.assertNotIn("view_image", names(text_only))
            agent._activate_tool_intents("fix the failing test and figure out why", replace=True)
            self.assertNotIn("view_image", names(agent))

            default._activate_tool_intents("fix the failing test and figure out why", replace=True)
            self.assertIn("view_image", names(default), "the default profile needs no magic words")
            default_text_only._activate_tool_intents("what does logo.png look like?", replace=True)
            self.assertNotIn("view_image", names(default_text_only), "no vision, no view_image")

            agent._activate_tool_intents("fix the header", replace=True)
            agent._handle_call(ToolCall("r1", "read_file", {"path": "logo.png"}))
            self.assertIn("image", agent._active_tool_intents)
            self.assertIn("view_image", names(agent), "an image read turns view_image on for the turn")
        finally:
            for made in (agent, text_only, default, default_text_only):
                made.mcp.stop_all()

    def test_parallel_reads_attribute_each_image(self):
        (self.root / "a.png").write_bytes(png(10, 10))
        (self.root / "b.png").write_bytes(png(20, 20))
        ui = RecordingUI()
        agent = make_agent(self.root, ui=ui)
        agent.session_file = sessions.new_path(self.root)
        try:
            agent._image_batch_open = True
            outputs = agent._parallel_read_outputs([
                ToolCall("call_a", "view_image", {"path": "a.png"}),
                ToolCall("call_b", "view_image", {"path": "b.png"})])
            self.assertEqual(len(outputs), 2)
            shown = {args[0]: kwargs["meta"][0]["name"] for _, args, kwargs in ui.named("tool_images")}
            self.assertEqual(shown, {"call_a": "a.png", "call_b": "b.png"})
            self.assertEqual({r.call_id: r.name for r in agent.image_views}, {"call_a": "a.png", "call_b": "b.png"})
            owner = agent.ctx.tool_owner
            self.assertFalse([key for key in tools._PENDING_IMAGES if key[0] == owner], "nothing left pending")
            self.assertEqual(len(agent._turn_images), 2)
        finally:
            agent.mcp.stop_all()


class PermissionTests(unittest.TestCase):
    def test_read_rules_cover_view_image(self):
        self.assertEqual(Rule.parse("Read(secret/**)", "deny").tool, "read_file")
        self.assertEqual(DISPLAY_TO_TOOL["read"], "read_file")
        self.assertEqual(Rule.parse("ViewImage(*.png)", "allow").tool, "view_image")
        self.assertEqual(len(set(DISPLAY.values())), len(DISPLAY))
        with tempfile.TemporaryDirectory() as directory:
            engine = PermissionEngine("auto", {"allow": [], "ask": [], "deny": ["Read(secret/**)"]}, Path(directory))
            self.assertEqual(engine.decide("view_image", {"path": "secret/x.png"})[0], "deny")
            self.assertEqual(engine.decide("view_image", {"path": "public/x.png"})[0], "allow")
            plan = PermissionEngine("plan", {"allow": [], "ask": [], "deny": []}, Path(directory))
            self.assertEqual(plan.decide("view_image", {"path": "x.png"})[0], "allow", "read-only in plan mode")
            ask = PermissionEngine("default", {"allow": [], "ask": [], "deny": ["ViewImage(*.png)"]}, Path(directory))
            self.assertEqual(ask.decide("view_image", {"path": "x.png"})[0], "deny")


# ---- get_image -----------------------------------------------------------------------------------------
class GetImageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-get-image-")
        self.session = Path(self.tmp.name) / "20260915-000000-abcd0002.json"
        self.stream = io.StringIO()
        self.lock = threading.Lock()
        backend = object.__new__(Backend)
        backend.em = Emitter(self.stream, validator=ep.event_error)
        backend.config = fixture_config(Path(self.tmp.name))
        backend.pending = PendingRequests()
        backend._queue = []
        backend.agent = types.SimpleNamespace(session_file=self.session, image_views=[],
                                              cancelled=threading.Event(), monitors=None)
        backend._busy = lambda: True             # accepted while a turn runs
        self.backend = backend

    def tearDown(self):
        pool = self.backend.__dict__.get("_image_pool")
        if pool is not None:
            pool.shutdown(wait=True)
        self.tmp.cleanup()

    def events(self, kind="image", wait_for=0, timeout=10.0):
        deadline = time.monotonic() + timeout
        while True:
            frames = [json.loads(line) for line in self.stream.getvalue().splitlines() if line]
            found = [f for f in frames if f["type"] == kind]
            if len(found) >= wait_for or time.monotonic() > deadline:
                for frame in frames:
                    self.assertIsNone(ep.event_error(frame), frame)
                return found
            time.sleep(0.01)

    def add(self, data, name="x.png", source="view_image"):
        record = image_views.store(self.session, data, name=name, source=source)
        self.backend.agent.image_views.append(record)
        return record

    def test_answers(self):
        record = self.add(png(12, 34))
        self.backend.dispatch({"type": "get_image", "request_id": "r1", "ref": record.ref})
        self.backend.dispatch({"type": "get_image", "request_id": "r2", "ref": "../../etc/passwd"})
        self.backend.dispatch({"type": "get_image", "request_id": "r3", "ref": "img_" + "f" * 32})
        answers = {e["request_id"]: e for e in self.events(wait_for=3)}
        self.assertEqual(answers["r1"]["image"], uri_of(png(12, 34)))
        self.assertEqual((answers["r1"]["width"], answers["r1"]["height"], answers["r1"]["mime"]), (12, 34, "image/png"))
        self.assertTrue(answers["r1"]["path"].endswith(f"{record.ref[4:]}.png"))
        self.assertEqual((answers["r2"]["image"], answers["r2"]["reason"]), ("", "invalid_ref"))
        self.assertEqual(answers["r3"]["reason"], "not_found")
        self.assertNotIn("path", answers["r3"])
        self.backend.dispatch({"type": "get_image", "request_id": "", "ref": record.ref})
        self.assertEqual(self.events("command_rejected", wait_for=1)[0]["reason"], "invalid_request_id")

    def test_too_large_and_previous_session(self):
        big = self.add(png(4000, 4000, extra=os.urandom(3 * 1024 * 1024)))
        self.backend.dispatch({"type": "get_image", "request_id": "big", "ref": big.ref})
        answer = self.events(wait_for=1)[0]
        self.assertEqual((answer["image"], answer["reason"]), ("", "too_large"))
        self.assertTrue(answer["path"], "Open file still works")
        self.backend.agent.image_views = []      # a new session: its index is empty
        self.backend.dispatch({"type": "get_image", "request_id": "old", "ref": big.ref})
        self.assertEqual(self.events(wait_for=2)[1]["reason"], "not_found")

    def test_worker_exception_is_unreadable_without_text(self):
        record = self.add(png(1, 1))
        with patch("dgc.image_views.resolve", side_effect=RuntimeError("/secret/path exploded")):
            self.backend.dispatch({"type": "get_image", "request_id": "boom", "ref": record.ref})
            answer = self.events(wait_for=1)[0]
        self.assertEqual(answer["reason"], "unreadable")
        self.assertNotIn("secret", json.dumps(answer))

    def test_pool_is_bounded_and_the_reader_stays_free(self):
        record = self.add(png(1, 1))
        release = threading.Event()
        def slow(session_file, rec):
            release.wait(2.0)
            return png(1, 1), "", "/tmp/x.png"
        with patch("dgc.image_views.resolve", side_effect=slow):
            for n in range(16):
                self.backend.dispatch({"type": "get_image", "request_id": f"q{n}", "ref": record.ref})
            self.backend.dispatch({"type": "get_image", "request_id": "q16", "ref": record.ref})
            busy = self.events(wait_for=1, timeout=1.0)
            self.assertEqual([(e["request_id"], e["reason"]) for e in busy], [("q16", "busy")])
            started = time.monotonic()
            self.backend.dispatch({"type": "cancel"})
            self.assertTrue(self.backend.agent.cancelled.is_set())
            self.assertLess(time.monotonic() - started, 1.0 + RUNNER_SLACK,
                        "cancel is handled before the reads finish")
            release.set()
            done = self.events(wait_for=17, timeout=15)
        self.assertEqual(len(done), 17)

    def test_contract(self):
        self.assertIn("get_image", _WAKE_NEUTRAL_COMMANDS)
        self.assertNotIn("get_image", _BUSY_MUTATIONS)
        self.assertIsNone(ep.command_error({"type": "get_image", "request_id": "r", "ref": "img_x"}))
        self.assertIsNotNone(ep.command_error({"type": "get_image", "request_id": "r"}))


# ---- history --------------------------------------------------------------------------------------------
class HistoryTests(unittest.TestCase):
    def backend_for(self, messages, records):
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(messages=messages, image_views=records)
        return backend

    def record(self, call_id, anchor, name="x.png"):
        return image_views.ImageRecord(ref="img_" + hashlib.sha256(name.encode()).hexdigest()[:32],
                                       name=name, mime="image/png", width=10, height=10, bytes=100,
                                       source="view_image", call_id=call_id, anchor=anchor)

    def assert_valid(self, items):
        for item in items:
            if isinstance(item.get("type"), str):
                self.assertIsNone(ep.event_error({**item, "seq": 0}), item)

    def test_native_session_replays_after_the_tool_result(self):
        messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "look at logo.png"},
                    {"role": "assistant", "content": "", "tool_calls": [
                        {"id": "call_1", "type": "function", "function": {"name": "view_image", "arguments": "{\"path\":\"logo.png\"}"}}]},
                    {"role": "tool", "tool_call_id": "call_1", "content": "viewed logo.png"},
                    {"role": "assistant", "content": "It is a peach."}]
        items = Backend._history(self.backend_for(messages, [self.record("call_1", 3)]))
        self.assert_valid(items)
        kinds = [item.get("type") for item in items]
        at = kinds.index("tool_images")
        self.assertEqual(kinds[at - 1], "tool_result")
        self.assertEqual(items[at]["call_id"], "call_1")
        self.assertEqual(items[at]["images"], [""])
        self.assertEqual(items[at]["items"][0]["name"], "x.png")

    def test_text_protocol_session_places_an_orphan_inside_its_turn(self):
        messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "look"},
                    {"role": "assistant", "content": "```tool\n{\"name\":\"view_image\"}\n```"},
                    {"role": "user", "content": "<tool_results>\n<result tool=\"view_image\">viewed</result>\n</tool_results>"},
                    {"role": "assistant", "content": "A peach."},
                    {"role": "user", "content": "next"}, {"role": "assistant", "content": "ok"}]
        items = Backend._history(self.backend_for(messages, [self.record("text-call-1", 3)]))
        self.assert_valid(items)
        kinds = [item.get("type") for item in items]
        at = kinds.index("tool_images")
        self.assertIsNone(items[at]["call_id"])
        first_end = kinds.index("turn_end")
        self.assertLess(kinds.index("turn_start"), at)
        self.assertLess(at, first_end, "inside the first turn, not the next one")

    def test_sub_agent_images_sit_under_the_task_call(self):
        messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "delegate"},
                    {"role": "assistant", "content": "", "tool_calls": [
                        {"id": "task_1", "type": "function", "function": {"name": "task", "arguments": "{}"}}]},
                    {"role": "tool", "tool_call_id": "task_1", "content": "the child looked"}]
        items = Backend._history(self.backend_for(messages, [self.record("task_1", 3, "a.png"),
                                                             self.record("task_1", 3, "b.png")]))
        images = [item for item in items if item.get("type") == "tool_images"]
        self.assertEqual(len(images), 1)
        self.assertEqual([it["name"] for it in images[0]["items"]], ["a.png", "b.png"])

    def test_order_survives_the_trim(self):
        messages = [{"role": "system", "content": "s"}]
        for n in range(30):
            messages += [{"role": "user", "content": f"prompt {n} " + "x" * 45_000},
                         {"role": "assistant", "content": "y" * 45_000}]
        messages += [{"role": "user", "content": "look"},
                     {"role": "assistant", "content": "", "tool_calls": [
                         {"id": "call_9", "type": "function", "function": {"name": "view_image", "arguments": "{}"}}]},
                     {"role": "tool", "tool_call_id": "call_9", "content": "viewed"}]
        items = Backend._history(self.backend_for(messages, [self.record("call_9", len(messages) - 1)]))
        self.assertEqual(items[0].get("role"), "notice", "the payload was trimmed")
        kinds = [item.get("type") for item in items]
        self.assertEqual(kinds[kinds.index("tool_images") - 1], "tool_result")
        self.assert_valid(items)

    def test_leftover_records_close_the_last_turn(self):
        messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "hello"}]
        items = Backend._history(self.backend_for(messages, [self.record("editor-mcp", 99)]))
        kinds = [item.get("type") for item in items]
        self.assertEqual(kinds[-2:], ["tool_images", "turn_end"])
        self.assert_valid(items)


class CompactionAnchorTests(unittest.TestCase):
    """Compaction rewrites the transcript: image records must stay on the messages they belong to."""

    def build(self, root: Path):
        for name, size in (("a.png", 11), ("b.png", 12), ("c.png", 13), ("d.png", 14)):
            (root / name).write_bytes(png(size, size))
        agent = make_agent(root, mode="auto", compact_threshold=0.0)
        agent.session_file = sessions.new_path(root)
        m = agent.messages

        def native(call_id, path, answer):
            m.append({"role": "assistant", "content": "", "tool_calls": [{"id": call_id, "type": "function",
                      "function": {"name": "view_image", "arguments": json.dumps({"path": path})}}]})
            out = agent._handle_call(ToolCall(call_id, "view_image", {"path": path}))
            m.append({"role": "tool", "tool_call_id": call_id, "content": out})
            m.append({"role": "assistant", "content": answer})

        def text_protocol(call_id, path, answer):
            m.append({"role": "assistant", "content": "```tool\n{\"name\":\"view_image\"}\n```"})
            agent._handle_call(ToolCall(call_id, "view_image", {"path": path}))
            m.append({"role": "user", "content": "<tool_results>\n<result tool=\"view_image\">viewed</result>\n</tool_results>"})
            m.append({"role": "assistant", "content": answer})

        m.append({"role": "user", "content": "look at a.png"})
        native("call_0", "a.png", "It is a.")                   # anchor 3, folded
        m.append({"role": "user", "content": "and c.png"})
        text_protocol("textcall_0", "c.png", "It is c.")        # anchor 7, folded
        m.append({"role": "user", "content": "look at b.png"})
        native("call_0", "b.png", "It is b.")                   # anchor 11, kept (a repeated fallback id)
        m.append({"role": "user", "content": "and d.png"})
        text_protocol("textcall_1", "d.png", "It is d.")        # anchor 15, kept
        self.assertEqual([r.anchor for r in agent.image_views], [3, 7, 11, 15])
        self.assertEqual(len(m), 17)
        return agent

    def compact(self, agent):
        with patch("dgc.agent.KEEP_RECENT", 6):
            self.assertTrue(agent.maybe_compact(deadline=time.monotonic(), notify=False))
        self.assertTrue(agent.messages[1]["content"].startswith("[Earlier conversation compacted"))

    def names(self, item):
        return [entry["name"] for entry in item["items"]]

    def test_history_places_kept_and_folded_images_after_a_compaction(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-compact-") as directory:
            agent = self.build(Path(directory))
            try:
                self.compact(agent)
                self.assertEqual(len(agent.messages), 10, "summary, ack and the kept tail of 7")
                by_name = {r.name: r for r in agent.image_views}
                self.assertEqual((by_name["a.png"].compacted, by_name["c.png"].compacted), (True, True))
                self.assertEqual((by_name["b.png"].anchor, by_name["d.png"].anchor), (4, 8))
                self.assertEqual((by_name["b.png"].origin, by_name["d.png"].origin), (11, 15))
                self.assertEqual(agent.messages[4].get("tool_call_id"), "call_0")

                backend = object.__new__(Backend)
                backend.agent = agent
                items = Backend._history(backend)
                for item in items:
                    if isinstance(item.get("type"), str):
                        self.assertIsNone(ep.event_error({**item, "seq": 0}), item)
                rows = [(i, item) for i, item in enumerate(items) if item.get("type") == "tool_images"]
                self.assertEqual([self.names(item) for _, item in rows], [["a.png", "c.png"], ["b.png"], ["d.png"]])
                marker = next(i for i, item in enumerate(items) if item.get("role") == "compaction")
                folded_at, folded = rows[0]
                self.assertIsNone(folded["call_id"])
                self.assertEqual(items[marker + 1], {"type": "turn_start", "turn_id": "h0", "prompt": "", "kind": "prompt"})
                self.assertEqual(items[folded_at + 1]["type"], "turn_end")
                kept_at, kept = rows[1]
                self.assertEqual((kept["call_id"], items[kept_at - 1]["type"]), ("call_0", "tool_result"))
                calls = [item for item in items if item.get("type") == "tool_result"]
                self.assertEqual(len(calls), 1, "the folded call_0 card is gone; its image does not borrow the kept one")
                last_start = max(i for i, item in enumerate(items) if item.get("type") == "turn_start")
                self.assertEqual(items[last_start]["prompt"], "and d.png")
                self.assertGreater(rows[2][0], last_start, "d.png replays in its own turn")

                # persisted and loaded back with the same placement
                loaded = make_agent(Path(directory))
                try:
                    loaded.load_session(agent.session_file)
                    self.assertEqual([(r.name, r.anchor, r.origin, r.compacted) for r in loaded.image_views],
                                     [(r.name, r.anchor, r.origin, r.compacted) for r in agent.image_views])
                    self.assertEqual(loaded._image_folded_now(), 7)
                finally:
                    loaded.mcp.stop_all()
            finally:
                agent.mcp.stop_all()

    def test_a_second_compaction_and_a_rollback(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-compact2-") as directory:
            agent = self.build(Path(directory))
            try:
                self.compact(agent)
                before = [(r.name, r.anchor, r.compacted) for r in agent.image_views]
                with patch.object(agent, "_persist", return_value=False), patch("dgc.agent.KEEP_RECENT", 2):
                    agent.maybe_compact(deadline=time.monotonic(), notify=False)
                self.assertEqual([(r.name, r.anchor, r.compacted) for r in agent.image_views], before,
                                 "a compaction that could not be saved leaves the index as it was")
                with patch("dgc.agent.KEEP_RECENT", 2):
                    self.assertTrue(agent.maybe_compact(deadline=time.monotonic(), notify=False))
                # The tail kept is d.png's <tool_results> and answer: its step's result is still there.
                self.assertEqual([r.compacted for r in agent.image_views], [True, True, True, False])
                self.assertEqual([r.anchor for r in agent.image_views], [3, 3, 3, 3])
                self.assertEqual([r.origin for r in agent.image_views], [3, 7, 11, 15])
                self.assertEqual(agent._image_folded_now(), 12)
                backend = object.__new__(Backend)
                backend.agent = agent
                rows = [item for item in Backend._history(backend) if item.get("type") == "tool_images"]
                self.assertEqual([self.names(row) for row in rows], [["a.png", "c.png", "b.png"], ["d.png"]])
            finally:
                agent.mcp.stop_all()

    def test_rewind_after_a_compaction_keeps_the_kept_tail(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-compact-rewind-") as directory:
            agent = self.build(Path(directory))
            try:
                original = copy.deepcopy(agent.messages)
                self.compact(agent)
                agent.checkpoints.commit_rewind = lambda: None
                agent.checkpoints.rollback_rewind = lambda: None
                agent.checkpoints.rewind_state = lambda idx, transactional=True: (6, 0, None)
                self.assertEqual(agent.rewind(0)[0], 6)
                self.assertEqual([r.name for r in agent.image_views], ["a.png", "c.png", "b.png"],
                                 "the folded images and b.png (before the cut) stay; d.png goes")
                self.assertEqual(image_views.resolve(agent.session_file, agent.image_views[2])[1], "")

                # A turn from before the compaction restores the never-compacted transcript.
                agent2 = self.build(Path(directory))
                try:
                    original = copy.deepcopy(agent2.messages)
                    self.compact(agent2)
                    agent2.checkpoints.commit_rewind = lambda: None
                    agent2.checkpoints.rollback_rewind = lambda: None
                    agent2.checkpoints.rewind_state = lambda idx, transactional=True: (9, 0, original[1:9])
                    self.assertEqual(agent2.rewind(0)[0], 9)
                    self.assertEqual([(r.name, r.anchor, r.compacted) for r in agent2.image_views],
                                     [("a.png", 3, False), ("c.png", 7, False)])
                    self.assertEqual(agent2._image_folded_now(), 0)
                    backend = object.__new__(Backend)
                    backend.agent = agent2
                    items = Backend._history(backend)
                    rows = [item for item in items if item.get("type") == "tool_images"]
                    self.assertEqual([(row["call_id"], self.names(row)) for row in rows],
                                     [("call_0", ["a.png"]), (None, ["c.png"])])
                finally:
                    agent2.mcp.stop_all()
            finally:
                agent.mcp.stop_all()


class HistoryScaleTests(unittest.TestCase):
    def test_replay_stays_linear_with_a_full_index(self):
        messages = [{"role": "system", "content": "s"}]
        records = []
        for n in range(1200):
            call = f"call_{n}"
            messages += [{"role": "user", "content": f"p{n}"},
                         {"role": "assistant", "content": "", "tool_calls": [
                             {"id": call, "type": "function", "function": {"name": "view_image", "arguments": "{}"}}]}]
            if n >= 1200 - 256:
                records += [image_views.ImageRecord(ref="img_" + hashlib.sha256(f"{n}{k}".encode()).hexdigest()[:32],
                                                    name=f"{n}.png", mime="image/png", source="view_image",
                                                    call_id=call if k == 0 else f"text-{n}", anchor=len(messages))
                            for k in range(2)]
            messages += [{"role": "tool", "tool_call_id": call, "content": "viewed"},
                         {"role": "assistant", "content": "ok"}]
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(messages=messages, image_views=records)
        # CPU time, not wall time: a shared runner deschedules a process mid-measurement and
        # inflates perf_counter by however long it waited, which has nothing to do with the
        # algorithm under test. process_time only advances while this process is on a CPU, so a
        # quadratic lookup still shows up and a busy machine does not.
        started = time.process_time()
        Backend._history(backend)
        with_images = time.process_time() - started
        backend.agent = types.SimpleNamespace(messages=messages, image_views=[])
        started = time.process_time()
        Backend._history(backend)
        without = time.process_time() - started
        self.assertLess(with_images, without * 3 + 0.05, (with_images, without))


if __name__ == "__main__":
    unittest.main()
