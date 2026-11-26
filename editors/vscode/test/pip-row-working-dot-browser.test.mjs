// A working Pip's row (a screenshot, 15 Nov): the row of a Pip that is replying wears a blue dot at its right end. With
// the pointer over the row, its pin was drawn ON the dot (both sat at the row's end), and the new "Open in editor"
// button stood beside it. The dot says the Pip is working, so nothing may lie on it: the dot keeps its place at the
// row's end, and the row's buttons (Open in editor, the pin) stand beside it, to its left, with the row's words ending
// before them. The same for a keyboard (the row focused), for a finger (the buttons always show), and for a working
// row that also has a number waiting, something new to read, or both.
// In real Chromium with the real Pips bundle, dark and light, at 300, 440 and 700 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { PIP, openChat } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const id = (c) => "pip_" + c.repeat(32);
// The scene's own Pip (nothing else on its row), one with a number waiting, one with something new to read, one with both.
const ROWS = [[PIP, "working"], [id("2"), "working, 2 waiting"], [id("3"), "working, 2 new"], [id("4"), "working, 12 new and 3 waiting"]];
const IDLE = id("1");

/** Everything at the end of a Pip's row, as drawn: the working dot, the row's buttons, its number, its new-dot or
 *  "Read", and where its words end. */
const measure = (pip) => {
  const root = window.__pipsRoot || document, row = root.querySelector(`[data-job="${pip}"]`), slot = row.closest(".pip-row-slot") || row.parentElement;
  const r = row.getBoundingClientRect(), after = getComputedStyle(row, "::after");
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 0;
  const box = (n) => { if (!seen(n)) return null; const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
  const w = parseFloat(after.width) || 0, h = parseFloat(after.height) || 0, right = parseFloat(after.right) || 0;
  const dot = after.content !== "none" && after.display !== "none" && w > 0 ? { left: r.right - right - w, right: r.right - right, top: r.top + r.height / 2 - h / 2, bottom: r.top + r.height / 2 + h / 2 } : null;
  const copy = row.querySelector(".pip-row-copy"), c = copy.getBoundingClientRect();
  const read = slot.querySelector(".pip-row-read"), word = slot.querySelector(".pip-read-word");
  return { state: row.dataset.state, label: (row.querySelector(".pip-row-copy small")?.textContent || "").trim(), row: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, dot,
    dotInk: dot ? after.backgroundColor : "", pin: box(slot.querySelector(".job-pin")) || box(slot.querySelector(".job-more")), open: box(slot.querySelector(".job-open")), count: box(slot.querySelector(".pip-row-marks-live .pip-row-count") || row.querySelector(".pip-row-marks:not(.pip-row-room) .pip-row-count") || slot.querySelector(".pip-row-count")),
    read: box(read), readWord: box(word), newDot: box(slot.querySelector(".pip-row-marks-live .pip-new-dot") || slot.querySelector(".pip-new-dot")),
    words: c.right - parseFloat(getComputedStyle(copy).paddingRight), wordsLeft: c.left, sideways: document.documentElement.scrollWidth > innerWidth + 1,
    sizes: ["job-pin", "job-open", "job-more"].map((k) => { const n = slot.querySelector("." + k); if (!seen(n)) return null; const b = n.getBoundingClientRect(); return [Math.round(b.width) + (k === "job-more" ? 4 : 0), Math.round(b.height), parseFloat(getComputedStyle(n).borderTopLeftRadius)]; }).filter(Boolean) };
};
const overlap = (a, b) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
/** Nothing at the row's end lies on anything else there, the dot least of all; the words end before all of it.
 *  (in a list under 400px the row's buttons are in its ⋯, which stands where the pin stood: 16 Nov); "the pin" here is then that ⋯, 4px slimmer than the pin. */
function clear(m, what, { controls }) {
  assert.equal(m.state, "working", `${what}: the row is a working Pip's`);
  assert.ok(m.dot, `${what}: the dot that says it is working is drawn`);
  assert.ok(m.dot.right <= m.row.right && m.dot.left >= m.row.left, `${what}: inside its row`);
  if (controls) { assert.ok(m.pin, `${what}: the pin shows`); assert.equal(!!m.open, controls === "both", `${what}: Open in editor ${controls === "both" ? "shows" : "is in the chat's own menu at this width"}`); }
  const parts = { pin: m.pin, "Open in editor": m.open, number: m.count, "new dot": m.readWord ? null : m.newDot, Read: m.readWord };
  for (const [name, b] of Object.entries(parts)) {
    if (!b) continue;
    assert.equal(overlap(m.dot, b), false, `${what}: the ${name} never lies on the working dot (dot ${m.dot.left}–${m.dot.right}, ${name} ${b.left}–${b.right})`);
    if (name === "pin" || name === "Open in editor") assert.ok(b.right <= m.dot.left - 2, `${what}: the ${name} stands beside the dot, to its left (${b.right} / ${m.dot.left})`);
    // (In a side bar under 300 px what waits is a number on the face's corner, before the words: user test 2, P1.)
    if (name === "number" && b.right <= m.wordsLeft + 0.5) continue;
    assert.ok(m.words <= b.left + 0.5, `${what}: the row's words end before the ${name} (${m.words} / ${b.left})`);
  }
  const names = Object.keys(parts).filter((k) => parts[k]);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) assert.equal(overlap(parts[names[i]], parts[names[j]]), false, `${what}: the ${names[i]} and the ${names[j]} do not overlap`);
  assert.ok(m.words <= m.dot.left - 2, `${what}: the words end before the dot`);
  for (const s of m.sizes) assert.deepEqual([s[0], s[1], s[2] >= 4 && s[2] <= 8], [20, 28, true], `${what}: the row's buttons keep their size and corner (as pip-open-in-editor-browser.test.mjs measures them)`);
  assert.equal(m.sideways, false);
}
const scene = (o) => openChat(browser, { height: 900, api: 97, convs: true, switches: true, many: true, home: true, working: "9234", ...o });

