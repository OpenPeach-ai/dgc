// The chip line (B2) is a layout fact, so it is measured in real Chromium. The founder's case -- a goal, a troupe, two
// monitors, a checklist and this chat's changes all showing -- stacked five rows above the prompt box: 204px of a
// 460x820 side bar. Folded into one line of chips it must take at most 40px at 460 and at 900; each chip's popover
// must float over the transcript (moving nothing), hold the kind's real row with controls that take their clicks,
// close on Esc or a click elsewhere with the focus back on its chip; amber must clear contrast in both themes; one
// kind alone keeps today's full row; 300px wraps without clipping or scrolling sideways; reduced motion is honoured.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio } from "./support/webview-dom.mjs";
import { ALL_KINDS, measurePile, openRailScene } from "./support/rail-scene.mjs";

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

// Resolve a CSS colour (including color-mix and alpha) to opaque hex over the given backdrop.
async function paint(page, color, backdrop) {
  return page.evaluate(([value, under]) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const probe = document.createElement("span"); document.body.appendChild(probe);
    const resolve = (css) => { probe.style.color = ""; probe.style.color = css; return getComputedStyle(probe).color; };
    ctx.fillStyle = resolve(under); ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = resolve(value); ctx.fillRect(0, 0, 1, 1);
    probe.remove();
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  }, [color, backdrop]);
}
const chipSel = (kind) => `#rail-chips .rail-chip[data-kind="${kind}"]`;
const lineFacts = (page) => page.evaluate(() => {
  const rect = (node) => node.getBoundingClientRect();
  const line = rect(document.getElementById("rail-line"));
  const chips = [...document.querySelectorAll("#rail-chips .rail-chip")].map((chip) => ({ kind: chip.dataset.kind, ...rect(chip).toJSON(),
    clipped: chip.scrollWidth > chip.clientWidth + 1 }));
  const ws = rect(document.getElementById("workspace-changes"));
  return { line: line.toJSON(), chips, ws: ws.toJSON(), fit: document.getElementById("rail-line").dataset.fit,
    overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    rows: getComputedStyle(document.getElementById("composer-rail")).display };
});
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

