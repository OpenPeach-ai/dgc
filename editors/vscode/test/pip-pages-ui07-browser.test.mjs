// The Pips list, a Pip's page and Pips settings (ui-07), in real Chromium with the real Pips bundle
// (test/support/pip-chat-scene.mjs, its "many" home: a Primary Pip, long names, numbers and dots).
// The list: the runner is a dot, Controls is a "…" menu, a count is a soft pill, and a name is one line, cut with an
// ellipsis. A Pip's page: no title yet is a quiet "Add a title" link, a long title wraps inside the page, a group's
// label is sentence case, a row's control ends at the row's right edge (a button or a switch stays beside a
// setting's bare name, even at 300 px), nothing pokes out of its card, and nothing is filled. Pips settings: the same rows.
// Dark and light, in a tab (700 px) and in the side bar (300 px).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull, isPurple, look, tokenColours } from "./support/look-probe.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
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

const LONG_TITLE = "Chief of staff for everything that arrives before nine";
const click = (p, sel) => p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);
const open = (theme, width, opts = {}) => openChat(browser, { width, height: 900, theme, where: width > 400 ? "tab" : "side", api: 80, many: true, ...opts });
async function openPage(theme, width, opts = {}) {
  const x = await open(theme, width, { settings: true, ...opts });
  await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-page #pipLevel"); await x.p.waitForTimeout(300);
  return x;
}
async function openSettings(theme, width, view) {
  const x = await open(theme, width, { settings: true, home: true });
  await click(x.p, "#pips-settings-open"); await x.p.waitForSelector(".pip-page [data-computers-update]");
  if (view !== "computer") { await click(x.p, `[data-pips-settings="${view}"]`); await x.p.waitForSelector(view === "apps" ? "#pipsMax" : "select[data-plugin-level]"); }
  await x.p.waitForTimeout(300);
  return x;
}

/** A settings page's rows, read in the page: each label's case, each row's last control against the row's right edge and
    its title's line, every control against its card, and every button's fill. */
