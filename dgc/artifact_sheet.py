"""Sheets: a spreadsheet DGC keeps as data (an artifact's ``sheet.json``) and lays out the same way every time.

The model hands over what each sheet holds, never a file's bytes or its markup:

    {"sheets": [{"name": "Budget",
                 "columns": [{"name": "Item", "type": "text"},
                             {"name": "Planned", "type": "currency", "currency": "₹"}],
                 "rows": [["Rent", 45000], ["Groceries", 18000], ["Total", "=SUM(B2:B3)"]],
                 "frozen": 1}]}

Cells are addressed the way every spreadsheet addresses them, so a formula means the same here and in Excel: row 1
holds the column names, the first of ``rows`` is row 2, and the first column is A. A text that starts with "=" is a
formula; write "'=" for text that starts with "=". A column is text, number, currency (with its symbol, "$" unless
given), percent (0.15 shows as 15%), date ("2026-10-28", or "2026-10-28 14:30") or bool; "decimals" fixes how many
places a number shows. "frozen" is how many rows at the top stay in view (1, the column names, unless given).

- ``normalize``: a workbook checked and complete. Its errors name the sheet, the cell, its row and its column, and
  say what to write instead, in words a small local model can act on. Normalizing a normalized workbook gives it
  back unchanged.
- ``compute``: the values the cells show. Formulas are parsed here and never handed to eval: numbers, "text",
  TRUE and FALSE, references (A1, $A$1), ranges (A1:B9, B:B), other sheets (Summary!B4, 'Q3 plan'!B4), the
  operators + - * / ^ & % and = <> < > <= >=, and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, IF, ABS and CONCAT.
  A loop of formulas shows #CYCLE and the rest show what a spreadsheet shows: #REF!, #DIV/0!, #NAME?, #VALUE!, #NUM!.
  ``problems`` says, cell by cell, why.
- ``apply_edits``: the ``edit_artifact`` tool's ops (set a cell or a range, insert and delete rows and columns,
  change a column, add, rename and delete a sheet, sort, freeze). Every reference in every formula moves the way a
  spreadsheet moves it, so a total stays the total: a reference to a deleted cell becomes #REF!, and rows inserted
  right under a range, above the formula that reads it, join the range. Nothing changes unless every edit applies.
- ``render_html``: a clean read-only grid, one tab a sheet, that loads nothing from anywhere.
- ``export_xlsx`` (formulas stay formulas, each column keeps its number format) and ``export_csv``.
- ``from_table_file``: a sheet from a .csv, .tsv or .xlsx file (the files ChatDGC already made), read by
  ``dgc.chatdgc.data``'s readers.
- ``outline``: what the model reads back before it edits: every cell by its address, formulas with what they show.

Standard library only, with ``dgc.chatdgc.made``'s limits and workbook writer and ``dgc.chatdgc.data``'s readers.
"""
from __future__ import annotations

import bisect
import copy
import dataclasses
import functools
import html
import json
import math
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

from .chatdgc import data as tabledata
from .chatdgc import made

TYPES = ("text", "number", "currency", "percent", "date", "bool")
FUNCTIONS = ("SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "ROUND", "IF", "ABS", "CONCAT")
EDIT_OPS = ("set", "insert_rows", "delete_rows", "insert_columns", "delete_columns", "set_column", "add_sheet",
            "rename_sheet", "delete_sheet", "sort", "freeze")
ERRORS = ("#CYCLE", "#REF!", "#DIV/0!", "#NAME?", "#VALUE!", "#NUM!", "#N/A", "#NULL!", "#CALC!")

MAX_SHEETS = made.MAX_SHEETS
MAX_CELLS = made.MAX_CELLS              # over the workbook, the column names included
MAX_COLUMNS = tabledata.MAX_COLUMNS
MAX_TEXT = 32_000                       # one cell's text (Excel's limit is 32,767)
MAX_FORMULA = 8_000                     # one formula (Excel's is 8,192)
MAX_NAME = 31                           # a sheet's name, as Excel allows
MAX_COLUMN_NAME = 80
MAX_FROZEN = 10
MAX_EDITS = 100
MAX_DEPTH = 64                          # brackets and functions inside one another, in one formula
MAX_WORK = 5_000_000                    # cells read by ranges in one compute; past it formulas show #CALC!
MAX_DEP_WORK = 250_000                 # formula dependency edges; bounds memory before evaluating ranges
MAX_FILE_BYTES = 50 * 1024 * 1024       # a table file from_table_file reads
DEFAULT_CURRENCY = "$"

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]")
_BAD_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")
_CURRENCY = re.compile(r"[^\d\s\"'\\;,.#%@*+=<>\-\[\]]{1,4}\Z")
_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\Z")
_CELL = re.compile(r"\$?([A-Za-z]{1,3})\$?(\d{1,7})\Z")
_COLUMN = re.compile(r"[A-Za-z]{1,3}\Z")
_EPOCH = datetime(1899, 12, 30)
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_MAX_ROW = 1_048_576
_MAX_COL = 16_384


class SheetError(ValueError):
    """A workbook or an edit that can't be used as given; the text names the sheet, the cell and what to change."""


class CellError(str):
    """What a cell shows when its formula can't give a value ("#DIV/0!"), as a spreadsheet shows it. It is text, so
    it reads and serializes as its code; ``why`` says what caused it and ``cell`` names the cell it started in."""
    why: str = ""
    cell: str = ""


def _err(code: str, why: str = "") -> CellError:
    error = CellError(code)
    error.why = why
    return error


# =========================================================================== addresses

def letters(index: int) -> str:
    """Column A for 0, B for 1 … AA for 26."""
    return made._column(index)


def column_index(text: str) -> int:
    n = 0
    for ch in text.upper():
        n = n * 26 + ord(ch) - 64
    return n - 1


def _address(row: int, col: int) -> str:
    return f"{letters(col)}{row}"


def _quote_sheet(name: str) -> str:
    if re.fullmatch(r"[^\W\d][\w.]*", name) and not re.fullmatch(r"[A-Za-z]{1,3}\d+", name) \
            and name.upper() not in ("TRUE", "FALSE"):
        return name
    return "'" + name.replace("'", "''") + "'"


# =========================================================================== formulas: reading them

_TOKENS = re.compile(r"""
  (?P<ws>\s+)
| (?P<str>"(?:[^"]|"")*")
| (?P<err>\#(?:REF!|DIV/0!|NAME\?|VALUE!|N/A|NUM!|NULL!|CYCLE|CALC!))
| (?P<ref>(?:'(?:[^']|'')+'!|[^\W\d][\w.]*!)?
          (?:\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3})
          (?![\w.(!:]))
| (?P<num>(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)
| (?P<name>[^\W\d][\w.]*)
| (?P<op><=|>=|<>|[-+*/^&=<>%(),])
""", re.X)
_REF_PARTS = re.compile(r"(?:(?P<sheet>'(?:[^']|'')+'|[^\W\d][\w.]*)!)?(?P<a>[^:]+)(?::(?P<b>.+))?\Z")
_POINT = re.compile(r"(\$?)([A-Za-z]{1,3})(?:(\$?)(\d+))?\Z")


@dataclass(frozen=True)
class _Ref:
    """A reference: one cell (single), a range, or whole columns (rows None). Columns from 0, rows from 1."""
    sheet: str | None
    c1: int
    r1: int | None
    c2: int
    r2: int | None
    ac1: bool = False
    ar1: bool = False
    ac2: bool = False
    ar2: bool = False
    single: bool = False

    @property
    def whole(self) -> bool:
        return self.r1 is None


@dataclass(frozen=True)
class _Tok:
    kind: str
    text: str
    ref: _Ref | None = None


class _Bad(Exception):
    """A formula that can't be read; the text says why."""


def _point(text: str):
    m = _POINT.match(text)
    if not m:
        return None
    col = column_index(m.group(2))
    row = int(m.group(4)) if m.group(4) else None
    if col >= _MAX_COL or (row is not None and not 1 <= row <= _MAX_ROW):
        return None
    return col, row, bool(m.group(1)), bool(m.group(3))


def _parse_ref(text: str) -> _Ref | None:
    m = _REF_PARTS.match(text)
    if not m:
        return None
    sheet = m.group("sheet")
    if sheet and sheet.startswith("'"):
        sheet = sheet[1:-1].replace("''", "'")
    a = _point(m.group("a"))
    if a is None:
        return None
    if m.group("b") is None:
        if a[1] is None:
            return None
        return _Ref(sheet, a[0], a[1], a[0], a[1], a[2], a[3], a[2], a[3], single=True)
    b = _point(m.group("b"))
    if b is None or (a[1] is None) != (b[1] is None):
        return None
    c1, c2 = sorted((a[0], b[0]))
    ac1, ac2 = (a[2], b[2]) if a[0] <= b[0] else (b[2], a[2])
    if a[1] is None:
        return _Ref(sheet, c1, None, c2, None, ac1, False, ac2, False)
    r1, r2 = sorted((a[1], b[1]))
    ar1, ar2 = (a[3], b[3]) if a[1] <= b[1] else (b[3], a[3])
    return _Ref(sheet, c1, r1, c2, r2, ac1, ar1, ac2, ar2)


def _ref_text(ref: _Ref) -> str:
    def point(c, r, ac, ar):
        return ("$" if ac else "") + letters(c) + ("" if r is None else ("$" if ar else "") + str(r))
    text = point(ref.c1, ref.r1, ref.ac1, ref.ar1)
    if not ref.single:
        text += ":" + point(ref.c2, ref.r2, ref.ac2, ref.ar2)
    return (_quote_sheet(ref.sheet) + "!" + text) if ref.sheet is not None else text


@functools.lru_cache(maxsize=8192)
def _tokens(formula: str) -> tuple:
    """A formula's tokens (its text after the "="), each with its text written the canonical way: references and
    function names in capitals."""
    out, i = [], 0
    while i < len(formula):
        m = _TOKENS.match(formula, i)
        if not m or m.end() == i:
            if formula[i] == '"':
                raise _Bad("a text in quotes isn't closed: end it with another \"")
            if formula[i] == ":":
                raise _Bad("a range needs both its ends, like B2:B9")
            raise _Bad(f"“{formula[i:i + 12]}” can't be read here")
        kind, text = m.lastgroup, m.group()
        i = m.end()
        if kind == "ref":
            ref = _parse_ref(text)
            if ref is None:
                kind = "name"
            else:
                out.append(_Tok("ref", _ref_text(ref), ref))
                continue
        if kind == "name":
            text = text.upper()
        out.append(_Tok(kind, text))
    return tuple(out)


_ARITY = {"SUM": (1, 255), "AVERAGE": (1, 255), "MIN": (1, 255), "MAX": (1, 255), "COUNT": (1, 255),
          "COUNTA": (1, 255), "ROUND": (2, 2), "IF": (2, 3), "ABS": (1, 1), "CONCAT": (1, 255)}
_USAGE = {"SUM": "SUM(B2:B9)", "AVERAGE": "AVERAGE(B2:B9)", "MIN": "MIN(B2:B9)", "MAX": "MAX(B2:B9)",
          "COUNT": "COUNT(B2:B9)", "COUNTA": "COUNTA(A2:A9)", "ROUND": "ROUND(B2, 2)",
          "IF": "IF(B2>0, \"yes\", \"no\")", "ABS": "ABS(B2)", "CONCAT": "CONCAT(A2, \" \", B2)"}
_COMPARE = ("=", "<>", "<", ">", "<=", ">=")


