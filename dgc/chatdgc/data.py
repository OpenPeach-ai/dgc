"""Data analysis (ChatGPT's), without running code the model wrote: a chat's spreadsheets as SQLite tables to query.

ChatGPT answers questions about a spreadsheet by writing and running Python. ChatDGC loads each CSV, TSV or Excel
sheet the chat holds (attached, in its project, or made by it) into an in-memory SQLite database, and the model asks
with one read-only SELECT at a time (``query_data``): exact sums, groups, trends and medians, never estimates from
reading rows. Nothing it writes can touch a file or the network: the database lives in memory, an authorizer allows
reading and functions only, and a query has seconds and a row cap.
"""
from __future__ import annotations

import csv
import io
import math
import re
import sqlite3
import statistics
import time
import zipfile
from datetime import datetime, timedelta
from xml.etree import ElementTree

MAX_ROWS = 100_000          # loaded, over every table
MAX_COLUMNS = 200
MAX_RESULT_ROWS = 200       # a query's result, as the model reads it
SHOWN_ROWS = 60             # of those, in the table it reads (the rest counted)
QUERY_SECONDS = 5.0
TABULAR = (".csv", ".tsv", ".xlsx")
_NUMBER = re.compile(r"^[-+]?(?:[$₹€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$|^[-+]?\.\d+%?$")


class DataError(Exception):
    """A query or a file that can't be used as asked; the text says what to change."""


def tabular(name: str) -> bool:
    return str(name or "").lower().endswith(TABULAR)


def _ident(value: str, used: set, fallback: str) -> str:
    text = re.sub(r"[^0-9a-zA-Z]+", "_", str(value or "").strip().lower()).strip("_")[:40] or fallback
    if text[0].isdigit():
        text = "c_" + text
    base, n = text, 2
    while text in used:
        text, n = f"{base}_{n}", n + 1
    used.add(text)
    return text


def _number(value):
    """A cell as a number when it's plainly one (1,234.5; ₹12,000; 15%), else None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = str(value or "").strip()
    if not text or not _NUMBER.match(text):
        return None
    percent = text.endswith("%")
    clean = re.sub(r"[,%$₹€£¥\s]", "", text)
    try:
        number = float(clean)
    except ValueError:
        return None
    if percent:
        return number / 100
    return int(number) if number.is_integer() and "." not in clean and abs(number) < 2**53 else number


# --------------------------------------------------------------------------- reading files

def _csv_rows(raw: bytes, name: str) -> list[list]:
    text = raw.decode("utf-8-sig", errors="replace")
    sample = text[:20_000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|") if not name.lower().endswith(".tsv") else csv.excel_tab
    except csv.Error:
        dialect = csv.excel_tab if name.lower().endswith(".tsv") else csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect)]


_DATE_FORMATS = set(range(14, 23)) | {45, 46, 47}


def _xlsx_sheets(raw: bytes) -> list[tuple[str, list[list]]]:
    """Each sheet's rows as values: shared and inline strings, numbers, booleans, and dates (by their format) as ISO."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rel = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
        names = set(z.namelist())

        def xml(part):
            if part not in names or z.getinfo(part).file_size > 80_000_000:
                return None
            return ElementTree.fromstring(z.read(part))
        shared = []
        strings = xml("xl/sharedStrings.xml")
        for si in strings.findall("m:si", ns) if strings is not None else []:
            shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
        dates = set()
        styles = xml("xl/styles.xml")
        if styles is not None:
            custom = {int(f.get("numFmtId")): f.get("formatCode", "") for f in styles.findall("m:numFmts/m:numFmt", ns)}
            for i, xf in enumerate(styles.findall("m:cellXfs/m:xf", ns)):
                fmt = int(xf.get("numFmtId", "0"))
                code = re.sub(r"\[[^\]]*\]|\"[^\"]*\"", "", custom.get(fmt, "")).lower()
                if fmt in _DATE_FORMATS or (fmt in custom and re.search(r"[dy]", code) and "0" not in code[:1]):
                    dates.add(i)
        book = xml("xl/workbook.xml")
        rels = xml("xl/_rels/workbook.xml.rels")
        targets = {r.get("Id"): r.get("Target") for r in (rels if rels is not None else [])}
        out = []
        for sheet in book.findall("m:sheets/m:sheet", ns) if book is not None else []:
            target = targets.get(sheet.get(rel), "")
            part = target.lstrip("/") if target.startswith("/") else "xl/" + target
            data = xml(part)
            if data is None:
                continue
            rows = []
            for row in data.findall("m:sheetData/m:row", ns):
                cells = {}
                for c in row.findall("m:c", ns):
                    ref = re.match(r"([A-Z]+)", c.get("r", "") or "")
                    col = 0
                    for ch in ref.group(1) if ref else "":
                        col = col * 26 + ord(ch) - 64
                    col = col - 1 if ref else len(cells)
                    kind, v = c.get("t"), c.find("m:v", ns)
                    if kind == "s" and v is not None:
                        value = shared[int(v.text)] if v.text and int(v.text) < len(shared) else ""
                    elif kind == "inlineStr":
                        value = "".join(t.text or "" for t in c.iter(f"{{{ns['m']}}}t"))
                    elif kind == "b" and v is not None:
                        value = "TRUE" if v.text == "1" else "FALSE"
                    elif v is not None and v.text is not None:
                        value = v.text if kind in ("str", "e") else _number(v.text)
                        if value is None:
                            value = v.text
                        if isinstance(value, (int, float)) and int(c.get("s", "0") or 0) in dates and 0 < value < 2958466:
                            value = (datetime(1899, 12, 30) + timedelta(days=float(value))).isoformat(sep=" ")
                            value = value[:10] if value.endswith("00:00:00") else value
                    else:
                        value = ""
                    if 0 <= col < MAX_COLUMNS:
                        cells[col] = value
                if cells:
                    rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
            out.append((sheet.get("name") or "Sheet", rows))
        return out
    except (zipfile.BadZipFile, ElementTree.ParseError, KeyError, ValueError) as exc:
        raise DataError(f"That workbook couldn't be read ({type(exc).__name__}).") from None