const rows = () => {
  const root = window.__pipsRoot || document, page = root.querySelector(".pip-page"), seen = (n) => n.checkVisibility() && n.getBoundingClientRect().width > 1;
  const box = (n) => n.getBoundingClientRect(), near = (a, b) => Math.abs(a - b) <= 1.5;
  const labels = [...page.querySelectorAll(".pip-page-label")].filter(seen).map((n) => { const s = getComputedStyle(n); return { text: n.textContent.trim(), case: s.textTransform, spacing: s.letterSpacing }; });
  const controls = (row) => [...row.children].filter((c) => seen(c) && c.matches("button, select, input, label.switch, .row-confirm, .pip-artifacts-actions, label"));
  const out = [];
  for (const row of page.querySelectorAll(".pip-page-row.static, .pip-dashboards > li")) {
    const words = row.querySelector(":scope > .row-words"), own = controls(row); if (!seen(row) || !words || !own.length) continue;
    // (Its control is the last one on the first line of them: a suggestion under the words, as Seeing's "Switch to…", is not it.)
    const first = box(own[0]), line = own.filter((c) => Math.abs(box(c).top + box(c).height / 2 - first.top - first.height / 2) < 12);
    const s = getComputedStyle(row), edge = box(row).right - parseFloat(s.paddingRight), last = box(line.at(-1)), w = box(words);
    out.push({ text: words.textContent.trim().slice(0, 28), atEdge: near(last.right, edge), off: Math.round(edge - last.right), // (A setting's name and nothing else, with a button or a switch: a choice as wide as its words may go under it.)
      titleOnly: !!words.querySelector(":scope > strong") && !words.querySelector("small") && !line.at(-1).matches("select"),
      beside: (last.top + last.bottom) / 2 > w.top - 1 && (last.top + last.bottom) / 2 < w.bottom + 1, titleLines: Math.round(w.height / parseFloat(getComputedStyle(words).lineHeight || 18)) });
  }
  const poking = [...page.querySelectorAll(".pip-page-group :is(button, select, input, label.switch)")].filter((c) => seen(c) && !c.closest(".switch input"))
    // (A row that is itself a button runs the card's width: the Instructions row, a routine, "Ask me again from now on".)
    .filter((c) => { const g = box(c.closest(".pip-page-group")), r = box(c), whole = c.matches("button.pip-page-row, .routine-open, .level-reset") || r.width > g.width - 4; return whole ? r.right > g.right + 0.5 || r.left < g.left - 0.5 : r.right > g.right - 8 || r.left < g.left + 8; })
    .map((c) => (c.id || c.textContent.trim() || c.tagName).slice(0, 24));
  const fills = [...page.querySelectorAll("button")].filter(seen).map((b) => ({ text: (b.textContent.trim() || b.getAttribute("aria-label") || "").slice(0, 24), fill: getComputedStyle(b).backgroundColor }));
  return { labels, rows: out, poking, fills, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
};
function checkRows(m, width, solid) {
  assert.deepEqual(m.labels.filter((l) => l.case !== "none" || !["normal", "0px"].includes(l.spacing)), [], "every group's label is sentence case, as written");
  assert.deepEqual(m.rows.filter((r) => !r.atEdge).map((r) => `${r.text} (${r.off}px short)`), [], "every row's control ends at the row's right edge");
  assert.deepEqual(m.rows.filter((r) => r.titleOnly && !r.beside).map((r) => r.text), [], `a row that is only a title has its control beside it at ${width}px`);
  assert.deepEqual(m.poking, [], "no control pokes out of its card");
  assert.deepEqual(m.fills.filter((b) => b.fill === solid || isPurple(b.fill)).map((b) => b.text), [], "no filled button");
  assert.equal(m.sideways, false, "nothing scrolls sideways");
}

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`the list: the runner is a dot, Controls is a "…" menu, counts are soft pills, a name is one line (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { home: true });
    try {
      const m = await x.p.evaluate(() => {
        const root = window.__pipsRoot || document, box = (n) => n.getBoundingClientRect();
        const status = root.querySelector(".simple-bar .runner-status"), dot = status.querySelector(".status-dot"), toggle = root.getElementById("runner-controls-toggle");
        const names = [...root.querySelectorAll(".pip-row .pip-row-copy strong")].map((n) => { const text = n.querySelector(".pip-row-name") || n, s = getComputedStyle(text), row = n.closest(".pip-row");
          return { name: row.getAttribute("title") || "", shown: text.textContent.trim(), height: Math.round(box(n).height), nowrap: s.whiteSpace, cut: s.textOverflow, clipped: text.scrollWidth > text.clientWidth + 1, rowHeight: Math.round(box(row).height),
            star: !!n.querySelector(".primary-badge") && box(n.querySelector(".primary-badge")).right <= box(n).right + 0.5 }; });
        const counts = [...root.querySelectorAll(".pip-row-count")].map((n) => { const s = getComputedStyle(n); return { fill: s.backgroundColor, corner: parseFloat(s.borderTopLeftRadius), height: box(n).height }; });
        return { statusWords: getComputedStyle(status).fontSize, dot: [Math.round(box(dot).width), Math.round(box(dot).height)], toggle: { words: toggle.textContent.trim(), name: toggle.getAttribute("aria-label"), width: Math.round(box(toggle).width), height: Math.round(box(toggle).height),
          icon: !!toggle.querySelector("svg"), right: Math.round(box(root.querySelector(".simple-bar")).right - box(toggle).right) }, names, counts,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      });
      assert.deepEqual([m.statusWords, m.dot], ["0px", [8, 8]], "the runner's status is a small dot");
      assert.deepEqual([m.toggle.words, m.toggle.name, m.toggle.icon], ["", "Controls", true], "Controls is a \"…\" button, named for a screen reader");
      assert.ok(m.toggle.width <= 34 && m.toggle.width === m.toggle.height, `the "…" button is a round icon button (${m.toggle.width}x${m.toggle.height})`);
      assert.ok(m.counts.length >= 2, "two rows carry a number");
      const soft = (await tokenColours(x.p, ["--accent-soft"], ".pip-row-count"))["--accent-soft"];
      for (const c of m.counts) { assert.equal(c.fill, soft, "a count is the soft wash"); assert.equal(isPurple(c.fill), false); assert.ok(c.corner >= c.height / 2, "a pill"); }
      assert.equal(m.names.length, 6);
      for (const n of m.names) { assert.ok(n.height <= 22, `"${n.shown.slice(0, 20)}" is one line (${n.height}px)`); assert.deepEqual([n.nowrap, n.cut], ["nowrap", "ellipsis"]); assert.ok(n.rowHeight <= 62);
        if (n.clipped) assert.equal(n.name, n.shown, "a name that is cut says itself whole as the row's title"); }
      if (width === 300) assert.ok(m.names.filter((n) => n.clipped).length >= 2, "the long names are cut at 300px");
      assert.ok(m.names.find((n) => n.shown === "Core").star, "the Primary Pip keeps its star");
      assert.equal(m.sideways, false);
      // The "…" opens what Controls opened.
      await click(x.p, "#runner-controls-toggle");
      assert.ok(await x.p.evaluate(() => { const root = window.__pipsRoot || document, menu = root.querySelector(".runner-menu"), r = menu.getBoundingClientRect();
        return menu.checkVisibility() && !!root.getElementById("stop-all") && r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5; }), "its menu opens inside the page, with Stop all Pips");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a Pip's page: sentence-case labels, each control at its row's right edge, nothing filled (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(theme, width);
    try {
      const solid = (await tokenColours(x.p, ["--solid"], ".pip-page"))["--solid"];
      const m = await x.p.evaluate(rows);
      assert.ok(m.labels.length >= 6 && m.rows.length >= 10, `the page drew its groups (${m.labels.length} labels, ${m.rows.length} rows)`);
      checkRows(m, width, solid);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a Pip's page: no title yet is a quiet "Add a title" link; a long title wraps inside the page (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(theme, width);
    try {
      const muted = (await tokenColours(x.p, ["--muted"], ".pip-page"))["--muted"];
      assert.equal(await x.p.evaluate(() => !!(window.__pipsRoot || document).getElementById("pipPageTitle")), false, "no empty box where a title would go");
      await x.p.mouse.move(1, 1);       // its resting look: the pointer isn't on it (where it rests depends on the layout above)
      const link = await look(x.p, "[data-pip-title-edit]");
      assert.deepEqual([await x.p.evaluate(() => (window.__pipsRoot || document).querySelector("[data-pip-title-edit]").textContent.trim()), link.fill, link.words, link.lineWidth === "0px" || link.line === "rgba(0, 0, 0, 0)"],
        ["Add a title", "rgba(0, 0, 0, 0)", muted, true], "a quiet link: muted words, no fill, no line");
      // The link becomes the box, with the caret in it; left empty, it is the link again.
      await x.p.locator("[data-pip-title-edit]").click();
      assert.equal(await x.p.evaluate(() => { const root = window.__pipsRoot || document; return root.activeElement?.id || document.activeElement?.id; }), "pipPageTitle", "the caret is in the title's box");
      await x.p.keyboard.press("Tab"); await x.p.waitForTimeout(150);
      assert.equal(await x.p.evaluate(() => { const root = window.__pipsRoot || document; return !root.getElementById("pipPageTitle") && root.querySelector("[data-pip-title-edit]")?.textContent.trim(); }), "Add a title", "left empty, it is the link again");
      // Typed: Save and Cancel, as for its name.
      await x.p.locator("[data-pip-title-edit]").click(); await x.p.keyboard.type("Morning desk"); await x.p.waitForTimeout(100);
      assert.deepEqual(await x.p.evaluate(() => { const root = window.__pipsRoot || document; return [root.getElementById("pipPageTitle").value, [...root.querySelectorAll(".pip-name-actions button")].map((b) => b.textContent)]; }), ["Morning desk", ["Save", "Cancel"]]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    const y = await openPage(theme, width, { title: LONG_TITLE });
    try {
      const m = await y.p.evaluate(() => { const root = window.__pipsRoot || document, n = root.querySelector("[data-pip-title-edit]"), r = n.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(n);
        const lines = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size, name = root.getElementById("pipPageName");
        return { text: n.textContent.trim(), left: r.left, right: r.right, lines, cut: n.scrollWidth > n.clientWidth + 1, vw: document.documentElement.clientWidth, nameCut: getComputedStyle(name).textOverflow, box: !!root.getElementById("pipPageTitle") }; });
      assert.deepEqual([m.text, m.cut, m.box], [LONG_TITLE, false, false], "the whole title is shown, as words");
      assert.ok(m.left >= 8 && m.right <= m.vw - 8 && m.lines <= 3, `it wraps inside the page (${m.lines} lines, ${Math.round(m.left)} to ${Math.round(m.right)} of ${m.vw})`);
      assert.equal(m.nameCut, "ellipsis", "a name too long for its box ends in an ellipsis");
      // The title opens for a change with its words in the box.
      await y.p.locator("[data-pip-title-edit]").click();
      assert.equal(await y.p.evaluate(() => (window.__pipsRoot || document).getElementById("pipPageTitle").value), LONG_TITLE);
      assert.deepEqual(y.errors, []);
    } finally { await y.close(); }
  });
}

for (const view of ["computer", "apps", "plugins"]) for (const width of [700, 300]) {
  test(`Pips settings, ${view}: sentence-case labels, each control at its row's right edge, inside its card (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openSettings("dark", width, view);
    try {
      const solid = (await tokenColours(x.p, ["--solid"], ".pip-page"))["--solid"];
      const m = await x.p.evaluate(rows);
      assert.ok(m.rows.length >= 2, `the page drew its rows (${m.rows.length})`);
      checkRows(m, width, solid);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
