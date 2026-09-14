"""What DGC says when a turn ends for a reason nobody chose.

A person pressing stop and a backend being torn down both cancel the turn. Reporting the second
as "Stopped by user" is how a goal that died with its process came back looking like the user's
own doing — no error anywhere, just a paused goal and a person who had to resume it by hand.
"""
from __future__ import annotations

import json
import os
import pwd
import signal
import subprocess
import sys
import threading
import time
import tempfile
import unittest
from pathlib import Path

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_turn_interruption.py needs HOME redirected before dgc is "
                           "imported — run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-interruption-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc.agent import Agent            # noqa: E402  (after the redirect above)
from dgc.config import Config          # noqa: E402
from dgc import sessions               # noqa: E402

PROJECT = Path(__file__).resolve().parents[1]


class QuietUI:
    def __init__(self):
        self.infos, self.errors = [], []

    def info(self, message):
        self.infos.append(message)

    def error(self, message):
        self.errors.append(message)

    def __getattr__(self, name):
        return lambda *a, **k: None


class CancelReasonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-interruption-")
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        cfg = Config()
        cfg.project_root = self.root
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})
        self.agent = Agent(cfg, QuietUI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.agent.session_file = sessions.new_path(self.root)

    def test_a_person_pressing_stop_still_reads_as_the_user(self):
        self.agent.cancelled.set()
        self.assertEqual(self.agent._cancel_reason(), "Stopped by user")

    def test_a_backend_shutdown_does_not_claim_the_user_stopped_it(self):
        self.agent.stopping = True
        reason = self.agent._cancel_reason()
        self.assertIn("backend stopped", reason)
        self.assertNotIn("Stopped by user", reason)
        self.assertIn("resume", reason.lower())

    def test_a_goal_cancelled_by_shutdown_records_the_real_reason(self):
        self.assertTrue(self.agent.set_goal("Ship the thing"))

        def step(_prompt):
            self.agent.stopping = True          # the process goes down mid-cycle
            self.agent.cancelled.set()
            return False
        self.agent._run_turn = step
        self.agent.run_turn("Continue")
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["status"], "paused")
        self.assertIn("backend stopped", snapshot["reason"])
        history = [h for h in (self.agent._goal_details.get("history") or []) if isinstance(h, dict)]
        self.assertTrue(any("backend stopped" in str(h.get("reason", "")) for h in history))
        self.assertFalse(any(str(h.get("reason", "")) == "Stopped by user" for h in history))


class ServeShutdownLogTests(unittest.TestCase):
    """`serve.log` has to answer, days later, which of three shutdowns happened."""

    def run_serve(self, commands: str) -> str:
        home = tempfile.TemporaryDirectory(prefix="dgc-serve-log-")
        self.addCleanup(home.cleanup)
        work = tempfile.TemporaryDirectory(prefix="dgc-serve-proj-")
        self.addCleanup(work.cleanup)
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT))
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
            env[var] = home.name
        subprocess.run([sys.executable, "-m", "dgc", "serve"], input=commands, text=True,
                       cwd=work.name, env=env, capture_output=True, timeout=90)
        return (Path(home.name) / ".dgc" / "logs" / "serve.log").read_text(encoding="utf-8")

    def test_stdin_eof_names_the_parent_and_the_work_in_flight(self):
        log = self.run_serve(json.dumps({"type": "status", "request_id": "s1"}) + "\n")
        self.assertIn(f"parent pid {os.getpid()}", log)
        self.assertIn("stdin closed while the parent", log)
        self.assertIn("1 commands, last 'status'", log)
        self.assertIn("turn running: no", log)
        self.assertIn("backend closed cleanly", log)

    def test_an_asked_for_shutdown_is_not_reported_as_a_closed_pipe(self):
        log = self.run_serve(json.dumps({"type": "shutdown"}) + "\n")
        self.assertIn("the editor asked us to shut down", log)
        self.assertNotIn("stdin closed", log)

    def test_a_sigterm_closes_the_backend_instead_of_killing_it_between_two_bytecodes(self):
        """The default disposition runs no `finally`: the goal was never paused, only abandoned."""
        home = tempfile.TemporaryDirectory(prefix="dgc-serve-signal-")
        self.addCleanup(home.cleanup)
        work = tempfile.TemporaryDirectory(prefix="dgc-serve-signal-proj-")
        self.addCleanup(work.cleanup)
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT))
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
            env[var] = home.name
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                cwd=work.name, env=env)
        self.addCleanup(proc.kill)
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            self.addCleanup(pipe.close)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:      # the handler is installed once serve() is running
            line = proc.stdout.readline()
            self.assertTrue(line, "the backend exited before it was ready")
            if '"ready"' in line:
                break
        proc.send_signal(signal.SIGTERM)
        status = proc.wait(timeout=60)
        log = (Path(home.name) / ".dgc" / "logs" / "serve.log").read_text(encoding="utf-8")
        # Nothing tells a signal handler who sent the signal: the cause must not claim the editor did.
        self.assertIn("SIGTERM — a stop signal from another process, not a shutdown command from the editor", log)
        self.assertNotIn("the parent asked us to stop", log)
        self.assertIn("backend closed cleanly", log)    # the finally ran: work is saved, not lost
        # The stack dump still runs first and now chains INTO our handler instead of the kernel.
        self.assertIn("Current thread", log)
        # And we still die OF the signal — a 0 would tell a supervisor we chose to stop.
        self.assertEqual(status, -signal.SIGTERM)


