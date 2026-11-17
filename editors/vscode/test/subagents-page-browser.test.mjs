import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pickerPage, sampleView } from "./support/model-picker-scene.mjs";

// The model picker's second page (17 Nov, his words: "when user selects a sub agent model, then we further take user to
// a next page to select the context window and thinking effort, and context size only shows options of what that model
// is capable of"), in real Chromium: media/shared/modelpicker.js + .css. Its head (Back, the model, its connection),
// Their thinking, Their context window (Same, only the sizes the model takes, Custom…), Done; Back and Escape; the
// keyboard; both themes at 300, 440 and 700 px. Also the look fixes of the same day: the chosen tab is the raised tile,
// and Main and Fallback are tags with the buttons' corner. Work's and a Pip's pages fill it (their own tests).
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};

const TABS = { tabs: [{ id: "main", label: "Main model" }, { id: "agents", label: "Sub-agents" }], tab: "agents" };
const LEVELS = [["same", "Same", "Same as the session"], ["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"]]
  .map(([value, label, title]) => ({ value, label, ...(title ? { title, now: title } : {}) }));
const page = (window = {}, more = {}) => ({ key: "anthropic:claude-opus-5-5", name: "claude-opus-5-5", conn: "Anthropic API · your key",
  thinking: { label: "Their thinking", value: "same", levels: LEVELS },
  window: { label: "Their context window", value: 0, max: 262144, same: "Same as the session", ...window }, ...more });
/** The picker on its Sub-agents tab, its second page open for a model whose largest window is `window.max`. */
const scene = async (t, { width = 440, theme = "dark", height = 720 } = {}, window = {}, more = {}) => {
  const made = await pickerPage(browser, { width, theme, height });
  t.after(() => made.context.close());
  const errors = [];
  made.page.on("pageerror", (e) => errors.push(e.message));
  await made.page.evaluate(`window.openPicker(${sampleView(4, { ...TABS, page: page(window, more) })})`);
  return { ...made, errors };
};
const q = (p, fn, arg) => p.evaluate(fn, arg);
const focusKey = (p) => q(p, () => document.activeElement?.dataset?.k || document.activeElement?.id || document.activeElement?.tagName);
const picked = (p) => q(p, () => window.picked);
const sizes = (p) => q(p, () => [...document.querySelectorAll(".dgc-mp-size")].map((b) => b.textContent));
const update = (p, change) => q(p, (c) => { window.view = { ...window.view, ...c, page: c.page === null ? null : { ...window.view.page, ...(c.page || {}), window: { ...(window.view.page || {}).window, ...((c.page || {}).window || {}) } } }; window.picker.update(window.view); }, change);

