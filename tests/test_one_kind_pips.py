"""One kind of Pip (his decision 13 Nov; finishing it 15 Nov): every Pip gets everything, a folder if it was given one,
and the safety is the wall of its box, its level and Allow cards. What was left of "Personal" vs "Project" Pips that
kept something from a Pip with a folder goes, gate by gate (the audit: ~/dgc-work/052-plan/one-kind-audit.md)."""
import unittest
from unittest.mock import patch

from dgc import pip_chat_options, pip_logins, pip_memory_review
from tests import test_pips_local as fixtures


class OneKind(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.folder_pip = self.store.create(self.workspace["id"], "Auditor", "Read source", "editor-user")
        self.assertNotEqual(self.folder_pip["source_policy"], {"mode": "personal"}, "a Pip with a folder")

    def test_a_pip_with_a_folder_shows_how_full_its_context_is(self):
        # A9: "Context use is shown for Personal Pips." The estimate itself works for any Pip's chat.
        out = pip_chat_options.context_estimate(self.store, self.folder_pip["id"], self.cfg)
        self.assertEqual(out["pip_id"], self.folder_pip["id"])
        self.assertIn("used_tokens", out)
        self.assertIn("breakdown", out)


    def test_a_pip_with_a_folder_lists_and_saves_logins(self):
        # A7: "Saved logins are for Personal Pips." A Pip with a folder has its own computer and browser too.
        listed = pip_logins.handle(self.registry, "list_pip_logins", {"pip_id": self.folder_pip["id"]}, "editor-user")
        self.assertEqual(listed["logins"], [])
        pips = pip_logins._pips_list(self.registry, [self.folder_pip["id"]])
        self.assertEqual(pips, [self.folder_pip["id"]])

    def test_a_chat_with_a_pip_with_a_folder_feeds_the_one_memory_too(self):
        # A14: the look back over a chat (which feeds the user's one memory) skipped Pips with a folder.
        import json
        run = {"id": "run_" + "e" * 32}
        db = self.registry.db
        db.execute("PRAGMA foreign_keys=OFF")
        with self.registry.transaction():
            db.execute("INSERT INTO pip_runs(id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,"
                       "status,created_at) VALUES(?,?,?,'b','k','editor-user',?,'succeeded',?)",
                       (run["id"], self.folder_pip["id"], self.folder_pip["workspace_id"],
                        json.dumps({"run_kind": "conversation"}), self.registry.clock()))
        db.execute("PRAGMA foreign_keys=ON")
        ended = []
        with patch.object(pip_memory_review, "_reviews", return_value=type("R", (), {"ended": lambda self, pip: ended.append(pip)})()), \
             patch("dgc.pip_notes.user_turn", return_value={"text": "I prefer short answers"}):
            pip_memory_review.after_run(self.registry, self.cfg, run["id"])
        self.assertEqual(ended, [self.folder_pip["id"]])


    def control(self, request, actor="editor-user"):
        from dgc import pips
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_a_pip_with_a_folder_has_working_notes_and_a_daily_log_on_its_page(self):
        # A10: "Working notes and a daily log belong to a Personal Pip." Its page showed them, and they errored.
        for command in ("get_pip_working_notes", "list_pip_daily_log"):
            with self.subTest(command=command):
                out = self.control({"type": command, "pip_id": self.folder_pip["id"]})
                self.assertTrue(out["ok"], out)

    def test_a_pip_with_a_folder_writes_its_daily_log_line(self):
        from dgc import pip_daily_log
        run = {"id": "run_" + "d" * 32, "pip_id": self.folder_pip["id"], "manifest": {"run_kind": "personal_task"}}
        pip_daily_log.after_run(self.registry.directory, self.registry.db, run, status="succeeded",
                                result={"text": "Checked the build."})
        days = pip_daily_log.days(self.registry.directory, self.folder_pip["id"])
        self.assertTrue(days["days"], days)


if __name__ == "__main__":
    unittest.main()