class KilledBackendResumeTests(unittest.TestCase):
    """A backend killed outright runs no finally block. What it leaves on disk is all Continue has."""

    def test_continue_after_sigkill_resumes_the_interrupted_prompt_and_its_completed_steps(self):
        import queue
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from dgc.headless import TURN_CONTINUE_MARKER

        def sse(delta, finish=None):
            return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"

        def bash_call(call_id, command):
            return (sse({"tool_calls": [{"index": 0, "id": call_id, "type": "function", "function": {
                "name": "bash", "arguments": json.dumps({"command": command})}}]})
                + sse({}, finish="tool_calls") + "data: [DONE]\n\n")
        continued = []

        class Model(BaseHTTPRequestHandler):
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
                messages = body.get("messages") or []
                text = json.dumps(messages)
                tools_done = sum(1 for m in messages if m.get("role") == "tool")
                if TURN_CONTINUE_MARKER in text:
                    continued.append(messages)
                    payload = sse({"content": "Continued."}) + sse({}, finish="stop") + "data: [DONE]\n\n"
                elif tools_done == 0:
                    payload = bash_call("call_1", "echo s8-step-one-done > s8-step1.txt && cat s8-step1.txt")
                elif tools_done == 1:
                    payload = bash_call("call_2", "echo $$ > s8-sleep.pid; exec sleep 60")
                else:
                    payload = sse({"content": "Done."}) + sse({}, finish="stop") + "data: [DONE]\n\n"
                self._send(payload, "text/event-stream")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        home = tempfile.TemporaryDirectory(prefix="dgc-kill-resume-home-")
        self.addCleanup(home.cleanup)
        work = tempfile.TemporaryDirectory(prefix="dgc-kill-resume-work-")
        self.addCleanup(work.cleanup)
        (Path(home.name) / ".dgc").mkdir()
        (Path(home.name) / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{server.server_address[1]}/v1", "model": "mock-model",
            "api_mode": "chat_completions", "suggest": False, "notes": False}))
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT), PYTHONDONTWRITEBYTECODE="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = home.name

        def serve():
            proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=work.name, env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True)
            self.addCleanup(lambda: proc.poll() is None and proc.kill())
            for pipe in (proc.stdin, proc.stdout):
                self.addCleanup(pipe.close)
            arrived = queue.Queue()

            def read():
                for line in proc.stdout:
                    try:
                        arrived.put(json.loads(line))
                    except ValueError:
                        pass
            threading.Thread(target=read, daemon=True).start()

            def send(command):
                proc.stdin.write(json.dumps(command) + "\n")
                proc.stdin.flush()

            def wait(predicate, timeout=60):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    try:
                        event = arrived.get(timeout=max(0.01, deadline - time.monotonic()))
                    except queue.Empty:
                        break
                    if predicate(event):
                        return event
                return None
            self.assertIsNotNone(wait(lambda e: e.get("type") == "ready"))
            send({"type": "set_mode", "mode": "auto", "acknowledge_workspace_trust": True,
                  "request_id": "m"})
            self.assertIsNotNone(wait(lambda e: e.get("type") == "mode_changed"))
            return proc, send, wait

        first, send, wait = serve()
        send({"type": "prompt", "text": "S8 prompt: two steps please", "request_id": "p1"})
        pid_file = Path(work.name) / "s8-sleep.pid"
        deadline = time.monotonic() + 60
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(pid_file.exists(), "step 2 is running")
        time.sleep(0.2)
        try:
            sleeper = int(pid_file.read_text().strip())
            self.addCleanup(lambda: os.path.exists(f"/proc/{sleeper}") and os.kill(sleeper, signal.SIGKILL))
        except ValueError:
            pass
        first.kill()                               # SIGKILL: no finally block, no grace path
        first.wait(30)

        second, send, wait = serve()
        send({"type": "resume_session", "latest": True, "request_id": "r1"})
        resumed = wait(lambda e: e.get("type") in ("session", "error", "command_rejected"))
        self.assertEqual((resumed or {}).get("type"), "session", resumed)
        send({"type": "resume_turn", "request_id": "c1"})
        outcome = wait(lambda e: e.get("type") in ("turn_end", "command_rejected"), 90)
        self.assertEqual((outcome or {}).get("type"), "turn_end", outcome)
        self.assertEqual(len(continued), 1, "Continue reached the model")
        users = [str(m.get("content")) for m in continued[0] if m.get("role") == "user"]
        self.assertTrue(any("S8 prompt: two steps please" in u for u in users), users)
        self.assertLess(next(i for i, u in enumerate(users) if "S8 prompt" in u),
                        next(i for i, u in enumerate(users) if TURN_CONTINUE_MARKER in u))
        tools = [str(m.get("content")) for m in continued[0] if m.get("role") == "tool"]
        self.assertTrue(any("s8-step-one-done" in t for t in tools), "the completed step survived")
        second.stdin.close()
        second.wait(60)