class _Parser:
    """Excel's precedence, low to high: comparisons, &, + -, * /, ^ (left to right, as Excel does), a leading -
    (so -2^2 is 4, as in Excel), a trailing %."""

    def __init__(self, tokens):
        self.t = [tok for tok in tokens if tok.kind != "ws"]
        self.i = 0
        self.depth = 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def is_op(self, *ops) -> bool:
        tok = self.peek()
        return tok is not None and tok.kind == "op" and tok.text in ops

    def parse(self):
        if not self.t:
            raise _Bad("there's nothing after the =")
        node = self.compare()
        if self.peek() is not None:
            raise _Bad(f"“{self.peek().text}” isn't expected after {self._before()}")
        return node

    def _before(self) -> str:
        return "“" + " ".join(t.text for t in self.t[max(0, self.i - 3):self.i]) + "”"

    def _binary(self, ops, lower):
        node = lower()
        while self.is_op(*ops):
            op = self.take().text
            node = ("bin", op, node, lower())
        return node

    def compare(self):
        return self._binary(_COMPARE, self.concat)

    def concat(self):
        return self._binary(("&",), self.additive)

    def additive(self):
        return self._binary(("+", "-"), self.multiplicative)

    def multiplicative(self):
        return self._binary(("*", "/"), self.power)

    def power(self):
        return self._binary(("^",), self.unary)

    def unary(self):
        if self.is_op("-", "+"):
            op = self.take().text
            self.depth += 1
            if self.depth > MAX_DEPTH:
                raise _Bad("it nests too deeply")
            node = ("neg" if op == "-" else "pos", self.unary())
            self.depth -= 1
            return node
        return self.postfix()

    def postfix(self):
        node = self.primary()
        while self.is_op("%"):
            self.take()
            node = ("pct", node)
        return node

    def primary(self):
        tok = self.take()
        if tok is None:
            raise _Bad("it ends too early" + (f", after {self._before()}" if self.t else ""))
        if tok.kind == "num":
            return ("n", float(tok.text))
        if tok.kind == "str":
            return ("s", tok.text[1:-1].replace('""', '"'))
        if tok.kind == "err":
            return ("e", tok.text)
        if tok.kind == "ref":
            return ("ref" if tok.ref.single else "rng", tok.ref)
        if tok.kind == "name":
            if self.is_op("("):
                self.take()
                self.depth += 1
                if self.depth > MAX_DEPTH:
                    raise _Bad("it nests too deeply")
                args = []
                if not self.is_op(")"):
                    while True:
                        if self.is_op(",", ")"):
                            raise _Bad(f"{tok.text}( ) has an empty value between its commas")
                        args.append(self.compare())
                        if self.is_op(","):
                            self.take()
                            continue
                        break
                if not self.is_op(")"):
                    raise _Bad(f"{tok.text}( is missing its closing bracket")
                self.take()
                self.depth -= 1
                if tok.text in _ARITY:
                    lo, hi = _ARITY[tok.text]
                    if not lo <= len(args) <= hi:
                        count = f"{lo}" if lo == hi else f"{lo} to {hi}" if hi < 255 else f"at least {lo}"
                        raise _Bad(f"{tok.text} takes {count} value{'s' if hi != 1 else ''}, like "
                                   f"={_USAGE[tok.text]}")
                return ("call", tok.text, tuple(args))
            if tok.text in ("TRUE", "FALSE"):
                return ("b", tok.text == "TRUE")
            return ("name", tok.text)
        if tok.kind == "op" and tok.text == "(":
            self.depth += 1
            if self.depth > MAX_DEPTH:
                raise _Bad("it nests too deeply")
            node = self.compare()
            if not self.is_op(")"):
                raise _Bad("a bracket isn't closed")
            self.take()
            self.depth -= 1
            return node
        raise _Bad(f"“{tok.text}” isn't expected" + (f" after {self._before()[:-1]}”" if self.i > 1 else " there"))


@functools.lru_cache(maxsize=8192)
def _ast(formula: str):
    return _Parser(_tokens(formula)).parse()


def _is_formula(value) -> bool:
    return isinstance(value, str) and len(value) > 1 and value[0] == "="


def _canonical(formula: str) -> str:
    """The formula (after "=") as it's kept: references and function names in capitals, spacing as written."""
    return "".join(tok.text for tok in _tokens(formula))


def _rewrite(formula: str, change) -> str:
    """The formula with each reference passed through ``change(ref)``: a new _Ref, or None for one that no longer
    exists (it becomes #REF!, as a spreadsheet writes it)."""
    out = []
    for tok in _tokens(formula):
        if tok.kind == "ref":
            new = change(tok.ref)
            out.append("#REF!" if new is None else _ref_text(new))
        else:
            out.append(tok.text)
    return "".join(out)


# =========================================================================== values

def _serial(text: str):
    """An ISO date as a spreadsheet's day number (1900 date system, as Excel and LibreOffice keep it)."""
    m = _DATE.match(text)
    if not m:
        return None
    try:
        when = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4) or 0),
                        int(m.group(5) or 0), int(m.group(6) or 0))
    except ValueError:
        return None
    delta = when - _EPOCH
    serial = delta.days + delta.seconds / 86400
    return int(serial) if float(serial).is_integer() else serial


def _iso(serial) -> str | None:
    if not isinstance(serial, (int, float)) or isinstance(serial, bool) or not 0 < serial < 2958466:
        return None
    when = _EPOCH + timedelta(days=float(serial))
    when = when.replace(microsecond=0) + timedelta(seconds=round(when.microsecond / 1e6))
    if when.hour == when.minute == when.second == 0:
        return when.strftime("%Y-%m-%d")
    return when.strftime("%Y-%m-%d %H:%M" if when.second == 0 else "%Y-%m-%d %H:%M:%S")


def _num_text(value) -> str:
    """A number as a spreadsheet writes it in text: 15 significant digits, no grouping (0.1+0.2 is "0.3")."""
    if isinstance(value, int):
        return str(value)
    if float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    text = f"{value:.15g}"
    return text.upper() if "e" in text else text


def _clean_number(value):
    """A computed number as it's shown and kept: 15 significant digits, a whole number as an int."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    if isinstance(value, float):
        value = float(f"{value:.15g}")
        if value.is_integer() and abs(value) < 2 ** 53:
            return int(value)
    return value


def _text_number(text: str):
    """Text a formula reads as a number, the way a spreadsheet does: "12", "1,200", "₹1,200", "15%", "2026-10-28"."""
    number = tabledata._number(text)
    if number is not None:
        return number
    return _serial(text.strip())


# =========================================================================== normalize

def _where(sheet: str, row: int, col: int, columns: list) -> str:
    name = columns[col]["name"] if col < len(columns) and isinstance(columns[col], dict) else ""
    return (f"{sheet}!{_address(row, col)} (row {row}, column {letters(col)}"
            + (f" “{name}”" if name else "") + ")")


def _sheet_name(value, n: int, used: set) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        value = f"Sheet{n}"
    if not isinstance(value, str):
        raise SheetError(f"Sheet {n}'s name should be text, like \"Budget\".")
    name = " ".join(value.split())
    if len(name) > MAX_NAME:
        raise SheetError(f"Sheet {n}'s name “{name[:40]}…” is {len(name)} characters; a sheet's name is at most "
                         f"{MAX_NAME}.")
    if _BAD_SHEET_CHARS.search(name) or _CTRL.search(name) or name.startswith("'") or name.endswith("'"):
        raise SheetError(f"Sheet {n}'s name “{name}” can't have [ ] : * ? / \\ in it or start or end with '. "
                         "Use letters, numbers, spaces and dashes.")
    if name.casefold() == "history":
        raise SheetError(f"Sheet {n} can't be named “History”: Excel keeps that name for itself.")
    if name.casefold() in used:
        raise SheetError(f"Two sheets are named “{name}”; each sheet needs a name of its own.")
    used.add(name.casefold())
    return name


def _infer(values) -> tuple[str, str]:
    """A column's type from what it holds (formulas aside): (type, currency symbol)."""
    seen = [v for v in values if v is not None and v != "" and not _is_formula(v)]
    if not seen:
        return ("number", "") if any(_is_formula(v) for v in values) else ("text", "")
    if all(isinstance(v, bool) or (isinstance(v, str) and v.strip().upper() in ("TRUE", "FALSE")) for v in seen):
        return "bool", ""
    if all(isinstance(v, str) and _serial(v.strip()) is not None for v in seen):
        return "date", ""
    numbers = []
    for v in seen:
        if isinstance(v, bool):
            return "text", ""
        if isinstance(v, (int, float)):
            numbers.append(v)
            continue
        text = str(v).strip()
        if re.match(r"^[-+]?0\d", text) or tabledata._number(text) is None:      # 007, 0412: codes, not numbers
            return "text", ""
        numbers.append(text)
    texts = [str(v).strip().lstrip("+-") for v in numbers if isinstance(v, str)]
    if texts and all(t.endswith("%") for t in texts) and len(texts) == len(numbers):
        return "percent", ""
    symbols = {t[0] for t in texts if t[:1] in "$₹€£¥"}
    if len(symbols) == 1 and all(t[:1] in "$₹€£¥" for t in texts):
        return "currency", symbols.pop()
    return "number", ""


def _column_spec(raw, n: int, sheet: str, values) -> dict:
    if isinstance(raw, str):
        raw = {"name": raw}
    if not isinstance(raw, dict):
        raise SheetError(f'{sheet}\'s column {letters(n)} should be {{"name": "…", "type": "number"}}.')
    for key in raw:
        if key not in ("name", "type", "currency", "decimals"):
            raise SheetError(f'{sheet}\'s column {letters(n)} has "{str(key)[:30]}"; a column has "name", "type", '
                             '"currency" and "decimals".')
    name = raw.get("name")
    if isinstance(name, (int, float)) and not isinstance(name, bool):
        name = _num_text(name)
    if not isinstance(name, str) or not name.strip():
        raise SheetError(f'{sheet}\'s column {letters(n)} needs a name: {{"name": "Amount", "type": "number"}}.')
    name = " ".join(_CTRL.sub(" ", name).split())
    if len(name) > MAX_COLUMN_NAME:
        raise SheetError(f"{sheet}'s column {letters(n)} name is {len(name)} characters; keep it to "
                         f"{MAX_COLUMN_NAME}.")
    kind = raw.get("type")
    inferred, symbol = _infer(values)
    if kind in (None, ""):
        kind = inferred
    kind = str(kind).strip().lower()
    kind = {"string": "text", "str": "text", "int": "number", "integer": "number", "float": "number",
            "decimal": "number", "money": "currency", "boolean": "bool", "checkbox": "bool", "datetime": "date",
            "%": "percent"}.get(kind, kind)
    if kind not in TYPES:
        raise SheetError(f'{sheet}\'s column {letters(n)} “{name}” has type "{str(raw.get("type"))[:20]}"; a '
                         f'column\'s type is one of {", ".join(TYPES)}.')
    out = {"name": name, "type": kind}
    if kind == "currency":
        cur = raw.get("currency") or symbol or DEFAULT_CURRENCY
        if not isinstance(cur, str) or not _CURRENCY.match(cur.strip()):
            raise SheetError(f'{sheet}\'s column {letters(n)} “{name}” has currency "{str(cur)[:10]}"; give its '
                             'symbol or code, like "₹", "$", "€" or "CHF".')
        out["currency"] = cur.strip()
    elif raw.get("currency") not in (None, ""):
        raise SheetError(f'{sheet}\'s column {letters(n)} “{name}” is a {kind} column, so it has no currency. '
                         'Give it "type": "currency" to show a symbol.')
    if raw.get("decimals") is not None:
        d = raw["decimals"]
        if kind not in ("number", "currency", "percent"):
            raise SheetError(f"{sheet}'s column {letters(n)} “{name}” is a {kind} column; only number, currency "
                             "and percent columns have decimals.")
        if isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6:
            raise SheetError(f"{sheet}'s column {letters(n)} “{name}”: decimals is a whole number from 0 to 6.")
        out["decimals"] = d
    return out


