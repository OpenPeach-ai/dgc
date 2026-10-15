"""Files ChatDGC makes (ChatGPT's "here's your report.docx"): Word, PDF, Excel, PowerPoint, CSV and Markdown.

The model never writes a file's bytes or its markup. It hands over what the file says: Markdown for a document or a
PDF, rows for a spreadsheet, titles and bullets for a deck; this module lays it out, the same way every time. Each
writer is the standard library and DGC's own pinned dependencies only (rich already brings markdown-it-py), the way
``dgc.documents`` reads these formats with none.

A PDF is printed by the Chrome or Edge the user already has (``dgc.browser``, the page DGC wrote with every remote
load blocked), so any script or symbol prints as it should: ₹, हिन्दी, 中文. Without one, a plain built-in writer
lays out the text in Helvetica, and says which characters it couldn't draw.
"""
from __future__ import annotations

import base64
import csv
import html
import io
import os
import re
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone

FORMATS = {
    "docx": ("Word document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "pdf": ("PDF", "application/pdf"),
    "xlsx": ("Excel workbook", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "pptx": ("PowerPoint presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    "csv": ("CSV", "text/csv"),
    "md": ("Markdown", "text/markdown"),
}
MAX_TEXT = 200_000           # characters of Markdown, a document or a PDF
MAX_SHEETS = 20
MAX_CELLS = 100_000
MAX_SLIDES = 60
MAX_BULLETS = 12
MAX_NAME = 80
_INVALID_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_NUMBER = re.compile(r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\Z")


class MadeError(Exception):
    """A file that can't be made as asked; the text says what to change, for the model."""


@dataclass
class Made:
    name: str               # with its extension, as the user sees and saves it
    format: str
    mime: str
    raw: bytes
    text: str               # what the model reads of it later: its Markdown, its rows, its outline
    note: str = ""          # something the user should know (a PDF made without a browser)
    pages: int = 0


# --------------------------------------------------------------------------- what the model hands over

def file_name(value, fmt: str) -> str:
    """A name a file can have on any system, with the format's extension once."""
    text = " ".join(re.sub(r"[\x00-\x1f\x7f/\\:*?\"<>|]", " ", str(value or "")).split()).strip(" .")
    if text.lower().endswith("." + fmt):
        text = text[: -len(fmt) - 1].rstrip(" .")
    text = text[:MAX_NAME].rstrip(" .") or "ChatDGC file"
    return f"{text}.{fmt}"


def make(spec: dict, config=None, *, browser=None) -> Made:
    """Make the file a ``make_file`` call describes: {name, format, content | sheets | slides}."""
    if not isinstance(spec, dict):
        raise MadeError("Say what the file is: its name, its format and what it says.")
    fmt = str(spec.get("format") or "").strip().lower().lstrip(".")
    fmt = {"word": "docx", "doc": "docx", "excel": "xlsx", "xls": "xlsx", "powerpoint": "pptx", "ppt": "pptx",
           "markdown": "md"}.get(fmt, fmt)
    if fmt not in FORMATS:
        raise MadeError("Choose a format: docx, pdf, xlsx, pptx, csv or md.")
    name = file_name(spec.get("name") or spec.get("title"), fmt)
    title = name[: -len(fmt) - 1]
    label, mime = FORMATS[fmt]
    if fmt in ("docx", "pdf", "md"):
        content = _content(spec)
        if fmt == "md":
            return Made(name, fmt, mime, content.encode("utf-8"), content)
        blocks = parse(content)
        if fmt == "docx":
            return Made(name, fmt, mime, docx(title, blocks), content)
        raw, note, pages = pdf(title, blocks, config, browser=browser)
        return Made(name, fmt, mime, raw, content, note, pages)
    if fmt in ("xlsx", "csv"):
        sheets = _sheets(spec)
        text = "\n\n".join((f"## {s['name']}\n" if len(sheets) > 1 else "") + _csv_text(s["rows"]) for s in sheets)
        if fmt == "csv":
            return Made(name, fmt, mime, _csv_text(sheets[0]["rows"]).encode("utf-8-sig"), text)
        return Made(name, fmt, mime, xlsx(sheets), text)
    slides = _slides(spec)
    return Made(name, fmt, mime, pptx(title, slides), _outline(slides))


def _content(spec) -> str:
    content = spec.get("content")
    if not isinstance(content, str) or not content.strip():
        raise MadeError("Give the file's text as Markdown in content.")
    if len(content) > MAX_TEXT:
        raise MadeError(f"That's {len(content):,} characters; a file holds at most {MAX_TEXT:,}. Make it shorter or split it.")
    return _INVALID_XML.sub("", content.replace("\r\n", "\n"))


def _cell(value):
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return value if value == value and value not in (float("inf"), float("-inf")) else ""
    if value is None:
        return ""
    return _INVALID_XML.sub("", str(value))[:32_000]


def _sheets(spec) -> list[dict]:
    sheets = spec.get("sheets")
    if sheets is None and isinstance(spec.get("rows"), list):
        sheets = [{"name": "Sheet1", "rows": spec["rows"]}]
    if not isinstance(sheets, list) or not sheets:
        raise MadeError('Give the spreadsheet as sheets: [{"name": "…", "rows": [["header", …], [value, …]]}].')
    if len(sheets) > MAX_SHEETS:
        raise MadeError(f"A workbook holds at most {MAX_SHEETS} sheets.")
    out, used, cells = [], set(), 0
    for i, sheet in enumerate(sheets):
        if not isinstance(sheet, dict) or not isinstance(sheet.get("rows"), list):
            raise MadeError(f"Sheet {i + 1} needs rows: a list of rows, each a list of cells.")
        rows = [[_cell(c) for c in (row if isinstance(row, list) else [row])] for row in sheet["rows"]]
        cells += sum(len(r) for r in rows)
        if cells > MAX_CELLS:
            raise MadeError(f"A workbook holds at most {MAX_CELLS:,} cells.")
        base = re.sub(r"[\[\]:*?/\\]", "", str(sheet.get("name") or f"Sheet{i + 1}")).strip("' ")[:31] or f"Sheet{i + 1}"
        sheet_name, n = base, 2
        while sheet_name.casefold() in used:
            sheet_name, n = f"{base[:28]} {n}", n + 1
        used.add(sheet_name.casefold())
        out.append({"name": sheet_name, "rows": rows, "header": sheet.get("header", True) is not False and len(rows) > 1})
    return out


def _csv_text(rows) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    for row in rows:
        writer.writerow(["" if c is None else c for c in row])
    return buffer.getvalue()


def _slides(spec) -> list[dict]:
    slides = spec.get("slides")
    if not isinstance(slides, list) or not slides:
        raise MadeError('Give the deck as slides: [{"title": "…", "bullets": ["…", {"text": "…", "level": 1}]}].')
    if len(slides) > MAX_SLIDES:
        raise MadeError(f"A deck holds at most {MAX_SLIDES} slides.")
    out = []
    for i, slide in enumerate(slides):
        if isinstance(slide, str):
            slide = {"title": slide}
        if not isinstance(slide, dict):
            raise MadeError(f"Slide {i + 1} needs a title and bullets.")
        bullets = []
        for b in slide.get("bullets") or []:
            if isinstance(b, dict):
                level = b.get("level", 0)
                bullets.append((_cell(b.get("text")), max(0, min(3, level if type(level) is int else 0))))
            else:
                bullets.append((_cell(b), 0))
        if len(bullets) > MAX_BULLETS:
            raise MadeError(f"Slide {i + 1} has {len(bullets)} bullets; keep a slide to {MAX_BULLETS} or split it.")
        table = slide.get("table")
        rows = [[_cell(c) for c in (r if isinstance(r, list) else [r])] for r in table] if isinstance(table, list) else []
        out.append({"title": _cell(slide.get("title")), "subtitle": _cell(slide.get("subtitle")),
                    "bullets": [(str(t), lv) for t, lv in bullets if str(t).strip()], "table": rows[:16],
                    "notes": _cell(slide.get("notes"))})
    return out


def _outline(slides) -> str:
    lines = []
    for i, s in enumerate(slides, 1):
        lines.append(f"## Slide {i}: {s['title']}")
        if s["subtitle"]:
            lines.append(s["subtitle"])
        lines += ["  " * lv + f"- {t}" for t, lv in s["bullets"]]
        if s["table"]:
            lines.append(_csv_text(s["table"]).rstrip())
        if s["notes"]:
            lines.append(f"Notes: {s['notes']}")
        lines.append("")
    return "\n".join(lines).strip()


# --------------------------------------------------------------------------- Markdown → blocks

@dataclass
class Run:
    text: str
    bold: bool = False
    italic: bool = False
    code: bool = False
    strike: bool = False
    href: str = ""


@dataclass
class Block:
    kind: str                       # heading, para, item, quote, code, table, rule
    runs: list = field(default_factory=list)
    level: int = 0                  # a heading's level; an item's depth
    ordered: bool = False
    number: int = 0                 # an ordered item's number; which list it belongs to (for numbering)
    list_id: int = 0
    text: str = ""                  # a code block
    rows: list = field(default_factory=list)       # a table: [[runs]]; rows[0] is the header
    aligns: list = field(default_factory=list)


def _runs(token) -> list[Run]:
    runs, bold, italic, strike, href = [], 0, 0, 0, []
    for child in token.children or []:
        kind = child.type
        if kind == "text" or kind == "html_inline":
            if child.content:
                runs.append(Run(child.content, bold > 0, italic > 0, False, strike > 0, href[-1] if href else ""))
        elif kind == "code_inline":
            runs.append(Run(child.content, bold > 0, italic > 0, True, strike > 0, href[-1] if href else ""))
        elif kind in ("softbreak", "hardbreak"):
            # In a document a new line is meant (an address, a sign-off): Markdown would run them together.
            runs.append(Run("\n", bold > 0, italic > 0))
        elif kind == "strong_open":
            bold += 1
        elif kind == "strong_close":
            bold -= 1
        elif kind == "em_open":
            italic += 1
        elif kind == "em_close":
            italic -= 1
        elif kind == "s_open":
            strike += 1
        elif kind == "s_close":
            strike -= 1
        elif kind == "link_open":
            target = str(child.attrs.get("href") or "")
            href.append(target if re.match(r"(?i)(https?|mailto):", target) else "")
        elif kind == "link_close":
            href and href.pop()
        elif kind == "image":
            alt = "".join(c.content for c in child.children or []) or child.content
            if alt:
                runs.append(Run(alt, bold > 0, True))
    return runs


def parse(markdown: str) -> list[Block]:
    from markdown_it import MarkdownIt
    tokens = MarkdownIt("commonmark").enable(["table", "strikethrough"]).parse(markdown)
    blocks: list[Block] = []
    lists: list[dict] = []          # the open lists, outermost first
    quote = 0
    item_started: list[bool] = []
    table: Block | None = None
    row: list | None = None
    list_ids = 0
    i = 0
    while i < len(tokens):
        t = tokens[i]
        kind = t.type
        if kind == "heading_open":
            blocks.append(Block("heading", _runs(tokens[i + 1]), level=int(t.tag[1])))
            i += 3
            continue
        if kind in ("bullet_list_open", "ordered_list_open"):
            list_ids += 1
            start = t.attrs.get("start")
            lists.append({"ordered": kind == "ordered_list_open", "n": int(start) if start else 1, "id": list_ids})
        elif kind in ("bullet_list_close", "ordered_list_close"):
            lists.pop()
        elif kind == "list_item_open":
            item_started.append(False)
        elif kind == "list_item_close":
            item_started.pop()
            lists[-1]["n"] += 1
        elif kind == "blockquote_open":
            quote += 1
        elif kind == "blockquote_close":
            quote -= 1
        elif kind == "paragraph_open" and table is None:
            runs = _runs(tokens[i + 1])
            if lists and item_started and not item_started[-1]:
                current = lists[-1]
                blocks.append(Block("item", runs, level=len(lists) - 1, ordered=current["ordered"],
                                    number=current["n"], list_id=current["id"]))
                item_started[-1] = True
            elif lists:
                blocks.append(Block("para", runs, level=len(lists)))      # a second paragraph in an item
            else:
                blocks.append(Block("quote" if quote else "para", runs))
            i += 3
            continue
        elif kind in ("fence", "code_block"):
            blocks.append(Block("code", text=t.content.rstrip("\n")))
        elif kind == "hr":
            blocks.append(Block("rule"))
        elif kind == "table_open":
            table = Block("table")
        elif kind == "table_close" and table is not None:
            blocks.append(table)
            table = None
        elif kind == "tr_open":
            row = []
        elif kind == "tr_close" and table is not None and row is not None:
            table.rows.append(row)
            row = None
        elif kind in ("th_open", "td_open") and row is not None and table is not None:
            style = str(t.attrs.get("style") or "")
            if not table.rows:
                table.aligns.append("right" if "right" in style else "center" if "center" in style else "left")
            row.append(_runs(tokens[i + 1]))
            i += 3
            continue
        elif kind == "html_block":
            text = re.sub(r"<[^>]+>", "", t.content).strip()
            if text:
                blocks.append(Block("para", [Run(text)]))
        i += 1
    return blocks


def _plain(runs) -> str:
    return "".join(r.text for r in runs)


# --------------------------------------------------------------------------- shared OOXML pieces

def _x(text) -> str:
    return html.escape(_INVALID_XML.sub("", str(text)), quote=True)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _core(title: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{_x(title)}</dc:title><dc:creator>ChatDGC</dc:creator><cp:lastModifiedBy>ChatDGC</cp:lastModifiedBy>'
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{_now()}</dcterms:created>'
            f'<dcterms:modified xsi:type="dcterms:W3CDTF">{_now()}</dcterms:modified></cp:coreProperties>')


def _app(extra: str = "") -> str:
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
            f'<Application>ChatDGC</Application>{extra}</Properties>')


_RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
         '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
         'Target="{main}"/>'
         '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
         'Target="docProps/core.xml"/>'
         '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
         'Target="docProps/app.xml"/></Relationships>')


def _zip(parts: dict[str, str | bytes]) -> bytes:
    buffer = io.BytesIO()
    stamp = time.localtime()[:6]
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():          # [Content_Types].xml first, as Office writes it
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data.encode("utf-8") if isinstance(data, str) else data)
    return buffer.getvalue()


def _types(defaults: dict, overrides: dict) -> str:
    body = "".join(f'<Default Extension="{e}" ContentType="{t}"/>' for e, t in defaults.items())
    body += "".join(f'<Override PartName="{p}" ContentType="{t}"/>' for p, t in overrides.items())
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{body}</Types>')


_BASE_TYPES = {"rels": "application/vnd.openxmlformats-package.relationships+xml", "xml": "application/xml"}
_PROPS = {"/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
          "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml"}


# --------------------------------------------------------------------------- Word

_W = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
_FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>'
_MONO = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>'


def _style(sid, name, *, kind="paragraph", based="Normal", ppr="", rpr="", extra="") -> str:
    based_on = f'<w:basedOn w:val="{based}"/>' if based else ""
    return (f'<w:style w:type="{kind}" w:styleId="{sid}"><w:name w:val="{name}"/>{based_on}{extra}<w:qFormat/>'
            f'{f"<w:pPr>{ppr}</w:pPr>" if ppr else ""}{f"<w:rPr>{rpr}</w:rPr>" if rpr else ""}</w:style>')


def _word_styles() -> str:
    heading = lambda n, size, before: _style(            # noqa: E731
        f"Heading{n}", f"heading {n}", extra='<w:next w:val="Normal"/>',
        ppr=f'<w:keepNext/><w:spacing w:before="{before}" w:after="80"/><w:outlineLvl w:val="{n - 1}"/>',
        rpr=f'<w:b/><w:color w:val="1F2937"/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<w:styles {_W}><w:docDefaults><w:rPrDefault><w:rPr>{_FONT}<w:sz w:val="22"/><w:szCs w:val="22"/>'
            '<w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" '
            'w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
            '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
            + _style("Title", "Title", extra='<w:next w:val="Normal"/>', ppr='<w:spacing w:after="200"/>',
                     rpr='<w:b/><w:color w:val="111827"/><w:sz w:val="48"/><w:szCs w:val="48"/>')
            + heading(1, 34, 360) + heading(2, 28, 280) + heading(3, 24, 220)
            + _style("ListParagraph", "List Paragraph", ppr='<w:spacing w:after="60"/><w:ind w:left="720"/>')
            + _style("Quote", "Quote", ppr='<w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="12" '
                     'w:color="D1D5DB"/></w:pBdr>', rpr='<w:i/><w:color w:val="4B5563"/>')
            + _style("Code", "Code", ppr='<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" '
                     'w:color="auto" w:fill="F3F4F6"/>', rpr=f'{_MONO}<w:sz w:val="19"/><w:szCs w:val="19"/>')
            + _style("Hyperlink", "Hyperlink", kind="character", based="",
                     rpr='<w:color w:val="1D4ED8"/><w:u w:val="single"/>')
            + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr>'
              '<w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>'
              '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
            + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/>'
              '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
              + "".join(f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>'
                        for side in ("top", "left", "bottom", "right", "insideH", "insideV"))
            + '</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tblCellMar>'
              '</w:tblPr></w:style></w:styles>')


def _word_numbering(ordered_lists: list[int]) -> str:
    bullets = "•◦▪"

    def levels(ordered: bool) -> str:
        out = ""
        for lv in range(9):
            fmt, text = ("decimal", f"%{lv + 1}.") if ordered else ("bullet", bullets[lv % 3])
            font = "" if ordered else '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>'
            out += (f'<w:lvl w:ilvl="{lv}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/>'
                    f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 + 360 * lv}" w:hanging="360"/></w:pPr>{font}</w:lvl>')
        return out
    nums = '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    for n, _ in enumerate(ordered_lists):
        nums += (f'<w:num w:numId="{n + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride '
                 'w:val="1"/></w:lvlOverride></w:num>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<w:numbering {_W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
            f'{levels(False)}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>'
            f'{levels(True)}</w:abstractNum>{nums}</w:numbering>')


def _word_runs(runs: list[Run], links: list[str], *, bold_all=False) -> str:
    out = ""
    for r in runs:
        props = ("<w:b/>" if r.bold or bold_all else "") + ("<w:i/>" if r.italic else "") + \
                ("<w:strike/>" if r.strike else "") + (_MONO + '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>'
                                                       if r.code else "")
        pieces = r.text.split("\n")
        body = "".join(("<w:br/>" if n else "") + (f'<w:t xml:space="preserve">{_x(p)}</w:t>' if p else "")
                       for n, p in enumerate(pieces))
        if r.href:
            links.append(r.href)
            out += (f'<w:hyperlink r:id="rIdL{len(links)}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/>{props}</w:rPr>'
                    f'{body}</w:r></w:hyperlink>')
        else:
            out += f'<w:r>{f"<w:rPr>{props}</w:rPr>" if props else ""}{body}</w:r>'
    return out


def docx(title: str, blocks: list[Block]) -> bytes:
    links: list[str] = []
    ordered = sorted({b.list_id for b in blocks if b.kind == "item" and b.ordered})
    num_of = {lid: n + 2 for n, lid in enumerate(ordered)}
    body = ""
    titled = bool(blocks) and blocks[0].kind == "heading" and blocks[0].level == 1
    if not titled:
        body += f'<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>{_word_runs([Run(title)], links)}</w:p>'
    for b in blocks:
        if b.kind == "heading":
            style = "Title" if titled and b is blocks[0] else f"Heading{min(3, max(1, b.level - (1 if titled else 0)))}"
            body += f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr>{_word_runs(b.runs, links)}</w:p>'
        elif b.kind == "item":
            num = num_of.get(b.list_id, 1) if b.ordered else 1
            body += (f'<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="{min(8, b.level)}"/>'
                     f'<w:numId w:val="{num}"/></w:numPr></w:pPr>{_word_runs(b.runs, links)}</w:p>')
        elif b.kind == "para":
            indent = f'<w:ind w:left="{720 + 360 * (b.level - 1)}"/>' if b.level else ""
            body += f'<w:p>{f"<w:pPr>{indent}</w:pPr>" if indent else ""}{_word_runs(b.runs, links)}</w:p>'
        elif b.kind == "quote":
            body += f'<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>{_word_runs(b.runs, links)}</w:p>'
        elif b.kind == "code":
            lines = b.text.split("\n")
            for n, line in enumerate(lines):
                after = '<w:spacing w:after="160"/>' if n == len(lines) - 1 else ""
                body += (f'<w:p><w:pPr><w:pStyle w:val="Code"/>{after}</w:pPr><w:r><w:t xml:space="preserve">{_x(line)}'
                         '</w:t></w:r></w:p>')
        elif b.kind == "rule":
            body += ('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D5DB"/></w:pBdr>'
                     '</w:pPr></w:p>')
        elif b.kind == "table" and b.rows:
            cols = max(len(r) for r in b.rows)
            width = 9026 // cols
            grid = "".join(f'<w:gridCol w:w="{width}"/>' for _ in range(cols))
            rows = ""
            for n, row in enumerate(b.rows):
                head = n == 0
                cells = ""
                for c in range(cols):
                    runs = row[c] if c < len(row) else []
                    align = b.aligns[c] if c < len(b.aligns) else "left"
                    jc = {"right": "right", "center": "center"}.get(align, "left")
                    shade = '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' if head else ""
                    cells += (f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{shade}</w:tcPr><w:p><w:pPr>'
                              f'<w:jc w:val="{jc}"/></w:pPr>{_word_runs(runs, links, bold_all=head)}</w:p></w:tc>')
                rows += f'<w:tr>{"<w:trPr><w:tblHeader/></w:trPr>" if head else ""}{cells}</w:tr>'
            body += (f'<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>'
                     f'<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" '
                     f'w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>{grid}</w:tblGrid>{rows}</w:tbl>'
                     '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>')
    section = ('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" '
               'w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>')
    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<w:document {_W}><w:body>{body}{section}</w:body></w:document>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
            'Target="styles.xml"/>'
            '<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" '
            'Target="numbering.xml"/>'
            + "".join(f'<Relationship Id="rIdL{n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                      f'relationships/hyperlink" Target="{_x(href)}" TargetMode="External"/>' for n, href in enumerate(links))
            + '</Relationships>')
    word = "application/vnd.openxmlformats-officedocument.wordprocessingml"
    return _zip({
        "[Content_Types].xml": _types(_BASE_TYPES, {"/word/document.xml": f"{word}.document.main+xml",
                                                    "/word/styles.xml": f"{word}.styles+xml",
                                                    "/word/numbering.xml": f"{word}.numbering+xml", **_PROPS}),
        "_rels/.rels": _RELS.replace("{main}", "word/document.xml"),
        "word/document.xml": document,
        "word/_rels/document.xml.rels": rels,
        "word/styles.xml": _word_styles(),
        "word/numbering.xml": _word_numbering(ordered),
        "docProps/core.xml": _core(title),
        "docProps/app.xml": _app(),
    })


# --------------------------------------------------------------------------- Excel

def _column(n: int) -> str:
    name = ""
    n += 1
    while n:
        n, rest = divmod(n - 1, 26)
        name = chr(65 + rest) + name
    return name


def _xlsx_cell(ref: str, value, style: int) -> str:
    s = f' s="{style}"' if style else ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        thousands = not style and float(value).is_integer() and abs(value) >= 1000
        attr = ' s="2"' if thousands else s            # no backslash inside the f-string: Python 3.10/3.11
        return (f'<c r="{ref}"{attr}><v>'
                f'{int(value) if float(value).is_integer() else repr(float(value))}</v></c>')
    text = str(value)
    if not text:
        return f'<c r="{ref}"{s}/>' if style else ""
    if text.startswith("=") and len(text) > 1:
        return f'<c r="{ref}"{s}><f>{_x(text[1:])}</f></c>'
    plain = text.replace(",", "") if re.fullmatch(r"-?\d{1,3}(,\d{3})+(\.\d+)?", text) else text
    if _NUMBER.match(plain) and not (len(plain) > 1 and plain.lstrip("-").startswith("0") and "." not in plain[:3]):
        return _xlsx_cell(ref, float(plain) if any(c in plain for c in ".eE") else int(plain), style)
    return f'<c r="{ref}" t="inlineStr"{s}><is><t xml:space="preserve">{_x(text)}</t></is></c>'


def xlsx(sheets: list[dict]) -> bytes:
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    parts: dict[str, str] = {}
    overrides = {"/xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                 "/xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml", **_PROPS}
    for n, sheet in enumerate(sheets, 1):
        rows = sheet["rows"]
        cols = max((len(r) for r in rows), default=1)
        widths = [10.0] * cols
        for r in rows[:2000]:
            for c, v in enumerate(r):
                longest = max((len(line) for line in str(v).split("\n")), default=0)
                widths[c] = min(60.0, max(widths[c], longest * 1.1 + 2))
        data = ""
        for r, row in enumerate(rows, 1):
            style = 1 if sheet["header"] and r == 1 else 0
            cells = "".join(_xlsx_cell(f"{_column(c)}{r}", v, style) for c, v in enumerate(row))
            data += f'<row r="{r}">{cells}</row>'
        freeze = ('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" '
                  'state="frozen"/></sheetView></sheetViews>') if sheet["header"] else \
            '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        filt = f'<autoFilter ref="A1:{_column(cols - 1)}{len(rows)}"/>' if sheet["header"] else ""
        columns = "".join(f'<col min="{c + 1}" max="{c + 1}" width="{w:.1f}" customWidth="1"/>' for c, w in enumerate(widths))
        dimension = f'A1:{_column(cols - 1)}{max(1, len(rows))}'
        parts[f"xl/worksheets/sheet{n}.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<worksheet xmlns="{main}" xmlns:r="{rel}"><dimension ref="{dimension}"/>{freeze}'
            f'<sheetFormatPr defaultRowHeight="15"/><cols>{columns}</cols><sheetData>{data}</sheetData>{filt}'
            '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')
        overrides[f"/xl/worksheets/sheet{n}.xml"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
    names = "".join(f'<sheet name="{_x(s["name"])}" sheetId="{n}" r:id="rId{n}"/>' for n, s in enumerate(sheets, 1))
    parts["xl/workbook.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                                f'<workbook xmlns="{main}" xmlns:r="{rel}"><bookViews><workbookView/></bookViews>'
                                f'<sheets>{names}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
    parts["xl/_rels/workbook.xml.rels"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(f'<Relationship Id="rId{n}" Type="{rel}/worksheet" Target="worksheets/sheet{n}.xml"/>'
                  for n in range(1, len(sheets) + 1))
        + f'<Relationship Id="rId{len(sheets) + 1}" Type="{rel}/styles" Target="styles.xml"/></Relationships>')
    parts["xl/styles.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<styleSheet xmlns="{main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
        '<border><left/><right/><top/><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
        '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    return _zip({"[Content_Types].xml": _types(_BASE_TYPES, overrides),
                 "_rels/.rels": _RELS.replace("{main}", "xl/workbook.xml"),
                 **parts,
                 "docProps/core.xml": _core(sheets[0]["name"]),
                 "docProps/app.xml": _app()})


# --------------------------------------------------------------------------- PowerPoint

_P = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
_SLIDE_W, _SLIDE_H = 12192000, 6858000
_INK, _MUTED, _ACCENT = "1F2937", "6B7280", "4F46E5"


def _theme() -> str:
    colors = {"dk1": '<a:sysClr val="windowText" lastClr="000000"/>', "lt1": '<a:sysClr val="window" lastClr="FFFFFF"/>',
              "dk2": '<a:srgbClr val="1F2937"/>', "lt2": '<a:srgbClr val="F3F4F6"/>',
              "accent1": '<a:srgbClr val="4F46E5"/>', "accent2": '<a:srgbClr val="0EA5E9"/>',
              "accent3": '<a:srgbClr val="10B981"/>', "accent4": '<a:srgbClr val="F59E0B"/>',
              "accent5": '<a:srgbClr val="EF4444"/>', "accent6": '<a:srgbClr val="8B5CF6"/>',
              "hlink": '<a:srgbClr val="1D4ED8"/>', "folHlink": '<a:srgbClr val="7C3AED"/>'}
    scheme = "".join(f"<a:{k}>{v}</a:{k}>" for k, v in colors.items())
    font = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>'
    solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    line = lambda w: f'<a:ln w="{w}" cap="flat" cmpd="sng" algn="ctr">{solid}<a:prstDash val="solid"/></a:ln>'  # noqa: E731
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ChatDGC"><a:themeElements>'
            f'<a:clrScheme name="ChatDGC">{scheme}</a:clrScheme>'
            f'<a:fontScheme name="ChatDGC"><a:majorFont>{font}</a:majorFont><a:minorFont>{font}</a:minorFont></a:fontScheme>'
            f'<a:fmtScheme name="ChatDGC"><a:fillStyleLst>{solid * 3}</a:fillStyleLst>'
            f'<a:lnStyleLst>{line(6350)}{line(12700)}{line(19050)}</a:lnStyleLst>'
            '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>'
            '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
            f'<a:bgFillStyleLst>{solid * 3}</a:bgFillStyleLst></a:fmtScheme></a:themeElements>'
            '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>')


def _box(sid: int, name: str, x: int, y: int, w: int, h: int, paragraphs: str, *, ph: str = "", anchor: str = "t") -> str:
    placeholder = f"<p:nvPr><p:ph {ph}/></p:nvPr>" if ph else "<p:nvPr/>"
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{_x(name)}"/><p:cNvSpPr txBox="{0 if ph else 1}"/>{placeholder}'
            f'</p:nvSpPr><p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
            f'<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" anchor="{anchor}"><a:normAutofit/></a:bodyPr>'
            f'<a:lstStyle/>{paragraphs}</p:txBody></p:sp>')


def _para(text: str, size: int, *, color=_INK, bold=False, bullet=False, level=0, space_after=600) -> str:
    if bullet:
        indent = 342900 + 285750 * level
        ppr = (f'<a:pPr marL="{indent}" lvl="{level}" indent="-285750"><a:spcAft><a:spcPts val="{space_after}"/>'
               f'</a:spcAft><a:buClr><a:srgbClr val="{_ACCENT}"/></a:buClr><a:buFont typeface="Arial"/>'
               f'<a:buChar char="{"•" if level % 2 == 0 else "–"}"/></a:pPr>')
    else:
        ppr = f'<a:pPr><a:spcAft><a:spcPts val="{space_after}"/></a:spcAft><a:buNone/></a:pPr>'
    rpr = (f'<a:rPr lang="en-US" sz="{size}" b="{1 if bold else 0}" dirty="0"><a:solidFill><a:srgbClr val="{color}"/>'
           '</a:solidFill><a:latin typeface="Calibri"/><a:cs typeface="Calibri"/></a:rPr>')
    return f'<a:p>{ppr}<a:r>{rpr}<a:t>{_x(text)}</a:t></a:r></a:p>'


def _slide_table(rows: list, sid: int, y: int) -> str:
    cols = max(len(r) for r in rows)
    width = _SLIDE_W - 2 * 609600
    col_w = width // cols
    row_h = 370840
    grid = "".join(f'<a:gridCol w="{col_w}"/>' for _ in range(cols))
    body = ""
    for n, row in enumerate(rows):
        cells = ""
        for c in range(cols):
            value = row[c] if c < len(row) else ""
            fill = '<a:solidFill><a:srgbClr val="F3F4F6"/></a:solidFill>' if n == 0 else "<a:noFill/>"
            border = "".join(f'<a:{side} w="6350"><a:solidFill><a:srgbClr val="D1D5DB"/></a:solidFill></a:{side}>'
                             for side in ("lnL", "lnR", "lnT", "lnB"))
            cells += (f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>{_para(str(value), 1400, bold=n == 0, space_after=0)}'
                      f'</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720">{border}{fill}</a:tcPr></a:tc>')
        body += f'<a:tr h="{row_h}">{cells}</a:tr>'
    return (f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{sid}" name="Table {sid}"/><p:cNvGraphicFramePr>'
            '<a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
            f'<p:xfrm><a:off x="609600" y="{y}"/><a:ext cx="{width}" cy="{row_h * len(rows)}"/></p:xfrm>'
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
            f'<a:tblPr firstRow="1"/><a:tblGrid>{grid}</a:tblGrid>{body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>')


def _slide(n: int, slide: dict, deck_title: str) -> str:
    margin = 609600
    shapes = ""
    if n == 1 and not slide["bullets"] and not slide["table"]:
        shapes += _box(2, "Title", margin, 2286000, _SLIDE_W - 2 * margin, 1371600,
                       _para(slide["title"] or deck_title, 4400, bold=True, space_after=0), ph='type="ctrTitle"', anchor="b")
        if slide["subtitle"]:
            shapes += _box(3, "Subtitle", margin, 3749040, _SLIDE_W - 2 * margin, 914400,
                           _para(slide["subtitle"], 2000, color=_MUTED, space_after=0), ph='type="subTitle" idx="1"')
    else:
        shapes += _box(2, "Title", margin, 457200, _SLIDE_W - 2 * margin, 914400,
                       _para(slide["title"], 3200, bold=True, space_after=0), ph='type="title"', anchor="b")
        y = 1508760
        if slide["subtitle"]:
            shapes += _box(3, "Subtitle", margin, y, _SLIDE_W - 2 * margin, 457200,
                           _para(slide["subtitle"], 1800, color=_MUTED, space_after=0))
            y += 548640
        if slide["bullets"]:
            count = len(slide["bullets"])
            size = 2400 if count <= 5 else 2000 if count <= 8 else 1600
            height = (_SLIDE_H - y - 457200) if not slide["table"] else min(2743200, 457200 * count)
            paragraphs = "".join(_para(t, size - 200 * lv, bullet=True, level=lv) for t, lv in slide["bullets"])
            shapes += _box(4, "Content", margin, y, _SLIDE_W - 2 * margin, height, paragraphs, ph='idx="1"')
            y += height + 182880
        if slide["table"]:
            shapes += _slide_table(slide["table"], 5, y)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<p:sld {_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/>'
            f'</a:xfrm></p:grpSpPr>{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')


def _layout(kind: str, name: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<p:sldLayout {_P} type="{kind}" preserve="1"><p:cSld name="{name}"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" '
            'name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
            '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>'
            '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>')


def _master() -> str:
    clr = ('bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
           'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"')
    level = lambda n: (f'<a:lvl{n}pPr marL="{342900 * (n - 1)}" algn="l"><a:defRPr sz="1800" kern="1200">'  # noqa: E731
                       '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr>'
                       f'</a:lvl{n}pPr>')
    styles = "".join(level(n) for n in range(1, 10))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<p:sldMaster {_P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'
            '<a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
            '</p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/>'
            '<a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>'
            f'<p:clrMap {clr}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/>'
            '<p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst>'
            f'<p:txStyles><p:titleStyle>{styles}</p:titleStyle><p:bodyStyle>{styles}</p:bodyStyle>'
            f'<p:otherStyle>{styles}</p:otherStyle></p:txStyles></p:sldMaster>')


def pptx(title: str, slides: list[dict]) -> bytes:
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    pml = "application/vnd.openxmlformats-officedocument.presentationml"

    def rels(items) -> str:
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + "".join(f'<Relationship Id="{i}" Type="{rel}/{t}" Target="{target}"/>' for i, t, target in items)
                + "</Relationships>")
    parts: dict[str, str] = {}
    overrides = {"/ppt/presentation.xml": f"{pml}.presentation.main+xml",
                 "/ppt/slideMasters/slideMaster1.xml": f"{pml}.slideMaster+xml",
                 "/ppt/slideLayouts/slideLayout1.xml": f"{pml}.slideLayout+xml",
                 "/ppt/slideLayouts/slideLayout2.xml": f"{pml}.slideLayout+xml",
                 "/ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
                 "/ppt/presProps.xml": f"{pml}.presProps+xml", "/ppt/viewProps.xml": f"{pml}.viewProps+xml",
                 "/ppt/tableStyles.xml": f"{pml}.tableStyles+xml", **_PROPS}
    for n, slide in enumerate(slides, 1):
        parts[f"ppt/slides/slide{n}.xml"] = _slide(n, slide, title)
        layout = 1 if n == 1 and not slide["bullets"] and not slide["table"] else 2
        parts[f"ppt/slides/_rels/slide{n}.xml.rels"] = rels([("rId1", "slideLayout", f"../slideLayouts/slideLayout{layout}.xml")])
        overrides[f"/ppt/slides/slide{n}.xml"] = f"{pml}.slide+xml"
    ids = "".join(f'<p:sldId id="{255 + n}" r:id="rId{n + 4}"/>' for n in range(1, len(slides) + 1))
    parts["ppt/presentation.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<p:presentation {_P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>'
        f'</p:sldMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="{_SLIDE_W}" cy="{_SLIDE_H}"/>'
        '<p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>'
        '</p:defaultTextStyle></p:presentation>')
    parts["ppt/_rels/presentation.xml.rels"] = rels(
        [("rId1", "slideMaster", "slideMasters/slideMaster1.xml"), ("rId2", "presProps", "presProps.xml"),
         ("rId3", "viewProps", "viewProps.xml"), ("rId4", "theme", "theme/theme1.xml"),
         *((f"rId{n + 4}", "slide", f"slides/slide{n}.xml") for n in range(1, len(slides) + 1)),
         (f"rId{len(slides) + 5}", "tableStyles", "tableStyles.xml")])
    parts["ppt/slideMasters/slideMaster1.xml"] = _master()
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels(
        [("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
         ("rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"), ("rId3", "theme", "../theme/theme1.xml")])
    for n, (kind, name) in enumerate((("title", "Title Slide"), ("obj", "Title and Content")), 1):
        parts[f"ppt/slideLayouts/slideLayout{n}.xml"] = _layout(kind, name)
        parts[f"ppt/slideLayouts/_rels/slideLayout{n}.xml.rels"] = rels([("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")])
    parts["ppt/theme/theme1.xml"] = _theme()
    parts["ppt/presProps.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                                  f'<p:presentationPr {_P}/>')
    parts["ppt/viewProps.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                                  f'<p:viewPr {_P}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/>'
                                  '</p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>')
    parts["ppt/tableStyles.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                                    '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                                    'def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>')
    return _zip({"[Content_Types].xml": _types(_BASE_TYPES, overrides),
                 "_rels/.rels": _RELS.replace("{main}", "ppt/presentation.xml"),
                 **parts,
                 "docProps/core.xml": _core(title),
                 "docProps/app.xml": _app(f"<Slides>{len(slides)}</Slides>")})


# --------------------------------------------------------------------------- PDF

def page_html(title: str, blocks: list[Block]) -> str:
    """The page a PDF prints: DGC's own markup and style around the model's escaped text. Nothing loads from
    anywhere (the policy blocks it), and no script runs."""
    def runs(rs) -> str:
        out = ""
        for r in rs:
            text = html.escape(r.text).replace("\n", "<br>")
            if r.code:
                text = f"<code>{text}</code>"
            if r.bold:
                text = f"<strong>{text}</strong>"
            if r.italic:
                text = f"<em>{text}</em>"
            if r.strike:
                text = f"<s>{text}</s>"
            if r.href:
                text = f'<a href="{html.escape(r.href, quote=True)}">{text}</a>'
            out += text
        return out
    body, open_lists = [], []                 # (ordered, list_id) per depth

    def close_to(depth):
        while len(open_lists) > depth:
            ordered, _ = open_lists.pop()
            body.append("</ol>" if ordered else "</ul>")
    titled = bool(blocks) and blocks[0].kind == "heading" and blocks[0].level == 1
    if not titled:
        body.append(f"<h1>{html.escape(title)}</h1>")
    for b in blocks:
        if b.kind == "item":
            close_to(b.level + 1)
            if len(open_lists) == b.level + 1 and open_lists[-1] != (b.ordered, b.list_id):
                close_to(b.level)
            while len(open_lists) <= b.level:
                open_lists.append((b.ordered, b.list_id))
                body.append(f'<ol start="{b.number}">' if b.ordered else "<ul>")
            body.append(f"<li>{runs(b.runs)}</li>")
            continue
        if b.kind == "para" and b.level and open_lists:
            close_to(b.level)
            body.append(f'<p class="in">{runs(b.runs)}</p>')
            continue
        close_to(0)
        if b.kind == "heading":
            level = min(4, b.level + (0 if titled else 1))
            body.append(f"<h{level}>{runs(b.runs)}</h{level}>")
        elif b.kind == "para":
            body.append(f"<p>{runs(b.runs)}</p>")
        elif b.kind == "quote":
            body.append(f"<blockquote>{runs(b.runs)}</blockquote>")
        elif b.kind == "code":
            body.append(f"<pre>{html.escape(b.text)}</pre>")
        elif b.kind == "rule":
            body.append("<hr>")
        elif b.kind == "table" and b.rows:
            rows = []
            for n, row in enumerate(b.rows):
                tag = "th" if n == 0 else "td"
                cells = "".join(f'<{tag} style="text-align:{b.aligns[c] if c < len(b.aligns) else "left"}">'
                                f"{runs(cell)}</{tag}>" for c, cell in enumerate(row))
                rows.append(f"<tr>{cells}</tr>")
            body.append(f"<table><thead>{rows[0]}</thead><tbody>{''.join(rows[1:])}</tbody></table>")
    close_to(0)
    return ("<!doctype html><html><head><meta charset=\"utf-8\">"
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">"
            f"<title>{html.escape(title)}</title><style>{_PAGE_CSS}</style></head><body>{''.join(body)}</body></html>")


_PAGE_CSS = """
@page { margin: 20mm 18mm 22mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { overflow-wrap: anywhere; font: 10.5pt/1.5 -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Devanagari",
       "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2937; margin: 0; }
h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 14pt; color: #111827; }
h2 { font-size: 15pt; margin: 20pt 0 6pt; color: #111827; break-after: avoid; }
h3 { font-size: 12.5pt; margin: 16pt 0 4pt; break-after: avoid; }
h4 { font-size: 11pt; margin: 12pt 0 4pt; break-after: avoid; }
p { margin: 0 0 8pt; orphans: 3; widows: 3; }
p.in { margin-left: 0; }
ul, ol { margin: 0 0 8pt; padding-left: 18pt; }
li { margin: 0 0 3pt; }
blockquote { margin: 0 0 8pt; padding: 2pt 0 2pt 12pt; border-left: 3pt solid #d1d5db; color: #4b5563; font-style: italic; }
code { font: 9pt/1.4 "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; background: #f3f4f6; padding: 0 2pt;
       border-radius: 2pt; }
pre { font: 9pt/1.45 "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; background: #f3f4f6; padding: 8pt 10pt;
      border-radius: 4pt; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 10pt; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 12pt; font-size: 9.5pt; font-variant-numeric: tabular-nums; }
th, td { border: 0.75pt solid #d1d5db; padding: 4pt 6pt; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
hr { border: 0; border-top: 0.75pt solid #d1d5db; margin: 12pt 0; }
a { color: #1d4ed8; }
"""


def _letter() -> bool:
    lang = os.environ.get("LC_ALL") or os.environ.get("LC_PAPER") or os.environ.get("LANG") or ""
    return bool(re.match(r"(en|es)_(US|CA|MX|PH)|fr_CA", lang))


def pdf(title: str, blocks: list[Block], config=None, *, browser=None) -> tuple[bytes, str, int]:
    """(bytes, a note for the user or "", pages). The user's browser prints it; without one, the built-in writer."""
    try:
        raw = _print(page_html(title, blocks), config, browser)
        return raw, "", len(re.findall(rb"/Type\s*/Page(?!s)", raw))
    except Exception as exc:          # no browser, or it wouldn't print: the plain writer, and say so
        reason = _why_plain(exc)
    raw, missing, pages = plain_pdf(title, blocks)
    note = (f"This PDF is plain text in Helvetica: {reason}"
            + (f" {missing} character{'s' if missing != 1 else ''} it can't draw show as ?." if missing else ""))
    return raw, note, pages


def _why_plain(exc: Exception) -> str:
    text = str(exc)
    if "No Chrome or Chromium found" in text:
        return "no Chrome or Edge was found to print it. With one installed, PDFs print with full typography."
    if "sandbox" in text:
        return ("Chrome can't start its sandbox on this system and DGC couldn't box it. Install bubblewrap, or set "
                "browser_allow_unsandboxed in ~/.dgc/config.json to run it without one.")
    return "the browser couldn't print it (" + (text.split("\n")[0][:120] or type(exc).__name__) + ")."


def _print(page: str, config, browser) -> bytes:
    from .. import browser as cdp
    folder = tempfile.mkdtemp(prefix="dgc-made-")
    path = os.path.join(folder, "page.html")
    session = None
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(page)
        get = getattr(config, "get", None) or (lambda key, default=None: default)
        # The page it prints is in its own folder: a browser in DGC's box may read that, and nothing else of yours.
        session = browser or cdp.BrowserSession(cdp.discover_browser(str(get("browser_path", "") or "")),
                                                allow_unsandboxed=bool(get("browser_allow_unsandboxed", False)),
                                                readable=(folder,))
        session.navigate("file://" + path if os.sep == "/" else "file:///" + path.replace("\\", "/"))
        width, height = (8.5, 11.0) if _letter() else (8.27, 11.69)
        footer = ('<div style="font: 8px -apple-system, \'Segoe UI\', Arial, sans-serif; color: #9ca3af; width: 100%; '
                  'text-align: center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>')
        result = session.command("Page.printToPDF", {
            "paperWidth": width, "paperHeight": height, "printBackground": True, "preferCSSPageSize": False,
            "marginTop": 0.79, "marginBottom": 0.87, "marginLeft": 0.71, "marginRight": 0.71,
            "displayHeaderFooter": True, "headerTemplate": "<div></div>", "footerTemplate": footer,
            "generateDocumentOutline": True}, timeout=90.0)
        raw = base64.b64decode(result.get("data") or "")
        if not raw.startswith(b"%PDF"):
            raise MadeError("the browser returned no PDF")
        return raw
    finally:
        if session is not None and browser is None:
            session.close()
        try:
            os.remove(path)
            os.rmdir(folder)
        except OSError:
            pass


# The built-in writer: PDF's standard Helvetica (no font to embed), WinAnsi text, laid out by its metrics.
_HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278] + [556] * 10 + \
    [278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
     778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
     556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
_HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278] + [556] * 10 + \
    [333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667,
     778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
     611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]


def _width(text: str, size: float, font: str) -> float:
    if font == "F4":
        return len(text) * 0.6 * size
    table = _HELV_B if font == "F2" else _HELV
    return sum(table[ord(c) - 32] if 32 <= ord(c) < 127 else 556 for c in text) * size / 1000


def _winansi(text: str) -> tuple[bytes, int]:
    out, missing = bytearray(), 0
    for c in text:
        try:
            out += c.encode("cp1252")
        except UnicodeEncodeError:
            out += b"?"
            missing += 1
    return bytes(out), missing


def _pdf_string(raw: bytes) -> bytes:
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


def plain_pdf(title: str, blocks: list[Block]) -> tuple[bytes, int, int]:
    width, height = (612, 792) if _letter() else (595, 842)
    left, right, top, bottom = 56, 56, 64, 64
    pages: list[list[bytes]] = [[]]
    y = height - top
    missing = 0

    def new_page():
        nonlocal y
        pages.append([])
        y = height - top

    def line(words: list[tuple[str, str]], size: float, indent: float, lead: float, *, shade=False):
        nonlocal y, missing
        if y - lead < bottom:
            new_page()
        y -= lead
        x = left + indent
        ops = []
        if shade:
            ops.append(f"0.953 0.957 0.965 rg {left + indent - 4:.1f} {y - 3:.1f} {width - left - right - indent + 8:.1f} "
                       f"{lead:.1f} re f 0 0 0 rg".encode())
        for text, font in words:
            raw, lost = _winansi(text)
            missing += lost
            ops.append(f"BT /{font} {size} Tf {x:.1f} {y:.1f} Td ".encode() + _pdf_string(raw) + b" Tj ET")
            x += _width(text, size, font)
        pages[-1].append(b"\n".join(ops))

    def flow(runs: list[Run], size: float, indent: float = 0, *, bold=False, prefix="", lead=None):
        """Wrap runs to the page, a list item's later lines hanging under its text, not its marker."""
        lead = lead or size * 1.45
        limit = width - left - right - indent
        pad = _width(prefix, size, "F1") if prefix else 0
        words: list[tuple[str, str]] = []
        for r in runs:
            font = "F4" if r.code else "F2" if (r.bold or bold) else "F3" if r.italic else "F1"
            for piece in re.split(r"(\s+)", r.text):
                if piece.isspace():
                    words.append(("\n" if "\n" in piece else " ", font))
                elif piece:
                    while _width(piece, size, font) > limit - pad and len(piece) > 1:     # a long URL: split it
                        cut = len(piece) - 1
                        while cut > 1 and _width(piece[:cut], size, font) > limit - pad:
                            cut -= 1
                        words.append((piece[:cut], font))
                        piece = piece[cut:]
                    words.append((piece, font))
        current, used, has_text, first = ([(prefix, "F1")] if prefix else []), pad, False, True
        for word, font in words:
            if word == "\n":
                if has_text:
                    line(current, size, indent if first else indent + pad, lead)
                    current, used, has_text, first = [], pad, False, False
                continue
            if word == " " and not has_text:
                continue
            w = _width(word, size, font)
            if word != " " and has_text and used + w > limit:
                while current and current[-1][0] == " ":
                    current.pop()
                line(current, size, indent if first else indent + pad, lead)
                current, used, has_text, first = [], pad, False, False
            current.append((word, font))
            used += w
            has_text = has_text or word != " "
        if has_text:
            line(current, size, indent if first else indent + pad, lead)

    titled = bool(blocks) and blocks[0].kind == "heading" and blocks[0].level == 1
    if not titled:
        flow([Run(title)], 20, bold=True)
        y -= 8
    for b in blocks:
        if b.kind == "heading":
            size = {1: 20, 2: 15, 3: 12.5}.get(b.level + (0 if titled else 1), 11)
            y -= size * 0.6
            flow(b.runs, size, bold=True)
            y -= 2
        elif b.kind in ("para", "quote"):
            flow(b.runs, 10.5, 18 * b.level if b.kind == "para" else 14)
            y -= 6
        elif b.kind == "item":
            marker = f"{b.number}. " if b.ordered else "• "
            flow(b.runs, 10.5, 14 + 16 * b.level, prefix=marker)
            y -= 2
        elif b.kind == "code":
            for text in b.text.split("\n") or [""]:
                line([(text[:96], "F4")], 9, 4, 12.5, shade=True)
            y -= 8
        elif b.kind == "rule":
            if y - 12 < bottom:
                new_page()
            y -= 8
            pages[-1].append(f"0.82 0.84 0.86 RG 0.75 w {left} {y:.1f} m {width - right} {y:.1f} l S".encode())
            y -= 8
        elif b.kind == "table" and b.rows:
            cols = max(len(r) for r in b.rows)
            col_w = (width - left - right) / cols
            for n, row in enumerate(b.rows):
                cells = [_plain(row[c]) if c < len(row) else "" for c in range(cols)]
                wrapped = []
                for text in cells:
                    lines_, current = [], ""
                    for word in text.split():
                        trial = (current + " " + word).strip()
                        if _width(trial, 9, "F2" if n == 0 else "F1") > col_w - 8 and current:
                            lines_.append(current)
                            current = word
                        else:
                            current = trial
                    lines_.append(current)
                    wrapped.append(lines_)
                rows_tall = max(len(w) for w in wrapped)
                if y - rows_tall * 12 - 6 < bottom:
                    new_page()
                for k in range(rows_tall):
                    pieces = []
                    for c in range(cols):
                        text = wrapped[c][k] if k < len(wrapped[c]) else ""
                        raw, lost = _winansi(text)
                        missing += lost
                        pieces.append(f"BT /{'F2' if n == 0 else 'F1'} 9 Tf {left + c * col_w + 4:.1f} "
                                      f"{y - 12 * (k + 1):.1f} Td ".encode() + _pdf_string(raw) + b" Tj ET")
                    pages[-1].append(b"\n".join(pieces))
                y -= rows_tall * 12 + 4
                pages[-1].append(f"0.82 0.84 0.86 RG 0.5 w {left} {y:.1f} m {width - right} {y:.1f} l S".encode())
            y -= 8
    # objects: 1 catalog, 2 pages, 3-6 fonts, 7 info, then (content, page) per page: 8 + 2n and 9 + 2n
    objects: list[bytes] = []
    fonts = ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Courier")
    kids = []
    for n in range(len(pages)):
        kids.append(f"{9 + 2 * n} 0 R")
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(pages)} >>".encode())
    for font in fonts:
        objects.append(f"<< /Type /Font /Subtype /Type1 /BaseFont /{font} /Encoding /WinAnsiEncoding >>".encode())
    raw_title, _ = _winansi(title)
    objects.append(b"<< /Title " + _pdf_string(raw_title) + b" /Producer (ChatDGC) >>")
    for n, ops in enumerate(pages):
        footer = f"BT /F1 8 Tf {width / 2 - 10:.1f} 32 Td ({n + 1} / {len(pages)}) Tj ET".encode()
        stream = b"\n".join([*ops, footer])
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents {8 + 2 * n} 0 R "
                       "/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> >>".encode())
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out), missing, len(pages)
