"""Browser screenshots reach a vision model, are labelled per page, and stay out of the user's changes."""
import base64
import copy
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_screenshot_vision.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-vision-tests-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import chat_changes, sessions, tools  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config, DEFAULTS  # noqa: E402
from dgc.llm import ChatResult, ToolCall  # noqa: E402

_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


class _ShowHandler(BaseHTTPRequestHandler):
    """/api/show for two models: `vis` accepts images, `txt` does not."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/api/show":
            caps = ["completion", "tools"] + (["vision"] if body.get("model") == "vis" else [])
            payload = json.dumps({"capabilities": caps, "details": {"family": "fixture"}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


class _UI:
    non_interactive = False

    def __init__(self):
        self.images = []

    def tool_images(self, call_id, images, caption="", *, items=None, omitted=0, meta=None):
        self.images.append((call_id, list(images), caption, list(meta or [])))

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class ScreenshotVisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _ShowHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-vision-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)

    def agent(self, model: str, api_mode: str = "ollama") -> Agent:
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        # A path unique to this test keeps the class-wide metadata cache from leaking between tests.
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        cfg.data.update(base_url=base, model=model, mode="auto", api_mode=api_mode,
                        hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                        max_turns=6, thinking="off")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        self.ui = _UI()
        agent = Agent(cfg, self.ui)
        agent.client.invalidate_capabilities()
        agent.session_file = sessions.new_path(self.root)
        self.addCleanup(agent.mcp.stop_all)
        return agent

    # --- the capability flag -----------------------------------------------------------------

    def test_a_fresh_agent_carries_its_clients_image_capability(self):
        agent = self.agent("vis")
        self.assertTrue(agent.client.vision_supported)
        self.assertTrue(tools._vision_available(agent.ctx),
                        "a new backend must not tell a vision model it is blind")

    def test_the_turn_rereads_the_capability_once_the_models_metadata_is_known(self):
        seen = {}
        for model in ("txt", "vis"):
            agent = self.agent(model)
            agent.refresh_client()                  # a model switch: no metadata cached yet

            def chat(messages, _agent=agent, _model=model, **kwargs):
                seen[_model] = tools._vision_available(_agent.ctx)
                return ChatResult(content="ok")
            with patch.object(agent.client, "chat", side_effect=chat):
                self.assertTrue(agent.run_turn("look at the page"))
        self.assertEqual(seen, {"txt": False, "vis": True})

    # --- labelled screenshots ----------------------------------------------------------------

    def test_each_screenshot_in_a_batch_is_labelled_for_the_model_and_the_panel(self):
        agent = self.agent("vis")
        pages = {"a": "http://127.0.0.1:1/page2.html", "b": "http://127.0.0.1:1/tall.html"}

        def fake_browser(args, ctx):
            page = pages[args["url"]]
            tools._queue_image(ctx.tool_owner, tools._image_entry(
                _PNG, name=f"page-{args['url']}.png", source="browser", host=page,
                label=f"screenshot of {page}"))
            return f"screenshot of {page}"
        calls = iter([
            ChatResult(tool_calls=[ToolCall("c1", "browser", {"operation": "screenshot", "url": "a"}),
                                   ToolCall("c2", "browser", {"operation": "screenshot", "url": "b"})]),
            ChatResult(content="done")])
        with patch.dict(tools.EXECUTORS, {"browser": fake_browser}), \
                patch.object(agent.client, "chat", side_effect=lambda *a, **k: next(calls)):
            self.assertTrue(agent.run_turn("screenshot both"))
        shot_messages = [m for m in agent.messages if m.get("role") == "user"
                         and isinstance(m.get("content"), list)
                         and any(p.get("type") == "image_url" for p in m["content"])]
        self.assertEqual(len(shot_messages), 1)
        parts = shot_messages[0]["content"]
        texts = [p["text"] for p in parts if p.get("type") == "text"]
        self.assertTrue(texts[0].startswith("<tool_results>"))
        self.assertIn(f"Image 1 of 2: screenshot of {pages['a']} (tool call c1)", texts)
        self.assertIn(f"Image 2 of 2: screenshot of {pages['b']} (tool call c2)", texts)
        order = [p.get("type") for p in parts[1:]]
        self.assertEqual(order, ["text", "image_url", "text", "image_url"], "each label precedes its image")
        # The panel gets one event per step; each chip names its file and the page's host (v14
        # chips never show a page URL), so the two screenshots stay distinguishable there too.
        self.assertEqual([call_id for call_id, *_ in self.ui.images], ["c1", "c2"])
        self.assertEqual([[entry["name"] for entry in meta] for *_, meta in self.ui.images],
                         [["page-a.png"], ["page-b.png"]])
        self.assertTrue(all(entry["host"] for *_, meta in self.ui.images for entry in meta))

    def test_a_reminder_folded_after_a_screenshot_keeps_the_image_parts(self):
        agent = self.agent("vis")
        agent.messages.append({"role": "user", "content": Agent._screenshot_parts(
            [("data:image/png;base64,AAAA", "screenshot of http://x/", "c1")])})
        agent._fold_into_last_user("<system-reminder>\nhurry\n</system-reminder>")
        content = agent.messages[-1]["content"]
        self.assertIsInstance(content, list)
        self.assertEqual(content[-1], {"type": "text", "text": "<system-reminder>\nhurry\n</system-reminder>"})
        self.assertTrue(any(p.get("type") == "image_url" for p in content))

    # --- the screenshot operation ------------------------------------------------------------

    def _fake_session(self):
        class Session:
            current_url = "about:blank"
            navigated = []

            def navigate(self, url):
                self.navigated.append(url)
                self.current_url = url
                return "load event fired"

            def screenshot_png(self):
                return _PNG
        return Session()

    def test_a_screenshot_with_a_url_opens_that_page_first(self):
        agent = self.agent("vis")
        session = self._fake_session()
        with patch.object(tools, "_browser_session", return_value=session):
            out = tools.browser_tool({"operation": "screenshot", "url": "http://127.0.0.1:4901/page1.html"},
                                     agent.ctx)
            bad = tools.browser_tool({"operation": "screenshot", "url": "file:///etc/passwd"}, agent.ctx)
        self.assertEqual(session.navigated, ["http://127.0.0.1:4901/page1.html"])
        self.assertIn("screenshot of http://127.0.0.1:4901/page1.html", out)
        self.assertNotIn("about:blank", out)
        self.assertTrue(bad.startswith("error:"), bad)
        queued = tools.take_pending_images(agent.ctx.tool_owner)
        self.assertEqual([entry["label"] for entry in queued], ["screenshot of http://127.0.0.1:4901/page1.html"])

    def test_screenshots_stay_out_of_git_status_and_the_chats_changes(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "app.py").write_text("print('hi')\n")
        agent = self.agent("vis")
        session = self._fake_session()
        with patch.object(tools, "_browser_session", return_value=session):
            first = tools.browser_tool({"operation": "screenshot"}, agent.ctx)
            second = tools.browser_tool({"operation": "screenshot"}, agent.ctx)
        tools.take_pending_images(agent.ctx.tool_owner)
        shots = sorted((self.root / ".dgc" / "screenshots").glob("page-*.png"))
        self.assertEqual(len(shots), 2, (first, second))     # two in one second do not collide
        status = subprocess.run(["git", "-C", str(self.root), "status", "--porcelain",
                                 "--untracked-files=all"], capture_output=True, text=True).stdout
        self.assertNotIn(".dgc", status)
        # Even a .dgc file git does not ignore is DGC's own state, not an edit made in the chat.
        (self.root / ".dgc" / "notes.lock").write_text("x")
        import time as _time
        names = chat_changes._names(self.root, _time.monotonic() + 5)
        self.assertIn("app.py", names)
        self.assertFalse([name for name in names if name.startswith(".dgc/")], names)


if __name__ == "__main__":
    unittest.main()
