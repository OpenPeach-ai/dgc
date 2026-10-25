"""One process writes to a session at a time, for as long as it has it open, idle or not (dgc/session_owner.py).

The session lock used to be held only during a turn, so a terminal (`dgc -c`) could run a turn on a session a VS Code
window had open while it was idle, and both then wrote the same file. Now the process that has a session open holds
its owner lock until it lets it go, and the OS frees it when that process dies.

Real `python -m dgc serve` processes and real terminal processes, in a throwaway HOME, against a scripted model:
* a terminal's message on a session a window holds idle is refused and writes nothing (the one-shot, and the classic
  prompt, which offers Open here, a new session or quitting);
* Open here in the terminal takes it from the window when nothing runs there, and the window shows it read-only with
  the line about the terminal; while a turn runs there it says so and takes nothing;
* Open here in a window takes it from a terminal (classic), which says so; a window opening it without Open here
  shows it read-only with "Open in the terminal";
* the SDK's resume of a held session is refused, naming where it is open (the protocol, and the Python SDK);
* a crashed owner frees it, even with a command it started still running.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_session_detach import POSIX_SOCKETS, Serve, World, alive   # noqa: E402
from waiting import wait_until                                        # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
from dgc import editor_protocol as ep                                 # noqa: E402

# A terminal that holds the session: the classic prompt's own note and Open here answers (dgc/cli.py), until a window
# takes it. Prints "holding", then what it was told.
CLASSIC_HOLDER = r"""
import json, sys, time
from pathlib import Path
from dgc.cli import CLI
from dgc.config import Config
cli = CLI(Config(project_root=Path(sys.argv[1])))
cli.agent.load_session(sys.argv[2])
assert cli.agent.own_session(), "the terminal holds it"
cli._start_peer_heartbeat()
print("holding", flush=True)
deadline = time.time() + 90
while time.time() < deadline and not cli.agent.session_taken:
    time.sleep(0.1)
refused = cli.agent.run_turn("TURN_SHORT after the window took it") is False
print("RESULT " + json.dumps({"taken": cli.agent.session_taken, "line": getattr(cli, "_pending_line", ""),
                              "refused": refused, "error": getattr(cli.agent, "_last_turn_error", "")}), flush=True)
"""

# The classic prompt resuming a session another DGC holds: the choices it offers (dgc.menu.select stands in for the
# person: argv[3] is what it picks), and what happens after.
CLASSIC_RESUME = r"""
import json, sys
from pathlib import Path
import dgc.menu
from dgc.cli import CLI
from dgc.config import Config
asked = []
def select(title, labels, hints=None, initial=0):
    asked.append({"title": title, "labels": labels, "initial": initial})
    return int(sys.argv[3]) if len(asked) == 1 else 2
dgc.menu.select = select
cli = CLI(Config(project_root=Path(sys.argv[1])))
cli.agent.load_session(sys.argv[2])
owned = cli._check_owner()
result = {"owned": owned, "asked": asked, "quit": bool(getattr(cli, "_quit_requested", False)),
          "session": str(cli.agent.session_file)}
if not owned:
    result["refused"] = cli.agent.run_turn("TURN_SHORT from the terminal") is False
    result["error"] = getattr(cli.agent, "_last_turn_error", "")
