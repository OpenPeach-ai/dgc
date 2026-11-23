// Work's plan, measured in real Chromium on Work's real page (agent-todos.test.mjs holds the behaviour in jsdom). The plan
// copies the reference's shapes, sizes, spacing and motion exactly (the rule for a copied part): a 16 px mark beside 13/20
// px words, 12 px apart and 6 px above and below, a 24 px header, a 4 px bar 8 px under it, 12.8 px row corners, the
// ring turning once a second, the check drawing in 200 ms, the chevron turning on the spring. Its colours are DGC's own,
// in both themes: nothing on it is blue. Reduced motion leaves every mark at its end. 300 px scrolls nothing sideways.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openTodosScene } from "./support/todos-scene.mjs";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const SPRING = "linear(0 0%, 0.015 2%, 0.0532 4%, 0.1065 6%, 0.1686 8%, 0.2351 10%, 0.3363 13%, 0.4332 16%, 0.5495 20%, 0.648 24%, 0.7287 28%, 0.807 33%, 0.8646 38%, 0.9128 44%, 0.9447 50%, 0.968 57%, 0.9834 65%, 0.9924 74%, 0.9975 85%, 1 100%)";

// The geometry of one plan (`root`: the turn's card or the pill's section).
const geometry = (page, root) => page.evaluate((selector) => {
  const card = document.querySelector(selector);
  const box = (node) => node.getBoundingClientRect();
  const css = (node) => getComputedStyle(node);
  const head = card.querySelector(".todos-trigger"), track = card.querySelector(".todos-track");
  const row = card.querySelector('li.todo[data-status="pending"]'), doing = card.querySelector('li.todo[data-status="in_progress"]');
  const mark = row.querySelector(".todo-mark"), label = row.querySelector(".todo-label");
  const spin = doing.querySelector(".todo-spin"), chev = card.querySelector(".todos-chev");
  const fill = card.querySelector(".todos-fill"), done = card.querySelector('.todo-mark[data-mark="done"]');
  return {
    head: Math.round(box(head).height), title: [css(card.querySelector(".todos-title")).fontSize, css(card.querySelector(".todos-title")).fontWeight],
    sum: css(card.querySelector(".todos-sum")).fontSize,
    track: { height: box(track).height, gap: Math.round(box(track).top - box(head).bottom), radius: css(track).borderRadius },
    row: { height: box(row).height, radius: css(row).borderRadius, padTop: css(row.querySelector(".todo-row")).paddingTop,
      gap: Math.round(box(label).left - box(mark).right) },
    mark: [box(mark).width, box(mark).height],
    label: [css(label).fontSize, css(label).lineHeight],
    spin: [css(spin).animationName, css(spin).animationDuration, css(spin).animationTimingFunction, css(spin).animationIterationCount],
    chev: [css(chev).transitionProperty, css(chev).transitionDuration, css(chev).transitionTimingFunction],
    fill: [css(fill).transitionProperty, css(fill).transitionDuration, css(fill).transitionTimingFunction],
    doneRound: css(done).borderRadius,
    // (A row's ground reaches 8 px past the words on each side, as the reference's does: into the transcript's gutter,
    // never past it.)
    overflowX: document.documentElement.scrollWidth > innerWidth || document.getElementById("log").scrollWidth > document.getElementById("log").clientWidth + 1
      || box(row).left < box(document.getElementById("log")).left || box(row).right > box(document.getElementById("log")).right,
  };
}, root);

// Every colour on the plan, the pill and the section, as sRGB, with where it came from.
const colours = (page) => page.evaluate(() => {
  const nodes = [...document.querySelectorAll(".todos, .todos *, #rail-chips .rail-chip[data-kind=\"tasks\"], #rail-chips .rail-chip[data-kind=\"tasks\"] *")];
  const found = [];
  // Each colour painted alone on a 1x1 canvas and read back: whatever its notation (color-mix, color(srgb), rgb).
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgb = (value) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a ? "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("") : "";
  };
  for (const node of nodes) {
    const style = getComputedStyle(node);
    for (const prop of ["color", "background-color", "border-top-color", "fill", "stroke", "text-decoration-color", "-webkit-text-fill-color"]) {
      const value = style.getPropertyValue(prop);
      if (value && value !== "none" && !/^url/.test(value)) found.push({ where: String(node.className?.baseVal ?? node.className), prop, value: rgb(value) });
    }
    for (const m of style.backgroundImage.matchAll(/(?:rgba?|color)\([^)]*\)/g)) found.push({ where: String(node.className), prop: "background-image", value: rgb(m[0]) });
  }
  return found.filter((c) => c.value);
});
const blueish = (hex) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), span = max - min;
  if (span < 0.12) return false;                    // a grey
  const hue = (max === r ? (((g - b) / span) % 6) * 60 : max === g ? ((b - r) / span + 2) * 60 : ((r - g) / span + 4) * 60) + 360;
  return hue % 360 >= 185 && hue % 360 <= 250;
};