def _value(value, col: dict, where: str):
    """One cell, checked against its column's type."""
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        raise SheetError(f"{where} isn't a finite number; leave it empty (null) instead.")
    if isinstance(value, str):
        value = _CTRL.sub("", value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")) \
            if _CTRL.search(value) or "\r" in value or "\t" in value else value
        if not value.strip():
            return None
        if _is_formula(value):
            if len(value) > MAX_FORMULA:
                raise SheetError(f"{where} has a formula of {len(value):,} characters; a formula is at most "
                                 f"{MAX_FORMULA:,}.")
            try:
                _ast(value[1:])
                return "=" + _canonical(value[1:])
            except _Bad as error:
                raise SheetError(f"{where}: the formula {value[:80]} can't be read: {error}.") from None
        if len(value) > MAX_TEXT:
            raise SheetError(f"{where} holds {len(value):,} characters; a cell holds at most {MAX_TEXT:,}.")
    kind = col["type"]
    if kind == "text":
        if isinstance(value, bool):
            return "TRUE" if value else "FALSE"
        if isinstance(value, (int, float)):
            return _num_text(value)
        if not isinstance(value, str):
            raise SheetError(f"{where} should be text, a number or a formula.")
        return value
    if kind in ("number", "currency", "percent"):
        if isinstance(value, bool):
            raise SheetError(f"{where} is a {kind} column; {str(value).lower()} isn't a number. Write a number, "
                             "or make the column a bool column.")
        if isinstance(value, (int, float)):
            return _clean_number(value)
        if isinstance(value, str):
            number = tabledata._number(value)
            if number is not None:
                return _clean_number(number)
        example = {"number": "1200", "currency": "45000", "percent": "0.15 (shows as 15%)"}[kind]
        raise SheetError(f"{where} is a {kind} column, and “{str(value)[:40]}” isn't a number. Write a number like "
                         f"{example}, a formula like \"=B2*2\", or nothing (null). A note belongs in a text column.")
    if kind == "date":
        if isinstance(value, str):
            m = _DATE.match(value.strip())
            if m and _serial(value.strip()) is not None:
                day = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
                if m.group(4) is None:
                    return day
                return f"{day} {m.group(4)}:{m.group(5)}" + (f":{m.group(6)}" if m.group(6) not in (None, "00")
                                                             else "")
        raise SheetError(f"{where} is a date column; “{str(value)[:40]}” isn't a date written as 2026-10-28 (or "
                         "2026-10-28 14:30). Write the year first, then the month and the day.")
    # bool
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in ("true", "false", "yes", "no"):
        return value.strip().lower() in ("true", "yes")
    raise SheetError(f"{where} is a bool column; “{str(value)[:40]}” isn't true or false.")


def _sheet(raw, n: int, used: set) -> dict:
    if not isinstance(raw, dict):
        raise SheetError(f'Sheet {n} should be {{"name": "…", "columns": [{{"name": "…", "type": "text"}}], '
                         '"rows": [["…"]]}.')
    for key in raw:
        if key not in ("name", "columns", "rows", "frozen"):
            raise SheetError(f'Sheet {n} has "{str(key)[:30]}"; a sheet has "name", "columns", "rows" and '
                             '"frozen".')
    name = _sheet_name(raw.get("name"), n, used)
    rows = raw.get("rows", [])
    if rows is None:
        rows = []
    if not isinstance(rows, list) or not all(isinstance(r, list) for r in rows):
        raise SheetError(f'{name}\'s rows should be a list of rows, each a list of cells: "rows": [["Rent", 45000]].')
    columns = raw.get("columns")
    if columns is None:
        if not rows or not all(isinstance(c, str) and c.strip() for c in rows[0]):
            raise SheetError(f'{name} needs its columns: "columns": [{{"name": "Item", "type": "text"}}, '
                             '{"name": "Amount", "type": "number"}] (or the column names as its first row).')
        columns, rows = list(rows[0]), rows[1:]
    if not isinstance(columns, list) or not columns:
        raise SheetError(f'{name} needs at least one column: "columns": [{{"name": "Item", "type": "text"}}].')
    if len(columns) > MAX_COLUMNS:
        raise SheetError(f"{name} has {len(columns)} columns; a sheet holds at most {MAX_COLUMNS}.")
    width = len(columns)
    for r, row in enumerate(rows, 2):
        if len(row) > width:
            raise SheetError(f"{name} row {r} has {len(row)} cells but the sheet has {width} columns "
                             f"(A to {letters(width - 1)}). Add a column first, or drop the extra cells.")
    specs, seen = [], set()
    for c, col in enumerate(columns):
        spec = _column_spec(col, c, name, [row[c] if c < len(row) else None for row in rows])
        if spec["name"].casefold() in seen:
            raise SheetError(f"{name} has two columns named “{spec['name']}”; each column needs a name of its own.")
        seen.add(spec["name"].casefold())
        specs.append(spec)
    out_rows = []
    for r, row in enumerate(rows, 2):
        out_rows.append([_value(row[c] if c < len(row) else None, specs[c], _where(name, r, c, specs))
                         for c in range(width)])
    frozen = raw.get("frozen", 1)
    if frozen is None:
        frozen = 1
    if isinstance(frozen, bool) or not isinstance(frozen, int) or not 0 <= frozen <= MAX_FROZEN:
        raise SheetError(f"{name}'s frozen is how many rows at the top stay in view: 0 to {MAX_FROZEN} (1 keeps the "
                         "column names in view).")
    return {"name": name, "columns": specs, "rows": out_rows, "frozen": frozen}


def normalize(sheet) -> dict:
    """The workbook, checked and complete: {"sheets": [{"name", "columns": [{"name", "type", …}], "rows", "frozen"}]},
    every row as long as its columns, every value of its column's type, every formula readable and written the
    canonical way. Errors name the sheet, the cell, its row and column, and what to write instead."""
    if isinstance(sheet, (str, bytes)):
        try:
            sheet = json.loads(sheet)
        except ValueError as error:
            raise SheetError(f"The sheet isn't valid JSON ({error}).") from None
    if isinstance(sheet, list):
        sheet = {"sheets": [{"name": "Sheet1", "rows": sheet}]}
    if isinstance(sheet, dict) and "sheets" not in sheet and ("rows" in sheet or "columns" in sheet):
        sheet = {"sheets": [sheet]}
    if not isinstance(sheet, dict):
        raise SheetError('A spreadsheet is {"sheets": [{"name": "Budget", "columns": [{"name": "Item", "type": '
                         '"text"}, {"name": "Amount", "type": "number"}], "rows": [["Rent", 45000]]}]}.')
    for key in sheet:
        if key != "sheets":
            raise SheetError(f'A spreadsheet has "sheets"; "{str(key)[:30]}" isn\'t part of it. Put it on a sheet.')
    sheets = sheet.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        raise SheetError('Give the spreadsheet its sheets: "sheets": [{"name": "Budget", "columns": [...], '
                         '"rows": [...]}].')
    if len(sheets) > MAX_SHEETS:
        raise SheetError(f"The spreadsheet has {len(sheets)} sheets; it holds at most {MAX_SHEETS}.")
    cells = 0
    for raw in sheets:
        if isinstance(raw, dict):
            rows = raw.get("rows") if isinstance(raw.get("rows"), list) else []
            cols = raw.get("columns") if isinstance(raw.get("columns"), list) else []
            cells += len(cols) + sum(len(r) if isinstance(r, list) else 1 for r in rows)
    if cells > MAX_CELLS:
        raise SheetError(f"The spreadsheet has {cells:,} cells; it holds at most {MAX_CELLS:,}. Split it, or keep "
                         "the rows that matter.")
    used: set = set()
    out = [_sheet(raw, n, used) for n, raw in enumerate(sheets, 1)]
    total = sum(len(s["columns"]) * (len(s["rows"]) + 1) for s in out)
    if total > MAX_CELLS:
        raise SheetError(f"The spreadsheet has {total:,} cells; it holds at most {MAX_CELLS:,}. Split it, or keep "
                         "the rows that matter.")
    return {"sheets": out}


# =========================================================================== compute

class _Budget(Exception):
    pass


class _Range:
    __slots__ = ("si", "ref")

    def __init__(self, si, ref):
        self.si, self.ref = si, ref


class _Book:
    """A normalized workbook, evaluated: every formula's value, each computed once, after the cells it reads."""

    def __init__(self, book: dict):
        self.sheets = book["sheets"]
        self.index = {s["name"].casefold(): i for i, s in enumerate(self.sheets)}
        self.asts: dict = {}
        self.fcols: dict = {}
        for si, s in enumerate(self.sheets):
            for r, row in enumerate(s["rows"], 2):
                for c, v in enumerate(row):
                    if _is_formula(v):
                        self.asts[(si, r, c)] = _ast(v[1:])
                        self.fcols.setdefault((si, c), []).append(r)
        self.memo: dict = {}
        self.work = 0
        self.dep_work = 0
        self.over = False
        for key in self.asts:
            self._resolve(key)

    # reading cells ----------------------------------------------------------------------------------------
    def name(self, key) -> str:
        si, r, c = key
        return f"{self.sheets[si]['name']}!{_address(r, c)}"

    def target(self, ref: _Ref, si: int):
        if ref.sheet is None:
            return si
        return self.index.get(ref.sheet.casefold())

    def cell(self, si: int, r: int, c: int):
        key = (si, r, c)
        if key in self.asts:
            if key in self.memo:
                return self.memo[key]
            return _err("#CALC!", "DGC stopped computing: the sheet's formulas read more than "
                                  f"{MAX_WORK:,} cells in all. Excel or LibreOffice will compute it.")
        s = self.sheets[si]
        columns = s["columns"]
        if c >= len(columns):
            return None
        if r == 1:
            return columns[c]["name"]
        if not 2 <= r <= len(s["rows"]) + 1:
            return None
        v = s["rows"][r - 2][c]
        if isinstance(v, str):
            if columns[c]["type"] == "date":
                serial = _serial(v)
                return serial if serial is not None else v
            if v.startswith("'="):
                return v[1:]
        return v

    def extent(self, si: int, ref: _Ref):
        """The part of a range that holds anything: (rows, columns) clipped to the sheet's data."""
        s = self.sheets[si]
        last_row = len(s["rows"]) + 1
        r1 = 1 if ref.whole else ref.r1
        r2 = last_row if ref.whole else min(ref.r2, last_row)
        c2 = min(ref.c2, len(s["columns"]) - 1)
        return range(r1, r2 + 1), range(ref.c1, c2 + 1)

    def values(self, si: int, ref: _Ref) -> list:
        rows, cols = self.extent(si, ref)
        self.work += len(rows) * len(cols)
        if self.work > MAX_WORK:
            raise _Budget()
        return [self.cell(si, r, c) for r in rows for c in cols]

    # the order of computing ---------------------------------------------------------------------------------
    def deps(self, key) -> list:
        si = key[0]
        out = []
        for ref in _refs(self.asts[key]):
            t = self.target(ref, si)
            if t is None:
                continue
            if ref.single:
                if (t, ref.r1, ref.c1) in self.asts:
                    self.dep_work += 1
                    if self.dep_work > MAX_DEP_WORK:
                        raise _Budget()
                    out.append((t, ref.r1, ref.c1))
                continue
            rows, cols = self.extent(t, ref)
            if not rows:
                continue
            for c in cols:
                found = self.fcols.get((t, c))
                if not found:
                    continue
                lo, hi = bisect.bisect_left(found, rows.start), bisect.bisect_right(found, rows.stop - 1)
                self.dep_work += hi - lo
                if self.dep_work > MAX_DEP_WORK:
                    raise _Budget()
                out.extend((t, r, c) for r in found[lo:hi])
        return out

    def _resolve(self, start) -> None:
        """Compute ``start`` after every formula it reads, without recursion (a running total down 10,000 rows is a
        chain 10,000 deep); a formula that reads itself, however far round, is part of a loop and shows #CYCLE."""
        if start in self.memo:
            return
        if self.over:
            error = _err("#CALC!", "DGC stopped computing: the workbook exceeded its calculation budget")
            error.cell = self.name(start)
            self.memo[start] = error
            return
        stack = []
        try:
            stack = [(start, iter(self.deps(start)))]
            on = {start: 0}
            while stack:
                key, deps = stack[-1]
                pushed = False
                for dep in deps:
                    if dep in self.memo:
                        continue
                    if dep in on:
                        loop = [k for k, _ in stack[on[dep]:]]
                        names = ", ".join(_address(k[1], k[2]) if k[0] == loop[0][0] else self.name(k) for k in loop[:6])
                        for k in loop:
                            if k not in self.memo:
                                error = _err("#CYCLE", f"it is part of a loop of formulas that read each other "
                                                       f"({names}{', …' if len(loop) > 6 else ''}); break the loop")
                                error.cell = self.name(k)
                                self.memo[k] = error
                        continue
                    on[dep] = len(stack)
                    stack.append((dep, iter(self.deps(dep))))
                    pushed = True
                    break
                if pushed:
                    continue
                stack.pop()
                on.pop(key, None)
                if key not in self.memo:
                    self.memo[key] = self.evaluate(key)
        except _Budget:
            self.over = True
            for key, _ in stack or [(start, None)]:
                if key not in self.memo:
                    error = _err("#CALC!", "DGC stopped computing: formula dependencies exceed the workbook budget")
                    error.cell = self.name(key)
                    self.memo[key] = error

    def evaluate(self, key):
        if self.over:
            return self.cell(*key)
        try:
            value = self.ev(self.asts[key], key[0])
        except _Budget:
            self.over = True
            return self.cell(*key)
        except (RecursionError, MemoryError):
            value = _err("#NUM!", "it is too large to compute")
        if isinstance(value, _Range):
            value = _err("#VALUE!", "it is a range where one value is expected: wrap it in SUM( ) or point at one "
                                    "cell")
        if value is None:
            value = 0
        if isinstance(value, float) and not math.isfinite(value):
            value = _err("#NUM!", "its result is too large to be a number")
        if isinstance(value, CellError) and not value.cell:
            value.cell = self.name(key)
        if isinstance(value, float) and value.is_integer() and abs(value) < 2 ** 53:
            value = int(value)
        return value                    # full precision: a spreadsheet rounds only what it shows

    # evaluating ---------------------------------------------------------------------------------------------
    def scalar(self, value):
        if isinstance(value, _Range):
            return _err("#VALUE!", "it uses a range where one value is expected: wrap it in SUM( ) or point at one "
                                   "cell")
        return value

    def ev(self, node, si: int):
        kind = node[0]
        if kind in ("n", "s", "b"):
            return node[1]
        if kind == "e":
            return _err(node[1], "it refers to a cell, row, column or sheet that was deleted" if node[1] == "#REF!"
                        else f"its formula holds the error {node[1]}")
        if kind == "name":
            return _err("#NAME?", f"“{node[1]}” isn't something DGC's sheets know: put text in quotes (\"{node[1]}\"), "
                                  "and refer to cells like B2")
        if kind == "ref":
            ref = node[1]
            t = self.target(ref, si)
            if t is None:
                return _err("#REF!", f"there's no sheet named “{ref.sheet}”")
            return self.cell(t, ref.r1, ref.c1)
        if kind == "rng":
            t = self.target(node[1], si)
            if t is None:
                return _err("#REF!", f"there's no sheet named “{node[1].sheet}”")
            return _Range(t, node[1])
        if kind == "neg":
            v = _to_number(self.scalar(self.ev(node[1], si)))
            return v if isinstance(v, CellError) else -v
        if kind == "pos":
            return self.scalar(self.ev(node[1], si))
        if kind == "pct":
            v = _to_number(self.scalar(self.ev(node[1], si)))
            return v if isinstance(v, CellError) else v / 100
        if kind == "bin":
            return self.binary(node[1], self.scalar(self.ev(node[2], si)), self.scalar(self.ev(node[3], si)))
        return self.call(node[1], node[2], si)

    @staticmethod
    def binary(op, a, b):
        for v in (a, b):
            if isinstance(v, CellError):
                return v
        if op == "&":
            return _to_text(a) + _to_text(b)
        if op in _COMPARE:
            c = _compare(a, b)
            return {"=": c == 0, "<>": c != 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0}[op]
        x, y = _to_number(a), _to_number(b)
        for v in (x, y):
            if isinstance(v, CellError):
                return v
        try:
            if op == "+":
                return x + y
            if op == "-":
                return x - y
            if op == "*":
                return x * y
            if op == "/":
                if y == 0:
                    return _err("#DIV/0!", "it divides by zero (or by an empty cell)")
                return x / y
            if x == 0 and y < 0:
                return _err("#DIV/0!", "it raises zero to a negative power")
            result = x ** y
            if isinstance(result, complex):
                return _err("#NUM!", "it takes a fractional power of a negative number")
            return result
        except OverflowError:
            return _err("#NUM!", "its result is too large to be a number")

    def gather(self, args, si: int, *, count: bool = False):
        """The numbers SUM, AVERAGE, MIN, MAX and COUNT see, as a spreadsheet gathers them: in a reference, only
        numbers count (text, TRUE/FALSE and empty cells are skipped); a value written in the formula is turned into
        a number. An error stops the function, except for COUNT, which skips it."""
        numbers = []
        for arg in args:
            if arg[0] in ("ref", "rng"):
                t = self.target(arg[1], si)
                if t is None:
                    if count:
                        continue
                    return _err("#REF!", f"there's no sheet named “{arg[1].sheet}”")
                for v in self.values(t, arg[1]):
                    if isinstance(v, CellError):
                        if not count:
                            return v
                    elif isinstance(v, (int, float)) and not isinstance(v, bool):
                        numbers.append(v)
                continue
            v = self.scalar(self.ev(arg, si))
            if isinstance(v, CellError):
                if count:
                    continue
                return v
            if v is None:
                continue
            n = _to_number(v)
            if isinstance(n, CellError):
                if count:
                    continue
                return n
            numbers.append(n)
        return numbers

    def call(self, name: str, args, si: int):
        if name not in _ARITY:
            return _err("#NAME?", f"DGC's sheets don't know {name}; they know {', '.join(FUNCTIONS)}")
        if name == "IF":
            test = self.scalar(self.ev(args[0], si))
            if isinstance(test, CellError):
                return test
            truth = _to_bool(test)
            if isinstance(truth, CellError):
                return truth
            if truth:
                return self.scalar(self.ev(args[1], si))
            return self.scalar(self.ev(args[2], si)) if len(args) > 2 else False
        if name in ("SUM", "AVERAGE", "MIN", "MAX", "COUNT"):
            numbers = self.gather(args, si, count=name == "COUNT")
            if isinstance(numbers, CellError):
                return numbers
            if name == "SUM":
                return math.fsum(numbers)
            if name == "COUNT":
                return len(numbers)
            if name == "AVERAGE":
                if not numbers:
                    return _err("#DIV/0!", "AVERAGE has no numbers to average")
                return math.fsum(numbers) / len(numbers)
            if not numbers:
                return 0
            return min(numbers) if name == "MIN" else max(numbers)
        if name == "COUNTA":
            n = 0
            for arg in args:
                if arg[0] in ("ref", "rng"):
                    t = self.target(arg[1], si)
                    if t is not None:
                        n += sum(1 for v in self.values(t, arg[1]) if v is not None and v != "")
                else:
                    n += 1
            return n
        if name == "CONCAT":
            parts = []
            for arg in args:
                if arg[0] in ("ref", "rng"):
                    t = self.target(arg[1], si)
                    if t is None:
                        return _err("#REF!", f"there's no sheet named “{arg[1].sheet}”")
                    for v in self.values(t, arg[1]):
                        if isinstance(v, CellError):
                            return v
                        parts.append(_to_text(v))
                    continue
                v = self.scalar(self.ev(arg, si))
                if isinstance(v, CellError):
                    return v
                parts.append(_to_text(v))
            text = "".join(parts)
            if len(text) > 32_767:
                return _err("#VALUE!", "its text would be longer than a cell holds")
            return text
        x = _to_number(self.scalar(self.ev(args[0], si)))
        if isinstance(x, CellError):
            return x
        if name == "ABS":
            return abs(x)
        digits = _to_number(self.scalar(self.ev(args[1], si)))
        if isinstance(digits, CellError):
            return digits
        return _round(x, int(digits))


def _refs(node):
    """Every reference in a parsed formula."""
    out, stack = [], [node]
    while stack:
        n = stack.pop()
        kind = n[0]
        if kind in ("ref", "rng"):
            out.append(n[1])
        elif kind in ("neg", "pos", "pct"):
            stack.append(n[1])
        elif kind == "bin":
            stack.extend((n[2], n[3]))
        elif kind == "call":
            stack.extend(n[2])
    return out


def _to_number(v):
    if v is None:
        return 0
    if isinstance(v, CellError):
        return v
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    number = _text_number(str(v))
    if number is None:
        return _err("#VALUE!", f"it does arithmetic with “{str(v)[:30]}”, which is text, not a number")
    return number


def _to_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return _num_text(_clean_number(v))
    return str(v)


def _to_bool(v):
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if str(v).strip().upper() in ("TRUE", "FALSE"):
        return str(v).strip().upper() == "TRUE"
    return _err("#VALUE!", f"IF's test is “{str(v)[:30]}”, which is text, not TRUE or FALSE")


def _compare(a, b) -> int:
    """A spreadsheet's order: numbers, then text (ignoring case), then FALSE and TRUE; an empty cell is 0 or ""."""
    if a is None:
        a = "" if isinstance(b, str) else False if isinstance(b, bool) else 0
    if b is None:
        b = "" if isinstance(a, str) else False if isinstance(a, bool) else 0

    def rank(v):
        return 2 if isinstance(v, bool) else 1 if isinstance(v, str) else 0
    ra, rb = rank(a), rank(b)
    if ra != rb:
        return -1 if ra < rb else 1
    if ra == 1:
        a, b = a.casefold(), b.casefold()
    return (a > b) - (a < b)


def _round(x, digits: int):
    """Half away from zero, as a spreadsheet rounds (ROUND(2.675, 2) is 2.68; Python's round gives 2.67)."""
    if digits > 15:
        return x
    try:
        result = Decimal(repr(float(x))).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return x
    return float(result)


def _evaluate(book: dict) -> _Book:
    return _Book(book)


def _grid(book: dict, evaluated: _Book, si: int) -> list:
    """A sheet's data rows as their values: formulas as what they computed, dates as ISO text."""
    s = book["sheets"][si]
    out = []
    for r, row in enumerate(s["rows"], 2):
        line = []
        for c, v in enumerate(row):
            kind = s["columns"][c]["type"]
            if (si, r, c) in evaluated.asts:
                v = _clean_number(evaluated.memo.get((si, r, c), evaluated.cell(si, r, c)))
                if kind == "date" and not isinstance(v, (bool, CellError)) and isinstance(v, (int, float)):
                    v = _iso(v) or v
            elif isinstance(v, str) and v.startswith("'="):
                v = v[1:]
            line.append(v)
        out.append(line)
    return out


def compute(sheet) -> list[dict]:
    """The values every cell shows: [{"name", "columns": [names], "rows": [[value, …]]}], one a sheet, data rows
    only (row 2 on). A formula's cell holds what it computed (a number, text, TRUE/FALSE, or a CellError such as
    "#DIV/0!"); a date column's dates are ISO text."""
    book = normalize(sheet)
    evaluated = _evaluate(book)
    return [{"name": s["name"], "columns": [c["name"] for c in s["columns"]], "rows": _grid(book, evaluated, si)}
            for si, s in enumerate(book["sheets"])]


def problems(sheet, *, limit: int = 20) -> list[str]:
    """Why each cell that shows an error shows it, where the error starts (the cells that only pass it on are
    counted with it), in the words the model reads: "Budget!D7 shows #DIV/0!: it divides by zero …"."""
    book = normalize(sheet)
    evaluated = _evaluate(book)
    origins: dict = {}
    for key, value in evaluated.memo.items():
        if isinstance(value, CellError):
            where = value.cell or evaluated.name(key)
            entry = origins.setdefault(where, [value, 0])
            if evaluated.name(key) != where:
                entry[1] += 1
    out = []
    for where, (value, passed) in list(origins.items())[:limit]:
        text = f"{where} shows {value}" + (f": {value.why}" if value.why else "")
        if passed:
            text += f". {passed} other cell{'s' if passed != 1 else ''} show{'' if passed != 1 else 's'} it because " \
                    "they use it"
        out.append(text + ".")
    if len(origins) > limit:
        out.append(f"… and {len(origins) - limit} more.")
    return out


# =========================================================================== how a value reads

def _places(value) -> int:
    text = f"{abs(value):.10f}".rstrip("0")
    return len(text.split(".")[1]) if "." in text else 0


def _decimals(col: dict, values) -> int:
    """How many places a column shows: its own "decimals", or what its numbers need (number: up to 2; currency: 0
    or 2; percent: 0 or 1, of the percentage)."""
    if "decimals" in col:
        return col["decimals"]
    kind = col["type"]
    numbers = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if kind == "percent":
        return 0 if all(_places(v * 100) == 0 for v in numbers) else 1
    if kind == "currency":
        return 0 if all(_places(v) == 0 for v in numbers) else 2
    if kind == "number":
        return min(2, max((_places(v) for v in numbers), default=0))
    return 0


def _grouped(value, places: int) -> str:
    text = f"{abs(value):,.{places}f}"
    negative = value < 0 and text.strip("0.,") != ""
    return ("-" if negative else "") + text


def _date_text(iso: str) -> str:
    m = _DATE.match(iso)
    if not m:
        return iso
    text = f"{int(m.group(3))} {_MONTHS[int(m.group(2)) - 1]} {m.group(1)}"
    if m.group(4) is not None:
        text += f", {m.group(4)}:{m.group(5)}"
    return text


def display(value, col: dict, places: int = 0) -> str:
    """A value as its cell shows it: ₹45,000 · 15% · 28 Oct 2026 · TRUE · #DIV/0!."""
    if value is None:
        return ""
    if isinstance(value, CellError):
        return str(value)
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    kind = col["type"]
    if isinstance(value, (int, float)):
        if kind == "currency":
            symbol = col.get("currency", DEFAULT_CURRENCY)
            text = _grouped(value, places)
            sign, digits = ("-", text[1:]) if text.startswith("-") else ("", text)
            return sign + (symbol + digits if len(symbol) == 1 else f"{symbol} {digits}")
        if kind == "percent":
            return _grouped(value * 100, places) + "%"
        if kind == "date":
            iso = _iso(value)
            return _date_text(iso) if iso else _num_text(value)
        if kind == "number":
            return _grouped(value, places)
        return _num_text(value)
    if kind == "date" and isinstance(value, str):
        return _date_text(value)
    return str(value)


def _column_places(book: dict, grids: list) -> list:
    return [[_decimals(col, [row[c] for row in grid]) for c, col in enumerate(s["columns"])]
            for s, grid in zip(book["sheets"], grids)]


# =========================================================================== edits

def _find_sheet(sheets: list, value, label: str) -> int:
    if value is None:
        if len(sheets) == 1:
            return 0
        names = ", ".join(f"“{s['name']}”" for s in sheets)
        raise SheetError(f'{label} needs "sheet": which sheet, by its name ({names}).')
    if isinstance(value, int) and not isinstance(value, bool):
        if 1 <= value <= len(sheets):
            return value - 1
    elif isinstance(value, str):
        for i, s in enumerate(sheets):
            if s["name"].casefold() == value.strip().casefold():
                return i
    names = ", ".join(f"“{s['name']}”" for s in sheets)
    raise SheetError(f"{label}: there's no sheet “{str(value)[:40]}”; the sheets are {names}.")


def _find_column(sheet: dict, value, label: str, *, end: bool = False) -> int:
    columns = sheet["columns"]
    top = len(columns) + (1 if end else 0)
    if isinstance(value, str) and _COLUMN.match(value.strip()):
        c = column_index(value.strip())
        if c < top:
            return c
    if isinstance(value, str):
        for i, col in enumerate(columns):
            if col["name"].casefold() == value.strip().casefold():
                return i
    span = f"A to {letters(top - 1)}"
    raise SheetError(f"{label}: there's no column “{str(value)[:40]}” in {sheet['name']}; give a column letter "
                     f"({span}) or a column's name.")


def _row_number(sheet: dict, value, label: str, key: str, *, end: bool = False) -> int:
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    top = len(sheet["rows"]) + 1 + (1 if end else 0)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SheetError(f'{label} needs "{key}": a row number from 2 to {top} (row 1 is the column names).')
    if value == 1:
        raise SheetError(f"{label}: row 1 is the column names; data rows start at row 2.")
    if not 2 <= value <= top:
        raise SheetError(f"{label}: there's no row {value} in {sheet['name']}; its rows are 2 to "
                         f"{len(sheet['rows']) + 1}" + (f" (insert at 2 to {top})." if end else "."))
    return value


def _count(value, label: str, default: int = 1, most: int = 10_000) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= most:
        raise SheetError(f"{label}: count is a whole number from 1 to {most:,}.")
    return value


def _each_formula(sheets: list, fn) -> None:
    """Pass every formula in the workbook through fn(formula_text, sheet_index, row, col) -> new formula text."""
    for si, s in enumerate(sheets):
        for r, row in enumerate(s["rows"], 2):
            for c, v in enumerate(row):
                if _is_formula(v):
                    try:
                        row[c] = "=" + fn(v[1:], si, r, c)
                    except _Bad:
                        continue


def _aimed_at(ref: _Ref, own: str, target: str) -> bool:
    return (ref.sheet if ref.sheet is not None else own).casefold() == target.casefold()


def _shift(ref: _Ref, dr: int, dc: int) -> _Ref | None:
    """A reference copied dr rows and dc columns away: its relative parts move, its $ parts stay."""
    c1 = ref.c1 if ref.ac1 else ref.c1 + dc
    c2 = ref.c2 if ref.ac2 else ref.c2 + dc
    r1 = ref.r1 if ref.whole or ref.ar1 else ref.r1 + dr
    r2 = ref.r2 if ref.whole or ref.ar2 else ref.r2 + dr
    if min(c1, c2) < 0 or max(c1, c2) >= _MAX_COL:
        return None
    if not ref.whole and (min(r1, r2) < 1 or max(r1, r2) > _MAX_ROW):
        return None
    if ref.single:
        return dataclasses.replace(ref, c1=c1, c2=c1, r1=r1, r2=r1)
    lo_c, hi_c = sorted((c1, c2))
    if ref.whole:
        return dataclasses.replace(ref, c1=lo_c, c2=hi_c)
    lo_r, hi_r = sorted((r1, r2))
    return dataclasses.replace(ref, c1=lo_c, c2=hi_c, r1=lo_r, r2=hi_r)


def _fill(formula_value: str, dr: int, dc: int) -> str:
    return "=" + _rewrite(formula_value[1:], lambda ref: _shift(ref, dr, dc))


def _insert_lines(sheets, si: int, at: int, n: int, *, rows: bool) -> None:
    """Move every reference to the sheet for n rows (or columns) inserted at ``at``; a range that ends right above
    them, read by a formula below them, takes them in (a row added above a total is counted in it)."""
    target = sheets[si]["name"]

    def fn(formula, fsi, fr, fc):
        own = sheets[fsi]["name"]
        below = fsi == si and (fr >= at if rows else fc >= at)

        def change(ref):
            if not _aimed_at(ref, own, target):
                return ref
            if rows:
                if ref.whole:
                    return ref
                r1 = ref.r1 + n if ref.r1 >= at else ref.r1
                r2 = ref.r2 + n if ref.r2 >= at else ref.r2
                if below and not ref.single and ref.r2 == at - 1 and (ref.r2 > ref.r1 or ref.c1 == ref.c2):
                    r2 = ref.r2 + n
                return dataclasses.replace(ref, r1=r1, r2=r1 if ref.single else r2)
            c1 = ref.c1 + n if ref.c1 >= at else ref.c1
            c2 = ref.c2 + n if ref.c2 >= at else ref.c2
            if below and not ref.single and ref.c2 == at - 1 and not ref.whole and ref.r1 == ref.r2 \
                    and ref.c2 > ref.c1:
                c2 = ref.c2 + n
            return dataclasses.replace(ref, c1=c1, c2=c1 if ref.single else c2)
        return _rewrite(formula, change)
    _each_formula(sheets, fn)


def _delete_lines(sheets, si: int, at: int, n: int, *, rows: bool) -> None:
    """Move every reference to the sheet for n rows (or columns) deleted from ``at``: one to a deleted cell becomes
    #REF!, a range loses what was deleted (and is #REF! when nothing of it is left)."""
    target, end = sheets[si]["name"], at + n - 1

    def keep(lo, hi):
        if at <= lo and hi <= end:
            return None
        new_lo = lo if lo < at else (end + 1 if lo <= end else lo)
        new_hi = hi if hi > end else (at - 1 if hi >= at else hi)
        moved = [(v - n if v > end else v) for v in (new_lo, new_hi)]
        return moved

    def fn(formula, fsi, fr, fc):
        own = sheets[fsi]["name"]

        def change(ref):
            if not _aimed_at(ref, own, target):
                return ref
            if rows:
                if ref.whole:
                    return ref
                span = keep(ref.r1, ref.r2)
                if span is None:
                    return None
                return dataclasses.replace(ref, r1=span[0], r2=span[1])
            span = keep(ref.c1, ref.c2)
            if span is None:
                return None
            return dataclasses.replace(ref, c1=span[0], c2=span[1])
        return _rewrite(formula, change)
    _each_formula(sheets, fn)


def _sort_value(v):
    if v is None or v == "":
        return None
    if isinstance(v, CellError):
        return (3, "")
    if isinstance(v, bool):
        return (2, int(v))
    if isinstance(v, (int, float)):
        return (0, v)
    return (1, str(v).casefold())


def apply_edits(sheet, edits) -> dict:
    """The workbook after ``edits``, in order; each edit sees the workbook as the ones before it left it. Cells
    are A1 addresses (row 1 is the column names; data starts at row 2), rows are row numbers and columns are
    letters or names. Nothing changes unless every edit applies: an error names the edit and what to change.

    - {"op": "set", "sheet": "Budget", "cell": "B4", "value": 1200}: one cell ("value": null empties it; row 1
      renames the column). "values": [[…], […]] writes a block starting there. "range": "D2:D9" with one "value"
      fills it, a formula moving as it would when filled down ("=B2*C2" becomes "=B3*C3" in D3); with "values" it
      must be the range's shape.
    - {"op": "insert_rows", "row": 5, "rows": [[…]]} (or "count"): new rows from row 5 down; {"op": "delete_rows",
      "row": 5, "count": 2}.
    - {"op": "insert_columns", "column": "C", "columns": [{"name": "Notes", "type": "text"}]}; {"op":
      "delete_columns", "column": "C", "count": 1}.
    - {"op": "set_column", "column": "C", "name": …, "type": …, "currency": …, "decimals": …}.
    - {"op": "add_sheet", "name": …, "columns": […], "rows": […], "at": 2}; {"op": "rename_sheet", "sheet": …,
      "name": …}; {"op": "delete_sheet", "sheet": …}.
    - {"op": "sort", "column": "B", "descending": true, "rows": "2:9"}: rows (all data rows unless given) by a
      column's values; a formula in a sorted row moves with its row.
    - {"op": "freeze", "rows": 1}: how many rows at the top stay in view.
    """
    book = normalize(sheet)
    if isinstance(edits, dict):
        edits = [edits]
    if not isinstance(edits, list) or not edits:
        raise SheetError('Give the edits as a list: [{"op": "set", "sheet": "Budget", "cell": "B4", "value": 1200}]. '
                         f'The ops are {", ".join(EDIT_OPS)}.')
    if len(edits) > MAX_EDITS:
        raise SheetError(f"That's {len(edits)} edits; make at most {MAX_EDITS} at once, or set a range.")
    sheets = copy.deepcopy(book["sheets"])
    allowed = {"set": ("sheet", "cell", "range", "value", "values"),
               "insert_rows": ("sheet", "row", "count", "rows"), "delete_rows": ("sheet", "row", "count"),
               "insert_columns": ("sheet", "column", "count", "columns"),
               "delete_columns": ("sheet", "column", "count"),
               "set_column": ("sheet", "column", "name", "type", "currency", "decimals"),
               "add_sheet": ("name", "columns", "rows", "frozen", "at"), "rename_sheet": ("sheet", "name"),
               "delete_sheet": ("sheet",), "sort": ("sheet", "column", "descending", "rows"),
               "freeze": ("sheet", "rows")}
    for i, edit in enumerate(edits, 1):
        if not isinstance(edit, dict):
            raise SheetError(f'Edit {i} should be an object like {{"op": "set", "cell": "B4", "value": 1200}}.')
        op = str(edit.get("op") or "").strip().lower()
        label = f"Edit {i} ({op})" if op else f"Edit {i}"
        if op not in allowed:
            raise SheetError(f'Edit {i}\'s op is one of {", ".join(EDIT_OPS)}; "{op[:20]}" isn\'t.')
        for key in edit:
            if key != "op" and key not in allowed[op]:
                fields = ", ".join(f'"{k}"' for k in allowed[op])
                raise SheetError(f'{label} has "{str(key)[:20]}"; a {op} edit has {fields}.')
        try:
            _apply(sheets, op, edit, label)
        except SheetError as error:
            text = str(error)
            raise SheetError(text if text.startswith(label) else f"{label}: {text}") from None
    try:
        return normalize({"sheets": sheets})
    except SheetError as error:
        raise SheetError(f"After the edits, {error}") from None


def _check_formula(value, label: str):
    if _is_formula(value):
        try:
            _ast(value[1:])
        except _Bad as error:
            raise SheetError(f"{label}: the formula {value[:80]} can't be read: {error}.") from None
    return value


def _apply(sheets: list, op: str, edit: dict, label: str) -> None:
    if op == "add_sheet":
        if len(sheets) >= MAX_SHEETS:
            raise SheetError(f"the spreadsheet already has {MAX_SHEETS} sheets, the most it holds.")
        used = {s["name"].casefold() for s in sheets}
        raw = {k: edit[k] for k in ("name", "columns", "rows", "frozen") if k in edit}
        if not raw.get("name"):
            raise SheetError('give the new sheet a "name".')
        new = _sheet(raw, len(sheets) + 1, used)
        at = edit.get("at", len(sheets) + 1)
        if isinstance(at, bool) or not isinstance(at, int) or not 1 <= at <= len(sheets) + 1:
            raise SheetError(f"at is where the new sheet goes: 1 to {len(sheets) + 1}.")
        sheets.insert(at - 1, new)
        return
    si = _find_sheet(sheets, edit.get("sheet"), label)
    s = sheets[si]
    if op == "rename_sheet":
        used = {x["name"].casefold() for j, x in enumerate(sheets) if j != si}
        new = _sheet_name(edit.get("name"), si + 1, used) if edit.get("name") else None
        if not new:
            raise SheetError('give the sheet its new "name".')
        old = s["name"]

        def fn(formula, fsi, fr, fc):
            own = sheets[fsi]["name"]
            return _rewrite(formula, lambda ref: dataclasses.replace(ref, sheet=new)
                            if ref.sheet is not None and ref.sheet.casefold() == old.casefold() else ref)
        _each_formula(sheets, fn)
        s["name"] = new
        return
    if op == "delete_sheet":
        if len(sheets) == 1:
            raise SheetError("that's the only sheet; a spreadsheet keeps at least one.")
        gone = s["name"]
        del sheets[si]

        def fn(formula, fsi, fr, fc):
            return _rewrite(formula, lambda ref: None if ref.sheet is not None
                            and ref.sheet.casefold() == gone.casefold() else ref)
        _each_formula(sheets, fn)
        return
    if op == "freeze":
        rows = edit.get("rows")
        if isinstance(rows, bool) or not isinstance(rows, int) or not 0 <= rows <= MAX_FROZEN:
            raise SheetError(f"rows is how many rows at the top stay in view: 0 to {MAX_FROZEN}.")
        s["frozen"] = rows
        return
    width = len(s["columns"])
    if op == "set":
        _set(s, edit, label)
        return
    if op == "insert_rows":
        at = _row_number(s, edit.get("row"), label, "row", end=True)
        new_rows = edit.get("rows")
        if new_rows is not None:
            if not isinstance(new_rows, list) or not new_rows or not all(isinstance(r, list) for r in new_rows):
                raise SheetError('rows is a list of rows, each a list of cells: "rows": [["Utilities", 4200]].')
            if edit.get("count") is not None and edit["count"] != len(new_rows):
                raise SheetError(f"count is {edit['count']} but rows has {len(new_rows)}; give one of them.")
            for k, row in enumerate(new_rows):
                if len(row) > width:
                    raise SheetError(f"new row {k + 1} has {len(row)} cells but {s['name']} has {width} columns.")
                for v in row:
                    _check_formula(v, label)
            n = len(new_rows)
        else:
            n = _count(edit.get("count"), label)
            new_rows = [[] for _ in range(n)]
        _insert_lines(sheets, si, at, n, rows=True)
        s["rows"][at - 2:at - 2] = [list(r) + [None] * (width - len(r)) for r in new_rows]
        return
    if op == "delete_rows":
        at = _row_number(s, edit.get("row"), label, "row")
        n = _count(edit.get("count"), label)
        last = len(s["rows"]) + 1
        if at + n - 1 > last:
            raise SheetError(f"{s['name']} has rows 2 to {last}; deleting {n} from row {at} goes past the end.")
        _delete_lines(sheets, si, at, n, rows=True)
        del s["rows"][at - 2:at - 2 + n]
        return
    if op == "insert_columns":
        at = _find_column(s, edit.get("column", letters(width)), label, end=True)
        new_cols = edit.get("columns")
        if new_cols is not None:
            if not isinstance(new_cols, list) or not new_cols:
                raise SheetError('columns is a list: "columns": [{"name": "Notes", "type": "text"}].')
            n = len(new_cols)
        else:
            n = _count(edit.get("count"), label, most=MAX_COLUMNS)
            new_cols = [{"name": f"Column {letters(width + k)}", "type": "text"} for k in range(n)]
        if width + n > MAX_COLUMNS:
            raise SheetError(f"{s['name']} would have {width + n} columns; a sheet holds at most {MAX_COLUMNS}.")
        specs = [_column_spec(c, at + k, s["name"], []) for k, c in enumerate(new_cols)]
        _insert_lines(sheets, si, at, n, rows=False)
        s["columns"][at:at] = specs
        for row in s["rows"]:
            row[at:at] = [None] * n
        return
    if op == "delete_columns":
        at = _find_column(s, edit.get("column"), label)
        n = _count(edit.get("count"), label, most=MAX_COLUMNS)
        if at + n > width:
            raise SheetError(f"{s['name']} has columns A to {letters(width - 1)}; deleting {n} from "
                             f"{letters(at)} goes past the end.")
        if n == width:
            raise SheetError(f"that's every column of {s['name']}; a sheet keeps at least one (delete the sheet "
                             "instead).")
        _delete_lines(sheets, si, at, n, rows=False)
        del s["columns"][at:at + n]
        for row in s["rows"]:
            del row[at:at + n]
        return
    if op == "set_column":
        c = _find_column(s, edit.get("column"), label)
        col = dict(s["columns"][c])
        for key in ("name", "type", "currency", "decimals"):
            if key in edit:
                if edit[key] is None:
                    col.pop(key, None)
                else:
                    col[key] = edit[key]
        if col.get("type") != "currency" and "type" in edit:
            col.pop("currency", None)
        if col.get("type") not in ("number", "currency", "percent"):
            col.pop("decimals", None)
        s["columns"][c] = col
        return
    # sort
    c = _find_column(s, edit.get("column"), label)
    first, last = 2, len(s["rows"]) + 1
    if edit.get("rows") is not None:
        m = re.fullmatch(r"\s*(\d+)\s*:\s*(\d+)\s*", str(edit["rows"]))
        if not m:
            raise SheetError('rows is the rows to sort, like "2:9".')
        first, last = sorted((int(m.group(1)), int(m.group(2))))
        if first < 2 or last > len(s["rows"]) + 1:
            raise SheetError(f"{s['name']}'s data rows are 2 to {len(s['rows']) + 1}; rows {first}:{last} goes past "
                             "them.")
    if last <= first:
        return
    tangled, pinned = None, set()        # a formula reading other rows being sorted; the rows that can't move
    for r in range(first, last + 1):
        for k, v in enumerate(s["rows"][r - 2]):
            if not _is_formula(v):
                continue
            for ref in _refs(_ast(v[1:])):
                if not _aimed_at(ref, s["name"], s["name"]) or ref.whole:
                    continue
                if ref.r1 <= last and ref.r2 >= first and not (ref.r1 == ref.r2 == r):
                    tangled = tangled or (_address(r, k), v)
                    if ref.r1 == ref.r2:
                        pinned.add(ref.r1)          # a single row others point at (a total)
                    else:
                        pinned.add(r)               # a row whose formula reads a block of rows (a total)
    if tangled:
        top = min(pinned) - 1 if pinned else first
        hint = (f' Sort only the rows above it, like "rows": "{first}:{top}".' if top > first else
                ' Give "rows" for just the rows to sort, leaving out the totals.')
        raise SheetError(f"{tangled[0]}'s formula {tangled[1][:60]} reads other rows being sorted, so sorting would "
                         f"scramble it.{hint}")
    desc = edit.get("descending", False)
    if not isinstance(desc, bool):
        raise SheetError("descending is true or false.")
    try:
        current = normalize({"sheets": sheets})
    except SheetError as error:
        raise SheetError(f"the sheet has to be valid to sort it: {error}") from None
    values = _grid(current, _evaluate(current), si)
    order = list(range(first, last + 1))
    filled = [r for r in order if _sort_value(values[r - 2][c]) is not None]
    empty = [r for r in order if _sort_value(values[r - 2][c]) is None]
    filled.sort(key=lambda r: _sort_value(values[r - 2][c]), reverse=desc)
    new_order = filled + empty
    moved = []
    for new_r, old_r in zip(order, new_order):
        row = list(s["rows"][old_r - 2])
        if new_r != old_r:
            row = [_fill(v, new_r - old_r, 0) if _is_formula(v) else v for v in row]
        moved.append(row)
    s["rows"][first - 2:last - 1] = moved


def _set(s: dict, edit: dict, label: str) -> None:
    width = len(s["columns"])
    has_value, has_values = "value" in edit, "values" in edit
    if has_value == has_values:
        raise SheetError('give "value" (one value) or "values" (rows of values), not both and not neither.')
    if (edit.get("cell") is None) == (edit.get("range") is None):
        raise SheetError('give "cell" (like "B4") or "range" (like "B2:C9").')
    if edit.get("cell") is not None:
        m = _CELL.match(str(edit["cell"]).strip())
        if not m:
            raise SheetError(f'cell is an address like "B4"; “{str(edit["cell"])[:20]}” isn\'t one.')
        c1, r1 = column_index(m.group(1)), int(m.group(2))
        if has_value:
            block = [[edit["value"]]]
        else:
            block = edit["values"]
            if not isinstance(block, list) or not block or not all(isinstance(r, list) for r in block):
                raise SheetError('values is a list of rows, each a list of values: "values": [[1200, 900]].')
        r2, c2 = r1 + len(block) - 1, c1 + max(len(r) for r in block) - 1
        fill = None
    else:
        ref = _parse_ref(str(edit["range"]).strip())
        if ref is None or ref.sheet is not None or ref.whole:
            raise SheetError(f'range is like "B2:C9" (on this sheet); “{str(edit["range"])[:20]}” isn\'t one.')
        c1, r1, c2, r2 = ref.c1, ref.r1, ref.c2, ref.r2
        if has_value:
            fill = edit["value"]
            block = None
        else:
            block, fill = edit["values"], None
            if not isinstance(block, list) or not all(isinstance(r, list) for r in block) \
                    or len(block) != r2 - r1 + 1 or any(len(r) != c2 - c1 + 1 for r in block):
                raise SheetError(f"{edit['range']} is {r2 - r1 + 1} row{'s' if r2 != r1 else ''} by {c2 - c1 + 1} "
                                 f"column{'s' if c2 != c1 else ''}; values must be that shape (or give one value "
                                 "to fill it).")
    if c2 >= width:
        raise SheetError(f"{s['name']} has columns A to {letters(width - 1)}; {letters(c2)} isn't one of them. "
                         "Insert a column first (insert_columns).")
    if (r2 - r1 + 1) * (c2 - c1 + 1) > MAX_CELLS:
        raise SheetError(f"that's more than {MAX_CELLS:,} cells.")
    if r2 - 1 > len(s["rows"]):
        if (r2 - 1) * width > MAX_CELLS:
            raise SheetError(f"row {r2} is past what a sheet holds ({MAX_CELLS:,} cells).")
        s["rows"].extend([None] * width for _ in range(r2 - 1 - len(s["rows"])))
    for r in range(r1, r2 + 1):
        for c in range(c1, c2 + 1):
            if block is not None:
                row = block[r - r1]
                if c - c1 >= len(row):
                    continue
                value = row[c - c1]
            else:
                value = fill
                if _is_formula(value) and (r, c) != (r1, c1):
                    _check_formula(value, label)
                    value = _fill(value, r - r1, c - c1)
            _check_formula(value, label)
            if r == 1:
                if not isinstance(value, str) or not value.strip() or _is_formula(value):
                    raise SheetError(f"row 1 is the column names; {_address(1, c)} takes a name (text), so give the "
                                     "column a name, or set_column.")
                s["columns"][c] = {**s["columns"][c], "name": value}
                continue
            s["rows"][r - 2][c] = value


# =========================================================================== the page

_PAGE_CSS = """
:root{color-scheme:light;--bg:#f6f6f4;--surface:#fcfcfb;--ink:#141413;--ink2:#52514e;--muted:#6b6a66;
--line:#e4e3de;--head:#f1f1ee;--head-line:#cfcec7;--accent:#2a78d6;--sel:#2a78d61f;--err:#b42318;--err-bg:#fdeceb;
--on:#2a78d6;--off:#c3c2b7;--shadow:0 1px 2px rgb(11 11 11/.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#111110;--surface:#1a1a19;
--ink:#f0efec;--ink2:#c3c2b7;--muted:#9c9a92;--line:#2c2c2a;--head:#222220;--head-line:#45443f;--accent:#3987e5;
--sel:#3987e533;--err:#ff8d85;--err-bg:#3b1f1d;--on:#3987e5;--off:#5c5b56;--shadow:none}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#111110;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9c9a92;
--line:#2c2c2a;--head:#222220;--head-line:#45443f;--accent:#3987e5;--sel:#3987e533;--err:#ff8d85;--err-bg:#3b1f1d;
--on:#3987e5;--off:#5c5b56;--shadow:none}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,
"Helvetica Neue",Arial,"Noto Sans",sans-serif;-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:18px 20px 10px;flex-wrap:wrap}
h1{font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0}
.meta{color:var(--muted);font-size:12px}
.tabs{display:none;gap:4px;padding:0 16px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.js .tabs{display:flex}
.tab{appearance:none;border:0;background:none;margin:0;padding:8px 10px 9px;font:inherit;font-weight:500;
color:var(--ink2);border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;border-radius:4px 4px 0 0}
.tab:hover{color:var(--ink);background:var(--head)}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.tab .k{color:var(--muted);font-weight:400;margin-left:6px;font-variant-numeric:tabular-nums}
.fx{display:none;align-items:center;gap:0;margin:12px 16px 0;height:30px;border:1px solid var(--line);
border-radius:6px;background:var(--surface);font:12px/1 ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
overflow:hidden}
.js .fx{display:flex}
.fx .ad{flex:none;min-width:64px;padding:0 10px;height:100%;display:flex;align-items:center;color:var(--ink2);
font-weight:600;border-right:1px solid var(--line);background:var(--head)}
.fx .fn{flex:none;padding:0 8px 0 10px;color:var(--muted);font-style:italic}
.fx .f{flex:1;min-width:0;white-space:pre;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.fx .f:empty::before{content:attr(data-hint);color:var(--muted);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.pane{padding:12px 16px 18px}
.pane>h2{font-size:13px;font-weight:600;margin:6px 2px 8px;color:var(--ink2)}
.js .pane>h2{display:none}
.sc{overflow:auto;max-height:calc(100vh - 150px);background:var(--surface);border:1px solid var(--line);
border-radius:8px;box-shadow:var(--shadow)}
.js .pane[hidden]{display:none}
table.g{border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums;min-width:100%}
.g th,.g td{height:30px;padding:0 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);
white-space:nowrap;text-align:left;max-width:30em;overflow:hidden;text-overflow:ellipsis}
.g thead th{position:sticky;background:var(--head);z-index:2}
.g .lt th{top:0;height:22px;font-size:10.5px;font-weight:500;color:var(--muted);text-align:center;letter-spacing:.04em}
.g .nm th{top:22px;font-weight:600;color:var(--ink);border-bottom:1px solid var(--head-line)}
.g .nm th.n{text-align:right}
.g .nm th.c{text-align:center}
.g td,.g .nm th:not(.rn):not(.pad){min-width:92px}
.g .pad{width:100%;padding:0;border-right:0;background:transparent}
.g thead .pad{background:var(--head)}
.g .rn{position:sticky;left:0;z-index:1;background:var(--head);color:var(--muted);font-size:11px;font-weight:500;
text-align:right;padding:0 8px;min-width:40px;width:40px}
.g thead .rn{z-index:3}
.g td{color:var(--ink)}
.g td.n{text-align:right}
.g td.c{text-align:center}
.g td.e{color:var(--err);background:var(--err-bg);font-weight:600;font-size:12px}
.g td.t{color:var(--ink)}
.g tbody tr:hover td{background:color-mix(in srgb,var(--sel) 45%,transparent)}
.g td.on{outline:2px solid var(--accent);outline-offset:-2px;background:var(--sel)}
.g .ck{display:inline-block;width:14px;height:14px;border-radius:4px;border:1.5px solid var(--off);vertical-align:-2px}
.g .ck.y{background:var(--on);border-color:var(--on);position:relative}
.g .ck.y::after{content:"";position:absolute;left:3.5px;top:0.5px;width:4px;height:8px;border:solid #fff;
border-width:0 2px 2px 0;transform:rotate(45deg)}
.st{display:flex;gap:14px;padding:8px 4px 0;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
@media (max-width:640px){.top{padding:14px 16px 8px}.pane{padding:10px 12px 14px}.fx{margin:10px 12px 0}
.sc{max-height:calc(100vh - 140px)}}
@media print{.tabs,.fx{display:none!important}.pane[hidden]{display:block!important}.sc{max-height:none;overflow:visible}}
"""

_PAGE_JS = """(function(){
var root=document.documentElement;root.classList.add('js');
var tabs=[].slice.call(document.querySelectorAll('.tab')),panes=[].slice.call(document.querySelectorAll('.pane'));
var ad=document.querySelector('.fx .ad'),fx=document.querySelector('.fx .f'),cur=null;
function col(n){var s='';n+=1;while(n>0){var m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;}
function pick(td){if(cur){cur.classList.remove('on');}cur=td||null;
if(!cur){ad.textContent='';fx.textContent='';return;}
cur.classList.add('on');var tr=cur.parentElement;
ad.textContent=col(cur.cellIndex-1)+tr.firstElementChild.textContent;
fx.textContent=cur.getAttribute('data-f')||cur.getAttribute('data-v')||cur.textContent;}
function show(i){tabs.forEach(function(t,k){var on=k===i;t.setAttribute('aria-selected',on?'true':'false');
t.tabIndex=on?0:-1;});panes.forEach(function(p,k){p.hidden=k!==i;});pick(null);}
tabs.forEach(function(t,i){t.addEventListener('click',function(){show(i);});
t.addEventListener('keydown',function(e){var k=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;
if(k){e.preventDefault();var j=(i+k+tabs.length)%tabs.length;show(j);tabs[j].focus();}});});
document.addEventListener('click',function(e){var td=e.target.closest&&e.target.closest('tbody td');
if(td){pick(td);}});
document.addEventListener('keydown',function(e){if(!cur||e.altKey||e.ctrlKey||e.metaKey){return;}
var tr=cur.parentElement,i=cur.cellIndex,n=null;
if(e.key==='ArrowRight'){n=cur.nextElementSibling;}else if(e.key==='ArrowLeft'){n=cur.previousElementSibling;}
else if(e.key==='ArrowDown'&&tr.nextElementSibling){n=tr.nextElementSibling.cells[i];}
else if(e.key==='ArrowUp'&&tr.previousElementSibling){n=tr.previousElementSibling.cells[i];}
else if(e.key==='Escape'){pick(null);return;}else{return;}
if(n&&n.tagName==='TD'){e.preventDefault();pick(n);n.scrollIntoView({block:'nearest',inline:'nearest'});}});
show(0);})();"""


def render_html(sheet, *, nonce: str | None = None, title: str = "") -> str:
    """The workbook as one read-only page: a tab a sheet, the column names (and any other frozen rows) staying in
    view, numbers right-aligned in their column's format, an error's reason on hover, and a bar that shows a
    clicked cell's address and its formula. It loads nothing from anywhere and declares a policy that says so; its
    one small script carries ``nonce`` (made here when none is given). Without the script every sheet is shown, one
    under another."""
    book = normalize(sheet)
    evaluated = _evaluate(book)
    grids = [_grid(book, evaluated, si) for si in range(len(book["sheets"]))]
    places = _column_places(book, grids)
    nonce = nonce or secrets.token_urlsafe(16)
    if not re.fullmatch(r"[A-Za-z0-9+/=_\-]{8,128}", nonce):
        raise SheetError("nonce is 8 to 128 base64 characters.")
    e = html.escape
    name = title or book["sheets"][0]["name"]
    tabs, panes, rules = [], [], []
    for si, (s, grid) in enumerate(zip(book["sheets"], grids)):
        cols = s["columns"]
        n_formulas = sum(1 for row in s["rows"] for v in row if _is_formula(v))
        tabs.append(f'<button class="tab" role="tab" id="t{si}" aria-controls="p{si}" aria-selected="false" '
                    f'tabindex="-1">{e(s["name"])}<span class="k">{len(s["rows"])}</span></button>')
        numeric = [c["type"] in ("number", "currency", "percent", "date") for c in cols]
        head = ('<tr class="lt"><th class="rn" aria-hidden="true"></th>'
                + "".join(f"<th>{letters(c)}</th>" for c in range(len(cols)))
                + '<th class="pad" aria-hidden="true"></th></tr>'
                + '<tr class="nm"><th class="rn">1</th>'
                + "".join(f'<th scope="col"{" class=n" if numeric[c] else " class=c" if col["type"] == "bool" else ""}>'
                          f'{e(col["name"])}</th>'
                          for c, col in enumerate(cols)) + '<th class="pad" aria-hidden="true"></th></tr>')
        body = []
        for r, (raw_row, row) in enumerate(zip(s["rows"], grid), 2):
            cells = []
            for c, (raw, v) in enumerate(zip(raw_row, row)):
                col = cols[c]
                attrs, classes = [], []
                text = e(display(v, col, places[si][c]))
                if isinstance(v, CellError):
                    classes.append("e")
                    why = getattr(v, "why", "")
                    if why:
                        attrs.append(f'title="{e(why[:1].upper() + why[1:], quote=True)}"')
                elif isinstance(v, bool) and col["type"] == "bool":
                    classes.append("c")
                    text = (f'<span class="ck{" y" if v else ""}" role="img" '
                            f'aria-label="{"Yes" if v else "No"}"></span>')
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    classes.append("n")
                    if text.startswith("-"):
                        text = "\u2212" + text[1:]
                    if col["type"] in ("number", "currency", "percent", "date"):
                        attrs.append(f'data-v="{e(_num_text(v) if col["type"] != "date" else (_iso(v) or ""))}"')
                elif isinstance(v, str) and col["type"] == "date" and v:
                    classes.append("n")
                    attrs.append(f'data-v="{e(v)}"')
                if _is_formula(raw):
                    attrs.append(f'data-f="{e(raw, quote=True)}"')
                cls = f' class="{" ".join(classes)}"' if classes else ""
                cells.append(f"<td{cls}{' ' + ' '.join(attrs) if attrs else ''}>{text}</td>")
            frozen = r <= s["frozen"]
            body.append(f'<tr{f" class=f{r}" if frozen else ""}><th class="rn" scope="row">{r}</th>'
                        + "".join(cells) + '<th class="pad" aria-hidden="true"></th></tr>')
            if frozen:
                top = 22 + 31 * (r - 1)
                rules.append(f"#p{si} tr.f{r}>*{{position:sticky;top:{top}px;z-index:1;background:var(--surface)}}"
                             f"#p{si} tr.f{r}>.rn{{z-index:2;background:var(--head)}}")
        stats = [f"{len(s['rows']):,} row{'s' if len(s['rows']) != 1 else ''}",
                 f"{len(cols)} column{'s' if len(cols) != 1 else ''}"]
        if n_formulas:
            stats.append(f"{n_formulas} formula{'s' if n_formulas != 1 else ''}")
        errors = sum(1 for row in grid for v in row if isinstance(v, CellError))
        if errors:
            stats.append(f"{errors} error{'s' if errors != 1 else ''}")
        panes.append(f'<section class="pane" id="p{si}" role="tabpanel" aria-labelledby="t{si}">'
                     f'<h2>{e(s["name"])}</h2><div class="sc" tabindex="0"><table class="g"><thead>{head}</thead>'
                     f'<tbody>{"".join(body)}</tbody></table></div>'
                     f'<div class="st">{"".join(f"<span>{x}</span>" for x in stats)}</div></section>')
    count = len(book["sheets"])
    meta = (f"{count} sheets" if count > 1 else f"{len(book['sheets'][0]['rows']):,} rows") + " · read-only"
    policy = f"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{nonce}'"
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<meta http-equiv="Content-Security-Policy" content="{policy}">'
            f'<title>{e(name)}</title><style nonce="{nonce}">{_PAGE_CSS}{"".join(rules)}</style></head><body>'
            f'<header class="top"><h1>{e(name)}</h1><span class="meta">{e(meta)}</span></header>'
            f'<nav class="tabs" role="tablist" aria-label="Sheets">{"".join(tabs)}</nav>'
            '<div class="fx" aria-live="polite"><span class="ad"></span><span class="fn">fx</span>'
            '<span class="f" data-hint="Select a cell to see its formula or value"></span></div>'
            f'<main>{"".join(panes)}</main><script nonce="{nonce}">{_PAGE_JS}</script></body></html>')