class PlanHandoffPromptTests(unittest.TestCase):
    """After an approved plan the answer contract changes — but only where that is true.

    Unfenced, the block contradicts three things already in the same context: the approval's own
    tool result ("Execute the plan now"), a standing goal ("keep making progress every turn"), and
    auto mode. And a plan whose checklist has nothing open is not a plan in progress at all.
    """

    def agent(self, root: Path | None = None, **settings):
        if root is None:
            tmp = tempfile.TemporaryDirectory(prefix="dgc-plan-prompt-")
            self.addCleanup(tmp.cleanup)
            root = Path(tmp.name)
        cfg = Config()
        cfg.project_root = root
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})
        cfg.data.update(settings)
        agent = Agent(cfg, QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(root)
        return agent

    OPEN = (("Phase 1 — the part asked for", "in_progress"), ("Phase 2", "pending"))
    # "done" is what the store holds: the todo tool normalises "completed" → "done", so a fixture
    # spelled the other way would pass by being coerced to pending, not by being finished.
    DONE = (("Phase 1 — the part asked for", "done"), ("Phase 2", "done"))
    BLOCKED = (("Phase 1 — the part asked for", "done"), ("Phase 2", "blocked"))

    def approve(self, agent, checklist=OPEN):
        """Present a plan, have the user approve it, and leave the checklist it produced."""
        agent.set_mode("plan")
        agent._plan_presented = True                 # present_plan succeeded
        agent.exit_plan("default")                   # the user approved it
        agent.ctx.todos = [{"content": c, "status": s} for c, s in checklist]
        return agent

    def next_turn_prompt(self, agent):
        """The system prompt exactly as the NEXT top-level turn sends it."""
        seen = {}

        def fake_chat(*a, **k):
            seen["system"] = agent.messages[0]["content"]
            from dgc.llm import ChatResult
            return ChatResult(content="phase 1 done", tool_calls=[], finish_reason="stop")
        agent._chat = fake_chat
        agent.run_turn("do phase 1")
        return seen.get("system", "<no model request was made>")

    def test_the_approving_turn_is_never_told_to_hand_back(self):
        agent = self.approve(self.agent())
        # The approval tool result in this very turn says "Execute the plan now".
        self.assertNotIn("# Approved plan", agent.system_prompt())
        self.assertIn("# Approved plan", self.next_turn_prompt(agent))

    def test_a_plan_with_open_phases_asks_for_the_hand_back_without_refusing_the_plan(self):
        prompt = self.next_turn_prompt(self.approve(self.agent()))
        self.assertIn("# Approved plan", prompt)
        self.assertIn("carry it out", prompt)        # approved as a whole → keep going
        self.assertIn("finish that part", prompt)    # scoped to one part → hand back
        self.assertIn("whether to continue", prompt)

    def test_a_checklist_with_nothing_open_clears_the_block_by_itself(self):
        self.assertNotIn("# Approved plan",
                         self.next_turn_prompt(self.approve(self.agent(), self.DONE)))
        self.assertNotIn("# Approved plan",
                         self.next_turn_prompt(self.approve(self.agent(), ())))

    def test_a_standing_goal_and_auto_mode_both_win(self):
        goal_agent = self.approve(self.agent())
        self.assertTrue(goal_agent.set_goal("Ship the thing"))
        goal_agent._plan_approved_this_turn = False   # a later turn; the goal loop owns run_turn
        prompt = goal_agent.system_prompt()
        self.assertIn("# Standing goal", prompt)
        self.assertNotIn("# Approved plan", prompt)

        auto_agent = self.approve(self.agent())
        auto_agent._plan_approved_this_turn = False
        auto_agent.set_mode("auto")
        self.assertNotIn("# Approved plan", auto_agent.system_prompt())
        auto_agent.set_mode("default")
        self.assertIn("# Approved plan", auto_agent.system_prompt())

    def test_no_plan_means_no_extra_instructions(self):
        plain = self.agent()
        self.assertNotIn("# Approved plan", plain.system_prompt())
        self.assertNotIn("# Approved plan", self.next_turn_prompt(plain))
        # ... and the same agent, once a plan is approved and a turn has passed, does get it.
        self.assertIn("# Approved plan", self.next_turn_prompt(self.approve(plain)))

    def test_leaving_plan_mode_without_a_plan_adds_nothing(self):
        agent = self.agent()
        agent.set_mode("plan")
        agent.exit_plan("default")                   # no present_plan call behind it
        agent.ctx.todos = [{"content": c, "status": s} for c, s in self.OPEN]
        self.assertNotIn("# Approved plan", self.next_turn_prompt(agent))
        # Same agent, same checklist — only a presented plan makes the difference.
        self.assertIn("# Approved plan", self.next_turn_prompt(self.approve(agent)))

    def test_a_plan_whose_remaining_phase_is_blocked_still_hands_back(self):
        # A parked phase is still a phase left; the hand-back is where the user hears about it.
        blocked = self.next_turn_prompt(self.approve(self.agent(), self.BLOCKED))
        self.assertIn("# Approved plan", blocked)
        finished = self.next_turn_prompt(self.approve(self.agent(), self.DONE))
        self.assertNotIn("# Approved plan", finished)

    def test_a_new_chat_forgets_the_plan(self):
        agent = self.approve(self.agent())
        self.assertIn("# Approved plan", self.next_turn_prompt(agent))
        agent.reset()
        self.assertNotIn("# Approved plan", agent.system_prompt())

    def test_a_resumed_session_does_not_inherit_someone_else_s_approved_plan(self):
        project = tempfile.TemporaryDirectory(prefix="dgc-plan-resume-")
        self.addCleanup(project.cleanup)
        other = self.agent(Path(project.name))
        self.next_turn_prompt(other)                 # an ordinary chat, saved to disk
        resumed = self.approve(self.agent(Path(project.name)))
        self.assertIn("# Approved plan", self.next_turn_prompt(resumed))
        resumed.load_session(other.session_file)
        self.assertFalse(resumed._executing_plan)
        self.assertFalse(resumed._plan_presented)
        self.assertNotIn("# Approved plan", resumed.messages[0]["content"])
        self.assertNotIn("# Approved plan", resumed.system_prompt())


class GracefulShutdownTests(unittest.TestCase):
    """A closed pipe should cost seconds of work, not the turn."""

    def backend(self):
        from dgc.headless import Backend, HeadlessUI, PendingRequests
        from dgc.protocol import Emitter
        import io, types
        tmp = tempfile.TemporaryDirectory(prefix="dgc-grace-")
        self.addCleanup(tmp.cleanup)
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})
        events = []
        emitter = types.SimpleNamespace(
            emit=lambda t, **d: events.append({"type": t, **d}))
        ui = HeadlessUI(emitter, PendingRequests(), 300.0)
        backend = object.__new__(Backend)
        backend.agent = Agent(cfg, ui)
        self.addCleanup(backend.agent.mcp.stop_all)
        backend.config, backend.em = cfg, emitter
        backend._queue = []
        backend._worker = None
        backend._foreground_worker = None
        backend.pending = PendingRequests()
        backend._turn_state_lock = lambda: threading.RLock()
        return backend, events

    def test_an_idle_backend_closes_at_once(self):
        backend, _ = self.backend()
        backend._busy = lambda: False
        start = time.monotonic()
        self.assertEqual(backend.close(grace_s=5), "idle")
        self.assertLess(time.monotonic() - start, 1.0)
        self.assertTrue(backend.agent.stopping)

    def test_work_that_lands_inside_the_grace_is_not_cancelled(self):
        backend, _ = self.backend()
        busy = {"value": True}
        backend._busy = lambda: busy["value"]
        threading.Timer(0.4, lambda: busy.__setitem__("value", False)).start()
        self.assertEqual(backend.close(grace_s=5), "landed")

    def test_work_that_overruns_the_grace_is_cancelled(self):
        backend, _ = self.backend()
        backend._busy = lambda: True
        start = time.monotonic()
        self.assertEqual(backend.close(grace_s=0.5), "cancelled")
        self.assertGreaterEqual(time.monotonic() - start, 0.5)
        self.assertTrue(backend.agent.cancelled.is_set())

    def test_the_turn_loop_lands_instead_of_starting_another_request(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-grace-turn-")
        self.addCleanup(tmp.cleanup)
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})
        agent = Agent(cfg, QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(Path(tmp.name))
        requests = []

        def fake_chat(*a, **k):
            requests.append(1)
            agent.stopping = True                     # the pipe closes while this call is in flight
            from dgc.llm import ChatResult
            return ChatResult(content="", tool_calls=[], finish_reason="tool_calls")
        agent._chat = fake_chat
        ok = agent.run_turn("do the thing")
        self.assertFalse(ok)
        self.assertEqual(len(requests), 1, "no second model request after the pipe closed")
        self.assertIn("backend was shut down mid-turn", agent._last_turn_error)
        self.assertIn("saved", agent._last_turn_error)


class DelegatedEditCheckpointTests(unittest.TestCase):
    """A delegated task in its own worktree must still be able to edit files.

    Every sub-task in a Git project gets an isolated worktree; the child runs at depth 1, so it
    never opens a recovery point, and it only inherits the parent's manager when it shares the
    checkout. The pre-edit capture gate then refused every write inside every delegated task —
    and the model, reasonably, routed its writes through the shell instead, landing them outside
    rewind. The gate now applies only where a rewind can actually reach.
    """

    def agent(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-delegated-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        cfg = Config()
        cfg.project_root = root
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "acceptEdits"})
        agent = Agent(cfg, QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(root)
        return agent, root

    def write(self, agent, path, text="hello\n"):
        from dgc.agent import ToolCall
        return agent._handle_call(ToolCall("w1", "write_file", {"path": path, "content": text}))

    def test_a_top_level_turn_still_requires_a_recovery_point(self):
        agent, _ = self.agent()
        self.assertTrue(agent._edit_checkpoints_required)
        out = self.write(agent, "a.txt")                       # no point opened in this fixture
        self.assertIn("could not capture", out)
        self.assertIn("no recovery point", out, "the refusal names its actual cause")

    def test_the_refusal_names_the_cause_it_hit(self):
        agent, root = self.agent()
        self.assertTrue(agent.checkpoints.open(0, "turn", []))
        agent.checkpoints._snapshot_bytes_total = 128 * 1024 * 1024
        (root / "b.txt").write_text("x" * 64)
        out = self.write(agent, "b.txt")
        self.assertIn("snapshot budget is spent", out)

    def test_a_worktree_sub_agent_writes_without_a_recovery_point(self):
        agent, root = self.agent()
        agent._edit_checkpoints_required = False               # what an isolated child is given
        out = self.write(agent, "c.txt", "from the sub-agent\n")
        self.assertNotIn("error", out.lower())
        self.assertEqual((root / "c.txt").read_text(), "from the sub-agent\n")
        self.assertEqual(agent.checkpoints.points, [], "nothing was snapshotted, by design")

    def test_a_shared_checkout_sub_agent_still_snapshots_into_the_parents_point(self):
        parent, root = self.agent()
        self.assertTrue(parent.checkpoints.open(0, "turn", []))
        (root / "d.txt").write_text("before\n")
        child = Agent(parent.config, QuietUI())
        self.addCleanup(child.mcp.stop_all)
        child.depth = 1
        child.checkpoints = parent.checkpoints                 # what a shared-checkout child is given
        child.session_file = parent.session_file
        self.assertTrue(child._edit_checkpoints_required)
        out = self.write(child, "d.txt", "after\n")
        self.assertNotIn("error", out.lower())
        captured = parent.checkpoints.points[-1]["files"]
        self.assertTrue(any(str(k).endswith("d.txt") for k in captured), captured)


class AuditRegressionTests(unittest.TestCase):
    """The eleven things an independent audit found still broken after the first round of fixes."""

    def test_a_child_never_designates_the_parents_answer_even_unphased(self):
        from dgc.agent import _SubUI
        seen = []

        class Parent:
            def end_stream(self, phase=""):
                seen.append(phase)

            def __getattr__(self, name):
                return lambda *a, **k: None

        sub = _SubUI(Parent(), "audit")
        sub.end_stream("answer")
        sub.end_stream()                       # the cancel/error/timeout paths close unphased
        sub.end_stream("commentary")
        self.assertEqual(seen, ["commentary", "commentary", "commentary"])

    def test_a_childs_checklist_never_repaints_the_sessions_rail(self):
        from dgc.agent import _SubUI
        pushed = []

        class Parent:
            def on_todo(self, todos):
                pushed.append(list(todos))

            def __getattr__(self, name):
                return lambda *a, **k: None

        _SubUI(Parent(), "audit").on_todo([{"content": "child step", "status": "in_progress"}])
        self.assertEqual(pushed, [], "the session's plan stays the session's")

    def test_an_isolated_child_still_captures_writes_into_the_parent_checkout(self):
        from dgc.agent import _within_own_checkout
        tmp = tempfile.TemporaryDirectory(prefix="dgc-own-checkout-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name) / "worktree"
        (root / "src").mkdir(parents=True)
        outside = Path(tmp.name) / "parent"
        outside.mkdir()
        cfg = Config()
        cfg.project_root = root
        cfg.data.update({"model": "fixture", "base_url": "http://fixture"})
        agent = Agent(cfg, QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        agent._edit_checkpoints_required = False          # what an isolated child is given
        self.assertTrue(_within_own_checkout(agent, "src/a.py"))
        self.assertTrue(_within_own_checkout(agent, str(root / "src" / "a.py")))
        self.assertFalse(_within_own_checkout(agent, str(outside / "b.py")),
                         "a write into the parent's tree is not the child's to skip")

    def test_close_never_calls_a_cancelled_turn_idle(self):
        from dgc.headless import Backend
        backend = object.__new__(Backend)
        backend.agent = type("A", (), {"stopping": False, "cancelled": __import__("threading").Event(),
                                       "mcp": None})()
        backend._queue = []
        backend._worker = backend._foreground_worker = None
        backend.pending = __import__("dgc.headless", fromlist=["PendingRequests"]).PendingRequests()
        backend._turn_state_lock = lambda: __import__("threading").RLock()
        backend._busy = lambda: True
        self.assertEqual(backend.close(grace_s=0.0), "cancelled")   # the editor asked; a turn ran
        backend._busy = lambda: False
        self.assertEqual(backend.close(grace_s=0.0), "idle")

    def test_the_logo_glint_follows_the_canvas(self):
        import dgc.style as style_mod
        from dgc.logo import _glint, _REST
        try:
            style_mod.set_theme("light")
            light = _glint()
            style_mod.set_theme("dark")
            dark = _glint()
        finally:
            style_mod.set_theme("dark")
        self.assertNotEqual(light, dark, "a lavender glint is invisible on the white canvas")
        self.assertNotEqual(light.lower(), "#d9ccff")
        self.assertNotEqual(light, _REST)


if __name__ == "__main__":
    unittest.main()
