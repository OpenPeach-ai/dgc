"""Dashboard artifacts: widgets over data the user allowed, refreshed on this computer with no model.

What matters: nothing a dashboard runs can change data (a query that writes is refused before it runs, and the
database refuses it again if it got past); a SQLite file is byte-for-byte the same after a refresh; a source the
user hasn't allowed is never read and a plugin tool that isn't read-only is never called; Postgres is reached only
through the project's read-only account, with the password off psql's command line; one failing widget never stops
the rest; the page loads nothing, runs no script, and turns nothing from the data into markup.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_dashboard as D
from dgc import artifact_service as service
from dgc import readonly_database
from dgc.artifact_dashboard import DashboardError
from dgc.artifact_store import Store

NOW = datetime(2026, 10, 28, 4, 10, tzinfo=timezone.utc)


def _shop(path: Path) -> None:
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE orders (id INTEGER PRIMARY KEY, placed TEXT, region TEXT, total INTEGER, status TEXT);
        INSERT INTO orders VALUES (1, '2026-09-03', 'North', 1200, 'delivered'), (2, '2026-09-17', 'South', 800,
          'refunded'), (3, '2026-10-02', 'North', 2150, 'delivered'), (4, '2026-10-09', 'West', 640, 'delivered'),
          (5, '2026-10-20', 'South', 3900, 'delivered'), (6, '2026-10-25', 'West', 1100, 'refunded');
    """)
    db.commit()
    db.close()