test("the page's parts: Back, the model and its connection under it, Their thinking, Their context window, Done", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) for (const width of [300, 440, 700]) {
    const { page: p, errors } = await scene(t, { width, theme });
    const facts = await q(p, () => {
      const box = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
      const d = document.querySelector(".dgc-mp"), group = document.querySelector(".dgc-mp-page"), back = document.querySelector(".dgc-mp-back"), done = document.querySelector(".dgc-mp-done");
      const name = document.querySelector(".dgc-mp-page-name"), conn = document.querySelector(".dgc-mp-page-conn");
      return { role: group.getAttribute("role"), label: group.getAttribute("aria-label"), listHidden: getComputedStyle(document.querySelector(".dgc-mp-main")).display, tabsHidden: document.querySelector(".dgc-mp-tabs").hidden,
        back: { ...box(back), label: back.getAttribute("aria-label"), r: parseFloat(getComputedStyle(back).borderTopLeftRadius), svg: !!back.querySelector("svg") },
        name: { text: name.textContent, ...box(name) }, conn: { text: conn.textContent, ...box(conn) }, dialog: box(d), done: { ...box(done), text: done.textContent, primary: done.classList.contains("primary") },
        heads: [...document.querySelectorAll(".dgc-mp-page .dgc-mp-think-name")].map((n) => n.textContent),
        levels: [...document.querySelectorAll(".dgc-mp-page [data-pthink]")].map((b) => [b.dataset.pthink, b.getAttribute("aria-checked")]),
        note: document.querySelector(".dgc-mp-window-note").textContent, custom: document.querySelector(".dgc-mp-custom")?.textContent,
        cut: [...document.querySelectorAll(".dgc-mp-page button")].filter((b) => b.scrollWidth > b.clientWidth + 0.5).map((b) => b.textContent),
        outside: [...document.querySelectorAll(".dgc-mp-page *")].filter((n) => { const r = n.getBoundingClientRect(); return r.width && (r.left < d.getBoundingClientRect().left - 0.5 || r.right > d.getBoundingClientRect().right + 0.5); }).length,
        sideways: document.documentElement.scrollWidth <= innerWidth };
    });
    const at = `${theme} ${width}px`;
    assert.deepEqual([facts.role, facts.label, facts.listHidden, facts.tabsHidden], ["group", "claude-opus-5-5 for sub-agents", "none", true], at);
    assert.deepEqual([Math.round(facts.back.w), Math.round(facts.back.h), facts.back.r, facts.back.svg, facts.back.label], [28, 28, 6, true, "Back to the models"], `${at}: Back is a 28 px button with the 6 px corner`);
    assert.equal(facts.name.text, "claude-opus-5-5");
    assert.equal(facts.conn.text, "Anthropic API · your key");
    assert.ok(facts.conn.y >= facts.name.y + facts.name.h - 1 && Math.abs(facts.conn.x - facts.name.x) <= 1, `${at}: the connection is under the name`);
    assert.ok(facts.name.x > facts.back.right, `${at}: beside Back`);
    assert.deepEqual(facts.heads, ["Their thinking", "Their context window"], at);
    assert.deepEqual(facts.levels.map((l) => l[0]), ["same", "off", "low", "medium", "high", "xhigh"], `${at}: Same first`);
    assert.deepEqual(facts.levels.filter((l) => l[1] === "true").map((l) => l[0]), ["same"]);
    assert.equal(facts.custom, "Custom…");
    assert.equal(facts.note, "This model takes up to 256K.");
    assert.deepEqual([facts.done.text, facts.done.primary], ["Done", true]);
    assert.ok(facts.done.bottom <= facts.dialog.bottom && facts.done.right <= facts.dialog.right && facts.done.bottom > facts.dialog.bottom - 60, `${at}: Done is at the foot`);
    assert.deepEqual(facts.cut, [], `${at}: no word on the page is cut`);
    assert.equal(facts.outside, 0, `${at}: everything is inside the dialog`);
    assert.equal(facts.sideways, true);
    assert.equal(await focusKey(p), "back", `${at}: the focus is on Back`);
    assert.deepEqual(errors, []);
  }
});

test("only the sizes the model takes: a 256K model shows no 512K or 1M; a 200K one shows 200K last; unknown shows every size", async (t) => {
  if (skipOrFail(t)) return;
  const { page: p } = await scene(t);
  assert.deepEqual(await sizes(p), ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "256K"]);
  assert.deepEqual(await q(p, () => [...document.querySelectorAll(".dgc-mp-size")].map((b) => [b.dataset.size, b.title])).then((r) => r.slice(-1)), [["262144", "262,144 tokens"]]);
  await update(p, { page: { window: { max: 200000 } } });
  assert.deepEqual(await sizes(p), ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "200K"], "a window that is no step is the last choice");
  assert.equal(await q(p, () => document.querySelector(".dgc-mp-window-note").textContent), "This model takes up to 200K.");
  await update(p, { page: { window: { max: 0 } } });
  assert.deepEqual(await sizes(p), ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "256K", "512K", "1M"]);
  assert.equal(await q(p, () => document.querySelector(".dgc-mp-window-note").textContent), "DGC couldn’t learn this model’s largest window, so every size shows.");
  await update(p, { page: { window: { max: 0, checking: true } } });
  assert.equal((await sizes(p)).length, 10, "while it is asked, the sizes show: never an empty page");
  assert.equal(await q(p, () => document.querySelector(".dgc-mp-window-note").textContent), "Checking this model’s largest window…");
  await update(p, { page: { window: { max: 131072, checking: false, value: 24576 } } });
  assert.deepEqual(await sizes(p), ["Same", "4K", "8K", "16K", "24K", "32K", "64K", "128K"], "a size set before is shown where it falls, chosen");
  assert.deepEqual(await q(p, () => [...document.querySelectorAll('.dgc-mp-size[aria-checked="true"]')].map((b) => b.textContent)), ["24K"]);
  assert.equal(await q(p, () => document.querySelector(".dgc-mp-page-window .dgc-mp-think-now").textContent), "24K");
  await p.click('.dgc-mp-size[data-size="65536"]');
  assert.deepEqual((await picked(p)).at(-1), ["pageWindow", 65536, { keys: false }]);
  await p.click('.dgc-mp-size[data-size="0"]');
  assert.deepEqual((await picked(p)).at(-1), ["pageWindow", 0, { keys: false }], "Same is 0: the session's own");
  await p.click('[data-pthink="high"]');
  assert.deepEqual((await picked(p)).at(-1), ["pageThinking", "high", { keys: false }]);
  assert.equal(await q(p, () => !!document.querySelector(".dgc-mp-page")), true, "a choice keeps the page open");
});

