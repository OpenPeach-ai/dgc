"""Real artifacts for the artifact panel's tests and captures (test/support/artifact-scene.mjs): a deck, a workbook and a
dashboard as dgc/artifact_slides.py, artifact_sheet.py and artifact_dashboard.py normalize them (a checklist, as
dgc/artifact_checklist.py keeps one, and a design, as dgc/artifact_design.py does), and DGC's own page of
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


def _png(width: int, height: int, rgb: tuple) -> bytes:
    """A small real picture (one colour, a darker band across its top), standing in for a screenshot."""
    import struct
    import zlib

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    band = bytes(max(0, c - 60) for c in rgb)
    rows = b"".join(b"\x00" + (band if y < height // 6 else bytes(rgb)) * width for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def checklist_fixture() -> dict:
    """A checklist part-way through, as DGC keeps one: an item Done with its note, test results and a screenshot, one
    being built, one that needs the user, one not started."""
    import base64
    from dgc import artifact_checklist as checklist
    shot = _png(320, 200, (58, 110, 190))
    name = checklist.picture_name(shot)
    data = checklist.normalize({"about": "The parser the importer needs, tested and written up.", "pinned": True, "items": [
        {"title": "Write the parser", "done_when": "parse() reads every sample file in samples/"},
        {"title": "Add the tests", "done_when": "pytest passes with 10 or more tests"},
        {"title": "Publish the package", "done_when": "The package is on the index, version 1.0"},
        {"title": "Write the README", "done_when": "README says how to install it and run it, with one example"}]})
    stamp = "2026-10-28T08:{:02d}:00+00:00"
    data = checklist.apply_edits(data, [{"op": "set", "item": "c1", "status": "Done", "note": "Wrote parse() in parser.py; it reads all three samples.",
                                         "proof": ["pytest tests/test_parser.py: 4 passed in 0.31s", {"image": "shot.png", "caption": "The run, all three read"}]}],
                                 picture=lambda path: name, now=stamp.format(10))
    data = checklist.apply_edits(data, [{"op": "set", "item": "c2", "status": "Building"}], now=stamp.format(20))
    data = checklist.apply_edits(data, [{"op": "set", "item": "c3", "status": "Needs you",
                                         "note": "The index asks for an API token; I don't have one."}], now=stamp.format(30))
    pictures = {name: "data:image/png;base64," + base64.b64encode(shot).decode("ascii")}
    made = view("ar_" + "6" * 16, "checklist", "Ship the parser", 4, "work", progress=checklist.progress(data))
    made["origin"] = {"surface": "work", "project": "/home/me/code/shop"}
    made["versions"] = [{"n": 1, "author": "DGC", "at": "2026-10-28T08:00:00Z", "summary": "Made", "size": 900},
                        {"n": 2, "author": "DGC", "at": "2026-10-28T08:10:00Z", "summary": "c1 “Write the parser”: Not started → Done", "size": 1900},
                        {"n": 3, "author": "DGC", "at": "2026-10-28T08:20:00Z", "summary": "c2 “Add the tests”: Not started → Building", "size": 1950},
                        {"n": 4, "author": "DGC", "at": "2026-10-28T08:30:00Z", "summary": "c3 “Publish the package”: Not started → Needs you", "size": 2050}]
    return {"view": made, "content": data, "state": {"pictures": pictures},
            "html": checklist.render_html(data, title="Ship the parser", pictures=pictures)}


DESKTOP_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bean There</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #fbf6ef; color: #2b1d14; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 28px 72px; }
  nav { display: flex; gap: 28px; }
  .hero { display: flex; flex-direction: column; gap: 24px; padding: 96px 72px; max-width: 760px; }
  h1 { margin: 0; font-size: 72px; line-height: 1.02; }
  p.lead { margin: 0; font-size: 22px; line-height: 1.5; }
  .cta { align-self: flex-start; background: var(--accent, #b5651d); color: #fff; border: 0; padding: 16px 26px; border-radius: 8px; font-size: 18px; }
  html[data-tweak-badge="off"] .badge { display: none; }
  .badge { align-self: flex-start; background: #2b1d14; color: #fbf6ef; padding: 6px 12px; border-radius: 4px; font-size: 13px; }
</style></head>
<body>
<header><strong>Bean There</strong><nav><a href="#menu">Menu</a><a href="#visit">Visit</a></nav></header>
<section class="hero"><span class="badge">New: single-origin Ethiopia</span><h1 id="headline">Coffee worth waking up for</h1>
<p class="lead">Roasted on Mill Street every morning, poured until six.</p><button class="cta">See the menu</button></section>
</body></html>"""

