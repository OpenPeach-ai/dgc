"""Files ChatDGC makes: each writer's output is a real file of its kind (every part well-formed, every relationship
pointing at a part that exists, every part with a content type), DGC's own reader gets the words back, and nothing
the model wrote can become markup, a script or a remote load."""
import base64
import io
import re
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from xml.dom import minidom

from dgc import documents
from dgc.chatdgc import made
from dgc.chatdgc.engine import LOOK_UP, ChatEngine
from dgc.chatdgc.store import ChatStore
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory

CONFIG = SimpleNamespace(get=lambda key, default=None: default)
BRIEF = """# London flat: FEMA brief

Buying from India runs through the **Liberalised Remittance Scheme** (LRS). See [RBI](https://www.rbi.org.in/).

## The limit

- USD 250,000 a year
  - per person
- TCS above ₹10 lakh

1. Open an account
2. Send the money

| Route | Cap |
|---|--:|
| LRS | 250,000 |

> Check with your bank.

```
total = 250000 * 2
```
"""


def _package(raw: bytes) -> dict[str, bytes]:
    """Open an OOXML package and check it the way Office does: every XML part parses, every relationship's target
    exists, and every part has a content type."""
    archive = zipfile.ZipFile(io.BytesIO(raw))
    parts = {name: archive.read(name) for name in archive.namelist()}
    assert archive.namelist()[0] == "[Content_Types].xml"
    for name, data in parts.items():
        minidom.parseString(data)                      # raises on anything malformed
    types = parts["[Content_Types].xml"].decode()
    defaults = set(re.findall(r'Default Extension="([^"]+)"', types))
    overrides = set(re.findall(r'Override PartName="([^"]+)"', types))
    for name in parts:
        if name != "[Content_Types].xml":
            assert "/" + name in overrides or name.rsplit(".", 1)[-1] in defaults, f"{name} has no content type"
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        base = name.replace("_rels/", "").removesuffix(".rels")
        folder = base.rsplit("/", 1)[0] if "/" in base else ""
        for target, mode in re.findall(r'Target="([^"]+)"(?: TargetMode="([^"]+)")?', data.decode()):
            if mode == "External":
                continue
            path = target.lstrip("/") if target.startswith("/") else "/".join(p for p in (folder, target) if p)
            while "/../" in "/" + path:
                path = re.sub(r"(^|/)[^/]+/\.\./", r"\1", path, count=1)
            assert path in parts, f"{name} points at {path}, which isn't there"
    return parts


class Documents(unittest.TestCase):
    def test_a_word_document_is_a_real_one_and_reads_back(self):
        m = made.make({"name": "London FEMA brief", "format": "docx", "content": BRIEF}, CONFIG)
        self.assertEqual((m.name, m.mime), ("London FEMA brief.docx", made.FORMATS["docx"][1]))
        parts = _package(m.raw)
        body = parts["word/document.xml"].decode()
        self.assertIn('w:val="Title"', body, "the first # heading is the title")
        self.assertIn('w:val="Heading1"', body, "## under it is a first-level heading")
        self.assertEqual(body.count("<w:numPr>"), 5, "four list items and one nested")
        self.assertIn("<w:tbl>", body)
        self.assertIn('TargetMode="External"', parts["word/_rels/document.xml.rels"].decode())
        text = documents.extract_text(m.raw, m.name).text
        for words in ("London flat: FEMA brief", "Liberalised Remittance Scheme", "₹10 lakh", "250,000", "total = 250000"):
            self.assertIn(words, text)
        self.assertEqual(m.text, BRIEF, "the model reads back what it wrote")

    def test_a_new_line_is_a_new_line_as_in_a_letter(self):
        letter = "**To:** Mr Rao\nFlat 4B, Hill Road\n\nYours sincerely,\nAnya"
        m = made.make({"name": "Notice", "format": "docx", "content": letter}, CONFIG)
        self.assertIn("<w:r><w:br/></w:r>", _package(m.raw)["word/document.xml"].decode())
        self.assertIn("Mr Rao\nFlat 4B, Hill Road", documents.extract_text(m.raw, m.name).text)
        self.assertIn("Mr Rao<br>Flat 4B", made.page_html("Notice", made.parse(letter)))
        from pypdf import PdfReader
        raw, _, _ = made.plain_pdf("Notice", made.parse(letter))
        lines = PdfReader(io.BytesIO(raw)).pages[0].extract_text().splitlines()
        self.assertIn("Yours sincerely,", lines)
        self.assertIn("Anya", lines)

    def test_without_a_heading_the_name_is_the_title(self):
        body = _package(made.make({"name": "Notes", "format": "docx", "content": "Just a line."}, CONFIG).raw)
        self.assertIn("Notes", body["word/document.xml"].decode())

    def test_nothing_the_model_writes_becomes_markup(self):
        hostile = 'A <w:p>, ]]> & "quotes" <script>alert(1)</script>\x01\x0b and [x](javascript:alert(1))'
        m = made.make({"name": "x", "format": "docx", "content": hostile}, CONFIG)
        body = _package(m.raw)["word/document.xml"].decode()
        self.assertIn("&lt;script&gt;", body)
        self.assertNotIn("javascript:", _package(m.raw)["word/_rels/document.xml.rels"].decode(), "only web and mail links")
        page = made.page_html("x", made.parse(hostile))
        self.assertNotIn("<script>", page)
        self.assertIn("default-src 'none'", page, "the printed page loads nothing from anywhere")
        self.assertNotIn('href="javascript:', page)

    def test_markdown_is_kept_as_written(self):
        m = made.make({"name": "notes.md", "format": "md", "content": BRIEF}, CONFIG)
        self.assertEqual((m.name, m.raw.decode()), ("notes.md", BRIEF))


