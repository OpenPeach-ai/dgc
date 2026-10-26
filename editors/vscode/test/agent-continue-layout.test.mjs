// "Ask it to do more" and a continued helper's runs, in real Chromium: at side-bar widths 300 and 460 and an editor's
// 900, dark and light, the box sits inside the finished helper's card with nothing scrolling sideways, its field takes
// the card's width and its Continue button stays on the row beside the note; the row's "Continued · 2 runs" stays
// one line; in the transcript the divider ("Continued 18:42 · asked by you") is one line across it and what it was
// asked reads as a prompt; the words clear 4.5:1. The chat is the agent map's realistic one (agent-map-scene.mjs),
// its finished settings helper continued once.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openMapScene, sid } from "./support/agent-map-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
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

const contrasts = (page, selectors) => page.evaluate((list) => {
  const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = (c) => { const v = c.map((p) => p / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  return Object.fromEntries(list.map((selector) => {
    const node = document.querySelector(selector);
    if (!node) return [selector, 0];
    let ground = node;
    while (ground && getComputedStyle(ground).backgroundColor.replace(/\s/g, "") === "rgba(0,0,0,0)") ground = ground.parentElement;
    return [selector, ratio(rgb(getComputedStyle(node).color), rgb(getComputedStyle(ground || document.body).backgroundColor))];
  }));
}, selectors);

const AT = Date.now() / 1000 - 600;
const RUNS = { id: sid(4), runs: 2, continuable: true, history: [
  { run: 1, by: "model", held: false, note: "Sub-task 'Write the settings migration and its tests' completed and integrated 2 path(s): src/settings.ts, test/settings.test.ts.",
    report: "Migrated the settings store to version 3 and covered both directions." },
  { run: 2, by: "you", at: AT, held: false, request: "Also migrate the per-workspace overrides, and keep the old keys readable for one release.",
    note: "Sub-task 'Write the settings migration and its tests' completed and integrated 1 path(s): src/settings.ts.",
    report: "Migrated the per-workspace overrides; the old keys still read for one release." }] };

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 460, 900]) {
    test(`${theme} at ${width}px: the box in a finished helper's card, its row's runs, the divider in its transcript`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, send, errors } = await openMapScene(browser, { width, height: 760, theme, capabilities: { continue_agent: 1 } });
      try {
        // Its second run's steps, live (the r2 call ids), then what the CLI says of its runs.
        await send({ type: "tool_call", call_id: `${sid(4)}:r2-w1`, name: "edit_file", args: { path: "src/settings.ts" }, summary: "src/settings.ts" });
        await send({ type: "tool_result", call_id: `${sid(4)}:r2-w1`, name: "edit_file", output: "edited src/settings.ts", is_error: false });
        await send({ type: "agent_runs", items: [RUNS] });
        await page.waitForTimeout(60);
        const rowMeta = await page.evaluate((id) => {
          const meta = document.querySelector(`#agent-map .am-row[data-am-key="agent:${id}"] .am-meta`)
            || document.querySelector(`#agent-map .am-row[data-am-key="agent:${id}"]`);
          const s = getComputedStyle(meta);
          return { text: meta.textContent, height: meta.getBoundingClientRect().height, line: parseFloat(s.lineHeight) };
        }, sid(4));
        assert.match(rowMeta.text, /Continued · 2 runs/);
        await page.click(`#agent-map .am-row[data-am-key="agent:${sid(4)}"]`);
        await page.waitForTimeout(80);
        const card = await page.evaluate(() => {
          const body = document.getElementById("agent-card-body"), box = body.querySelector(".agent-more");
          const rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
          const field = box.querySelector("textarea"), send = box.querySelector("button"), note = box.querySelector(".agent-more-note");
          return { hidden: box.hidden, body: rect(body), box: rect(box), field: rect(field), send: rect(send), note: rect(note),
            bodyOverflow: body.scrollWidth - body.clientWidth, pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
            sendText: send.textContent, sendLines: send.getBoundingClientRect().height / parseFloat(getComputedStyle(send).lineHeight || "16") };
        });
        assert.equal(card.hidden, false, "the box is on its card");
        assert.ok(card.bodyOverflow <= 0 && card.pageOverflow <= 0, `nothing scrolls sideways (${card.bodyOverflow}, ${card.pageOverflow})`);
        assert.ok(card.box.left >= card.body.left - 0.5 && card.box.right <= card.body.right + 0.5, "inside the card");
        assert.ok(card.field.width >= card.box.width - 1, `the field takes the card's width (${card.field.width} / ${card.box.width})`);
        assert.ok(card.field.height >= 40, `room for two lines (${card.field.height})`);
        assert.ok(Math.abs(card.send.top - card.note.top) < card.send.height, "Continue sits on the row beside the note");
        assert.ok(card.send.right <= card.box.right + 0.5, "and inside the box");
        assert.equal(card.sendText, "Continue");
        const words = await contrasts(page, ["#agent-card-body .agent-more-note", "#agent-card-body .agent-more-text"]);
        for (const [selector, value] of Object.entries(words)) assert.ok(value >= 4.5, `${selector}: ${value.toFixed(2)}:1`);
        // Its transcript: the divider is one line across it.
        await page.click("#agent-card-body .am-wide");
        await page.waitForTimeout(80);
        const tx = await page.evaluate(() => {
          const into = document.getElementById("agent-transcript-log"), divider = into.querySelector(".agent-run-divider");
          const mark = divider.querySelector(".agent-run-mark"), request = divider.querySelector(".agent-run-request");
          const body = document.getElementById("agent-transcript-body");
          const s = getComputedStyle(mark);
          return { mark: mark.textContent, markLines: mark.getBoundingClientRect().height / parseFloat(s.lineHeight),
            markWidth: mark.getBoundingClientRect().width, logWidth: into.getBoundingClientRect().width,
            request: !!request?.querySelector(".bubble"), overflow: body.scrollWidth - body.clientWidth,
            order: [...into.children].map((n) => n.classList.contains("agent-run-divider") ? "divider" : n.classList.contains("tool") ? n.dataset.callId : "") };
        });
        assert.match(tx.mark, /^Continued \S+.* · asked by you$/);
        assert.ok(tx.markLines <= 1.05, `the divider is one line (${tx.markLines})`);
        assert.ok(tx.markWidth >= tx.logWidth - 1, "across the transcript");
        assert.ok(tx.request, "what it was asked, as a prompt");
        assert.ok(tx.overflow <= 0, `the transcript does not scroll sideways (${tx.overflow})`);
        assert.ok(tx.order.indexOf("divider") < tx.order.indexOf(`${sid(4)}:r2-w1`), "the divider comes before its run's step");
        const mark = await contrasts(page, ["#agent-transcript-log .agent-run-mark"]);
        assert.ok(mark["#agent-transcript-log .agent-run-mark"] >= 4.5, `the divider's words: ${mark["#agent-transcript-log .agent-run-mark"]}`);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
}
