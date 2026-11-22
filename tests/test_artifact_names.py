"""One artifact per name: a model changes the one that's there, or names a second one apart.

The user's ask: a model that is asked to change something it made must not save another copy beside it; it updates the
one there (a new version), or, when the user wants both, makes a second one under a name of its own. Two of a kind never
share a name (case and spacing don't make it another name). Any conversation can find what the user already has
(find_artifacts), so "change yesterday's report" changes yesterday's report. A Pip sees and changes only its own.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_service as service
from dgc import artifact_tools, permissions, tools
from dgc.agent import AgentContext
from dgc.config import Config


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-artnames-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")
        self.root = self.tmp / "proj"
        self.root.mkdir()
        self.ctx = AgentContext(self.root, Config(self.root), on_artifact=lambda v, op: None,
                                artifact_origin=lambda: {"surface": "work", "project": str(self.root), "session": "s1"})

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def make(self, title, type_="doc", content="# x\n"):
        args = {"type": type_, "title": title}
        if type_ == "doc":
            args["content"] = content
        elif type_ == "sheet":
            args["data"] = {"sheets": [{"name": "S", "columns": [{"name": "A", "type": "text"}], "rows": [["a"]]}]}
        elif type_ == "page":
            args["content"] = "<!doctype html><p>hi</p>"
        return tools.execute("make_artifact", args, self.ctx)

    def docs(self):
        return [v for v in service.listing(type="doc")]


class OneNamePerKind(Base):
    def test_a_taken_name_is_refused_with_the_one_there_and_what_to_do(self):
        first = self.make("Q3 plan")
        self.assertTrue(first.startswith("Made Document “Q3 plan” (ar_"), first)
        aid = first.split("(")[1].split(",")[0]
        out = self.make("  q3   PLAN ")
        self.assertTrue(out.startswith("error: there's already a document named “Q3 plan”"), out)
        self.assertIn(aid, out)
        self.assertIn("edit_artifact", out)
        self.assertIn("a name that says how it differs", out)
        self.assertEqual(len(self.docs()), 1, "nothing second was saved")
        read = tools.execute("edit_artifact", {"id": aid}, self.ctx)
        self.assertTrue(read.endswith("(You only read it: nothing has changed. To change it, call edit_artifact again "
                                      "with edits or the whole new content.)"), read[-160:])

    def test_another_kind_may_share_the_name(self):
        self.make("Budget")
        out = self.make("Budget", "sheet")
        self.assertTrue(out.startswith("Made Spreadsheet “Budget”"), out)

    def test_no_name_gets_the_kinds_own_numbered_past_the_ones_there(self):
        for want in ("Document", "Document 2", "Document 3"):
            out = tools.execute("make_artifact", {"type": "doc", "content": "# x\n"}, self.ctx)
            self.assertTrue(out.startswith(f"Made Document “{want}”"), out)

    def test_a_removed_one_frees_its_name(self):
        aid = self.make("Notes").split("(")[1].split(",")[0]
        service.remove(aid)
        self.assertTrue(self.make("Notes").startswith("Made Document “Notes”"))

    def test_rename_by_the_model_alone_or_with_a_change_never_to_a_taken_name(self):
        a = self.make("Draft").split("(")[1].split(",")[0]
        b = self.make("Final").split("(")[1].split(",")[0]
        out = tools.execute("edit_artifact", {"id": a, "title": "final"}, self.ctx)
        self.assertTrue(out.startswith("error: another document is already named “Final”"), out)
        self.assertIn(b, out)
        self.assertEqual(service.view(a)["title"], "Draft")
        out = tools.execute("edit_artifact", {"id": a, "title": "Board version"}, self.ctx)
        self.assertTrue(out.startswith("Changed Document “Board version”"), out)
        v = service.view(a)
        self.assertEqual((v["title"], v["version"], v["versions"][-1]["summary"]), ("Board version", 2, "Renamed"))
        self.assertEqual(service.outline(a).count("# x"), 1, "the same content, as it was")
        # Its own name in other letters is still its own.
        out = tools.execute("edit_artifact", {"id": a, "title": "BOARD version", "content": "# y\n"}, self.ctx)
        self.assertTrue(out.startswith("Changed Document “BOARD version”"), out)

    def test_a_page_and_a_sheet_can_be_renamed_without_their_content(self):
        p = self.make("Tool", "page").split("(")[1].split(",")[0]
        s = self.make("Costs", "sheet").split("(")[1].split(",")[0]
        self.assertTrue(tools.execute("edit_artifact", {"id": p, "title": "Tip calculator"}, self.ctx).startswith("Changed Page"))
        self.assertTrue(tools.execute("edit_artifact", {"id": s, "title": "Costs 2026"}, self.ctx).startswith("Changed Spreadsheet"))
        from dgc.artifact_store import store
        self.assertIn(b"<p>hi</p>", b"".join(store().files(p).values()), "the page's files, as they were")

    def test_your_own_rename_in_the_library_follows_the_rule_too(self):
        a = self.make("Alpha").split("(")[1].split(",")[0]
        self.make("Beta")
        with self.assertRaises(service.ArtifactNameTaken):
            service.edit(a, content="# x\n", title="beta", author="you")
        with self.assertRaises(service.ArtifactUseError):
            service.edit(a, title="   ", author="you")


class OnePlaceOneName(Base):
    """Per place, never across places: "logo" can be in every project."""

    def other_project(self, name):
        root = self.tmp / name
        root.mkdir()
        return AgentContext(root, Config(root), on_artifact=lambda v, op: None,
                            artifact_origin=lambda: {"surface": "work", "project": str(root), "session": "s2"})

    def test_the_same_name_in_another_project_is_fine(self):
        self.make("Logo notes")
        other = self.other_project("shop")
        out = tools.execute("make_artifact", {"type": "doc", "title": "Logo notes", "content": "# l\n"}, other)
        self.assertTrue(out.startswith("Made Document “Logo notes”"), out)
        again = tools.execute("make_artifact", {"type": "doc", "title": "logo NOTES", "content": "# l\n"}, other)
        self.assertTrue(again.startswith("error: there's already a document named “Logo notes”"), again)
        found = tools.execute("find_artifacts", {"query": "logo"}, self.ctx).splitlines()
        self.assertEqual(len(found), 2, "find looks in every place")

    def test_a_chat_in_the_projects_folder_shares_its_names_and_a_chat_without_one_has_its_own(self):
        self.make("Roadmap")
        in_folder = {"surface": "chat", "chat": "c1", "project": str(self.root)}
        with self.assertRaises(service.ArtifactNameTaken):
            service.make("doc", "roadmap", {"content": "# r\n"}, origin=in_folder)
        alone = service.make("doc", "Roadmap", {"content": "# r\n"}, origin={"surface": "chat", "chat": "c2"})
        self.assertEqual(alone["title"], "Roadmap")
        with self.assertRaises(service.ArtifactNameTaken):
            service.make("doc", "ROADMAP", {"content": "# r\n"}, origin={"surface": "chat", "chat": "c2"})
        self.assertEqual(service.place_of({"surface": "work", "project": str(self.root) + "/"}), service.place_of(in_folder))

    def test_a_rename_is_checked_in_its_own_place_only(self):
        a = self.make("Alpha").split("(")[1].split(",")[0]
        other = self.other_project("site")
        tools.execute("make_artifact", {"type": "doc", "title": "Beta", "content": "# b\n"}, other)
        out = tools.execute("edit_artifact", {"id": a, "title": "Beta"}, self.ctx)
        self.assertTrue(out.startswith("Changed Document “Beta”"), out)


class FindWhatTheyHave(Base):
    def test_find_by_words_newest_first_with_ids(self):
        self.make("Q3 plan")
        time.sleep(1.05)                                  # (the store's times are to the second)
        self.make("Q3 board deck")
        self.make("Holiday list")
        out = tools.execute("find_artifacts", {"query": "q3"}, self.ctx)
        lines = out.splitlines()
        self.assertEqual(len(lines), 2, out)
        self.assertIn("“Q3 board deck”", lines[0], "newest first")
        self.assertRegex(lines[0], r"^ar_[0-9a-f]{16} · Document “Q3 board deck” · version 1")
        self.assertIn("in Work", lines[0])
        latest = tools.execute("find_artifacts", {}, self.ctx).splitlines()
        self.assertEqual(len(latest), 3)
        none = tools.execute("find_artifacts", {"query": "taxes"}, self.ctx)
        self.assertTrue(none.startswith("No artifacts named with “taxes”"), none)
        self.assertTrue(tools.execute("find_artifacts", {"type": "sheet"}, self.ctx).startswith("No artifacts"))

    def test_it_is_offered_everywhere_the_other_two_are_and_changes_nothing(self):
        self.assertIn("find_artifacts", artifact_tools.NAMES)
        self.assertIn("find_artifacts", permissions.READ_ONLY_TOOLS)
        self.assertEqual(permissions.DISPLAY["find_artifacts"], "FindArtifacts")
        from dgc_sdk import policy as sdk_policy
        self.assertEqual(sdk_policy._DISPLAY["find_artifacts"], "FindArtifacts")
        self.assertFalse(artifact_tools.NAMES & {s["function"]["name"] for s in tools.TOOL_SCHEMAS})
        from dgc import pip_library
        self.assertIn("find_artifacts", pip_library.TOOLS)
        self.assertIn("find_artifacts", {s["function"]["name"] for s in pip_library.schemas()})
        make = next(t for t in artifact_tools.TOOLS if t["function"]["name"] == "make_artifact")
        self.assertIn("find_artifacts", make["function"]["description"])
        edit = next(t for t in artifact_tools.TOOLS if t["function"]["name"] == "edit_artifact")
        self.assertIn("title", edit["function"]["parameters"]["properties"])


class APipSeesItsOwn(Base):
    def test_a_pip_finds_and_is_told_only_about_its_own(self):
        from dgc import pip_library
        self.make("Weekly report")                                      # the user's, made in Work
        session = pip_library.Session(self.tmp, Config(self.root), "pip_" + "a" * 32)
        mine = session.call("make_artifact", {"type": "doc", "title": "Prices", "content": "# p\n"})
        self.assertTrue(mine.startswith("Made Document “Prices”"), mine)
        found = session.call("find_artifacts", {})
        self.assertIn("“Prices”", found)
        self.assertNotIn("Weekly report", found, "the user's own aren't the Pip's to see")
        # A Pip's things are its own place: the user's "Weekly report" in a project doesn't take the name from it.
        out = session.call("make_artifact", {"type": "doc", "title": "weekly REPORT", "content": "# w\n"})
        self.assertTrue(out.startswith("Made Document “weekly REPORT”"), out)
        again = session.call("make_artifact", {"type": "doc", "title": "Prices", "content": "# p2\n"})
        self.assertTrue(again.startswith("error: there's already a document named “Prices”"), again)
        self.assertIn("edit_artifact", again, "its own: change that one")

    def test_a_name_another_maker_holds_in_the_same_place_is_said_without_its_id(self):
        out = artifact_tools.taken_words({"id": "ar_0123456789abcdef", "type": "doc", "label": "Document", "title": "Plan",
                                          "version": 3}, "make_artifact", mine=lambda view: False)
        self.assertEqual(out, "error: the user already has a document named “Plan”. Give yours a different name that "
                              "says what it is.")


class AChatsDocument(Base):
    def test_a_chats_document_follows_the_same_names(self):
        self.make("Trip plan")
        from dgc.chatdgc import engine
        src = Path(engine.__file__).read_text()
        self.assertEqual(src.count('artifact_service.taken("doc", args.get("title"), place=self._artifact_place(chat))'), 2,
                         "make_artifact's document and canvas_create, both in the chat's own place")
        self.assertIn("artifact_tools.FIND_ARTIFACTS", src)


if __name__ == "__main__":
    unittest.main()