test("Custom… is a field right there: 24K, 24k, 24576 and 24,576 save; a wrong size is said in one line; Escape returns", async (t) => {
  if (skipOrFail(t)) return;
  const { page: p } = await scene(t, { width: 300 });
  for (const typed of ["24K", "24k", "24576", "24,576"]) {
    await p.click(".dgc-mp-custom");
    assert.equal(await focusKey(p), "custom-in", "the field has the focus");
    await p.keyboard.type(typed);
    await p.keyboard.press("Enter");
    assert.deepEqual((await picked(p)).at(-1), ["pageWindow", 24576, { keys: false, typed: true }], typed);
    assert.equal(await q(p, () => !!document.querySelector(".dgc-mp-custom-input")), false, "saved: the field closes");
  }
  const said = async (typed) => {
    await p.click(".dgc-mp-custom");
    await p.keyboard.type(typed);
    const before = (await picked(p)).length;
    await p.keyboard.press("Enter");
    assert.equal((await picked(p)).length, before, `${typed}: nothing is saved`);
    const line = await q(p, () => ({ text: document.querySelector(".dgc-mp-wrong")?.textContent || "", role: document.querySelector(".dgc-mp-wrong")?.getAttribute("role"), invalid: document.querySelector(".dgc-mp-custom-input").getAttribute("aria-invalid"), h: document.querySelector(".dgc-mp-wrong")?.getBoundingClientRect().height }));
    assert.equal(line.role, "alert"); assert.equal(line.invalid, "true");
    assert.ok(line.h < 40, `${typed}: one line (${line.h}px)`);
    assert.equal(await focusKey(p), "custom-in", "the field keeps the focus");
    await p.keyboard.press("Escape");
    assert.equal(await focusKey(p), "custom", "Escape returns to Custom…");
    assert.equal(await q(p, () => !!document.querySelector(".dgc-mp-page")), true, "and the page stays");
    return line.text;
  };
  assert.equal(await said("1K"), "Below 2K: DGC needs at least 2K (2,048 tokens) for its own instructions.");
  assert.equal(await said("300K"), "This model takes up to 256K: type that or less.");
  assert.equal(await said("lots"), "Type a size like 24K or 24576.");
  assert.equal(await said("17000000"), "DGC takes up to 16,384K (16,777,216 tokens).");
  // Typing again takes the line away; Save is the same as Enter.
  await p.click(".dgc-mp-custom");
  await p.keyboard.type("x"); await p.keyboard.press("Enter");
  assert.equal(await q(p, () => !!document.querySelector(".dgc-mp-wrong")), true);
  await p.keyboard.press("Backspace"); await p.keyboard.type("48K");
  assert.equal(await q(p, () => !!document.querySelector(".dgc-mp-wrong")), false, "the line goes as the size is typed again");
  await p.click(".dgc-mp-custom-save");
  assert.deepEqual((await picked(p)).at(-1), ["pageWindow", 49152, { keys: false, typed: true }]);
  // A model DGC knows nothing of: any size DGC takes.
  await update(p, { page: { window: { max: 0 } } });
  await p.click(".dgc-mp-custom"); await p.keyboard.type("2000K"); await p.keyboard.press("Enter");
  assert.deepEqual((await picked(p)).at(-1), ["pageWindow", 2048000, { keys: false, typed: true }]);
});

