"""A page as a file people pass around: what it says as a Word document, its tables as a workbook.

A page is HTML, which DGC never made a layout for, so this reads what it says rather than how it looks: headings,
paragraphs, lists, quotes, code, links and tables, in order. Scripts, styles, navigation, buttons and anything hidden
aren't part of what it says. Pictures become their descriptions: a PDF keeps the look, and a Word file keeps the words.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser

from .chatdgc.made import MAX_SHEETS, MAX_TEXT, Block, Run

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
_LEFT_OUT = {"script", "style", "noscript", "template", "nav", "svg", "canvas", "iframe", "object", "embed", "audio",
             "video", "button", "select", "textarea", "datalist", "meter", "progress", "dialog"}
_BREAKS = {"address", "article", "aside", "body", "center", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
           "figure", "footer", "form", "header", "hgroup", "html", "main", "p", "section", "summary"}
_LINKS = re.compile(r"(?:https?://|mailto:)", re.I)
_HIDDEN_STYLE = re.compile(r"(?:display\s*:\s*none|visibility\s*:\s*hidden)", re.I)


class _Reader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self.tables: list[dict] = []
        self.title = ""
        self._runs: list[Run] = []
        self._skip: list[str] = []
        self._bold = self._italic = self._code = self._strike = 0
        self._href: list[str] = []
        self._lists: list[dict] = []
        self._list_ids = 0
        self._item_open = False
        self._quote = 0
        self._heading = 0
        self._pre: list[str] | None = None
        self._table: dict | None = None
        self._table_depth = 0
        self._in_title = False
        self._said = 0
        self._last_heading = ""

    # -- what's being written
    def _add(self, text: str) -> None:
        if not text or self._said > MAX_TEXT:
            return
        self._said += len(text)
        run = Run(text, bold=self._bold > 0 or self._heading > 0, italic=self._italic > 0, code=self._code > 0,
                  strike=self._strike > 0, href=self._href[-1] if self._href else "")
        last = self._runs[-1] if self._runs else None
        if last and (last.bold, last.italic, last.code, last.strike, last.href) == (run.bold, run.italic, run.code, run.strike, run.href):
            last.text += text
        else:
            self._runs.append(run)

    def _taken(self) -> list[Run]:
        """The words so far, without the spaces their edges only had from the source's line breaks."""
        runs, self._runs = self._runs, []
        if runs:
            runs[0].text = runs[0].text.lstrip()
            runs[-1].text = runs[-1].text.rstrip()
        return [run for run in runs if run.text]

    def _flush(self) -> None:
        runs = self._taken()
        if not runs:
            return
        if self._table is not None and self._table.get("cell") is not None:
            self._table["cell"].extend(runs)
        elif self._heading:
            self.blocks.append(Block("heading", [Run(r.text, italic=r.italic, code=r.code, href=r.href) for r in runs], level=self._heading))
            self._last_heading = "".join(r.text for r in runs)
        elif self._lists and self._item_open:
            current = self._lists[-1]
            self.blocks.append(Block("item", runs, level=len(self._lists) - 1, ordered=current["ordered"], number=current["n"], list_id=current["id"]))
            self._item_open = False
        elif self._lists:
            self.blocks.append(Block("para", runs, level=len(self._lists)))
        else:
            self.blocks.append(Block("quote" if self._quote else "para", runs))

    # -- the parser
    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if self._skip:
            if tag not in _VOID:
                self._skip.append(tag)
            return
        if tag == "title":
            self._in_title = True
            return
        hidden = ("hidden" in fields or str(fields.get("aria-hidden") or "").lower() == "true"
                  or _HIDDEN_STYLE.search(str(fields.get("style") or "")) is not None)
        if tag in _LEFT_OUT or hidden:
            if tag not in _VOID:
                self._skip.append(tag)
            return
        if tag in _BREAKS:
            self._flush()
        elif re.fullmatch(r"h[1-6]", tag):
            self._flush()
            self._heading = int(tag[1])
        elif tag in ("ul", "ol", "menu"):
            self._flush()
            self._list_ids += 1
            start = str(fields.get("start") or "1")
            self._lists.append({"ordered": tag == "ol", "n": (int(start) - 1) if start.lstrip("-").isdigit() else 0, "id": self._list_ids})
        elif tag == "li":
            self._flush()
            if self._lists:
                self._lists[-1]["n"] += 1
            self._item_open = True
        elif tag == "blockquote":
            self._flush()
            self._quote += 1
        elif tag == "pre":
            self._flush()
            self._pre = []
        elif tag == "hr":
            self._flush()
            self.blocks.append(Block("rule"))
        elif tag == "br":
            if self._pre is not None:
                self._pre.append("\n")
            else:
                self._add(" ")
        elif tag == "table":
            self._table_depth += 1
            if self._table_depth == 1:
                self._flush()
                self._table = {"rows": [], "row": None, "cell": None, "before": self._last_heading}
        elif tag == "tr" and self._table_depth == 1 and self._table is not None:
            self._end_row()
            self._table["row"] = []
        elif tag in ("td", "th") and self._table_depth == 1 and self._table is not None:
            self._end_cell()
            if self._table["row"] is None:
                self._table["row"] = []
            self._table["cell"] = []
            self._table["span"] = int(fields["colspan"]) if str(fields.get("colspan") or "").isdigit() else 1
        elif tag in ("b", "strong"):
            self._bold += 1
        elif tag in ("i", "em", "cite"):
            self._italic += 1
        elif tag in ("code", "kbd", "samp"):
            self._code += 1
        elif tag in ("s", "strike", "del"):
            self._strike += 1
        elif tag == "a":
            href = str(fields.get("href") or "")
            self._href.append(href if _LINKS.match(href) else "")
        elif tag == "img":
            self._add(str(fields.get("alt") or ""))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self._skip:
            # Unclosed tags inside a left-out part end with it.
            if tag in self._skip:
                while self._skip and self._skip.pop() != tag:
                    pass
            return
        if tag == "title":
            self._in_title = False
        elif tag in _BREAKS:
            self._flush()
        elif re.fullmatch(r"h[1-6]", tag):
            self._flush()
            self._heading = 0
        elif tag in ("ul", "ol", "menu"):
            self._flush()
            if self._lists:
                self._lists.pop()
        elif tag == "li":
            self._flush()
            self._item_open = False
        elif tag == "blockquote":
            self._flush()
            self._quote = max(0, self._quote - 1)
        elif tag == "pre" and self._pre is not None:
            text, self._pre = "".join(self._pre).strip("\n"), None
            self._said += len(text)
            if text.strip() and self._said <= MAX_TEXT:
                self.blocks.append(Block("code", text=text))
        elif tag == "table":
            self._table_depth = max(0, self._table_depth - 1)
            if self._table_depth == 0:
                self._end_table()
        elif tag == "tr" and self._table_depth == 1:
            self._end_row()
        elif tag in ("td", "th") and self._table_depth == 1:
            self._end_cell()
        elif tag in ("b", "strong"):
            self._bold = max(0, self._bold - 1)
        elif tag in ("i", "em", "cite"):
            self._italic = max(0, self._italic - 1)
        elif tag in ("code", "kbd", "samp"):
            self._code = max(0, self._code - 1)
        elif tag in ("s", "strike", "del"):
            self._strike = max(0, self._strike - 1)
        elif tag == "a" and self._href:
            self._href.pop()

    def handle_data(self, data):
        if self._skip:
            return
        if self._in_title:
            self.title = (self.title + data)[:200]
        elif self._pre is not None:
            self._pre.append(data)
        else:
            text = re.sub(r"\s+", " ", data)
            if text.strip() or self._runs:
                self._add(text)

    # -- tables
    def _end_cell(self) -> None:
        table = self._table
        if table is None or table.get("cell") is None:
            return
        cell = table["cell"]
        runs = self._taken()
        table["cell"] = None
        cell.extend(runs)
        if table["row"] is not None:
            table["row"].append(cell)
            table["row"].extend([] for _ in range(min(table.get("span", 1), 64) - 1))

    def _end_row(self) -> None:
        table = self._table
        if table is None:
            return
        self._end_cell()
        if table.get("row"):
            table["rows"].append(table["row"])
        table["row"] = None

    def _end_table(self) -> None:
        table, self._table = self._table, None
        if table is None:
            return
        table["cell"] = table.get("cell")
        self._table = table
        self._end_row()
        self._table = None
        rows = table["rows"]
        widest = max((len(row) for row in rows), default=0)
        if widest <= 1 or len(rows) < 2:
            # A table used to lay a page out, not to hold data: its words, in order.
            for row in rows:
                for cell in row:
                    if cell:
                        self.blocks.append(Block("para", cell))
            return
        rows = [row + [[] for _ in range(widest - len(row))] for row in rows]
        self.blocks.append(Block("table", rows=rows, aligns=[""] * widest))
        self.tables.append({"name": table.get("before") or f"Table {len(self.tables) + 1}",
                            "rows": [["".join(run.text for run in cell) for cell in row] for row in rows]})

    def finish(self) -> None:
        self.close()
        if self._table is not None:
            self._table_depth = 0
            self._end_table()
        self._pre = None
        self._flush()


def read(html: str) -> _Reader:
    reader = _Reader()
    reader.feed(html if isinstance(html, str) else str(html or ""))
    reader.finish()
    return reader


def has_table(html: str) -> bool:
    """Whether the page holds a table of data, not only one laying it out."""
    return "<table" in html.lower() and bool(read(html).tables)


def has_words(reader: _Reader) -> bool:
    return any(block.kind in ("code", "table", "rule") or "".join(run.text for run in block.runs).strip() for block in reader.blocks)


def sheets(reader: _Reader) -> list[dict]:
    return reader.tables[:MAX_SHEETS]
