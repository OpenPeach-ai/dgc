"""Dashboards: number tiles, charts and tables over data the user allowed, refreshed on this computer with no model.

A dashboard is data (an artifact's ``dashboard.json``) the model writes once:

    {"title": "Store sales", "layout": {"columns": 2},
     "sources": [{"id": "shop", "kind": "sqlite", "path": "data/shop.db"}],
     "widgets": [{"id": "revenue", "kind": "number", "title": "Revenue this month", "source": "shop",
                  "query": "SELECT SUM(total) AS revenue FROM orders WHERE …", "value": "revenue", "unit": "₹"},
                 {"id": "by_month", "kind": "chart", "title": "Revenue by month", "source": "shop",
                  "query": "SELECT strftime('%Y-%m', placed) AS month, SUM(total) AS revenue FROM orders GROUP BY 1",
                  "chart": {"type": "bar", "x": "month", "series": ["revenue"], "unit": "₹"}}]}

Sources, all read-only:

- ``file``: a .csv, .tsv or .xlsx file, loaded the way ChatDGC loads one (``dgc.chatdgc.data``) into a SQLite database
  in memory. Its table is named after the file (sales-2026.csv is ``sales_2026``; each sheet of a workbook is
  ``book_sheet``).
- ``sqlite``: a SQLite database file, opened read-only (``mode=ro``, ``query_only``) with an authorizer that allows
  reading and nothing else.
- ``postgres``: the project's read-only database account (``dgc readonly-db set``), through the ``psql`` program:
  CSV out, a statement timeout, ``default_transaction_read_only=on``, the query wrapped as one sub-select.
- ``plugin``: one call to a plugin's tool. This module never calls a plugin itself: the host passes
  ``is_read_only(server, tool)`` and ``call(server, tool, args)``, and a tool that isn't read-only is refused. The
  rows are picked out of the result by a small JSON path ("data.items", "$.result[*].stats").

Every query is one SELECT (or WITH … SELECT), checked before anything runs (``normalize``), and again by the
database itself. The user allows each source once for the dashboard (the host keeps the allowed ids beside it,
never in this data, so the model can't allow a source by writing it); a widget over a source that isn't allowed
doesn't run and says "Allow <source> to show this". ``changed_sources`` names the sources an edit pointed at
something else, whose allowance the host should drop.

- ``refresh``: runs every widget's query on its own (one failing never stops the rest); each result keeps its
  rows (capped), its error and when it ran.
- ``render_html``: the page: number tiles with their change, charts drawn by the Slides module's ``chart_svg`` (so
  a chart looks the same everywhere), tables, each with "Refreshed 09:40" and its exact query. Light and dark,
  nothing loaded from anywhere, no script.
- ``apply_edits``: add, change, remove and move widgets and sources, the layout and the title.
"""
from __future__ import annotations

import copy
import csv
import dataclasses
import html
import io
import itertools
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from . import artifact_slides as slides
from .chatdgc import data as tabledata
from .workspace import WorkspaceBoundaryError, read_regular_bytes

KINDS = ("file", "sqlite", "postgres", "plugin")
WIDGETS = ("chart", "number", "table")
CHART_TYPES = slides.CHART_TYPES
EDIT_OPS = ("add_widget", "change_widget", "remove_widget", "move_widget", "add_source", "change_source",
            "remove_source", "layout", "title")
MAX_SOURCES = 12
MAX_WIDGETS = 30
MAX_ROWS = tabledata.MAX_RESULT_ROWS        # rows a widget keeps from its query
MAX_QUERY = 20_000                          # characters of SQL
MAX_ARGS = 8_000                            # characters of a plugin call's arguments, as JSON
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_CELL = 1_000                            # characters of one value a widget keeps
MAX_COLUMNS = 50
MAX_EDITS = 50
QUERY_SECONDS = tabledata.QUERY_SECONDS
PSQL_SECONDS = 20                           # connecting and the statement timeout, together
MAX_PSQL_OUTPUT_BYTES = 32 * 1024 * 1024  # at most 201 rows, even if one cell is enormous
MAX_PSQL_ERROR_BYTES = 64 * 1024
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-]{0,39}\Z")

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]")
_WRITES = ("INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "INTO", "DROP", "ALTER", "CREATE", "TRUNCATE", "GRANT",
           "REVOKE", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX", "COPY", "CALL", "EXECUTE", "EXEC", "PREPARE",
           "DEALLOCATE", "LOCK", "LISTEN", "NOTIFY", "UNLISTEN", "RESET", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT",
           "RELEASE")
_WRITE = re.compile(r"\b(" + "|".join(_WRITES) + r")\b", re.I)
_SQL_SKIP = re.compile(r"--[^\n]*|/\*.*?(?:\*/|\Z)|'(?:[^']|'')*'?|\"(?:[^\"]|\"\")*\"?|`[^`]*`?|"
                       r"\$([A-Za-z_]*)\$.*?(?:\$\1\$|\Z)", re.S)
_NULL = "\\N"


class DashboardError(ValueError):
    """A dashboard, an edit or a query that can't be used as given; the text says what to change."""


# =========================================================================== checking

def check_query(sql, where: str = "The query") -> str:
    """One read-only SELECT (or WITH … SELECT), or DashboardError saying why not: nothing that changes data, one
    statement, no ATTACH or PRAGMA. The database checks again when it runs (an authorizer, a read-only transaction)."""
    if not isinstance(sql, str) or not sql.strip():
        raise DashboardError(f"{where} needs its SQL: one SELECT, like \"SELECT region, SUM(total) AS total FROM "
                             "orders GROUP BY region\".")
    text = sql.strip()
    while text.endswith(";"):
        text = text[:-1].rstrip()
    if len(text) > MAX_QUERY:
        raise DashboardError(f"{where} is {len(text):,} characters; a widget's query is at most {MAX_QUERY:,}.")
    if ";" in text:
        raise DashboardError(f"{where} has a “;” inside it. A widget runs one SELECT, and a “;” isn't allowed even "
                             "in quotes: match text with LIKE or char(59) instead.")
    body = _SQL_SKIP.sub(" ", text)
    if not re.match(r"\s*\(*\s*(select|with)\b", body, re.I):
        first = (body.split() or ["?"])[0][:20]
        raise DashboardError(f"{where} starts with “{first}”; a widget only reads, with one SELECT (or WITH … "
                             "SELECT).")
    word = _WRITE.search(body)
    if word:
        raise DashboardError(f"{where} has “{word.group(1).upper()}”, which writes or changes the database. A "
                             "widget only reads: one SELECT (or WITH … SELECT). If it's a column's name, put it in "
                             f"double quotes (\"{word.group(1).lower()}\").")
    return text


def _text(value, where: str, limit: int, *, required: bool = False) -> str:
    if value is None or value == "":
        if required:
            raise DashboardError(f"{where} is needed.")
        return ""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise DashboardError(f"{where} should be text.")
    text = " ".join(_CTRL.sub(" ", str(value)).split())
    if len(text) > limit:
        raise DashboardError(f"{where} is {len(text)} characters; keep it to {limit}.")
    return text


def _id(value, where: str) -> str:
    if not isinstance(value, str) or not ID.match(value):
        raise DashboardError(f'{where} needs an "id": letters, numbers, - and _, like "revenue" or "by_month" '
                             f'(up to 40).')
    return value


def _source(raw, n: int, ids: set) -> dict:
    if not isinstance(raw, dict):
        raise DashboardError(f'Source {n} should be {{"id": "shop", "kind": "sqlite", "path": "data/shop.db"}}.')
    sid = _id(raw.get("id"), f"Source {n}")
    where = f"Source “{sid}”"
    if sid in ids:
        raise DashboardError(f"Two sources have the id “{sid}”; each needs its own.")
    ids.add(sid)
    kind = str(raw.get("kind") or "").strip().lower()
    if kind not in KINDS:
        raise DashboardError(f'{where}\'s kind is one of {", ".join(KINDS)}; "{kind[:20]}" isn\'t.')
    fields = {"file": ("path",), "sqlite": ("path",), "postgres": (), "plugin": ("server",)}[kind]
    for key in raw:
        if key in ("id", "kind", "label") or key in fields:
            continue
        if kind == "postgres" and key in ("url", "dsn", "password", "user", "host", "database", "connection"):
            raise DashboardError(f"{where} is the project's read-only Postgres account; its connection is kept "
                                 "with `dgc readonly-db set`, never in the dashboard. Remove \"" + key + "\".")
        raise DashboardError(f'{where} has "{str(key)[:30]}"; a {kind} source has "id", "kind", "label"'
                             + "".join(f', "{f}"' for f in fields) + ".")
    out = {"id": sid, "kind": kind}
    label = _text(raw.get("label"), f"{where}'s label", 60)
    if label:
        out["label"] = label
    if kind in ("file", "sqlite"):
        path = raw.get("path")
        if not isinstance(path, str) or not path.strip() or len(path) > 1000 or _CTRL.search(path):
            raise DashboardError(f'{where} needs "path": the {"table file" if kind == "file" else "database file"}, '
                                 'relative to the project or a full path.')
        path = path.strip()
        if kind == "file" and not tabledata.tabular(path):
            raise DashboardError(f"{where}'s path is a .csv, .tsv or .xlsx file; for a SQLite database use "
                                 '"kind": "sqlite".')
        out["path"] = path
    if kind == "plugin":
        out["server"] = _text(raw.get("server"), f'{where}\'s "server" (the plugin\'s name)', 80, required=True)
    return out