test("Back and Escape go back to the list with the focus on the chosen model; a second Escape closes; Done closes", async (t) => {
  if (skipOrFail(t)) return;
  // On the list first: a model is picked (the page saves it), then its page opens.
  const made = await pickerPage(browser, { width: 440 });
  t.after(() => made.context.close());
  const p = made.page;
  await p.evaluate(`window.openPicker(${sampleView(4, TABS)})`);
  await p.click('.dgc-mp-conn[data-rail="anthropic"]');
  await p.click('.dgc-mp-row[data-value="claude-opus-5-5"]');
  assert.deepEqual((await picked(p)).at(-1), ["pick", "claude-opus-5-5", "anthropic"]);
  await q(p, () => { const c = window.view.connections[1]; c.sections[0].rows = c.sections[0].rows.map((r, i) => ({ ...r, current: i === 1 })); });
  await update(p, { page: page() });
  assert.equal(await focusKey(p), "back", "the page opens on Back");
  await p.click(".dgc-mp-back");
  assert.deepEqual((await picked(p)).at(-1), ["back"]);
  // The page clears it (as Work and a Pip do on back).
  await q(p, () => { window.view = { ...window.view, page: null }; window.picker.update(window.view); });
  assert.equal(await q(p, () => [!!document.querySelector(".dgc-mp-page:not([hidden])"), document.querySelector(".dgc-mp-tabs").hidden, getComputedStyle(document.querySelector(".dgc-mp-main")).display]).then(JSON.stringify), JSON.stringify([false, false, "flex"]));
  assert.equal(await focusKey(p), "r:anthropic:claude-opus-5-5", "the focus is on the chosen model");
  // Again, and Escape this time.
  await update(p, { page: page() });
  assert.equal(await focusKey(p), "back");
  await p.keyboard.press("Escape");
  assert.deepEqual((await picked(p)).at(-1), ["back"], "Escape on the page is Back");
  assert.equal(await q(p, () => !!document.querySelector(".dgc-mp-layer")), true, "the picker stays");
  await q(p, () => { window.view = { ...window.view, page: null }; window.picker.update(window.view); });
  await p.keyboard.press("Escape");
  assert.equal(await q(p, () => !!document.querySelector(".dgc-mp-layer")), false, "a second Escape closes");
  // Done.
  const again = await scene(t, { width: 700 });
  await again.page.click(".dgc-mp-done");
  assert.deepEqual((await picked(again.page)).at(-1), ["done"]);
});

test("the keyboard on the page: Tab stays inside it, arrows move each choice and say so", async (t) => {
  if (skipOrFail(t)) return;
  const { page: p } = await scene(t, { width: 440 });
  const seen = [];
  for (let i = 0; i < 6; i++) { await p.keyboard.press("Tab"); seen.push(await focusKey(p)); }
  assert.deepEqual(seen, ["pt:same", "ps:0", "custom", "done", "back", "pt:same"], "one stop per choice, then Done, then round again");
  await p.keyboard.press("ArrowRight");
  assert.deepEqual((await picked(p)).at(-1), ["pageThinking", "off", { keys: true }]);
  assert.equal(await focusKey(p), "pt:off");
  await update(p, { page: { thinking: { label: "Their thinking", levels: LEVELS, value: "off" } } });
  assert.equal(await focusKey(p), "pt:off", "the focus stays as the page answers");
  await p.keyboard.press("Tab");
  await p.keyboard.press("End");
  assert.deepEqual((await picked(p)).at(-1), ["pageWindow", 262144, { keys: true }]);
  await p.keyboard.press("Shift+Tab");
  assert.equal(await focusKey(p), "pt:off", "from a size the arrows moved to, Shift+Tab is the choice before");
  await p.keyboard.press("Shift+Tab");
  assert.equal(await focusKey(p), "back");
});

