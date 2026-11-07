"""A page downloads as Word and PDF, and as Excel when it holds a table: what people pass around, not only a web page.
He asked for it on 2026-11-07, about a mail summary made as a page."""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

if "dgc.config" not in sys.modules:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-page-downloads-")
    os.environ["HOME"] = os.path.realpath(_HOME.name)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_page_export as page_export, artifact_service as service  # noqa: E402
from dgc.artifact_store import Store  # noqa: E402

PAGE = """<!doctype html><html><head><title>Inbox Summary</title><style>body{color:red} .x{}</style>
<script>var secret = "not a word of the page";</script></head><body>
<nav><a href="#a">Jump to the list</a></nav>
<h1>Inbox Summary</h1>
<p>Ten mails, <strong>two</strong> need you. See <a href="https://example.com/more">the site</a> or <a href="/local">here</a>.</p>
<button>Copy this page</button>
<div hidden>Hidden words</div><p style="display:none">Also hidden</p>
<h2>By sender</h2>
<table><thead><tr><th>Sender</th><th>Subject</th><th>Count</th></tr></thead>
<tbody><tr><td>Priya</td><td>Invoice &amp; order</td><td>3</td></tr><tr><td>Arjun</td><td>Lunch</td><td>7</td></tr></tbody></table>
<ul><li>Reply to Priya<ul><li>Today</li></ul></li><li>Call the bank</li></ul>
<ol start="3"><li>Third thing</li></ol>
<blockquote>Quoted words</blockquote><pre>line one
  line two</pre><hr><img src="a.png" alt="A chart of the week">
</body></html>"""


def text_of(raw: bytes, part: str) -> str:
    with zipfile.ZipFile(__import__("io").BytesIO(raw)) as zf:
        return zf.read(part).decode("utf-8")


class Reading(unittest.TestCase):
    def setUp(self):
        self.page = page_export.read(PAGE)
        self.words = "\n".join("".join(r.text for r in b.runs) or b.text for b in self.page.blocks)

    def test_it_reads_what_the_page_says_in_order(self):
        kinds = [b.kind for b in self.page.blocks]
        for kind in ("heading", "para", "table", "item", "quote", "code", "rule"):
            self.assertIn(kind, kinds)
        self.assertLess(self.words.index("Inbox Summary"), self.words.index("Ten mails"))
        self.assertEqual(self.page.title, "Inbox Summary")
        self.assertIn("A chart of the week", self.words)

    def test_scripts_styles_navigation_buttons_and_hidden_parts_are_not_what_it_says(self):
        for gone in ("not a word", "color:red", "Jump to the list", "Copy this page", "Hidden words", "Also hidden"):
            self.assertNotIn(gone, self.words)

    def test_links_keep_only_addresses_that_lead_somewhere(self):
        para = next(b for b in self.page.blocks if b.kind == "para" and "Ten mails" in "".join(r.text for r in b.runs))
        hrefs = {r.text: r.href for r in para.runs if r.href}
        self.assertEqual(hrefs, {"the site": "https://example.com/more"}, "a link inside the page has nowhere to go from a file")
        self.assertIn("here", "".join(r.text for r in para.runs))
        self.assertTrue(any(r.bold and r.text == "two" for r in para.runs))

    def test_a_list_keeps_its_depth_and_numbers(self):
        items = [(("".join(r.text for r in b.runs)), b.level, b.ordered, b.number) for b in self.page.blocks if b.kind == "item"]
        self.assertEqual(items, [("Reply to Priya", 0, False, 1), ("Today", 1, False, 1), ("Call the bank", 0, False, 2), ("Third thing", 0, True, 3)])

    def test_a_table_used_for_layout_is_not_data(self):
        self.assertFalse(page_export.has_table("<table><tr><td>Only one cell</td></tr></table>"))
        self.assertFalse(page_export.has_table("<p>No table</p>"))
        self.assertFalse(page_export.has_table("<table><tr><td>a</td></tr><tr><td>b</td></tr></table>"))
        self.assertTrue(page_export.has_table(PAGE))
        laid_out = page_export.read("<table><tr><td>Only one cell</td></tr></table>")
        self.assertEqual([b.kind for b in laid_out.blocks], ["para"])

    def test_broken_html_still_gives_what_it_can(self):
        page = page_export.read("<h1>Top<p>Words <b>bold<table><tr><td>a<td>b<tr><td>c<td>d")
        self.assertTrue(page_export.has_words(page))
        self.assertEqual(page.tables[0]["rows"], [["a", "b"], ["c", "d"]])