def _chart(raw, where: str) -> dict:
    if not isinstance(raw, dict):
        raise DashboardError(f'{where} needs "chart": {{"type": "bar", "x": "<column>", "series": ["<column>"]}}.')
    allowed = ("type", "x", "series", "unit", "stacked", "horizontal", "x_label", "y_label")
    for key in raw:
        if key not in allowed:
            raise DashboardError(f'{where}\'s chart has "{str(key)[:30]}"; a chart has '
                                 + ", ".join(f'"{k}"' for k in allowed) + ".")
    kind = str(raw.get("type") or "bar").strip().lower()
    if kind not in CHART_TYPES:
        raise DashboardError(f'{where}\'s chart type is one of {", ".join(CHART_TYPES)}; "{kind[:20]}" isn\'t.')
    out: dict = {"type": kind}
    x = _text(raw.get("x"), f"{where}'s chart x", 80)
    if x:
        out["x"] = x
    series = raw.get("series")
    if series is not None:
        if isinstance(series, str):
            series = [series]
        if not isinstance(series, list) or not series:
            raise DashboardError(f'{where}\'s chart series is a list of columns: "series": ["revenue", "cost"].')
        if len(series) > slides.MAX_SERIES:
            raise DashboardError(f"{where}'s chart has {len(series)} series; a chart shows at most "
                                 f"{slides.MAX_SERIES}.")
        items = []
        for k, item in enumerate(series, 1):
            if isinstance(item, dict):
                for key in item:
                    if key not in ("column", "name"):
                        raise DashboardError(f'{where}\'s series {k} is a column name, or {{"column": "…", '
                                             '"name": "…"}.')
                column = _text(item.get("column"), f"{where}'s series {k} column", 80, required=True)
                name = _text(item.get("name"), f"{where}'s series {k} name", 60)
                items.append({"column": column, **({"name": name} if name else {})})
            else:
                items.append(_text(item, f"{where}'s series {k}", 80, required=True))
        out["series"] = items
    unit = _text(raw.get("unit"), f"{where}'s chart unit", 8)
    if unit:
        out["unit"] = unit
    for key in ("x_label", "y_label"):
        label = _text(raw.get(key), f"{where}'s chart {key}", 60)
        if label:
            out[key] = label
    for key in ("stacked", "horizontal"):
        if raw.get(key) not in (None, False, True):
            raise DashboardError(f"{where}'s chart {key} is true or false.")
        if raw.get(key):
            out[key] = True
    return out


def _widget(raw, n: int, ids: set, sources: dict) -> dict:
    if not isinstance(raw, dict):
        raise DashboardError(f'Widget {n} should be {{"id": "…", "kind": "number", "title": "…", "source": "…", '
                             '"query": "SELECT …"}.')
    wid = _id(raw.get("id"), f"Widget {n}")
    where = f"Widget “{wid}”"
    if wid in ids:
        raise DashboardError(f"Two widgets have the id “{wid}”; each needs its own.")
    ids.add(wid)
    kind = str(raw.get("kind") or "").strip().lower()
    if kind not in WIDGETS:
        raise DashboardError(f'{where}\'s kind is one of {", ".join(WIDGETS)}; "{kind[:20]}" isn\'t.')
    extra = {"chart": ("chart",), "number": ("value", "label", "compare", "unit", "better"),
             "table": ("columns",)}[kind]
    for key in raw:
        if key not in ("id", "kind", "title", "source", "query", "span") + extra:
            raise DashboardError(f'{where} has "{str(key)[:30]}"; a {kind} widget has "id", "kind", "title", '
                                 '"source", "query", "span"' + "".join(f', "{k}"' for k in extra) + ".")
    out: dict = {"id": wid, "kind": kind, "title": _text(raw.get("title"), f"{where}'s title", 120, required=True)}
    source = raw.get("source")
    if not isinstance(source, str) or source not in sources:
        if len(sources) == 1 and source in (None, ""):
            source = next(iter(sources))
        else:
            names = ", ".join(f"“{s}”" for s in sources) or "none yet"
            raise DashboardError(f'{where}\'s source is one of the dashboard\'s sources ({names}); '
                                 f'"{str(source)[:40]}" isn\'t. Add the source first.')
    out["source"] = source
    if sources[source]["kind"] == "plugin":
        query = raw.get("query")
        if not isinstance(query, dict):
            raise DashboardError(f'{where} reads a plugin, so its query is a tool call: {{"tool": "list_issues", '
                                 '"args": {"state": "open"}, "path": "items"}.')
        for key in query:
            if key not in ("tool", "args", "path"):
                raise DashboardError(f'{where}\'s query has "{str(key)[:30]}"; a plugin query has "tool", "args" '
                                     'and "path".')
        call = {"tool": _text(query.get("tool"), f"{where}'s tool", 120, required=True)}
        args = query.get("args") or {}
        if not isinstance(args, dict):
            raise DashboardError(f"{where}'s args are an object of the tool's arguments.")
        if len(json.dumps(args, ensure_ascii=False)) > MAX_ARGS:
            raise DashboardError(f"{where}'s args are longer than {MAX_ARGS:,} characters.")
        call["args"] = args
        path = _text(query.get("path"), f"{where}'s path", 200)
        if path:
            _path_steps(path, where)
            call["path"] = path
        out["query"] = call
    else:
        out["query"] = check_query(raw.get("query"), f"{where}'s query")
    span = raw.get("span")
    if span is not None:
        if isinstance(span, bool) or not isinstance(span, int) or not 1 <= span <= 3:
            raise DashboardError(f"{where}'s span is how many layout columns it takes: 1, 2 or 3.")
        out["span"] = span
    if kind == "chart":
        out["chart"] = _chart(raw.get("chart") or {}, where)
    elif kind == "number":
        for key in ("value", "compare"):
            column = _text(raw.get(key), f"{where}'s {key}", 80)
            if column:
                out[key] = column
        label = _text(raw.get("label"), f"{where}'s label", 80)
        if label:
            out["label"] = label
        unit = _text(raw.get("unit"), f"{where}'s unit", 8)
        if unit:
            out["unit"] = unit
        better = raw.get("better")
        if better not in (None, "", "up", "down"):
            raise DashboardError(f'{where}\'s better is "up" (a rise is good, the default) or "down" (a fall is '
                                 'good, like costs or churn).')
        if better == "down":
            out["better"] = "down"
    elif raw.get("columns") is not None:
        columns = raw["columns"]
        if not isinstance(columns, list) or not columns or len(columns) > MAX_COLUMNS:
            raise DashboardError(f'{where}\'s columns is a list of the query\'s columns to show, like ["region", '
                                 f'{{"column": "total", "label": "Total", "unit": "₹"}}] (up to {MAX_COLUMNS}).')
        items = []
        for k, item in enumerate(columns, 1):
            if isinstance(item, dict):
                for key in item:
                    if key not in ("column", "label", "unit"):
                        raise DashboardError(f'{where}\'s column {k} is a name, or {{"column", "label", "unit"}}.')
                spec = {"column": _text(item.get("column"), f"{where}'s column {k}", 80, required=True)}
                for key, limit in (("label", 60), ("unit", 8)):
                    value = _text(item.get(key), f"{where}'s column {k} {key}", limit)
                    if value:
                        spec[key] = value
                items.append(spec)
            else:
                items.append(_text(item, f"{where}'s column {k}", 80, required=True))
        out["columns"] = items
    return out