print("RESULT " + json.dumps(result), flush=True)
sys.stdin.readline()                                   # hold it (if it took it) until the test is done
"""

# A process that holds the owner lock, starts a long command, and is then killed: the lock must come free.
CRASHING_OWNER = r"""
import subprocess, sys, time
from dgc import sessions
lock = sessions.owner_lock_for_file(sys.argv[1])
assert lock.acquire(blocking=False)
child = subprocess.Popen(["sleep", "60"])
print(child.pid, flush=True)
time.sleep(120)
"""


@unittest.skipUnless(POSIX_SOCKETS, "the attach socket and the owner lock's tests run on Linux and macOS")
class SessionOwnerTests(unittest.TestCase):
    maxDiff = None

    def window(self, world, name="window-a", editor="Cursor", *, env=None):
        """A window's DGC with an idle session it ran one turn in."""
        serve = Serve(world, env, name=name)
        ready = serve.wait(lambda e: e.get("type") == "ready", 90)
        self.assertEqual(ready["capabilities"]["session_owner"], 1)
        serve.send({"type": "set_detach", "keep_running": True})
        serve.send({"type": "editor_app", "name": editor})
        serve.send({"type": "watch_session_owner"})
        serve.send({"type": "editor_state", "source": "renderer", "view": "open"})
        return serve, ready

    def idle_session(self, world, serve, ready):
        serve.send({"type": "prompt", "text": "TURN_SHORT go", "request_id": "p1"})
        serve.wait(lambda e: e.get("type") == "turn_end", 90)
        session_id = ready["session_id"]
        path = world.session_file(session_id)
        self.assertIsNotNone(path)
        wait_until(lambda: any(c.get("session_id") == session_id for c in
                               (((world.note(serve.proc.pid) or {}).get("open_here") or {}).get("chats") or [])),
                   timeout=20, what="the window's note to say it holds the session")
        return session_id, path

    def helper(self, world, script, *args, stdin=True):
        proc = subprocess.Popen([sys.executable, "-c", script, *map(str, args)], cwd=str(world.work), env=world.env,
                                stdin=subprocess.PIPE if stdin else subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        self.addCleanup(self._end, proc)
        return proc

    @staticmethod
    def _end(proc):
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=10)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass

    def result_of(self, proc, timeout=120):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if line.startswith("RESULT "):
                return json.loads(line[len("RESULT "):])
        self.fail(f"no result; stderr: {proc.stderr.read()[-3000:] if proc.poll() is not None else ''}")

    # ---- a terminal on a session a window holds, idle -----------------------------------------------------------
    def test_a_terminal_message_on_a_session_a_window_holds_idle_writes_nothing(self):
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        before = path.read_bytes()
        out = world.dgc("-c", "-p", "TURN_SHORT from the terminal", timeout=120)
        said = " ".join((out.stdout + out.stderr).split())
        self.assertNotEqual(out.returncode, 0, said)
        self.assertIn(f"This session is open in Cursor · {world.work.name} · idle", said)
        self.assertEqual(path.read_bytes(), before, "nothing written behind the window")
        self.assertNotIn("from the terminal", path.read_text())

    def test_the_classic_prompt_offers_the_choices_and_writes_nothing(self):
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        before = path.read_bytes()
        proc = self.helper(world, CLASSIC_RESUME, world.work, path, 2)          # it picks Quit
        result = self.result_of(proc)
        self.assertFalse(result["owned"])
        self.assertTrue(result["quit"])
        self.assertEqual(result["asked"][0]["initial"], 1, "Enter alone starts a new session, never takes it")
        labels = result["asked"][0]["labels"]
        self.assertEqual(labels, ["Open here — move it into this terminal; Cursor shows it read-only",
                                  "Start a new session — this one stays open in Cursor",
                                  "Quit — leave it as it is"])
        self.assertTrue(result["refused"])
        self.assertIn("This session is open in Cursor", result["error"])
        self.assertEqual(path.read_bytes(), before)
        # A new session instead: a session of its own, the window's untouched.
        proc = self.helper(world, CLASSIC_RESUME, world.work, path, 1)
        result = self.result_of(proc)
        self.assertTrue(result["owned"])
        self.assertNotEqual(Path(result["session"]).stem, session_id)
        self.assertEqual(path.read_bytes(), before)

    def test_open_here_in_the_terminal_takes_it_and_the_window_goes_read_only(self):
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        proc = self.helper(world, CLASSIC_RESUME, world.work, path, 0)          # it picks Open here
        result = self.result_of(proc)
        self.assertTrue(result["owned"], result)
        self.assertEqual(result["session"], str(path))
        held = a.wait(lambda e: e.get("type") == "session_held", 30)
        self.assertEqual(held["session_id"], session_id)
        # The window: read-only, and its bar says the terminal has it.
        wait_until(lambda: (((world.note(proc.pid) or {}).get("open_here") or {}).get("chats") or []),
                   timeout=20, what="the terminal's note to say it holds the session")
        a.send({"type": "session_holder", "request_id": "h1", "session_id": session_id})
        told = a.wait(lambda e: e.get("type") == "session_holder" and e.get("request_id") == "h1", 30)
        self.assertEqual({k: told.get(k) for k in ("found", "editor", "windowless", "folder", "working")},
                         {"found": True, "editor": "the terminal", "windowless": False, "folder": world.work.name,
                          "working": False})
        # Nothing the window sends writes it now.
        before = path.read_bytes()
        a.send({"type": "prompt", "text": "TURN_SHORT from the window", "request_id": "p2"})
        refused = a.wait(lambda e: e.get("type") == "error" and "Open here moved this session" in e.get("message", ""), 60)
        self.assertIn("open in the terminal", refused["message"])
        self.assertEqual(path.read_bytes(), before)
        for event in a.events:
            self.assertIsNone(ep.event_error(event), event)

    def test_open_here_in_the_terminal_waits_while_a_turn_runs_there(self):
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p2"})
        a.wait(lambda e: e.get("type") == "text_delta" and e.get("seq", 0) > 0 and "f" in e.get("text", ""), 60)
        proc = self.helper(world, CLASSIC_RESUME, world.work, path, 0)
        result = self.result_of(proc)
        self.assertFalse(result["owned"])
        self.assertEqual(len(result["asked"]), 2, "told why, then asked again")
        self.assertFalse(any(e.get("type") == "session_held" for e in a.events), "the window keeps it")
        self.assertTrue(alive(a.proc.pid))

    # ---- a window on a session a terminal holds ---------------------------------------------------------------------
    def test_a_window_shows_a_terminal_held_session_read_only_and_open_here_takes_it(self):
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        a.send({"type": "shutdown"})
        a.proc.wait(timeout=30)
        terminal = self.helper(world, CLASSIC_HOLDER, world.work, path)
        self.assertEqual(terminal.stdout.readline().strip(), "holding")
        wait_until(lambda: (((world.note(terminal.pid) or {}).get("open_here") or {}).get("chats") or []),
                   timeout=20, what="the terminal's note")
        # Opened in a window without Open here: read-only, and where it is open.
        b, b_ready = self.window(world, "window-b", "VS Code",
                                 env={"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "auto"})
        b.send({"type": "resume_session", "path": f"{session_id}.json", "request_id": "r"})
        b.wait(lambda e: e.get("type") == "session" and e.get("request_id") == "r", 60)
        b.wait(lambda e: e.get("type") == "session_held" and e.get("session_id") == session_id, 30)
        b.send({"type": "session_holder", "request_id": "h", "session_id": session_id})
        told = b.wait(lambda e: e.get("type") == "session_holder" and e.get("request_id") == "h", 30)
        self.assertEqual((told["found"], told["editor"]), (True, "the terminal"))
        b.stop()
        # Open here in the window: the terminal lets it go and says so; the window writes to it.
        c, c_ready = self.window(world, "window-c", "VS Code",
                                 env={"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "steal"})
        self.assertNotIn("elsewhere", c_ready["capabilities"].get("detach", {}))
        c.send({"type": "resume_session", "path": f"{session_id}.json", "request_id": "r"})
        c.wait(lambda e: e.get("type") == "session" and e.get("request_id") == "r", 60)
        c.send({"type": "prompt", "text": "TURN_SHORT from the window", "request_id": "p3"})
        c.wait(lambda e: e.get("type") == "turn_end", 90)
        self.assertFalse(any(e.get("type") == "session_held" for e in c.events))
        self.assertIn("from the window", path.read_text())
        said = self.result_of(terminal)
        self.assertEqual(said["taken"], "the editor")
        self.assertIn("This session is open in the editor now", said["line"])
        self.assertTrue(said["refused"], "the terminal takes no more prompts for it")
        self.assertIn("Open here moved this session", said["error"])
        for serve in (b, c):
            for event in serve.events:
                self.assertIsNone(ep.event_error(event), event)

    # ---- the SDK --------------------------------------------------------------------------------------------------
    def test_a_resume_from_a_client_that_does_not_show_it_read_only_is_refused_naming_where(self):
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        before = path.read_bytes()
        sdk = Serve(world, name="sdk")                         # what the SDK runs: it never sends watch_session_owner
        sdk.wait(lambda e: e.get("type") == "ready", 90)
        sdk.send({"type": "resume_session", "path": f"{session_id}.json", "request_id": "r"})
        refused = sdk.wait(lambda e: e.get("type") == "command_rejected" and e.get("request_id") == "r", 60)
        self.assertEqual(refused["reason"], "session_held")
        self.assertIn(f"This session is open in Cursor · {world.work.name} · idle", refused["message"])
        self.assertFalse(any(e.get("type") == "session" and e.get("request_id") == "r" for e in sdk.events))
        sdk.send({"type": "prompt", "text": "TURN_SHORT from the sdk", "request_id": "p"})
        sdk.wait(lambda e: e.get("type") == "turn_end", 90)
        self.assertEqual(path.read_bytes(), before, "its own new session, never the window's")
        self.assertIsNone(ep.event_error(refused))

    def test_the_python_sdk_resume_of_a_held_session_raises_naming_where(self):
        sys.path[:0] = [str(ROOT / "sdk" / "python")]
        from dgc_sdk import DGC, DGCConfigError
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        before = path.read_bytes()
        state = Path(tempfile.mkdtemp(prefix="dgc-sdk-state-", dir="/tmp"))
        old = os.environ.get("HOME")
        os.environ["HOME"] = str(world.home)
        try:
            with DGC(state_dir=state, inherit_user_state=True) as client:
                with self.assertRaises(DGCConfigError) as caught:
                    client.resume(session_id, cwd=world.work)
        finally:
            if old is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old
        self.assertIn(f"This session is open in Cursor · {world.work.name}", str(caught.exception))
        self.assertEqual(path.read_bytes(), before)

    # ---- a dead owner ---------------------------------------------------------------------------------------------
    def test_a_crashed_owner_frees_it_even_with_a_command_it_started_still_running(self):
        world = World(self, scale=1.0)
        a, ready = self.window(world)
        session_id, path = self.idle_session(world, a, ready)
        a.send({"type": "shutdown"})
        a.proc.wait(timeout=30)
        owner = self.helper(world, CRASHING_OWNER, path, stdin=False)
        child = int(owner.stdout.readline())
        self.addCleanup(lambda: alive(child) and os.kill(child, signal.SIGKILL))
        out = world.dgc("-c", "-p", "TURN_SHORT while it lives", timeout=120)
        self.assertNotEqual(out.returncode, 0, "held while its owner lives")
        os.kill(owner.pid, signal.SIGKILL)
        owner.wait(timeout=10)
        self.assertTrue(alive(child), "the command it started still runs")
        out = world.dgc("-c", "-p", "TURN_SHORT after it died", timeout=120)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("after it died", path.read_text())


if __name__ == "__main__":
    unittest.main()