def _dashboard() -> dict:
    return {"title": "Store sales", "layout": {"columns": 2},
            "sources": [{"id": "shop", "kind": "sqlite", "label": "shop.db", "path": "data/shop.db"},
                        {"id": "targets", "kind": "file", "path": "data/targets.csv"}],
            "widgets": [
                {"id": "revenue", "kind": "number", "title": "Revenue in October", "source": "shop", "unit": "₹",
                 "value": "october", "compare": "september", "label": "vs September",
                 "query": "SELECT SUM(CASE WHEN placed LIKE '2026-10-%' THEN total END) AS october,\n"
                          "       SUM(CASE WHEN placed LIKE '2026-09-%' THEN total END) AS september\n"
                          "FROM orders WHERE status = 'delivered'"},
                {"id": "refunds", "kind": "number", "title": "Refunds", "source": "shop", "better": "down",
                 "value": "now", "compare": "before",
                 "query": "SELECT 1 AS now, 2 AS before"},
                {"id": "by_region", "kind": "chart", "title": "Revenue by region", "source": "shop",
                 "chart": {"type": "bar", "x": "region", "series": [{"column": "revenue", "name": "Revenue"}],
                           "unit": "₹"},
                 "query": "SELECT region, SUM(total) AS revenue FROM orders GROUP BY region ORDER BY region"},
                {"id": "vs_target", "kind": "chart", "title": "Against target", "source": "targets",
                 "chart": {"type": "line", "x": "month"},
                 "query": "SELECT month, target, actual FROM targets ORDER BY month"},
                {"id": "latest", "kind": "table", "title": "Latest orders", "source": "shop", "span": 2,
                 "columns": ["placed", "region", {"column": "total", "label": "Total", "unit": "₹"}],
                 "query": "SELECT placed, region, total FROM orders ORDER BY placed DESC LIMIT 5"}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(os.path.realpath(self.tmp.name)) / "store"
        (self.project / "data").mkdir(parents=True)
        self.db = self.project / "data" / "shop.db"
        _shop(self.db)
        (self.project / "data" / "targets.csv").write_text(
            "Month,Target,Actual\n2026-08,4000,3650\n2026-09,4200,4410\n2026-10,4500,4690\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def refresh(self, dashboard=None, allowed=("shop", "targets"), **kw):
        return D.refresh(dashboard or _dashboard(), allowed=list(allowed), project_root=self.project, now=NOW, **kw)


class ReadOnly(Base):
    def test_widget_source_must_be_a_source_id(self):
        for invalid in ([], {}, ["shop"]):
            with self.subTest(source=invalid):
                spec = _dashboard()
                spec["widgets"][0]["source"] = invalid
                with self.assertRaises(DashboardError):
                    D.normalize(spec)

    def test_file_size_limit_is_checked_on_the_open_file(self):
        path = self.project / "data" / "targets.csv"
        original = Path.stat
        def small_size(p, *args, **kwargs):
            result = original(p, *args, **kwargs)
            if p == path:
                fields = list(result)
                fields[6] = 1
                return os.stat_result(fields)
            return result
        reader = D._Sources(self.project, None, None)
        try:
            with mock.patch.object(D, "MAX_FILE_BYTES", 32), mock.patch.object(Path, "stat", small_size):
                with self.assertRaises(DashboardError):
                    reader._file({"id": "targets", "path": "data/targets.csv"}, "SELECT * FROM targets")
        finally:
            reader.close()

    def test_a_query_that_writes_or_does_more_than_one_thing_is_refused_before_it_runs(self):
        refused = {"INSERT INTO orders VALUES (9, 'x', 'y', 1, 'z')": "starts with “INSERT”",
                   "UPDATE orders SET total = 0": "starts with “UPDATE”",
                   "DELETE FROM orders": "starts with “DELETE”",
                   "ATTACH DATABASE '/tmp/x.db' AS x": "starts with “ATTACH”",
                   "PRAGMA writable_schema = 1": "starts with “PRAGMA”",
                   "SELECT 1; DROP TABLE orders": "has a “;” inside it",
                   "SELECT * FROM orders;\nDELETE FROM orders;": "has a “;” inside it",
                   "SELECT region FROM orders WHERE note = 'a;b'": "even in quotes",
                   "WITH x AS (SELECT 1) INSERT INTO orders SELECT * FROM x": "“INSERT”",
                   "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d": "“DELETE”",
                   "SELECT * INTO copy FROM orders": "“INTO”",
                   "SELECT * FROM orders FOR UPDATE": "“UPDATE”",
                   "/* report */ DROP TABLE orders": "starts with “DROP”",
                   "": "needs its SQL"}
        for sql, words in refused.items():
            with self.subTest(sql), self.assertRaises(DashboardError) as caught:
                D.check_query(sql)
            self.assertIn(words, str(caught.exception))
        for sql in ("SELECT region FROM orders WHERE status = 'deleted, update later'",
                    "-- by region\nSELECT region, COUNT(*) FROM orders GROUP BY 1;",
                    "WITH m AS (SELECT substr(placed, 1, 7) AS month, total FROM orders) SELECT month, SUM(total) "
                    "FROM m GROUP BY month", "SELECT deleted_at, \"update\" FROM audit", "(SELECT 1)"):
            with self.subTest(sql):
                self.assertTrue(D.check_query(sql).strip())
        with self.assertRaisesRegex(DashboardError, "Widget “w”'s query starts with “DELETE”"):
            D.normalize({"sources": [{"id": "s", "kind": "sqlite", "path": "x.db"}],
                         "widgets": [{"id": "w", "kind": "table", "title": "T", "source": "s",
                                      "query": "DELETE FROM orders"}]})

    def test_the_database_refuses_writes_even_past_the_check(self):
        conn = D.open_sqlite(self.db)
        try:
            for sql in ("INSERT INTO orders VALUES (9, 'x', 'y', 1, 'z')", "UPDATE orders SET total = 0",
                        "WITH x AS (SELECT 1) INSERT INTO orders (id) SELECT 99 FROM x",
                        f"ATTACH DATABASE '{self.project}/other.db' AS other", "PRAGMA writable_schema = 1",
                        "SELECT 1; DELETE FROM orders", "CREATE TABLE t (x)"):
                with self.subTest(sql), self.assertRaises(DashboardError) as caught:
                    D.run_sqlite(conn, sql)
                self.assertIn("didn't run", str(caught.exception))
            names, rows, more = D.run_sqlite(conn, "SELECT COUNT(*) AS n, SUM(total) AS t FROM orders")
            self.assertEqual((names, rows, more), (["n", "t"], [[6, 9790]], False))
        finally:
            conn.close()
        self.assertFalse((self.project / "other.db").exists(), "ATTACH made no file")

    def test_a_sqlite_file_is_unchanged_by_refresh(self):
        def snapshot():
            return (hashlib.sha256(self.db.read_bytes()).hexdigest(), self.db.stat().st_mtime_ns,
                    sorted(p.name for p in self.db.parent.iterdir()))
        before = snapshot()
        results = self.refresh()
        self.assertEqual(snapshot(), before, "same bytes, same time, and no journal or WAL file left beside it")
        self.assertIsNone(results["revenue"]["error"])

    def test_a_long_or_huge_query_is_capped(self):
        dash = {"sources": [{"id": "shop", "kind": "sqlite", "path": "data/shop.db"}],
                "widgets": [{"id": "many", "kind": "table", "title": "Many", "source": "shop",
                             "query": "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) "
                                      "SELECT i FROM n"}]}
        result = self.refresh(dash, allowed=["shop"])["many"]
        self.assertEqual((len(result["rows"]), result["more"]), (D.MAX_ROWS, True))
        with mock.patch.object(D, "QUERY_SECONDS", 0.2):
            slow = dict(dash, widgets=[dict(dash["widgets"][0], query="WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL "
                                            "SELECT i + 1 FROM n) SELECT COUNT(*) FROM n")])
            self.assertIn("took more than", self.refresh(slow, allowed=["shop"])["many"]["error"])

    def test_a_file_source_is_read_the_way_chatdgc_reads_it(self):
        result = self.refresh()["vs_target"]
        self.assertIsNone(result["error"])
        self.assertEqual(result["columns"], ["month", "target", "actual"])
        self.assertEqual(result["rows"][-1], ["2026-10", 4500, 4690])
        dash = _dashboard()
        dash["widgets"][3]["query"] = "SELECT * FROM target_sheet"
        self.assertIn("The file's table is targets", self.refresh(dash)["vs_target"]["error"])


class Allowing(Base):
    def test_a_source_the_user_hasnt_allowed_is_never_read(self):
        calls = []
        dash = {"sources": [{"id": "gh", "kind": "plugin", "server": "github"},
                            {"id": "shop", "kind": "sqlite", "path": "data/shop.db"}],
                "widgets": [{"id": "bugs", "kind": "number", "title": "Open bugs", "source": "gh",
                             "query": {"tool": "search_issues", "args": {"q": "is:open"}, "path": "total_count"}},
                            {"id": "n", "kind": "number", "title": "Orders", "source": "shop",
                             "query": "SELECT COUNT(*) FROM orders"}]}
        with mock.patch.object(D, "open_sqlite", side_effect=AssertionError("read a source not allowed")):
            results = D.refresh(dash, allowed=[], project_root=self.project, now=NOW,
                                call=lambda *a: calls.append(a) or {"total_count": 3},
                                is_read_only=lambda server, tool: True)
        self.assertEqual(calls, [])
        self.assertEqual((results["bugs"]["blocked"], results["bugs"]["error"]), ("gh", "Allow github to show this."))
        self.assertEqual(results["n"]["blocked"], "shop")
        allowed = D.refresh(dash, allowed=["gh"], project_root=self.project, now=NOW,
                            call=lambda *a: calls.append(a) or {"total_count": 3}, is_read_only=lambda s, t: True)
        self.assertEqual((allowed["bugs"]["rows"], allowed["n"]["blocked"]), ([[3]], "shop"))
        self.assertEqual(calls, [("github", "search_issues", {"q": "is:open"})])

    def test_which_sources_are_allowed_is_the_hosts_never_the_dashboards(self):
        with self.assertRaisesRegex(DashboardError, "the user allows each one, once"):
            D.normalize(dict(_dashboard(), allowed=["shop"]))
        with self.assertRaisesRegex(DashboardError, "dgc readonly-db set"):
            D.normalize({"sources": [{"id": "db", "kind": "postgres", "url": "postgresql://u:p@localhost/x"}],
                         "widgets": [{"id": "w", "kind": "table", "title": "T", "query": "SELECT 1"}]})

    def test_a_source_pointed_at_other_data_is_named_so_its_allowance_can_go(self):
        before = _dashboard()
        moved = D.apply_edits(before, [{"op": "change_source", "id": "shop", "set": {"path": "data/other.db"}},
                                       {"op": "change_source", "id": "targets", "set": {"label": "Targets"}}])
        self.assertEqual(D.changed_sources(before, moved), ["shop"], "a new label reads the same data")


class Plugins(Base):
    DASH = {"sources": [{"id": "gh", "kind": "plugin", "server": "github"}],
            "widgets": [{"id": "w", "kind": "table", "title": "Issues", "source": "gh",
                         "query": {"tool": "create_issue", "args": {"title": "x"}, "path": "items"}}]}

    def test_a_tool_that_isnt_read_only_is_refused_and_never_called(self):
        calls = []
        for answer in (lambda s, t: False, lambda s, t: 1 / 0, None):
            results = D.refresh(self.DASH, allowed=["gh"], project_root=self.project, now=NOW,
                                call=lambda *a: calls.append(a), is_read_only=answer)
            self.assertRegex(results["w"]["error"], "isn't marked read-only|can't be called here")
        self.assertEqual(calls, [])

    def test_rows_are_picked_out_of_the_result_by_a_json_path(self):
        dash = json.loads(json.dumps(self.DASH))
        dash["widgets"][0]["query"] = {"tool": "list_issues", "args": {"state": "open"}, "path": "$.data.items[*].fields"}
        mcp = {"content": [{"type": "text", "text": json.dumps({"data": {"items": [
            {"fields": {"title": "Crash on save", "comments": 4, "labels": ["bug"]}},
            {"fields": {"title": "Slow start", "comments": 1}}]}})}]}
        result = D.refresh(dash, allowed=["gh"], project_root=self.project, now=NOW, call=lambda *a: mcp,
                           is_read_only=lambda s, t: t == "list_issues")["w"]
        self.assertEqual(result["columns"], ["title", "comments", "labels"])
        self.assertEqual(result["rows"], [["Crash on save", 4, '["bug"]'], ["Slow start", 1, None]])
        dash["widgets"][0]["query"]["path"] = "data.issues"
        missing = D.refresh(dash, allowed=["gh"], project_root=self.project, now=NOW, call=lambda *a: mcp,
                            is_read_only=lambda s, t: True)["w"]["error"]
        self.assertIn("no “issues” on the way to “data.issues”; the keys there are items", missing)
        self.assertEqual(D.table_of([["region", "total"], ["North", 4]]), (["region", "total"], [["North", 4]]))
        self.assertEqual(D.select({"structuredContent": 1}, ""), {"structuredContent": 1})
        self.assertEqual(D._unwrap({"structuredContent": {"n": 2}}), {"n": 2})


class Postgres(Base):
    ACCOUNT = readonly_database.parse("postgresql://dgc_readonly:s3cret%21pw@localhost:5433/sales")

    def fake_psql(self, body: str) -> Path:
        path = Path(self.tmp.name) / "psql"
        path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_without_psql_or_an_account_it_says_how_to_set_it_up(self):
        with mock.patch("shutil.which", return_value=None):
            with self.assertRaisesRegex(DashboardError, "psql program, which isn't installed.*dgc readonly-db set"):
                D.run_postgres("SELECT 1", self.project)
        psql = self.fake_psql("exit 0\n")
        with mock.patch.object(readonly_database, "load", return_value=None):
            with self.assertRaisesRegex(DashboardError, "no read-only database account.*`dgc readonly-db set`"):
                D.run_postgres("SELECT 1", self.project, psql=str(psql))
        dash = {"sources": [{"id": "db", "kind": "postgres"}],
                "widgets": [{"id": "w", "kind": "number", "title": "N", "source": "db", "query": "SELECT 1"}]}
        with mock.patch("shutil.which", return_value=None):
            self.assertIn("dgc readonly-db set", self.refresh(dash, allowed=["db"])["w"]["error"])

    def test_psql_runs_read_only_and_the_password_stays_off_its_command_line(self):
        record = Path(self.tmp.name) / "record.json"
        psql = self.fake_psql(
            f'python3 -c \'import json, os, sys; json.dump({{"argv": sys.argv[1:], "options": os.environ.get('
            f'"PGOPTIONS"), "password": os.environ.get("PGPASSWORD")}}, open("{record}", "w"))\' "$@"\n'
            "printf 'region,total,code,note\\nNorth,2150.5,007,\\\\N\\nSouth,3900,012,\"a, b\"\\n'\n")
        with mock.patch.object(readonly_database, "load", return_value=self.ACCOUNT):
            names, rows, more = D.run_postgres("SELECT region, total, code, note FROM sales", self.project,
                                               psql=str(psql))
        seen = json.loads(record.read_text())
        self.assertEqual(names, ["region", "total", "code", "note"])
        self.assertEqual(rows, [["North", 2150.5, "007", None], ["South", 3900, "012", "a, b"]],
                         "numbers become numbers, a code keeps its zero, NULL is null")
        self.assertFalse(more)
        self.assertIn("--csv", seen["argv"])
        self.assertIn("--no-psqlrc", seen["argv"])
        self.assertIn("SELECT * FROM (\nSELECT region, total, code, note FROM sales\n) AS dgc_widget LIMIT 201",
                      seen["argv"])
        self.assertNotIn("s3cret", " ".join(seen["argv"]))
        self.assertEqual(seen["password"], "s3cret!pw")
        self.assertIn("default_transaction_read_only=on", seen["options"])
        self.assertIn("statement_timeout=5000", seen["options"])

    def test_postgres_saying_no_is_shown_on_the_widget(self):
        psql = self.fake_psql("echo 'ERROR:  cannot execute INSERT in a read-only transaction' >&2\nexit 1\n")
        with mock.patch.object(readonly_database, "load", return_value=self.ACCOUNT):
            with self.assertRaisesRegex(DashboardError, "Postgres said: cannot execute INSERT in a read-only "
                                                        r"transaction \(a dashboard only reads\)"):
                D.run_postgres("SELECT 1", self.project, psql=str(psql))

    def test_postgres_output_is_bounded_before_csv_materialization(self):
        psql = self.fake_psql("python3 -c 'import sys; sys.stdout.write(\"x\" * 10000)'\n")
        with mock.patch.object(readonly_database, "load", return_value=self.ACCOUNT), \
                mock.patch.object(D, "MAX_PSQL_OUTPUT_BYTES", 1024):
            with self.assertRaisesRegex(DashboardError, "result is too large"):
                D.run_postgres("SELECT 1", self.project, psql=str(psql))


class Refresh(Base):
    def test_one_failing_widget_leaves_the_rest_working(self):
        dash = _dashboard()
        dash["sources"].append({"id": "gone", "kind": "sqlite", "path": "data/missing.db"})
        dash["widgets"] += [
            {"id": "typo", "kind": "table", "title": "Typo", "source": "shop", "query": "SELECT nope FROM orders"},
            {"id": "lost", "kind": "number", "title": "Lost", "source": "gone", "query": "SELECT 1"},
            {"id": "lost2", "kind": "number", "title": "Lost too", "source": "gone", "query": "SELECT 2"},
            {"id": "too_many", "kind": "chart", "title": "Too many", "source": "shop",
             "chart": {"type": "bar", "x": "i"},
             "query": "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 90) "
                      "SELECT i, i * 2 AS v FROM n"},
            {"id": "bad_col", "kind": "number", "title": "Bad column", "source": "shop", "value": "missing",
             "query": "SELECT 1 AS present"}]
        results = self.refresh(dash, allowed=["shop", "targets", "gone"])
        self.assertIn("no such column: nope", results["typo"]["error"])
        self.assertIn("isn't there", results["lost"]["error"])
        self.assertEqual(results["lost"]["error"], results["lost2"]["error"])
        self.assertIn("a chart shows at most 60", results["too_many"]["error"])
        self.assertIn("no column “missing”", results["bad_col"]["error"])
        for wid in ("revenue", "refunds", "by_region", "vs_target", "latest"):
            self.assertIsNone(results[wid]["error"], wid)
        self.assertEqual(results["revenue"]["rows"], [[6690, 1200]])
        self.assertEqual(results["revenue"]["refreshed_at"], "2026-10-28T04:10:00Z")
        self.assertEqual(json.loads(json.dumps(results)), results, "results are plain JSON, kept beside the artifact")

    def test_a_relative_path_needs_its_project(self):
        results = D.refresh(_dashboard(), allowed=["shop"], project_root=None, now=NOW)
        self.assertIn("refreshed without its project", results["revenue"]["error"])


class Page(Base):
    def test_a_damaged_cached_widget_does_not_hide_the_other_widgets(self):
        import copy
        saved = self.refresh()
        mutations = ({"columns": None}, {"columns": [7]}, {"rows": [None]},
                     {"rows": [[1]]}, {"rows": [[{}, 2]]}, {"error": {"message": "bad"}},
                     {"refreshed_at": ["invalid"]}, {"rows": [[10 ** 400, 2]]})
        for change in mutations:
            with self.subTest(change=change):
                results = copy.deepcopy(saved)
                results["revenue"].update(change)
                before = copy.deepcopy(results)
                page = D.render_html(_dashboard(), results)
                self.assertIn("Saved data for this widget", page)
                self.assertIn("Latest orders", page)
                self.assertIn("2026-10-25", page)
                self.assertEqual(results, before, "rendering does not rewrite cached data")

    def test_the_page_loads_nothing_and_runs_no_script(self):
        page = D.render_html(_dashboard(), self.refresh(), nonce="abcDEF123456")
        policy = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', page).group(1)
        self.assertIn("default-src 'none'", policy)
        self.assertNotIn("script-src", policy)
        self.assertNotIn("<script", page)
        self.assertIsNone(re.search(r"(src|href)=\"?(https?:)?//", page))
        self.assertIn('<style nonce="abcDEF123456">', page)

    def test_tiles_charts_and_tables_with_when_and_the_exact_query(self):
        dash = _dashboard()
        # On the day it ran, so the page says the time alone (any other day it says the date too).
        class Today(datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW.astimezone(tz) if tz else NOW.astimezone().replace(tzinfo=None)
        with mock.patch.object(D, "datetime", Today):
            page = D.render_html(dash, self.refresh())
        local = NOW.astimezone().strftime("%H:%M")
        self.assertEqual(page.count(f"Refreshed {local}</span>"), 5 + 1, "every widget says when it ran, and the "
                                                                          "page when the last one did")
        self.assertIn('<div class="big">₹6,690</div>', page)
        self.assertIn("+457.5%", page)
        self.assertIn('class="chg good"', page)
        self.assertIn('class="chg good" aria-label="−50.0%, better"', page, "falling refunds are good news")
        self.assertEqual(page.count('<svg class="v-'), 2 * 2 * 2, "two charts, light and dark, wide and narrow")
        self.assertEqual(page.count('role="img" aria-label="Revenue by region"'), 4, "drawn by Slides' chart_svg")
        self.assertIn("SELECT region, SUM(total) AS revenue FROM orders GROUP BY region ORDER BY region", page)
        self.assertIn("&#x27;2026-10-%&#x27;", page, "the query is shown exactly, escaped")
        self.assertIn('<td class="n">₹3,900</td>', page)
        self.assertIn("<title>Store sales</title>", page)
        self.assertIn(">Target</text>", page, "series names from the columns")
        self.assertIn(">Aug</text>", page, "2026-08 reads as a month")

    def test_widgets_that_cant_show_their_data_say_why(self):
        dash = _dashboard()
        dash["widgets"].append({"id": "empty", "kind": "table", "title": "November", "source": "shop",
                                "query": "SELECT * FROM orders WHERE placed LIKE '2026-11-%'"})
        dash["widgets"].append({"id": "typo", "kind": "table", "title": "Typo", "source": "shop",
                                "query": "SELECT nope FROM orders"})
        page = D.render_html(dash, self.refresh(dash, allowed=["shop"]))
        self.assertIn("Allow data/targets.csv to show this", page)
        self.assertIn("This reads the file data/targets.csv, read-only. DGC asks once for this dashboard.", page)
        self.assertIn("No rows", page)
        self.assertIn("no such column: nope", page)
        self.assertIn("Not refreshed yet", D.render_html(dash, {}))

    def test_nothing_from_the_data_becomes_markup(self):
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO orders VALUES (7, '2026-10-26', '<img src=x onerror=alert(1)>', 10, 'delivered')")
        conn.commit()
        conn.close()
        dash = _dashboard()
        dash["title"] = "<script>alert(1)</script>"
        page = D.render_html(dash, self.refresh(dash))
        self.assertNotIn("<img src=x", page)
        self.assertNotIn("<script>alert", page)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", page)


class Edits(Base):
    def test_every_op_lands_where_it_says(self):
        tile = {"id": "aov", "kind": "number", "title": "Average order", "source": "shop",
                "query": "SELECT AVG(total) FROM orders"}
        d = D.apply_edits(_dashboard(), [
            {"op": "add_widget", "widget": tile, "at": 1},
            {"op": "change_widget", "id": "latest", "set": {"title": "Newest orders", "span": None}},
            {"op": "move_widget", "id": "latest", "to": 2},
            {"op": "remove_widget", "id": "refunds"},
            {"op": "add_source", "source": {"id": "gh", "kind": "plugin", "server": "github"}},
            {"op": "change_source", "id": "shop", "set": {"label": "Shop database"}},
            {"op": "remove_source", "id": "gh"},
            {"op": "layout", "columns": 3},
            {"op": "title", "title": "Sales, October", "description": "To 27 Oct."}])
        self.assertEqual([w["id"] for w in d["widgets"]], ["aov", "latest", "revenue", "by_region", "vs_target"])
        self.assertEqual(d["widgets"][1]["title"], "Newest orders")
        self.assertNotIn("span", d["widgets"][1])
        self.assertEqual(d["sources"][0]["label"], "Shop database")
        self.assertEqual([s["id"] for s in d["sources"]], ["shop", "targets"])
        self.assertEqual((d["layout"], d["title"], d["description"]), ({"columns": 3}, "Sales, October", "To 27 Oct."))
        self.assertEqual(D.normalize(d), d)
        kind = D.apply_edits(_dashboard(), [{"op": "change_widget", "id": "refunds",
                                             "set": {"kind": "table", "columns": ["now"]}}])
        self.assertEqual(set(kind["widgets"][1]), {"id", "kind", "title", "source", "query", "columns"})

    def test_a_bad_edit_says_which_and_why_and_changes_nothing(self):
        before = _dashboard()
        frozen = json.dumps(before, sort_keys=True)
        cases = [([{"op": "layout", "columns": 3}, {"op": "change_widget", "id": "latest",
                                                     "set": {"query": "DELETE FROM orders"}}], "Edit 2 (change_widget)"),
                 ([{"op": "remove_source", "id": "shop"}], "widgets still read it (revenue, refunds, by_region"),
                 ([{"op": "add_widget", "widget": dict(_dashboard()["widgets"][0])}], "Two widgets have the id"),
                 ([{"op": "change_widget", "id": "nope", "set": {"title": "x"}}], "no widget “nope”"),
                 ([{"op": "change_widget", "id": "latest", "set": {"id": "other"}}], "an id stays"),
                 ([{"op": "explode"}], "Edit 1's op is one of add_widget"),
                 ([{"op": "add_widget", "widget": {"id": "x", "kind": "chart", "title": "X", "source": "nowhere",
                                                   "query": "SELECT 1"}}], "Add the source first")]
        for edits, words in cases:
            with self.subTest(words), self.assertRaises(DashboardError) as caught:
                D.apply_edits(before, edits)
            self.assertIn(words, str(caught.exception))
        self.assertEqual(json.dumps(before, sort_keys=True), frozen)


class Service(Base):
    def test_made_allowed_refreshed_shown_and_exported_through_the_artifact_service(self):
        store = Store(Path(self.tmp.name) / "artifacts")
        origin = {"surface": "work", "session": "s", "project": str(self.project)}
        view = service.make("dashboard", "Store sales", _dashboard(), origin=origin, store=store)
        results = service.refresh(view["id"], project_root=self.project, store=store)
        self.assertEqual(results["revenue"]["blocked"], "shop")
        service.allow_source(view["id"], "shop", store=store)
        results = service.refresh(view["id"], project_root=self.project, store=store)
        self.assertIsNone(results["revenue"]["error"])
        files, entry = service.render(view["id"], store=store)
        self.assertIn("₹6,690", files[entry].decode())
        changed = service.edit(view["id"], edits=[{"op": "remove_widget", "id": "refunds"}], store=store)
        self.assertEqual(changed["version"], 2)
        self.assertTrue(service.export(view["id"], "html", store=store).read_text().startswith("<!doctype html>"))
        sheet = service.make("sheet", "Budget", {"sheets": [{"name": "B", "columns": ["Item", {"name": "Cost",
                                                                                          "type": "number"}],
                                                             "rows": [["Rent", 42000], ["Total", "=SUM(B2:B2)"]]}]},
                             origin=origin, store=store)
        self.assertTrue(service.export(sheet["id"], "xlsx", store=store).read_bytes().startswith(b"PK"))
        self.assertIn("Total,42000", service.export(sheet["id"], "csv", store=store).read_text(encoding="utf-8-sig"))
        self.assertIn("3: Total | =SUM(B2:B2) → 42,000", service.outline(sheet["id"], store=store))


if __name__ == "__main__":
    unittest.main()
