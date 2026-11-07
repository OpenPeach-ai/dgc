"""The model's make_artifact and edit_artifact, in a Work session.

Three things matter beyond "it makes one":
- the names are never published in ready.tools (TOOL_SCHEMAS): an installed dgc-sdk with allow_tools raises on a
  runtime tool it can't name, so publishing them would end every such embedder's session the day the CLI updates;
- a deck's picture comes only from inside the project, never a dot folder or a private file;
- the screens hear that an artifact was made, and the model reads back a short line, not the artifact.
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_tools, permissions, tools
from dgc.agent import AgentContext
from dgc.config import Config

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


class WorkArtifactTools(unittest.TestCase):
    def test_non_text_note_still_has_a_safe_activity_label(self):
        self.assertEqual(artifact_tools.args_preview({"id": "art_123", "note": {"why": "update"}}),
                         "art_123 · {'why': 'update'}")
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-arttools-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")
        self.root = self.tmp / "proj"
        (self.root / "img").mkdir(parents=True)
        (self.root / "img" / "chart.png").write_bytes(PNG)
        (self.root / ".secret").mkdir()
        (self.root / ".secret" / "logo.png").write_bytes(PNG)
        (self.tmp / "outside.png").write_bytes(PNG)
        self.heard = []
        self.ctx = AgentContext(self.root, Config(self.root), on_artifact=lambda v, op: self.heard.append((v, op)),
                                artifact_origin=lambda: {"surface": "work", "project": str(self.root),
                                                         "session": "s1"})

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def deck(self, src):
        return {"type": "slides", "title": "Q3", "data": {"slides": [
            {"layout": "title", "title": "Q3 review"},
            {"layout": "image", "title": "Chart", "image": {"src": src, "alt": "chart"}}]}}

    def test_make_then_read_then_edit_a_doc(self):
        out = tools.execute("make_artifact", {"type": "doc", "title": "Notes", "content": "# Notes\n\nOne.\n"},
                            self.ctx)
        self.assertTrue(out.startswith("Made Document “Notes” (ar_"), out)
        view, op = self.heard[-1]
        self.assertEqual((op, view["origin"]), ("made", {"surface": "work", "project": str(self.root),
                                                         "session": "s1"}))
        read = tools.execute("edit_artifact", {"id": view["id"]}, self.ctx)
        self.assertIn("One.", read)
        changed = tools.execute("edit_artifact", {"id": view["id"], "edits": [{"find": "One.", "replace": "Two."}],
                                                  "note": "Fixed"}, self.ctx)
        self.assertIn("version 2", changed)
        self.assertEqual(self.heard[-1][1], "changed")

    def test_a_deck_takes_a_picture_from_the_project_only(self):
        self.assertTrue(tools.execute("make_artifact", self.deck("img/chart.png"), self.ctx).startswith("Made"))
        for bad in (str(self.tmp / "outside.png"), "../outside.png", ".secret/logo.png"):
            out = tools.execute("make_artifact", self.deck(bad), self.ctx)
            self.assertTrue(out.startswith("error:"), (bad, out))

    def test_a_bad_call_says_what_to_fix_and_writes_nothing(self):
        out = tools.execute("make_artifact", {"type": "slides", "title": "X"}, self.ctx)
        self.assertTrue(out.startswith("error:"), out)
        out = tools.execute("make_artifact", {"type": "design", "title": "X", "data": {}}, self.ctx)
        self.assertTrue(out.startswith("error:"), out)
        self.assertEqual(self.heard, [])

    def test_the_names_are_never_published_in_ready_tools(self):
        published = {s["function"]["name"] for s in tools.TOOL_SCHEMAS}
        self.assertFalse(artifact_tools.NAMES & published,
                         "an installed dgc-sdk with allow_tools would refuse a session listing these")
        self.assertEqual({s["function"]["name"] for s in tools.ARTIFACT_TOOL_SCHEMAS}, set(artifact_tools.NAMES))

    def test_no_approval_card_but_a_rule_can_name_them(self):
        for name in artifact_tools.NAMES:
            self.assertIn(name, permissions.READ_ONLY_TOOLS)
            self.assertIn(name, permissions.DISPLAY)
        from dgc_sdk import policy as sdk_policy                       # the SDK can name them in a policy
        self.assertEqual(sdk_policy._DISPLAY["make_artifact"], "MakeArtifact")

    def test_a_page_outside_the_project_is_refused_with_the_way_that_needs_no_file(self):
        # A page of someone's mail summary was refused as outside the project, so the model copied it into their repo.
        from dgc.agent import Agent
        from dgc.llm import ToolCall
        page = self.tmp / "dgc-pages" / "inbox.html"
        page.parent.mkdir()
        page.write_text("<h1>Inbox</h1>", encoding="utf-8")
        cfg = Config(self.root)
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})

        class Quiet:
            def __getattr__(self, name):
                return lambda *a, **k: None
        agent = Agent(cfg, Quiet())
        self.addCleanup(agent.mcp.stop_all)
        said = agent._handle_call(ToolCall("c1", "artifact", {"path": str(page), "name": "Inbox"}))
        self.assertIn("outside the project", said)
        self.assertIn('make_artifact with type "page"', said)
        self.assertIn("Do not copy the file into the project", said)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), [".secret", "img"], "nothing landed in the project")
        # And the way it names works: a page with no file in the project.
        made = tools.execute("make_artifact", {"type": "page", "title": "Inbox", "content": "<h1>Inbox</h1>"}, self.ctx)
        self.assertTrue(made.startswith("Made Page “Inbox” (ar_"), made)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), [".secret", "img"])

    def test_the_words_say_a_page_needs_no_file_in_the_project(self):
        schema = next(row["function"]["description"] for row in tools.TOOL_SCHEMAS if row["function"]["name"] == "artifact")
        self.assertIn("make_artifact with type page", schema)
        self.assertIn("Never copy a page into the project", schema)
        self.assertIn("needs no file", artifact_tools.MAKE_ARTIFACT["function"]["description"])

    def test_the_output_chip_line_and_the_note_when_it_wasnt_made(self):
        self.assertIn("make_artifact (type slides)", artifact_tools.output_line("slides"))
        self.assertEqual(artifact_tools.output_line("auto"), "")
        self.assertEqual(artifact_tools.missing_note("slides", ["slides"]), "")
        self.assertIn("didn't make slides", artifact_tools.missing_note("slides", ["doc"]))
        self.assertEqual(artifact_tools.missing_note("auto", []), "")


if __name__ == "__main__":
    unittest.main()