test("the card and the section take the reference's exact geometry and motion", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTodosScene(browser, { width: 440, height: 820, theme: "dark-modern" });
  try {
    for (const root of ["#log .todos-card", "#tasksbar"]) {
      if (root === "#tasksbar") await x.openPill();
      const g = await geometry(x.page, root);
      assert.equal(g.head, 24, `${root}: the header line`);
      assert.deepEqual(g.title, ["13px", "500"]);
      assert.equal(g.sum, "13px");
      assert.deepEqual(g.track, { height: 4, gap: 8, radius: "9999px" }, `${root}: the bar`);
      assert.deepEqual(g.row, { height: 32, radius: "12.8px", padTop: "6px", gap: 12 }, `${root}: a step's row`);
      assert.deepEqual(g.mark, [16, 16]);
      assert.deepEqual(g.label, ["13px", "20px"]);
      assert.deepEqual(g.spin, ["todo-spin", "1s", "linear", "infinite"], "the ring turns once a second");
      assert.deepEqual(g.chev, ["rotate", "0.2s", SPRING], "the chevron turns on the spring");
      assert.equal(g.fill[1].split(",")[0], "0.5s");
      assert.match(g.fill[2], /^cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
      assert.equal(g.doneRound, "9999px");
      assert.equal(g.overflowX, false);
    }
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("the popover holds the section with the reference's 10 px inside and its close beside the header", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTodosScene(browser, { width: 440, height: 820, theme: "light-modern" });
  try {
    await x.openPill();
    const f = await x.page.evaluate(() => {
      const box = (id) => document.querySelector(id).getBoundingClientRect();
      const bar = box("#tasksbar"), head = box("#tasksbar .todos-head"), close = box("#rail-pop-close"), pop = box("#rail-pop");
      const style = getComputedStyle(document.getElementById("tasksbar"));
      return { pad: style.padding, closeInHead: close.top >= head.top - 1 && close.bottom <= head.bottom + 1,
        closeRight: Math.round(pop.right - close.right), headClear: close.left >= head.right - 30,
        title: getComputedStyle(document.getElementById("rail-pop-title")).width, inPop: bar.top >= pop.top && bar.bottom <= pop.bottom + 1 };
    });
    assert.equal(f.pad, "10px");
    assert.ok(f.closeInHead, "× sits on the header's line");
    assert.ok(f.closeRight <= 12, `× at the popover's edge (${f.closeRight}px)`);
    assert.equal(f.title, "1px", "the popover's own title is said, not shown twice");
    assert.ok(f.inPop);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  test(`nothing on the plan, its section or its pill is blue (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openTodosScene(browser, { width: 440, height: 820, theme });
    try {
      // Every state: a step done just now, one in progress (spinning, shimmering), next, later, blocked, cancelled, failed.
      await x.update([{ content: "Read the settings store", status: "done" }, { content: "Write the migration", status: "done" },
        { content: "Tests for both directions", status: "in_progress" }, { content: "Update the changelog", status: "pending" },
        { content: "Publish", status: "blocked" }, { content: "Skipped", status: "cancelled" }, { content: "Later", status: "pending" }]);
      await x.openPill();
      const found = await colours(x.page);
      assert.ok(found.length > 40, "the plan's colours were read");
      assert.deepEqual(found.filter((c) => blueish(c.value)), [], "no blue anywhere");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("reduced motion: the ring stands, the check is drawn, nothing shimmers or slides", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTodosScene(browser, { width: 440, height: 820, reducedMotion: true });
  try {
    await x.update([{ content: "Read the settings store", status: "done" }, { content: "Write the v2 to v3 migration", status: "done" },
      { content: "Tests for both directions", status: "in_progress" }, { content: "Update the changelog", status: "pending" },
      { content: "Publish to the marketplace", status: "pending" }]);
    const f = await x.page.evaluate(() => {
      const card = document.querySelector("#log .todos-card");
      const css = (sel, prop) => getComputedStyle(card.querySelector(sel)).getPropertyValue(prop);
      return { spin: css(".todo-spin", "animation-name"), fresh: card.querySelectorAll(".todo-fresh").length,
        draw: css(".todo-fresh .todo-glyph path", "animation-name"), offset: css(".todo-fresh .todo-glyph path", "stroke-dashoffset"),
        shimmer: css('li.todo[data-status="in_progress"] .todo-label', "animation-name"),
        chip: getComputedStyle(document.querySelector('#rail-chips .rail-chip[data-kind="tasks"] .chip-word')).animationName };
    });
    assert.equal(f.spin, "none");
    assert.equal(f.fresh, 1, "the step done just now");
    assert.equal(f.draw, "none");
    assert.equal(f.offset, "0px", "its check is simply there");
    assert.equal(f.shimmer, "none");
    assert.equal(f.chip, "none");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

for (const width of [300, 700]) {
  test(`at ${width} px the plan, its section and the bar fit: one line of pills, nothing scrolls sideways`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openTodosScene(browser, { width, height: 760, theme: "dark-modern", kinds: ["goal", "changes"] });
    try {
      const card = await geometry(x.page, "#log .todos-card");
      assert.equal(card.overflowX, false);
      await x.openPill();
      const f = await x.page.evaluate(() => {
        const line = document.getElementById("rail-line").getBoundingClientRect();
        const chip = document.querySelector('#rail-chips .rail-chip[data-kind="tasks"]');
        const bar = document.getElementById("tasksbar");
        return { line: Math.round(line.height), chipClipped: chip.scrollWidth > chip.clientWidth + 1,
          sectionClipped: bar.scrollWidth > bar.clientWidth + 1, overflowX: document.documentElement.scrollWidth > innerWidth,
          mark: !!chip.querySelector(".todo-mark[data-running]") };
      });
      assert.equal(f.line, 36, "the bar keeps its one height");
      assert.equal(f.chipClipped, false);
      assert.equal(f.sectionClipped, false);
      assert.equal(f.overflowX, false);
      assert.ok(f.mark, "the pill keeps its turning mark at any width");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}