def normalize(dashboard) -> dict:
    """The dashboard, checked and complete: {"title"?, "description"?, "sources", "widgets", "layout"}. Every query
    is one read-only SELECT, every widget's source exists, ids are unique. Normalizing a normalized dashboard gives
    it back unchanged."""
    if isinstance(dashboard, (str, bytes)):
        try:
            dashboard = json.loads(dashboard)
        except ValueError as error:
            raise DashboardError(f"The dashboard isn't valid JSON ({error}).") from None
    if not isinstance(dashboard, dict):
        raise DashboardError('A dashboard is {"sources": [{"id", "kind", …}], "widgets": [{"id", "kind", "title", '
                             '"source", "query"}], "layout": {"columns": 2}}.')
    for key in dashboard:
        if key == "allowed":
            raise DashboardError("A dashboard doesn't say which sources are allowed: the user allows each one, "
                                 "once, on the dashboard. Remove \"allowed\".")
        if key not in ("title", "description", "sources", "widgets", "layout"):
            raise DashboardError(f'A dashboard has "title", "description", "sources", "widgets" and "layout"; '
                                 f'"{str(key)[:30]}" isn\'t one of them.')
    sources_raw = dashboard.get("sources")
    if not isinstance(sources_raw, list) or not sources_raw:
        raise DashboardError('Give the dashboard its sources: "sources": [{"id": "shop", "kind": "sqlite", "path": '
                             '"data/shop.db"}].')
    if len(sources_raw) > MAX_SOURCES:
        raise DashboardError(f"The dashboard has {len(sources_raw)} sources; it reads at most {MAX_SOURCES}.")
    ids: set = set()
    sources = [_source(raw, n, ids) for n, raw in enumerate(sources_raw, 1)]
    by_id = {s["id"]: s for s in sources}
    widgets_raw = dashboard.get("widgets")
    if not isinstance(widgets_raw, list) or not widgets_raw:
        raise DashboardError('Give the dashboard its widgets: "widgets": [{"id": "revenue", "kind": "number", '
                             '"title": "Revenue", "source": "shop", "query": "SELECT SUM(total) AS revenue FROM '
                             'orders"}].')
    if len(widgets_raw) > MAX_WIDGETS:
        raise DashboardError(f"The dashboard has {len(widgets_raw)} widgets; it shows at most {MAX_WIDGETS}.")
    wids: set = set()
    widgets = [_widget(raw, n, wids, by_id) for n, raw in enumerate(widgets_raw, 1)]
    layout = dashboard.get("layout") or {}
    if not isinstance(layout, dict) or any(k != "columns" for k in layout):
        raise DashboardError('layout is {"columns": 2} (or 3).')
    columns = layout.get("columns", 2)
    if columns not in (2, 3) or isinstance(columns, bool):
        raise DashboardError("layout's columns is 2 or 3.")
    out: dict = {}
    title = _text(dashboard.get("title"), "The dashboard's title", 120)
    if title:
        out["title"] = title
    description = _text(dashboard.get("description"), "The dashboard's description", 300)
    if description:
        out["description"] = description
    out.update({"sources": sources, "widgets": widgets, "layout": {"columns": columns}})
    return out


def changed_sources(before, after) -> list[str]:
    """The ids of sources that read something else after an edit (another path, server or kind), or were removed:
    the host drops their allowance, so a source the user allowed can't be pointed at other data unasked."""
    try:
        old = {s["id"]: s for s in normalize(before)["sources"]}
    except DashboardError:
        return []
    try:
        new = {s["id"]: s for s in normalize(after)["sources"]}
    except DashboardError:
        return sorted(old)

    def what(s):
        return (s["kind"], s.get("path"), s.get("server"))
    return sorted(sid for sid, s in old.items() if sid not in new or what(new[sid]) != what(s))


# =========================================================================== running queries

def _resolve(path: str, project_root) -> Path:
    p = Path(os.path.expanduser(path))
    if not p.is_absolute():
        if not project_root:
            raise DashboardError(f"“{path}” is a path inside a project, and this dashboard was refreshed without "
                                 "its project. Refresh it from the project, or give the full path.")
        p = Path(project_root) / p
    return p.resolve()


def _where_source(source: dict) -> str:
    return source.get("label") or {"file": source.get("path"), "sqlite": source.get("path"),
                                   "postgres": "the project's database", "plugin": source.get("server")}[
        source["kind"]] or source["id"]


def _cell(value):
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(value)):,} bytes>"
    text = str(value)
    return text if len(text) <= MAX_CELL else text[:MAX_CELL - 1] + "…"


class _Sources:
    """What one refresh opened, each source once: a file's tables, a SQLite connection."""

    def __init__(self, project_root, call, is_read_only):
        self.project_root, self.call, self.is_read_only = project_root, call, is_read_only
        self.open: dict = {}

    def close(self):
        for handle in self.open.values():
            try:
                handle.close()
            except Exception:           # noqa: BLE001 - closing what's already closed
                pass

    def run(self, source: dict, query) -> tuple[list, list, bool]:
        kind = source["kind"]
        if kind == "file":
            return self._file(source, query)
        if kind == "sqlite":
            return self._sqlite(source, query)
        if kind == "postgres":
            return run_postgres(query, self.project_root)
        return run_plugin(source, query, call=self.call, is_read_only=self.is_read_only)

    def _file(self, source, sql):
        sid = source["id"]
        if sid not in self.open:
            path = _resolve(source["path"], self.project_root)
            if not path.is_file():
                raise DashboardError(f"{source['path']} isn't there (looked for {path}).")
            if path.stat().st_size > MAX_FILE_BYTES:
                raise DashboardError(f"{source['path']} is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB; use a "
                                     "SQLite database for data this size.")
            try:
                captured = read_regular_bytes(path, maximum=MAX_FILE_BYTES)
            except (OSError, WorkspaceBoundaryError) as error:
                raise DashboardError(f"{source['path']} couldn't be read safely ({error}).") from None
            loaded = tabledata.Data([(path.name, captured[0])])
            if not loaded.tables:
                loaded.close()
                raise DashboardError(f"{source['path']} has no table to read"
                                     + (f": {'; '.join(loaded.problems)}" if loaded.problems else "."))
            self.open[sid] = loaded
        try:
            result = self.open[sid].query(sql)
        except tabledata.DataError as error:
            tables = ", ".join(t["table"] for t in self.open[sid].tables)
            raise DashboardError(f"{error} The file's table{'s are' if ',' in tables else ' is'} {tables}.") from None
        return result["columns"], [[_cell(v) for v in row] for row in result["rows"]], result["more"]

    def _sqlite(self, source, sql):
        sid = source["id"]
        if sid not in self.open:
            path = _resolve(source["path"], self.project_root)
            if not path.is_file():
                raise DashboardError(f"{source['path']} isn't there (looked for {path}).")
            self.open[sid] = open_sqlite(path, source["path"])
        return run_sqlite(self.open[sid], sql)


def open_sqlite(path: Path, shown: str = "") -> sqlite3.Connection:
    """A SQLite database opened so it can only be read: mode=ro (no file is created or written), query_only, and
    an authorizer that allows reading tables and calling functions, nothing else (no ATTACH, no PRAGMA)."""
    shown = shown or str(path)
    try:
        with open(path, "rb") as handle:
            head = handle.read(16)
    except OSError as error:
        raise DashboardError(f"{shown} couldn't be opened ({error.strerror or type(error).__name__}).") from None
    if head != b"SQLite format 3\x00":
        raise DashboardError(f"{shown} isn't a SQLite database. For a .csv, .tsv or .xlsx file use \"kind\": "
                             "\"file\".")
    uri = "file:" + urllib.parse.quote(str(path)) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2, isolation_level=None, check_same_thread=False)
        conn.execute("PRAGMA query_only = ON")
    except sqlite3.Error as error:
        raise DashboardError(f"{shown} couldn't be opened read-only ({error}).") from None
    conn.set_authorizer(tabledata.Data._authorize)
    return conn


def run_sqlite(conn: sqlite3.Connection, sql: str) -> tuple[list, list, bool]:
    """One SELECT on a read-only connection: seconds capped, rows capped."""
    deadline = time.monotonic() + QUERY_SECONDS
    conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 20_000)
    try:
        cursor = conn.execute(sql)
        names = [d[0] for d in cursor.description or []]
        rows = cursor.fetchmany(MAX_ROWS + 1)
    except (sqlite3.Error, sqlite3.Warning) as error:
        message = str(error)
        if "interrupted" in message:
            message = f"it took more than {QUERY_SECONDS:.0f} seconds; ask for less (aggregate, or add LIMIT)"
        elif "not authorized" in message or "readonly" in message or "read-only" in message:
            message = "a dashboard only reads, and this query would do more"
        elif "one statement" in message:
            message = "a widget runs one statement"
        raise DashboardError(f"The query didn't run: {message}.") from None
    finally:
        conn.set_progress_handler(None, 0)
    if not names:
        raise DashboardError("The query returned no columns; a widget's query is a SELECT.")
    return names, [[_cell(v) for v in row] for row in rows[:MAX_ROWS]], len(rows) > MAX_ROWS


