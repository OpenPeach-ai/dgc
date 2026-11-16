// A Pip's row with something new to read and a dock pin (his picture, 14 Nov): the pin sits level with the dot, and
// the dot's "Read" (on hover or focus) never lies on the pin. "Read" is a button in the page's one shape (6 px corners),
// never a pill. In real Chromium with the real Pips bundle, dark and light, in a tab (700 px) and in the side bar (300 px).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
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

const INBOX = "pip_" + "3".repeat(32), BOTH = "pip_" + "4".repeat(32);   // "Inbox": 2 new; the long one: 12 new and 3 waiting

const measure = (id) => {
  const root = window.__pipsRoot || document, slot = root.querySelector(`[data-job="${id}"]`).closest(".pip-row-slot");
  const box = (n) => n && n.getBoundingClientRect(), shown = (n) => !!n && n.getClientRects().length > 0, dot = box(slot.querySelector(".pip-new-dot"));
  // (in a list under 400px the row's buttons are in its ⋯, which stands where the pin stood: 16 Nov)
  const pin = box(shown(slot.querySelector(".job-more")) ? slot.querySelector(".job-more") : slot.querySelector(".job-pin"));
  const word = slot.querySelector(".pip-read-word"), w = word && getComputedStyle(word).display !== "none" ? box(word) : null;
  const mid = (r) => (r.top + r.bottom) / 2, copy = slot.querySelector(".pip-row-copy"), c = box(copy);
  const textRight = c.right - parseFloat(getComputedStyle(copy).paddingRight);
  return { pin: pin && [pin.left, pin.right], word: w && [w.left, w.right], level: pin && dot ? Math.abs(mid(pin) - mid(dot)) : null,
    radius: word ? getComputedStyle(word).borderTopLeftRadius : "", gap: pin && w ? w.left - pin.right : null,
    clearOfText: pin ? pin.left - textRight : null };
};

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`a row's pin is level with its dot, and "Read" never lies on the pin (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await openChat(browser, { width, height: 900, theme, where: width > 400 ? "tab" : "side", many: true, home: true });
    try {
      await p.evaluate(([a, b]) => window.postMessage({ type: "dock", pinned: [`pip:${a}`, `pip:${b}`] }, "*"), [INBOX, BOTH]);
      await p.waitForSelector(`[data-pin-pip="${INBOX}"][aria-pressed="true"]`, { state: "attached" });
      for (const id of [INBOX, BOTH]) {
        await p.waitForSelector(`[data-job="${id}"]`);
        await p.mouse.move(0, 0); await p.waitForTimeout(150);
        const still = await p.evaluate(measure, id);
        assert.ok(still.level !== null && still.level <= 1, `${id === INBOX ? "a dot" : "a dot and a number"}: the pin is level with the dot (off by ${still.level}px)`);
        await p.hover(`[data-job="${id}"]`); await p.waitForTimeout(150);
        const rowHovered = await p.evaluate(measure, id);
        assert.ok(rowHovered.clearOfText >= 4, `the pin never lies on the row's words (clear by ${rowHovered.clearOfText}px)`);
        await p.hover(`[data-pip-read="${id}"]`); await p.waitForTimeout(150);
        const hovered = await p.evaluate(measure, id);
        assert.ok(hovered.word, "Read shows on hover");
        assert.ok(hovered.gap >= 4, `Read keeps clear of the pin (gap ${hovered.gap}px)`);
        assert.equal(hovered.radius, "6px", "Read is the page's one button shape, never a pill");
      }
    } finally { await close(); }
  });
}
