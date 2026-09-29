// The open-ask card is a layout fact, so it is measured in real Chromium at three panel widths,
// open and settled.
//
// Two defects it holds down, both found by measuring rather than by reading the CSS:
//
//   `.oask-desc { flex: 1; min-width: 0 }` let a description shrink without limit. At a 420px
//   panel one 60-character description was squeezed into a 90px column, wrapped to five lines and
//   made its row 105px tall beside 35px neighbours; at 320px it was 69px and seven lines.
//
//   `.oask-mark` was a flex sibling after the description, so "Recommended" was pushed onto a line
//   of its own — at 320px it landed on line two with the description starting next to it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const QUESTION = "Which option should I build for the Body to Puller breakdown?";
// A real set, from the session that produced the report: labels long enough to fill a narrow row.
const OPTIONS = [
  { label: "A — make the existing filters real", recommended: true,
    description: "Body becomes a searchable dropdown of bodies that actually sell; smallest change, uses what already exists." },
  { label: "B — a dedicated board",
    description: "Bodies ranked by sales, each expanding to its pullers; needs a new aggregation endpoint." },
  { label: "C — every unit's children", description: "The same breakdown for every unit." },
];

async function card(width, { settled = false, theme = "dark-modern" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((e) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
  await send({ type: "ready", version: "0.46.1", protocol_version: 14,
    capabilities: { open_asks: true, ask_options: true }, model: "m", mode: "auto", think: "off",
    base_url: "http://x/v1", workspace_trusted: true, commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
  await send({ type: "turn_start", turn_id: "t1", prompt: "which option?" });
  await send({ type: "ask_request", ask_id: "a1", question: QUESTION, options: OPTIONS });
  if (settled) await send({ type: "ask_resolved", ask_id: "a1", outcome: "expired", question: QUESTION });
  await page.waitForTimeout(120);
  const geometry = await page.evaluate(() => {
    const row = document.querySelector(".open-ask");
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom, right: b.right }; };
    return {
      card: r(row),
      options: [...row.querySelectorAll(".oask-opt")].map((opt) => ({
        box: r(opt),
        label: r(opt.querySelector(".oask-label")),
        desc: opt.querySelector(".oask-desc") ? r(opt.querySelector(".oask-desc")) : null,
        mark: opt.querySelector(".oask-mark") ? r(opt.querySelector(".oask-mark")) : null,
      })),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  await page.close();
  assert.deepEqual(errors, [], "the page must render without script errors");
  return geometry;
}

const WIDTHS = [320, 420, 830];

for (const settled of [false, true]) {
  const state = settled ? "settled" : "open";

  test(`a description is never squeezed into a narrow column (${state})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of WIDTHS) {
      const g = await card(width, { settled });
      for (const [index, opt] of g.options.entries()) {
        if (!opt.desc) continue;
        // Either it sits beside the label with room to read, or it has taken its own line.
        const ownLine = opt.desc.x <= opt.label.x + 1;
        assert.ok(ownLine || opt.desc.w >= 140,
          `${width}px option ${index}: description is ${Math.round(opt.desc.w)}px wide beside its `
          + "label; it should have wrapped to its own line instead");
      }
    }
  });

  test(`no row towers over its neighbours (${state})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of WIDTHS) {
      const g = await card(width, { settled });
      const heights = g.options.map((o) => o.box.h);
      assert.ok(Math.max(...heights) <= Math.min(...heights) * 3.2,
        `${width}px: option heights ${heights.map((h) => Math.round(h)).join("/")} — one row is `
        + "several times its neighbours, which is what a crushed description looks like");
    }
  });

  test(`"Recommended" stays with the label it qualifies (${state})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of WIDTHS) {
      const g = await card(width, { settled });
      const opt = g.options.find((o) => o.mark);
      assert.ok(opt, "the recommended option is marked in words");
      assert.ok(opt.mark.y < opt.label.bottom && opt.mark.bottom > opt.label.y,
        `${width}px: the badge sits on its own line, away from the label`);
      // When the description has taken a line of its own, the badge must be above it. When it sits
      // beside the label there is nothing more to say: the badge shares that line too, and its
      // smaller box rides the same baseline a few pixels lower, which is not a defect.
      if (opt.desc && opt.desc.x <= opt.label.x + 1) {
        assert.ok(opt.mark.bottom <= opt.desc.y + 1,
          `${width}px: the badge was pushed below a description that had its own line`);
      }
    }
  });

  test(`nothing escapes the card and the panel never scrolls sideways (${state})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of WIDTHS) {
      const g = await card(width, { settled });
      assert.equal(g.sideways, false, `${width}px: the panel scrolls sideways`);
      for (const [index, opt] of g.options.entries()) {
        assert.ok(opt.box.x >= g.card.x - 0.5 && opt.box.right <= g.card.right + 0.5,
          `${width}px option ${index} sticks out of the card`);
        for (const part of [opt.label, opt.desc, opt.mark].filter(Boolean)) {
          assert.ok(part.y >= opt.box.y - 0.5 && part.bottom <= opt.box.bottom + 0.5,
            `${width}px option ${index}: a part of it sits outside its own row`);
        }
      }
    }
  });
}

test("a settled card keeps every option it offered", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of WIDTHS) {
    const g = await card(width, { settled: true });
    assert.equal(g.options.length, OPTIONS.length,
      `${width}px: the record of what was offered lost a row`);
    for (const opt of g.options) assert.ok(opt.box.h > 0, "and every row is still drawn");
  }
});
