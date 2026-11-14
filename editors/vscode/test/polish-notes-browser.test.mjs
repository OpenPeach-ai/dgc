// Notes, the visual polish pass (0.52, 14 Nov): on a Large card every PIN screen with a pad fits the card without a
// scroll (the pad's bottom row and the line under it were cut); the pad's focus ring is a quiet grey that still reads
// (it was the editor's blue ring, loud around a pad that takes the keyboard by itself); and a tick box has a real
// checked state (it was only drawn by the stylesheet, so a screen reader read a ticked line as plain words).
// In real Chromium on the real Home, dark and light.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid, LISBON } from "./support/home-grid-scene.mjs";
import { sample } from "./support/notes-sample.mjs";
import { cleanup } from "./support/notes-host.mjs";
import { focusAudit } from "./support/polish-audit.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });

const CARD = '.hc-grid .hc-card[data-card="note"]';
const large = (theme, width = 700) => openGrid(browser, { width, theme, layout: ["note", "clock", "weather"], seed: sample(), notesOptions: { iterations: 1500 }, settings: { weather: { place: LISBON } } });
/** The PIN screen on the card: how much of it the card's body cannot show, and each of its controls against the body's box. */
const fit = (p) => p.evaluate((sel) => {
  const card = document.querySelector(sel), body = card.querySelector(".nt-body"), box = card.querySelector(".nt-lockbox"); if (!box) return null;
  const b = body.getBoundingClientRect(), c = card.getBoundingClientRect();
  const cut = [...box.querySelectorAll("button, h3, p, .nt-dots")].filter((n) => n.checkVisibility()).map((n) => { const r = n.getBoundingClientRect(); return { what: (n.textContent || n.getAttribute("aria-label") || n.className).trim().slice(0, 24), over: Math.max(0, r.bottom - b.bottom, b.top - r.top, r.right - c.right, c.left - r.left) }; }).filter((x) => x.over > 0.5);
  const keys = [...box.querySelectorAll(".nt-pad button")].map((k) => k.getBoundingClientRect().height);
  return { form: card.dataset.form, title: box.querySelector("h3")?.textContent || "", scroll: body.scrollHeight - body.clientHeight, cut, keys: keys.length, key: Math.min(...keys) };
}, CARD);
const type = async (x, digits) => { for (const d of digits) { await x.page.keyboard.press(d); await x.rest(120); } };

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 1000]) {
  test(`a Large card: every PIN screen with a pad fits without a scroll (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await large(theme, width), p = x.page;
    try {
      const whole = async (name, title) => { await x.rest(350); const s = await fit(p);
        assert.ok(s, `${name}: its screen is up`); assert.equal(s.form, "l", "the card is Large");
        if (title) assert.equal(s.title, title);
        assert.ok(s.scroll <= 0.5, `${name}: nothing to scroll in the card (${s.scroll}px more than it shows)`);
        assert.deepEqual(s.cut, [], `${name}: nothing of it is cut`);
        if (s.keys) { assert.equal(s.keys, 11, `${name}: the whole pad`); assert.ok(s.key >= 15, `${name}: a key is at least 15px tall (${s.key})`); } };
      await p.click(`${CARD} .hc-note-row[data-note="wifi01"]`); await x.rest(350);
      await p.click(`${CARD} .nt-lock`);
      await whole("Choose a PIN", "Choose a PIN");
      await p.click(`${CARD} .nt-lockbox [data-pin="longer"]`); await whole("Choose a PIN, a longer one (with Next)", "Choose a PIN");
      await p.click(`${CARD} .nt-lockbox [data-pin="longer"]`); await x.rest(150);
      await type(x, "4821"); await whole("Type it again", "Choose a PIN");
      await type(x, "4821"); await x.rest(700);
      // Locked again: the PIN is asked to open it; a wrong one says so.
      await p.keyboard.press("Control+Alt+l"); await whole("a locked note");
      await type(x, "1111"); await x.rest(500); await whole("a wrong PIN");
      // Another note, locked while the notes are locked: the PIN is asked first.
      await p.click(`${CARD} .hc-note-row[data-note="seeds1"]`); await x.rest(350); await p.click(`${CARD} .nt-lock`);
      await whole("Lock this note", "Lock this note");
    } finally { await x.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`the PIN pad's focus ring is a quiet grey that still reads at 3:1, never the editor's blue (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await large(theme), p = x.page;
    try {
      await p.click(`${CARD} .hc-note-row[data-note="wifi01"]`); await x.rest(350); await p.click(`${CARD} .nt-lock`); await x.rest(350);
      await p.keyboard.press("4"); await x.rest(150);                       // the keyboard is in use: the ring shows
      const ring = await p.evaluate((sel) => { const pad = document.querySelector(`${sel} .nt-pad`), s = getComputedStyle(pad);
        const parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g).map(Number); return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
        const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]));
        let ground = [255, 255, 255]; const layers = []; for (let n = pad; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.unshift(c); if (c[3] >= 1) break; } for (const l of layers) ground = over(l, ground);
        const ink = over(parse(s.outlineColor), ground), lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const [hi, lo] = [lum(ink), lum(ground)].sort((a, b) => b - a);
        return { focused: document.activeElement === pad, shown: pad.matches(":focus-visible"), style: s.outlineStyle, width: parseFloat(s.outlineWidth), ink: ink.map(Math.round), chroma: Math.max(...ink) - Math.min(...ink), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }; }, CARD);
      assert.ok(ring.focused && ring.shown, "the pad has the keyboard");
      assert.ok(ring.style !== "none" && ring.width >= 1, "it has a ring");
      assert.ok(ring.chroma <= 16, `the ring is a grey, not a colour (${ring.ink})`);
      assert.ok(ring.ratio >= 3, `and reads at 3:1 on the card (${ring.ratio})`);
    } finally { await x.close(); }
  });
}