_PLAIN_NUMBER = re.compile(r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\Z")


def run_postgres(sql: str, project_root, *, psql: str | None = None) -> tuple[list, list, bool]:
    """One SELECT on the project's read-only Postgres account, with psql: the query wrapped as a sub-select (so it
    is one statement and its rows are capped by the database), in a read-only transaction with a statement
    timeout. The password goes to psql in its environment, never on its command line."""
    from . import readonly_database
    exe = psql or shutil.which("psql")
    if not exe:
        raise DashboardError("Postgres isn't set up here: DGC reads Postgres with the psql program, which isn't "
                             "installed. Install the PostgreSQL client, then set the project's read-only account "
                             "with `dgc readonly-db set`.")
    account = readonly_database.load(project_root) if project_root else None
    if account is None:
        raise DashboardError("Postgres isn't set up for this project: there's no read-only database account. Run "
                             "`dgc readonly-db set` in the project (`dgc readonly-db guide` shows how to make the "
                             "account).")
    wrapped = f"SELECT * FROM (\n{sql}\n) AS dgc_widget LIMIT {MAX_ROWS + 1}"
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "TMPDIR")
           if key in os.environ}
    env.update({"PGPASSWORD": account["password"], "PGCONNECT_TIMEOUT": "8", "PGAPPNAME": "dgc-dashboard",
                "PGCLIENTENCODING": "UTF8",
                "PGOPTIONS": f"-c default_transaction_read_only=on -c statement_timeout={int(QUERY_SECONDS * 1000)} "
                             "-c idle_in_transaction_session_timeout=10000"})
    target = readonly_database.url_for({**account, "password": ""})
    argv = [exe, "--no-psqlrc", "--csv", "--quiet", "--set=ON_ERROR_STOP=1", f"--pset=null={_NULL}",
            f"--dbname={target}", "--command", wrapped]
    done = _run_psql_bounded(argv, env)
    if done.returncode != 0:
        lines = [line.strip() for line in (done.stderr or "").splitlines() if line.strip()]
        message = next((ln for ln in lines if ln.startswith(("ERROR:", "psql: error:", "FATAL:"))), lines[0] if lines
                       else f"psql exited with {done.returncode}")
        message = re.sub(r"^(psql: error: |ERROR:\s+|FATAL:\s+)", "", message)
        if "read-only transaction" in message:
            message += " (a dashboard only reads)"
        raise DashboardError(f"Postgres said: {message[:300]}")
    table = list(itertools.islice(csv.reader(io.StringIO(done.stdout)), MAX_ROWS + 2))
    if not table:
        raise DashboardError("The query returned no columns; a widget's query is a SELECT.")
    names, body = table[0], table[1:]
    width = len(names)
    rows = [[None if v == _NULL else v for v in (r + [_NULL] * (width - len(r)))[:width]] for r in body]
    for c in range(width):
        values = [r[c] for r in rows if r[c] is not None]
        if values and all(_PLAIN_NUMBER.match(v) for v in values) \
                and not any(re.match(r"-?0\d", v) for v in values):
            for r in rows:
                if r[c] is not None:
                    number = float(r[c])
                    r[c] = int(number) if number.is_integer() and "." not in r[c] and "e" not in r[c].lower() \
                        and abs(number) < 2 ** 53 else number
    return names, [[_cell(v) for v in row] for row in rows[:MAX_ROWS]], len(rows) > MAX_ROWS


def _run_psql_bounded(argv: list[str], env: dict) -> subprocess.CompletedProcess:
    """Drain both pipes while bounding retained output and stopping an oversized query promptly."""
    try:
        proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        raise DashboardError(f"psql couldn't be started ({error.strerror or type(error).__name__}).") from None
    output, errors = bytearray(), bytearray()
    over = threading.Event()
    reader_error = []

    def drain(stream, target, maximum):
        try:
            while True:
                chunk = stream.read(65_536)
                if not chunk:
                    break
                remaining = maximum - len(target)
                target.extend(chunk[:max(0, remaining)])
                if len(chunk) > remaining:
                    over.set()
                    break
        except (OSError, ValueError) as error:
            reader_error.append(type(error).__name__)

    readers = [threading.Thread(target=drain, args=(proc.stdout, output, MAX_PSQL_OUTPUT_BYTES), daemon=True),
               threading.Thread(target=drain, args=(proc.stderr, errors, MAX_PSQL_ERROR_BYTES), daemon=True)]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + PSQL_SECONDS
    failure = ""
    while True:
        if over.is_set():
            failure = "large"
            break
        if reader_error:
            failure = "read"
            break
        if proc.poll() is not None and all(not reader.is_alive() for reader in readers):
            break
        if time.monotonic() >= deadline:
            failure = "timeout"
            break
        time.sleep(0.01)
    if failure and proc.poll() is None:
        proc.kill()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
    for stream in (proc.stdout, proc.stderr):
        if stream is not None:
            stream.close()
    for reader in readers:
        reader.join(timeout=1)
    if failure == "timeout":
        raise DashboardError(f"Postgres didn't answer within {PSQL_SECONDS} seconds.")
    if failure == "large" or over.is_set():
        raise DashboardError("The Postgres result is too large for a dashboard. Aggregate it or select fewer columns.")
    if failure or any(reader.is_alive() for reader in readers):
        raise DashboardError("The Postgres result couldn't be read safely.")
    return subprocess.CompletedProcess(argv, proc.returncode, output.decode("utf-8", errors="replace"),
                                       errors.decode("utf-8", errors="replace"))


_STEP = re.compile(r"\.?([A-Za-z_][\w\-]*)|\[(\d+)\]|\[\*\]|\[\"((?:[^\"\\]|\\.)*)\"\]|\['([^']*)'\]")


def _path_steps(path: str, where: str = "The path") -> list:
    text = path.strip()
    if text.startswith("$"):
        text = text[1:]
    steps, i = [], 0
    while i < len(text):
        m = _STEP.match(text, i)
        if not m or m.end() == i:
            raise DashboardError(f'{where} “{path}” can\'t be read: write it like "data.items", "items[0].rows" or '
                                 '"result[*].stats".')
        if m.group(1) is not None:
            steps.append(m.group(1))
        elif m.group(2) is not None:
            steps.append(int(m.group(2)))
        elif m.group(3) is not None:
            steps.append(json.loads('"' + m.group(3) + '"'))
        elif m.group(4) is not None:
            steps.append(m.group(4))
        else:
            steps.append("*")
        i = m.end()
    return steps


def select(value, path: str, *, max_items: int | None = None, truncated: list[bool] | None = None):
    """A small JSON path: "data.items", "$.result[0].rows", "items[*].stats", "['odd key']"."""
    current, every = value, False
    for step in _path_steps(path or ""):
        if step == "*":
            if not isinstance(current, list):
                raise DashboardError(f"The tool's result has no list at “{path}” to take every item of.")
            if max_items is not None and len(current) > max_items:
                current = current[:max_items]
                if truncated is not None:
                    truncated[0] = True
            every = True
            continue
        items = current if every else [current]
        picked = []
        for item in items:
            if isinstance(step, int):
                if not isinstance(item, list) or step >= len(item):
                    raise DashboardError(f"The tool's result has no item [{step}] on the way to “{path}”.")
                picked.append(item[step])
            else:
                if not isinstance(item, dict) or step not in item:
                    keys = ", ".join(list(item)[:12]) if isinstance(item, dict) else "none (it's a list or a value)"
                    raise DashboardError(f"The tool's result has no “{step}” on the way to “{path}”; the keys there "
                                         f"are {keys}.")
                picked.append(item[step])
        current = picked if every else picked[0]
    return current


def _unwrap(result):
    """A tool's result as data: MCP's structuredContent, or its text parsed as JSON when it is JSON."""
    if isinstance(result, (str, bytes)):
        try:
            return json.loads(result)
        except ValueError:
            return result
    if isinstance(result, dict) and isinstance(result.get("structuredContent"), (dict, list)):
        return result["structuredContent"]
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        texts = []
        for item in result["content"]:
            if isinstance(item, dict) and item.get("type") == "text":
                texts.append(item.get("text"))
                if len(texts) > 1:
                    break
        if len(texts) == 1:
            try:
                return json.loads(texts[0])
            except (TypeError, ValueError):
                return texts[0]
    return result


def table_of(value, *, max_rows: int | None = None) -> tuple[list, list]:
    """JSON as rows: a list of objects (their keys as columns), a list of lists (the first as the column names when
    it's all text), a list of values (one "value" column), an object (one row) or a value."""
    def cell(v):
        if isinstance(v, (dict, list)):
            parts, size = [], 0
            for chunk in json.JSONEncoder(ensure_ascii=False, separators=(",", ":")).iterencode(v):
                remaining = MAX_CELL - size
                if len(chunk) > remaining:
                    return ("".join(parts) + chunk[:remaining])[:MAX_CELL - 1] + "…"
                parts.append(chunk)
                size += len(chunk)
            return "".join(parts)
        return _cell(v)
    if isinstance(value, list):
        if max_rows is not None:
            value = value[:max_rows]
        if value and all(isinstance(v, dict) for v in value):
            names: list = []
            for v in value:
                for key in v:
                    if key not in names and len(names) < MAX_COLUMNS:
                        names.append(key)
            return [str(n) for n in names], [[cell(v.get(n)) for n in names] for v in value]
        if value and all(isinstance(v, list) for v in value):
            width = min(MAX_COLUMNS, max(len(v) for v in value))
            first = value[0]
            if len(value) > 1 and all(isinstance(v, str) for v in first):
                names = [str(v) for v in first[:width]]
                names += [f"column_{k + 1}" for k in range(len(names), width)]
                body = value[1:]
            else:
                names, body = [f"column_{k + 1}" for k in range(width)], value
            return names, [[cell(v[k]) if k < len(v) else None for k in range(width)] for v in body]
        return ["value"], [[cell(v)] for v in value]
    if isinstance(value, dict):
        names = [str(k) for k in list(value)[:MAX_COLUMNS]]
        return names, [[cell(value[k]) for k in list(value)[:MAX_COLUMNS]]]
    return ["value"], [[cell(value)]]