# =========================================================================== files

def _xlsx_format(col: dict, places: int) -> str:
    kind = col["type"]
    digits = ("." + "0" * places) if places else ""
    if kind == "number":
        return "#,##0" + digits
    if kind == "currency":
        symbol = col.get("currency", DEFAULT_CURRENCY).replace('"', "")
        quoted = f'"{symbol}"' if len(symbol) == 1 else f'"{symbol} "'
        return f"{quoted}#,##0{digits};-{quoted}#,##0{digits}"
    if kind == "percent":
        return "0" + digits + "%"
    if kind == "date":
        return "d mmm yyyy"
    return ""


_XLFN = {"CONCAT"}            # functions newer than the file format, which Excel keeps under _xlfn.


def _excel_formula(formula: str) -> str:
    out = []
    for tok in _tokens(formula):
        out.append(("_xlfn." + tok.text) if tok.kind == "name" and tok.text in _XLFN else tok.text)
    return "".join(out)


def export_xlsx(sheet, *, values: bool = True) -> bytes:
    """The workbook as an Excel file: formulas as formulas (each with the value DGC computed beside it, for readers
    that don't recalculate, unless ``values`` is False; Excel and LibreOffice recompute when they open it), every
    column's number format, dates as dates, TRUE/FALSE as booleans, the frozen rows frozen."""
    book = normalize(sheet)
    evaluated = _evaluate(book)
    grids = [_grid(book, evaluated, si) for si in range(len(book["sheets"]))]
    places = _column_places(book, grids)
    out = []
    for si, (s, grid) in enumerate(zip(book["sheets"], grids)):
        cols = s["columns"]
        fmts = [_xlsx_format(col, places[si][c]) for c, col in enumerate(cols)]
        rows: list = [[col["name"] for col in cols]]
        for r, (raw_row, shown) in enumerate(zip(s["rows"], grid), 2):
            cells = []
            for c, (raw, v) in enumerate(zip(raw_row, shown)):
                col, fmt = cols[c], fmts[c]
                text = display(v, col, places[si][c])
                if _is_formula(raw):
                    cached = evaluated.memo.get((si, r, c)) if values else None
                    cells.append(made.XlsxCell("=" + _excel_formula(raw[1:]), fmt, cached=cached, shown=text))
                elif raw is None:
                    cells.append("")
                elif col["type"] == "date" and isinstance(raw, str):
                    cells.append(made.XlsxCell(_serial(raw), fmt, shown=text))
                elif isinstance(raw, str):
                    cells.append(made.XlsxCell(raw[1:] if raw.startswith("'=") else raw, "", shown=text))
                else:
                    cells.append(made.XlsxCell(raw, fmt, shown=text))
            rows.append(cells)
        out.append({"name": s["name"], "rows": rows, "header": True, "frozen": s["frozen"]})
    return made.xlsx(out)