test("a tick box has a real checked state: a checkbox by role, checked or not, that follows a tick and a new line", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300, layout: ["note", "clock"], seed: sample(), notesOptions: { iterations: 1500 } }), p = x.page;
  try {
    await p.click(CARD); await x.rest(250); await p.click('.hc-open .hc-card .hc-note-row[data-note="ferry1"]'); await x.rest(400);
    const boxes = () => p.evaluate(() => [...document.querySelectorAll(".hc-open .nt-doc .nt-l")].filter((l) => l.dataset.k === "ck" || l.getAttribute("role") === "checkbox").map((l) => ({ text: l.textContent.trim(), done: l.dataset.done, role: l.getAttribute("role"), checked: l.getAttribute("aria-checked") })));
    const first = await boxes();
    assert.ok(first.length >= 4, "the note's tick boxes are drawn");
    assert.deepEqual(first.filter((b) => b.role !== "checkbox" || b.checked !== (b.done === "1" ? "true" : "false")), [], "each is a checkbox whose checked state is its tick");
    // What a screen reader is handed: the browser's own accessibility tree says checkbox, and which are checked.
    const cdp = await p.context().newCDPSession(p), tree = (await cdp.send("Accessibility.getFullAXTree")).nodes;
    const read = tree.filter((n) => n.role?.value === "checkbox" && /Book the 09:40|Ask about bikes/.test(n.name?.value || "")).map((n) => [n.name.value, n.properties?.find((q) => q.name === "checked")?.value?.value]);
    assert.deepEqual(read.sort(), [["Ask about bikes", "false"], ["Book the 09:40", "true"]], "read as a ticked and an unticked checkbox");
    // Ticked with the mouse (on its box), it says so at once.
    const line = p.locator(".hc-open .nt-doc .nt-l", { hasText: "Ask about bikes" }), r = await line.boundingBox();
    await p.mouse.click(r.x + 7, r.y + r.height / 2); await x.rest(200);
    assert.equal((await boxes()).find((b) => b.text === "Ask about bikes").checked, "true", "a tick is said");
    // A line made a tick box by typing, and one that stops being one.
    await line.click({ position: { x: r.width - 4, y: r.height / 2 } }); await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.type("Pack the flask"); await x.rest(200);
    const made = (await boxes()).find((b) => b.text === "Pack the flask");
    assert.deepEqual([made?.role, made?.checked], ["checkbox", "false"], "a new tick line is an unticked checkbox");
    await p.keyboard.press("Home"); await p.keyboard.press("Backspace"); await x.rest(200);
    assert.equal(await p.evaluate(() => [...document.querySelectorAll(".hc-open .nt-doc .nt-l")].filter((l) => l.dataset.k !== "ck" && (l.getAttribute("role") || l.hasAttribute("aria-checked"))).length), 0, "a line that is no longer a tick box is no checkbox");
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  test(`a Large card: a note's row in the list shows its whole focus ring (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await large(theme), p = x.page;
    try {
      await p.click(`${CARD} .hc-note-row[data-note="wifi01"]`); await x.rest(350); await p.keyboard.press("Shift");
      const rings = await p.evaluate(focusAudit, { scope: `${CARD} .nt-listbox` });
      assert.ok(rings.walked >= 5, `the list's rows were walked (${rings.walked})`);
      assert.deepEqual(rings.cut.map((c) => `${c.text.slice(0, 24)}: ${c.lost}px of its ring is cut by ${c.by}`), []);
      assert.deepEqual(rings.missing.map((c) => c.text.slice(0, 24)), [], "and every row has one");
    } finally { await x.close(); }
  });
}
