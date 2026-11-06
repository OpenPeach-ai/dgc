// The agent map's helper line keeps where it ran readable (0.51, DGC Router): in a narrow row, "Finished · 3m 32s ·
// 97.2k tokens · on NAS · qwen3.5:9b" gives way at its state, time and tokens (an ellipsis) and never at the system
// or the model, which are what tell two helpers apart. The line's text, and so what a screen reader hears, is the same.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openMapScene, sid } from "./support/agent-map-scene.mjs";

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  if (browser) return false;
  const reason = chromium ? "Chromium could not start" : "playwright is not installed (npm ci at the repository root)";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

const LEASES = { enabled: true, when_busy: "wait", workers: { total: 6, free: 4, busy: 2 }, systems: [
  { id: "nas", name: "NAS", leases: [{ owner: sid(4), label: "Write the settings migration", model: "qwen3.5:9b", job: "subagents" }] },
  { id: "basement", name: "Basement workstation", leases: [{ owner: sid(1), label: "Review the auth module", model: "qwen2.5-coder:14b-instruct-q8_0", job: "subagents" }] }] };

const measure = (page, id) => page.evaluate((id) => {
  const meta = document.querySelector(`#agent-map .am-row[data-am-key="agent:${id}"] .am-meta`);
  const lead = meta?.querySelector(".am-meta-lead"), where = meta?.querySelector(".am-meta-where");
  const sep = meta?.querySelector(".am-meta-sep");
  // What a person sees: the parts not hidden, then where it ran.
  const seen = meta ? [...meta.querySelectorAll(".am-meta-part, .am-meta-sep, .am-meta-where")]
    .filter((node) => node.checkVisibility()).map((node) => node.textContent).join("") : "";
  // Clipped across, or (the lead's parts drop out whole onto a hidden second line) down.
  const clipped = (node) => !!node && (node.scrollWidth > node.clientWidth + 0.5 || node.scrollHeight > node.clientHeight + 0.5);
  const box = (node) => node ? node.getBoundingClientRect() : null;
  return { text: meta?.textContent, seen, split: !!where, where: (sep?.textContent || "") + (where?.textContent || ""), whereClipped: clipped(where),
    leadClipped: clipped(lead), leadShown: lead ? lead.clientWidth : 0, row: meta?.closest(".am-row").getBoundingClientRect().width,
    // The line's own box ends before the meta's: its ellipsis is drawn, never cut off by the row.
    whereInside: !where || box(where).right <= box(meta).right + 0.5 };
}, id);

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 460, 900]) {
    test(`${theme} at ${width}px: a helper's system and model stay whole; its state, time and tokens give way first`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, send, errors } = await openMapScene(browser, { width, height: 760, theme });
      try {
        await send({ type: "router_changed", status: LEASES, why: "leased" });
        await page.waitForTimeout(80);
        if (process.env.DGC_SHOTS) await page.screenshot({ path: `${process.env.DGC_SHOTS}/agent-map-where-${theme}-${width}.png` });
        const nas = await measure(page, sid(4));
        assert.equal(nas.split, true);
        assert.match(nas.text, /^Finished · \d+m \d+s · 97\.2k tokens · on NAS · qwen3\.5:9b$/, "the same words as before");
        assert.equal(nas.where, " · on NAS · qwen3.5:9b");
        assert.equal(nas.whereClipped, false, `"on NAS · qwen3.5:9b" is whole in a ${Math.round(nas.row)}px row`);
        const long = await measure(page, sid(1));
        assert.match(long.text, /on Basement workstation · qwen2\.5-coder:14b-instruct-q8_0$/);
        // A model name too long for the row clips at its end, after the rest has given way, whole parts at a time;
        // the line never starts with " · " and never shows a cut number.
        if (long.whereClipped) assert.equal(long.seen, "on Basement workstation · qwen2.5-coder:14b-instruct-q8_0", "the rest gave way first");
        assert.doesNotMatch(long.seen, /^ · |\d…/);
        assert.equal(long.whereInside, true, "a clipped model name shows its ellipsis inside the row");
        // A helper the Router didn't place keeps its one-line meta.
        const plain = await measure(page, sid(3));
        assert.equal(plain.split, false);
        assert.match(plain.text, /^Failed · 48s · 18\.2k tokens$/);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

// Seen in testing, a 1440 px window: "Finished · 6s · 4.1… · on Workstation · qwen2.5:7b". The time and tokens give
// way whole ("6s · 4.1k", then "6s"), never cut mid-number: every part of the line's start is either all there or
// all gone, and what shows reads as words and numbers, never "4.1…".
const parts = (page, id) => page.evaluate((id) => {
  const lead = document.querySelector(`#agent-map .am-row[data-am-key="agent:${id}"] .am-meta-lead`);
  if (!lead) return null;
  const box = lead.getBoundingClientRect();
  return [...lead.querySelectorAll(".am-meta-part")].map((part, i) => {
    const r = part.getBoundingClientRect();
    const shown = part.checkVisibility() && r.width > 0;
    return { text: part.textContent, i, shown, whole: r.right <= box.right + 0.5 && r.left >= box.left - 0.5,
      cut: part.scrollWidth > part.clientWidth + 0.5 };
  });
}, id);
for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: the time and tokens give way whole, never mid-number, at every width`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of [300, 360, 420, 460, 540, 600, 720, 900, 1440]) {
      const { page, send, errors } = await openMapScene(browser, { width, height: 760, theme });
      try {
        await send({ type: "router_changed", status: LEASES, why: "leased" });
        await page.waitForTimeout(80);
        for (const id of [sid(4), sid(1)]) {
          const got = await parts(page, id);
          assert.ok(got && got.length >= 3, `${width}px: the lead is in parts`);
          assert.match(got.map((p) => p.text).join(""), /^(Finished · )?\d+m \d+s · [\d.]+k tokens$/);
          const shown = got.filter((p) => p.shown);
          for (const p of shown) assert.ok(p.whole && !p.cut, `${width}px: "${p.text}" shows whole`);
          // What shows is the line's start, in order: a part never shows after one that dropped out.
          assert.deepEqual(shown.map((p) => p.i), shown.map((_, i) => i), `${width}px: ${JSON.stringify(got)}`);
          const seen = shown.map((p) => p.text).join("");
          assert.doesNotMatch(seen, /\d…|\.$| ·$/, `${width}px: "${seen}" ends cleanly`);
        }
        if (process.env.DGC_SHOTS) await page.screenshot({ path: `${process.env.DGC_SHOTS}/agent-map-parts-${theme}-${width}.png` });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });
}
