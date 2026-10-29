"""Real artifacts for the artifact panel's tests and captures (test/support/artifact-scene.mjs): a deck, a workbook and a
dashboard as dgc/artifact_slides.py, artifact_sheet.py and artifact_dashboard.py normalize them, and DGC's own page of
each as the artifact server would serve it. Prints one JSON object. Writes only into the folder it is given (the
dashboard's SQLite database, which it then refreshes from); the caller removes that folder. Not a test file.

    python artifact-fixture.py FOLDER
"""
import json
import sqlite3
import sys
from pathlib import Path

from dgc import artifact_dashboard as dashboard
from dgc import artifact_service as service
from dgc import artifact_sheet as sheet
from dgc import artifact_slides as slides

DECK = {"theme": "dusk", "slides": [
    {"layout": "title", "title": "Q3 plan", "subtitle": "What we ship, and what it costs", "notes": "Open with the headline."},
    {"layout": "bullets", "title": "Where we are", "bullets": ["Revenue up 18% on Q2", {"text": "Two launches slipped", "sub": ["Search", "Billing v2"]},
                                                               "Hiring on plan"]},
    {"layout": "two_columns", "title": "Build or buy", "left": {"heading": "Build", "bullets": ["Fits our stack", "Six weeks"]},
     "right": {"heading": "Buy", "bullets": ["Live next week", "₹4L a year"]}},
    {"layout": "table", "title": "Budget", "table": {"columns": ["Item", "Q3", "Q4"], "rows": [["Cloud", 120, 140], ["People", 900, 960]]}},
    {"layout": "quote", "quote": {"text": "Ship the smallest thing that's true.", "by": "The team"}},
    {"layout": "closing", "title": "Questions?"},
]}

BOOK = {"sheets": [
    {"name": "Budget", "columns": [{"name": "Item", "type": "text"}, {"name": "Planned", "type": "currency", "currency": "₹"},
                                   {"name": "Actual", "type": "currency", "currency": "₹"}, {"name": "Gap", "type": "currency", "currency": "₹"}],
     "rows": [["Rent", 45000, 45000, "=C2-B2"], ["Groceries", 18000, 21000, "=C3-B3"], ["Power", 4200, 3900, "=C4-B4"],
              ["Travel", 9000, 12500, "=C5-B5"], ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)"]], "frozen": 1},
    {"name": "Notes", "columns": [{"name": "Note", "type": "text"}, {"name": "Done", "type": "bool"}],
     "rows": [["Ask for the power bill", True], ["Book the trip", False]], "frozen": 1},
]}


def board(db: str) -> dict:
    return {"title": "Store sales", "layout": {"columns": 2},
            "sources": [{"id": "shop", "kind": "sqlite", "path": db, "label": "Shop database"},
                        {"id": "ads", "kind": "file", "path": str(Path(db).with_name("ads.csv")), "label": "Ad spend"}],
            "widgets": [{"id": "revenue", "kind": "number", "title": "Revenue", "source": "shop",
                         "query": "SELECT SUM(total) AS revenue FROM orders", "value": "revenue", "unit": "₹"},
                        {"id": "orders", "kind": "number", "title": "Orders", "source": "shop",
                         "query": "SELECT COUNT(*) AS orders FROM orders", "value": "orders"},
                        {"id": "by_month", "kind": "chart", "title": "Revenue by month", "source": "shop",
                         "query": "SELECT month, SUM(total) AS revenue FROM orders GROUP BY month ORDER BY month",
                         "chart": {"type": "bar", "x": "month", "series": ["revenue"], "unit": "₹"}},
                        {"id": "spend", "kind": "table", "title": "Ad spend", "source": "ads", "query": "SELECT * FROM ads"}]}


def view(aid: str, type_: str, title: str, versions: int, surface: str, **extra) -> dict:
    out = {"id": aid, "type": type_, "label": service.LABELS[type_], "title": title, "version": versions,
           "created": "2026-10-27T09:12:00Z", "updated": "2026-10-28T08:40:00Z", "origin": {"surface": surface},
           "exports": list(service.EXPORTS[type_]),
           "versions": [{"n": n, "author": "DGC" if n % 2 else "you", "at": f"2026-10-2{7 + (n > 1)}T0{n}:15:00Z",
                         "summary": "Made" if n == 1 else ("Your edits" if n % 2 == 0 else "Added the budget slide"), "size": 2048 * n}
                        for n in range(1, versions + 1)]}
    out.update(extra)
    return out


def main(folder: str) -> None:
    root = Path(folder)
    db = root / "shop.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE orders (id INTEGER, month TEXT, total REAL)")
        conn.executemany("INSERT INTO orders VALUES (?,?,?)", [(1, "2026-07", 42000), (2, "2026-07", 18000), (3, "2026-08", 51000),
                                                              (4, "2026-09", 64000), (5, "2026-09", 12000)])
    (root / "ads.csv").write_text("channel,spend\nSearch,12000\nSocial,8000\n", encoding="utf-8")
    deck = slides.normalize(DECK)
    book = sheet.normalize(BOOK)
    dash = dashboard.normalize(board(str(db)))
    results = dashboard.refresh(dash, allowed=["shop"], project_root=str(root), now=None)
    out = {
        "slides": {"view": view("ar_" + "1" * 16, "slides", "Q3 plan", 3, "chat"), "content": deck,
                   "html": slides.render_html(deck, mode="view", title="Q3 plan")},
        "sheet": {"view": view("ar_" + "2" * 16, "sheet", "Home budget", 2, "work"), "content": book,
                  "html": sheet.render_html(book, title="Home budget")},
        "dashboard": {"view": view("ar_" + "3" * 16, "dashboard", "Store sales", 1, "pip"), "content": dash,
                      "state": {"results": results, "version": 1},
                      "html": dashboard.render_html(dash, results, title="Store sales")},
        "page": {"view": view("ar_" + "4" * 16, "page", "Tip calculator", 1, "work")},
        "doc": {"view": view("ar_" + "5" * 16, "doc", "Launch notes", 2, "work", file=str(root / "ar_5555555555555555" / "work" / "Launch notes.md"))},
    }
    out["dashboard"]["three_column_html"] = dashboard.render_html(
        {**dash, "layout": {"columns": 3}}, results, title="Store sales")
    # Capture a real comparison from saved versions, alongside the pages the browser scenes use.
    from dgc.artifact_store import Store
    comparison_store = Store(root / "comparisons")
    comparison_doc = comparison_store.create("doc", "Launch notes", "Ship Friday.\n", origin={"surface": "cli"})
    comparison_store.update(comparison_doc.id, "Ship Monday.\n")
    out["comparison_event"] = {"type": "artifact_comparison", "seq": 1,
                               "comparison": service.compare(comparison_doc.id, 1, 2, store=comparison_store)}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])
