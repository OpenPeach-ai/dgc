"""Ask DGC to fix: a Pip's report fixed in the background of the chat it reported to.

The founder's decisions (pips-report-to-chat-decisions, 18-19 Oct, final): the fix is a BACKGROUND
sub-agent in the main chat's session -- no main turn, the user keeps chatting -- started by a new
command; the report's card is its live status; it APPLIES with Undo when it finishes, holding back a
file the user changed on the same lines; the card says what changed and whether tests ran in the fix
copy. The fix copy is ONE kept copy per project, synced (HEAD + uncommitted) before each fix, its
dependencies installed once with the project's own install command and again only when a lock file
changes; fixes run one at a time per project; a missing ignored file (.env) is asked for only when a
test needs it, remembered per project, copied never linked; copies unused for 14 days are removed;
their size is only in `dgc doctor`.

Real registry and runs (as test_pip_report_delivery), a real Backend whose frames go through the
protocol validator, a real Git project and a real kept worktree; only the model is scripted.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import pip_fix
from dgc.config import Config
from dgc.headless import Backend
from dgc.llm import ChatResult, LLMClient, ToolCall
from tests.test_pip_report_delivery import Scene, Wire, finding
from tests.test_pips_local import config as pips_config
from tests.test_subagents import Script, clone_fixture


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def wait_for(predicate, timeout=20.0, what="the condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


def fixer(edits=None, final="Fixed the GST total.\nTESTS: passed — python -m pytest", calls=None, before_final=None):
    """A scripted fixer: one round of tool calls, then its summary."""
    def route(messages, results, cancel):
        if not results:
            planned = list(calls or []) + [ToolCall(f"w{i}", "write_file", {"path": path, "content": text})
                                            for i, (path, text) in enumerate((edits or {}).items())]
            if planned:
                return ChatResult(tool_calls=planned)
        if before_final is not None:
            before_final()
        return ChatResult(content=final)
    return route


class FixScene(Scene):
    """A Git project with Pips, its chat on a real Backend, and the chat's report of one run."""

    MODE = "auto"

    def setUp(self):
        super().setUp()
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "tests@dgc.invalid")
        git(self.root, "config", "user.name", "DGC Tests")
        (self.root / "app").mkdir()
        (self.root / "app" / "gst.py").write_text("def total(x):\n    return x\n")
        (self.root / "app" / "billing.py").write_text("RATE = 1\n")
        (self.root / ".gitignore").write_text("node_modules/\n.env\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "baseline")
        self.cfg = pips_config(self.root, mode=self.MODE)
        self.patches = [patch.object(Config, "clone_for_root", clone_fixture)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def make(self):
        self.wire = Wire()
        with patch("dgc.trust.is_trusted", return_value=True), patch.object(sys, "stdout", self.wire):
            backend = Backend(self.cfg)
        self.addCleanup(lambda: backend.agent.mcp.stop_all())
        self.addCleanup(lambda: [job["cancel"].set() for job in list((getattr(backend.agent, "_detached_jobs", None)
                                                                         or {}).values())])
        backend.agent.messages = [backend.agent.messages[0],
                                  {"role": "user", "content": "Set up a daily audit of billing"},
                                  {"role": "assistant", "content": "Done: ERP daily audit runs at 18:30."}]
        self.assertTrue(backend.agent._persist(), backend.agent._last_persist_error)
        self.session = backend.agent.session_file.stem
        self.chat(self.session)
        self.attach(self.session)
        self.later(1)
        backend.dispatch({"type": "watch_pip_reports"})
        return backend

    def report(self, backend, title="GST total skips cess", **kwargs):
        run = self.finished(findings=[finding(title, "high", path="app/gst.py", line=2)], **kwargs)
        backend._look_for_pip_reports(force=True)
        return run

    def fixes(self, run=None):
        rows = [frame["fix"] for frame in self.wire.of("pip_fix")]
        return [row for row in rows if run is None or row["run_id"] == run]

    def last(self, run):
        rows = self.fixes(run)
        return rows[-1] if rows else None

    def ended(self, run, timeout=30.0):
        return wait_for(lambda: (row := self.last(run)) is not None and row["state"] in pip_fix.ENDED and row,
                        timeout, f"the fix of {run} to end")

    def start(self, backend, run, request_id="fix-1"):
        backend.dispatch({"type": "start_pip_fix", "run_id": run, "request_id": request_id})


class BackgroundFixTests(FixScene):
    def test_ask_dgc_to_fix_runs_in_the_background_applies_and_starts_no_turn(self):
        backend = self.make()
        run = self.report(backend)
        before = [dict(m) for m in backend.agent.messages]
        seen = []

        def route(messages, results, cancel):
            seen.append(messages)
            return fixer({"app/gst.py": "def total(x):\n    return x * 118 // 100\n"})(messages, results, cancel)

        with patch.object(LLMClient, "chat", Script([("Fix what Pip “ERP daily audit” found", route)])):
            self.start(backend, run)
            row = self.ended(run)
        self.assertEqual(row["state"], "applied", row)
        self.assertEqual((self.root / "app" / "gst.py").read_text(), "def total(x):\n    return x * 118 // 100\n")
        self.assertEqual([(f["path"], f["kind"], f["additions"], f["deletions"]) for f in row["files"]],
                         [("app/gst.py", "edited", 1, 1)])
        self.assertEqual(row["undo"], {"state": "available"})
        states = [f["state"] for f in self.fixes(run)]
        self.assertEqual(states[0], "queued")
        for state in ("preparing", "running", "applying", "applied"):
            self.assertIn(state, states)
        self.assertEqual(self.wire.of("turn_start"), [], "no main turn: the chat stays free")
        self.assertEqual(len(backend.agent.messages), len(before), "nothing was added to the conversation")
        started = [f for f in self.wire.of("agent_started") if f["id"] == row["agent_id"]]
        self.assertTrue(started and started[0].get("background"), "a background sub-agent of this chat")
        reply = [f for f in self.wire.of("pip_fix") if f.get("request_id") == "fix-1"]
        self.assertEqual(len(reply), 1, "the command is answered with the fix's record")
        task = next(str(m["content"]) for m in seen[0] if m.get("role") == "user")
        self.assertIn("GST total skips cess", task)
        self.assertIn("Evidence: return total", task, "the fixer reads the whole finding, evidence too")
        self.assertIn("Never change live data or services", task)
        self.assertIn("TESTS:", task)

    def test_the_tests_line_is_said_only_when_the_fixer_ran_a_command(self):
        backend = self.make()
        run = self.report(backend)
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", fixer({"app/gst.py": "fixed\n"}))])):
            self.start(backend, run)
            row = self.ended(run)
        self.assertEqual(row["tests"]["state"], "not_run", "it claimed passed but ran nothing")
        self.assertEqual(pip_fix.tests_outcome("Done.\nTESTS: failed — npm test: 2 failed", ["npm test"]),
                         {"state": "failed", "command": "npm test", "note": "2 failed"})
        self.assertEqual(pip_fix.tests_outcome("Done.\nTESTS: not run — no tests in this project", []),
                         {"state": "not_run", "note": "no tests in this project"})
        self.assertEqual(pip_fix.tests_outcome("Done.", ["ls"]), {"state": "not_run"})

    def test_undo_puts_back_what_the_fix_left_and_keeps_a_file_changed_since(self):
        backend = self.make()
        run = self.report(backend)
        edits = {"app/gst.py": "fixed gst\n", "app/billing.py": "RATE = 2\n", "app/new.py": "NEW = 1\n"}
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", fixer(edits))])):
            self.start(backend, run)
            row = self.ended(run)
        self.assertEqual(row["state"], "applied")
        (self.root / "app" / "billing.py").write_text("RATE = 3  # mine\n")      # the user, after the fix
        backend.dispatch({"type": "undo_pip_fix", "fix_id": row["fix_id"], "request_id": "undo-1"})
        undone = wait_for(lambda: next((f["fix"] for f in self.wire.of("pip_fix") if f.get("request_id") == "undo-1"),
                                       None), what="the undo")
        self.assertEqual((self.root / "app" / "gst.py").read_text(), "def total(x):\n    return x\n")
        self.assertFalse((self.root / "app" / "new.py").exists(), "a file the fix added is removed again")
        self.assertEqual((self.root / "app" / "billing.py").read_text(), "RATE = 3  # mine\n",
                         "a file changed since the fix is never overwritten")
        self.assertEqual(undone["undo"]["state"], "partial")
        self.assertEqual(undone["undo"]["kept"], [{"path": "app/billing.py", "why": "changed since the fix"}])
        self.assertEqual(sorted(undone["undo"]["restored"]), ["app/gst.py", "app/new.py"])

    def test_a_file_the_user_changed_on_the_same_lines_is_held_back_and_the_rest_applied(self):
        backend = self.make()
        run = self.report(backend)
        edits = {"app/gst.py": "def total(x):\n    return x * 2\n", "app/billing.py": "RATE = 2\n"}

        def user_edits():                       # while the fix works, the user changes the same line
            (self.root / "app" / "gst.py").write_text("def total(x):\n    return x + 1  # mine\n")
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", fixer(edits, before_final=user_edits))])):
            self.start(backend, run)
            row = self.ended(run)
        self.assertEqual(row["state"], "partial", row)
        self.assertEqual([f["path"] for f in row["files"]], ["app/billing.py"])
        self.assertEqual(row["held"], [{"path": "app/gst.py", "n": 0, "why": "you changed the same lines while it worked"}])
        self.assertEqual((self.root / "app" / "gst.py").read_text(), "def total(x):\n    return x + 1  # mine\n")
        self.assertEqual((self.root / "app" / "billing.py").read_text(), "RATE = 2\n")
        backend.dispatch({"type": "get_pip_fix_change", "fix_id": row["fix_id"], "path": "app/gst.py",
                          "request_id": "review-1"})
        [change] = self.wire.of("pip_fix_change")
        self.assertEqual((change["kind"], change["after"]), ("held", "def total(x):\n    return x * 2\n"))
        self.assertIn("# mine", change["before"])

    def test_a_file_with_uncommitted_work_is_fixed_on_top_of_it(self):
        backend = self.make()
        (self.root / "app" / "billing.py").write_text("RATE = 1\nDRAFT = True\n")   # the user's own work
        run = self.report(backend)

        def route(messages, results, cancel):
            if not results:
                # The copy holds the user's uncommitted work: the fixer edits on top of it.
                copy = pip_fix.FixProject(self.root).copy
                self.assertEqual((copy / "app" / "billing.py").read_text(), "RATE = 1\nDRAFT = True\n")
                return ChatResult(tool_calls=[ToolCall("w", "write_file", {
                    "path": "app/billing.py", "content": "RATE = 2\nDRAFT = True\n"})])
            return ChatResult(content="Raised the rate.\nTESTS: not run — no tests")
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", route)])):
            self.start(backend, run)
            row = self.ended(run)
        self.assertEqual(row["state"], "applied", row)
        self.assertEqual((self.root / "app" / "billing.py").read_text(), "RATE = 2\nDRAFT = True\n")


class FixCopyTests(FixScene):
    def test_one_kept_copy_per_project_synced_to_head_and_uncommitted_before_each_fix(self):
        backend = self.make()
        run1 = self.report(backend, "First")
        copy = pip_fix.FixProject(self.root).copy

        def first(messages, results, cancel):
            if not results:
                (copy / "node_modules").mkdir(exist_ok=True)
                (copy / "node_modules" / "dep.js").write_text("installed\n")
                return ChatResult(tool_calls=[ToolCall("w", "write_file", {"path": "scratch.txt", "content": "x\n"})])
            return ChatResult(content="Done.")
        with patch.object(LLMClient, "chat", Script([("First", first)])):
            self.start(backend, run1)
            self.ended(run1)
        (self.root / "scratch.txt").unlink()            # the user threw the first fix's file away
        (self.root / "app" / "billing.py").write_text("RATE = 5\n")    # and has work of their own
        self.later(1)
        run2 = self.report(backend, "Second")
        seen = {}

        def second(messages, results, cancel):
            seen.update(billing=(copy / "app" / "billing.py").read_text(), scratch=(copy / "scratch.txt").exists(),
                        dep=(copy / "node_modules" / "dep.js").exists())
            return ChatResult(content="Nothing to change.\nTESTS: not run — nothing changed")
        with patch.object(LLMClient, "chat", Script([("Second", second)])):
            self.start(backend, run2, "fix-2")
            row = self.ended(run2)
        self.assertEqual(seen, {"billing": "RATE = 5\n", "scratch": False, "dep": True},
                         "synced: the user's uncommitted change in, the old leftover out, the ignored deps kept")
        self.assertEqual(row["state"], "unchanged")
        worktrees = [line for line in git(self.root, "worktree", "list").splitlines()]
        self.assertEqual(len(worktrees), 2, "one kept copy for the project, whatever the number of fixes")

    def test_dependencies_install_once_and_again_only_when_a_lock_file_changes(self):
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        log = self.base / "npm.log"
        npm = bin_dir / "npm"
        npm.write_text(f"#!/bin/sh\necho \"$PWD $*\" >> {log}\nmkdir -p node_modules\n")
        npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
        (self.root / "package-lock.json").write_text('{"lockfileVersion": 3}\n')
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "lock")
        backend = self.make()
        env = patch.dict(os.environ, {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"})
        env.start()
        self.addCleanup(env.stop)
        notes = []

        def route(messages, results, cancel):
            notes.append(str(messages[0].get("content", "")))
            return ChatResult(content="Nothing to change.")
        for n, title in enumerate(("One", "Two", "Three"), 1):
            if n == 3:
                (self.root / "package-lock.json").write_text('{"lockfileVersion": 3, "x": 1}\n')
            self.later(1)
            run = self.report(backend, title)
            with patch.object(LLMClient, "chat", Script([(title, route)])):
                self.start(backend, run, f"fix-{n}")
                row = self.ended(run)
            self.assertEqual(row["state"], "unchanged", row)
        calls = log.read_text().splitlines()
        self.assertEqual(len(calls), 2, f"once, then again only after the lock file changed: {calls}")
        self.assertTrue(all(call.endswith("ci --no-audit --no-fund") for call in calls))
        self.assertTrue(all(call.startswith(str(pip_fix.FixProject(self.root).copy.resolve())) for call in calls),
                        "in the fix copy, never the project")
        self.assertFalse((self.root / "node_modules").exists())
        self.assertIn("dependencies are installed in it (`npm ci --no-audit --no-fund`", notes[1])


class DefaultModeFixTests(FixScene):
    MODE = "default"

    def answer_permissions(self, decision="once"):
        answered = set()
        stop = threading.Event()
        self.addCleanup(stop.set)
        asked = []

        def respond():
            while not stop.wait(0.02):
                for frame in self.wire.of("permission_request"):
                    if frame["id"] not in answered:
                        answered.add(frame["id"])
                        asked.append(frame)
                        self.backend.pending.resolve(frame["id"], {"decision": decision})
        threading.Thread(target=respond, daemon=True).start()
        return asked

    def test_a_missing_ignored_file_is_asked_for_when_a_test_needs_it_copied_and_remembered(self):
        (self.root / ".env").write_text("DATABASE_URL=postgres://localhost/test\n")
        self.backend = backend = self.make()
        asked = self.answer_permissions()
        run = self.report(backend, "Needs env")
        copy = pip_fix.FixProject(self.root).copy
        state = {}

        def route(messages, results, cancel):
            if not results:
                state["before"] = (copy / ".env").exists()
                return ChatResult(tool_calls=[ToolCall("f", "request_project_file",
                                                       {"path": ".env", "why": "the API tests read DATABASE_URL"})])
            state["after"] = (copy / ".env").is_file() and not (copy / ".env").is_symlink()
            return ChatResult(content="The tests need the database.\nTESTS: not run — no database")
        with patch.object(LLMClient, "chat", Script([("Needs env", route)])):
            self.start(backend, run)
            self.ended(run)
        self.assertEqual(state, {"before": False, "after": True}, "asked for, then copied (a file, not a link)")
        self.assertEqual([frame["name"] for frame in asked], ["request_project_file"])
        self.assertTrue(asked[0]["call_id"].startswith(self.last(run)["agent_id"] + ":"),
                        "the card knows which fix asks")
        self.assertEqual(pip_fix.FixProject(self.root).remembered(), [".env"])
        self.later(1)
        run2 = self.report(backend, "Again")
        seen = {}

        def again(messages, results, cancel):
            seen["env"] = (copy / ".env").read_text()
            return ChatResult(content="Nothing to change.")
        with patch.object(LLMClient, "chat", Script([("Again", again)])):
            self.start(backend, run2, "fix-2")
            self.ended(run2)
        self.assertEqual(seen, {"env": "DATABASE_URL=postgres://localhost/test\n"}, "remembered: copied in again")
        self.assertEqual(len(asked), 1, "and never asked again")
        self.assertFalse((self.root / ".env").is_symlink())

    def test_the_install_asks_on_the_card_in_default_mode(self):
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        log = self.base / "npm.log"
        (bin_dir / "npm").write_text(f"#!/bin/sh\necho \"$*\" >> {log}\n")
        (bin_dir / "npm").chmod(0o755)
        (self.root / "package-lock.json").write_text("{}\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "lock")
        env = patch.dict(os.environ, {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"})
        env.start()
        self.addCleanup(env.stop)
        self.backend = backend = self.make()
        asked = self.answer_permissions()
        run = self.report(backend)
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", lambda m, r, c: ChatResult(content="Nothing."))])):
            self.start(backend, run)
            row = self.ended(run)
        self.assertEqual([(f["name"], f["args"]) for f in asked], [("bash", {"command": "npm ci --no-audit --no-fund"})])
        self.assertTrue(asked[0]["call_id"].startswith(row["agent_id"] + ":install-"))
        self.assertEqual(log.read_text().strip(), "ci --no-audit --no-fund")


class QueueAndLifecycleTests(FixScene):
    def test_fixes_run_one_at_a_time_per_project_and_another_click_waits_its_turn(self):
        backend = self.make()
        run1 = self.report(backend, "Slow one")
        self.later(1)
        run2 = self.report(backend, "Quick one")
        release = threading.Event()
        running = []

        def slow(messages, results, cancel):
            running.append("slow")
            release.wait(10)
            return ChatResult(content="Done slow.")

        def quick(messages, results, cancel):
            running.append("quick")
            return ChatResult(content="Done quick.")
        with patch.object(LLMClient, "chat", Script([("Slow one", slow), ("Quick one", quick)])):
            self.start(backend, run1, "a")
            wait_for(lambda: running == ["slow"], what="the first fix to run")
            self.start(backend, run2, "b")
            queued = wait_for(lambda: (row := self.last(run2)) and row.get("queued_behind") and row, what="queued")
            self.assertEqual((queued["state"], queued["queued_behind"]), ("queued", "ERP daily audit"))
            time.sleep(0.3)
            self.assertEqual(running, ["slow"], "the second waits while the first runs")
            release.set()
            self.ended(run1)
            self.ended(run2)
        self.assertEqual(running, ["slow", "quick"])

    def test_stop_while_queued_ends_it_with_nothing_changed(self):
        backend = self.make()
        run1 = self.report(backend, "Slow one")
        self.later(1)
        run2 = self.report(backend, "Queued one")
        release = threading.Event()
        with patch.object(LLMClient, "chat", Script([("Slow one", lambda m, r, c: (release.wait(10),
                                                                                   ChatResult(content="ok"))[1])])):
            self.start(backend, run1, "a")
            self.start(backend, run2, "b")
            queued = wait_for(lambda: (row := self.last(run2)) and row.get("queued_behind") and row, what="queued")
            backend.dispatch({"type": "agent_control", "action": "close", "id": queued["agent_id"], "request_id": "s"})
            row = self.ended(run2)
            release.set()
            self.ended(run1)
        self.assertEqual(row["state"], "stopped")
        self.assertIn("Nothing in your project was changed", row["message"])

    def test_a_reopened_chat_draws_the_card_with_its_fix_and_lists_it(self):
        backend = self.make()
        run = self.report(backend)
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", fixer({"app/gst.py": "fixed\n"}))])):
            self.start(backend, run)
            row = self.ended(run)
        backend._flush_pip_reports()
        [card] = [item for item in backend._history() if item.get("role") == "pip_report"]
        self.assertEqual(card["report"]["fix"]["fix_id"], row["fix_id"])
        self.assertEqual(card["report"]["fix"]["state"], "applied")
        backend.dispatch({"type": "list_pip_fixes", "request_id": "l"})
        [listed] = self.wire.of("pip_fixes")
        self.assertEqual([item["fix_id"] for item in listed["items"]], [row["fix_id"]])
        self.assertNotIn("owner", listed["items"][0])
        self.assertNotIn("session_id", listed["items"][0])

    def test_a_fix_whose_process_stopped_reads_as_interrupted(self):
        project = pip_fix.FixProject(self.root)
        project.put({"fix_id": "fix_" + "a" * 32, "session_id": "s", "run_id": "run_" + "b" * 32,
                     "state": "running", "created_at": 1.0, "owner": {"pid": 2 ** 22 + 12345, "token": "gone"}})
        [row] = project.records()
        self.assertEqual(row["state"], "interrupted")
        self.assertIn("Nothing in your project was changed", row["message"])

    def test_a_run_this_chat_never_showed_gets_its_card_with_the_fix(self):
        backend = self.make()
        other = self.store.create(self.workspace["id"], "Lens review", "Review.", "fixture", pip_type="lens")
        run = self.finished(pip=other, findings=[finding("Unused import", "low", path="app/gst.py", line=1)])
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", fixer({"app/gst.py": "fixed\n"}))])):
            self.start(backend, run)
            row = self.ended(run)
        [card] = [f for f in self.wire.of("pip_report") if f["report"]["run_id"] == run]
        self.assertEqual(card["report"]["name"], "Lens review")
        self.assertEqual(row["state"], "applied")

    def test_refusals_say_why(self):
        backend = self.make()
        clean = self.finished(findings=[])
        backend.dispatch({"type": "start_pip_fix", "run_id": clean, "request_id": "c"})
        backend.dispatch({"type": "start_pip_fix", "run_id": "run_" + "f" * 32, "request_id": "u"})
        wait_for(lambda: len(self.wire.of("command_rejected")) >= 2, what="two refusals")
        reasons = {f["request_id"]: f["reason"] for f in self.wire.of("command_rejected")}
        self.assertEqual(reasons, {"c": "nothing_to_fix", "u": "unknown_run"})
        self.assertEqual(self.wire.of("pip_fix"), [])

    def test_the_capability_and_every_frame_is_declared(self):
        backend = self.make()
        ready = backend._ready_payload()
        self.assertEqual(ready["capabilities"]["pip_fix"], 1)
        for name in ("start_pip_fix", "undo_pip_fix", "list_pip_fixes", "get_pip_fix_change"):
            self.assertIn(name, ep.COMMAND_FIELDS)
        for name in ("pip_fix", "pip_fixes", "pip_fix_change"):
            self.assertIn(name, ep.EVENT_FIELDS)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        temp = tempfile.TemporaryDirectory(prefix="dgc-fix-copies-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home")})
        env.start()
        self.addCleanup(env.stop)

    def test_copies_unused_for_14_days_are_removed_and_doctor_says_their_size(self):
        old, new = pip_fix.root() / "old-aaaaaaaaaaaa", pip_fix.root() / "new-bbbbbbbbbbbb"
        for folder, age_days in ((old, 15), (new, 3)):
            (folder / "copy").mkdir(parents=True)
            (folder / "copy" / "big.bin").write_bytes(b"x" * 4096)
            (folder / "project.json").write_text(json.dumps({"project_root": str(self.base / folder.name),
                                                             "last_used": time.time() - age_days * 86400}))
        rows = {Path(row["project"]).name: row["bytes"] for row in pip_fix.doctor_rows()}
        self.assertGreaterEqual(rows["old-aaaaaaaaaaaa"], 4096)
        self.assertEqual(pip_fix.sweep(), ["old-aaaaaaaaaaaa"])
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())


if __name__ == "__main__":
    unittest.main()
