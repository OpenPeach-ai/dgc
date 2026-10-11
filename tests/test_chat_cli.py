"""`dgc chat`: ChatDGC in the terminal (Phase 10), run for real against a local mock model in a throwaway HOME."""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_dgc_sdk as harness                               # noqa: E402  (its mock model)

ROOT = Path(__file__).resolve().parent.parent
ANSWER = "The checkout flow creates an empty cart and then redirects."


class ChatCliTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-chat-cli-"))
        (self.home / ".dgc").mkdir()
        harness._Model.behavior = "text"
        harness._Model.posts = 0
        self.server, base_url = harness._start_model()
        (self.home / ".dgc" / "config.json").write_text(json.dumps({"model": "sdk-model", "base_url": base_url}), encoding="utf-8")
        self.env = {**os.environ, "HOME": str(self.home), "PYTHONPATH": str(ROOT), "NO_COLOR": "1"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.home, ignore_errors=True)

    def dgc(self, *args: str, stdin: str = "") -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "dgc", "chat", *args], cwd=self.home, env=self.env, input=stdin,
                              capture_output=True, text=True, timeout=180)

    def test_one_question_its_answer_then_the_list_resume_and_export(self):
        run = self.dgc("What does the checkout do?", "--search", "off")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn(ANSWER, run.stdout)
        listed = self.dgc("--list", "--json")
        chats = json.loads(listed.stdout)
        self.assertEqual(len(chats), 1, "a sent chat is listed")
        chat_id = chats[0]["id"]
        self.assertIn(chat_id, self.dgc("--list").stdout)
        self.assertIn("No chat mentions", self.dgc("--list", "nothing-like-this").stdout)
        again = self.dgc("--resume", chat_id, "And then?", "--search", "off", "--json")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)["chat_id"], chat_id, "the same chat, continued")
        target = self.home / "out" / "chat.json"
        saved = self.dgc("--export", chat_id, "-o", str(target), "--json")
        self.assertEqual(saved.returncode, 0, saved.stderr)
        exported = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual(exported["format"], "chatdgc-chat")
        self.assertEqual([m["role"] for m in exported["chat"]["messages"]], ["user", "assistant", "user", "assistant"])
        markdown = self.dgc("--export", chat_id)
        self.assertEqual(markdown.returncode, 0, markdown.stderr)
        path = Path(markdown.stdout.strip())
        self.assertEqual(path.parent, self.home / ".dgc" / "exports", "saved where `dgc export` saves")
        self.assertIn(ANSWER, path.read_text(encoding="utf-8"))

    def test_json_piped_question_and_a_temporary_chat(self):
        run = self.dgc("--json", "--search", "off", stdin="What does the checkout do?\n")
        self.assertEqual(run.returncode, 0, run.stderr)
        reply = json.loads(run.stdout)
        self.assertEqual(reply["text"], ANSWER, "piped text is the question")
        self.assertTrue(reply["chat_id"].startswith("chat_"))
        self.assertEqual(reply["finish"], "stop")
        secret = self.dgc("Just between us.", "--temporary", "--search", "off")
        self.assertIn(ANSWER, secret.stdout)
        self.assertEqual(len(json.loads(self.dgc("--list", "--json").stdout)), 1, "a temporary chat is never listed")

    def test_refusals_say_what_is_wrong(self):
        missing = self.dgc("hi", "--file", str(self.home / "missing.txt"))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("not a file", missing.stderr)
        files = []
        for n in range(11):
            f = self.home / f"f{n}.txt"
            f.write_text("x", encoding="utf-8")
            files += ["--file", str(f)]
        self.assertEqual(self.dgc("hi", *files).returncode, 2)
        self.assertEqual(self.dgc("--think", "max", "hi").returncode, 2)
        nothing = self.dgc()
        self.assertEqual(nothing.returncode, 2, "no question and nothing piped")
        self.assertIn("nothing to ask", nothing.stderr)
        unknown = self.dgc("--resume", "chat_" + "0" * 32, "hi")
        self.assertEqual(unknown.returncode, 1)
        self.assertTrue(unknown.stderr.strip().startswith("dgc chat:"), unknown.stderr)
        self.assertEqual(subprocess.run([sys.executable, "-m", "dgc", "chat", "--help"], env=self.env, capture_output=True,
                                        text=True, timeout=60).returncode, 0)

    def test_an_event_with_a_field_named_kind_reaches_the_screen(self):
        """Found live: a search's activity event has a `kind` field, which the event callback's own parameter took."""
        from dgc.chat_cli import ChatClient, Printer

        class Quiet:
            def close(self):
                pass

        client = ChatClient(None, service=Quiet())
        client._emit("chatdgc_activity", conversation_id="chat_x", kind="search", text="Searching the web: IRA rules")
        event = client.events.get_nowait()
        self.assertEqual((event["type"], event["kind"]), ("chatdgc_activity", "search"))
        out = io.StringIO()
        Printer(out, False).event(event)
        self.assertEqual(out.getvalue(), "· Searching the web: IRA rules\n")

    def test_the_chat_you_type_into(self):
        # In this process, so its ~/.dgc is patched where dgc.config keeps it (fixed when it was first imported, which
        # in a full run was long before this test set HOME).
        from unittest.mock import patch
        from dgc import config as config_module
        user = self.home / ".dgc"
        patches = [patch.object(config_module, name, value) for name, value in
                   (("USER_HOME", user), ("USER_CONFIG", user / "config.json"), ("USER_SECRETS", user / "secrets.json"))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        old = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        try:
            from dgc.chat_cli import ChatClient, _open, _repl, parser
            from dgc.config import Config
            client = ChatClient(Config())
            lines = iter(["What does the checkout do?", "/title Checkout notes", "/list", "/new", "/help", "/nope", "/quit"])
            out = io.StringIO()
            try:
                args = parser().parse_args(["--search", "off"])
                code = _repl(client, _open(client, None), args, out, False, read=lambda _prompt: next(lines))
            finally:
                client.close()
            text = out.getvalue()
            self.assertEqual(code, 0)
            self.assertIn(ANSWER, text)
            self.assertIn("Renamed.", text)
            self.assertIn("Checkout notes", text, "/list shows the renamed chat")
            self.assertIn("A new chat.", text)
            self.assertIn("/export [FILE]", text, "/help lists the commands")
            self.assertIn("Unknown command", text)
        finally:
            if old is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old


if __name__ == "__main__":
    unittest.main()
