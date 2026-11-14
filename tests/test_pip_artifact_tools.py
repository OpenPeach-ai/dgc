"""A Pip makes pages, sheets, documents, decks and dashboards (0.52, his call 15 Nov: "pips should have these all
tools"; no cap, better instructions instead).

The worker never writes DGC's artifact store: its make_artifact / edit_artifact go through the run's socket to the
controller (pip_artifacts.Session), which writes the user's Library with the Pip as its maker. A Pip edits what it made
and the dashboards the user gave it to keep current, nothing else. Its instructions say: one item per purpose, update
it instead of making another.
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path


class APipMakesAndKeepsItsOwn(unittest.TestCase):
    def setUp(self):
        from tests import test_pips_local as fixtures
        fixtures.LocalPipsTests.setUp(self)
        os.environ["DGC_HOME"] = str(Path(self.registry.directory).parent / "dgc-home")
        self.pip = self.store.create(self.registry.personal()["id"], "Sales watch", "Keep the sales numbers", "editor-user")
        from dgc import pip_library as pip_artifacts
        self.session = pip_artifacts.Session(self.registry.directory, self.cfg, self.pip["id"])

    def made(self, said):
        import re
        found = re.search(r"\b(ar_[0-9a-z]+)\b", said)
        self.assertIsNotNone(found, said)
        from dgc.artifact_store import store
        return store().get(found.group(1))

    def test_its_page_is_in_the_library_with_the_pip_as_its_maker(self):
        said = self.session.call("make_artifact", {"type": "page", "title": "Weekly sales", "content": "<h1>Sales</h1>"})
        art = self.made(said)
        self.assertEqual(art.origin.get("surface"), "pip")
        self.assertEqual(art.origin.get("pip"), self.pip["id"])
        from dgc.artifact_store import store
        self.assertEqual(store().versions(art.id)[-1].author, "Sales watch", "the Pip's name on its version")

    def test_it_edits_its_own_and_never_someone_elses(self):
        own = self.made(self.session.call("make_artifact", {"type": "doc", "title": "Notes", "content": "# One"}))
        said = self.session.call("edit_artifact", {"id": own.id, "content": "# Two"})
        self.assertNotIn("error", said.lower()[:20], said)
        from dgc import artifact_service
        theirs = artifact_service.make("doc", "Mine", {"content": "# Mine"}, origin={"surface": "work", "project": "/w"})
        refused = self.session.call("edit_artifact", {"id": theirs["id"], "content": "# changed"})
        self.assertTrue(refused.startswith("error"), refused)

    def test_a_dashboard_the_user_gave_it_is_its_to_keep_current(self):
        from dgc import artifact_pips, artifact_service
        project = Path(os.environ["DGC_HOME"]).parent / "shop"
        (project / "data").mkdir(parents=True)
        (project / "data" / "orders.csv").write_text("id,total\n1,100\n")
        spec = {"title": "Sales", "sources": [{"id": "orders", "kind": "file", "path": "data/orders.csv"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "orders", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM orders"}]}
        board = artifact_service.make("dashboard", "Sales", spec, origin={"surface": "work", "project": str(project)})
        refused = self.session.call("edit_artifact", {"id": board["id"], "data": spec})
        self.assertTrue(refused.startswith("error"), "not its own, not given to it")
        with self.registry.transaction():
            artifact_pips.set_settings(self.registry.db, self.pip["id"], dashboards=[board["id"]])
        said = self.session.call("edit_artifact", {"id": board["id"], "data": {**spec, "title": "Sales today"}})
        self.assertFalse(said.startswith("error: that one isn't yours"), said)

    def test_its_instructions_say_one_per_purpose(self):
        from dgc import pip_library as pip_artifacts
        words = " ".join(s["function"]["description"] for s in pip_artifacts.schemas())
        self.assertIn("one", words.lower())
        self.assertIn("edit_artifact", words)
        self.assertEqual({s["function"]["name"] for s in pip_artifacts.schemas()}, {"make_artifact", "edit_artifact"})


class APipReadsAPageAndDGCsDocs(unittest.TestCase):
    """His "yes to your full add list" (15 Nov): a quick read of one public page, through the controller with DGC's
    leak guard and careful mode as its search has; and DGC's own docs, read-only."""

    def setUp(self):
        from tests import test_pips_local as fixtures
        fixtures.LocalPipsTests.setUp(self)
        self.pip = self.store.create(self.registry.personal()["id"], "Reader", "Read things", "editor-user")
        from dgc import pip_app_links as links
        self.server = links.RunSocket(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], "run_" + "e" * 32)
        self.addCleanup(self.server.close)

    def test_it_reads_one_public_page_as_untrusted_text(self):
        from unittest import mock
        with mock.patch("dgc.tools._fetch_public_text", return_value=("https://example.com/a", "<h1>Hello</h1><p>World</p>")):
            said = self.server.call("web_fetch", {"url": "https://example.com/a"})
        self.assertIn("Untrusted", said)
        self.assertIn("Hello", said)

    def test_careful_mode_keeps_what_it_read_from_your_apps_out_of_an_address(self):
        import types
        self.server.taint, self.server.said = types.SimpleNamespace(carried=lambda text, said: ["a line from your mail"]), ""
        said = self.server.call("web_fetch", {"url": "https://example.com/?q=secret+line"})
        self.assertTrue(said.startswith("Not read"), said)

    def test_its_tools_offer_the_page_read_and_the_docs(self):
        from dgc import pip_app_links as links, pip_library
        names = {s["function"]["name"] for s in links.schemas([])}
        self.assertIn("web_fetch", names)
        self.assertIn("dgc_docs", {s["function"]["name"] for s in pip_library.doc_schemas()})
        self.assertIn("Slash commands", pip_library.docs({"query": "slash commands"}))


if __name__ == "__main__":
    unittest.main()
