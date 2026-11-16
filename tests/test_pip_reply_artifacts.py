"""A Pip's reply carries what it made, so the chat can open it (live round r27, 16 Nov: the Pip "Made the page" and its
reply had nothing to open it with; Work's reply shows the page's card).

What a run made or changed with make_artifact / edit_artifact is counted by the controller (pip_library.Session), never
taken from the worker; the run's result carries `artifacts` [{id, type, title, op}] (at most 8, one per artifact, its
last op), and the reply's message row carries the same (Pips API 102), for the chat to draw each as a card."""
import unittest
from unittest.mock import patch

from dgc import artifact_tools, pip_chat, pip_library
from dgc.workspace_registry import RegistryError
from tests.test_pip_missed_steer import Base


def session():
    s = pip_library.Session.__new__(pip_library.Session)
    s.directory, s.config, s.pip_id, s.run_id, s.name = None, None, "pip_x", "run_x", "Tide"
    s.made, s.made_items = [], []
    return s


class Counted(unittest.TestCase):
    def test_what_it_made_and_changed_one_per_artifact(self):
        s = session()
        views = iter([{"id": "ar_" + "1" * 16, "type": "page", "label": "Page", "title": "Tides", "version": 1},
                      {"id": "ar_" + "1" * 16, "type": "page", "label": "Page", "title": "Tides (big)", "version": 2},
                      {"id": "ar_" + "2" * 16, "type": "sheet", "label": "Spreadsheet", "title": "Tide table", "version": 1}])
        with patch.object(artifact_tools.service, "make", side_effect=lambda *a, **k: next(views)), \
                patch.object(artifact_tools.service, "edit", side_effect=lambda *a, **k: next(views)), \
                patch.object(artifact_tools.service, "view", return_value={"type": "page"}), \
                patch.object(pip_library.Session, "_may_edit", return_value=True):
            s.call("make_artifact", {"type": "page", "title": "Tides", "content": "<p>x</p>"})
            s.call("edit_artifact", {"id": "ar_" + "1" * 16, "content": "<p>X</p>"})
            s.call("make_artifact", {"type": "sheet", "title": "Tide table", "data": {}})
        self.assertEqual(pip_library.reply_artifacts(s.made_items), [
            {"id": "ar_" + "1" * 16, "type": "page", "title": "Tides (big)", "op": "changed"},
            {"id": "ar_" + "2" * 16, "type": "sheet", "title": "Tide table", "op": "made"}])

    def test_bounded(self):
        items = [{"id": "ar_%016x" % i, "type": "doc", "title": f"Doc {i}", "op": "made"} for i in range(20)]
        self.assertEqual(len(pip_library.reply_artifacts(items)), pip_library.MAX_REPLY_ARTIFACTS)


class OnTheReply(Base):
    def reply(self, result):
        self.job_ready()
        first = self.send("A page of tide times", "first")
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result=result)
        [reply] = [m for m in self.page()["messages"] if m["role"] == "assistant"]
        return reply

    def test_the_reply_lists_what_it_made(self):
        made = [{"id": "ar_" + "a" * 16, "type": "page", "title": "Tides", "op": "made"}]
        self.assertEqual(self.reply({"text": "Made the page.", "artifacts": made})["artifacts"], made)

    def test_none_says_nothing(self):
        self.assertNotIn("artifacts", self.reply({"text": "Here."}))

    def test_a_bad_list_is_refused(self):
        self.job_ready()
        first = self.send("x", "first")
        self.store.claim_next()
        run = self.store.run(first["run"]["id"])
        for bad in ([{"id": "nope", "type": "page", "title": "x", "op": "made"}],
                    [{"id": "ar_" + "a" * 16, "type": "video", "title": "x", "op": "made"}],
                    [{"id": "ar_" + "a" * 16, "type": "page", "title": "x", "op": "deleted"}],
                    [{"id": "ar_" + "a" * 16, "type": "page", "title": "x", "op": "made"}] * 9, "x"):
            with self.subTest(bad=str(bad)[:40]), self.assertRaises(RegistryError):
                pip_chat.insert_reply(self.store, run, {"text": "x", "artifacts": bad}, "2026-11-16T00:00:00Z")

    def test_it_is_in_pips_api_102(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 102)


if __name__ == "__main__":
    unittest.main()