class Spreadsheets(unittest.TestCase):
    def test_a_workbook_keeps_numbers_numbers_and_text_text(self):
        m = made.make({"name": "Budget", "format": "xlsx", "sheets": [
            {"name": "Costs: 2026/27", "rows": [["Item", "Amount"], ["Flat", 450000], ["Fees", "12,500"],
                                                ["Code", "007"], ["Total", "=SUM(B2:B3)"]]},
            {"name": "Costs: 2026/27", "rows": [["a"], ["b"]]}]}, CONFIG)
        parts = _package(m.raw)
        sheet = parts["xl/worksheets/sheet1.xml"].decode()
        self.assertIn('<c r="B2" s="2"><v>450000</v></c>', sheet, "a big whole number shows its thousands: 450,000")
        self.assertIn('<c r="B3" s="2"><v>12500</v></c>', sheet, "a number written with commas is still a number")
        self.assertIn("<t xml:space=\"preserve\">007</t>", sheet, "a code keeps its leading zero")
        self.assertIn("<f>SUM(B2:B3)</f>", sheet)
        self.assertIn('ySplit="1"', sheet, "the header row stays in view")
        names = re.findall(r'<sheet name="([^"]+)"', parts["xl/workbook.xml"].decode())
        self.assertEqual(names, ["Costs 202627", "Costs 202627 2"], "Excel's rules: no : or /, unique")
        self.assertIn('fullCalcOnLoad="1"', parts["xl/workbook.xml"].decode(), "formulas compute when opened")
        self.assertIn("Total", documents.extract_text(m.raw, m.name).text)

    def test_a_csv_is_one_sheet(self):
        m = made.make({"name": "rows", "format": "csv", "rows": [["a", "b"], [1, "x,y"]]}, CONFIG)
        self.assertEqual(m.raw.decode("utf-8-sig"), 'a,b\n1,"x,y"\n')

    def test_limits_say_what_to_change(self):
        with self.assertRaisesRegex(made.MadeError, "100,000 cells"):
            made.make({"name": "big", "format": "xlsx", "sheets": [{"rows": [[1] * 1000] * 101}]}, CONFIG)
        with self.assertRaisesRegex(made.MadeError, "docx, pdf, xlsx, pptx, csv or md"):
            made.make({"name": "x", "format": "exe", "content": "x"}, CONFIG)
        with self.assertRaisesRegex(made.MadeError, "Markdown"):
            made.make({"name": "x", "format": "docx", "content": "  "}, CONFIG)


class Decks(unittest.TestCase):
    def test_a_deck_is_a_real_one_and_reads_back(self):
        m = made.make({"name": "Deck", "format": "pptx", "slides": [
            {"title": "Buying in London", "subtitle": "A FEMA walk-through"},
            {"title": "The limit", "bullets": ["USD 250,000 a year", {"text": "per person", "level": 1}]},
            {"title": "Routes", "table": [["Route", "Cap"], ["LRS", "250,000"]]}]}, CONFIG)
        parts = _package(m.raw)
        self.assertEqual(len([p for p in parts if re.fullmatch(r"ppt/slides/slide\d+\.xml", p)]), 3)
        self.assertIn('type="ctrTitle"', parts["ppt/slides/slide1.xml"].decode(), "a first slide alone is a title slide")
        self.assertIn('lvl="1"', parts["ppt/slides/slide2.xml"].decode())
        self.assertIn("<a:tbl>", parts["ppt/slides/slide3.xml"].decode())
        text = documents.extract_text(m.raw, m.name).text
        for words in ("Buying in London", "per person", "LRS"):
            self.assertIn(words, text)
        self.assertIn("## Slide 2: The limit\n- USD 250,000 a year\n  - per person", m.text)

    def test_a_crowded_slide_is_refused(self):
        with self.assertRaisesRegex(made.MadeError, "split it"):
            made.make({"name": "d", "format": "pptx", "slides": [{"title": "t", "bullets": ["x"] * 13}]}, CONFIG)