def _csv_value(value, col: dict) -> str:
    if value is None:
        return ""
    if isinstance(value, CellError):
        return str(value)
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        if col["type"] == "date":
            return _iso(value) or _num_text(value)
        return _num_text(value)
    return str(value)


def export_csv(sheet, name: str | None = None) -> str:
    """One sheet (by name; the first when none is given) as CSV text: the column names, then each cell's plain
    value: numbers without grouping or symbols (1234.5; a percent column's 15% is 0.15), dates as 2026-10-28,
    formulas as what they computed. The caller encodes it (ChatDGC writes UTF-8 with a BOM, so Excel reads ₹)."""
    book = normalize(sheet)
    si = 0 if not name else _find_sheet(book["sheets"], name, "export_csv")
    s = book["sheets"][si]
    grid = _grid(book, _evaluate(book), si)
    rows = [[c["name"] for c in s["columns"]]]
    rows += [[_csv_value(v, s["columns"][c]) for c, v in enumerate(row)] for row in grid]
    return made._csv_text(rows)


def from_table_file(path) -> dict:
    """A workbook from a .csv, .tsv or .xlsx file: its first row as the column names, each column's type from what
    it holds (numbers, ₹ or $ amounts, percentages, ISO dates, TRUE/FALSE, else text; codes like 007 stay text).
    Read with ChatDGC's own readers, so a workbook's formulas come in as the values it last saved."""
    p = Path(path)
    if not tabledata.tabular(p.name):
        raise SheetError(f"{p.name} isn't a table file DGC reads into a sheet: give a .csv, .tsv or .xlsx file.")
    try:
        if p.stat().st_size > MAX_FILE_BYTES:
            raise SheetError(f"{p.name} is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB; a sheet holds at most "
                             f"{MAX_CELLS:,} cells.")
        raw = p.read_bytes()
    except OSError as error:
        raise SheetError(f"{p.name} couldn't be read ({error.strerror or type(error).__name__}).") from None
    try:
        tables = tabledata._xlsx_sheets(raw) if p.suffix.lower() == ".xlsx" else [(p.stem, tabledata._csv_rows(raw,
                                                                                                          p.name))]
    except tabledata.DataError as error:
        raise SheetError(f"{p.name}: {error}") from None
    out, used, cells = [], set(), 0
    for sheet_name, rows in tables:
        rows = [list(r) for r in rows if any(str(c).strip() for c in r)]
        if not rows:
            continue
        width = min(MAX_COLUMNS, max(len(r) for r in rows))
        rows = [r[:width] + [""] * (width - len(r[:width])) for r in rows]
        cells += width * len(rows)
        if cells > MAX_CELLS:
            raise SheetError(f"{p.name} holds more than {MAX_CELLS:,} cells; a sheet holds at most that. Use the data "
                             "as a dashboard source instead, or a smaller file.")
        header, body = rows[0], rows[1:]
        names, seen = [], set()
        for c, h in enumerate(header):
            text = " ".join(_CTRL.sub(" ", _to_text(h) if not isinstance(h, str) else h).split())[:MAX_COLUMN_NAME]
            text = text or f"Column {letters(c)}"
            base, k = text, 2
            while text.casefold() in seen:
                text = f"{base[:MAX_COLUMN_NAME - 4]} {k}"
                k += 1
            seen.add(text.casefold())
            names.append(text)
        columns = []
        for c in range(width):
            kind, symbol = _infer([None if v == "" else v for v in (row[c] for row in body)])
            columns.append({"name": names[c], "type": kind, **({"currency": symbol or DEFAULT_CURRENCY}
                                                                if kind == "currency" else {})})
        data_rows = []
        for row in body:
            line = []
            for c, v in enumerate(row):
                if v == "" or v is None:
                    line.append(None)
                    continue
                kind = columns[c]["type"]
                if kind in ("number", "currency", "percent"):
                    line.append(_clean_number(v) if isinstance(v, (int, float)) else tabledata._number(str(v)))
                elif kind == "bool":
                    line.append(v if isinstance(v, bool) else str(v).strip().upper() == "TRUE")
                elif kind == "date":
                    line.append(str(v).strip())
                else:
                    text = v if isinstance(v, str) else _to_text(v)
                    line.append("'" + text if text.startswith("=") else text)
            data_rows.append(line)
        base = _BAD_SHEET_CHARS.sub(" ", str(sheet_name or "Sheet")).strip(" '")[:MAX_NAME] or "Sheet"
        if base.casefold() == "history":
            base = "History data"
        title, k = base, 2
        while title.casefold() in used:
            title = f"{base[:MAX_NAME - 3]} {k}"
            k += 1
        used.add(title.casefold())
        out.append({"name": title, "columns": columns, "rows": data_rows, "frozen": 1})
    if not out:
        raise SheetError(f"{p.name} has no rows to make a sheet from.")
    return normalize({"sheets": out})