test("the look: the chosen tab is the raised tile; Main and Fallback are tags with the 6 px corner; nothing on the page is a pill", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    const made = await pickerPage(browser, { width: 440, theme });
    t.after(() => made.context.close());
    const p = made.page;
    await p.evaluate(`(() => { const v = ${sampleView(3, { tabs: TABS.tabs, tab: "main" })};
      const rows = v.connections[1].sections[0].rows; rows[0] = { ...rows[0], current: true, pills: [["Main", "main"]] }; rows[1] = { ...rows[1], pills: [["Fallback", "fallback"]] };
      v.selected = v.connections[1].id; window.openPicker(v); })()`);
    const look = await q(p, () => {
      const on = document.querySelector('.dgc-mp-tab[aria-selected="true"]'), off = document.querySelector('.dgc-mp-tab[aria-selected="false"]'), level = document.querySelector('.dgc-mp-level[aria-checked="true"]');
      const c = (n) => getComputedStyle(n);
      return { tab: c(on).backgroundColor, level: c(level).backgroundColor, shadow: c(on).boxShadow, offBg: c(off).backgroundColor, tabsBg: c(document.querySelector(".dgc-mp-tabs")).backgroundColor, segBg: c(document.querySelector(".dgc-mp-seg")).backgroundColor,
        tags: [...document.querySelectorAll(".dgc-mp-tag")].map((n) => [n.textContent, parseFloat(c(n).borderTopLeftRadius), n.getBoundingClientRect().height]) };
    });
    assert.equal(look.tab, look.level, `${theme}: the chosen tab is the chosen level's raised tile`);
    assert.notEqual(look.shadow, "none", `${theme}: raised`);
    assert.equal(look.tabsBg, look.segBg, `${theme}: the tabs' ground is the levels' ground`);
    assert.equal(look.offBg, "rgba(0, 0, 0, 0)");
    assert.deepEqual(look.tags.map((x) => x[0]), ["Main", "Fallback"]);
    for (const [word, r, h] of look.tags) { assert.equal(r, 6, `${theme} ${word}: the buttons' corner`); assert.ok(r < h / 2 - 1, `${theme} ${word}: no pill (${r}px on ${h}px)`); }
  }
  const { page: p } = await scene(t, { width: 300 });
  await p.click(".dgc-mp-custom");
  const corners = await q(p, () => [".dgc-mp-back", ".dgc-mp-page .dgc-mp-seg", ".dgc-mp-size", ".dgc-mp-custom-input", ".dgc-mp-custom-save", ".dgc-mp-done"].map((s) => {
    const n = document.querySelector(s), c = getComputedStyle(n); return [s, parseFloat(c.borderTopLeftRadius), n.getBoundingClientRect().height]; }));
  for (const [selector, radius, height] of corners) {
    assert.ok(radius <= 6 && radius < height / 2 - 1, `${selector}: ${radius}px on ${height}px`);
  }
  assert.deepEqual(corners.filter(([s]) => [".dgc-mp-back", ".dgc-mp-custom-input", ".dgc-mp-custom-save", ".dgc-mp-done"].includes(s)).map(([s, r, h]) => [s, r, Math.round(h)]),
    [[".dgc-mp-back", 6, 28], [".dgc-mp-custom-input", 6, 28], [".dgc-mp-custom-save", 6, 28], [".dgc-mp-done", 6, 28]], "the buttons' corner and height");
});

test("the words on the page clear 4.5:1 in both themes", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    const { page: p } = await scene(t, { width: 440, theme }, { max: 0 });
    const ratios = await q(p, () => {
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const rgba = (colour) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const over = (top, under) => { const a = top[3] / 255; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)); };
      const ground = rgba(getComputedStyle(document.querySelector(".dgc-mp-page")).backgroundColor);
      return [".dgc-mp-page-name", ".dgc-mp-page-conn", ".dgc-mp-page .dgc-mp-think-name", ".dgc-mp-page .dgc-mp-think-now", '.dgc-mp-size[aria-checked="false"]', ".dgc-mp-window-note", ".dgc-mp-custom"].map((s) => {
        const ink = over(rgba(getComputedStyle(document.querySelector(s)).color), ground), a = lum(ink), b = lum(ground);
        return [s, Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100];
      });
    });
    for (const [selector, ratio] of ratios) assert.ok(ratio >= 4.5, `${theme} ${selector}: ${ratio}:1`);
  }
});

test("in a short window the page stays inside it: its choices scroll, Back and Done stay in view", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, height] of [[440, 380], [300, 320]]) {
    const { page: p } = await scene(t, { width, height }, { max: 0 });
    const facts = await q(p, () => { const d = document.querySelector(".dgc-mp").getBoundingClientRect(), b = document.querySelector(".dgc-mp-back").getBoundingClientRect(), done = document.querySelector(".dgc-mp-done").getBoundingClientRect(), body = document.querySelector(".dgc-mp-page-body");
      return { inside: d.top >= 0 && d.bottom <= innerHeight, back: b.top >= d.top && b.bottom <= d.bottom, done: done.top >= d.top && done.bottom <= d.bottom, scrolls: body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === "auto" }; });
    assert.deepEqual(facts, { inside: true, back: true, done: true, scrolls: true }, `${width}×${height}`);
  }
});
