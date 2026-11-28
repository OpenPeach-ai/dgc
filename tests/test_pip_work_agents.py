"""A sub-agent with Work tools, from a Pip's chat (0.52, decided 14 Nov).

For a fix its copy can't do (it needs what Git ignores, like .env, or a service to run), a Pip's sub-agent may be a
real Work run on the REAL project folder: a `dgc -p --output-format json --mode auto` child the Pips runner starts, on
the Pip's Sub-agents model, with auto mode's safety check on. It is shown in the Pip's chat (its agent map) and never in
the Work sessions list: its session lives in the job's own folder. Its steps feed the agent map row; the Pip checks what
it changed in the folder (from the session's checkpoints); PASS ends it done with Undo (Work's own rule: never over a
file the user changed since); RETRY continues the same session. The user's press is the yes at every level; the Pip
starts one by itself only at Do it all.

Real registry, real runs claimed and run through the Pips runner's own path (pips._run_claimed), a real `dgc -p` child
against a local stand-in model (an OpenAI-compatible server in this process).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from dgc import pip_agents, pip_chat, pip_fixes as fixes, pip_levels as levels, pips
from tests.test_pip_agents import AgentWorld, PASS
from tests.test_pip_fixes import TOTAL

KEY = "sk-work-agent-NEVER-SHOWN-7f3a91c2"
INTENT = "You are DGC's safety check"
NEW_APP = "def total(items, discount=0):\n    return sum(items) - discount\n"
NEW_UTIL = "X = 2\n"
WORK_RETRY = "Not yet: the discount can go below zero.\nRESULT: RETRY — clamp the total at zero"


def sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "choices": [
        {"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


def sse_text(text):
    return sse({"content": text}) + sse({}, "stop") + "data: [DONE]\n\n"


def sse_call(name, arguments, call_id):
    return (sse({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                 "function": {"name": name, "arguments": json.dumps(arguments)}}]})
            + sse({}, "tool_calls") + "data: [DONE]\n\n")


class Model:
    """A local OpenAI-compatible stand-in for the Pip's Sub-agents model. What it does follows the job DGC sends it
    (a SCENARIO word in the job's text); the safety check's own question it answers YES only when the user's own
    messages ask to delete the old data folder."""

    def __init__(self):
        self.requests: list = []
        self.headers: list = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, body, kind):
                data = body.encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", kind)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

            def do_GET(self):
                self._send(json.dumps({"data": [{"id": "stub-model"}]}), "application/json")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                owner.requests.append(body)
                owner.headers.append(dict(self.headers))
                self._send(owner.answer(body), "text/event-stream")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def intent_questions(self):
        return [b for b in self.requests if str((b.get("messages") or [{}])[0].get("content") or "").startswith(INTENT)]

    def answer(self, body):
        messages = body.get("messages") or []
        system = str(messages[0].get("content") or "") if messages else ""
        if system.startswith(INTENT):
            asked = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "user")
            theirs = asked.split("<user_messages>", 1)[-1].split("</user_messages>", 1)[0]
            return sse_text("YES" if "delete the old data folder" in theirs.lower() else "NO")
        if not body.get("tools"):
            return sse_text("Work on the shop")                     # a title, a summary: anything without tools
        last = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
        users = [str(m.get("content") or "") for m in messages if m.get("role") == "user"]
        now = users[-1] if users else ""
        results = [str(m.get("content") or "") for m in messages[last + 1:] if m.get("role") == "tool"]
        said = " ".join(str(m.get("content") or "") for m in messages[:last] if m.get("role") == "assistant")
        if "Try 2 of 3" in now:
            return sse_text("SECOND-TRY-SAW-FIRST" if "FIRST-TRY-DONE" in said else "SECOND-TRY-BLIND")
        job = users[0] if users else ""
        if "SCENARIO: edit" in job or "Total ignores the discount" in job:      # (a fix's own brief, too)
            if len(results) == 0:
                return sse_call("write_file", {"path": "app.py", "content": NEW_APP}, "c-app")
            if len(results) == 1:
                return sse_call("write_file", {"path": "util.py", "content": NEW_UTIL}, "c-util")
            return sse_text("FIRST-TRY-DONE: total takes the discount off, and X is 2.\nFINDING 1: fixed — the discount")
        if "SCENARIO: env" in job:
            if len(results) == 0:
                return sse_call("read_file", {"path": ".env"}, "c-env")
            if len(results) == 1:
                return sse_call("write_file", {"path": "settings.py", "content": "LOADED = True\n"}, "c-set")
            return sse_text("ENV-READ: settings load from .env now.")
        if "SCENARIO: risky" in job:
            if len(results) == 0:
                return sse_call("bash", {"command": "rm -rf data"}, "c-rm")
            return sse_text("RISKY-RESULT: " + results[0].splitlines()[0][:300] if results[0] else "RISKY-RESULT: (none)")
        if "SCENARIO: slow" in job:
            if len(results) == 0:
                return sse_call("bash", {"command": "sleep 307 && echo slept-dgc-work-test"}, "c-slow")
            return sse_text("SLOW-DONE")
        return sse_text("Nothing to do.")


_REAL_POPEN = subprocess.Popen          # (the tests record what the Pip starts by patching subprocess.Popen itself)


def _ps(*args) -> str:
    """ps's answer, never among the commands a test records."""
    with _REAL_POPEN(["ps", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as proc:
        return proc.communicate()[0]


def process_alive(pid) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    if not Path("/proc").is_dir():                        # a Mac: ps says whether it is a zombie
        state = _ps("-o", "stat=", "-p", str(pid)).strip()
        return bool(state) and not state.startswith("Z")
    try:                                                  # a zombie is gone too
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        return state != "Z"
    except (OSError, IndexError):
        return True


def sleepers() -> list[int]:
    found = []
    if not Path("/proc").is_dir():                        # a Mac has no /proc (GitHub's macOS runner, 27 Nov): ps
        listed = _ps("-axo", "pid=,command=")
        for line in listed.splitlines():
            pid, _, cmd = line.strip().partition(" ")
            if pid.isdigit() and "sleep 307" in cmd and process_alive(int(pid)):
                found.append(int(pid))
        return found
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                cmd = (entry / "cmdline").read_bytes().replace(b"\x00", b" ")
            except OSError:
                continue
            if b"sleep 307" in cmd and process_alive(int(entry.name)):
                found.append(int(entry.name))
    return found


class WorkWorld(AgentWorld):
    """A folder Pip ("Shop helper" in shop/, a Git project with a .env it ignores) whose Sub-agents model is a local
    stand-in, and the user's own DGC home (where Work's sessions live) beside it."""

    def setUp(self):
        super().setUp()
        self.model = Model()
        self.addCleanup(self.model.close)
        self.cfg.data.update(base_url=self.model.url, model="stub-model", api_mode="chat_completions")
        self.cfg.set_runtime_secret("api_key", KEY)
        keyed = patch.dict(os.environ, {"DGC_API_KEY": KEY})       # the user's key, as their own DGC holds it
        keyed.start()
        self.addCleanup(keyed.stop)
        self.user_home = Path(os.environ["HOME"])
        (self.user_home / ".dgc").mkdir(parents=True, exist_ok=True)
        # The user's saved route (a run pins the saved connection) and what their own DGC reads in the child.
        (self.user_home / ".dgc" / "config.json").write_text(json.dumps({
            "model": "stub-model", "base_url": self.model.url, "api_mode": "chat_completions",
            "suggest": False, "eta": False, "notes": False, "artifact_autostart": False, "plan_artifact": False}))
        (self.root / "data").mkdir()
        (self.root / "data" / "old.csv").write_text("a,b\n1,2\n")
        self.argv: list = []
        # The Work runs among what was started: on a Mac DGC also asks `ps -o lstart= -p <pid>` (no /proc there).
        self.work_runs = lambda: [a for a in self.argv if "-p" in a and "--output-format" in a]
        real = subprocess.Popen
        owner = self

        def popen(args, *a, **k):
            owner.argv.append([str(x) for x in args])
            return real(args, *a, **k)
        recorder = patch("dgc.pip_work_agents.subprocess.Popen", side_effect=popen)
        recorder.start()
        self.addCleanup(recorder.stop)
        self.addCleanup(self._no_sleepers_left)

    def _no_sleepers_left(self):
        for pid in sleepers():
            try:
                os.kill(pid, 9)
            except OSError:
                pass

    def start(self, scenario="edit", words=None, fix_id=None, title="Load settings from .env"):
        return pip_agents.start(self.store, self.cfg, self.helper["id"], kind="work", title=title,
                                brief=f"Make the shop load its settings. SCENARIO: {scenario}", fix_id=fix_id,
                                words=words)

    def run_next(self):
        """The runner's own path: the next queued run is claimed, run and finished (pips._run_claimed)."""
        row = self.store.claim_next()
        self.assertIsNotNone(row, "a run was queued")
        pips._run_claimed(self.registry, self.store, row, self.cfg, self.registry.directory)
        return row

    def work_job(self):
        if not self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='pip_agent_jobs'").fetchone():
            return None
        return self.registry.db.execute("SELECT * FROM pip_agent_jobs WHERE kind='work' ORDER BY created_at DESC, "
                                        "rowid DESC LIMIT 1").fetchone()

    def job_sessions(self, job=None):
        from dgc import pip_work_agents as work
        job = job or self.work_job()
        folder = work.sessions_dir(self.registry, job["pip_id"], job["id"])
        return sorted(folder.rglob("*.json")) if folder.is_dir() else []

    def user_sessions(self):
        folder = self.user_home / ".dgc" / "sessions"
        return sorted(folder.rglob("*.json")) if folder.is_dir() else []

    def check_ends(self, text=PASS):
        self.send()
        row = self.store.claim_next()
        self.assertIsNotNone(row, "the Pip's check was queued in its chat")
        self.assertNotIn("agent", json.loads(row["manifest"]))
        self.store.finish(row["id"], result={"text": text})
        return row["id"]


class AWorkJobRunsInTheRealFolder(WorkWorld, unittest.TestCase):
    def test_it_works_in_the_real_folder_and_its_session_is_its_own(self):
        before = (self.root / "app.py").read_text()
        self.start("edit")
        job = self.work_job()
        self.assertEqual((job["kind"], job["state"], job["tries"]), ("work", "working", 1))
        self.assertIsNone(job["copy"], "no copy: it works in the folder itself")
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (job["run_id"],)).fetchone()[0])
        self.assertIs(manifest["agent"]["work"], True)
        self.run_next()
        self.assertEqual((self.root / "app.py").read_text(), NEW_APP, "the change is in the real folder")
        self.assertNotEqual(before, NEW_APP)
        self.assertEqual(self.work_job()["state"], "check_due")
        self.assertIn("FIRST-TRY-DONE", self.work_job()["said"])
        self.assertEqual(self.user_sessions(), [], "never in the user's Work sessions")
        self.assertEqual(len(self.job_sessions()), 1, "its session is in the job's own folder")
        listed = self.control("list_pip_agents", pip_id=self.helper["id"])
        [row] = [a for a in listed["agents"] if a["id"] == job["id"]]
        self.assertEqual(row["kind"], "work")
        self.assertEqual(row["model"], "stub-model", "the Pip's Sub-agents model")
        self.assertEqual(sorted(f["path"] for f in row["changed"]), ["app.py", "util.py"])

    def test_it_reaches_what_git_ignores(self):
        self.start("env")
        self.run_next()
        self.assertEqual((self.root / "settings.py").read_text(), "LOADED = True\n")
        steps = self.store.run_activity(self.work_job()["run_id"])["events"]
        tools = [e["payload"].get("tool") for e in steps if e["event_type"] == "pip_run_progress"
                 and e["payload"].get("kind") == "tool_call"]
        self.assertIn("read_file", tools, "its steps feed the agent map row")
        self.assertIn("write_file", tools)

    def test_the_child_is_a_real_work_run_on_the_sub_agents_model(self):
        self.start("edit")
        self.run_next()
        [argv] = self.work_runs()
        for flag in ("--output-format", "--mode", "--model", "--base-url", "--api-key-env", "--engine"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--mode") + 1], "auto")
        self.assertEqual(argv[argv.index("--model") + 1], "stub-model")
        self.assertEqual(argv[argv.index("--base-url") + 1], self.model.url)
        self.assertEqual(argv[argv.index("--engine") + 1], "native", "never the user's subscription CLI")
        self.assertTrue(self.model.requests, "the stand-in model answered it")
        self.assertTrue(any(h.get("Authorization") == f"Bearer {KEY}" for h in self.model.headers),
                        "the Sub-agents key reached its model")

    def test_an_untrusted_folder_is_trusted_for_this_run_only(self):
        # (Decided 18 Nov: the press, or Do it all, is the yes to this run in this folder; it never makes
        # the folder trusted for the user's own Work afterwards. `--trust` would have saved it in their config.)
        config_file = self.user_home / ".dgc" / "config.json"
        before = json.loads(config_file.read_text())
        self.start("edit")
        self.run_next()
        [argv] = self.work_runs()
        self.assertNotIn("--trust", argv)
        self.assertEqual(self.work_job()["state"], "check_due", "the run worked in the untrusted folder")
        after = json.loads(config_file.read_text())
        self.assertNotIn(os.path.realpath(self.root), [os.path.realpath(d) for d in after.get("trusted_dirs", [])],
                         "the folder isn't saved as trusted")
        self.assertEqual(after.get("trusted_dirs"), before.get("trusted_dirs"))

    def test_a_subscription_cli_or_the_router_is_refused(self):
        from dgc.workspace_registry import RegistryError
        with patch.object(pip_agents, "agents_model", return_value={
                "model_choice": {"mode": "subscription", "engine": "claude"}, "thinking": "", "context_size": 0,
                "fallback": {"provider": "", "model": ""}}), \
             patch.object(pips, "_model_settings", return_value={"model": "Claude Code", "brain": {"engine": "claude"}}):
            with self.assertRaises(RegistryError):
                self.start("edit")


class TheSafetyCheckReadsTheUsersOwnWords(WorkWorld, unittest.TestCase):
    def test_a_risky_step_from_dgcs_brief_is_stopped(self):
        # DGC's brief says to delete the old data folder; the user said nothing: the step is stopped.
        pip_agents.start(self.store, self.cfg, self.helper["id"], kind="work", title="Clean up",
                         brief="Delete the old data folder, it is stale. SCENARIO: risky", words=[])
        self.run_next()
        self.assertTrue((self.root / "data" / "old.csv").is_file(), "nothing was deleted")
        self.assertIn("BLOCKED by DGC's safety check", self.work_job()["said"])
        for body in self.model.intent_questions():
            theirs = str(body["messages"][1]["content"]).split("<user_messages>", 1)[-1].split("</user_messages>", 1)[0]
            self.assertNotIn("delete the old data folder", theirs.lower(), "DGC's brief is never the user's words")

    def test_the_same_step_asked_in_the_users_own_words_runs(self):
        pip_agents.start(self.store, self.cfg, self.helper["id"], kind="work", title="Clean up",
                         brief="Clean up what the user asked. SCENARIO: risky",
                         words=["Please delete the old data folder, we don't use it any more."])
        self.run_next()
        self.assertFalse((self.root / "data").exists(), "the user's own words asked for it")
        self.assertNotIn("BLOCKED", self.work_job()["said"])

    def test_the_users_words_are_quoted_as_theirs_and_dgcs_as_dgcs(self):
        self.start("edit", words=["Fix the discount, it needs the .env"])
        job = self.work_job()
        text = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (job["run_id"],)).fetchone()[0])["conversation"]["text"]
        self.assertIn("This message is from DGC, not the user", text)
        self.assertIn("Fix the discount, it needs the .env", text)
        self.assertLess(text.index("This message is from DGC"), text.index("Fix the discount"))