class Pdfs(unittest.TestCase):
    def test_the_users_browser_prints_the_page_dgc_wrote(self):
        seen = {}

        class Browser:
            def navigate(self, url):
                with open(url.removeprefix("file://"), encoding="utf-8") as handle:
                    seen["page"] = handle.read()

            def command(self, method, params, timeout=0):
                seen["print"] = (method, params)
                return {"data": base64.b64encode(b"%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF").decode()}
        m = made.make({"name": "Brief", "format": "pdf", "content": BRIEF}, CONFIG, browser=Browser())
        self.assertEqual((m.raw[:8], m.note, m.pages), (b"%PDF-1.7", "", 1))
        self.assertEqual(seen["print"][0], "Page.printToPDF")
        self.assertTrue(seen["print"][1]["printBackground"])
        self.assertIn("<h2>The limit</h2>", seen["page"])
        self.assertIn("₹10 lakh", seen["page"], "the browser draws every script")

    def test_without_a_browser_the_plain_writer_says_what_it_couldnt_draw(self):
        class NoBrowser:
            def navigate(self, url):
                raise RuntimeError("No Chrome or Chromium found. Install one")
        m = made.make({"name": "Brief", "format": "pdf", "content": BRIEF}, CONFIG, browser=NoBrowser())
        self.assertIn("no Chrome or Edge was found", m.note)
        self.assertIn("1 character it can't draw show as ?", m.note, "₹")
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(m.raw))
        self.assertEqual(len(reader.pages), m.pages)
        text = reader.pages[0].extract_text()
        self.assertIn("Liberalised Remittance Scheme", text)
        for offset in re.findall(rb"(\d{10}) 00000 n", m.raw):
            self.assertRegex(m.raw[int(offset):int(offset) + 12], rb"^\d+ 0 obj", "the cross-reference table is exact")

    def test_a_long_document_runs_to_more_pages(self):
        raw, missing, pages = made.plain_pdf("Long", made.parse("\n\n".join(f"Paragraph {n} " * 12 for n in range(120))))
        self.assertGreater(pages, 3)
        self.assertEqual(missing, 0)


class Names(unittest.TestCase):
    def test_a_name_any_system_can_keep(self):
        self.assertEqual(made.file_name('Q3: "plan" / v2?', "docx"), "Q3 plan v2.docx")
        self.assertEqual(made.file_name("report.PDF", "pdf"), "report.pdf")
        self.assertEqual(made.file_name("", "xlsx"), "ChatDGC file.xlsx")
        self.assertEqual(len(made.file_name("x" * 300, "md")), made.MAX_NAME + 3)


class Model:
    """Follows its script: words, and tool calls. Records what it was given each time."""

    def __init__(self, world):
        self.world, self.model, self.context_size = world, "chat-model", 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        if str(messages[0]["content"]).startswith(LOOK_UP[:60]):       # the check before a reply: nothing to look up
            return SimpleNamespace(content="", tool_calls=[ToolCall("lu", "search_first", {"needs_search": False, "query": ""})],
                                   finish_reason="stop", thinking="", usage={})
        self.world["read"].append({"messages": messages, "tools": [t["function"]["name"] for t in tools or []]})
        step = self.world["script"].pop(0) if self.world["script"] else {"parts": ["OK."]}
        for part in step.get("parts", []):
            on_text(part)
        calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(step.get("calls", []))]
        return SimpleNamespace(content="".join(step.get("parts", [])), tool_calls=calls, finish_reason="stop",
                               thinking="", usage={"input_tokens": 10, "output_tokens": 5})


