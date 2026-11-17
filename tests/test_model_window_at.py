"""The largest context window a model at a host takes (`model_window_at`, answered by `model_window`; 0.52, 17 Nov).

His call for the model picker's Sub-agents page: "context size only shows options of what that model is capable of, so
for a model whose max is 256k, we do not show 1M option". The editor asks for the model it shows, at that connection's
address, and DGC says the window as its own model client knows it (Ollama's /api/show, Anthropic's Models API, a vLLM
or llama.cpp server's own word, or what an earlier overflow taught it), or 0 when nothing says (the picker then offers
every size). The same address and key rules as list_models_at: a saved key goes only to the host it is bound to.
"""
from __future__ import annotations

import http.server
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

if "dgc.config" not in sys.modules:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-model-window-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import Config  # noqa: E402

MAIN_KEY = "sk-main-saved-0123456789"
SUB_KEY = "sk-subagent-saved-0123456789"


class StubHost:
    """Ollama's /api/show, Anthropic's /v1/models/<id>, and an OpenAI-compatible host that says no window."""

    def __init__(self, window=262144):
        self.window = window
        self.seen: list[tuple[str, dict, dict]] = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def reply(self, status, body):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                owner.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}, {}))
                if "/models/" in self.path:          # Anthropic's Models API: one model
                    self.reply(200, {"id": self.path.rsplit("/", 1)[-1], "type": "model",
                                     "max_input_tokens": owner.window, "max_tokens": 64000})
                elif self.path.endswith("/models"):   # an OpenAI-compatible list with nothing about windows
                    self.reply(200, {"object": "list", "data": [{"id": "served-a", "object": "model"}]})
                else:
                    self.reply(404, {"error": "not found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                sent = json.loads(self.rfile.read(length) or b"{}")
                owner.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}, sent))
                if self.path.endswith("/api/show"):
                    self.reply(200, {"capabilities": ["completion", "tools"], "details": {"family": "qwen3"},
                                     "model_info": {"general.architecture": "qwen3",
                                                    "qwen3.context_length": owner.window}})
                else:
                    self.reply(404, {"error": "not found"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def keys_received(self) -> set[str]:
        got = set()
        for _path, headers, _body in self.seen:
            for name in ("authorization", "x-api-key", "api-key"):
                value = headers.get(name, "")
                value = value[len("Bearer "):] if value.startswith("Bearer ") else value
                if value.strip():
                    got.add(value.strip())
        return got

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ModelWindowAt(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-model-window-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.root = tmp / "project"
        (self.root / ".git").mkdir(parents=True)
        self.main, self.sub, self.other = StubHost(262144), StubHost(131072), StubHost(200000)
        for host in (self.main, self.sub, self.other):
            self.addCleanup(host.close)

    def host(self):
        (self.user / "config.json").write_text(json.dumps({
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, "model": "fixture",
            "base_url": self.main.url, "api_mode": "ollama", "subagent_base_url": self.sub.url}))
        with patch.dict(os.environ, {"DGC_API_KEY": MAIN_KEY, "DGC_SUBAGENT_API_KEY": SUB_KEY}):
            config = Config(project_root=self.root)
        self.wire = io.StringIO()
        sessions_dir = patch.object(sessions, "SESSIONS_DIR", self.user / "sessions")
        sessions_dir.start()
        self.addCleanup(sessions_dir.stop)
        host = headless.Host(config)
        host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(host.chats.values())])
        return host

    def frames(self, kind=""):
        frames = [json.loads(line) for line in self.wire.getvalue().splitlines()]
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        return [f for f in frames if not kind or f["type"] == kind]

    def ask(self, host, request_id, role, base_url, model, api_mode="", api_key=None, timeout=15):
        cmd = {"type": "model_window_at", "request_id": request_id, "role": role, "base_url": base_url, "model": model,
               "api_mode": api_mode, **({"api_key": api_key} if api_key is not None else {})}
        self.assertIsNone(ep.command_error(cmd), cmd)
        host.dispatch(cmd)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for frame in self.frames("model_window"):
                if frame["request_id"] == request_id:
                    return frame
            time.sleep(0.02)
        self.fail(f"no model_window for {request_id}")

    def test_it_is_offered(self):
        host = self.host()
        self.assertEqual(host.default._ready_payload()["capabilities"]["model_window_at"], 1)

    def test_ollama_says_its_window(self):
        host = self.host()
        frame = self.ask(host, "w1", "main", "", "qwen3:8b", "ollama")
        self.assertEqual(frame["window"], 262144)
        self.assertEqual(frame["model"], "qwen3:8b")
        shown = [body for path, _h, body in self.main.seen if path.endswith("/api/show")]
        self.assertEqual(shown[-1].get("model"), "qwen3:8b", "it asks for that model, not the session's")

    def test_anthropic_says_its_window(self):
        host = self.host()
        frame = self.ask(host, "w2", "subagent", self.other.url + "/v1", "claude-opus-5-5", "anthropic", api_key="sk-typed-1234")
        self.assertEqual(frame["window"], 200000)
        self.assertEqual(self.other.keys_received(), {"sk-typed-1234"}, "a key sent beside the address goes there")

    def test_a_host_that_says_nothing_answers_zero(self):
        host = self.host()
        frame = self.ask(host, "w3", "subagent", self.other.url + "/v1", "served-a", "chat_completions")
        self.assertEqual(frame["window"], 0, "nothing known: the picker offers every size")
        self.assertNotIn("error", frame)

    def test_a_saved_key_goes_only_to_its_own_host(self):
        host = self.host()
        self.ask(host, "w4", "subagent", self.sub.url, "qwen3:8b", "ollama")   # the sub-agents' saved host
        self.assertEqual(self.sub.keys_received(), {SUB_KEY})
        self.ask(host, "w4b", "subagent", "", "qwen3:8b", "ollama")           # "": the main host, as the route has it
        self.assertEqual(self.main.keys_received(), {MAIN_KEY})
        self.ask(host, "w5", "subagent", self.other.url, "qwen3:8b", "ollama")
        self.assertEqual(self.other.keys_received(), set(), "another address gets no saved key")
        self.assertNotIn(MAIN_KEY, self.wire.getvalue())
        self.assertNotIn(SUB_KEY, self.wire.getvalue())

    def test_a_bad_request_is_refused_in_words(self):
        host = self.host()
        host.dispatch({"type": "model_window_at", "request_id": "", "role": "main", "base_url": "", "model": "x"})
        rejected = [f for f in self.frames("command_rejected") if f.get("command") == "model_window_at"]
        self.assertEqual(rejected[-1]["reason"], "invalid_request_id")
        frame = self.ask(host, "w6", "subagent", "ftp://nowhere", "x")
        self.assertEqual(frame["window"], 0)
        self.assertIn("http", frame["error"])
        frame = self.ask(host, "w7", "main", "", "")
        self.assertEqual(frame["window"], 0)
        self.assertIn("model", frame["error"])


if __name__ == "__main__":
    unittest.main()