class PassUndoAndRetry(WorkWorld, unittest.TestCase):
    def test_the_pips_check_reads_what_changed_in_the_real_folder(self):
        self.start("edit")
        self.run_next()
        self.send()
        message = self.registry.db.execute("SELECT text,request_key FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                           "ORDER BY seq DESC LIMIT 1", (self.helper["id"],)).fetchone()
        self.assertTrue(message["request_key"].startswith(pip_agents.CHECK_KEY))
        self.assertIn("+    return sum(items) - discount", message["text"], "the change, from its checkpoints")
        self.assertIn("-X = 1", message["text"])
        self.assertIn("real folder", message["text"], "the Pip is told it is already in the folder")

    def test_pass_is_done_with_undo_and_undo_puts_the_folder_back(self):
        app, util = (self.root / "app.py").read_text(), (self.root / "util.py").read_text()
        self.start("edit")
        self.run_next()
        self.check_ends(PASS)
        job = self.work_job()
        self.assertEqual(job["state"], "merged")
        listed = [a for a in self.control("list_pip_agents", pip_id=self.helper["id"])["agents"] if a["id"] == job["id"]][0]
        self.assertTrue(listed["can_undo"], "done, with Undo")
        self.assertEqual((self.root / "app.py").read_text(), NEW_APP, "already in the folder: no Apply")
        out = self.control("undo_pip_agent_job", pip_id=self.helper["id"], job_id=job["id"])
        self.assertEqual(((self.root / "app.py").read_text(), (self.root / "util.py").read_text()), (app, util))
        self.assertEqual(sorted(out["undo"]["restored"]), ["app.py", "util.py"])
        self.assertEqual(out["undo"]["left"], [])
        self.assertFalse(out["agent"]["can_undo"])
        with self.assertRaises(Exception):
            self.control("undo_pip_agent_job", pip_id=self.helper["id"], job_id=job["id"])

    def test_undo_never_overwrites_a_file_the_user_changed_since(self):
        util = (self.root / "util.py").read_text()
        self.start("edit")
        self.run_next()
        self.check_ends(PASS)
        (self.root / "app.py").write_text("# yours now\n")
        out = self.control("undo_pip_agent_job", pip_id=self.helper["id"], job_id=self.work_job()["id"])
        self.assertEqual((self.root / "app.py").read_text(), "# yours now\n", "never over your edit")
        self.assertEqual((self.root / "util.py").read_text(), util, "the rest is put back")
        self.assertEqual([f["path"] for f in out["undo"]["left"]], ["app.py"], "named, and left as it is")

    def test_retry_continues_the_same_session(self):
        self.start("edit")
        self.run_next()
        [session] = self.job_sessions()
        self.check_ends(WORK_RETRY)
        self.assertEqual(self.work_job()["state"], "retry_due")
        self.send()
        self.assertEqual(self.work_job()["tries"], 2)
        self.run_next()
        self.assertEqual(self.job_sessions(), [session], "the same session, continued")
        self.assertIn("SECOND-TRY-SAW-FIRST", self.work_job()["said"], "the second turn sees the first")
        second = self.work_runs()[-1]
        self.assertEqual(second[second.index("--resume") + 1], session.stem)
        self.assertIn("clamp the total at zero", self.model.requests[-1]["messages"][-1]["content"])

    def test_the_fix_it_came_from_ends_applied_with_that_undo(self):
        self.check([TOTAL])
        fix = self.one()
        answer = self.control("start_pip_work_helper", pip_id=self.helper["id"], fix_id=fix["id"])
        self.assertEqual(answer["fix"]["state"], "running")
        self.assertEqual(self.work_job()["fix_id"], fix["id"])
        self.run_next()
        self.check_ends(PASS)
        fix = self.one()
        self.assertEqual(fix["state"], "applied", "as a fix applied at Do it all ends")
        self.assertEqual(fix["agent"]["kind"], "work")
        self.assertTrue(fix["agent"]["can_undo"])
        self.assertIn("discount", fix["message"])


class StopAndRestart(WorkWorld, unittest.TestCase):
    def wait_for(self, what, seconds=60):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if what():
                return True
            time.sleep(0.1)
        return False

    def test_stop_ends_the_child_and_what_it_started(self):
        from dgc import pip_work_agents as work
        self.start("slow")
        job = self.work_job()
        row = self.store.claim_next()

        def runner():                                   # its own registry connection, as each runner thread has
            with self.registry.__class__(self.registry.directory) as registry:
                pips._run_claimed(registry, pips.PipStore(registry), row, self.cfg, self.registry.directory)
        thread = threading.Thread(target=runner, daemon=True)
        thread.start()
        self.assertTrue(self.wait_for(lambda: sleepers()), "its command started")
        pid = work.state(self.registry.db, job["id"]).get("pid")
        self.assertTrue(pid and process_alive(pid))
        pip_agents.stop(self.store, self.helper["id"], job["id"], "editor-user")
        thread.join(60)
        self.assertFalse(thread.is_alive(), "the run ended")
        self.assertFalse(process_alive(pid), "the child is gone")
        self.assertTrue(self.wait_for(lambda: not sleepers(), 15), "and the command it ran")
        self.assertEqual(self.work_job()["state"], "stopped")

    def test_a_run_that_goes_quiet_is_stopped_and_says_why(self):
        # Nothing from it for longer than any one command may run (Work's foreground limit is an hour): stuck. It is
        # ended with everything it started, and the job says so in plain words.
        from dgc import pip_work_agents as work
        with patch.object(work, "QUIET_SECONDS", 3.0):
            self.start("slow")
            self.run_next()
        job = self.work_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("went quiet", job["said"])
        deadline = time.monotonic() + 10
        while sleepers() and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertEqual(sleepers(), [], "what it started was ended too")

    def test_its_quiet_limit_outlasts_the_longest_command(self):
        from dgc import pip_work_agents as work
        from dgc.tools import MAX_BASH_TIMEOUT_S
        self.assertGreater(work.QUIET_SECONDS, MAX_BASH_TIMEOUT_S + 10 * 60)

    def test_a_runner_restart_says_it_was_stopped(self):
        self.start("edit")
        row = self.store.claim_next()                  # it was running when the runner went away
        self.store.recover()
        status = self.registry.db.execute("SELECT status FROM pip_runs WHERE id=?", (row["id"],)).fetchone()[0]
        self.assertEqual(status, "failed", "a Work run is never run again by itself")
        self.send()
        job = self.work_job()
        self.assertEqual(job["state"], "stopped", "never left working forever")
        self.assertIn("restart", job["said"].lower())


class WhoStartsIt(WorkWorld, unittest.TestCase):
    def test_the_fix_card_press_works_at_ask_me_first(self):
        self.assertEqual(levels.level(self.registry, self.helper["id"]), levels.ASK)
        self.check([TOTAL])
        fix = self.one()
        self.assertEqual(fix["state"], "ask")
        answer = self.control("start_pip_work_helper", pip_id=self.helper["id"], fix_id=fix["id"])
        job = self.work_job()
        self.assertEqual((job["kind"], job["fix_id"]), ("work", fix["id"]))
        self.assertEqual(answer["fix"]["by"], "you", "the press is the yes")
        from dgc import pip_work_agents as work
        self.assertTrue(work.state(self.registry.db, job["id"])["words"], "the press is quoted as the user's")

    def test_only_you_press_it(self):
        self.check([TOTAL])
        with self.assertRaises(Exception):
            self.control("start_pip_work_helper", actor="device_1", pip_id=self.helper["id"], fix_id=self.one()["id"])

    def pinned(self, *, level=levels.FULL, agent=False, personal=False):
        from dgc import pip_work_agents as work
        self.choose(level)
        pip = self.pip if personal else self.helper
        sent = pip_chat.send(self.store, pip["id"], "The settings won't load: fix it", "m-" + str(time.monotonic_ns()),
                             "editor-user", self.cfg)
        row = self.registry.db.execute("SELECT * FROM pip_runs WHERE id=?", (sent["run"]["id"],)).fetchone()
        manifest = json.loads(row["manifest"])
        if agent:
            manifest = {**manifest, "agent": {"job_id": "pipagent_" + "a" * 32, "try": 1}}
        return work.runtime(self.registry, dict(row), manifest)

    def test_the_pips_own_tool_is_offered_only_at_do_it_all_in_a_folder_pip(self):
        from dgc import pip_work_agents as work
        self.assertIn(work.PIN, self.pinned(level=levels.FULL))
        self.assertNotIn(work.PIN, self.pinned(level=levels.APPROVE))
        self.assertNotIn(work.PIN, self.pinned(level=levels.ASK))
        self.assertNotIn(work.PIN, self.pinned(level=levels.FULL, agent=True), "never inside a sub-agent's own run")

    def test_the_worker_offers_it_with_the_pin_and_hands_it_to_the_supervisor(self):
        from dgc import pip_work_agents as work
        from dgc.llm import ChatResult, LLMClient, ToolCall
        manifest = self.pinned(level=levels.FULL)
        seen, calls = {}, []

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen.setdefault("tools", {t["function"]["name"] for t in tools or []})
            calls.append(messages[-1])
            if len(calls) == 1:
                return ChatResult(content="", tool_calls=[ToolCall("w1", work.TOOL, {
                    "title": "Load settings from .env", "brief": "The settings loader needs the real .env."})],
                    finish_reason="tool_calls")
            return ChatResult(content="I started a sub-agent with Work tools on your folder.")
        events = []
        # (The stand-in model answers what the client asks of the server itself, its window; the turn is `chat`.)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}):
            result = pips.execute_native(self.cfg, self.root, manifest, events.append)
        self.assertIn(work.TOOL, seen["tools"])
        self.assertEqual(result["work_subagents"][0]["title"], "Load settings from .env")
        unpinned = {k: v for k, v in manifest.items() if k != work.PIN}
        seen.clear(); calls.clear()
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", lambda client, messages, tools=None, **k: seen.setdefault(
                 "tools", {t["function"]["name"] for t in tools or []}) and ChatResult(content="ok")), \
             patch("dgc.agent.discover_skills", return_value={}):
            pips.execute_native(self.cfg, self.root, unpinned, events.append)
        self.assertNotIn(work.TOOL, seen["tools"], "below Do it all it is not offered")

    def test_a_reply_that_started_one_starts_it_on_the_next_tick(self):
        from dgc import pip_work_agents as work
        self.choose(levels.FULL)
        sent = pip_chat.send(self.store, self.helper["id"], "The settings won't load: fix it", "m-tick", "editor-user", self.cfg)
        row = self.store.claim_next()
        self.assertEqual(row["id"], sent["run"]["id"])
        self.store.finish(row["id"], result={"text": "I started a sub-agent with Work tools.", "work_subagents": [
            {"title": "Load settings from .env", "brief": "The loader needs the real .env. SCENARIO: env"}]})
        job = self.work_job()
        self.assertIsNotNone(job, "kept as the reply was kept")
        self.assertEqual(job["state"], "queued")
        self.send()
        job = self.work_job()
        self.assertEqual(job["state"], "working")
        self.assertEqual(work.state(self.registry.db, job["id"])["words"], ["The settings won't load: fix it"],
                         "the user's own message that led to it")

    def test_a_reply_below_do_it_all_starts_nothing(self):
        self.choose(levels.APPROVE)
        pip_chat.send(self.store, self.helper["id"], "The settings won't load: fix it", "m-low", "editor-user", self.cfg)
        row = self.store.claim_next()
        self.store.finish(row["id"], result={"text": "Done.", "work_subagents": [{"title": "x", "brief": "y"}]})
        self.assertIsNone(self.work_job())