class Downloads(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.store = Store(Path(self.dir.name))
        self.made = self.page(PAGE, "Inbox Summary")

    def page(self, html, title):
        return service.make("page", title, {"html": html}, origin={"surface": "chat"}, store=self.store)

    def export(self, aid, fmt, **kw):
        return service.export(aid, fmt, store=self.store, **kw)

    def test_a_page_offers_word_and_pdf_first_and_excel_when_it_holds_a_table(self):
        self.assertEqual(self.made["exports"], ["docx", "pdf", "xlsx", "html", "zip"])
        plain = self.page("<h1>Note</h1><p>Words</p>", "Note")
        self.assertEqual(plain["exports"], ["docx", "pdf", "html", "zip"])
        with self.assertRaisesRegex(service.ArtifactUseError, "no table"):
            self.export(plain["id"], "xlsx")

    def test_word_holds_the_words_and_the_table(self):
        path = self.export(self.made["id"], "word")
        self.assertEqual(path.suffix, ".docx")
        xml = text_of(path.read_bytes(), "word/document.xml")
        self.assertIn("Inbox Summary", xml)
        self.assertIn("<w:tbl>", xml)
        self.assertIn("Invoice &amp; order", xml)
        self.assertNotIn("not a word", xml)

    def test_excel_holds_each_table_named_for_the_heading_above_it(self):
        raw = self.export(self.made["id"], "excel").read_bytes()
        self.assertIn('name="By sender"', text_of(raw, "xl/workbook.xml"))
        sheet = text_of(raw, "xl/worksheets/sheet1.xml")
        self.assertIn("Priya", sheet)
        self.assertIn("<v>3</v>", sheet, "a count is a number in the workbook")

    def test_pdf_prints_the_page_with_its_own_files_beside_it(self):
        seen = {}

        class Browser:
            def navigate(self, url):
                path = url[len("file://"):]
                seen["url"] = url
                seen["page"] = Path(path).read_text(encoding="utf-8")
                seen["beside"] = sorted(p.name for p in Path(path).parent.rglob("*") if p.is_file())

            def command(self, method, params=None, timeout=0):
                seen["method"] = method
                return {"data": base64.b64encode(b"%PDF-1.7 printed").decode()}

        made = service.make("page", "Site", {"files": {"index.html": "<h1>Hi</h1><img src='a.png'>", "a.png": "x"}, "entry": "index.html"},
                            origin={"surface": "chat"}, store=self.store)
        raw = self.export(made["id"], "pdf", browser=Browser()).read_bytes()
        self.assertEqual(raw, b"%PDF-1.7 printed")
        self.assertEqual(seen["method"], "Page.printToPDF")
        self.assertIn("a.png", seen["beside"])
        self.assertIn("<h1>Hi</h1>", seen["page"])
        self.assertFalse(Path(seen["url"][len("file://"):]).exists(), "its folder goes when it's done")

    def test_with_no_browser_a_pdf_still_holds_the_words(self):
        class NoBrowser:
            def navigate(self, url):
                raise RuntimeError("no browser")

        raw = self.export(self.made["id"], "pdf", browser=NoBrowser()).read_bytes()
        self.assertTrue(raw.startswith(b"%PDF"))

    def test_a_page_that_draws_itself_says_what_to_do(self):
        class NoBrowser:
            def navigate(self, url):
                raise RuntimeError("no browser")

        drawn = self.page("<canvas></canvas><script>draw()</script>", "Drawn")
        with self.assertRaisesRegex(service.ArtifactUseError, "Download it as PDF"):
            self.export(drawn["id"], "docx", browser=NoBrowser())

    def test_a_page_that_writes_itself_is_read_after_its_script_has_run(self):
        class Browser:
            def navigate(self, url):
                pass

            def evaluate_json(self, expression, timeout=None):
                return "<html><body><h1>Written by script</h1></body></html>"

        written = self.page("<div id=x></div><script>x.innerHTML='<h1>Written by script</h1>'</script>", "Written")
        xml = text_of(self.export(written["id"], "docx", browser=Browser()).read_bytes(), "word/document.xml")
        self.assertIn("Written by script", xml)


if __name__ == "__main__":
    unittest.main()
