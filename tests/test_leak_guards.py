"""Leak guards for 0.52 (agreed 14 Nov: "yes, want these four in 0.52"), guard 1 and 3 here.

1. Secrets never reach the model: DGC already hides its own saved keys and anything shaped like a secret
   (`API_KEY=...`, tokens, private keys). A project's own .env values were not known, so a password or salt in .env that
   also appears in a config file, a test or a log reached the model. Now the values of the project's .env files that
   are secrets (their name says so, or they look like one) are hidden everywhere the model reads, like a saved key.
   Hiding has a cost: a model that rewrites a file holding a hidden value would write the mark instead of the value. So
   no file tool writes "[REDACTED]" into a file that didn't have it; it says why and how to edit around it.
3. The instruction: a Work session and every Pip are told not to send code, files or personal details to a site unless
   the task needs it, and to say so when they do.

Real Config on a real project folder, the real file tools, the real prompts.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import leak_guard, redaction
from dgc.config import Config
from dgc.tools import EXECUTORS

ENV = """# local settings
export STRIPE_SECRET_KEY=sk_live_51Hc0ffeeC0ffeeC0ffee
DB_PASSWORD="hunter2hunter2"
SESSION_SALT='q8Zr2LmP4xVw7Kt1Nb6Yc3Hd'
PORT=3000
NODE_ENV=production
APP_URL=https://shop.example.com
DATABASE_URL=postgres://shop:s3cretPassw0rd@db.internal:5432/shop
"""


class Ctx:
    def __init__(self, root: Path, config):
        self.project_root = root
        self.config = config


class Project(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-leak-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / "shop"
        self.root.mkdir()
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home"), "HOME": str(self.base / "home")})
        env.start()
        self.addCleanup(env.stop)
        (self.root / ".env").write_text(ENV)
        (self.root / "settings.py").write_text('PASSWORD = "hunter2hunter2"\nSALT = "q8Zr2LmP4xVw7Kt1Nb6Yc3Hd"\nPORT = 3000\n')
        self.config = Config(self.root)
        leak_guard.forget()

    def secrets(self):
        return redaction.secret_values(self.config)

    def run_tool(self, name, **args):
        return EXECUTORS[name](args, Ctx(self.root, self.config))


class TheProjectsEnvValuesAreHidden(Project):
    def test_secret_values_of_its_env_files_are_known_and_ordinary_settings_are_not(self):
        known = self.secrets()
        for value in ("sk_live_51Hc0ffeeC0ffeeC0ffee", "hunter2hunter2", "q8Zr2LmP4xVw7Kt1Nb6Yc3Hd",
                      "postgres://shop:s3cretPassw0rd@db.internal:5432/shop", "s3cretPassw0rd"):
            self.assertIn(value, known, value)
        for value in ("3000", "production", "https://shop.example.com"):
            self.assertNotIn(value, known, f"{value} is a setting, not a secret: hiding it would blind the model")

    def test_what_the_model_reads_never_holds_them(self):
        shown = self.run_tool("read_file", path="settings.py")
        self.assertNotIn("hunter2hunter2", shown)
        self.assertNotIn("q8Zr2LmP4xVw7Kt1Nb6Yc3Hd", shown)
        self.assertIn(redaction.REDACTED, shown)
        self.assertIn("PORT = 3000", shown, "the rest of the file is as it is")

    def test_example_files_are_not_secrets_and_a_changed_env_is_read_again(self):
        (self.root / ".env.example").write_text("STRIPE_SECRET_KEY=sk_test_placeholderplaceholder\n")
        self.assertNotIn("sk_test_placeholderplaceholder", self.secrets())
        (self.root / ".env.local").write_text("API_TOKEN=tok_9f8e7d6c5b4a39281706\n")
        self.assertIn("tok_9f8e7d6c5b4a39281706", self.secrets(), "a new .env file is read")
        (self.root / ".env").write_text("DB_PASSWORD=another-long-password-1\n")
        known = self.secrets()
        self.assertIn("another-long-password-1", known, "a changed .env is read again")
        self.assertNotIn("hunter2hunter2", known)

    def test_no_env_and_no_project_cost_nothing(self):
        self.assertEqual(leak_guard.project_env_values(None), ())
        empty = self.base / "empty"
        empty.mkdir()
        self.assertEqual(leak_guard.project_env_values(empty), ())


class NoFileToolWritesTheMark(Project):
    def test_write_file_refuses_content_that_would_put_the_mark_in_place_of_a_value(self):
        shown = self.run_tool("read_file", path="settings.py")
        lines = [line.split("\t", 1)[1] for line in shown.splitlines() if "\t" in line]
        said = self.run_tool("write_file", path="settings.py", content="\n".join(lines).replace("3000", "8080") + "\n")
        self.assertTrue(said.startswith("error:"), said)
        self.assertIn("[REDACTED]", said)
        self.assertIn("hunter2hunter2", (self.root / "settings.py").read_text(), "the file is untouched")

    def test_edit_file_and_multi_edit_refuse_it_and_an_edit_around_it_works(self):
        said = self.run_tool("edit_file", path="settings.py", old_string="PORT = 3000",
                             new_string='PORT = 8080\nTOKEN = "[REDACTED]"')
        self.assertTrue(said.startswith("error:"), said)
        said = self.run_tool("multi_edit", path="settings.py",
                             edits=[{"old_string": "PORT = 3000", "new_string": "PORT = [REDACTED]"}])
        self.assertIn("[REDACTED]", said)
        self.assertIn("PORT = 3000", (self.root / "settings.py").read_text())
        fine = self.run_tool("edit_file", path="settings.py", old_string="PORT = 3000", new_string="PORT = 8080")
        self.assertFalse(fine.startswith("error:"), fine)
        self.assertIn("hunter2hunter2", (self.root / "settings.py").read_text(), "the secret is still there")

    def test_an_edit_whose_old_text_holds_the_mark_says_why_it_cannot_match(self):
        said = self.run_tool("edit_file", path="settings.py", old_string='PASSWORD = "[REDACTED]"',
                             new_string='PASSWORD = "[REDACTED]"  # kept')
        self.assertTrue(said.startswith("error:"), said)
        self.assertIn("hides", said)

    def test_a_file_with_no_hidden_secret_may_say_redacted(self):
        # Self-review, 14 Nov: code and docs about redaction legitimately write the word; only a file that holds a
        # secret DGC hides from the model is guarded.
        said = self.run_tool("write_file", path="test_logs.py", content='assert clean(line) == "token=[REDACTED]"\n')
        self.assertFalse(said.startswith("error:"), said)
        (self.root / "notes.md").write_text("Plain notes.\n")
        said = self.run_tool("edit_file", path="notes.md", old_string="Plain notes.", new_string="Logs show [REDACTED].")
        self.assertFalse(said.startswith("error:"), said)

    def test_a_file_that_already_holds_the_mark_can_still_be_written(self):
        (self.root / "notes.md").write_text("Logs show [REDACTED] where a key was.\n")
        said = self.run_tool("write_file", path="notes.md", content="Logs show [REDACTED] where a key was. Fixed.\n")
        self.assertFalse(said.startswith("error:"), said)


class TheInstruction(unittest.TestCase):
    def test_a_work_session_and_every_pip_are_told(self):
        self.assertIn("unless the task needs it", leak_guard.INSTRUCTION)
        from dgc import pip_chat
        from dgc.agent import Agent
        import inspect
        self.assertIn("leak_guard.INSTRUCTION", inspect.getsource(Agent._system_prompt) if hasattr(Agent, "_system_prompt")
                      else inspect.getsource(Agent))
        self.assertIn(leak_guard.INSTRUCTION, pip_chat.SYSTEM)


if __name__ == "__main__":
    unittest.main()