for (const theme of ["dark", "light"]) for (const width of [300, 440, 700]) {
  test(`a working Pip's row: its buttons stand beside the dot, never on it, pointed at or not (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close, errors } = await scene({ width, theme, where: width >= 700 ? "tab" : "side" });
    try {
      for (const [pip] of ROWS) await p.waitForSelector(`[data-job="${pip}"][data-state="working"]`);
      // One of them is pinned to the dock, so its pin always shows.
      await p.evaluate((a) => window.postMessage({ type: "dock", pinned: [`pip:${a}`] }, "*"), ROWS[2][0]);
      await p.waitForSelector(`[data-pin-pip="${ROWS[2][0]}"][aria-pressed="true"]`, { state: "attached" });
      for (const [pip, what] of ROWS) {
        await p.locator(`[data-job="${pip}"]`).scrollIntoViewIfNeeded();
        await p.mouse.move(1, 1); await p.waitForTimeout(180);
        const rest = await p.evaluate(measure, pip);
        assert.match(rest.label, /Replying|waiting for you|\S/, "its second line says what it is doing");
        clear(rest, `${what}, at rest`, { controls: false });
        await p.hover(`[data-job="${pip}"]`, { position: { x: 30, y: 12 } }); await p.waitForTimeout(220);
        const hovered = await p.evaluate(measure, pip);
        clear(hovered, `${what}, pointed at`, { controls: width > 340 ? "both" : "pin" });
        assert.deepEqual([hovered.dot.left, hovered.dot.right], [rest.dot.left, rest.dot.right], `${what}: the dot keeps its place when the buttons show`);
        // The keyboard: the row focused shows the same buttons, the same way.
        await p.mouse.move(1, 1); await p.locator(`[data-job="${pip}"]`).focus(); await p.waitForTimeout(220);
        clear(await p.evaluate(measure, pip), `${what}, reached by Tab`, { controls: width > 340 ? "both" : "pin" });
        await p.evaluate(() => (window.__pipsRoot || document).activeElement?.blur());
      }
      // A row whose Pip is not working is as it was: its buttons at the row's end.
      await p.hover(`[data-job="${IDLE}"]`, { position: { x: 30, y: 12 } }); await p.waitForTimeout(220);
      const idle = await p.evaluate(measure, IDLE);
      assert.equal(idle.dot, null, "no dot on a Pip that is not working");
      assert.ok(idle.pin && idle.row.right - idle.pin.right <= 9, `its pin stays at the row's end (${idle.pin && idle.row.right - idle.pin.right}px in)`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

for (const width of [300, 440, 700]) {
  test(`with a finger the buttons always show, and the dot is still clear of them (${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close, errors } = await scene({ width, theme: "dark", where: width >= 700 ? "tab" : "side", touch: true });
    try {
      await p.waitForSelector(`[data-job="${PIP}"][data-state="working"]`);
      await p.evaluate((a) => window.postMessage({ type: "dock", pinned: [`pip:${a}`] }, "*"), ROWS[2][0]);
      await p.waitForSelector(`[data-pin-pip="${ROWS[2][0]}"][aria-pressed="true"]`, { state: "attached" });
      for (const [pip, what] of ROWS) {
        await p.waitForSelector(`[data-job="${pip}"][data-state="working"]`);
        await p.locator(`[data-job="${pip}"]`).scrollIntoViewIfNeeded(); await p.waitForTimeout(120);
        clear(await p.evaluate(measure, pip), `${what}, touch`, { controls: width > 340 ? "both" : "pin" });
      }
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}
