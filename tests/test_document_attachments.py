"""A document attached with @path reaches the model as text.

Before this, `@report.docx` hit the binary guard in expand_attachments and was skipped with
"binary data is not a text attachment" -- the one thing a person most wants to hand an agent was
the one thing it could not read. The extraction itself is covered by tests/test_documents.py;
these tests are about the attachment boundary: bounds, sanitisation, labelling and refusals.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import documents as d
from dgc.attachments import (DOCUMENT_SUFFIXES, MAX_DOCUMENT_FILE_BYTES, expand_attachments)


def archive(parts: dict[str, str | bytes]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for name, value in parts.items():
            z.writestr(name, value)
    return buffer.getvalue()


def word(text: str = "Hello document") -> bytes:
    body = f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"
    return archive({"word/document.xml":
                    f'<w:document xmlns:w="{d._W}"><w:body>{body}</w:body></w:document>'})


R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'


def workbook(cell: str = "Revenue") -> bytes:
    # A sheet is only reachable through the workbook's relationship part, so the fixture needs
    # all three entries -- a workbook without them extracts to nothing at all.
    rows = f'<row><c t="inlineStr"><is><t>{cell}</t></is></c><c><v>42</v></c></row>'
    return archive({
        "xl/workbook.xml": f'<workbook xmlns="{d._X}" xmlns:r="{R}"><sheets>'
                           '<sheet name="Budget" sheetId="1" r:id="r1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{REL}">'
                                      '<Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{d._X}"><sheetData>{rows}</sheetData></worksheet>',
    })


class AttachmentTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def write(self, name: str, raw: bytes) -> Path:
        path = self.root / name
        path.write_bytes(raw)
        return path

    def expand(self, name: str, raw: bytes, **kwargs):
        self.write(name, raw)
        return expand_attachments(f"summarise @{name}", self.root, **kwargs)

    def test_a_word_document_reaches_the_model_as_its_text(self):
        out = self.expand("report.docx", word("Quarterly revenue is up"))
        self.assertIn("Quarterly revenue is up", out.text)
        self.assertIn("attached 1 document", out.notices)
        self.assertEqual(out.document_files, 1)

    def test_a_spreadsheet_reaches_the_model_as_its_cells(self):
        out = self.expand("book.xlsx", workbook("Revenue"))
        self.assertIn("Revenue", out.text)

    def test_the_block_says_the_text_was_extracted(self):
        # The model must know it is reading an extraction: layout, images and anything the
        # extractor could not reach are absent, and the sha256 is of the document, not of this text.
        out = self.expand("report.docx", word())
        self.assertIn('"extracted":', out.text)
        self.assertIn('"format":".docx"', out.text.replace(" ", ""))
        self.assertIn("carries an \"extracted\" field", out.text)

    def test_a_document_is_not_rejected_as_binary(self):
        # The exact regression: a .docx is a zip, so it is full of NUL bytes.
        out = self.expand("report.docx", word())
        self.assertNotIn("binary data is not a text attachment", " ".join(out.notices))

    def test_a_corrupt_document_is_refused_with_its_reason(self):
        out = self.expand("report.docx", b"not a zip at all")
        self.assertIn("attachment skipped", " ".join(out.notices))
        self.assertNotIn("Hello", out.text)

    def test_an_unreadable_document_does_not_take_the_prompt_with_it(self):
        # A refusal leaves the mention as ordinary prompt text; the turn still happens.
        out = self.expand("report.docx", b"")
        self.assertIn("summarise @report.docx", out.text)

    def test_the_sanitizer_sees_the_text_before_anything_is_clipped(self):
        # The text path's rule, which a document must not quietly opt out of: a secret split by the
        # character limit would cross the boundary as two harmless-looking halves.
        seen = []

        def sanitizer(value):
            seen.append(value)
            return value.replace("sk-live-SECRET", "[redacted]")

        out = self.expand("report.docx", word("token sk-live-SECRET here"), sanitizer=sanitizer)
        self.assertTrue(seen, "the sanitizer was given the extracted text")
        self.assertIn("[redacted]", out.text)
        self.assertNotIn("sk-live-SECRET", out.text)

    def test_a_document_over_its_byte_ceiling_is_named_as_a_document(self):
        big = self.root / "huge.docx"
        big.write_bytes(b"P" * (MAX_DOCUMENT_FILE_BYTES + 1))
        out = expand_attachments("read @huge.docx", self.root)
        self.assertIn("document exceeds its byte limit", " ".join(out.notices))

    def test_csv_stays_on_the_text_path(self):
        # .csv is in documents.SUPPORTED but reads correctly as text already; routing it through
        # extraction would change behaviour that works, for no gain.
        self.assertNotIn(".csv", DOCUMENT_SUFFIXES)
        self.assertNotIn(".tsv", DOCUMENT_SUFFIXES)
        out = self.expand("rows.csv", b"name,amount\nacme,42\n")
        self.assertIn("acme,42", out.text)
        self.assertIn("attached 1 text file", out.notices)

    def test_every_routed_suffix_is_one_the_module_supports(self):
        self.assertTrue(DOCUMENT_SUFFIXES <= set(d.SUPPORTED),
                        "a suffix routed to extraction that the extractor does not know would be "
                        "refused as unsupported instead of read as text")

    def test_a_pdf_is_read_when_the_backend_is_installed(self):
        raw = self.pdf_bytes()
        out = self.expand("paper.pdf", raw)
        joined = " ".join(out.notices)
        if "attached 1 document" in joined:
            self.assertIn("Hello PDF", out.text)
        else:                                   # no pypdf here: it must say so, not read garbage
            self.assertIn("attachment skipped", joined)
            self.assertNotIn("\x00", out.text)

    @staticmethod
    def pdf_bytes() -> bytes:
        stream = b"BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET"
        objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]
        out = bytearray(b"%PDF-1.4\n")
        offsets = []
        for index, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
        start = len(out)
        out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
        for offset in offsets:
            out += f"{offset:010d} 00000 n \n".encode()
        out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n"
                f"{start}\n%%EOF\n").encode()
        return bytes(out)


if __name__ == "__main__":
    unittest.main()


class ReadFileTest(unittest.TestCase):
    """The model opening a document itself, which is how the EDITOR reaches one.

    The terminal expands `@path` before the turn; the editor puts the path in context and leaves
    the reading to the model. A recording of the real panel showed the consequence: a .docx
    mentioned in the editor came back "looks like a binary file" -- true, and useless.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def read(self, name: str, raw: bytes, **args) -> str:
        from dgc import tools
        (self.root / name).write_bytes(raw)
        ctx = type("Ctx", (), {"project_root": self.root, "config": None})()
        return tools.read_file({"path": str(self.root / name), **args}, ctx)

    def test_a_document_is_read_as_its_text(self):
        out = self.read("report.docx", word("Quarterly revenue is up"))
        self.assertIn("Quarterly revenue is up", out)
        self.assertNotIn("looks like a binary file", out)

    def test_it_says_the_text_is_an_extraction(self):
        # An answer about a document's layout cannot come from here, and the model must know that.
        out = self.read("report.docx", word())
        self.assertIn("extracted text from a Word document", out)
        self.assertIn("layout, images and embedded objects are not included", out)

    def test_line_numbers_and_offsets_work_as_they_do_for_any_file(self):
        body = "".join(f"<w:p><w:r><w:t>line {n}</w:t></w:r></w:p>" for n in range(1, 11))
        raw = archive({"word/document.xml":
                       f'<w:document xmlns:w="{d._W}"><w:body>{body}</w:body></w:document>'})
        out = self.read("many.docx", raw, offset=3, limit=2)
        self.assertIn("3\tline 3", out)
        self.assertIn("4\tline 4", out)
        self.assertNotIn("line 5", out)

    def test_a_corrupt_document_says_what_is_wrong(self):
        out = self.read("report.docx", b"not a zip")
        self.assertTrue(out.startswith("error: "), out[:80])
        self.assertNotIn("looks like a binary file", out)

    def test_an_ordinary_binary_is_still_refused(self):
        # The document branch must not become a way to read arbitrary binaries as mojibake.
        out = self.read("blob.bin", b"\x00\x01\x02binary\x00")
        self.assertIn("looks like a binary file", out)

    def test_a_text_file_is_untouched(self):
        out = self.read("notes.md", b"# Notes\nstill plain text\n")
        self.assertIn("still plain text", out)
        self.assertNotIn("extracted text", out)


