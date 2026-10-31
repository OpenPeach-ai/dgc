"""A Pip writes into artifacts: each finished Quill draft is the newest version of that Pip's own document; a Pip's
review can be kept as its own document or sheet too (report_as), and a Pip keeps the dashboards it refreshes current
after every run (get_pip_artifacts / set_pip_artifacts, Pips API 67)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_pips, artifact_service as S


class PipDocs(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-artpips-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp)

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def test_each_draft_is_a_new_version_of_one_document_by_the_pip(self):
        first = artifact_pips.keep_draft("pip_1", "Quill", "Setup guide", "# Setup\n\nStep one.\n", workspace="ws")
        again = artifact_pips.keep_draft("pip_1", "Quill", "Setup guide, revised", "# Setup\n\nStep two.\n")
        self.assertEqual(first, again)
        view = S.view(first)
        self.assertEqual(view["origin"], {"surface": "pip", "pip": "pip_1", "workspace": "ws"})
        self.assertTrue(view.get("file"), "the document keeps its working file, so the editor's saves are versions")
        self.assertEqual([(v["author"], v["summary"]) for v in view["versions"]],
                         [("Quill", "Setup guide"), ("Quill", "Setup guide, revised")])
        self.assertEqual(Path(view["file"]).read_text(), "# Setup\n\nStep two.\n")

    def test_another_pip_has_its_own_document(self):
        a = artifact_pips.keep_draft("pip_1", "Quill", "A", "# A\n")
        b = artifact_pips.keep_draft("pip_2", "Docs Quill", "B", "# B\n")
        self.assertNotEqual(a, b)

    def test_a_store_that_fails_never_fails_the_run(self):
        with patch.object(S, "make", side_effect=OSError("disk full")):
            self.assertEqual(artifact_pips.keep_draft("pip_9", "Quill", "T", "# T\n"), "")
        self.assertEqual(artifact_pips.keep_draft("pip_9", "Quill", "T", "   "), "")


FINDINGS = [{"title": "Upload size isn't checked", "severity": "medium", "path": "api/upload.py", "line": 42,
             "evidence": "data = request.files['f'].read()"},
            {"title": "Token in a log line", "severity": "high", "path": "api/auth.py", "line": 7,
             "evidence": "log.info(f'token={token}')"}]


class PipReports(unittest.TestCase):
    """report_as and dashboards through the Pips control API, and what a finished run does with them."""
    def setUp(self):
        from tests import test_pips_local as fixtures
        fixtures.LocalPipsTests.setUp(self)
        os.environ["DGC_HOME"] = str(Path(self.registry.directory).parent / "dgc-home")
        self.pip = self.store.create(self.registry.personal()["id"], "Reviewer", "Review my code", "editor-user")

    def control(self, command, actor="editor-user", **fields):
        from dgc import pips
        from dgc.workspace_registry import RegistryError, WorkspaceRegistry
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def run_done(self, findings=FINDINGS, status="succeeded", kind="audit"):
        run = {"pip_id": self.pip["id"], "workspace_id": self.pip["workspace_id"], "manifest": {"run_kind": kind}}
        return artifact_pips.after_run(self.registry.db, run, status=status, result={"findings": findings})

    def test_api_67_offers_it_and_a_pip_starts_with_its_report_in_chat_only(self):
        from dgc.headless import PIPS_API_VERSION
        from dgc.workspace_registry import RegistryError
        self.assertGreaterEqual(PIPS_API_VERSION, 67)
        got = self.control("get_pip_artifacts", pip_id=self.pip["id"])["artifacts"]
        self.assertEqual(got, {"report_as": "chat", "dashboards": [], "report_doc": "", "report_doc_title": "",
                               "report_doc_version": 0, "report_sheet": "", "report_sheet_title": "",
                               "report_sheet_version": 0})
        self.assertEqual(self.run_done(), {"report": "", "refreshed": []}, "chat only: no document is made")
        with self.assertRaises(RegistryError):
            self.control("set_pip_artifacts", pip_id=self.pip["id"], report_as="email")
        with self.assertRaises(RegistryError):
            self.control("set_pip_artifacts", pip_id=self.pip["id"], dashboards=["ar_" + "0" * 16])
        with self.assertRaises(RegistryError):
            self.control("get_pip_artifacts", pip_id="pip_" + "0" * 32)
        with self.assertRaises(RegistryError) as refused:
            self.control("set_pip_artifacts", actor="remote-client", pip_id=self.pip["id"], report_as="doc")
        self.assertEqual(refused.exception.code, "local_only")

    def test_a_review_kept_as_a_document_most_serious_first_each_run_a_version(self):
        self.control("set_pip_artifacts", pip_id=self.pip["id"], report_as="doc")
        first = self.run_done()["report"]
        self.assertTrue(first)
        view = S.view(first)
        self.assertEqual((view["type"], view["origin"]["surface"]), ("doc", "pip"))
        text = Path(view["file"]).read_text()
        self.assertLess(text.index("Token in a log line"), text.index("Upload size"), "the most serious first")
        self.assertIn("`api/auth.py:7`", text)
        self.assertIn("2 findings (1 high, 1 medium)", text)
        self.assertEqual(self.run_done(findings=[])["report"], first, "the next review is a version of the same one")
        self.assertIn("Nothing found.", Path(S.view(first)["file"]).read_text())
        self.assertEqual(len(S.view(first)["versions"]), 2)
        got = self.control("get_pip_artifacts", pip_id=self.pip["id"])["artifacts"]
        # Which document and how many reviews it holds, so the Pip's page can say more than "Open".
        self.assertEqual((got["report_doc"], got["report_doc_title"], got["report_doc_version"]),
                         (first, S.view(first)["title"], 2))
        self.assertEqual((got["report_sheet"], got["report_sheet_title"], got["report_sheet_version"]), ("", "", 0))
        self.assertEqual(self.run_done(status="failed")["report"], "", "only a finished review")
        self.assertEqual(self.run_done(kind="conversation")["report"], "", "a chat reply isn't a review")

    def test_a_review_kept_as_a_sheet_a_row_a_finding(self):
        self.control("set_pip_artifacts", pip_id=self.pip["id"], report_as="sheet")
        aid = self.run_done()["report"]
        from dgc.artifact_store import store
        book = store().source(aid)
        rows = book["sheets"][0]["rows"]
        self.assertEqual([r[0] for r in rows], ["high", "medium"])
        self.assertEqual(rows[0][2:4], ["api/auth.py", 7])

    def test_a_pip_keeps_its_dashboards_current_after_each_run(self):
        project = Path(os.environ["DGC_HOME"]).parent / "shop"
        (project / "data").mkdir(parents=True)
        (project / "data" / "orders.csv").write_text("id,total\n1,100\n2,250\n")
        dash = S.make("dashboard", "Orders", {"title": "Orders", "sources": [{"id": "orders", "kind": "file", "path": "data/orders.csv"}],
                      "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "orders", "value": "n",
                                   "query": "SELECT COUNT(*) AS n FROM orders"}]},
                      origin={"surface": "work", "project": str(project)})
        S.allow_source(dash["id"], "orders")
        self.control("set_pip_artifacts", pip_id=self.pip["id"], dashboards=[dash["id"]])
        self.assertEqual(self.run_done(kind="test")["refreshed"], [dash["id"]], "any finished run, a Pulse's checks too")
        first = json.dumps(S.state(dash["id"]))
        self.assertIn("2", first)
        (project / "data" / "orders.csv").write_text("id,total\n1,100\n2,250\n3,75\n")
        self.run_done(kind="test")
        self.assertIn("3", json.dumps(S.state(dash["id"])["results"]))

    def test_a_pip_refresh_uses_the_plugin_read_only_hooks_and_closes_them(self):
        from dgc import artifact_plugins
        dash = S.make("dashboard", "Issues", {
            "sources": [{"id": "gh", "kind": "plugin", "server": "github"}],
            "widgets": [{"id": "n", "kind": "number", "title": "Open issues", "source": "gh",
                         "query": {"tool": "search_issues", "args": {"q": "is:open"}, "path": "total_count"}}]},
            origin={"surface": "work"})
        S.allow_source(dash["id"], "gh")
        self.control("set_pip_artifacts", pip_id=self.pip["id"], dashboards=[dash["id"]])
        calls, closed = [], []

        def hooks(config):
            self.assertIs(config, self.cfg)
            return (lambda server, tool, args: calls.append((server, tool, args)) or {"total_count": 3},
                    lambda server, tool: tool == "search_issues", lambda: closed.append(True))

        run = {"pip_id": self.pip["id"], "workspace_id": self.pip["workspace_id"],
               "manifest": {"run_kind": "test"}}
        with patch.object(artifact_plugins, "hooks", side_effect=hooks):
            done = artifact_pips.after_run(self.registry.db, run, status="succeeded", result={}, config=self.cfg)
        self.assertEqual(done["refreshed"], [dash["id"]])
        self.assertEqual(calls, [("github", "search_issues", {"q": "is:open"})])
        self.assertEqual(closed, [True])


    def test_a_deleted_dashboard_drops_out_of_the_list_instead_of_blocking_every_change(self):
        """Reported with the Pip page: once a dashboard a Pip refreshed was deleted, every later save of its list was
        refused ("isn't a dashboard"), Add and Remove alike. One it had is dropped now; a new wrong id still isn't."""
        from dgc.workspace_registry import RegistryError
        project = Path(os.environ["DGC_HOME"]).parent / "books"
        (project / "data").mkdir(parents=True)
        (project / "data" / "sales.csv").write_text("id,total\n1,100\n")
        spec = {"sources": [{"id": "sales", "kind": "file", "path": "data/sales.csv"}],
                "widgets": [{"id": "n", "kind": "number", "title": "Sales", "source": "sales", "value": "n",
                             "query": "SELECT COUNT(*) AS n FROM sales"}]}
        keep, gone, new = (S.make("dashboard", name, dict(spec, title=name),
                                  origin={"surface": "work", "project": str(project)})["id"]
                           for name in ("Keep", "Gone", "New"))
        self.control("set_pip_artifacts", pip_id=self.pip["id"], dashboards=[keep, gone])
        S.remove(gone)
        self.assertEqual(self.control("get_pip_artifacts", pip_id=self.pip["id"])["artifacts"]["dashboards"],
                         [keep, gone], "read as stored: the page shows it as removed")
        saved = self.control("set_pip_artifacts", pip_id=self.pip["id"], dashboards=[keep, gone, new])
        self.assertEqual(saved["artifacts"]["dashboards"], [keep, new])
        with self.assertRaises(RegistryError):
            self.control("set_pip_artifacts", pip_id=self.pip["id"], dashboards=[keep, "ar_" + "0" * 16])

if __name__ == "__main__":
    unittest.main()
