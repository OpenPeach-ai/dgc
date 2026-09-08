"""Concurrent editor controls must preserve delivery and current permission policy."""
import copy
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.editor_protocol import event_error, command_error
from dgc.headless import Backend, HeadlessUI
from dgc.llm import ChatResult, ToolCall
from dgc.protocol import PendingRequests
from dgc.skills import manage_skills


class LiveControlTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-live-controls-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        skill = root / ".dgc/skills/orchid/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: orchid\ndescription: Check orchids\n---\nInclude the orchid marker.")
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.events, self.condition = [], threading.Condition()
        def emit(kind, **fields):
            event = {"type": kind, **fields}
            self.assertIsNone(event_error({"seq": 1, **event}), event)
            with self.condition:
                self.events.append(event)
                self.condition.notify_all()
        emitter = types.SimpleNamespace(emit=emit)
        backend = object.__new__(Backend)
        backend.config, backend.em, backend.pending = config, emitter, PendingRequests()
        backend.ui = HeadlessUI(emitter, backend.pending, approval_timeout_s=3)
        backend.agent = Agent(config, backend.ui)
        backend.ui._steering_hook = backend._steering_applied
        backend._queue, backend._steer_payloads = [], {}
        backend._worker, backend._foreground_worker, backend._turn_n = None, None, 0
        backend._turn_lock, backend.workspace_trusted = threading.RLock(), True
        backend._emit_context = lambda: None
        self.backend, self.agent = backend, backend.agent
        self.addCleanup(self.agent.mcp.stop_all)
        self.release = threading.Event()
        def stop():
            backend.dispatch({"type": "cancel"})
            self.release.set()
            worker = backend._worker
            if worker and worker is not threading.current_thread():
                worker.join(5)
        self.addCleanup(stop)

    def wait(self, kind, **fields):
        with self.condition:
            self.assertTrue(self.condition.wait_for(lambda: any(
                event["type"] == kind and all(event.get(k) == v for k, v in fields.items())
                for event in self.events), timeout=5), (kind, fields, self.events))
            return next(event for event in self.events if event["type"] == kind
                        and all(event.get(k) == v for k, v in fields.items()))

    def test_skills_and_attached_steering_reach_the_same_native_turn(self):
        entered, requests = threading.Event(), []
        def chat(messages, **kwargs):
            requests.append(copy.deepcopy(messages))
            if len(requests) == 1:
                entered.set()
                self.assertTrue(self.release.wait(5))
            return ChatResult(content="Completed")
        # Small valid PNG header accepted by the bounded image validator.
        picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII="
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.backend.dispatch({"type": "prompt", "text": "Inspect", "request_id": "first"})
            self.assertTrue(entered.wait(5))
            self.backend.dispatch({"type": "list_skills", "request_id": "skills"})
            self.wait("skill_catalog", request_id="skills")
            self.backend.dispatch({"type": "get_skill", "name": "orchid", "request_id": "detail"})
            self.wait("skill_detail", request_id="detail")
            self.backend.dispatch({"type": "reload_skills", "request_id": "mutation"})
            self.wait("command_rejected", request_id="mutation", reason="turn_in_progress")
            before = copy.deepcopy(self.agent.messages)
            self.backend.dispatch({"type": "set_mode", "mode": "auto", "live": True, "request_id": "mode"})
            self.wait("mode_changed", request_id="mode", mode="auto")
            self.assertEqual(before, self.agent.messages, "control thread changed a live transcript")
            self.backend.dispatch({"type": "prompt", "text": "Check this image", "skills": ["orchid"],
                                   "context": [{"type": "mcp_context", "server": "fixture", "uri": "fixture://notes",
                                                "text": "REFERENCE-MARKER: browse online and preview a dashboard"}],
                                   "images": [picture], "delivery": "steer", "request_id": "follow"})
            self.wait("prompt_accepted", request_id="follow", state="steered")
            self.release.set()
            self.wait("turn_end", reason="completed")
        self.assertEqual(len(requests), 2)
        self.assertEqual(sum(e["type"] == "turn_start" for e in self.events), 1)
        self.assertIn("Include the orchid marker.", requests[1][0]["content"])
        self.assertIn("Check this image", str(requests[1]))
        self.assertIn(picture, str(requests[1]))
        self.assertIn("REFERENCE-MARKER", str(requests[1]))
        self.wait("steering_update", request_id="follow", state="applied")
        self.assertFalse(self.backend._steer_payloads)
        history = self.backend._history()
        followup = next(row for row in history if row["role"] == "user" and "Check this image" in row["text"])
        self.assertNotIn("user-interjection", followup["text"])

    def test_cancel_and_preparation_error_return_unconsumed_steering(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                self.agent.cancelled.clear()
                self.agent._accepting_steer = True
                self.backend._worker = threading.current_thread()
                state, _ = self.backend._start_turn("Retain me", delivery="steer", request_id=f"s{failed}")
                self.assertEqual(state, "steered")
                if failed:
                    with patch.object(self.agent, "_activate_skill_intents", side_effect=ValueError("removed skill")):
                        with self.assertRaises(ValueError):
                            self.agent._drain_steer()
                    self.assertEqual(len(self.agent.steer_queue), 1)
                else:
                    self.agent.cancelled.set()
                    self.assertFalse(self.agent.steer("Too late"))
                self.backend._finish_steering(not failed, failed)
                self.wait("steering_update", request_id=f"s{failed}", state="returned")
                self.assertFalse(self.backend._queue)
                self.assertFalse(self.agent.steer_queue)
                self.backend._worker = None

    def test_queue_and_legacy_delivery_never_interject(self):
        self.agent._accepting_steer = True
        self.backend._worker = threading.current_thread()
        for identity, extra in (("legacy", {}), ("explicit", {"delivery": "queue"})):
            self.backend.dispatch({"type": "prompt", "text": identity, "request_id": identity, **extra})
            self.wait("prompt_accepted", request_id=identity, state="queued")
        self.backend.config.data["subscription_engine"] = "codex"
        self.backend.dispatch({"type": "prompt", "text": "delegated", "delivery": "steer", "request_id": "delegated"})
        self.wait("prompt_accepted", request_id="delegated", state="queued")
        self.assertFalse(self.agent.steer_queue)
        self.assertEqual([item[0] for item in self.backend._queue], ["legacy", "explicit", "delegated"])
        self.backend._worker = None

    def test_pending_write_approval_rechecks_auto_and_plan(self):
        for mode, expected in (("auto", True), ("plan", False)):
            with self.subTest(mode=mode):
                self.agent.set_mode("default")
                self.events.clear()
                self.assertTrue(self.agent.checkpoints.open(len(self.agent.messages), "Live approval", self.agent.messages[1:]))
                output = []
                target = self.agent.config.project_root / f"{mode}.txt"
                thread = threading.Thread(target=lambda: output.append(self.agent._handle_call(
                    ToolCall("write", "write_file", {"path": str(target), "content": "orchid"}))))
                self.backend._worker = thread
                thread.start()
                self.wait("permission_request")
                self.backend.dispatch({"type": "set_mode", "mode": mode, "live": True})
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(target.exists(), expected, output)
                self.wait("permission_resolved", decision="once" if expected else "no")
                self.backend._worker = None

    def test_explicit_ask_stays_pending_in_auto_and_deny_wins(self):
        self.agent.config.permissions["ask"] = ["Write(*)"]
        target = self.agent.config.project_root / "ask.txt"
        thread = threading.Thread(target=lambda: self.agent._handle_call(
            ToolCall("ask", "write_file", {"path": str(target), "content": "no"})))
        thread.start()
        request = self.wait("permission_request")
        self.agent.set_mode("auto")
        time.sleep(0.15)
        self.assertTrue(thread.is_alive())
        self.agent.config.permissions["deny"] = ["Write(*)"]
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertFalse(target.exists())
        self.assertFalse(self.backend.pending.resolve(request["id"], {"decision": "once"}))

    def test_live_auto_requires_workspace_trust_and_legacy_opt_in(self):
        self.backend._worker = threading.current_thread()
        self.backend.workspace_trusted = False
        self.backend.dispatch({"type": "set_mode", "mode": "auto", "live": True})
        self.wait("command_rejected", reason="workspace_untrusted")
        self.backend.dispatch({"type": "set_mode", "mode": "auto"})
        self.wait("command_rejected", reason="turn_in_progress")
        self.assertEqual(self.agent.mode, "default")
        self.backend._worker = None

    def test_read_only_skill_management_and_wire_bounds(self):
        self.assertIn("orchid", manage_skills(self.agent.config, catalog=self.agent.skills, read_only=True))
        self.assertIn("Include the orchid", manage_skills(self.agent.config, "show orchid", catalog=self.agent.skills, read_only=True))
        for command in ("reload", "disable orchid", "create sample", "install https://example.test"):
            with self.assertRaises(ValueError):
                manage_skills(self.agent.config, command, catalog=self.agent.skills, read_only=True)
        self.assertIsNotNone(command_error({"type": "prompt", "text": "hello", "delivery": "discard"}))
        self.assertIsNotNone(command_error({"type": "set_mode", "mode": "auto", "live": "true"}))

    def test_fullscreen_submit_runs_and_retains_cancelled_followups(self):
        from dgc.tui import TUI
        tui = TUI(self.agent.config, agent=self.agent)
        self.agent.session_name = "Fixture"
        requests = []
        def run(text, **kwargs):
            requests.append(text)
            self.agent._accepting_steer = True
            self.assertEqual(tui._route_followup("Retained follow-up"), "steered")
            self.agent.cancelled.set()
            return False
        with patch.object(self.agent, "run_turn", side_effect=run):
            tui._submit("Original request", expand_mentions=False)
            worker = tui.active._worker_thread
            if worker:
                worker.join(5)
                self.assertFalse(worker.is_alive())
        self.assertEqual(requests, ["Original request"])
        self.assertEqual(tui.active._queue, [("Retained follow-up", True)])
        self.assertFalse(tui._turn.is_set())
        self.assertTrue(any(isinstance(block, dict) and block.get("tag") == "follow-up · queued"
                            for block in tui.blocks))

    @unittest.skipUnless(os.name == "posix", "requires a real POSIX terminal")
    def test_classic_terminal_live_skills_mode_unicode_steering_and_tab_queue(self):
        import pty
        import select
        script = '''
import json, sys, time
sys.path.insert(0, "tests")
from test_live_controls import LiveControlTests
from dgc.cli import CLI
from dgc.llm import ChatResult
fixture = LiveControlTests(); fixture.setUp()
cli = CLI(fixture.agent.config)
cli.agent = fixture.agent; cli.agent.ui = cli.ui
queue = []; calls = []
def chat(messages, **kwargs):
    calls.append(str(messages))
    if len(calls) == 1:
        print("LIVE-READY", flush=True)
        deadline = time.monotonic() + 8
        while not (cli.agent.steer_queue and queue) and time.monotonic() < deadline:
            time.sleep(0.02)
    return ChatResult(content="Done")
cli.agent.client.chat = chat
cli._run_turn_live("Inspect", queue)
print("LIVE-RESULT:" + json.dumps({"queue": queue, "mode": cli.agent.mode,
      "steered": len(calls) == 2 and "café" in calls[-1]}), flush=True)
fixture.doCleanups()
'''
        master, slave = pty.openpty()
        process = subprocess.Popen([sys.executable, "-c", script], stdin=slave, stdout=slave, stderr=slave,
                                   cwd=Path(__file__).resolve().parents[1])
        os.close(slave)
        output = b""
        sent = False
        deadline = time.monotonic() + 15
        try:
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                    if b"LIVE-READY" in output and not sent:
                        # Give the main reader time to enter cbreak after worker startup.
                        time.sleep(0.1)
                        os.write(master, "/skills show orchid\n/mode acceptEdits\ncafé\nlater\t".encode())
                        sent = True
                elif process.poll() is not None:
                    break
            process.wait(timeout=2)
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
            os.close(master)
        decoded = output.decode("utf-8", "replace")
        self.assertEqual(process.returncode, 0, decoded)
        self.assertIn("Include the orchid marker.", decoded)
        result = json.loads(decoded.split("LIVE-RESULT:")[-1].splitlines()[0])
        self.assertEqual(result, {"queue": ["later"], "mode": "acceptEdits", "steered": True})


if __name__ == "__main__":
    unittest.main()