def run_plugin(source: dict, query: dict, *, call=None, is_read_only=None) -> tuple[list, list, bool]:
    """One call to a plugin's tool, if the host says the tool only reads; its rows from the result by the path."""
    server, tool = source["server"], query["tool"]
    if call is None or is_read_only is None:
        raise DashboardError("Plugin tools can't be called here: refresh the dashboard in DGC, where the plugin "
                             "is installed.")
    try:
        reads = bool(is_read_only(server, tool))
    except Exception:                    # noqa: BLE001 - a host that can't tell: treated as not read-only
        reads = False
    if not reads:
        raise DashboardError(f"{server}'s {tool} isn't marked read-only, so a dashboard won't call it. Use one of "
                             f"{server}'s tools that only reads.")
    try:
        result = call(server, tool, dict(query.get("args") or {}))
    except DashboardError:
        raise
    except Exception as error:           # noqa: BLE001 - the plugin's own failure, shown on its widget
        raise DashboardError(f"{server}'s {tool} failed: {str(error)[:200] or type(error).__name__}.") from None
    truncated = [False]
    selected = select(_unwrap(result), query.get("path") or "", max_items=MAX_ROWS + 2,
                      truncated=truncated)
    names, rows = table_of(selected, max_rows=MAX_ROWS + 2)
    return names, rows[:MAX_ROWS], truncated[0] or len(rows) > MAX_ROWS


def _stamp(now) -> str:
    when = now if isinstance(now, datetime) else datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.astimezone()
    return when.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def refresh(dashboard, *, allowed, project_root, call=None, is_read_only=None, now=None) -> dict:
    """Run every widget's query now, each on its own: {widget id: {"columns", "rows", "more", "error",
    "blocked", "refreshed_at", "ms"}}. A widget whose source isn't in ``allowed`` (the source ids the user allowed
    for this dashboard) doesn't run: its "blocked" names the source and its error says to allow it. A failing
    widget keeps its error and the rest run. No model is involved."""
    d = normalize(dashboard)
    stamp = _stamp(now)
    allowed = {str(a) for a in (allowed or [])}
    sources = {s["id"]: s for s in d["sources"]}
    opened = _Sources(project_root, call, is_read_only)
    failed: dict = {}
    results: dict = {}
    try:
        for w in d["widgets"]:
            source = sources[w["source"]]
            result = {"columns": [], "rows": [], "more": False, "error": None, "blocked": None,
                      "refreshed_at": stamp, "ms": 0}
            started = time.monotonic()
            if source["id"] not in allowed:
                result["blocked"] = source["id"]
                result["error"] = f"Allow {_where_source(source)} to show this."
            elif source["id"] in failed and source["kind"] in ("file", "sqlite"):
                result["error"] = failed[source["id"]]
            else:
                try:
                    columns, rows, more = opened.run(source, w["query"])
                    result.update(columns=[str(c) for c in columns], rows=rows, more=more)
                    _shape(w, result)                  # a chart or tile that can't be drawn from these rows says so
                except DashboardError as error:
                    result["error"] = str(error)
                    if source["kind"] in ("file", "sqlite") and source["id"] not in opened.open:
                        failed[source["id"]] = str(error)
                except Exception as error:             # noqa: BLE001 - one widget's failure never stops the rest
                    result["error"] = f"This widget didn't refresh ({type(error).__name__})."
            result["ms"] = int((time.monotonic() - started) * 1000)
            results[w["id"]] = result
    finally:
        opened.close()
    return results


# =========================================================================== shaping rows for a widget

def _pretty(name: str) -> str:
    text = str(name).replace("_", " ").strip()
    return text[:1].upper() + text[1:] if text else str(name)


def _column(columns: list, name: str, what: str) -> int:
    for k, c in enumerate(columns):
        if c == name:
            return k
    for k, c in enumerate(columns):
        if c.casefold() == name.casefold():
            return k
    raise DashboardError(f"The query has no column “{name}” for {what}; its columns are "
                         f"{', '.join(columns) or 'none'}. Name it in the SELECT (… AS {name}).")


def _number(value):
    return slides._num(value)


_YM = re.compile(r"(\d{4})-(\d{2})\Z")
_YMD = re.compile(r"(\d{4})-(\d{2})-(\d{2})\Z")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _x_labels(values: list) -> list:
    """Month and date keys as people read them: 2026-10 is "Oct" (or "Oct 2026" across years), 2026-10-28 is
    "28 Oct"; anything else as it is."""
    texts = ["" if v is None else str(v) for v in values]
    if texts and all(_YM.match(t) for t in texts) and all(1 <= int(t[5:7]) <= 12 for t in texts):
        one_year = len({t[:4] for t in texts}) == 1
        return [_MONTHS[int(t[5:7]) - 1] + ("" if one_year else f" {t[:4]}") for t in texts]
    if texts and all(_YMD.match(t) for t in texts) and all(1 <= int(t[5:7]) <= 12 for t in texts):
        one_year = len({t[:4] for t in texts}) == 1
        return [f"{int(t[8:10])} {_MONTHS[int(t[5:7]) - 1]}" + ("" if one_year else f" {t[:4]}") for t in texts]
    return texts


def _chart_spec(w: dict, result: dict) -> dict:
    columns, rows = result["columns"], result["rows"]
    chart = w["chart"]
    where = f"“{w['title']}”"
    if not rows:
        return {}
    if chart["type"] != "pie" and chart["type"] != "scatter" and len(rows) > slides.MAX_POINTS:
        raise DashboardError(f"The query returned {len(rows)}{'+' if result.get('more') else ''} rows; a chart shows "
                             f"at most {slides.MAX_POINTS}. Group them (GROUP BY) or add LIMIT.")
    x = _column(columns, chart["x"], "the chart's x") if chart.get("x") else 0
    if chart.get("series"):
        series = []
        for item in chart["series"]:
            column = item["column"] if isinstance(item, dict) else item
            name = item.get("name") if isinstance(item, dict) else None
            series.append((_column(columns, column, "a series"), name or _pretty(column)))
    else:
        series = [(k, _pretty(c)) for k, c in enumerate(columns)
                  if k != x and any(_number(r[k]) is not None for r in rows)]
        if not series:
            raise DashboardError(f"The query has no number column to chart; give the chart's series.")
    raw: dict = {"type": chart["type"], "title": w["title"]}
    if chart["type"] == "scatter":
        raw["series"] = [{"name": name, "points": [[r[x], r[k]] for r in rows]} for k, name in series]
    else:
        raw["x"] = _x_labels([r[x] for r in rows])
        raw["series"] = [{"name": name, "values": [_number(r[k]) for r in rows]} for k, name in series]
    for key in ("unit", "stacked", "horizontal", "x_label", "y_label"):
        if key in chart:
            raw[key] = chart[key]
    try:
        return slides._chart(raw, where)
    except slides.SlidesError as error:
        raise DashboardError(str(error).replace(f"{where}'s ", "The chart's ").replace(where, "The chart")) from None


def _number_parts(w: dict, result: dict) -> dict:
    columns, rows = result["columns"], result["rows"]
    if not rows:
        return {}
    if w.get("value"):
        k = _column(columns, w["value"], "the number")
    else:
        k = next((i for i, v in enumerate(rows[0]) if _number(v) is not None), 0)
    value = rows[0][k]
    out = {"value": _number(value) if _number(value) is not None else value}
    if w.get("compare"):
        c = _column(columns, w["compare"], "the comparison")
        out["compare"] = _number(rows[0][c])
    return out


def _shape(w: dict, result: dict):
    if w["kind"] == "chart":
        return _chart_spec(w, result)
    if w["kind"] == "number":
        return _number_parts(w, result)
    columns = result["columns"]
    specs = w.get("columns") or columns
    out = []
    for item in specs:
        name = item["column"] if isinstance(item, dict) else item
        k = _column(columns, name, "the table")
        label = item.get("label") if isinstance(item, dict) else None
        out.append((k, label or _pretty(columns[k]), item.get("unit", "") if isinstance(item, dict) else ""))
    return out


# =========================================================================== the page

def _fmt(value, unit: str = "", places: int | None = None) -> str:
    """A number with its unit: ₹4,820 · 38.4% · 1,240 orders. ``places`` fixes the decimals; otherwise up to 2."""
    if value is None:
        return "–"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(value)
    auto = places is None
    if auto:
        places = 0 if float(value).is_integer() else (2 if abs(value) < 1000 else 1 if abs(value) < 1e5 else 0)
    text = f"{abs(value):,.{places}f}"
    if auto and places:
        text = text.rstrip("0").rstrip(".")
    sign = "−" if value < 0 and text.strip("0.,") else ""
    if not unit:
        return sign + text
    if unit == "%":
        return sign + text + "%"
    if len(unit) == 1 and not unit.isalnum():
        return sign + unit + text
    return f"{sign}{text} {unit}"