class MadeInChat(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-made-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.world = {"script": [], "read": []}
        config = SimpleNamespace(base_url="", api_key="", model="chat-model", project_root=str(folder),
                                 get=lambda key, default=None: default)
        self.store = ChatStore(folder / "chat")
        self.engine = ChatEngine(config, self.store, searcher=lambda q: [], memory=SharedMemory(folder / "memory"),
                                 projects=lambda hidden: [], client_factory=lambda model: Model(self.world),
                                 plugins=lambda chat, said, taint: None)

    def say(self, text, *steps, chat=None, **kwargs):
        self.world["script"] += list(steps)
        chat = chat or self.engine.open()
        return chat, self.engine.send(chat["id"], text, search="off", **kwargs)

    def told(self, n=-1):
        return [m["content"] for m in self.world["read"][n]["messages"] if m["role"] == "tool"]

    def test_a_file_is_made_shown_kept_and_read_back(self):
        live = []
        chat, reply = self.say("Write me a one-page brief on the LRS as a Word file.",
                               {"parts": ["Here it is."], "calls": [("make_file", {"name": "LRS brief", "format": "docx",
                                                                                   "content": BRIEF})]},
                               {"parts": [" It covers the limit and the routes."]}, on_file=live.append)
        [file] = reply["files"]
        self.assertEqual(live, [file], "the card shows as the reply puts it there")
        self.assertEqual((file["name"], file["format"], file["made"], file["at"]), ("LRS brief.docx", "docx", True, len("Here it is.")))
        self.assertIn("Made LRS brief.docx (Word document). It's a card under your reply", self.told(1)[0])
        self.assertIn("make_file", self.world["read"][0]["tools"])
        meta, raw, text = self.engine.library_file({"conversation_id": chat["id"], "attachment_id": file["id"]})
        self.assertIn("Liberalised Remittance Scheme", documents.extract_text(raw, meta["name"]).text)
        found = self.store.library()
        self.assertEqual([(f["name"], f["made"], f["type"]) for f in found["files"]], [("LRS brief.docx", True, "document")])
        self.assertEqual(found["origins"], {"made": 1, "uploaded": 0})
        self.assertEqual(self.store.library(origin="uploaded")["files"], [])
        self.say("Make the title shorter.", {"parts": ["Done."]}, chat=chat)
        history = "\n".join(str(m["content"]) for m in self.world["read"][-1]["messages"])
        self.assertIn("[You made a file here, shown to the user as a card: LRS brief.docx", history)
        self.assertIn("## The limit", history, "what it wrote, to change it")
        self.assertIn("*Made: LRS brief.docx*", self.engine.export(chat["id"], "markdown"))
        self.engine.remove_library_file({"conversation_id": chat["id"], "attachment_id": file["id"]})
        self.say("Again?", {"parts": ["Sure."]}, chat=chat)
        history = "\n".join(str(m["content"]) for m in self.world["read"][-1]["messages"])
        self.assertIn("[You made LRS brief.docx here; the user has since deleted it.]", history)
        self.assertEqual(self.store.library()["files"], [])

    def test_a_file_that_cant_be_made_is_said_and_nothing_is_kept(self):
        chat, reply = self.say("A file please.", {"calls": [("make_file", {"name": "x", "format": "exe", "content": "x"})]},
                               {"parts": ["Sorry."]})
        self.assertNotIn("files", reply)
        self.assertTrue(self.told(1)[0].startswith("error: Choose a format"))

    def test_three_files_a_reply_then_the_tool_goes(self):
        sheet = {"name": "t", "format": "csv", "rows": [["a"], [1]]}
        chat, reply = self.say("Three tables.", {"calls": [("make_file", sheet)] * 3}, {"parts": ["Done."]})
        self.assertEqual(len(reply["files"]), 3)
        self.assertNotIn("make_file", self.world["read"][-1]["tools"])

    def test_a_branch_keeps_its_files_and_a_made_file_used_again_is_read_as_a_document(self):
        chat, reply = self.say("Budget please.", {"calls": [("make_file", {"name": "Budget", "format": "xlsx", "sheets": [
            {"name": "Costs", "rows": [["Item", "Amount"], ["Rent", 1200]]}]})]}, {"parts": ["Here."]})
        file = reply["files"][0]
        branched = self.engine.branch(chat["id"], reply["id"])
        meta, raw, _ = self.engine.library_file({"conversation_id": branched["id"], "attachment_id": file["id"]})
        self.assertEqual(raw[:2], b"PK")
        again = self.engine._from_library({"conversation_id": chat["id"], "attachment_id": file["id"]})
        self.assertIn("Rent\t1200", again["text"], "Excel's words, as any attached workbook is read")
        self.assertNotIn("made", again["meta"], "sent back, it's the user's file")

    def test_a_temporary_chat_keeps_its_files_in_memory_only(self):
        chat = self.engine.open(temporary=True)
        chat, reply = self.say("Notes.", {"calls": [("make_file", {"name": "n", "format": "md", "content": "# N"})]},
                               {"parts": ["Here."]}, chat=chat)
        self.assertEqual(reply["files"][0]["name"], "n.md")
        self.assertFalse((self.store.root / "files" / chat["id"]).exists())
        self.assertEqual(self.store.library()["files"], [])


if __name__ == "__main__":
    unittest.main()