class LoggingTest(unittest.TestCase):
    """Reading a document must not silence the rest of DGC.

    The module arrived calling `logging.disable(logging.CRITICAL)` before importing pypdf, with
    nothing to undo it. That call is process-wide and permanent, so after DGC read one PDF every
    logger in the process was dead for the rest of the run. The full suite found it: an unrelated
    test asserting that dgc.reasoning logs its R1/R2 downgrade started failing with "no logs of
    level WARNING or higher triggered", and passed again in isolation.
    """

    def test_reading_a_pdf_leaves_logging_alone(self):
        import logging
        from dgc import documents as module
        before = logging.root.manager.disable
        try:
            module.extract_text(AttachmentTest.pdf_bytes(), "paper.pdf")
        except (module.DocumentError, module.UnsupportedDocument):
            pass                     # no pypdf here; the point is what it did on the way out
        self.assertEqual(logging.root.manager.disable, before,
                         "documents must not touch the process-wide logging switch")

    def test_another_logger_still_works_afterwards(self):
        import logging
        from dgc import documents as module, reasoning
        try:
            module.extract_text(AttachmentTest.pdf_bytes(), "paper.pdf")
        except (module.DocumentError, module.UnsupportedDocument):
            pass
        reasoning._LOGGED.clear()
        self.addCleanup(reasoning._LOGGED.clear)
        with self.assertLogs("dgc.reasoning", level="WARNING"):
            reasoning.enforce_rules("summarized", "anthropic", private=True,
                                    channel="anthropic.thinking", klass="private")

    def test_pypdf_itself_is_quiet_again_afterwards(self):
        # Quietening pypdf is legitimate -- it warns per malformed object -- but it is for the
        # duration of the call, not for the life of the process.
        import logging
        from dgc import documents as module
        level = logging.getLogger("pypdf").level
        try:
            module.extract_text(AttachmentTest.pdf_bytes(), "paper.pdf")
        except (module.DocumentError, module.UnsupportedDocument):
            pass
        self.assertEqual(logging.getLogger("pypdf").level, level)
