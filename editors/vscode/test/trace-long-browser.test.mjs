// Trace with many rows (reported 12 Nov, a 139-span goal turn): scrolled down, the playhead and the grid lines must run
// the whole list, not stop at the first screen; and at the end of the timeline the playhead keeps a gap from the
// words in the right-hand column instead of touching them. Real Chromium, media/trace.js and media/trace.css.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const js = readFileSync(new URL("../media/trace.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../media/trace.css", import.meta.url), "utf8");
const page = `<!doctype html><html><head><style>:root{--text:#ccc;--text-strong:#fff;--muted:#888;--border:#333;--surface:#1b1b1b;}
body{margin:0;background:#111;color:#ccc}${css}</style></head><body><script>${js}</script></body></html>`;

function longTrace() {
  const steps = [];
  let at = 0;
  for (let i = 0; i < 70; i++) {
    steps.push({ kind: "model", label: "model.response", start: at, end: at + 5000, tokens: 770000 + i * 400 }); at += 5000;
    steps.push({ kind: "tool", label: "bash", detail: "cd ~/riverside_shop && docker compose exec backend python manage.py check", start: at, end: at + 800 }); at += 800;
  }
  return { v: 1, ms: at, steps };
}

for (const width of [1000, 600]) {
  test(`a long trace: the playhead runs the whole list and keeps clear of the right-hand words (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await browser.newPage({ viewport: { width, height: 700 } });
    try {
      await p.setContent(page);
      await p.evaluate((saved) => window.DgcTrace.open(window.DgcTrace.fromSaved(saved, "t1", "glm-5.3:cloud")), longTrace());
      await p.waitForSelector(".dgc-trace-cursor");
      const body = ".dgc-trace-body";
      const scrollable = await p.$eval(body, (b) => b.scrollHeight > b.clientHeight + 100);
      assert.ok(scrollable, "the list is longer than the dialog");
      await p.$eval(body, (b) => { b.scrollTop = b.scrollHeight; });
      const m = await p.evaluate(() => {
        const box = (n) => n.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".dgc-trace-row")];
        const last = box(rows[rows.length - 1]), cursor = box(document.querySelector(".dgc-trace-cursor"));
        const lines = [...document.querySelectorAll(".dgc-trace-grid i")].map(box);
        const metas = rows.map((r) => box(r.querySelector(".dgc-trace-meta span:first-child"))).filter((b) => b.width > 0);
        const metaLeft = Math.min(...rows.map((r) => box(r.querySelector(".dgc-trace-meta")).left));
        return { lastBottom: last.bottom, lastTop: last.top, cursorBottom: cursor.bottom, cursorTop: cursor.top, cursorRight: cursor.right,
          linesBottom: Math.min(...lines.map((l) => l.bottom)), metaLeft,
          textLeft: Math.min(...metas.map((b) => b.left)) };
      });
      assert.ok(m.cursorBottom >= m.lastBottom - 1, `the playhead reaches the last row once scrolled: ${JSON.stringify(m)}`);
      assert.ok(m.linesBottom >= m.lastBottom - 1, `the grid lines reach the last row once scrolled: ${JSON.stringify(m)}`);
      // At the end of the timeline (the dialog opens at the end), a clear gap before the right-hand column's words.
      assert.ok(m.textLeft - m.cursorRight >= 8, `the playhead keeps at least 8px from the words: ${JSON.stringify(m)}`);
      assert.ok(m.metaLeft - m.cursorRight >= 8, `and from the column itself: ${JSON.stringify(m)}`);
    } finally { await p.close(); }
  });
}