def _big(value, unit: str = "") -> str:
    """A tile's number, compact past a million: ₹4.82M, 12,840, 38.4%."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return "–" if value is None else str(value)
    a = abs(value)
    if a >= 1e6:
        for div, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
            if a >= div:
                text = f"{a / div:.2f}".rstrip("0").rstrip(".") + suffix
                break
        sign = "−" if value < 0 else ""
        if not unit:
            return sign + text
        if len(unit) == 1 and not unit.isalnum():
            return sign + unit + text
        return f"{sign}{text} {unit}"
    return _fmt(value, unit)


def _places(values) -> int:
    numbers = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    need = 0
    for v in numbers:
        text = f"{abs(v):.6f}".rstrip("0")
        need = max(need, len(text.split(".")[1]) if "." in text else 0)
    return min(2, need)


def _when(stamp: str, today=None) -> str:
    try:
        when = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone()
    except ValueError:
        return ""
    today = today or datetime.now().astimezone().date()
    clock = when.strftime("%H:%M")
    return clock if when.date() == today else f"{when.day} {_MONTHS[when.month - 1]}, {clock}"


_LIGHT = dataclasses.replace(slides._LOOKS["plain"], name="dashboard-light", bg="FCFCFB", fg="1C1B19", muted="65645F",
                             rule="E4E3DE", accent="2A78D6",
                             palette=("2A78D6", "EB6834", "1BAF7A", "EDA100", "E87BA4", "008300", "6250D6", "E34948"))
_DARK = dataclasses.replace(slides._LOOKS["plain"], name="dashboard-dark", bg="1A1A19", fg="F0EFEC", muted="A3A198",
                            rule="2E2E2B", accent="3987E5",
                            palette=("3987E5", "D95926", "199E70", "C98500", "D55181", "008300", "9085E9", "E66767"))

# A chart's drawing size in design px, by the layout's columns and the widget's span: chosen so its text reads at
# about 12 to 13 px wherever it lands; under 520 px wide a smaller drawing takes over.
_SIZES = {(2, 1): (760, 400), (2, 2): (1560, 520), (3, 1): (430, 290), (3, 2): (1000, 430), (3, 3): (1560, 520)}
_NARROW = (520, 380)

_ICONS = {
    "lock": '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" '
            'height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    "alert": '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/>'
             '<path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>',
    "empty": '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/>'
             '</svg>',
    "up": '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 2.2 10.2 8H1.8Z" '
          'fill="currentColor"/></svg>',
    "down": '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 9.8 1.8 4h8.4Z" '
            'fill="currentColor"/></svg>',
    "flat": '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="2" y="5.2" width="8" '
            'height="1.6" rx=".8" fill="currentColor"/></svg>',
    "chev": '<svg class="cv" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" '
            'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
            '</svg>',
}

_CSS = """
:root{color-scheme:light;--bg:#f3f3f0;--card:#fcfcfb;--ink:#161614;--ink2:#4f4e4a;--muted:#6b6a66;--line:#e4e3de;
--soft:#efeeea;--accent:#2a78d6;--good:#0b7a0b;--bad:#c42b2b;--code:#f3f2ee;--warn:#8a5300;--warn-bg:#fdf3e1;
--shadow:0 1px 2px rgb(20 20 18/.05),0 0 0 1px rgb(20 20 18/.02)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .plot .l{display:none}
:root:not([data-theme="light"]) .plot .d{display:block}
:root:not([data-theme="light"]){color-scheme:dark;--bg:#0f0f0e;--card:#1a1a19;
--ink:#f0efec;--ink2:#c9c8be;--muted:#a3a198;--line:#2c2c2a;--soft:#232321;--accent:#3987e5;--good:#3cc13c;
--bad:#ff8077;--code:#222220;--warn:#f2c46d;--warn-bg:#2e2615;--shadow:none}}
:root[data-theme="dark"] .plot .l{display:none}
:root[data-theme="dark"] .plot .d{display:block}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0f0f0e;--card:#1a1a19;--ink:#f0efec;--ink2:#c9c8be;--muted:#a3a198;
--line:#2c2c2a;--soft:#232321;--accent:#3987e5;--good:#3cc13c;--bad:#ff8077;--code:#222220;--warn:#f2c46d;
--warn-bg:#2e2615;--shadow:none}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,
"Helvetica Neue",Arial,"Noto Sans",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1240px;margin:0 auto;padding:28px 24px 44px}
.hd{display:flex;justify-content:space-between;align-items:flex-end;gap:12px 24px;flex-wrap:wrap;margin:0 0 20px}
h1{font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.015em;margin:0;text-wrap:balance}
.sub{margin:4px 0 0;color:var(--ink2);max-width:70ch}
.meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:12.5px}
.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;
border:1px solid var(--line);background:var(--card);color:var(--ink2);white-space:nowrap}
.pill i{width:6px;height:6px;border-radius:50%;background:var(--good);display:inline-block}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:16px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:0 0 16px}
.grid.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
.w{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);
padding:16px 18px 0;display:flex;flex-direction:column;min-width:0}
.s2{grid-column:span 2}.s3{grid-column:span 3}
.wt{font-size:13.5px;line-height:1.3;font-weight:600;color:var(--ink);margin:0 0 12px}
.num .wt{color:var(--ink2);font-weight:550;margin-bottom:8px}
.big{font-size:30px;line-height:1.1;font-weight:650;letter-spacing:-.02em;color:var(--ink);overflow-wrap:anywhere}
.delta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-top:10px;font-size:12.5px;color:var(--muted)}
.chg{display:inline-flex;align-items:center;gap:4px;font-weight:600;padding:2px 7px 2px 6px;border-radius:6px;
background:var(--soft)}
.chg.good{color:var(--good)}.chg.bad{color:var(--bad)}.chg.flat{color:var(--ink2)}
.cap{margin-top:10px;color:var(--muted);font-size:12.5px}
.plot{container-type:inline-size;flex:1;min-height:0;margin:0}
.plot svg{display:block;width:100%;height:auto;overflow:visible}
.plot svg text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
font-variant-numeric:tabular-nums}
.plot .d,.plot .v-s{display:none}
.plot svg.nv text[font-weight="600"]{display:none}
@container (max-width:520px){.plot .v-w{display:none}.plot .v-s{display:block}}
.tw{overflow:auto;max-height:380px;margin:0 -18px;border-top:1px solid var(--line)}
table.dt{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.dt th{position:sticky;top:0;z-index:1;background:var(--card);text-align:left;font-weight:600;color:var(--muted);
font-size:12px;padding:9px 18px;border-bottom:1px solid var(--line);white-space:nowrap}
.dt td{padding:8px 18px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:28em;overflow:hidden;
text-overflow:ellipsis}
.dt tr:last-child td{border-bottom:0}
.dt .n{text-align:right}
.dt tbody tr:hover td{background:var(--soft)}
.more{padding:8px 18px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
.state{display:flex;gap:10px;align-items:flex-start;padding:14px;border-radius:10px;background:var(--soft);
color:var(--ink2);font-size:13px;margin:2px 0 4px}
.state svg{flex:none;margin-top:1px}
.state b{display:block;color:var(--ink);font-weight:600;margin-bottom:2px}
.state.err{background:var(--warn-bg);color:var(--warn)}
.state.err b{color:var(--warn)}
.num .state{padding:10px 12px}
.wf{margin:auto -18px 0;border-top:1px solid var(--line)}
.w:not(.tbl)>:nth-last-child(2){margin-bottom:14px}
.tiles:has(.wf[open]),.grid:has(.wf[open]){align-items:start}
.wf summary{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 18px;cursor:pointer;
list-style:none;color:var(--muted);font-size:12px;border-radius:0 0 12px 12px;white-space:nowrap}
.wf summary::-webkit-details-marker{display:none}
.wf summary:hover{color:var(--ink2)}
.wf summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.wf .sq{display:inline-flex;align-items:center;gap:5px;color:var(--ink2)}
.wf .cv{transition:transform .15s ease}
.wf[open] .cv{transform:rotate(90deg)}
.wf pre{margin:0 18px 12px;padding:10px 12px;background:var(--code);border-radius:8px;white-space:pre-wrap;
overflow-wrap:anywhere;font:12px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
color:var(--ink);max-height:240px;overflow:auto}
.wf .src{margin:0 18px 8px;color:var(--muted);font-size:12px}
.wf .tw{margin:0 0 4px;max-height:220px}
@media (prefers-reduced-motion:reduce){.wf .cv{transition:none}}
@media (max-width:760px){.wrap{padding:20px 16px 32px}.grid,.grid.c3{grid-template-columns:minmax(0,1fr)}
.s2,.s3{grid-column:auto}.big{font-size:27px}}
@media print{body{background:#fff}.w{box-shadow:none;break-inside:avoid}.wf{display:none}}
"""


def _labels_collide(spec: dict, width: float) -> bool:
    """Whether the numbers chart_svg writes over a column chart's bars would run into each other at this width (it
    labels up to 16 bars whatever the width); where they would, the page hides them and the axis and each bar's
    hover title carry the numbers."""
    if spec["type"] != "bar" or spec.get("stacked") or spec.get("horizontal"):
        return False
    n, count = len(spec["x"]), len(spec["series"])
    if not n or n * count > 16:
        return False
    fs = 18 if width >= 760 else 16 if width >= 520 else 14
    unit = spec.get("unit", "")
    widest = max(slides._measure(slides._fmt(v, unit), fs - 1) * 1.08 for s in spec["series"] for v in s["values"])
    plot = width - 72
    gap = 0.34 if count == 1 else 0.26
    bar = plot / n * (1 - gap) / count
    return widest > (bar if count > 1 else plot / n) * 0.94


def _plot(spec: dict, columns: int, span: int, label: str) -> str:
    wide = _SIZES.get((columns, min(span, columns)), _SIZES[(columns, 1)])
    variants = [(wide, "v-w")] + ([(_NARROW, "v-s")] if wide[0] > 600 else [])
    parts = []
    for look, cls in ((_LIGHT, "l"), (_DARK, "d")):
        drawn = []
        for (W, H), size in variants:
            svg = slides.chart_svg(spec, W, H, look)
            classes = size if len(variants) > 1 else "v-o"
            if _labels_collide(spec, W):
                classes += " nv"
            drawn.append(svg.replace("<svg ", f'<svg class="{classes}" ', 1))
        parts.append(f'<div class="{cls}">{"".join(drawn)}</div>')
    return f'<figure class="plot" role="group" aria-label="{html.escape(label)}">{"".join(parts)}</figure>'


def _data_table(columns: list, rows: list, specs=None, *, limit: int = 200) -> str:
    e = html.escape
    specs = specs or [(k, _pretty(c), "") for k, c in enumerate(columns)]
    places = {k: _places(r[k] for r in rows) for k, _, _ in specs}
    numeric = {k: any(isinstance(r[k], (int, float)) and not isinstance(r[k], bool) for r in rows)
               and all(r[k] is None or isinstance(r[k], (int, float)) for r in rows) for k, _, _ in specs}
    head = "".join(f'<th scope="col"{" class=n" if numeric[k] else ""}>{e(label)}</th>' for k, label, _ in specs)
    body = []
    for row in rows[:limit]:
        cells = []
        for k, _, unit in specs:
            v = row[k]
            if numeric[k] and v is not None:
                cells.append(f'<td class="n">{e(_fmt(v, unit, places[k]))}</td>')
            else:
                text = "" if v is None else ("TRUE" if v is True else "FALSE" if v is False else str(v))
                cells.append(f'<td title="{e(text)}">{e(text)}</td>' if len(text) > 40 else f"<td>{e(text)}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    return f'<table class="dt"><thead><tr>{head}</tr></thead><tbody>{"".join(body)}</tbody></table>'


def _footer(w: dict, source: dict, result: dict | None, *, data: str = "") -> str:
    e = html.escape
    query = w["query"] if isinstance(w["query"], str) else json.dumps(w["query"], ensure_ascii=False, indent=1)
    if not result:
        left = "Not refreshed yet"
    elif result.get("blocked"):
        left = "Waiting to be allowed"
    else:
        when = _when(result.get("refreshed_at") or "")
        left = f"Refreshed {when}" if when else ""
    kind = {"file": "file", "sqlite": "SQLite", "postgres": "Postgres", "plugin": "plugin"}[source["kind"]]
    label = "Show query and data" if data else "Show query"
    return (f'<details class="wf"><summary><span>{e(left)}</span><span class="sq">{label}{_ICONS["chev"]}</span>'
            f'</summary><div class="src">{e(_where_source(source))} · {kind} · read-only</div><pre>{e(query)}</pre>'
            f'{data}</details>')


def _state(kind: str, title: str, text: str = "") -> str:
    e = html.escape
    icon = {"blocked": "lock", "error": "alert", "empty": "empty", "waiting": "empty"}[kind]
    cls = " err" if kind == "error" else ""
    return (f'<div class="state{cls}" role="status">{_ICONS[icon]}<div><b>{e(title)}</b>'
            f'{e(text)}</div></div>')


def _problem(w: dict, source: dict, result: dict | None) -> str:
    """The state a widget shows instead of its data, or ""."""
    if not result:
        return _state("waiting", "Not refreshed yet", "Refresh the dashboard to run this query.")
    if result.get("blocked"):
        reads = {"file": f"This reads the file {source.get('path')}, read-only.",
                 "sqlite": f"This reads the SQLite database {source.get('path')}, read-only.",
                 "postgres": "This reads the project's Postgres database with its read-only account.",
                 "plugin": f"This calls {source.get('server')}'s {w['query'].get('tool') if isinstance(w['query'], dict) else 'tool'}"
                           ", if it only reads."}[source["kind"]]
        return _state("blocked", f"Allow {_where_source(source)} to show this",
                      f"{reads} DGC asks once for this dashboard.")
    if result.get("error"):
        return _state("error", "This widget didn't refresh", result["error"])
    if not result.get("rows"):
        return _state("empty", "No rows", "The query ran and returned nothing to show.")
    return ""


def _number_html(w: dict, source: dict, result: dict | None) -> str:
    e = html.escape
    body = _problem(w, source, result)
    if not body:
        try:
            parts = _number_parts(w, result)
        except DashboardError as error:
            body = _state("error", "This widget didn't refresh", str(error))
        else:
            unit = w.get("unit", "")
            value = parts.get("value")
            body = f'<div class="big">{e(_big(value, unit))}</div>'
            if "compare" in parts and isinstance(value, (int, float)) and isinstance(parts["compare"], (int, float)):
                before = parts["compare"]
                change = value - before
                if unit == "%":
                    amount = f"{change:+.1f}".replace("-", "\u2212") + " pts"
                elif before:
                    amount = f"{change / abs(before) * 100:+.1f}%".replace("-", "\u2212")
                else:
                    amount = ("+" if change >= 0 else "") + _fmt(change, unit)
                if abs(change) < 1e-12:
                    tone, icon, amount = "flat", "flat", "No change"
                else:
                    rising = change > 0
                    good = rising if w.get("better", "up") == "up" else not rising
                    tone, icon = ("good" if good else "bad"), ("up" if rising else "down")
                caption = w.get("label") or f"vs {_big(before, unit)}"
                word = {"good": "better", "bad": "worse", "flat": "unchanged"}[tone]
                body += (f'<div class="delta"><span class="chg {tone}" aria-label="{e(amount)}, {word}">'
                         f'{_ICONS[icon]}{e(amount)}</span><span>{e(caption)}</span></div>')
            elif w.get("label"):
                body += f'<div class="cap">{e(w["label"])}</div>'
    return (f'<article class="w num"><h2 class="wt">{e(w["title"])}</h2>{body}'
            f'{_footer(w, source, result)}</article>')


def _chart_html(w: dict, source: dict, result: dict | None, columns: int) -> str:
    e = html.escape
    span = min(w.get("span", 1), columns)
    body, data = _problem(w, source, result), ""
    if not body:
        try:
            spec = _chart_spec(w, result)
        except DashboardError as error:
            body = _state("error", "This chart can't be drawn", str(error))
        else:
            body = _plot(spec, columns, span, w["title"])
            unit = w["chart"].get("unit", "")
            specs = [(k, _pretty(c), unit if any(isinstance(r[k], (int, float)) for r in result["rows"]) and k != 0
                      else "") for k, c in enumerate(result["columns"])]
            data = f'<div class="tw">{_data_table(result["columns"], result["rows"], specs, limit=60)}</div>'
    cls = f" s{span}" if span > 1 else ""
    return (f'<article class="w chart{cls}"><h2 class="wt">{e(w["title"])}</h2>{body}'
            f'{_footer(w, source, result, data=data)}</article>')


def _table_html(w: dict, source: dict, result: dict | None, columns: int) -> str:
    e = html.escape
    span = min(w.get("span", 1), columns)
    body = _problem(w, source, result)
    if not body:
        try:
            specs = _shape(w, result)
        except DashboardError as error:
            body = _state("error", "This table can't be shown", str(error))
        else:
            body = f'<div class="tw">{_data_table(result["columns"], result["rows"], specs)}</div>'
            if result.get("more"):
                body += f'<div class="more">The first {len(result["rows"])} rows. Add LIMIT or aggregate for fewer.</div>'
    cls = f" s{span}" if span > 1 else ""
    return (f'<article class="w tbl{cls}"><h2 class="wt">{e(w["title"])}</h2>{body}'
            f'{_footer(w, source, result)}</article>')


def _render_result(result) -> dict | None:
    """Keep a damaged saved result local to its widget, without rewriting the cache."""
    def valid_cell(value):
        if value is None or isinstance(value, (str, bool)):
            return True
        if isinstance(value, (int, float)):
            try:
                return math.isfinite(value)
            except OverflowError:
                pass
        return False

    if not isinstance(result, dict):
        return None
    columns, rows = result.get("columns", []), result.get("rows", [])
    valid = (isinstance(columns, list) and len(columns) <= MAX_COLUMNS
             and all(isinstance(c, str) and len(c) <= MAX_CELL for c in columns)
             and isinstance(rows, list) and len(rows) <= MAX_ROWS
             and all(isinstance(row, list) and len(row) == len(columns)
                     and all(valid_cell(v) and (not isinstance(v, str) or len(v) <= MAX_CELL)
                             for v in row) for row in rows)
             and all(result.get(key) is None or (isinstance(result[key], str) and len(result[key]) <= 2_000)
                     for key in ("error", "blocked", "refreshed_at"))
             and ("more" not in result or isinstance(result["more"], bool))
             and ("ms" not in result or (valid_cell(result["ms"])
                                         and isinstance(result["ms"], (int, float))
                                         and not isinstance(result["ms"], bool))))
    if not valid:
        return {"error": "Saved data for this widget couldn't be read. Refresh the dashboard to try again."}
    return result


def render_html(dashboard, results, *, nonce: str | None = None, title: str = "") -> str:
    """The dashboard as one page, from ``refresh``'s results: number tiles (with their change against the compare
    column, up or down, coloured by whether that's better), charts, tables; each widget with when it was refreshed
    and a "Show query" that holds its exact query. A widget over a source that isn't allowed asks for it; one that
    failed shows why. Light and dark from the system's setting; nothing loaded from anywhere; no script."""
    d = normalize(dashboard)
    results = results if isinstance(results, dict) else {}
    results = {w["id"]: _render_result(results.get(w["id"])) for w in d["widgets"]}
    nonce = nonce or secrets.token_urlsafe(16)
    if not re.fullmatch(r"[A-Za-z0-9+/=_\-]{8,128}", nonce):
        raise DashboardError("nonce is 8 to 128 base64 characters.")
    e = html.escape
    sources = {s["id"]: s for s in d["sources"]}
    columns = d["layout"]["columns"]
    groups: list = []
    for w in d["widgets"]:
        group = "tiles" if w["kind"] == "number" else "grid"
        if groups and groups[-1][0] == group:
            groups[-1][1].append(w)
        else:
            groups.append((group, [w]))
    sections = []
    for group, widgets in groups:
        cards = []
        for w in widgets:
            result = results.get(w["id"]) if isinstance(results.get(w["id"]), dict) else None
            source = sources[w["source"]]
            if w["kind"] == "number":
                cards.append(_number_html(w, source, result))
            elif w["kind"] == "chart":
                cards.append(_chart_html(w, source, result, columns))
            else:
                cards.append(_table_html(w, source, result, columns))
        if group == "tiles":
            sections.append(f'<section class="tiles" aria-label="Key numbers">{"".join(cards)}</section>')
        else:
            sections.append(f'<section class="grid c{columns}">{"".join(cards)}</section>')
    stamps = [r.get("refreshed_at") for r in results.values() if isinstance(r, dict) and r.get("refreshed_at")
              and not r.get("blocked")]
    name = title or d.get("title") or "Dashboard"
    meta = []
    if stamps:
        meta.append(f'<span class="pill"><i></i>Refreshed {e(_when(max(stamps)))}</span>')
    else:
        meta.append('<span class="pill">Not refreshed yet</span>')
    meta.append(f'<span class="pill">{len(d["sources"])} source{"s" if len(d["sources"]) != 1 else ""} · '
                'read-only</span>')
    sub = f'<p class="sub">{e(d["description"])}</p>' if d.get("description") else ""
    policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<meta http-equiv="Content-Security-Policy" content="{policy}">'
            f'<title>{e(name)}</title><style nonce="{nonce}">{_CSS}</style></head><body><main class="wrap">'
            f'<header class="hd"><div><h1>{e(name)}</h1>{sub}</div><div class="meta">{"".join(meta)}</div></header>'
            f'{"".join(sections)}</main></body></html>')


# =========================================================================== edits

def apply_edits(dashboard, edits) -> dict:
    """The dashboard after ``edits``, in order; nothing changes unless every edit applies.

    - {"op": "add_widget", "widget": {…}, "at": 1} (at: its place, from 1; the end unless given)
    - {"op": "change_widget", "id": "revenue", "set": {"title": "…", "query": "SELECT …"}} (null removes a field)
    - {"op": "remove_widget", "id": "revenue"}; {"op": "move_widget", "id": "revenue", "to": 1}
    - {"op": "add_source", "source": {…}}; {"op": "change_source", "id": "shop", "set": {"path": "…"}};
      {"op": "remove_source", "id": "shop"} (once no widget reads it)
    - {"op": "layout", "columns": 3}; {"op": "title", "title": "…", "description": "…"}
    """
    current = normalize(dashboard)
    if isinstance(edits, dict):
        edits = [edits]
    if not isinstance(edits, list) or not edits:
        raise DashboardError('Give the edits as a list: [{"op": "change_widget", "id": "revenue", "set": {"title": '
                             f'"Revenue"}}}}]. The ops are {", ".join(EDIT_OPS)}.')
    if len(edits) > MAX_EDITS:
        raise DashboardError(f"That's {len(edits)} edits; make at most {MAX_EDITS} at once, or give the whole "
                             "dashboard.")
    d = copy.deepcopy(current)
    allowed = {"add_widget": ("widget", "at"), "change_widget": ("id", "set"), "remove_widget": ("id",),
               "move_widget": ("id", "to"), "add_source": ("source",), "change_source": ("id", "set"),
               "remove_source": ("id",), "layout": ("columns",), "title": ("title", "description")}
    for i, edit in enumerate(edits, 1):
        if not isinstance(edit, dict):
            raise DashboardError(f'Edit {i} should be an object like {{"op": "remove_widget", "id": "revenue"}}.')
        op = str(edit.get("op") or "").strip().lower()
        label = f"Edit {i} ({op})" if op else f"Edit {i}"
        if op not in allowed:
            raise DashboardError(f'Edit {i}\'s op is one of {", ".join(EDIT_OPS)}; "{op[:20]}" isn\'t.')
        for key in edit:
            if key != "op" and key not in allowed[op]:
                fields = ", ".join(f'"{k}"' for k in allowed[op])
                raise DashboardError(f'{label} has "{str(key)[:20]}"; a {op} edit has {fields}.')
        try:
            _edit(d, op, edit)
            normalize(d)
        except DashboardError as error:
            text = str(error)
            raise DashboardError(text if text.startswith(label) else f"{label}: {text}") from None
    return normalize(d)


def _find(items: list, wid, what: str) -> int:
    for k, item in enumerate(items):
        if item.get("id") == wid:
            return k
    names = ", ".join(f"“{x['id']}”" for x in items) or "none"
    raise DashboardError(f"there's no {what} “{str(wid)[:40]}”; the {what}s are {names}.")


def _merge(item: dict, changes) -> dict:
    if not isinstance(changes, dict) or not changes:
        raise DashboardError('"set" is an object of the fields to change, like {"title": "Revenue"} (null removes '
                             'one).')
    if "id" in changes and changes["id"] != item.get("id"):
        raise DashboardError("an id stays as it is; remove this one and add a new one to rename it.")
    out = dict(item)
    for key, value in changes.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


def _edit(d: dict, op: str, edit: dict) -> None:
    widgets, sources = d["widgets"], d["sources"]
    if op == "add_widget":
        if not isinstance(edit.get("widget"), dict):
            raise DashboardError('give the new widget: "widget": {"id", "kind", "title", "source", "query", …}.')
        at = edit.get("at", len(widgets) + 1)
        if isinstance(at, bool) or not isinstance(at, int) or not 1 <= at <= len(widgets) + 1:
            raise DashboardError(f"at is the widget's place: 1 to {len(widgets) + 1}.")
        widgets.insert(at - 1, edit["widget"])
    elif op == "change_widget":
        k = _find(widgets, edit.get("id"), "widget")
        changed = _merge(widgets[k], edit.get("set"))
        if changed.get("kind") != widgets[k].get("kind"):
            for key in ("chart", "value", "label", "compare", "unit", "better", "columns"):
                if key not in (edit.get("set") or {}):
                    changed.pop(key, None)
        widgets[k] = changed
    elif op == "remove_widget":
        k = _find(widgets, edit.get("id"), "widget")
        if len(widgets) == 1:
            raise DashboardError("that's the dashboard's only widget; a dashboard keeps at least one.")
        del widgets[k]
    elif op == "move_widget":
        k = _find(widgets, edit.get("id"), "widget")
        to = edit.get("to")
        if isinstance(to, bool) or not isinstance(to, int) or not 1 <= to <= len(widgets):
            raise DashboardError(f"to is the widget's new place: 1 to {len(widgets)}.")
        widgets.insert(to - 1, widgets.pop(k))
    elif op == "add_source":
        if not isinstance(edit.get("source"), dict):
            raise DashboardError('give the new source: "source": {"id", "kind", "path" or "server"}.')
        sources.append(edit["source"])
    elif op == "change_source":
        k = _find(sources, edit.get("id"), "source")
        sources[k] = _merge(sources[k], edit.get("set"))
    elif op == "remove_source":
        k = _find(sources, edit.get("id"), "source")
        users = [w["id"] for w in widgets if w.get("source") == sources[k]["id"]]
        if users:
            raise DashboardError(f"widgets still read it ({', '.join(users)}); remove them or point them at another "
                                 "source first.")
        del sources[k]
    elif op == "layout":
        d["layout"] = {"columns": edit.get("columns")}
    else:
        for key in ("title", "description"):
            if key in edit:
                if edit[key] in (None, ""):
                    d.pop(key, None)
                else:
                    d[key] = edit[key]


# =========================================================================== what the model reads back

def outline(dashboard) -> str:
    """The dashboard as the model reads it before editing: its data, and the table each file source's queries
    read (a file's table is named after it)."""
    d = normalize(dashboard)
    lines = [json.dumps(d, ensure_ascii=False, indent=1)]
    notes = []
    for s in d["sources"]:
        if s["kind"] == "file":
            stem = re.sub(r"\.(csv|tsv|xlsx)$", "", Path(s["path"]).name, flags=re.I)
            table = tabledata._ident(stem, set(), "data")
            extra = " (a workbook's sheets are " + table + "_<sheet>)" if s["path"].lower().endswith(".xlsx") else ""
            notes.append(f"- {s['id']}: queries read the table {table}{extra}.")
        elif s["kind"] == "plugin":
            notes.append(f"- {s['id']}: a widget's query is a call to one of {s['server']}'s read-only tools: "
                         '{"tool", "args", "path"}.')
    if notes:
        lines += ["", "Sources:"] + notes
    return "\n".join(lines)