# --------------------------------------------------------------------------- the database

class Data:
    """A chat's tables, in memory. ``files``: (name, bytes) for each spreadsheet."""

    def __init__(self, files: list[tuple[str, bytes]]):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.tables: list[dict] = []
        self.problems: list[str] = []
        self._functions()
        used: set = set()
        loaded = 0
        for name, raw in files:
            try:
                sheets = _xlsx_sheets(raw) if name.lower().endswith(".xlsx") else [("", _csv_rows(raw, name))]
            except DataError as exc:
                self.problems.append(f"{name}: {exc}")
                continue
            stem = re.sub(r"\.(csv|tsv|xlsx)$", "", name, flags=re.I)
            for sheet, rows in sheets:
                rows = [r for r in rows if any(str(c).strip() for c in r)]
                if len(rows) < 2:
                    continue
                if loaded + len(rows) > MAX_ROWS:
                    self.problems.append(f"{name}{' / ' + sheet if sheet else ''}: left out, past {MAX_ROWS:,} rows in all")
                    continue
                table = _ident(stem if len(sheets) == 1 else f"{stem} {sheet}", used, "data")
                self._load(table, name, sheet, rows)
                loaded += len(rows) - 1
        self.db.set_authorizer(self._authorize)

    def _functions(self) -> None:
        """What ChatGPT's pandas would have: medians, spreads, correlations, roots and logs."""
        class Median:
            def __init__(self): self.values = []
            def step(self, v):
                if isinstance(v, (int, float)): self.values.append(v)
            def finalize(self): return statistics.median(self.values) if self.values else None

        class Stdev(Median):
            def finalize(self): return statistics.stdev(self.values) if len(self.values) > 1 else None

        class Variance(Median):
            def finalize(self): return statistics.variance(self.values) if len(self.values) > 1 else None

        class Corr:
            def __init__(self): self.xs, self.ys = [], []
            def step(self, x, y):
                if isinstance(x, (int, float)) and isinstance(y, (int, float)): self.xs.append(x); self.ys.append(y)
            def finalize(self):
                try:
                    return statistics.correlation(self.xs, self.ys) if len(self.xs) > 1 else None
                except statistics.StatisticsError:
                    return None
        self.db.create_aggregate("median", 1, Median)
        self.db.create_aggregate("stdev", 1, Stdev)
        self.db.create_aggregate("variance", 1, Variance)
        self.db.create_aggregate("corr", 2, Corr)
        for fname, fn in (("sqrt", math.sqrt), ("ln", math.log), ("log10", math.log10), ("exp", math.exp)):
            try:
                self.db.execute(f"SELECT {fname}(1)")
            except sqlite3.OperationalError:
                self.db.create_function(fname, 1, lambda v, fn=fn: None if v is None else fn(v), deterministic=True)
        try:
            self.db.execute("SELECT pow(2, 2)")
        except sqlite3.OperationalError:
            self.db.create_function("pow", 2, lambda a, b: None if a is None or b is None else a ** b, deterministic=True)

    def _load(self, table: str, name: str, sheet: str, rows: list[list]) -> None:
        width = min(MAX_COLUMNS, max(len(r) for r in rows))
        header, body = rows[0][:width], [r[:width] + [""] * (width - len(r[:width])) for r in rows[1:]]
        used: set = set()
        columns = [_ident(str(header[i]) if i < len(header) else "", used, f"column_{i + 1}") for i in range(width)]
        kinds = []
        for i in range(width):
            values = [r[i] for r in body if str(r[i]).strip()]
            numbers = [_number(v) for v in values]
            coded = any(re.match(r"^0\d", str(v).strip()) for v in values)          # 007, 0412: codes, not numbers
            kinds.append("REAL" if values and not coded and all(n is not None for n in numbers) else "TEXT")
        quoted = ", ".join(f'"{c}" {k}' for c, k in zip(columns, kinds))
        self.db.execute(f'CREATE TABLE "{table}" ({quoted})')
        cast = [(lambda v: _number(v) if str(v).strip() else None) if k == "REAL" else
                (lambda v: str(v) if str(v).strip() else None) for k in kinds]
        self.db.executemany(f'INSERT INTO "{table}" VALUES ({", ".join("?" * width)})',
                            [[cast[i](r[i]) for i in range(width)] for r in body])
        sample = self.db.execute(f'SELECT * FROM "{table}" LIMIT 3').fetchall()
        self.tables.append({"table": table, "file": name, "sheet": sheet, "rows": len(body),
                            "columns": [{"name": c, "type": "number" if k == "REAL" else "text", "header": str(h)}
                                        for c, k, h in zip(columns, kinds, list(header) + [""] * width)],
                            "sample": sample})

    @staticmethod
    def _authorize(action, arg1, arg2, db_name, trigger):
        allowed = (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE)
        return sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY

    def describe(self) -> str:
        """The tables as the model reads them: names, columns with their types, row counts and the first rows."""
        out = []
        for t in self.tables:
            cols = ", ".join(f"{c['name']} ({c['type']}{'' if c['header'].lower().replace(' ', '_') == c['name'] else ', was “' + c['header'][:40] + '”'})"
                             for c in t["columns"])
            where = t["file"] + (f", sheet {t['sheet']}" if t["sheet"] else "")
            first = "; ".join("(" + ", ".join(_show(v) for v in row) + ")" for row in t["sample"])
            out.append(f"- {t['table']} (from {where}, {t['rows']:,} rows): {cols}. First rows: {first}")
        return "\n".join(out + [f"- Not loaded: {p}" for p in self.problems])

    def query(self, sql: str) -> dict:
        """One read-only SELECT (WITH … SELECT too). Rows capped, seconds capped."""
        text = str(sql or "").strip().rstrip(";").strip()
        if not text:
            raise DataError("Give one SQL SELECT query.")
        if not re.match(r"(?is)^(select|with)\b", text) or ";" in text:
            raise DataError("Only one SELECT query at a time (WITH … SELECT is fine); nothing that changes the data.")
        deadline = time.monotonic() + QUERY_SECONDS
        self.db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 20_000)
        try:
            cursor = self.db.execute(text)
            names = [d[0] for d in cursor.description or []]
            rows = cursor.fetchmany(MAX_RESULT_ROWS + 1)
        except sqlite3.DatabaseError as exc:
            message = str(exc)
            if "interrupted" in message:
                message = f"it took more than {QUERY_SECONDS:.0f} seconds; ask for less"
            elif "not authorized" in message:
                message = "only reading the tables is allowed"
            raise DataError(f"That query didn't run: {message}.") from None
        finally:
            self.db.set_progress_handler(None, 0)
        more = len(rows) > MAX_RESULT_ROWS
        return {"columns": names, "rows": rows[:MAX_RESULT_ROWS], "more": more}

    def close(self) -> None:
        self.db.close()


def _show(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        # In full: 6 significant digits turned 44,662.76 into 44,662.8, and the model quoted it (live run).
        shown = round(value, 6)
        return str(int(shown)) if shown.is_integer() and abs(shown) < 1e15 else repr(shown)
    return str(value)[:60]


def as_table(result: dict) -> str:
    """A result as the model reads it: a Markdown table, the first SHOWN_ROWS rows, and how many there are."""
    columns, rows = result["columns"], result["rows"]
    if not columns:
        return "The query returned nothing."
    head = "| " + " | ".join(columns) + " |\n|" + "---|" * len(columns)
    body = "\n".join("| " + " | ".join(_show(v).replace("|", "/") for v in row) + " |" for row in rows[:SHOWN_ROWS])
    count = len(rows)
    tail = ""
    if result["more"] or count > SHOWN_ROWS:
        tail = (f"\n({'more than ' if result['more'] else ''}{count:,} rows; showing the first {min(count, SHOWN_ROWS)}. "
                "Aggregate or add LIMIT for fewer.)")
    return f"{count:,} row{'s' if count != 1 else ''}:\n{head}\n{body}{tail}" if rows else "No rows matched."
