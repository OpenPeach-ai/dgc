"""Thumbs up or down on a Pip's result reaches its later runs, as the user's own reference."""
import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pip_cli, pip_feedback, pips, sandbox
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

WORKER = r'''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult
from dgc.pips import _worker_main
EXPECT = %r
def chat(self, messages, tools=None, **kwargs):
    seen = json.dumps(messages)
    if EXPECT:
        assert "feedback on your recent results" in seen, "no feedback in the prompt"
        assert EXPECT in seen, "the note is missing"
        assert "not a new task, a job change or a permission" in seen
    else:
        assert "feedback on your recent results" not in seen, "nothing was rated yet"
    return ChatResult(content="Done.")
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''


class FeedbackTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def run_worker(self, pip_id, key, expect):
        queued = self.store.enqueue(pip_id, key, "local-console", self.cfg)
        row = self.store.claim_next()
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", WORKER % (expect,)]
            return popen(argv, *a, **kw)
        with patch.object(pips.subprocess, "Popen", side_effect=process):
            result = pips._execute_run(self.registry, row, self.cfg)
        done = self.store.finish(queued["id"], result=result)
        self.assertEqual(done["status"], "succeeded", done.get("error"))
        return queued

    def pip(self):
        return self.store.create(self.registry.personal()["id"], "Market brief", "Brief me before the open", "local-console")

    def control(self, request, actor="editor-user"):
        self.cfg.data["pips_enabled"] = True
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            response = pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)
        if not response["ok"]:
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def rate(self, run_id, rating, note="", actor="editor-user"):
        return self.control({"type": "set_pip_feedback", "run_id": run_id, "rating": rating, "note": note}, actor)

    def test_a_rating_and_its_note_reach_the_next_run(self):
        pip = self.pip()
        first = self.run_worker(pip["id"], "one", "")
        self.assertNotIn("user_feedback", first["manifest"])
        value = self.rate(first["id"], "down", "Too long. Lead with the three biggest movers.")
        self.assertEqual([(r["run_id"], r["rating"]) for r in value["feedback"]], [(first["id"], "down")])
        second = self.run_worker(pip["id"], "two", "Lead with the three biggest movers.")
        self.assertEqual(second["manifest"]["user_feedback"][0]["rating"], "down")
        self.rate(second["id"], "up", "Perfect length.")
        listed = self.control({"type": "list_pip_feedback", "pip_id": pip["id"]})
        self.assertEqual([r["note"] for r in listed["feedback"]], ["Perfect length.", "Too long. Lead with the three biggest movers."],
                         "newest first")
        self.rate(first["id"], None)
        third = self.store.enqueue(pip["id"], "three", "local-console", self.cfg)
        self.assertEqual([r["note"] for r in third["manifest"]["user_feedback"]], ["Perfect length."], "a cleared rating is gone")

    def test_only_the_user_rates_and_only_finished_results(self):
        pip = self.pip()
        queued = self.store.enqueue(pip["id"], "one", "local-console", self.cfg)
        with self.assertRaises(RegistryError) as raised:
            self.rate(queued["id"], "up")
        self.assertEqual(raised.exception.code, "invalid_request", "a queued run has no result to rate")
        for actor in ("pip-worker", "chat", "remote"):
            with self.subTest(actor=actor), self.assertRaises(RegistryError) as raised:
                self.rate(queued["id"], "up", actor=actor)
            self.assertEqual(raised.exception.code, "local_only")
        for rating, note in (("meh", ""), ("up", "x" * (pip_feedback.MAX_NOTE + 1)), ("up", "bell\x07")):
            with self.subTest(rating=rating, note=note[:8]), self.assertRaises(RegistryError):
                pip_feedback.set_feedback(self.registry, queued["id"], rating, note, "editor-user")
        with self.assertRaises(RegistryError) as raised:
            self.rate("run_missing", "up")
        self.assertEqual(raised.exception.code, "not_found")

    def test_newest_fifty_are_kept_and_five_reach_a_run_redacted(self):
        pip = self.pip()
        run = self.run_worker(pip["id"], "one", "")
        with self.registry.transaction():
            for n in range(pip_feedback.MAX_PER_PIP + 3):
                self.registry.db.execute("INSERT INTO metadata VALUES(?,?)", (
                    pip_feedback._key(pip["id"], f"run_old{n:02d}"),
                    json.dumps({"rating": "up", "note": f"old {n}", "at": "2026-09-01T00:00:00Z", "seq": n + 1})))
        value = self.rate(run["id"], "down", "Never mention plain-later-words-77 again")
        stored = self.registry.db.execute("SELECT COUNT(*) FROM metadata WHERE key LIKE ?", (f"pip_feedback:{pip['id']}:%",)).fetchone()[0]
        self.assertEqual(stored, pip_feedback.MAX_PER_PIP)
        self.assertEqual(value["feedback"][0]["run_id"], run["id"])
        self.assertEqual(len(value["feedback"]), 20, "a bounded list for the editor")
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM metadata WHERE key=?",
                                                   (pip_feedback._key(pip["id"], "run_old00"),)).fetchone(), "the oldest went")
        with patch("dgc.redaction.secret_values", return_value=["plain-later-words-77"]):
            queued = self.store.enqueue(pip["id"], "two", "local-console", self.cfg)
        # The stored manifest, as the worker reads it (a run's view is redacted again on the way out).
        pinned = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                     (queued["id"],)).fetchone()[0])["user_feedback"]
        self.assertEqual(len(pinned), pip_feedback.IN_RUNS)
        self.assertNotIn("plain-later-words-77", json.dumps(pinned))
        self.assertEqual(pinned[1]["note"], f"old {pip_feedback.MAX_PER_PIP + 2}")


class CommandLineTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        clean = {k: v for k, v in os.environ.items() if k != sandbox.AGENT_SHELL}
        p = patch.dict(os.environ, clean, clear=True)
        p.start(); self.addCleanup(p.stop)

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), patch("sys.stdin", io.StringIO()):
            code = pip_cli.handle_command(self.cfg, list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_rate_from_the_terminal_but_never_from_the_chat_shell(self):
        pip = self.store.create(self.registry.personal()["id"], "Brief", "Brief me", "local-console")
        queued = self.store.enqueue(pip["id"], "one", "local-console", self.cfg)
        self.store.claim_next()
        self.store.finish(queued["id"], result={"text": "Done.", "external_actions": False, "tools_called": 0, "usage": {}})
        same = patch("dgc.pips.WorkspaceRegistry", return_value=self.registry)
        same.start(); self.addCleanup(same.stop)
        closing = patch.object(self.registry, "close")
        closing.start(); self.addCleanup(closing.stop)
        with patch.dict(os.environ, {sandbox.AGENT_SHELL: "1"}):
            code, _, err = self.cli("feedback", queued["id"], "up")
        self.assertEqual(code, 2, err)
        self.assertEqual(pip_feedback.list_feedback(self.registry, pip["id"])["feedback"], [])
        code, text, err = self.cli("feedback", queued["id"], "up", "--note", "More like this")
        self.assertEqual(code, 0, err)
        self.assertIn("More like this", text)
        code, text, err = self.cli("feedback", queued["id"], "clear")
        self.assertEqual((code, text.strip()), (0, "No ratings yet."), err)


if __name__ == "__main__":
    unittest.main()