# =========================================================================== what the model reads back

def outline(sheet, *, max_rows: int = 300) -> str:
    """The workbook as the model reads it before editing: each sheet's columns by letter, then each row by its
    number with every cell; a formula shows as itself and what it computes (=B2-C2 → 0); then the problems."""
    book = normalize(sheet)
    evaluated = _evaluate(book)
    lines = [f"{len(book['sheets'])} sheet{'s' if len(book['sheets']) != 1 else ''}. Cells are A1 addresses: row 1 "
             "holds the column names and data starts at row 2."]
    for si, s in enumerate(book["sheets"]):
        grid = _grid(book, evaluated, si)
        places = _column_places({"sheets": [s]}, [grid])[0]
        cols = s["columns"]

        def kind(col):
            extra = f" {col['currency']}" if col["type"] == "currency" else ""
            return col["type"] + extra + (f", {col['decimals']} decimals" if "decimals" in col else "")
        last = len(s["rows"]) + 1
        span = f"rows 2 to {last}" if s["rows"] else "no data rows yet"
        lines.append("")
        lines.append(f"Sheet “{s['name']}” ({span}; columns A to {letters(len(cols) - 1)}; frozen {s['frozen']})")
        lines.append("  " + " | ".join(f"{letters(c)} “{col['name']}” {kind(col)}" for c, col in enumerate(cols)))
        for r, (raw_row, row) in enumerate(zip(s["rows"], grid), 2):
            if r - 1 > max_rows:
                lines.append(f"  … {last - r + 1} more rows (to row {last}).")
                break
            cells = []
            for c, (raw, v) in enumerate(zip(raw_row, row)):
                if raw is None:
                    cells.append("")
                elif _is_formula(raw):
                    cells.append(f"{raw} → {display(v, cols[c], places[c])}")
                elif isinstance(raw, str):
                    text = raw if len(raw) <= 80 else raw[:79] + "…"
                    cells.append(text.replace("|", "/").replace("\n", " "))
                else:
                    cells.append(_to_text(raw))
            lines.append(f"  {r}: " + " | ".join(cells))
    trouble = problems(book)
    if trouble:
        lines.append("")
        lines.append("Problems:")
        lines += [f"- {t}" for t in trouble]
    return "\n".join(lines)