SIGN_IN_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #fff; color: #1d1c21; padding: 96px 28px; }
  h1 { font-size: 30px; margin: 0 0 24px; } label { display: block; margin: 0 0 6px; font-size: 14px; }
  input { box-sizing: border-box; width: 100%; height: 44px; margin: 0 0 18px; padding: 0 12px; border: 1px solid #c9c6d1; border-radius: 8px; font-size: 16px; }
  button { width: 100%; height: 48px; border: 0; border-radius: 8px; background: #6747df; color: #fff; font-size: 17px; }
  #said { margin-top: 14px; color: #6d6a75; font-size: 14px; }
</style></head><body>
<h1>Sign in</h1>
<label for="email">Email</label><input id="email" type="email" value="asha@example.com">
<label for="pass">Password</label><input id="pass" type="password" value="secret">
<button id="go" data-goto="Welcome">Sign in</button>
<p id="said">Not signed in yet.</p>
<script>
  document.getElementById("email").addEventListener("input", function () { document.getElementById("said").textContent = "Typing…"; });
  window.parent.postMessage({ type: "artboard-script-ran" }, "*");
</script>
</body></html>"""

WELCOME_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f2f0ff; color: #1d1c21; padding: 120px 28px; text-align: center; }
  h1 { font-size: 34px; } a { color: #6747df; }
</style></head><body><h1>Welcome back, Asha</h1><p>Your usual is ready to order.</p><p><a href="#b2">Sign out</a></p></body></html>"""


def design_fixture() -> dict:
    """A design part-way through, as DGC keeps one: a desktop page with two tweaks, a sign-in screen whose button goes to
    a welcome screen (the first with a script of its own), a tablet not drawn yet, a title and a sticky note, and a second
    page with one more frame waiting."""
    from dgc import artifact_design as design
    index, _pending = design.start({"artboards": [{"title": "Desktop", "size": "desktop"}, {"title": "Sign in", "size": "phone"},
                                                   {"title": "Welcome", "size": "phone"}, {"title": "Tablet", "size": "tablet"}]})
    files: dict = {}
    for op in ({"op": "change", "board": "b1", "html": DESKTOP_PAGE, "tweaks": [
                    {"name": "accent", "label": "Accent colour", "type": "color", "value": "#b5651d"},
                    {"name": "badge", "label": "Show the badge", "type": "switch", "value": True}]},
               {"op": "change", "board": "b2", "html": SIGN_IN_PAGE},
               {"op": "change", "board": "b3", "html": WELCOME_PAGE},
               {"op": "note_add", "kind": "title", "text": "Bean There", "over": "b1"},
               {"op": "note_add", "kind": "sticky", "text": "Check the hero copy with Asha", "color": "pink", "near": "b2"},
               {"op": "page_add", "name": "Checkout"},
               {"op": "add", "title": "Cart", "size": "phone", "page": "Checkout"}):
        index, files, _said, _told = design.apply(index, files, op)
    index = design.normalize(index)
    boards = {b["id"]: files[design.board_file(b["id"])].decode("utf-8") for b in index["boards"]
              if design.board_file(b["id"]) in files}
    made = view("ar_" + "7" * 16, "design", "Coffee landing", 5, "work", design=design.counts(index))
    made["exports"] = ["pdf", "html", "zip"]
    made["updated"] = "2026-10-28T08:40:00Z"
    return {"view": made, "content": index, "state": {"boards": boards},
            "html": design.render_html(index, files, title="Coffee landing")}


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
    out["checklist"] = checklist_fixture()
    out["design"] = design_fixture()
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