for (const width of [460, 900]) {
  test(`${width}x820, a goal, a troupe, monitors, tasks and changes: one line, at most 40px above the box`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openRailScene(browser, { width, height: 820 });
    try {
      const pile = await measurePile(page);
      t.diagnostic(`above the box ${pile.above}px, transcript ${pile.log}px`);
      assert.ok(pile.above <= 40, `the pile takes ${pile.above}px above the box (it took 204px as five rows)`);
      assert.ok(pile.log >= 560, `the transcript keeps ${pile.log}px of 820`);
      const g = await lineFacts(page);
      assert.deepEqual(g.chips.map((chip) => chip.kind), ALL_KINDS);
      assert.equal(new Set(g.chips.map((chip) => Math.round(chip.top))).size, 1, "every chip on one line");
      for (const chip of g.chips) {
        assert.ok(chip.height <= 24.5, `${chip.kind} is ${chip.height}px tall`);
        assert.ok(chip.left >= g.line.left - 0.5 && chip.right <= g.line.right + 0.5, `${chip.kind} inside the line`);
        assert.equal(chip.clipped, false, `${chip.kind} shows all it says`);
        assert.ok(!overlaps(chip, g.ws), `${chip.kind} clear of Workspace changes`);
      }
      assert.ok(g.ws.top >= g.line.top - 0.5 && g.ws.bottom <= g.line.bottom + 0.5, "Workspace changes shares the line");
      assert.equal(g.rows, "none", "no row stacks above the box");
      assert.equal(g.overflowX, false);
      if (width === 900) assert.equal(g.fit, "full", "an editor tab has room for the words");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("each chip opens its real row in a popover over the transcript, and the row's controls take their clicks", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openRailScene(browser, { width: 460, height: 820 });
  try {
    const rest = await measurePile(page);
    const expect = { goal: "goalbar", troupe: "troupebar", monitors: "monitorsbar", tasks: "tasksbar", changes: "changesbar" };
    for (const [kind, row] of Object.entries(expect)) {
      await page.click(chipSel(kind));
      await page.waitForTimeout(200);
      const g = await page.evaluate((id) => {
        const rect = (node) => node.getBoundingClientRect();
        const pop = document.getElementById("rail-pop"), line = rect(document.getElementById("rail-line"));
        const head = rect(document.getElementById("phead"));
        const buttons = [...document.getElementById(id).querySelectorAll("button")].filter((b) => !b.closest("[hidden]") && rect(b).width > 0)
          .map((b) => { const r = rect(b); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { label: b.getAttribute("aria-label") || b.textContent.trim(), hit: b === hit || b.contains(hit) }; });
        return { open: !pop.hidden, holds: document.getElementById("rail-pop-body").contains(document.getElementById(id)),
          pop: rect(pop).toJSON(), line: line.toJSON(), headBottom: head.bottom, buttons,
          focusInside: pop.contains(document.activeElement) };
      }, row);
      assert.ok(g.open && g.holds, `${kind}: the popover holds #${row}`);
      assert.ok(g.pop.bottom <= g.line.top + 0.5, `${kind}: the popover sits above the line`);
      assert.ok(g.pop.top >= g.headBottom - 0.5, `${kind}: and below the header`);
      assert.ok(g.focusInside, `${kind}: focus moved into it`);
      assert.ok(g.buttons.length > 0);
      for (const b of g.buttons) assert.ok(b.hit, `${kind}: "${b.label}" is the element under its own centre`);
      assert.deepEqual(await measurePile(page), rest, `${kind}: the popover floats and moves nothing`);
    }
    // Stop on the troupe, from its popover, with a real click.
    await page.click(chipSel("troupe"));
    await page.click("#troupe-stop");
    assert.deepEqual(await page.evaluate(() => window.__posted.filter((m) => m.type === "stopTroupe")), [{ type: "stopTroupe", run_id: "tr-0123456789" }]);
    const stages = await page.evaluate(() => [...document.querySelectorAll("#rail-pop #troupe-panel .troupe-stages li")].length);
    assert.equal(stages, 2, "the troupe's stages are open in it");
    // Review changes: the changed files open over everything.
    await page.click(chipSel("changes"));
    await page.click("#changes-review-button");
    assert.equal(await page.evaluate(() => document.getElementById("changes-review").hidden), false);
    assert.match(await page.evaluate(() => document.getElementById("changes-review-list").textContent), /src\/settings\.ts/);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.getElementById("changes-review").hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "changes-main", "back in the popover, on the row");
    // Pause the goal.
    await page.click(chipSel("goal"));
    await page.click("#goal-toggle");
    assert.deepEqual(await page.evaluate(() => window.__posted.filter((m) => m.type === "pauseGoal")), [{ type: "pauseGoal" }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("keyboard: the arrows move along the chips, Enter and Space open, Esc closes back onto the chip; a click elsewhere closes", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openRailScene(browser, { width: 460, height: 820 });
  try {
    const state = () => page.evaluate(() => ({ open: !document.getElementById("rail-pop").hidden,
      kind: document.getElementById("rail-pop").dataset.kind || "",
      focus: document.activeElement?.dataset.kind || document.activeElement?.id || "",
      inside: document.getElementById("rail-pop").contains(document.activeElement) }));
    await page.focus(chipSel("goal"));
    await page.keyboard.press("ArrowRight");
    assert.equal((await state()).focus, "troupe");
    await page.keyboard.press("Enter");
    assert.deepEqual(await state(), { open: true, kind: "troupe", focus: "troupe-main", inside: true });
    await page.keyboard.press("Escape");
    assert.deepEqual(await state(), { open: false, kind: "", focus: "troupe", inside: false });
    assert.deepEqual(await page.evaluate(() => window.__posted.filter((m) => m.type === "cancel")), [], "Esc did not stop the turn");
    await page.keyboard.press("End");
    await page.keyboard.press(" ");
    assert.equal((await state()).kind, "changes", "Space opens");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    assert.equal((await state()).kind, "goal");
    // Tab order: one stop for the whole line.
    const stops = await page.evaluate(() => [...document.querySelectorAll("#rail-chips .rail-chip")].filter((c) => c.tabIndex === 0).length);
    assert.equal(stops, 1);
    const log = await page.evaluate(() => { const r = document.getElementById("log").getBoundingClientRect(); return { x: r.left + 40, y: r.top + 60 }; });
    await page.mouse.click(log.x, log.y);
    assert.equal((await state()).open, false, "a click on the transcript closes it");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: what needs you is said in the rows' old colours (blocked red, waiting amber; 4.5:1), no dot or outline`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openRailScene(browser, { width: 900, height: 820, theme, attention: true });
    try {
      const g = await page.evaluate(() => {
        const read = (kind) => {
          const chip = document.querySelector(`#rail-chips .rail-chip[data-kind="${kind}"]`);
          const need = chip.querySelector(".chip-need");
          const icon = chip.querySelector(":scope > .codicon");
          return { need: chip.hasAttribute("data-need"), tone: chip.dataset.need || "", border: getComputedStyle(chip).borderTopColor,
            dot: chip.querySelector(".chip-dot") ? "dot" : "", icon: icon ? getComputedStyle(icon).color : "",
            err: getComputedStyle(document.body).getPropertyValue("--err-text").trim(),
            bg: getComputedStyle(chip).backgroundColor, word: need ? need.textContent : "", wordColor: need ? getComputedStyle(need).color : "",
            label: chip.getAttribute("aria-label") };
        };
        return { tasks: read("tasks"), monitors: read("monitors"), goal: read("goal"),
          ground: getComputedStyle(document.querySelector("footer")).backgroundColor };
      });
      assert.equal(g.goal.need, false);
      for (const [kind, word] of [["tasks", "1 blocked"], ["monitors", "3 waiting"]]) {
        const c = g[kind];
        assert.equal(c.need, true, kind);
        assert.equal(c.word, word);
        assert.match(c.label, new RegExp(`Needs you: ${word}$`));
        const ground = await paint(page, g.ground, "#000000");
        const bg = await paint(page, c.bg, ground);
        const text = await paint(page, c.wordColor, bg);
        assert.ok(contrastRatio(text, bg) >= 4.5, `${kind} words ${text} on ${bg}: ${contrastRatio(text, bg).toFixed(2)}`);
        assert.equal(c.dot, "", `${kind}: no dot`);
        assert.equal(c.border, g.goal.border, `${kind}: no outline, the same border as a chip that doesn't need you`);
        assert.equal(c.tone, kind === "tasks" ? "error" : "warn");
        if (kind === "tasks") assert.equal(c.icon, c.wordColor, "blocked: the icon is red with the words, as the Tasks row was");
      }
      // At side-bar width the reason stays on screen: it takes the number's place before anything wraps.
      await page.setViewportSize({ width: 460, height: 820 });
      await page.waitForTimeout(150);
      const narrow = await page.evaluate(() => ["tasks", "monitors"].map((kind) => {
        const chip = document.querySelector(`#rail-chips .rail-chip[data-kind="${kind}"]`);
        const need = chip.querySelector(".chip-need");
        return [kind, need && getComputedStyle(need).display !== "none" ? need.textContent : ""];
      }));
      assert.deepEqual(narrow, [["tasks", "1 blocked"], ["monitors", "3 waiting"]]);
      assert.ok((await measurePile(page)).above <= 40);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("one kind alone keeps today's full row, and no chip", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openRailScene(browser, { width: 460, height: 820, kinds: ["troupe"] });
  try {
    const g = await page.evaluate(() => ({
      chips: getComputedStyle(document.getElementById("rail-chips")).display,
      rows: getComputedStyle(document.getElementById("composer-rail")).display,
      troupe: document.getElementById("troupebar").getBoundingClientRect().height,
      inRail: document.getElementById("troupebar").parentElement.id }));
    assert.deepEqual({ chips: g.chips, rows: g.rows, inRail: g.inRail }, { chips: "none", rows: "flex", inRail: "composer-rail" });
    assert.ok(g.troupe >= 33, `the full row (${g.troupe}px)`);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const attention of [false, true]) {
  test(`300px${attention ? " with chips that need you" : ""}: the line wraps whole chips, never clips or scrolls sideways`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openRailScene(browser, { width: 300, height: 760, attention });
    try {
      const g = await lineFacts(page);
      assert.equal(g.overflowX, false);
      assert.equal(g.chips.length, 5);
      for (const chip of g.chips) {
        assert.ok(chip.left >= -0.5 && chip.right <= 300.5, `${chip.kind} on screen (${chip.left}–${chip.right})`);
        assert.equal(chip.clipped, false, `${chip.kind} not cut off`);
        assert.ok(!overlaps(chip, g.ws), `${chip.kind} clear of Workspace changes`);
      }
      for (let i = 0; i < g.chips.length; i++) for (let j = i + 1; j < g.chips.length; j++) {
        assert.ok(!overlaps(g.chips[i], g.chips[j]), `${g.chips[i].kind} and ${g.chips[j].kind} overlap`);
      }
      const rows = new Set(g.chips.map((chip) => Math.round(chip.top))).size;
      assert.ok(rows <= 2, `${rows} lines of chips`);
      const pile = await measurePile(page);
      assert.ok(pile.above <= 64, `${pile.above}px above the box at 300px`);
      if (attention) {
        const words = await page.evaluate(() => [...document.querySelectorAll("#rail-chips .chip-need")]
          .filter((node) => getComputedStyle(node).display !== "none").map((node) => node.textContent));
        assert.deepEqual(words, ["3 waiting", "1 blocked"], "the reasons stay on screen");
      }
      // A popover is as wide as the line and stays on screen.
      await page.click(chipSel("goal"));
      const pop = await page.evaluate(() => document.getElementById("rail-pop").getBoundingClientRect().toJSON());
      assert.ok(pop.left >= -0.5 && pop.right <= 300.5 && pop.top >= 0, JSON.stringify(pop));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const reducedMotion of [false, true]) {
  test(`reduced motion ${reducedMotion ? "on" : "off"}: the popover ${reducedMotion ? "appears without" : "eases in with"} motion, the troupe's tiles ${reducedMotion ? "hold still" : "light in turn"}`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openRailScene(browser, { width: 460, height: 820, reducedMotion });
    try {
      await page.click(chipSel("goal"));
      const g = await page.evaluate(() => ({
        pop: getComputedStyle(document.getElementById("rail-pop")).animationName,
        tile: getComputedStyle(document.querySelector('#rail-chips .rail-chip[data-kind="troupe"] .chip-mark .tm-part')).animationName }));
      assert.deepEqual(g, reducedMotion ? { pop: "none", tile: "none" } : { pop: "rail-pop-in", tile: "troupe-tile" });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