class TheKeyStaysInTheChildsEnvironment(WorkWorld, unittest.TestCase):
    def test_the_key_is_in_no_command_line_log_event_or_saved_session(self):
        self.start("edit")
        self.run_next()
        self.check_ends(PASS)
        for argv in self.argv:
            self.assertFalse(any(KEY in part for part in argv), "never on a command line")
        found = []
        for path in Path(self.base).rglob("*"):
            if path.is_file() and not path.is_symlink():
                try:
                    if KEY.encode() in path.read_bytes():
                        found.append(str(path))
                except OSError:
                    pass
        self.assertEqual(found, [], "never in a file: the state, its events, its session, a log")
        events = self.registry.db.execute("SELECT payload FROM workspace_events").fetchall()
        self.assertFalse(any(KEY in str(e[0]) for e in events))


class TheChildsOwnFlags(unittest.TestCase):
    """What the child needs from `dgc -p`, for that run only: DGC's own model loop whatever route is saved (--engine
    native), the endpoint's API (--api-mode), and the user's own words apart from DGC's prompt (DGC_USER_WORDS)."""

    def test_native_and_api_mode_are_for_this_run_only(self):
        import sys
        import tempfile
        model = Model()
        self.addCleanup(model.close)
        home = Path(tempfile.mkdtemp(prefix="dgc-work-flags-"))
        work_dir = home / "ws"
        work_dir.mkdir()
        (home / ".dgc").mkdir()
        saved = {"model": "other", "base_url": "http://127.0.0.1:9/v1", "api_mode": "ollama",
                 "subscription_engine": "claude", "suggest": False, "eta": False, "notes": False}
        (home / ".dgc" / "config.json").write_text(json.dumps(saved))
        env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
               "DGC_SESSIONS_DIR": str(home / "private-sessions")}
        env.pop("DGC_HOME", None)
        done = subprocess.run([sys.executable, "-m", "dgc", "-p", "say hi", "--output-format", "json", "--engine", "native",
                               "--model", "stub-model", "--base-url", model.url, "--api-mode", "chat_completions"],
                              cwd=work_dir, env=env, capture_output=True, text=True, timeout=180, input="")
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertTrue(model.requests, "DGC's own loop answered, not the saved subscription app")
        after = json.loads((home / ".dgc" / "config.json").read_text())
        self.assertEqual({k: after.get(k) for k in saved}, saved, "nothing of this run became the saved route")
        self.assertTrue(list((home / "private-sessions").rglob("*.json")), "its session went where DGC_SESSIONS_DIR says")
        self.assertFalse((home / ".dgc" / "sessions").exists() and list((home / ".dgc" / "sessions").rglob("*.json")))

    def test_trust_for_this_run_saves_nothing(self):
        import sys
        import tempfile
        model = Model()
        self.addCleanup(model.close)
        home = Path(tempfile.mkdtemp(prefix="dgc-work-trust-"))
        work_dir = home / "ws"
        work_dir.mkdir()
        (home / ".dgc").mkdir()
        saved = {"model": "stub-model", "base_url": model.url, "api_mode": "chat_completions", "suggest": False,
                 "eta": False, "notes": False}
        (home / ".dgc" / "config.json").write_text(json.dumps(saved))
        env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
               "DGC_SESSIONS_DIR": str(home / "private-sessions")}
        env.pop("DGC_HOME", None)
        argv = [sys.executable, "-m", "dgc", "-p", "say hi", "--output-format", "json", "--mode", "auto", "--engine", "native"]
        refused = subprocess.run(argv, cwd=work_dir, env=env, capture_output=True, text=True, timeout=180, input="")
        self.assertNotEqual(refused.returncode, 0, "auto mode in an untrusted folder is refused without it")
        done = subprocess.run(argv, cwd=work_dir, env={**env, "DGC_TRUST_THIS_RUN": "1"}, capture_output=True, text=True,
                              timeout=180, input="")
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        after = json.loads((home / ".dgc" / "config.json").read_text())
        self.assertNotIn("trusted_dirs", after, "trusted for that run only: nothing saved")

    def test_the_users_own_words_are_only_what_dgc_quoted(self):
        from dgc import auto_guard
        with patch.dict(os.environ, {auto_guard.USER_WORDS_ENV: json.dumps(["delete the old data folder"])}):
            self.assertEqual(auto_guard.launcher_user_words(), ["delete the old data folder"])
        with patch.dict(os.environ, {auto_guard.USER_WORDS_ENV: "not json"}):
            self.assertEqual(auto_guard.launcher_user_words(), [], "unreadable: no words at all, never DGC's prompt")
        env = dict(os.environ)
        env.pop(auto_guard.USER_WORDS_ENV, None)
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(auto_guard.launcher_user_words(), "a prompt the user typed is theirs")

    def test_the_safety_check_runs_where_its_runner_says(self):
        from dgc import auto_holds
        with patch.object(auto_holds, "_editor_on_wire", False):
            with patch.dict(os.environ, {auto_holds.GUARD_ENV: "1"}):
                self.assertTrue(auto_holds.guard_wanted())
                self.assertFalse(auto_holds.wanted(), "only the check, not the chat's other rules")
            env = dict(os.environ)
            env.pop(auto_holds.GUARD_ENV, None)
            with patch.dict(os.environ, env, clear=True):
                self.assertFalse(auto_holds.guard_wanted())


if __name__ == "__main__":
    unittest.main()
